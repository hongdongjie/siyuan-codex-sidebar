'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness({ fail = false, authenticated = true } = {}) {
  const calls = []; const timers = new Map(); let sequence = 0;
  class Client {
    constructor(callbacks) { this.callbacks = callbacks; }
    async start() { calls.push('start'); if (fail) throw new Error('offline'); }
    async request(method) {
      calls.push(method);
      if (method === 'account/read') return { account: authenticated ? { type: 'chatgpt' } : null };
      return { data: [{ name: 'siyuan', tools: { search: {} } }] };
    }
    stop() { calls.push('stop'); }
  }
  class Plugin {
    async loadData() { return { settings: {}, sessions: [{ id: 'saved', threadId: 'old-thread', messages: [] }], activeId: 'saved' }; }
    async saveData() {}
    addIcons() {}
    addDock() {}
  }
  const context = {
    module: { exports: {} },
    document: { createElement: tag => ({ tagName: tag, children: [], style: {}, scrollHeight: 100,
      classList: { add() {} }, setAttribute() {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      append(...nodes) { this.children.push(...nodes); }, focus() { this.focused = true; }
    }) },
    require: name => name === 'siyuan' ? { Plugin } : name === './client.cjs' ? { CodexClient: Client, threadParams: require('../src/client.cjs').threadParams } : require(name),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/index.cjs'), 'utf8'), context);
  const plugin = new context.module.exports();
  return { plugin, calls, timers, async tick() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id); timer.callback(); await settle(); return timer.delay;
  } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('startup connects without mounting the dock or sending a turn, preserving saved chat', async () => {
  const h = harness(); await h.plugin.onload(); await settle();
  assert.equal(h.plugin.connected, true);
  assert.deepEqual(h.calls, ['start', 'account/read', 'mcpServerStatus/list']);
  assert.equal(h.plugin.session().threadId, 'old-thread');
  assert.equal(h.timers.size, 0); h.plugin.onunload();
});

test('unexpected exit reconnects once and clears stale live thread state', async () => {
  const h = harness(); await h.plugin.onload(); await settle();
  h.plugin.loadedThreads.add('old-thread'); h.plugin.busy = true;
  h.plugin.client.callbacks.onExit(); h.plugin.scheduleReconnect();
  assert.equal(h.timers.size, 1); assert.equal(h.plugin.busy, false);
  assert.equal(h.plugin.loadedThreads.size, 0);
  assert.equal(await h.tick(), 5000);
  assert.equal(h.plugin.connected, true);
  assert.equal(h.calls.filter(x => x === 'start').length, 2);
  assert.equal(h.calls.includes('turn/start'), false); h.plugin.onunload();
});

test('startup failure backs off and stops after five retries', async () => {
  const h = harness({ fail: true }); await h.plugin.onload(); await settle();
  const delays = [];
  while (h.timers.size) delays.push(await h.tick());
  assert.deepEqual(delays, [5000, 15000, 30000, 60000, 60000]);
  assert.equal(h.calls.length, 6); assert.match(h.plugin.statusText, /发送消息时会重新连接/);
  h.plugin.onunload();
});

test('unload cancels retries and ignores late exit callbacks', async () => {
  const h = harness({ fail: true }); await h.plugin.onload(); await settle();
  assert.equal(h.timers.size, 1); h.plugin.onunload();
  h.plugin.client.callbacks.onExit(); await h.plugin.autoConnect();
  assert.equal(h.timers.size, 0); assert.deepEqual(h.calls, ['start', 'stop']);
});

test('missing login asks for login without opening browser or repeatedly reconnecting', async () => {
  const h = harness({ authenticated: false }); await h.plugin.onload(); await settle();
  assert.equal(h.plugin.authenticated, false); assert.equal(h.timers.size, 0);
  assert.match(h.plugin.statusText, /登录/);
  assert.deepEqual(h.calls, ['start', 'account/read']); h.plugin.onunload();
});

test('concurrent manual connection shares startup connection', async () => {
  const h = harness(); await h.plugin.onload();
  await Promise.all([h.plugin.connect(), h.plugin.connect()]);
  assert.equal(h.calls.filter(x => x === 'start').length, 1); h.plugin.onunload();
});

test('editing restores the unsent draft on cancel and rejects earlier messages', async () => {
  const h = harness(); await h.plugin.onload(); await settle();
  const p = h.plugin; p.input = { value: 'draft', focus() {} }; p.editNotice = {};
  p.session().messages = [{ role: 'user', text: 'first' }, { role: 'user', text: 'latest' }];
  p.beginEdit(0); assert.equal(p.editing, undefined);
  p.beginEdit(1); assert.equal(p.input.value, 'draft'); assert.equal(p.editing.text, 'latest');
  p.editing.text = 'replacement'; p.cancelEdit(); assert.equal(p.input.value, 'draft');
  assert.equal(p.session().messages[1].text, 'latest'); p.onunload();
});

test('edit textarea replaces the original message in place, leaving composer draft untouched', async () => {
  const h = harness(); await h.plugin.onload(); await settle(); const p = h.plugin;
  p.input = { value: 'unsent draft' };
  p.session().messages = [{ role: 'user', text: 'original' }];
  p.messagesNode = { children: [], scrollHeight: 100, scrollTop: 0, clientHeight: 300,
    replaceChildren() { this.children = []; }, append(n) { this.children.push(n); } };
  p.beginEdit(0);
  assert.equal(p.messagesNode.children.length, 1);
  assert.equal(p.messagesNode.children[0].children[0], p.inlineInput);
  assert.equal(p.inlineInput.value, 'original'); assert.equal(p.inlineInput.focused, true);
  p.inlineInput.value = 'edited'; p.inlineInput.listeners.input();
  assert.equal(p.editing.text, 'edited'); assert.equal(p.input.value, 'unsent draft');
  p.inlineCancel.listeners.click();
  assert.equal(p.inlineInput, null); assert.equal(p.editing, null);
  assert.equal(p.session().messages[0].text, 'original');
  assert.equal(p.input.value, 'unsent draft'); p.onunload();
});

test('edited resend forks before the replaced turn and excludes its answer', async () => {
  const h = harness(); await h.plugin.onload(); await settle();
  const p = h.plugin; const s = p.session(); const requests = [];
  s.messages = [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'keep' },
    { role: 'user', text: 'old', turnId: 't2' }, { role: 'assistant', text: 'discard' }];
  p.input = { value: 'draft', focus() {} }; p.editNotice = {};
  p.beginEdit(2); p.editing.text = 'new';
  p.client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread: { turns: [{ id: 't1' }, { id: 't2', status: 'completed' }] } };
    if (method === 'thread/fork') return { thread: { id: 'branch' } };
    if (method === 'turn/start') return { turn: { id: 't3' } };
    throw new Error(method);
  };
  await p.send(true);
  assert.equal(requests[1].params.lastTurnId, 't1');
  assert.equal(requests[2].params.threadId, 'branch');
  assert.equal(requests[2].params.input[0].text, 'new');
  assert.deepEqual(Array.from(s.messages, m => m.text), ['first', 'keep', 'new']);
  assert.equal(s.messages[2].turnId, 't3'); assert.equal(p.input.value, 'draft'); p.onunload();
});

test('first-message edit starts fresh; legacy messages match server text', async () => {
  const h = harness(); await h.plugin.onload(); await settle(); const p = h.plugin;
  const s = p.session(); s.messages = [{ role: 'user', text: 'old' }];
  const requests = [];
  p.client.request = async (method, params) => {
    requests.push(method);
    if (method === 'thread/read') return { thread: { turns: [{ id: 't1', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'old' }] }
    ] }] } };
    return { thread: { id: 'fresh' } };
  };
  assert.equal(await p.prepareEditedThread(s, 0, {}), 'fresh');
  assert.deepEqual(requests, ['thread/read', 'thread/start']); p.onunload();
});

test('failed fork preserves original messages and edited text for retry', async () => {
  const h = harness(); await h.plugin.onload(); await settle(); const p = h.plugin; const s = p.session();
  s.messages = [{ role: 'user', text: 'old', turnId: 't2' }, { role: 'assistant', text: 'answer' }];
  p.input = { value: '', focus() {} }; p.editNotice = {}; p.beginEdit(0); p.editing.text = 'replacement';
  p.client.request = async method => {
    if (method === 'thread/read') return { thread: { turns: [{ id: 't1' }, { id: 't2' }] } };
    throw new Error('fork unavailable');
  };
  await p.send(true);
  assert.equal(s.threadId, 'old-thread'); assert.equal(s.messages.length, 2);
  assert.equal(p.input.value, ''); assert.equal(p.editing.text, 'replacement'); assert.equal(p.busy, false); p.onunload();
});
