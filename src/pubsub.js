import ed25519 from 'ed25519-supercop';
import bencode from 'bencode';
import TokenStore from '#root/src/token-store';
import { sha1 } from '#root/src/util';

import debugLogger from 'debug';
const debug = debugLogger('dht:storage');



/**
 * Publish/Subscribe Extension for the DHT.
 * Implements [BEP-50](http://www.bittorrent.org/beps/bep_0050.html)
 */
export default function DHTPubSub(dht) {
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
