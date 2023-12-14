import crc32c from "sse4_crc32";



/**
 * Calculate the secure node id given the external ip address.
 * See: http://www.bittorrent.org/beps/bep_0042.html
 * @param {!string} ipaddr The ip address to compute the node ip for.
 * @param {=number} opt_rand Optionally specify the random parameter.
 * @return {!Buffer} The secure node id.
 */
export function computeSecureNodeId(ipaddr, opt_rand) {
  const rand = () => parseInt(Math.random() * 255, 10);

  // todo support ipv6
  const id = Buffer.alloc(20);
  const buf = Buffer.alloc(4);
  const ip = Buffer.from(ipaddr.split('.')).readUInt32BE();
  const r = opt_rand === undefined ? rand() : opt_rand;
  buf.writeUInt32BE(((ip & 0x030f3fff) | (r << 29)) >>> 0);
  
  const c = crc32c.calculate(buf, 0);
  id[0] = (c >> 24) & 0xff;
  id[1] = (c >> 16) & 0xff;
  id[2] = ((c >> 8) & 0xf8) | (rand() & 0x7);

  for (var i=3; i<19; i++) {
    id[i] = rand();
  }

  id[19] = r;
  return id;
};

