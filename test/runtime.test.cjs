'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join('C:/fake', 'OpenAI', 'Codex', 'bin');
function resolver(entries) {
  const files = new Map(entries.map(([dir, host, time]) => [path.join(root, dir, 'codex.exe'), { host, time }]));
  const fakeFs = {
    existsSync(p) { return p === root || files.has(p) || (path.basename(p) === 'codex-code-mode-host.exe' && !!files.get(path.join(path.dirname(p), 'codex.exe'))?.host); },
    readdirSync() { return entries.map(e => e[0]); },
    statSync(p) { return { mtimeMs: files.get(p).time }; }
  };
  const context = { module: { exports: {} }, process: { env: { LOCALAPPDATA: 'C:/fake', PATH: '' } }, require: n => n === 'fs' ? fakeFs : require(n) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/client.cjs'), 'utf8'), context);
  return context.module.exports.resolveCodex;
}
test('automatic discovery skips a newer desktop executable missing its code-mode host', () => {
  assert.equal(resolver([['complete', true, 1], ['incomplete', false, 2]])(), path.join(root, 'complete', 'codex.exe'));
});
test('an incomplete desktop install fails with an actionable error', () => {
  assert.throws(() => resolver([['incomplete', false, 2]])(), /codex-code-mode-host/);
});
test('an explicitly selected incomplete desktop install is rejected', () => {
  assert.throws(() => resolver([['incomplete', false, 2]])(path.join(root, 'incomplete', 'codex.exe')), /codex-code-mode-host/);
});
