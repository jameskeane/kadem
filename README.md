
An implementation of the Kademlia DHT.

Supports:
 - BEP-42 with `sse4_crc32` optional dependency.
 - BEP-44 with `ed25519-supercop` optional dependency.

## Usage
```javascript
	import DHT from 'kadem';

	// load DHT from stored state file; if it doesn't
	// exist or is not provided it'll bootstrap itself.
	const dht = DHT.load('.dht_state');
	dht.listen(/** listening port, can be anything */ 8468);

	const value = await dht.get({ k: key, salt: salt });
```
