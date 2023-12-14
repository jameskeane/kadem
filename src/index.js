import dgram from 'dgram';
import crypto from 'crypto';
import fs from 'fs';
import EventEmitter from 'events';

import { RoutingTable, distance } from './routing.js';
import { KRPCSocket } from './krpc.js';
import { PromiseSelector, PQueue } from './util.js';
import TokenStore from './token-store.js';
import bep44 from './storage.js';

import debugLogger from 'debug';
const debug = debugLogger('dht');



const ROUTING_REFRESH_INTERVAL = 1000 * 60 * 15;  // 15 minutes


/**
 * @typedef {{
 *   id?: Buffer|string,
 *   K?: number,
 *   nodes?: Array.<any>,
 *   bootstrapNodes?: Array.<PeerInfo>,
 *   socket?: dgram.Socket
 * }} DHTOptions
 * @typedef {{
 *   id: Buffer,
 *   implied_port: 0|1,
 *   info_hash: Buffer,
 *   port: number,
 *   token: Buffer
 * }} AnnouncePeerRequest
 * @typedef {{ id: Buffer }} AnnoucePeerResponse
 * @typedef {{ id: Buffer, info_hash: Buffer }} GetPeersRequest
 * @typedef {{
 *   id: Buffer, token: Buffer, values?: Buffer[], nodes?: NodeInfo[]
 * }} GetPeersResponse
 */


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
 */
export default class DHT extends EventEmitter {

  /**
   * @param {DHTOptions=} opt_options Optional initialization options
   */
  constructor(opt_options) {
    super();

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
     * @todo make private
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
     * @type {!Object.<string, Promise<any>>}
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
     * @type {IDHTExtension[]}
     * @private
     */
    this.extensions_ = []; // = [bep5, /*bep44*/];
    this.use(bep44);
  }


  /**
   * Instantiate a DHT from a serialized state file.
   * @param {string} filename The filename to load from.
   */
  static load(filename) {
    if (filename == undefined || !fs.existsSync(filename)) return new DHT();

    let state = JSON.parse(fs.readFileSync(filename).toString('utf-8'));
    return new DHT({
      K: state.K,
      id: Buffer.from(state.id, 'hex'),
      bootstrapNodes: [],
      nodes: state.nodes
    });
  }


  /**
   * @param {number=} opt_port Optional port to listen on.
   * @param {string=} opt_host Optional listening address to listen on.
   */
  async listen(opt_port, opt_host) {
    debug('Starting DHT on port %s', opt_port);
    const listen = () => new Promise((resolve, reject) =>
        this.socket_.bind(opt_port, opt_host, () => resolve(null)));

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
  }


  /**
   */
  dispose() {
    clearInterval(this.refreshTimer_);
    this.rpc_.dispose();
    this.extensions_.forEach((e) => e.dispose());
    this.announcedPeers_.dispose();
    this.nodes_.dispose();
    this.socket_.close();

    // this.announcedPeers_ = null;
    // this.nodes_ = null;
    // this.socket_ = null;
    // this.rpc_ = null;
  }


  /**
   * Save the state of this DHT to a file.
   * @param {string} filepath The path to the file to save the state into.
   */
  save(filepath) {
    let state = {
      K: this.K_,
      id: this.id.toString('hex'),
      nodes: this.nodes_.getState()
    };
    fs.writeFileSync(filepath, JSON.stringify(state));
  }


  /**
   * Configure the DHT to use an extension.
   * @param {IDHTExtensionConstructor} extension The extension constructor to
   *  initialize.
   */
  use(extension) {
    const inst = new extension(this);
    
    /** @type {any} */
    const instany = inst;
    inst.provides.forEach((method) => {
      Object.defineProperty(this, method, {  // @todo this doesn't work well for typing
        value: instany[method].bind(inst)
      });
    });
    this.extensions_.push(inst);
  }


  /**
   * Recursively traverse the network, starting from my peer list and moving
   * n closer each time.
   * @param {Buffer} target
   * @param {string} method
   * @param {any} args
   * @param {((a: any, n: NodeInfo)=>T)=} opt_rescb
   * @template T
   */
  async closest_(target, method, args, opt_rescb) {
    // use a priority queue to track closest responding, a set and hashing fn to
    // track nodes we've already visited
    const closest = new PQueue(this.K_);
    const seen = new Set();
    const hash = (/** @type {NodeInfo} */ node) =>
        `${node.id.toString('hex')}:${node.address}:${node.port}`;

    // the 'promise selector' allows us to simulate a more traditional networking
    // api. i.e. loop and 'block' until any outstanding request resolves
    /** @type {PromiseSelector<ITraversableQueryBase>} */
    const selector = new PromiseSelector([
        Promise.resolve({
          r: { nodes: this.nodes_.closest(target, this.K_) }
        })]);

    // loop over responses waiting to be processed
    // will block waiting for a response or timeout
    let res = null;
    while (res = await selector.next()) {
      // if (res.error) continue;   // @todo why was this here?
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
  }


  /**
   */
  isBound() {
    return this.isBound_;
  }


  /**
   * @param {NodeInfo} node The node that needs to be pinged.
   * @param {function(boolean): void} callback Callback to whether the ping
   *     succeeded or not.
   */
  async handleBucketPing_(node, callback) {
    const res = await this.ping(node);
    callback(!!res.error);
  }


  /**
   * When a bucket needs to be refreshed, we call find_node on a random id in the
   * range.
   * > "Buckets that have not been changed in 15 minutes should be "refreshed."
   * > This is done by picking a random ID in the range of the bucket and
   * > performing a find_nodes search on it."
   * - BEP-5
   * @param {Buffer} rangeId a random node id in the range of the bucket.
   */
  async handleBucketRefresh_(rangeId) {
    this.find_node(rangeId);
  }


  /**
   */
  handleRoutingRefresh_() {
    this.nodes_.refresh();
  }


  /**
   * Dispatches the core queries.
   * @param {string} method The query method.
   * @param {any} args The arguments.
   * @param {NodeInfo} node The sending node.
   * @param {function} respond The callback to respond to the query.
   */
  handleQuery_(method, args, node, respond) {
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
  }


  /**
   * Record a node response to the routing table.
   * @param {NodeInfo} node The node that responded.
   */
  handleNodeResponse_(node) {
    this.nodes_.recordResponse(node);
  }


  /**
   * Record a no response to the routing table.
   * @param {NodeInfo} node The node that didn't respond.
   */
  handleNodeTimeout_(node) {
    if (!node.id) return;
    debug('Recording timeout for node %s', node.id.toString('hex'));
    this.nodes_.recordNoResponse(node);
  }


  /**
   * @param {!PeerInfo} peer The peer to ping.
   */
  ping(peer) {
    let key = `${peer.address}:${peer.port}`;

    if (!(key in this.pendingPings_)) {
      this.pendingPings_[key] = this.rpc_.query(peer, 'ping', { 'id': this.id })
          .then((res) => {
            delete this.pendingPings_[key];
            return res;
          });
    }
    return this.pendingPings_[key];
  }


  /**
   * @param {{id: Buffer}} args
   * @param {NodeInfo} node
   */
  handlePing_(args, node) {
    return { id: this.id };
  }


  /**
   * Returns the result of a 'find_node' query, if opt_node is given this returns
   * the result of a single query otherwise it performs a recursive lookup
   * @param {Buffer} id Find the closest node to id.
   * @return {Promise<NodeInfo|undefined>} opt_node Optional node.
   */
  find_node(id) {
    return this.closest_(id, 'find_node', {
      'id': this.id,
      'target': id
    });
  }


  /**
   * @param {any} target
   * @param {NodeInfo} node
   */
  handleFindNode_(target, node) {
    return {
      'id': this.id,
      'nodes': this.nodes_.closest(target, this.K_)
    };
  }


  /**
   * Get peers that have announced on the target hash.
   * @param {Buffer|string} target The target hash.
   * @return {Promise<PeerInfo[]>} The announced peers.
   */
  async get_peers(target) {
    target = (typeof target === 'string') ? Buffer.from(target, 'hex') : target;
    debug('Looking up peers for \'%s\'.', target.toString('hex'));

    // maintain a set of peers
    /** @type {Object<string, PeerInfo>} */
    const peers = {};
    const hash = (/** @type {PeerInfo} */ peer) =>
      `${peer.address}:${peer.family}:${peer.port}`;
    const push_peer = (/** @type {PeerInfo} */peer) => peers[hash(peer)] = peer;

    await this.closest_(target, 'get_peers', {
      'id': this.id,
      'info_hash': target
    }, (/** @type {GetPeersResponse} **/ r) => {
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
  handleGetPeers_(args, node) {
    /** @type {GetPeersResponse} */
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
  }


  /**
   * Announce to the DHT.
   * @param {Buffer|string} target The target hash that we are announcing on.
   * @param {number=} opt_port The port to announce, if this is not supplied
   *     the port will be implied.
   */
  async announce_peer(target, opt_port) {
    const targetID = (typeof target === 'string') ? Buffer.from(target, 'hex') : target;

    debug('Announcing \'%s\'%s.', targetID.toString('hex'),
        opt_port ? (' on port ' + opt_port) : '');

    // create a bucket to store nodes with write tokens
    const writeable = new PQueue(this.K_);
    await this.closest_(targetID, 'get_peers', {
      'id': this.id,
      'info_hash': targetID
    }, (r, node) => {
      if (node.token) writeable.push(distance(targetID, node.id), node);
    });

    // write to the K closest
    const closest = writeable.items();
    await this.rpc_.query(closest, 'announce_peer', {
      'id': this.id,
      'info_hash': targetID,
      'implied_port': opt_port === undefined ? 1 : 0,
      'port': opt_port || this.socket_.address().port,
      'token': (/** @type {NodeInfo} */ node) => node.token
    });

    return targetID;
  }


  /**
   * Handle the 'announce_peer' query.
   * @param {!AnnouncePeerRequest} args The request args.
   * @param {!NodeInfo} node The requester.
   * @return {!AnnoucePeerResponse} The response.
   */
  handleAnnouncePeer_(args, node) {
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
    peers.add(encodeCompactNodeInfo({
      address: node.address,
      family: 'ipv4',
      port: args.implied_port ? node.port : args.port
    }).toString('hex'));
    return { 'id': this.id };
  }


  /**
   * @param {Buffer} id The target node or key id.
   * @param {number=} opt_n How many to return, i.e. n-closest.
   * @return {NodeInfo[]} The n closest nodes
   */
  closestNodes(id, opt_n) {
    return this.nodes_.closest(id, opt_n);
  }
}


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
