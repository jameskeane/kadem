// import { EventEmitter } from 'events';


interface PeerInfo {
  address: string,
  port: number,
  family?: 'ipv4'|'ipv6'
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

type EventEmitter = import('events').EventEmitter;

type KRPCQueryArgument = { [key: string]: any|((p: PeerInfo, m: string, a: KRPCQueryArgument )=>any)};

interface IKRPC extends EventEmitter {
  query(peer:PeerInfo|PeerInfo[], method: string, opt_args: KRPCQueryArgument): Promise<any>;
}

interface IRoutingTable {

}

type ClosestCallback<T> = (r: any, n: NodeInfo) => T;

interface IDHT {
  id: Buffer,
  K_: number,    // Default number of closest nodes to query
  rpc_: IKRPC,
  nodes_: IRoutingTable,

  closest_<T>(target: Buffer, method: string, args: any, opt_rescb:ClosestCallback<T>): Promise<NonNullable<T> | undefined>;

  closestNodes(id: Buffer, n?:number): Array<NodeInfo>;
}

interface IDHTExtension {
  provides: string[];
  dispose(): void;
}

interface IDHTExtensionConstructor {
  new(dht: IDHT): IDHTExtension;
}


interface ITraversableQueryBase {
  node?: NodeInfo;
  r: { nodes: NodeInfo[] };
}
