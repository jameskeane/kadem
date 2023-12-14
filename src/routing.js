import { EventEmitter } from 'events';

import debugLogger from 'debug';
const debug = debugLogger('dht:routing');



const GOODNESS_TIMEOUT = 15 * 60 * 1000;   // 15 minutes
const SILENCE_BEFORE_BAD = 3;



class Node {
  /**
   * @param {NodeInfo} node The node info.
   */
  constructor(node) {
    this.id = (typeof node.id === 'string') ?
        Buffer.from(node.id, 'hex') : node.id;

    /** @type {PeerInfo} */
    this.address = { address: node.address, port: node.port, family: node.family };
    this.token = node.token;

    /** @type {number|null} */
    this.lastResponse = null;

    /** @type {number|null} */
    this.lastReceivedQuery = null;
    this.failedResponses = 0;
  }

  get isGood() {
    const now = Date.now();
    return this.lastResponse && (this.failedResponses < SILENCE_BEFORE_BAD) && (
        (this.lastResponse >= (now - GOODNESS_TIMEOUT)) ||
        (this.lastReceivedQuery && this.lastReceivedQuery >= (now - GOODNESS_TIMEOUT)) );
  }

  get isBad() {
    return this.failedResponses >= SILENCE_BEFORE_BAD
  }

  toNodeInfo() {
    /** @type {NodeInfo} */
    let ni = { id: this.id, ...this.address };
    if (this.token) ni.token = this.token;
    return ni;
  }
}


class Bucket {
  /**
   * @param {Buffer} min The minimum node id of this bucket.
   * @param {Buffer} max The maximum node id of this bucket.
   */
  constructor(min, max) {
    this.min = min;
    this.max = max;
    this.lastChanged = Date.now();

    /** @type {Array.<Node>} */
    this.contacts = [];

    /** @type {Bucket|null} */
    this.left = null;

    /** @type {Bucket|null} */
    this.right = null;
  }
}


/**
 * @typedef {{ K?: number }} RoutingOptions
 */


export class RoutingTable extends EventEmitter {
  /**
   * @param {Buffer} localId The local node id of this routing table.
   * @param {RoutingOptions} options Configuration for this routing table.
   */
  constructor(localId, options = {}) {
    super();

    localId = (typeof localId === 'string') ? Buffer.from(localId, 'hex') : localId;
    if (localId.length !== 20) throw new Error('Invalid local id.');

    /** @private */
    this.localId = localId;

    /** @private */
    this._K = options.K || 8;

    /**
     * @type {Bucket|null}
     * @private
     */
    this._root = new Bucket(Buffer.alloc(20), Buffer.alloc(20, 0xff));

    /**
     * @type {Object.<string, Node>}
     * @private
     */
    this._nodeMap = {};

    /** @private */
    this._isDisposed = false;
  }

  get length() { return Object.keys(this._nodeMap).length; }

  /**
   * todo type the serialization format
   * @param {any[]} state
   */
  loadState(state) {
    for (let ns of state) {
      let idStr = ns[0];
      let id = Buffer.from(idStr, 'hex'),
            address = ns[1], port = ns[2], family = ns[3],
            token = ns[4] ? Buffer.from(ns[4], 'hex') : undefined;
      let ni = { id, address, port, family, token };
      let lastResponse = ns[5], lastReceivedQuery = ns[6],
          failedResponses = ns[7];

      let node = this._nodeMap[idStr];
      if (node) {
        node.lastResponse = lastResponse ? lastResponse : node.lastResponse;
        node.lastReceivedQuery = lastReceivedQuery ? lastReceivedQuery : node.lastReceivedQuery;
        node.failedResponses = failedResponses ? failedResponses : node.failedResponses;
      } else {
        node = new Node(ni);
        node.lastResponse = lastResponse;
        node.lastReceivedQuery = lastReceivedQuery;
        node.failedResponses = failedResponses;
        this._insertNode(node);
      }
    }
  }

  getState() {
    /** @type {[number, Node][]} */
    let all_nodes = Object.values(this._nodeMap)
        .map((n) => [distance(this.localId, n.id), n]);

    all_nodes.sort((a, b) => a[0] - b[0]);
    return all_nodes.map(([d, n]) => {
      return [
          n.id.toString('hex'),
          n.address.address, n.address.port, n.address.family,
          n.token ? n.token.toString('hex') : null,
          n.lastResponse, n.lastReceivedQuery, n.failedResponses
      ];
    });
  }

  dispose() {
    // todo if there are outstanding pings disposing can take upto 5s
    //      not great, we should look into a cancel immediate or something 
    this._isDisposed = true;
    this.removeAllListeners();
    this._root = null;
    this._nodeMap = {};
  }

  /**
   * @param {Buffer} id The id to search for.
   * @return {NodeInfo[]} The node info
   */
  closest(id, n=10) {
    id = (typeof id === 'string') ? Buffer.from(id, 'hex') : id;
    // todo, naive sort all nodes -- can be optimized?
    let allNodes = Object.values(this._nodeMap);
    /** @type {[number, Node][]} */
    let byDist = allNodes.map((node) => [distance(id, node.id), node]);

    byDist.sort((a, b) => a[0] - b[0]);
    return byDist.slice(0, n).map(([d, n]) => n.toNodeInfo());
  }

  /**
   * Check the 'freshness' of each bucket, if any are older than the ttl timeout
   * then fire a 'refresh' event with a random node id in the range.
   */
  refresh(ttl=GOODNESS_TIMEOUT) {
    const now = Date.now();
    let queue = [this._root];
    let bucket;
    while (bucket = queue.shift()) {
      if (bucket.left && bucket.right) {
        queue.push(bucket.left, bucket.right);
      }
      else if (bucket.lastChanged < now - ttl) {
        // needs refresh
        let rid = rand_on_range(bucket.min, bucket.max);
        this.emit('refresh', rid);
      }
    }
  }

  /**
   * @param {NodeInfo} nodeInfo
   */
  recordQuery(nodeInfo) {
    if (this._isDisposed) return;

    const now = Date.now();
    const idStr = nodeInfo.id.toString('hex');
    let node = this._nodeMap[idStr];
    if (node) {
      // node is already in the table, just update the last query time
      // todo compare ip and port
      node.lastReceivedQuery = now;
      debug('Updating node "%s" last query time', idStr);
      return;
    }

    // this is a new node, insert into routing table
    node = new Node(nodeInfo);
    node.lastReceivedQuery = now;
    debug('Attempting insert for node "%s" on query', idStr);
    return this._insertNode(node, false);
  }

  /**
   * @param {NodeInfo} nodeInfo
   */
  recordResponse(nodeInfo) {
    if (this._isDisposed) return;

    const now = Date.now();
    const idStr = nodeInfo.id.toString('hex');
    let node = this._nodeMap[idStr];
    if (node) {
      // node is already in the table, just update the last response time
      // todo compare ip and port
      node.lastResponse = now;
      node.failedResponses = 0;
      debug('Updating node "%s" last response time', idStr);
      return;
    }

    // this is a new node, insert into routing table
    node = new Node(nodeInfo);
    node.lastResponse = now;
    debug('Attempting insert for node "%s" on response', idStr);
    return this._insertNode(node, true);
  }

  /**
   * @param {NodeInfo} nodeInfo
   */
  recordNoResponse(nodeInfo) {
    if (this._isDisposed) return;

    let node = this._nodeMap[nodeInfo.id.toString('hex')];
    if (!node) return;
    node.failedResponses += 1;
  }

  /**
   * @param {Node} node The node to insert.
   * @param {boolean=} relaxed, whether to use relaxed mode... todo
   */
  async _insertNode(node, relaxed) {
    // todo protect against rogue actor flooding ids using ip address checks
    if (this._isDisposed || this._root === null) return;
    let bucket = this._root;
    while (bucket) {
      // if the bucket has space, just add it and be done
      if (bucket.contacts && bucket.contacts.length < this._K) {
        bucket.contacts.push(node);
        bucket.lastChanged = Date.now();
        this._nodeMap[node.id.toString('hex')] = node;
        return;
      }

      // bucket is already split, walk
      if (bucket.left && bucket.right) {
        bucket = (node.id <= bucket.left.max) ? bucket.left : bucket.right;
        continue;
      }

      // split the bucket if it contains the localId:
      if (bucket.min <= this.localId && this.localId < bucket.max) {
        if (this._split(bucket, !!relaxed)) {
          if (bucket.left === null || bucket.right === null)
            throw new Error('Bucket could not be split.');
          bucket = (node.id < bucket.left.max) ? bucket.left : bucket.right;
          continue;
        }
      }

      /** @param {Node} badnode */
      const replace = (badnode) => {
        this._evict(bucket, badnode);
        bucket.contacts.push(node);
        this._nodeMap[node.id.toString('hex')] = node;
        bucket.lastChanged = Date.now();
      };

      // if can't split, start eviction proceedings
      let unknown = [];
      for (let checknode of bucket.contacts) {
        if (checknode.isBad) return replace(checknode);
        else if (!checknode.isGood) {
          unknown.push(checknode);
        }
      }

      // 1. if all nodes in this bucket are good, then just discard
      if (unknown.length === 0) {
        return;
        // const nodetoevict = this.emit('bucketfull', node, bucket.contacts);
        // if (!nodetoevict) return;

      }

      // 2. otherwise, pick the least recently seen node and ping it
      //    if it doesn't respond then replace it
      unknown.sort((a, b) => (a.lastResponse || 0) - (b.lastResponse || 0));
      let checknode;

      // todo bulk ping?
      while (checknode = unknown.shift()) {
        let responded = await this._ping(checknode);
        if (this._isDisposed) return;

        if (responded) {
          bucket.lastChanged = Date.now();
          continue;
        } else {
          // todo spec says to ping again later
          // evict this node and insert the new one
          return replace(checknode);
        }
      }

      // all nodes checked responded
      // discard
      break;
    }
  }

  /**
   * @param {Bucket} bucket The bucket to evict from.
   * @param {Node} node The node to evict.
   */
  _evict(bucket, node) {
    delete this._nodeMap[node.id.toString('hex')];
    bucket.contacts.splice(bucket.contacts.indexOf(node), 1);
  }

  /**
   * Wrapper around the ping event so it can be used as a promise.
   * @param {Node} node The node to ping.
   */
  async _ping(node) {
    // wrap the ping event in a promise
    return new Promise((resolve) => {
      let failed = false;
      let timer = setTimeout(() => {
        failed = true;
        resolve(false);
      }, 5000);  // implementor should respond within 5 seconds

      this.emit('ping', node.toNodeInfo(), (/** @type {boolean} */ responded) => {
        if (failed) return;  // already failed
        clearTimeout(timer);

        // todo is this redundant? if the client already sets it?
        if (responded) {
          node.lastResponse = Date.now();
          node.failedResponses = 0;
        } else {
          node.failedResponses += 1;
        }
        resolve(responded);
      });
    });
  }

  /**
   * Split a bucket.
   * @param {Bucket} bucket The bucket to split.
   * @param {boolean} relaxed Whether to use relaxed mode... todo
   */
  _split(bucket, relaxed) {
    // todo relaxed splitting per https://stackoverflow.com/a/32187456
    let c = mid(bucket.min, bucket.max);
    if (c.equals(bucket.min) || c.equals(bucket.max)) return false;

    bucket.left = new Bucket(bucket.min, c);
    bucket.right = new Bucket(c, bucket.max);

    for (let node of bucket.contacts) {
      let target = (node.id < c) ? bucket.left : bucket.right;
      target.contacts.push(node);
    }
    bucket.contacts = [];
    return true;
  }
}


/**
 * Compute the node distance (XOR) between two node ids.
 * @param {Buffer} firstId The first id.
 * @param {Buffer} secondId The second id.
 * @return {number} The 'distance' metric between the two nodes.
 */
export function distance(firstId, secondId) {
  let distance = 0
  let i = 0
  const min = Math.min(firstId.length, secondId.length)
  const max = Math.max(firstId.length, secondId.length)
  for (; i < min; ++i) {
    distance = distance * 256 + (firstId[i] ^ secondId[i])
  }
  for (; i < max; ++i) distance = distance * 256 + 255
  return distance
}


/**
 * Compute the middle point between two node ids.
 * @param {Buffer} min The smaller id.
 * @param {Buffer} max The larger id.
 * @return {Buffer} The middle point between the two ids.
 */
function mid(min, max) {
  return Buffer.from(
      max.map((d, i) => (d+1-min[i])/2).map((d, i) => d + min[i]));
}


/**
 * Generate a random node id in the provided range.
 * @param {Buffer} min The minimum node id.
 * @param {Buffer} max The maximum node id.
 */
function rand_on_range(min, max) {
  return Buffer.from(max
      .map((d, i) => Math.floor((d+1-min[i]) * Math.random()))
      .map((d, i) => d + min[i]));
}

