import ed25519 from 'ed25519-supercop';
import bencode from 'bencode';

import TokenStore from './token-store.js';
import { distance } from './routing.js';
import { sha1, PQueue } from './util.js';

import debugLogger from 'debug';
const debug = debugLogger('dht:storage');


/**
 * @typedef {{ k?: Buffer|string, salt?: Buffer|string }} DHTGetOptions
 * @typedef {{ id?: Buffer, token?: Buffer|((n: NodeInfo)=>Buffer|undefined), v?: Buffer, k?: Buffer, sig?: Buffer, seq?: number, salt?: Buffer }} DHTStoreRecord
 * @typedef {function(function(DHTStoreRecord, Buffer): void, DHTStoreRecord=): DHTStoreRecord} DHTSignatureCallback
 * @typedef { { id: Buffer, target: Buffer } } GetRequest 
 * @typedef {any} GetResponse todo
 * @typedef {{
 *    id: Buffer, k: Buffer, salt?: Buffer, sig: Buffer, 
 *    cas?: number, seq?: number,  
 *    token: Buffer,
 *    v: Buffer
 * }} PutRequest
 * @typedef {any} PutResponse todo
 */


/**
 * Storage Extension for the DHT.
 * Implements [BEP-44](http://www.bittorrent.org/beps/bep_0044.html)
 */
export default class DHTStorage {

  /**
   * @param {IDHT} dht The DHT instance that this extension is extending
   */ 
  constructor(dht) {
    this.provides = ['get', 'put'];

    /**
     * @private
     */
    this.dht_ = dht;

    /**
     * @private
     */
    this.rpc_ = dht.rpc_;
    this.rpc_.on('query', this.handleQuery_.bind(this));

    /**
     * @type {!TokenStore}
     * @private
     */
    this.store_ = new TokenStore();
  }


  /**
   * Dispose this object.
   */
  dispose() {
    this.store_.dispose();
  }


  /**
   * Lookup a value on the DHT.
   * @param {Buffer|string|DHTGetOptions} args Either the SHA1 target
   *     hash of the value or the options dictionary.
   */
  async get(args) {
    // decode the arguments
    let opts = Buffer.isBuffer(args) || typeof args === 'string' ? null : args;
    let salt = !(opts && 'salt' in opts) ? undefined :
          (typeof opts.salt === 'string' ? Buffer.from(opts.salt) : opts.salt);
    let k = !(opts && 'k' in opts) ? undefined :
          (typeof opts.k === 'string' ? Buffer.from(opts.k, 'hex') : opts.k);
    /** @type {Buffer} */
    let target;
    if (Buffer.isBuffer(args)) {
      target = args;
    } else if (typeof args === 'string') {
      target = Buffer.from(args, 'hex');
    } else {
      if (!k) throw new Error('A target key _must_ be provided.');
      target = sha1(salt ? Buffer.concat([k, salt]) : k);
    }

    // first check if we have it locally
    const stored = this.store_.get(target);
    if (stored) {
      debug('Value for \'%s\' found locally.', target.toString('hex'));
      return stored;
    }

    // todo opts.seq can be sent in the query
    debug('Asking network for value for \'%s\'.', target.toString('hex'));
    const res = await this.dht_.closest_(target, 'get', {
      'target': target,
      'id': this.dht_.id
    }, GetResponseValidator(target, salt));

    if (res) {
      debug('Found %s value for \'%s\'.',
          res.sig ? 'mutable' : 'immutable', target.toString('hex'));
    } else {
      debug('No value found for \'%s\'.', target.toString('hex'));
    }
    return res;
  }


  /**
   * @param {Buffer|string} key_or_v Either the value (if immutable) or public key
   *     if mutable.
   * @param {(DHTSignatureCallback|string|Buffer)=} opt_salt Optional salt for
   *     mutable puts, or if no salt the signature callback.
   * @param {DHTSignatureCallback=} cb If using salt, the signature callback.
   */
  async put(key_or_v, opt_salt, cb) {
    // if immutable
    if (opt_salt === undefined) return this.putImmutable_(key_or_v);
    if (typeof key_or_v === 'string') throw new Error('Invalid public key');
    if (typeof opt_salt === 'function') {
      cb = opt_salt;
      opt_salt = undefined;
    }
    if (typeof opt_salt === 'string') {
      opt_salt = Buffer.from(opt_salt);
    }

    if (opt_salt && opt_salt.length > 64) throw new Error('Salt must be less than 64 bytes.');
    if (key_or_v.length !== 32) throw new Error('ed25519 public key must be 32 bytes.');
    if (!cb) throw new Error('A signing function must be provided');

    const target = sha1(opt_salt ?
        Buffer.concat([key_or_v, opt_salt]) : key_or_v);
    debug('Writing mutable data for key: \'%s%s\'.',
        key_or_v.toString('hex'), opt_salt ? '::' + opt_salt.toString('hex') : '');

    // prepare write tokens
    /** @type {DHTStoreRecord} */
    let prev = {
      k: key_or_v,
      v: undefined,
      sig: undefined,
      seq: 0
    };
    if (opt_salt) prev.salt = opt_salt;

    // create a bucket to store nodes with write tokens
    const writeable = new PQueue(this.dht_.K_);
    await this.dht_.closest_(target, 'get', {
      'target': target,
      'id': this.dht_.id
    }, (r, node) => {
      if (node.token) {
        debug('found writable node', node.address);
        writeable.push(distance(target, node.id), node);
      }
      if (r.v) {
        // todo exit if the seq is higher than what we are trying to put
        // todo create a list of nodes that have old data we need to update
        // console.log('------', r);
      }
    });

    // call for value
    const signed = cb((r, secretKey) => {
      r.id = this.dht_.id;

      r.k = r.k || prev.k;
      r.v = r.v || prev.v;
      r.v = typeof r.v === 'string' ? Buffer.from(r.v) : r.v;
      r.seq = r.seq || prev.seq;
      if (r.salt || prev.salt) r.salt = r.salt || prev.salt;

      r.sig = ed25519.sign(encodeSigData(r), key_or_v, secretKey);
      return r;
    }, prev);
    signed.token = (node) => node.token;

    if (!signed.v || signed.v.length > 1000) throw new Error('v must be less than 1000 bytes');

    // write to the K closest
    const closest = writeable.items();
    await this.rpc_.query(closest, 'put', signed);
    return target;
  }


  /**
   * Put immutable data to the DHT.
   * @param {string|Buffer} data The immutable data to put.
   * @return {Promise.<Buffer>} The sha key the data was stored at.
   */
  async putImmutable_(data) {
    const v = (typeof data === 'string') ?
          Buffer.from(data) : data;
    const target = sha1(bencode.encode(v));

    if (v.length > 1000) throw new Error('v must be less than 1000 bytes');
    debug('Writing immutable data as \'%s\'.', target.toString('hex'));

    // create a bucket to store nodes with write tokens
    const writeable = new PQueue(this.dht_.K_);
    await this.dht_.closest_(target, 'get', {
      'target': target,
      'id': this.dht_.id
    }, (r, node) => {
      if (node.token) writeable.push(distance(target, node.id), node);
    });

    // write to the K closest
    const closest = writeable.items();
    await this.rpc_.query(closest, 'put', {
      'id': this.dht_.id,
      'v': v,
      'token': (/** @type {NodeInfo} */ node) => node.token
    });

    return target;
  }


  /**
   * @param {string} method The query method we are handling.
   * @param {any} args The arguments.
   * @param {NodeInfo} node The sending node
   * @param {function(any):void} respond
   */
  handleQuery_(method, args, node, respond) {
    try {
      if (method === 'get') respond( this.handleGetQuery_(args, node) );
      if (method === 'put') respond( this.handlePutQuery_(args, node) );
    } catch (e) {
      // todo figure out how to respond with an error
      console.error('todo: implement error response', e);
    }
  }


  /**
   * Handle a get query.
   * @param {GetRequest} args The get query args.
   * @param {NodeInfo} node The requesting node.
   * @return {GetResponse} The response.
   * @private
   */
  handleGetQuery_(args, node) {
    const stored = this.store_.get(args.target);
    const nodes = this.dht_.closestNodes(args.target, this.dht_.K_);

    if (stored) {
      debug('Node %s:s \'get\' query found local value for \'%s\'.',
          node.address, node.port, args.target.toString('hex'));
      // todo
    }

    return Object.assign({
      id: this.dht_.id,
      token: this.store_.getWriteToken(args.target, node),
      nodes: nodes
    }, stored || {});
  }


  /**
   * Handle a put query.
   * @param {PutRequest} args The put query args.
   * @param {NodeInfo} node The requesting node.
   * @return {PutResponse} The response.
   * @private
   */
  handlePutQuery_(args, node) {
    const isMutable = args.sig !== undefined;
    const target = isMutable ?
        (sha1(args.salt ? Buffer.concat([args.k, args.salt]) : args.k)) :
        sha1(bencode.encode(args.v));

    // verify that the token owner is the requesting node first, since it is
    // much cheaper to check that before verifying signatures or hashes.
    if (!this.store_.verifyToken(args.token, target, node)) {
      debug('Node %s:%s \'put\' to \'%s\' failed with a bad token.',
          node.address, node.port, target.toString('hex'));
      throw new Error('Bad token');
    }

    // todo validate args.v.length < 1000
    let success = false;
    if (isMutable) {
      // check the signature
      if (!ed25519.verify(args.sig, encodeSigData(args), args.k)) {
        // todo respond with an error
        debug('Node %s:%s bad \'put\' query: signature does not match.',
            node.address, node.port);
        throw new Error('Bad signature');
      }

      const last = this.store_.get(target);
      if (last) {
        // todo verify seq and cas
      }

      success = this.store_.set(target, {
        k: Buffer.from(args.k),
        seq: args.seq || 0,
        sig: args.sig,
        salt: args.salt,
        v: Buffer.from(args.v)
      }, node, args.token);

      if (success) {
        debug('Storing mutable data for key: \'%s%s\'.',
            args.k.toString('hex'), args.salt ? '::' + args.salt.toString() : '');
      }
    } else {
      success = this.store_.set(target, {
        v: Buffer.from(args.v)
      }, node, args.token);

      if (success) {
        debug('Storing immutable value with id: \'%s\'.', target.toString('hex'));
      }
    }

    // node was good, so let's refresh it in the routing table
    if (!success) throw new Error('Could not write, token validation failed.');
    return { id: this.dht_.id };
  }
}


/**
 * @param {DHTStoreRecord} msg The storage record to encode.
 * @param {Buffer=} opt_salt Optional salt value.
 */
function encodeSigData(msg, opt_salt=undefined) {
  /** @type {DHTStoreRecord} */
  var ref = { seq: msg.seq || 0, v: msg.v };
  if (opt_salt || msg.salt) ref.salt = opt_salt || msg.salt;
  return bencode.encode(ref).slice(1, -1);
};


/**
 * @param {Buffer} target The requested target hash.
 * @param {Buffer=} opt_salt If mutable, the optional salt value.
 */
function GetResponseValidator(target, opt_salt=undefined) {
  /**
   * @param {DHTStoreRecord} r
   * @return {any|undefined}
   */
  function checker(r) {
    if (!r || !r.v) return;
    var isMutable = r.k || r.sig
    if (isMutable) {
      if (!r.sig || !r.k) return;
      if (!ed25519.verify(r.sig, encodeSigData(r, opt_salt), r.k)) {
        debug('Received bad signature for \'%s\'.', target.toString('hex'));
        return;
      }
      if (sha1(opt_salt ? Buffer.concat([r.k, opt_salt]) : r.k).equals(target)) {
        return r;
      }
    } else {
      if (sha1(bencode.encode(r.v)).equals(target)) {
        return r;
      }
    }
  }
  return checker;
}

