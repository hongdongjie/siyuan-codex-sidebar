'use strict';
const nativeRequire = typeof window !== 'undefined' && window.require ? window.require : require;
const { spawn } = nativeRequire('child_process');
const { createInterface } = nativeRequire('readline');
const fs = nativeRequire('fs');
const path = nativeRequire('path');
const os = nativeRequire('os');

function resolveCodex(explicit = '') {
  if (explicit.trim()) {
    const target = explicit.trim().replace(/^"|"$/g, '');
    if (!path.isAbsolute(target) || !fs.existsSync(target) || !/\.exe$/i.test(target))
      throw new Error('请填写有效的 codex.exe 完整路径。');
    return target;
  }
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(root)) {
    const candidates = fs.readdirSync(root).map(d => path.join(root, d, 'codex.exe')).filter(p => fs.existsSync(p));
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const target = path.join(dir, 'codex.exe');
    if (fs.existsSync(target)) return target;
  }
  throw new Error('未找到 codex.exe。请在设置里指定完整路径。');
}

class CodexClient {
  constructor({ onEvent = () => {}, onRequest = () => {}, onExit = () => {}, spawnImpl = spawn, timeout = 60000 } = {}) {
    Object.assign(this, { onEvent, onRequest, onExit, spawnImpl, timeout });
    this.pending = new Map(); this.seq = 0; this.proc = null; this.starting = null;
  }
  async start(settings = {}) {
    if (this.starting) return this.starting;
    if (this.proc) return;
    this.starting = this._start(settings);
    try { await this.starting; } finally { this.starting = null; }
  }
  async _start(settings) {
    const exe = resolveCodex(settings.executable);
    const home = settings.codexHome?.trim() || path.join(os.homedir(), '.codex');
    const cwd = settings.cwd || os.homedir();
    const proc = this.spawnImpl(exe, ['app-server', '--listen', 'stdio://'], {
      cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: home }
    });
    this.proc = proc;
    const lines = createInterface({ input: proc.stdout });
    this.lines = lines;
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      this.receive(msg);
    });
    // Drain stderr, but never surface raw authentication/configuration logs.
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', e => this.fail(e));
    proc.on('error', e => this.fail(e));
    proc.on('exit', code => {
      if (this.proc !== proc) return;
      this.proc = null; lines.close(); this.fail(new Error(`Codex 已退出（${code ?? '已停止'}），请重新连接。`));
      this.onExit();
    });
    try {
      await this.request('initialize', { clientInfo: { name: 'siyuan_codex_sidebar', title: 'SiYuan Codex Sidebar', version: '0.1.0' } });
      this.notify('initialized', {});
    } catch (e) { this.stop(); throw e; }
  }
  receive(msg) {
    if (msg.method && msg.id !== undefined) {
      Promise.resolve().then(() => this.onRequest(msg)).catch(() => this.replyError(msg.id, '请求处理失败'));
    } else if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'Codex 请求失败'));
      else pending.resolve(msg.result);
    } else if (msg.method) this.onEvent(msg.method, msg.params || {});
  }
  write(msg) {
    if (!this.proc || this.proc.stdin.destroyed) throw new Error('Codex 尚未连接。');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} 等待超时，请重连后重试。`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method, params) { this.write({ method, params }); }
  reply(id, result) { this.write({ id, result }); }
  replyError(id, message) { if (this.proc) this.write({ id, error: { code: -32601, message } }); }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  stop() {
    const proc = this.proc; this.proc = null;
    this.lines?.close(); this.fail(new Error('连接已关闭。'));
    if (proc) { proc.stdin.end(); proc.kill(); }
  }
}

function threadParams(session, settings) {
  const model = session.model ?? settings.model;
  return {
    cwd: settings.cwd,
    approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
    developerInstructions: session.prompt || '',
    ...(model?.trim() ? { model: model.trim() } : {})
  };
}
module.exports = { CodexClient, resolveCodex, threadParams };
