const { EventEmitter } = require('events');
const { NodeInfo } = require('./krpc');
const debug = require('debug')('dht:routing');



const GOODNESS_TIMEOUT = 15 * 60 * 1000;   // 15 minutes
const SILENCE_BEFORE_BAD = 3;



class Node {
  constructor(nodeInfo) {
    this.id = (typeof nodeInfo.id === 'string') ?
        Buffer.from(nodeInfo.id, 'hex') : nodeInfo.id;
    this.ip = nodeInfo.address;
    this.port = nodeInfo.port;
    this.token = nodeInfo.token;

    this.lastResponse = null;
    this.lastReceivedQuery = null;
    this.failedResponses = 0;
  }

  get isGood() {
    const now = Date.now();
    return this.lastResponse && (this.failedResponses < SILENCE_BEFORE_BAD) && (
        (this.lastResponse >= (now - GOODNESS_TIMEOUT)) ||
        (this.lastReceivedQuery >= (now - GOODNESS_TIMEOUT)) );
  }

  get isBad() {
    return this.failedResponses >= SILENCE_BEFORE_BAD
  }

  toNodeInfo() {
    let ni = { id: this.id, address: this.ip, port: this.port };
    if (this.token) ni.token = this.token;
    return ni;
  }
}


class Bucket {
  constructor(min, max) {
    this.min = min;
    this.max = max;

    this.contacts = [];
    this.left = null;
    this.right = null;
    this.lastChanged = Date.now();
  }
}


/**
 * @typedef {{
 *   localId: Buffer,
 *   K?: number
 * }}
 */
var RoutingOptions;




class RoutingTable extends EventEmitter {
  /**
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

    /** @private */
    this._root = new Bucket(Buffer.alloc(20), Buffer.alloc(20, 0xff));

    /** @private */
    this._nodeMap = {};

    /** @private */
    this._isDisposed = false;
  }

  get length() { return Object.keys(this._nodeMap).length; }

  dispose() {
    // todo if there are outstanding pings disposing can take upto 5s
    //      not great, we should look into a cancel immediate or something 
    this._isDisposed = true;
    this.removeAllListeners();
    this._root = null;
    this._nodeMap = {};
  }

  closest(id, n=10) {
    id = (typeof id === 'string') ? Buffer.from(id, 'hex') : id;
    // todo, naive sort all nodes -- can be optimized?
    let allNodes = Object.values(this._nodeMap);
    let byDist = allNodes.map((node) => [distance(id, node.id), node]);

    byDist.sort((a, b) => a[0] - b[0]);
    return byDist.slice(0, n).map(([d, n]) => n.toNodeInfo());
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

  async _insertNode(node, relaxed) {
    // todo protect against rogue actor flooding ids using ip address checks
    if (this._isDisposed) return;
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
        if (this._split(bucket)) {
          bucket = (node.id < bucket.left.max) ? bucket.left : bucket.right;
          continue;
        }
      }

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
      unknown.sort((a, b) => (a.lastResponse || 0) - b.lastResponse);
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

  _evict(bucket, node) {
    delete this._nodeMap[node.id.toString('hex')];
    bucket.contacts.splice(bucket.contacts.indexOf(node), 1);
  }

  async _ping(node) {
    // wrap the ping event in a promise
    return new Promise((resolve) => {
      let failed = false;
      let timer = setTimeout(() => {
        failed = true;
        resolve(false);
      }, 5000);  // implementor should respond within 5 seconds

      this.emit('ping', node.toNodeInfo(), (responded) => {
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
    bucket.contacts = null;
    return true;
  }
}



function distance(firstId, secondId) {
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

function mid(min, max) {
  return max.map((d, i) => (d+1-min[i])/2).map((d, i) => d + min[i]);
}

module.exports = { RoutingTable, distance };
