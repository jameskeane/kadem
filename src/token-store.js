import crypto from 'crypto';
import { LRUCache } from 'lru-cache';



/** @define {number} */
const SECRET_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes


/**
 * Token storage for peer requests.
 * The BitTorrent implementation uses the SHA1 hash of the IP address
 * concatenated onto a secret that changes every five minutes and tokens
 * up to ten minutes old are accepted.
 * @todo Why are we using `any` in the LRU?
 */
export default class TokenStore {
  constructor() {
    /**
     * The secret used to compute the tokens.
     * @type {!Buffer}
     * @private
     */
    this.secret_ = crypto.randomBytes(10);

    /**
     * The interval used to update the secret.
     * @type {NodeJS.Timeout}
     * @private
     */
    this.refreshInterval_ = setInterval(() => {
      this.secret_ = crypto.randomBytes(10);
    }, SECRET_REFRESH_INTERVAL);

    /**
     * The data store.
     * @type {LRUCache<string, any>}
     * @private
     */
    this.store_ = new LRUCache({
      max: 500,
      ttl: 7.2e+6 // 2 hours
    });
  }

  /**
   * Dispose of this object.
   */
  dispose() {
    clearInterval(this.refreshInterval_);
    this.store_.clear();
  }

  /**
   * Lookup the value(s) stored under the target hash.
   * @param {Buffer} target The target hash to lookup.
   * @return {any} The stored value or undefined if not found.
   */
  get(target) {
    return this.store_.get(target.toString('hex'));
  }

  /**
   * Set the value for a hash.
   * @param {!Buffer} target The target hash.
   * @param {any} value The value to store.
   * @param {!Buffer} token The write token to verify.
   * @param {!NodeInfo} node The requesting node.
   * @return {boolean} Whether the value was set, if false it implies the write
   *     token didn't validate.
   */
  set(target, value, node, token) {
    if (!this.verifyToken(token, target, node)) return false;
    this.store_.set(target.toString('hex'), value);
    return true;
  }

  /**
   * Verify the token owner.
   * @param {!Buffer} token The write token to verify.
   * @param {!Buffer} target If provided also verify the target hash.
   * @param {!NodeInfo} node The requesting node.
   * @return {boolean} Whether the token is owner by the node.
   */
  verifyToken(token, target, node) {
    return token.equals(this.getWriteToken(target, node));
  }

  /**
   * Create a new write token, bound to a specific node & target.
   * @param {!Buffer} target The target hash.
   * @param {!NodeInfo} node The requesting node.
   * @return {!Buffer} The write token.
   */
  getWriteToken(target, node) {
    return crypto.createHash('sha1')
        .update(target)
        .update(node.address)
        .digest();
  }

  /**
   * Get the stored keys.
   * @return {!Array.<string>}
   */
  keys() {
    return Array.from(this.store_.keys());
  }

  /**
   * Get the stored size.
   * @return {!number}
   */
  size() {
    return this.store_.size;
  }
}
