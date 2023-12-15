![Kadem](https://i.imgur.com/5yfwRZM.png)
[![CI](https://github.com/jameskeane/kadem/actions/workflows/ci.yml/badge.svg)](https://github.com/jameskeane/kadem/actions/workflows/ci.yml)

An implementation of the BitTorrent DHT (Kademlia).

Supports:
 - BEP-42 with `sse4_crc32` optional dependency.
 - BEP-44 with `ed25519-supercop` optional dependency.

## Usage
`npm install kadem`

```javascript
import DHT from 'kadem';

// load DHT from stored state file; if it doesn't
// exist or is not provided it'll bootstrap itself.
const dht = DHT.load('.dht_state');
dht.listen(/** listening port, can be anything */ 8468);

// create a public/secret key pair to use BEP-44
const keys = ed25519.createKeyPair();

// store mutable value
await dht.put(keys.publicKey, (sign, r) => sign({ v: 'example-mutable'}, keys.secretKey));

// retrieve mutable value
const value = await dht.get({ k: keys.publicKey });
assert value.v == 'example-mutable';
```
