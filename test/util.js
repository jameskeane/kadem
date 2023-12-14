import DHT from '#root/src/index';



export async function createCluster(n, port_start) {
  const ids = Array.isArray(n) ? n : [];
  n = Array.isArray(n) ? n.length : n;

  const nodes = [];

  // create first node manually since we need a bound socket to bootstrap
  const bootstrap = new DHT({
    bootstrapNodes: [],
    id: ids[0]
  });
  await bootstrap.listen(port_start, '127.0.0.1');

  for (let i = 1; i < n; i++) {
    let node = new DHT({
      bootstrapNodes: [{ address: '127.0.0.1', port: port_start }],
      id: ids[i]
    });
    nodes.push(node);
  }

  await Promise.all(nodes.map((n, i) =>
      n.listen(port_start + i + 1) ));

  nodes.push(bootstrap);
  return nodes;
};

export function destroyCluster(cluster) {
  cluster.forEach((n) => n.dispose());
}
