'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { CodexClient, threadParams } = require('../src/client.cjs');
function peer() {
  const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.kill = () => p.emit('exit', 0); return p;
}
test('JSONL handshake, split Unicode output and out-of-order RPC responses', async () => {
  const p = peer(); const calls = []; const notifications = [];
  p.stdin.on('data', data => {
    const m = JSON.parse(data.toString()); calls.push(m);
    if (m.method === 'initialize') p.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\n');
  });
  const client = new CodexClient({ spawnImpl: () => p, onEvent: (m, v) => notifications.push([m, v]) });
  await client.start({ executable: process.execPath });
  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized']);
  const a = client.request('one'); const b = client.request('two');
  p.stdout.write(JSON.stringify({ id: calls[3].id, result: 'B' }) + '\n');
  p.stdout.write(JSON.stringify({ id: calls[2].id, result: 'A' }) + '\n');
  assert.deepEqual(await Promise.all([a, b]), ['A','B']);
  const bytes = Buffer.from(JSON.stringify({ method: 'delta', params: { text: '思源笔记' } }) + '\n');
  p.stdout.write(bytes.subarray(0, bytes.length - 6)); p.stdout.write(bytes.subarray(bytes.length - 6));
  assert.equal(notifications[0][1].text, '思源笔记'); client.stop();
});
test('server requests are answered, unknown RPC errors reject and pending calls stop cleanly', async () => {
  const p = peer(); const written = [];
  p.stdin.on('data', d => written.push(JSON.parse(d.toString())));
  const client = new CodexClient({ onRequest: msg => client.reply(msg.id, { decision: 'decline' }) });
  client.proc = p;
  client.receive({ id: 0, method: 'approval', params: {} });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(written[0], { id: 0, result: { decision: 'decline' } });
  const bad = client.request('invalid'); client.receive({ id: written[1].id, error: { message: 'unsupported' } });
  await assert.rejects(bad, /unsupported/);
  const pending = client.request('wait'); client.stop(); await assert.rejects(pending, /连接已关闭/);
  assert.equal(client.pending.size, 0);
});
test('timeout clears pending state without accepting a late reply', async () => {
  const client = new CodexClient({ timeout: 10 }); client.proc = peer();
  await assert.rejects(client.request('slow'), /超时/);
  client.receive({ id: 1, result: 'late' }); assert.equal(client.pending.size, 0); client.stop();
});
test('thread instructions are frozen per conversation and permission policy is explicit', () => {
  const session = { prompt: '旧提示词' };
  const params = threadParams(session, { prompt: '新提示词', cwd: 'D:\\work', model: '' });
  assert.equal(params.developerInstructions, '旧提示词');
  assert.equal(params.sandbox, 'read-only'); assert.equal(params.approvalsReviewer, 'user');
  assert.equal('model' in params, false);
  assert.equal(threadParams({ model: 'chosen-model' }, { model: 'different-model' }).model, 'chosen-model');
  assert.equal('model' in threadParams({ model: '' }, { model: 'different-model' }), false);
});
