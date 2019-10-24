const crypto = require('crypto'),
      LRU = require('lru-cache');


module.exports = TokenStore;

/** @define {number} */
const SECRET_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes



/**
 * @constructor
 */
function TokenStore() {
  // The BitTorrent implementation uses the SHA1 hash of the IP address
  // concatenated onto a secret that changes every five minutes and tokens
  // up to ten minutes old are accepted.
  
  /**
   * The secret used to compute the tokens.
   * @type {!Buffer}
   * @private
   */
  this.secret_ = crypto.randomBytes(10);

  /**
   * The interval used to update the secret.
   * @type {number}
   * @private
   */
  this.refreshInterval_ = setInterval(() => {
    this.secret_ = crypto.randomBytes(10);
  }, SECRET_REFRESH_INTERVAL);

  /**
   * The data store.
   */
  this.store_ = new LRU({
    max: 500,
    maxAge: 7.2e+6 // 2 hours
  });
};


/**
 * Dispose of this object.
 */
TokenStore.prototype.dispose = function() {
  clearInterval(this.refreshInterval_);
};


/**
 * Lookup the value(s) stored under the target hash.
 * @param {Buffer|string} target The target hash to lookup.
 * @return {any} The stored value or undefined if not found.
 */
TokenStore.prototype.get = function(target) {
  if (typeof target !== 'string') target = target.toString('hex');
  return this.store_.get(target);
};


/**
 * Set the value for a hash.
 * @param {Buffer} target The target hash.
 * @param {any} value The value to store.
 * @param {Buffer|string} token The write token to verify.
 * @param {NodeInfo} node The requesting node.
 * @return {boolean} Whether the value was set, if false it implies the write
 *     token didn't validate.
 */
TokenStore.prototype.set = function(target, value, node, token) {
  if (!this.verifyToken(token, target, node)) return false;

  if (typeof target !== 'string') target = target.toString('hex');
  this.store_.set(target, value);
  return true;
};


/**
 * Verify the token owner.
 * @param {!(Buffer|string)} token The write token to verify.
 * @param {!Buffer} target If provided also verify the target hash.
 * @param {!NodeInfo} node The requesting node.
 * @return {boolean} Whether the token is owner by the node.
 */
TokenStore.prototype.verifyToken = function(token, target, node) {
  return token.equals(this.getWriteToken(target, node));
};


/**
 * Create a new write token, bound to a specific node & target.
 * @param {Buffer|string} target The target hash.
 * @param {NodeInfo} node The requesting node.
 * @return {Buffer} The write token.
 */
TokenStore.prototype.getWriteToken = function(target, node) {
  return crypto.createHash('sha1')
      .update(target)
      .update(node.address)
      .digest();
};


/**
 * Get the stored keys.
 * @return {!Array.<string>}
 */
TokenStore.prototype.keys = function() {
  return this.store_.keys();
};
