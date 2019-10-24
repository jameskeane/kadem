const assert = require('assert');
const bep42 = require('../src/security');


describe('BEP42 - DHT Security Extension', () => {
  it('computes the node id from the ip address.', () => {
    const vs = [
      // ip, rand, first two bytes, high bit
      ['124.31.75.21',  1, 0x5f, 0xbf, 0xb0],
      ['21.75.31.124', 86, 0x5a, 0x3c, 0xe0],
      ['65.23.51.170', 22, 0xa5, 0xd4, 0x30],
      ['84.124.73.14', 65, 0x1b, 0x03, 0x20],
      ['43.213.53.83', 90, 0xe5, 0x6f, 0x60]
    ];

    vs.forEach((v) => {
      const e = bep42.computeSecureNodeId(v[0], v[1]);

      // first two bytes should be 0x5f and 0xbf
      // third byte only has it's most significant bit pulled
      assert.deepEqual(e.slice(0, 2), [v[2], v[3]]);
      assert.equal(e[2] & 0xf0, v[4]);
      assert.equal(e[19], v[1]);
    });
  });
});