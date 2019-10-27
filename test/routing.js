const assert = require('assert');
const { RoutingTable } = require('../src/routing');




describe('The routing table', () => {

  it('adds a node with unknown status if bucket is not full', () => {
    let rt = new RoutingTable(ids[0]);
    let ni1 = ni(ids[1], ips[1], 6881), ni2 = ni(ids[2], ips[2], 6881);
    rt.recordResponse(ni2);
    rt.recordQuery(ni1);

    assert.deepEqual(rt.closest(ids[5]), [ni1, ni2]);
    assert.deepEqual(rt.closest(ids[5], 1), [ni1]);
  });

  it('the first split is 0..2^159 & 2^159..2^160', () => {
    let rt = new RoutingTable(ids[0], { K: 1 });
    rt.recordQuery(ni(ids[1], ips[1], 6881));
    rt.recordResponse(ni(ids[2], ips[2], 6881));

    assert.equal(
        rt._root.left.max.toString('hex'),
        '8080808080808080808080808080808080808080');
  });


  describe('the eviction process', () => {
    it('will ping a stale node if it can\'t split a bucket', async () => {
      let rt = new RoutingTable(ids[0], { K: 1 });
      rt.on('ping', (nodeInfo, cb) => cb(true));

      rt.recordQuery(ni(ids[6], ips[1], 6881));
      await rt.recordResponse(ni(ids[3], ips[2], 6881));
      
      // since it pinged, the new node shouldn't be in the routing table
      assert.equal(ids[3] in rt._nodeMap, false);
    });

    it('will evict and replace the node if it doesn\'t respond to ping', async () => {
      let rt = new RoutingTable(ids[0], { K: 1 });
      rt.on('ping', (nodeInfo, cb) => cb(false));

      rt.recordQuery(ni(ids[6], ips[1], 6881));
      await rt.recordResponse(ni(ids[3], ips[2], 6881));

      // since it didn't respond, the new node should be in the routing table
      // and the old one removed
      assert.equal(ids[6] in rt._nodeMap, false);
      assert.equal(ids[3] in rt._nodeMap, true);
    });

    it('will evict without ping known \'bad\' nodes.', async () => {
      // a 'known bad node' is a node that had not responded to multiple queries
      // in a row
      let rt = new RoutingTable(ids[0], { K: 1 });
      let pinged = false; // this should stay false
      rt.on('ping', (nodeInfo, cb) => {
        pinged = true;
        cb(true);
      });

      let badnode = ni(ids[6], ips[1], 6881);
      let newnode = ni(ids[3], ips[2], 6881);

      // insert and then mark no response
      rt.recordResponse(badnode);
      for (let i = 0; i < 10; i++) rt.recordNoResponse(badnode);

      await rt.recordQuery(newnode);
      assert.equal(pinged, false);
      assert.equal(ids[6] in rt._nodeMap, false);
      assert.equal(ids[3] in rt._nodeMap, true);
    });
  });

  describe('The refresh process', () => {

    // When a node in a bucket is pinged and it responds, or a node is added to
    // a bucket, or a node in a bucket is replaced with another node, the
    // bucket's last changed property should be updated
    it('should update the buckets last change when appropriate');
    it('should refresh buckets that have not been changed in the last X minutes', () => {
      let rt = new RoutingTable(ids[0], { K: 1 });
      rt.recordQuery(ni(ids[1], ips[1], 6881));
      rt.recordResponse(ni(ids[2], ips[2], 6881));
      rt.on('refresh', (forId) => {
        console.log('refresh', forId);
      });
      rt.refresh(-1);
    });
  })

  it('can save state');
  it('can load state');

  // it('will not split a bucket that does\'t contain the local id', () => {
  //   let rt = new RoutingTable(ids[0], { K: 1 });

  //   rt.recordQuery(ni(ids[6], ips[1], 6881));
  //   rt.recordResponse(ni(ids[3], ips[2], 6881));
  // });

  // it('discards new nodes, if a can\'t split bucket has all good nodes', () => {
  //   let rt = new RoutingTable(ids[0], { K: 1 });
  //   rt.recordResponse(ni(ids[6], ips[1], 6881));
  //   rt.recordResponse(ni(ids[3], ips[2], 6881));
  // });

});




function ni(id, address, port) {
  return { id: Buffer.from(id, 'hex'), address, port, family: 'ipv4' };
}


let ids = [
  'c5269329f1589e41a26d125ded189303fc8bfacf',
  'e1fd0952d1182960c45111d20660b4eaeba3d613',
  '5f97216455588dfecdb119384e24ed37bd8f41f4',
  '2c04c9ab5f6fa2d4cc06e8d0a4bd8f97face5de2',
  '5299740830f29c1fb6e3dc9874f87ef4af5a6a99',
  '973dcf7fb9ec1d1d3e5e6aca8ecd1f95b49e5832',
  '3ce4b6f0b1316c135c8a7f62c6af87ea65a78a2a',
  '2176740b415807b9a8aa6603912e2abd68146764',
  'ade9c51af1df1cad7b2dec95c71e041052d91744',
  '50abc552ef1a918b0ca8bd269bc71b01c1127a82',
  'eb03610e8b8f28f41c38e987fd0edf4e58693736',
  '7bce4391ad469e203773181fa145e386fd5a4a7c',
  '475d6a15a0d784767f201f2edb62d9b93892a93e',
  '0005f2f4981265ece3254e941d4a7d9e4d28a62c',
  '641d07dcbab886f55e057d0e7f13365622ae6590',
  '45f6c87b57592dddc16efd56bce9e5edbd06d794',
  'cd3f0b6a83e15b0d42830e6ce3711412f5cb394e',
  'f62c9e4634e84f38760e1424bc77fcbe41fb5e2a',
  'a0862256e261d02cc4e5a105f64a4d7b3735b41e',
  '1c011ca816747364852fecdfc5ec4397f0f19a1d'
];


let ips = [
  '237.1.95.245', '67.137.244.73', '184.83.107.223', '10.216.93.235',
  '89.220.188.229', '127.53.141.63', '220.203.154.108', '202.204.171.224',
  '54.207.20.63', '218.130.199.101', '65.3.217.54', '191.79.109.116',
  '121.107.224.215', '130.49.113.228', '235.171.8.108', '141.229.231.243',
  '22.102.96.172', '44.156.214.108', '18.31.130.113', '16.209.0.246'
];


