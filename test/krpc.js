import assert from 'assert';

import { EventEmitter } from 'events';
import sinon from 'sinon';
import bencode from 'bencode';

import { KRPCSocket } from '#root/src/krpc';

describe('KRPC Protocol', () => {
  let socketMock = null;
  let krpc = null;

  beforeEach(() => {
    socketMock = new EventEmitter();
    socketMock.send = sinon.stub();
    krpc = new KRPCSocket(socketMock, { timeout: 1 });
  });

  afterEach(() => {
    socketMock.removeAllListeners();
    krpc.removeAllListeners();
  });

  function respond(r) {
    // read off the latest tid
    const [buf, offset, len, port, address] = socketMock.send.args[0];
    const { t, q } = bencode.decode(buf);

    socketMock.emit('message', bencode.encode({
      t: t,
      y: 'r',
      q: q.toString(),
      r: r
    }), { address, port });
  }

  it('Properly constructs a krpc query', () => {
    const args = { p: 1, n: { p: 5 } };
    krpc.query({ address: '3.3.3.3', port: 12345 }, 'test', args);

    const [buf, offset, len, port, addr] = socketMock.send.args[0];
    const sentMsg = bencode.decode(buf);

    assert.equal(sentMsg.y.toString(), 'q');
    assert.equal(sentMsg.q.toString(), 'test');
    assert.deepEqual(sentMsg.a, args);
  });

  it('Resolves the query promise when it receives a response', () => {
    const p = krpc.query({ address: '3.3.3.3', port: 12345 }, 'test')
        .then((res) => {
          assert.deepEqual(res.r, { ok: 1 });
        });

    respond({
      ok: 1
    });

    return p;
  });

  it('Emits a \'query\' event when receiving queries from peers', (done) => {
    const test_args = { id: 123, a: 1, b: 2, c: { d: 50 }};
    const test_node = {address: '1.1.1.1', port: 4567, family: "ipv4" };

    krpc.on('query', (method, args, node) => {
      assert.equal(method, 'test_method');
      assert.deepEqual(args, test_args);
      assert.deepEqual(node, {
        id: 123, token: undefined,
        address: '1.1.1.1', port: 4567, family: "ipv4"
      });
      done();
    });

    socketMock.emit('message', bencode.encode({
      t: 'g6',
      y: 'q',
      q: 'test_method',
      a: test_args
    }), test_node);
  });

  it('Times out if a response is not received.', () => {
    return krpc.query({ address: '3.3.3.3', port: 12345 }, 'test')
        .then((res) => {
          assert.throws(() => {
            throw res.error;
          }, /Timeout exceeded/);
        });
  });

  it('Accepts an array of nodes to query');
  it('Calls functions passed as query args to get a value');
  it('Decodes peer information');
  it('Decodes received nodes');
  it('Handles error responses');
  it('Gracefully handles garbage in');
  it('Responds to queries');
});
