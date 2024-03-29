import { EventEmitter } from 'events';
import bencode from 'bencode';
import crypto from 'crypto';

import debugLogger from 'debug';
const debug = debugLogger('dht:rpc');


/**
 * @typedef {import('dgram').Socket} UDPSocket
 */


/**
 * Implements the KRPC Protocol, as defined in [BEP 0005].
 * See: http://www.bittorrent.org/beps/bep_0005.html
 *
 * The KRPC protocol is a simple RPC mechanism consisting of bencoded
 * dictionaries sent over UDP. A single query packet is sent out and a single
 * packet is sent in response. There is no retry.
 * There are three message types: query, response, and error.
 */
export class KRPCSocket extends EventEmitter {

  /**
   * @param {UDPSocket} socket The socket to run krpc over.
   * @param {any=} opt_options
   */
  constructor(socket, opt_options) {
    super();
    opt_options = opt_options || {};

    /**
     * Timeout for query responses in ms
     * @type {number}
     * @private
     */
    this.RESPONSE_TIMEOUT_ = opt_options['timeout'] === undefined ?
        2000 : opt_options['timeout'];

    /**
     * Outstanding queries' resolve functions
     * @type {!Object.<string, [function, function, NodeJS.Timeout?]>}
     * @private
     */
    this.outstandingTransactions_ = {};

    /**
     * @type {UDPSocket}
     * @private
     */
    this.socket_ = socket;

    this.boundHandleMessage_ = this.handleMessage_.bind(this);
    this.boundHandleError = this.handleError_.bind(this);
    this.socket_.addListener('message', this.boundHandleMessage_);
    this.socket_.addListener('error', this.boundHandleError);
  }

  /**
   * Dispose of the current socket and listeners.
   */
  dispose() {
    this.removeAllListeners();
    this.socket_.removeListener('message', this.boundHandleMessage_);
    this.socket_.removeListener('error', this.boundHandleError);
    this.socket_.unref();

    // clear outstanding transactions
    for (let [_, reject, timeout] of Object.values(this.outstandingTransactions_)) {
      clearTimeout(timeout);
      reject('Socket is disposing');
    }
    this.outstandingTransactions_ = {};
  }


  /**
   * @param {PeerInfo|Array.<PeerInfo>} peer
   * @param {string} method
   * @param {KRPCQueryArgument=} opt_args
   * @return {Promise.<any>} The response from the peer to the query
   */
  query(peer, method, opt_args) {
    opt_args = opt_args || {};

    // Accept and map multiple peers
    if (Array.isArray(peer)) {
      return Promise.all(peer.map((p) => this.query(p, method, opt_args)));
    }

    // Copy the args object, since we allow functions to provide values
    /** @type {{[k: string]: any}} */
    const args = {};    
    for (let arg in opt_args) {
      if (typeof opt_args[arg] === 'function') {
        args[arg] = opt_args[arg](peer, method, opt_args);
      } else {
        args[arg] = opt_args[arg];
      }
    }

    return this.transact_(peer, (tid) => {
      const buf = bencode.encode({
        't': tid,      // transaction id
        'y': 'q',      // message type, 'q' is 'query'
        'q': method,   // method name of the query
        'a': args,     // named arguments to the query
       // 'v': ''  BEP 0005 specifies we include this, but ...
      });

      // send the request
      const tstr = tid.toString('hex');
      debug('Sending \'%s\' query [%s] to %s', method, tstr, peer.address + ':' + peer.port);
      this.socket_.send(buf, 0, buf.length, peer.port, peer.address);
    }).catch((err) => {
      return { error: err };
    })
  }


  /**
   * @param {Buffer} msg
   * @param {PeerInfo} rinfo
   */
  handleMessage_(msg, rinfo) {

    let /** @type {any} */ bmsg, /** @type {string} */ tid, /** @type {string} */ msgtype;
    try {
      bmsg = bencode.decode(msg);
      tid = bmsg.t.toString('hex')
      msgtype = bmsg.y.toString('utf8');
    } catch(e) {
      const message = (e && typeof e == 'object' && 'message' in e) ? e.message : '';
      debug('Unrecognized socket message', msg.toString(), message);
      return;
    }

    // if the incoming message is a reply we handle things differently
    if (msgtype === 'r' || msgtype === 'e') {
      if (!(tid in this.outstandingTransactions_)) {
        debug('Unexpected transaction id %s.', tid);
        return;
      }

      const [resolve, reject] = this.outstandingTransactions_[tid];
      if (msgtype === 'r') {
        debug('Received response for transaction: %s.', tid);
        const r = bmsg.r;
        if (r.nodes) {
          r.nodes = decodeRecievedNodes(r.nodes);
        }

        let node = makeNodeInfo(r.id, rinfo, r.token);
        this.emit('response', node, bmsg.r);
        resolve({
          node: node,
          r: bmsg.r
        });
      } else {
        const [code, desc] = bmsg.e;
        debug('Error response for transaction %s: %s %s', tid, code, desc);
        const err = new KRPCError(code, desc.toString(), rinfo); 

        reject(err);
        // this.emit('error', err);
      }
    } else if (msgtype === 'q') {
      const method = bmsg.q.toString();
      debug('Received incoming query with method \'%s\' from %s:%s',
          method, rinfo.address, rinfo.port);

      const node = makeNodeInfo(bmsg.a.id, rinfo);
      this.emit('query', method, bmsg.a, node, (/** @type {any} */ r) => {
        // todo clean this up
        if (r.nodes) {
          r.nodes = encodeCompactNodeSet(r.nodes);
        }

        const buf = bencode.encode({
          't': bmsg.t,   // transaction id
          'y': 'r',      // message type, 'r' is 'response'
          'r': r         // the response
        });

        // send the response
        debug('Sending response to \'%s\' query [%s] to %s', method, tid,
            rinfo.address + ':' + rinfo.port);
        this.socket_.send(buf, 0, buf.length, rinfo.port, rinfo.address);
      });
    } else {
      debug('Unexpected krpc message type \'%s\'.', msgtype);
    }
  }


  /**
   * @param {Error} err The error to handle
   */
  handleError_(err) {
    console.error(err);
  }


  /**
   * Handles the transaction logic, since we want to present a nice promise based
   * send -> response API, we need to do some special wrapping.
   * @param {!PeerInfo} peer 
   * @param {!function(Buffer):void} inner The inner function that will be transacted.
   * @return {!Promise.<any>} The transaction resolution. 
   */
  transact_(peer, inner) {
    // Return the promise that will resolve on a response with
    // the correct transaction id.
    return new Promise((resolve, reject) => {
      // Generate a random transaction id for responses
      let tid;
      do {
        tid = crypto.randomBytes(4);
      } while (tid.toString('hex') in this.outstandingTransactions_);
      let tstr = tid.toString('hex');

      /** @type {NodeJS.Timeout=} */
      let timeout = undefined;
      const cleanUp = () => {
        delete this.outstandingTransactions_[tstr];
        if (timeout) clearTimeout(timeout);
      };

      // set the timeout
      if (this.RESPONSE_TIMEOUT_ !== 0) {
        timeout = setTimeout(() => {
          this.emit('timeout', peer);

          cleanUp();
          debug('Timeout exceeded for transaction: ' + tstr);
          reject(new Error('Timeout exceeded for transaction: ' + tstr));
        }, this.RESPONSE_TIMEOUT_);
      }

      // Register the transaction
      this.outstandingTransactions_[tstr] = [
        (/** @type {any} */ res) => { cleanUp(); resolve(res); },
        (/** @type {any} */ err) => { cleanUp(); reject(err); },
        timeout
      ];

      // call the inner fn
      inner(tid);
    });
  }
}


/**
 */
class KRPCError extends Error {
  /**
   * @param {number} code
   * @param {string} description
   * @param {PeerInfo} peer
   */
  constructor(code, description, peer) {
    super(`[${code}]: ${description}`);
    
    this.code = code;
    this.description = description;
    this.peer = peer;
  }
}


/**
 * Decode a 'Compact node info' buffer.
 * @param {Buffer} buf The buffer to decode.
 * @return {NodeInfo} The decoded node info.
 */
function decodeCompactNodeInfo(buf) {
  const id = buf.slice(0, 20)
  const ip = buf.readUInt8(20) + '.' +
             buf.readUInt8(21) + '.' +
             buf.readUInt8(22) + '.' +
             buf.readUInt8(23);
  const port = buf.readUInt16BE(24);
  return { id: id, address: ip, port: port, family: 'ipv4' }; // todo support ipv6
};


/**
 * @param {Buffer} buffer
 */
function decodeRecievedNodes(buffer) {
  const len = buffer.length / 26;
  const nodes = [];
  for (let i = 0; i < len; i++) {
    nodes.push(decodeCompactNodeInfo(buffer.slice(i * 26)));
  }
  return nodes;
};


/**
 * @param {Buffer} id The node's id.
 * @param {PeerInfo} peer The peer.
 * @param {Buffer=} token Optional write token of this peer.
 * @return {NodeInfo} The combined id + peer, node.
 * @private
 */
function makeNodeInfo(id, peer, token=undefined) {
  return {
    id: id,
    address: peer.address,
    family: peer.family,
    port: peer.port,
    token: token
  };
};


/**
 * Encode a 'Compact node info' buffer.
 * @param {NodeInfo} node The decoded node info.
 * @return {Buffer} The buffer to decode.
 */
function encodeCompactNodeInfo(node) {
  const buf = Buffer.alloc(26);
  node.id.copy(buf);

  // todo assumes ipv4
  const ip_parts = node.address.split('.').map((i) => parseInt(i, 10));
  buf.writeUInt8(ip_parts[0], 20);
  buf.writeUInt8(ip_parts[1], 21);
  buf.writeUInt8(ip_parts[2], 22);
  buf.writeUInt8(ip_parts[3], 23);
  buf.writeUInt16BE(node.port, 24);
  return buf;
}


/**
 * @param {Array.<NodeInfo>} nodes
 */
function encodeCompactNodeSet(nodes) {
  const buf = Buffer.alloc(nodes.length * 26);
  nodes.map(encodeCompactNodeInfo).forEach((nb, i) => {
    nb.copy(buf, i * 26);
  });
  return buf;
};
