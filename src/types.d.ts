interface PeerInfo {
  address: string,
  port: number,
  family: 'ipv4'|'ipv6'
}

interface AddressInfo {
  address: string,
  port: number,
  family: 'ipv4'|'ipv6'
}


interface NodeInfo extends PeerInfo {
  id: Buffer,
  token?: Buffer
}


declare module 'ed25519-supercop' {
  /**
   * Return a boolean ok, true if the 64-byte buffer or hex string signature
   * signs a buffer or string message with the 32-byte or hex string publicKey.
   */
  function verify(signature: Buffer, message: Buffer, publicKey: Buffer): boolean;

  /**
   * Generate a 64-byte signature.
   */
  function sign(message: Buffer, publicKey: Buffer, secretKey: Buffer): Buffer;
}

