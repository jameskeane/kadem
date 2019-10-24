const ed25519 = require('ed25519-supercop'),
      bencode = require('bencode'),
      KBucket = require('k-bucket'),
      debug = require('debug')('dht:storage'),
      TokenStore = require('./token-store'),
      { sha1 } = require('./util');


module.exports = DHTPubSub;



/**
 * Publish/Subscribe Extension for the DHT.
 * Implements [BEP-50](http://www.bittorrent.org/beps/bep_0050.html)
 */
function DHTPubSub(dht) {
  this.provides = ['publish', 'subscribe'];

  /**
   */
  this.dht_ = dht;

  // /**
  //  */
  // this.rpc_ = dht.rpc_;
  // this.rpc_.on('query', this.handleQuery_.bind(this));
};


/**
 * Returns an EventEmitter that will fire on events.
 */
DHTPubSub.prototype.subscribe = function(infohash) {

};
