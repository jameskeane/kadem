const assert = require('assert');
const { createCluster, destroyCluster } = require('./util');
const { sha1 } = require('../src/util');
const { distance } = require('../src/routing');


describe('The DHT tracker methods', () => {
  let cluster = null;

  beforeEach(async function() {
    // creates a cluster of 20 nodes, with known id's
    cluster = await createCluster([
      'd55e8d244e4a79c1f21f8ec5be0045e7cf1dcf53',
      '57fa45881e36e02a4da23af835cea6c9e2077684',
      'a1a7db87e50912cb64b89125e87904738a40f845',
      'a973aad6459be581ff826ec3b56a0cc6fc28ba90',
      'd6ba12bde68e49f83cece12aa0bdd8dc3af9a201',
      '893478c3d9fd89452794ae3c1348be888de93fb9',
      '9ab083509967317441ce68716aba1d853b294e7f',
      '7dface71336ccaeaa51d5d9a7347f9a6fa970c3a',
      '17d0c7a326f9cf50bb0b5f91039e89cf144fca68',
      'f4098400667cc625e13d8e720ffa9ff41fbf78cb',
      '12465cb10b66c24d3e7c5ebed36b181c17e13c8e',
      '69fb58413edd22f1a7e1990db17bfd4ac9c388a8',
      '7df9c4c85109ff208673de42178d5dc770593035',
      '9cababe0597ed4b0733fd1be871704bd3d3cbe12',
      'cb2da6a9d0d1ff731636ddedf560a7fd31b8177b',
      'bb4b41ceb6f2c857a10e4030fbfcb7693a9ef026',
      'ded6b7816635de889c42df4147ffc3e81d4b1f11',
      'ac8843e29d68b243feb12834df4b323340995285',
      '6cf2ad60aaaa2e52a2be571a5b58555faba914c8',
      '8499c13b27d67f4dab1e16c76a808a6e861a6768'
    ], 30000);
  });

  afterEach(() => {
    // todo should wait for all requests to complete...
    // i.e. with 'get' the code returns immediately when it finds a value
    destroyCluster(cluster);
  });


  describe("'get_peers'", () => {
    it('Returns peers that have announced', async () => {
      // sanity
      let target = sha1('no-peers-target');
      let peers = await cluster[5].get_peers(target);
      assert.equal(peers.length, 0);

      // have two peers announce, with specific ports (to test)
      target = sha1('announced');
      await Promise.all([
        cluster[2].announce_peer(target, 1234),
        cluster[14].announce_peer(target, 5678)
      ]);

      // The peers should now be stored in the 8 closest nodes
      // (which we know since we've fixed the node ids)
      const getStoredKeys = (n) => n.announcedPeers_.store_.keys();
      const expected = [
        1, 0, 0, 0, 1, 0, 1, 1, 0, 1,
        1, 1, 0, 0, 0, 0, 0, 1, 0, 0
      ];
      cluster.forEach((n, i) => {
        assert.equal(getStoredKeys(n).length, expected[i]);
      });

      peers = await cluster[15].get_peers(target);
      assert(peers.length, 2);
      assert.deepEqual(new Set(peers.map((p) => p.port)),
                       new Set([1234, 5678]));
    });

    it('Will respond with closer nodes if no peer has announced.');
  });

  describe("'announce_peer'", () => {
    it('Will announce itself to the closest nodes to the target hash.', async () => {
      const target = sha1('announce-closest');
      const target2 = sha1('announce-closest-2');
      let [p1, p2] = await Promise.all([
        cluster[5].get_peers(target),
        cluster[3].get_peers(target2)
      ]);
      assert.equal(p1.length, 0);
      assert.equal(p2.length, 0);

      // have two peers announce, with specific ports (to test)
      await Promise.all([
        cluster[2].announce_peer(target, 33334),
        cluster[5].announce_peer(target, 22222),
        cluster[7].announce_peer(target2, 44444),
        cluster[18].announce_peer(target2, 55555)
      ]);

      // The peers should now be stored in the 8 closest nodes
      // (which we know since we've fixed the node ids)
      const getStoredKeys = (n) => n.announcedPeers_.store_.keys();
      // const target1_closest = [14,  1,  2, 16,  5, 12, 18,  4];
      // const target2_closest = [13, 19,  3, 15,  8, 18,  4,  5];
      const expected = [
        0, 1, 1, 1, 2, 2, 0, 0, 1, 0,
        0, 0, 1, 1, 1, 1, 1, 0, 2, 1
      ];

      cluster.forEach((n, i) => {
        assert.equal(getStoredKeys(n).length, expected[i], `cluster node ${i}`);
      });

      [p1, p2] = await Promise.all([
        cluster[4].get_peers(target),
        cluster[1].get_peers(target2)
      ]);
      assert.equal(p1.length, 2);
      assert.equal(p2.length, 2);
      assert.deepEqual(new Set(p1.map((p) => p.port)),
                       new Set([33334, 22222]));
    });
    it('Will not duplicate peer information.');
    it('Will use the originating port if `implied_port` is set.');
  });
})