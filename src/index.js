import util from 'util';
import dgram from 'dgram';
import crypto from 'crypto';
import fs from 'fs';
import EventEmitter from 'events';

import { RoutingTable, distance } from '#root/src/routing';
import { KRPCSocket } from '#root/src/krpc';
import { PromiseSelector, PQueue } from '#root/src/util';
import TokenStore from '#root/src/token-store';
import bep44 from '#root/src/storage';

import debugLogger from 'debug';
const debug = debugLogger('dht');



const ROUTING_REFRESH_INTERVAL = 1000 * 60 * 15;  // 15 minutes



/**
 * @typedef {{
 *   address: string,
 *   port: number,
 *   family?: string
 * }}
 */
var PeerInfo;


/**
 * @typedef {{
 *   id?: Buffer|string,
 *   K?: number,
 *   nodes?: Array.<any>,
 *   bootstrapNodes?: Array.<PeerInfo>
 * }}
 */
var DHTOptions;


/**
 * @type {!Array.<PeerInfo>}
 * @const
 */
const BOOTSTRAP_NODES = [
  { address: 'router.bittorrent.com', port: 6881 },
  { address: 'router.utorrent.com', port: 6881 },
  { address: 'dht.transmissionbt.com', port: 6881 }
];


/**
 * Implements:
 *   * [BEP 0005](http://www.bittorrent.org/beps/bep_0005.html)
 * @constructor
 * @param {DHTOptions=} opt_options Optional initialization options
 * @extends {EventEmitter}
 */
export default function DHT(opt_options) {
  EventEmitter.call(this);

  // Initialize the options
  opt_options = opt_options || {};

  /**
   * Default value of closest nodes to query.
   * @define {number}
   */
  this.K_ = opt_options['K'] || 8;

  /**
   * @type {Buffer}
   */
  this.id = opt_options.id ? (
      Buffer.isBuffer(opt_options.id) ?
          opt_options.id : Buffer.from(opt_options.id, 'hex')) :
      crypto.randomBytes(20);

  /**
   * @type {!Array.<!PeerInfo>}
   * @private
   */
  this.bootstrapNodes_ = opt_options.bootstrapNodes || BOOTSTRAP_NODES;

  /**
   * @type {boolean}
   * @private
   */
  this.isBootstrapping_ = false;

  /**
   * @type {RoutingTable}
   * @private
   */
  this.nodes_ = new RoutingTable(this.id, { K: this.K_ });
  this.nodes_.on('ping', this.handleBucketPing_.bind(this));
  this.nodes_.on('refresh', this.handleBucketRefresh_.bind(this));
  if (opt_options.nodes) this.nodes_.loadState(opt_options.nodes);

  this.refreshTimer_ = setInterval(
      this.handleRoutingRefresh_.bind(this), ROUTING_REFRESH_INTERVAL);

  /**
   * @type {dgram.Socket}
   * @private
   */
  this.socket_ = opt_options.socket ||
      dgram.createSocket({ type: 'udp4', reuseAddr: true });

  /**
   */
  this.rpc_ = new KRPCSocket(this.socket_);
  this.rpc_.on('query', this.handleQuery_.bind(this));
  this.rpc_.on('response', this.handleNodeResponse_.bind(this));
  this.rpc_.on('timeout', this.handleNodeTimeout_.bind(this));

  // this.socket_.on('message', this.handleSocketMessage_.bind(this));
  // this.socket_.on('error', this.handleSocketError_.bind(this));

  /**
   * Whether the socket is currently bound
   * @type {boolean}
   * @private
   */
  this.isBound_ = false;

  /**
   * To prevent ping spamming when travelling far, we track pending pings.
   * @type {!Object.<string, Promise>}
   * @private
   */
  this.pendingPings_ = {};

  /**
   * Storage for the DHT tracker.
   * @type {!TokenStore}
   * @private
   */
  this.announcedPeers_ = new TokenStore();

  // initialize the extensions
  /**
   * DHT implementors, i.e. method providers
   */
  this.extensions_ = []; // = [bep5, /*bep44*/];
  this.use(bep44);
}
util.inherits(DHT, EventEmitter);


/**
 * Instantiate a DHT from a serialized state file.
 * @param {string} filename The filename to load from.
 */
DHT.load = function(filename) {
  let state = JSON.parse(fs.readFileSync(filename).toString('utf-8'));
  return new DHT({
    K: state.K,
    id: Buffer.from(state.id, 'hex'),
    bootstrapNodes: [],
    nodes: state.nodes
  });
};


/**
 */
DHT.prototype.listen = async function(opt_port, opt_host) {
  debug('Starting DHT on port %s', opt_port);
  const listen = () => new Promise((resolve, reject) =>
      this.socket_.bind(opt_port, opt_host, resolve));

  await listen();
  this.isBound_ = true;
  const addr = this.socket_.address();
  debug('DHT listening on %s:%s', addr.address, addr.port); 

  // start bootstrapping
  this.isBootstrapping_ = true;
  await Promise.all(this.bootstrapNodes_.map(
    async (peer) => {
      debug('Bootstrapping node %s.', peer.address + ':' + peer.port);
      await this.ping(peer);
    }
  ));
  // collect nodes near to us to populate our bucket
  await this.find_node(this.id);
  debug('Bootstrapping done, with %s nodes in routing table', this.nodes_.length);
  this.isBootstrapping_ = false;
};


/**
 */
DHT.prototype.dispose = function() {
  clearInterval(this.refreshTimer_);
  this.rpc_.dispose();
  this.extensions_.forEach((e) => e.dispose());
  this.announcedPeers_.dispose();
  this.nodes_.dispose();
  this.socket_.close();

  this.announcedPeers_ = null;
  this.nodes_ = null;
  this.socket_ = null;
  this.rpc_ = null;
};


/**
 * Save the state of this DHT to a file.
 */
DHT.prototype.save = function(filepath) {
  let state = {
    K: this.K_,
    id: this.id.toString('hex'),
    nodes: this.nodes_.getState()
  };
  fs.writeFileSync(filepath, JSON.stringify(state));
};


/**
 */
DHT.prototype.use = function(extension) {
  const inst = new extension(this);
  inst.provides.forEach((method) => {
    Object.defineProperty(this, method, {
      value: inst[method].bind(inst)
    });
  });
  this.extensions_.push(inst);
};


/**
 */
DHT.prototype.closest_ = async function(target, method, args, opt_rescb) {
  // use a priority queue to track closest responding, a set and hashing fn to
  // track nodes we've already visited
  const closest = new PQueue(this.K_);
  const seen = new Set();
  const hash = (node) =>
      `${node.id.toString('hex')}:${node.address}:${node.port}`;

  // the 'promise selector' allows us to simulate a more traditional networking
  // api. i.e. loop and 'block' until any outstanding request resolves
  const selector = new PromiseSelector();
  selector.add(Promise.resolve({
    node: undefined,
    r: { nodes: this.nodes_.closest(target, this.K_) }
  }));

  // loop over responses waiting to be processed
  // will block waiting for a response or timeout
  let res = null;
  while (res = await selector.next()) {
    if (res.error) continue;
    const { node, r } = res;

    if (node) {
      const res_v = opt_rescb && opt_rescb(r, node);
      if (res_v) return res_v;

      // Add the responder to the bucket of closest
      closest.push(distance(target, node.id), node);
    }
    if (!r.nodes) continue;

    // Candidates are nodes we haven't queried before, and that are closer
    // than the furthest known node
    let candidates = r.nodes
        .filter((p) => !seen.has(hash(p)))
        .filter((p) => distance(p.id, target) < closest.max);

    for (let p of candidates) {
      seen.add(hash(p));
      selector.add(this.rpc_.query(p, method, args));
    }
  }

  debug('Closest \'%s\' query returned without a value.', method);
  return undefined;
};


/**
 */
DHT.prototype.isBound = function() {
  return this.isBound_;
};


/**
 * @param {NodeInfo} node The node that needs to be pinged.
 * @param {function(boolean): void} callback Callback to whether the ping
 *     succeeded or not.
 */
DHT.prototype.handleBucketPing_ = async function(node, callback) {
  const res = await this.ping(node);
  callback(!!res.error);
};


/**
 * When a bucket needs to be refreshed, we call find_node on a random id in the
 * range.
 * > "Buckets that have not been changed in 15 minutes should be "refreshed."
 * > This is done by picking a random ID in the range of the bucket and
 * > performing a find_nodes search on it."
 * - BEP-5
 * @param {Buffer} rangeId a random node id in the range of the bucket.
 */
DHT.prototype.handleBucketRefresh_ = async function(rangeId) {
  this.find_node(rangeId);
};


/**
 */
DHT.prototype.handleRoutingRefresh_ = function() {
  this.nodes_.refresh();
};


/**
 * Dispatches the core queries.
 */
DHT.prototype.handleQuery_ = function(method, args, node, respond) {
  this.nodes_.recordQuery(node);
  try {
    if (method === 'ping') respond( this.handlePing_(args, node) );
    if (method === 'find_node') respond( this.handleFindNode_(args.target, node) );
    if (method === 'get_peers') respond( this.handleGetPeers_(args, node) );
    if (method === 'announce_peer') respond( this.handleAnnouncePeer_(args, node) );
  } catch (e) {
    // todo send error
    console.error(e);
  }
};


/**
 * Record a node response to the routing table.
 * @param {NodeInfo} node The node that responded.
 */
DHT.prototype.handleNodeResponse_ = function(node) {
  this.nodes_.recordResponse(node);
};


/**
 * Record a no response to the routing table.
 * @param {NodeInfo} node The node that didn't respond.
 */
DHT.prototype.handleNodeTimeout_ = function(node) {
  if (!node.id) return;
  debug('Recording timeout for node %s', node.id.toString('hex'));
  this.nodes_.recordNoResponse(node);
};


/**
 * @param {!PeerInfo} peer The peer to ping.
 */
DHT.prototype.ping = function(peer) {
  let key = `${peer.address}:${peer.port}`;

  if (!(key in this.pendingPings_)) {
    this.pendingPings_[key] = this.rpc_.query(peer, 'ping', { 'id': this.id })
        .then((res) => {
          delete this.pendingPings_[key];
          return res;
        });
  }
  return this.pendingPings_[key];
};


/**
 */
DHT.prototype.handlePing_ = function(args, node) {
  return { id: this.id };
};


/**
 * Returns the result of a 'find_node' query, if opt_node is given this returns
 * the result of a single query otherwise it performs a recursive lookup
 * @param {Buffer} id Find the closest node to id.
 * @param {NodeInfo} opt_node Optional node.
 */
DHT.prototype.find_node = function(id) {
  return this.closest_(id, 'find_node', {
    'id': this.id,
    'target': id
  });
};


/**
 */
DHT.prototype.handleFindNode_ = function(target, node) {
  return {
    'id': this.id,
    'nodes': this.nodes_.closest(target, this.K_)
  };
};


/**
 * Get peers that have announced on the target hash.
 * @param {Buffer|string} target The target hash.
 * @param {PeerInfo} The announced peers.
 */
DHT.prototype.get_peers = async function(target) {
  target = (typeof target === 'string') ? Buffer.from(target, 'hex') : target;
  debug('Looking up peers for \'%s\'.', target.toString('hex'));

  // maintain a set of peers
  const peers = {};
  const hash = (peer) =>
    `${peer.address}:${peer.family}:${peer.port}`;
  const push_peer = (peer) => peers[hash(peer)] = peer;

  await this.closest_(target, 'get_peers', {
    'id': this.id,
    'info_hash': target
  }, (r) => {
    if (r.values) {
      r.values.forEach((cp) => push_peer(decodeCompactPeerInfo(cp)));
    }
  });

  return Object.values(peers);
}

/**
 * Handle an incoming `get_peers` query.
 * @param {GetPeersRequest} args The args object that was sent.
 * @param {NodeInfo} node The requester.
 * @return {GetPeersResponse} The response.
 */
DHT.prototype.handleGetPeers_ = function(args, node) {
  const r = {
    'id': this.id,
    'token': this.announcedPeers_.getWriteToken(args.info_hash, node),

    // according to BEP5, if we find peers locally we should *not* return nodes
    // but that is stupid, so we are going to send nodes no matter what
    'nodes': this.nodes_.closest(args.info_hash, this.K_)
  };

  const peers = this.announcedPeers_.get(args.info_hash);
  if (peers) {
    debug('Node %s:%s \'get_peers\' query found local peers for \'%s\'.',
        node.address, node.port, args.info_hash.toString('hex'));

    r['values'] = Array.from(peers).map( (p) => Buffer.from(p, 'hex') );
  } else {
    debug('Node %s:%s \'get_peers\' query did not find local peers for \'%s\'.',
        node.address, node.port, args.info_hash.toString('hex'));
  }

  return r;
};


/**
 * Announce to the DHT.
 * @param {Buffer|string} target The target hash that we are announcing on.
 * @param {=number} opt_port The port to announce, if this is not supplied
 *     the port will be implied.
 */
DHT.prototype.announce_peer = async function(target, opt_port) {
  target = (typeof target === 'string') ? Buffer.from(target, 'hex') : target;
  debug('Announcing \'%s\'%s.', target.toString('hex'),
      opt_port ? (' on port ' + opt_port) : '');

  // create a bucket to store nodes with write tokens
  const writeable = new PQueue(this.K_);
  await this.closest_(target, 'get_peers', {
    'id': this.id,
    'info_hash': target
  }, (r, node) => {
    if (node.token) writeable.push(distance(target, node.id), node);
  });

  // write to the K closest
  const closest = writeable.items();
  await this.rpc_.query(closest, 'announce_peer', {
    'id': this.id,
    'info_hash': target,
    'implied_port': opt_port === undefined ? 1 : 0,
    'port': opt_port || this.socket_.address().port,
    'token': (node) => node.token
  });

  return target;
};


/**
 * Handle the 'announce_peer' query.
 * @params {!AnnouncePeerRequest} args The request args.
 * @params {!NodeInfo} node The requester.
 * @return {!AnnoucePeerResponse} The response.
 */
DHT.prototype.handleAnnouncePeer_ = function(args, node) {
  const target = args.info_hash;

  // verify that the token owner is the requesting node first, since it is
  // much cheaper to check that before verifying signatures or hashes.
  if (!this.announcedPeers_.verifyToken(args.token, target, node)) {
    debug('Node %s:%s \'announce_peer\' to \'%s\' failed with a bad token.',
        node.address, node.port, target.toString('hex'));
    throw new Error('Bad token');
  }

  let peers = this.announcedPeers_.get(target);
  if (!peers) {
    peers = new Set(); // we use a set to ensure we aren't duplicating
    this.announcedPeers_.set(target, peers, node, args.token);
  }

  debug('Node %s:%s announced to \'%s\'.',
      node.address, node.port, target.toString('hex'));
  const peer = {
    address: node.address,
    family: 'ipv4',
    port: args.implied_port ? node.port : args.port
  };
  peers.add(encodeCompactNodeInfo(peer).toString('hex'));
  return { 'id': this.id };
};


/**
 * Decode a 'Compact peer info' buffer.
 * @param {Buffer} buf The buffer to decode.
 * @return {PeerInfo} The decoded peer info.
 * @todo Why is ipv6 peer info not described in the BEP?
 */
function decodeCompactPeerInfo(buf) {
  const ip = buf.readUInt8(0) + '.' +
             buf.readUInt8(1) + '.' +
             buf.readUInt8(2) + '.' +
             buf.readUInt8(3);
  const port = buf.readUInt16BE(4);
  return { address: ip, family: 'ipv4', port: port };
};


/**
 * Encode a 'Compact peer info' buffer.
 * @param {PeerInfo} peer The decoded peer info.
 * @return {Buffer} The buffer to decode.
 */
function encodeCompactNodeInfo(peer) {
  const buf = Buffer.alloc(6);

  // todo assumes ipv4
  const ip_parts = peer.address.split('.').map((i) => parseInt(i, 10));
  buf.writeUInt8(ip_parts[0], 0);
  buf.writeUInt8(ip_parts[1], 1);
  buf.writeUInt8(ip_parts[2], 2);
  buf.writeUInt8(ip_parts[3], 3);
  buf.writeUInt16BE(peer.port, 4);
  return buf;
}
