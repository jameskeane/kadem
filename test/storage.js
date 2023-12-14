import assert from 'assert';
import crypto from 'crypto';
import ed25519 from 'ed25519-supercop';
import { createCluster, destroyCluster } from '#root/test/util';

import bencode from 'bencode';


const ED_SEED = Buffer.from(
    'ae460d331b6707d14af2b11315b490178a649c7bb39e075009b5e7d304d9ecf8', 'hex');


describe('BEP44 - DHT Storage Extension', () => {
  let cluster = null;

  beforeEach(async function() {
    // creates a cluster of 20 nodes, with known id's
    cluster = await createCluster([
      '279aa3f7227021f238723ecb743f7c78781d742d',
      '02e078d7718e8189921d7b1e3cdcfc17a55ef006',
      '050f8d48b6d125a07cc1e9852b496c53b2bdedfb',
      '7ec11fa3b8ef123bdf712843a0d9565f4659c2e2',
      '359f0f411441521f91593365d5c4012d29a52201',
      '3ebcb9442ca0499d7552c60cd1444bd26be5e7d5',
      '3f8f32984fcf5fb4f0d5380e3d4c1a50691da25d',
      '36ec12d5bfece5180a7348ca0e6aa8715e8bfc4e',
      '3d8194a4e5b9d31db71f93a1914bafd848fc9b9d',
      '180a6fd29b9612c2af7d631f9dbc72dac964f0b9',
      'af57374a9f2c3024e916f62d6dc2b52436460b05',
      '7e0105bc9d63094b7471e789fa36165e6390cb2f',
      '656b667714c98fb0570ceffec1f0d492197071e5',
      '2ca723d8e522b2df5366a9742c2ff9fe33241c78',
      '9768fa6f9a76d7844b16b38d4a8b8c0292afa798',
      '0a6290e43caf5c41918c3938caac087177fb40f5',
      'eee782719e8f6710f2a0e1ebe038bec75694cf25',
      '58187355b6fc57c8d167d20d9dce06b3cb6a9da6',
      '0f02498b891023f4f68814d2ee861bdaf7c44fe6',
      '50487e979b7406d35d45f0c377f808f02f3afcda'
    ], 40000);
  });

  afterEach(() => {
    // todo should wait for all requests to complete...
    // i.e. with 'get' the code returns immediately when it finds a value
    destroyCluster(cluster);
  });

  it('Returns undefined if no value can be found.', async () => {
    const res = await cluster[0].get(sha1('test'));
    assert.equal(res, undefined);
  });

  it('Can store immutable values', async function() {
    this.timeout(10000);

    const data = 'test-immutable';
    const target = sha1(bencode.encode(data));

    await cluster[0].put(data);

    // The data should now be stored in the 8 closest nodes
    // (which we know since we've fixed the node ids)
    const getStoredSize = (n) => n.extensions_[0].store_.size();
    const expected = [
      0, 1, 1, 0, 0, 0, 0, 0, 0, 0,
      1, 1, 0, 0, 1, 0, 1, 1, 1, 0
    ];
    cluster.forEach((n, i) => {
      assert.equal(getStoredSize(n), expected[i]);
    });

    // make sure we ask a node that doesn't have it stored locally
    const res = await cluster[5].get(target);
    assert.equal(res.v.toString(), data);
  });

  it('Can store mutable data', async () => {
    const keys = ed25519.createKeyPair(ED_SEED);

    // sanity
    let mutval = await cluster[2].get({ k: keys.publicKey });
    assert.equal(mutval, undefined);

    await cluster[4].put(keys.publicKey, (sign, r) => sign({
      v: 'test-mutable'
    }, keys.secretKey));

    mutval = await cluster[15].get({ k: keys.publicKey });
    assert.equal(mutval.v.toString(), 'test-mutable');
  });

  it('Can store mutable data with a salt', async () => {
    const keys = ed25519.createKeyPair(ED_SEED);

    // sanity
    let mutval = await cluster[1].get({ k: keys.publicKey, salt: 'salt-test' });
    assert.equal(mutval, undefined);

    await cluster[4].put(keys.publicKey, 'salt-test', (sign, r) => sign({
      v: 'test-mutable-w-salt',
      seq: 0
    }, keys.secretKey));

    mutval = await cluster[16].get({ k: keys.publicKey, salt: 'salt-test' });
    assert.equal(mutval.v.toString(), 'test-mutable-w-salt');

    // test seq
    await cluster[16].put(keys.publicKey, 'salt-test', (sign, r) => sign({
      v: '2/test-mutable-w-salt',
      seq: 1
    }, keys.secretKey));

    mutval = await cluster[5].get({ k: keys.publicKey, salt: 'salt-test' });
    assert.equal(mutval.v.toString(), '2/test-mutable-w-salt');
  });

  it('Will reject mutable data that isn\'t signed properly');
  it('Will reject mutable data that is has a lower sequence number.');
  it('Supports Compare and Swap semantics.');
  it('Will refuse to store data if the token is missing or incorrect.');
  it('Will refuse to store data if it knows about closer nodes.');
});

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest();
};

// console.log(cluster.map((c) => c.extensions_[0].store_.keys()));
