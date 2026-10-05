'use strict';
const { Plugin } = require('siyuan');
const { CodexClient, threadParams } = require('./client.cjs');
const nativeRequire = typeof window !== 'undefined' && window.require ? window.require : require;
const os = nativeRequire('os');

const STORE = 'sidebar.json';
const DEFAULTS = { prompt: '', executable: '', codexHome: '', model: '', effort: '' };
const EFFORT_LABELS = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高', ultra: '超高' };
const ICON = '<symbol id="iconCodexSidebar" viewBox="0 0 24 24"><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>';
// Lucide icons; see LICENSE-lucide.txt. Keep the original geometry across the toolbar.
const UI_ICONS = {
  chevron: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<polygon points="12 3 14.78 8.63 21 9.54 16.5 13.93 17.56 20.13 12 17.2 6.44 20.13 7.5 13.93 3 9.54 9.22 8.63 12 3"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  minus: '<path d="M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>'
};
function icon(name) {
  return `<svg class="cs-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${UI_ICONS[name]}</svg>`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag); if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; return node;
}
function button(text, label, fn, cls = '') {
  const b = el('button', `cs-button ${cls}`, text); b.type = 'button';
  b.title = label; b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b;
}
function iconButton(name, label, fn, cls = '') {
  const b = button('', label, fn, `cs-icon-button ${cls}`); b.innerHTML = icon(name); return b;
}
function renderMarkdown(target, text) {
  target.replaceChildren();
  // Use the host's Markdown renderer, then a strict allowlist before inserting DOM.
  const lute = window.Lute?.New?.();
  if (!lute) { target.textContent = text; target.classList.add('cs-plain'); return; }
  const doc = new DOMParser().parseFromString(lute.Md2HTML(text), 'text/html');
  const allowed = new Set('P BR STRONG EM DEL CODE PRE BLOCKQUOTE UL OL LI H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TR TH TD HR A'.split(' '));
  function copy(node, parent) {
    if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== 1 || ['SCRIPT','STYLE','IFRAME','OBJECT','SVG','IMG'].includes(node.tagName)) return;
    const next = allowed.has(node.tagName) ? document.createElement(node.tagName.toLowerCase()) : parent;
    if (next !== parent) {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^(https?:\/\/|siyuan:\/\/blocks\/)/i.test(href)) {
          next.setAttribute('href', href); next.setAttribute('rel', 'noopener noreferrer');
          next.addEventListener('click', e => {
            e.preventDefault();
            nativeRequire('electron').shell.openExternal(href);
          });
        }
      }
      parent.append(next);
    }
    for (const child of node.childNodes) copy(child, next);
  }
  for (const node of doc.body.childNodes) copy(node, target);
}

module.exports = class CodexSidebar extends Plugin {
  async onload() {
    this.state = { settings: { ...DEFAULTS }, sessions: [], activeId: null };
    this.writeQueue = Promise.resolve(); this.connected = false; this.busy = false;
    this.unloading = false; this.reconnectAttempts = 0; this.reconnectTimer = null;
    this.loadedThreads = new Set(); this.approvals = new Map(); this.statusText = '连接后可直接让 Codex 查找和阅读思源笔记。';
    const saved = await this.loadData(STORE);
    if (saved && typeof saved === 'object') {
      this.state.settings = { ...DEFAULTS, ...saved.settings };
      this.state.sessions = Array.isArray(saved.sessions) ? saved.sessions : [];
      for (const session of this.state.sessions) if (session.model === undefined) session.model = this.state.settings.model;
      this.state.activeId = saved.activeId;
    }
    if (!this.session()) this.createSession();
    this.client = new CodexClient({
      onEvent: (method, params) => this.event(method, params),
      onRequest: msg => this.serverRequest(msg),
      onExit: () => {
        if (this.unloading) return;
        this.connected = false; this.busy = false; this.loadedThreads.clear(); this.approvals.clear();
        this.authenticated = false; this.turnId = null;
        this.status('Codex 连接已断开，正在等待自动重连。', true); this.renderApprovals(); this.controls(); this.persist();
        this.scheduleReconnect();
      }
    });
    this.addIcons(ICON);
    this.addDock({ type: 'codex_chat', config: { position: 'RightBottom', size: { width: 380, height: 0 }, icon: 'iconCodexSidebar', title: 'Codex' },
      init: dock => this.mount(dock.element), destroy: () => { this.historyEvents?.abort(); this.root = null; }
    });
    this.autoConnect();
  }
  onDataChanged() {} // Saving plugin state must not reload the running chat.
  onunload() { this.unloading = true; clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.historyEvents?.abort(); this.settingsDialog?.remove(); this.client?.stop(); this.root = null; }
  async autoConnect() {
    if (this.unloading) return;
    try { await this.connect(); }
    catch (e) {
      if (this.unloading) return;
      this.status(`连接失败：${e.message}`, true);
      this.scheduleReconnect();
    }
  }
  scheduleReconnect() {
    if (this.unloading || this.reconnectTimer || this.connected) return;
    const delays = [5000, 15000, 30000, 60000, 60000];
    if (this.reconnectAttempts >= delays.length) {
      this.status('自动连接暂未成功，请检查连接设置，发送消息时会重新连接。', true); return;
    }
    const delay = delays[this.reconnectAttempts++];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null; this.autoConnect();
    }, delay);
  }
  session() { return this.state.sessions.find(s => s.id === this.state.activeId); }
  createSession() {
    const s = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: '新对话', prompt: this.state.settings.prompt, model: this.state.settings.model, effort: this.state.settings.effort, messages: [], threadId: null };
    this.state.sessions.push(s); this.state.activeId = s.id; return s;
  }
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => this.saveData(STORE, snapshot));
    this.writeQueue.catch(() => this.status('聊天或设置保存失败，请检查思源存储空间。', true));
    return this.writeQueue;
  }
  status(text, error = false) {
    this.statusText = text; this.statusError = error;
    if (this.statusNode) { this.statusNode.textContent = text; this.statusNode.classList.toggle('cs-error', error); }
  }
  mount(host) {
    this.historyEvents?.abort(); this.historyEvents = new AbortController();
    host.replaceChildren(); this.root = el('section', 'cs-root'); host.append(this.root);
    const header = el('header', 'cs-header'); header.append(el('strong', '', 'Codex'));
    const spacer = el('span', 'cs-spacer'); header.append(spacer);
    this.newButton = iconButton('plus', '新建对话，使用当前前置提示词', () => {
      if (this.busy) return; this.session().draft = this.input.value; this.createSession(); this.input.value = ''; this.persist(); this.renderSessions(); this.renderMessages(); this.controls(); this.input.focus();
    });
    this.historyButton = iconButton('history', '历史记录', () => this.toggleHistory());
    this.historyButton.setAttribute('aria-expanded', 'false');
    this.favoritesButton = iconButton('star', '收藏', () => this.toggleHistory('favorites'));
    this.favoritesButton.setAttribute('aria-expanded', 'false');
    this.historyMode = 'history';
    header.append(this.newButton, this.historyButton, this.favoritesButton, iconButton('settings', '设置前置提示词与 Codex 连接', () => this.toggleSettings()));
    const min = iconButton('minus', '收起侧栏', () => {}, 'block__icon block__icon--show'); min.setAttribute('data-type', 'min');
    header.append(min);
    this.root.append(header);
    this.historyPanel = el('section', 'cs-history'); this.historyPanel.hidden = true;
    this.historyPanel.id = `cs-history-${Math.random().toString(36).slice(2)}`;
    this.historyPanel.setAttribute('aria-label', '历史记录');
    this.historyButton.setAttribute('aria-controls', this.historyPanel.id);
    this.favoritesButton.setAttribute('aria-controls', this.historyPanel.id);
    this.historyHeading = el('h3', 'cs-history-heading', '历史记录');
    this.historyPanel.append(this.historyHeading);
    this.sessionsNode = el('div', 'cs-history-list'); this.historyPanel.append(this.sessionsNode);
    this.root.append(this.historyPanel);
    document.addEventListener('pointerdown', e => {
      if (!this.historyPanel.contains(e.target) && !this.historyButton.contains(e.target) && !this.favoritesButton.contains(e.target)) this.closeHistory();
    }, { signal: this.historyEvents.signal });
    document.addEventListener('focusin', e => {
      if (!this.historyPanel.contains(e.target) && !this.historyButton.contains(e.target) && !this.favoritesButton.contains(e.target)) this.closeHistory();
    }, { signal: this.historyEvents.signal });
    this.root.addEventListener('keydown', e => {
      if (this.historyPanel.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeHistory(); (this.historyMode === 'favorites' ? this.favoritesButton : this.historyButton).focus(); }
      if (this.historyPanel.contains(e.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        const items = [...this.sessionsNode.querySelectorAll('.cs-history-item')];
        const current = items.indexOf(document.activeElement.closest('.cs-history-row')?.querySelector('.cs-history-item'));
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    this.messagesNode = el('div', 'cs-messages'); this.messagesNode.setAttribute('role', 'log'); this.messagesNode.setAttribute('aria-label', '对话内容');
    this.root.append(this.messagesNode);
    this.approvalsNode = el('div', 'cs-approvals'); this.root.append(this.approvalsNode);
    this.statusNode = el('div', 'cs-status'); this.statusNode.setAttribute('role', 'status'); this.root.append(this.statusNode);
    const composer = el('div', 'cs-composer'); this.input = el('textarea', 'cs-input'); this.input.rows = 3;
    this.input.setAttribute('aria-label', '消息');
    this.input.value = this.session()?.draft || '';
    this.input.addEventListener('input', () => this.controls());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.busy) this.send(); }
    });
    composer.append(this.input);
    const choices = el('div', 'cs-model-controls');
    this.modelTrigger = button('', '选择模型与思考强度', () => this.toggleModelPanel(), 'cs-model-trigger');
    this.modelTrigger.setAttribute('aria-haspopup', 'dialog'); this.modelTrigger.setAttribute('aria-expanded', 'false');
    this.contextControl = el('div', 'cs-context-control');
    this.contextButton = button('', '上下文窗口用量', () => this.showContextUsage(true), 'cs-context-button');
    this.contextButton.removeAttribute('title');
    this.contextButton.innerHTML = '<svg class="cs-context-ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle class="cs-context-track" cx="10" cy="10" r="7"/><circle class="cs-context-progress" cx="10" cy="10" r="7" pathLength="100"/></svg>';
    this.contextProgress = this.contextButton.querySelector('.cs-context-progress');
    this.contextTooltip = el('div', 'cs-context-tooltip'); this.contextTooltip.hidden = true;
    this.contextTooltip.id = `cs-context-${Math.random().toString(36).slice(2)}`;
    this.contextTooltip.setAttribute('role', 'tooltip'); this.contextButton.setAttribute('aria-describedby', this.contextTooltip.id);
    this.contextTitle = el('div', 'cs-context-title', '背景信息窗口：');
    this.contextPercent = el('div'); this.contextTokens = el('div');
    this.contextTooltip.append(this.contextTitle, this.contextPercent, this.contextTokens);
    this.contextControl.append(this.contextButton, this.contextTooltip);
    this.contextControl.addEventListener('mouseenter', () => this.showContextUsage(true));
    this.contextControl.addEventListener('mouseleave', () => { if (document.activeElement !== this.contextButton) this.showContextUsage(false); });
    this.contextButton.addEventListener('focus', () => this.showContextUsage(true));
    this.contextButton.addEventListener('blur', () => this.showContextUsage(false));
    this.modelName = el('span', 'cs-model-name'); this.effortName = el('span', 'cs-effort-name');
    const arrow = el('span', 'cs-model-chevron'); arrow.innerHTML = icon('chevron');
    this.modelTrigger.append(this.modelName, this.effortName, arrow);
    this.modelPanel = el('section', 'cs-model-panel'); this.modelPanel.hidden = true;
    this.modelPanel.id = `cs-model-panel-${Math.random().toString(36).slice(2)}`;
    this.modelPanel.setAttribute('role', 'dialog'); this.modelPanel.setAttribute('aria-label', '模型与思考强度');
    this.modelTrigger.setAttribute('aria-controls', this.modelPanel.id);
    this.modelSelect = el('select', 'cs-model-select'); this.modelSelect.setAttribute('aria-label', '选择模型');
    this.effortSelect = el('select', 'cs-effort-select'); this.effortSelect.setAttribute('aria-label', '思考强度');
    this.effortSelect.hidden = true;
    this.modelSelect.addEventListener('change', () => this.changeSelection(true));
    this.effortSelect.addEventListener('change', () => this.changeSelection(false));
    const panelHeader = el('div', 'cs-model-panel-header');
    this.effortHeading = el('span', 'cs-effort-heading');
    panelHeader.append(this.effortHeading);
    this.effortSlider = el('input', 'cs-effort-slider'); this.effortSlider.type = 'range'; this.effortSlider.min = '0'; this.effortSlider.step = '1';
    this.effortSlider.setAttribute('aria-label', '思考强度');
    this.effortSlider.addEventListener('input', () => {
      this.effortSelect.value = this.effortOptions?.[Number(this.effortSlider.value)]?.reasoningEffort || '';
      this.changeSelection(false);
    });
    const sliderTrack = el('div', 'cs-effort-track');
    this.effortDots = el('div', 'cs-effort-dots'); this.effortDots.setAttribute('aria-hidden', 'true');
    sliderTrack.append(this.effortSlider, this.effortDots);
    this.modelPanel.append(panelHeader, this.modelSelect, sliderTrack, this.effortSelect);
    choices.append(this.contextControl, this.modelTrigger, this.modelPanel);
    this.modelHint = el('div', 'cs-model-hint'); this.modelHint.setAttribute('role', 'status'); this.modelHint.hidden = true;
    window.addEventListener('focus', () => this.refreshModels(), { signal: this.historyEvents.signal });
    document.addEventListener('pointerdown', e => { if (!choices.contains(e.target)) this.closeModelPanel(); }, { signal: this.historyEvents.signal });
    document.addEventListener('focusin', e => { if (!choices.contains(e.target)) this.closeModelPanel(); }, { signal: this.historyEvents.signal });
    document.addEventListener('pointerdown', e => { if (!this.contextControl.contains(e.target)) this.showContextUsage(false); }, { signal: this.historyEvents.signal });
    choices.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.contextTooltip.hidden) { e.preventDefault(); e.stopPropagation(); this.showContextUsage(false); return; }
      if (e.key === 'Escape' && !this.modelPanel.hidden) { e.preventDefault(); e.stopPropagation(); this.closeModelPanel(); this.modelTrigger.focus(); }
      if (e.key === 'ArrowDown' && e.target === this.modelTrigger) { e.preventDefault(); if (this.modelPanel.hidden) this.toggleModelPanel(); }
    });
    const actions = el('div', 'cs-actions');
    this.sendButton = button('发送', '发送消息（Enter）；Shift+Enter 换行', () => this.send(), 'cs-primary');
    this.stopButton = button('停止', '停止生成', () => this.interrupt());
    actions.append(choices, el('span', 'cs-spacer'), this.stopButton, this.sendButton);
    composer.append(actions, this.modelHint); this.root.append(composer);
    this.renderSessions(); this.renderMessages(); this.renderApprovals(); this.status(this.statusText, this.statusError); this.controls();
    this.refreshModels();
  }
  renderSessions() {
    if (!this.sessionsNode) return;
    this.sessionsNode.replaceChildren();
    const favorites = this.historyMode === 'favorites';
    const heading = favorites ? '收藏' : '历史记录';
    this.historyHeading.textContent = heading;
    this.historyPanel.setAttribute('aria-label', heading);
    const conversations = this.state.sessions.filter(s => (!favorites || s.favorite) && s.messages?.some(m => m.role === 'user' && m.text?.trim()));
    if (!conversations.length) this.sessionsNode.append(el('div', 'cs-history-heading', favorites ? '暂无收藏，点击历史记录中的星星即可收藏。' : '暂无历史对话'));
    for (const s of [...conversations].reverse()) {
      const item = button('', s.title, () => {
        if (this.busy || this.editing) return;
        this.session().draft = this.input.value; this.state.activeId = s.id;
        this.input.value = s.draft || ''; this.closeHistory(); this.persist();
        this.renderSessions(); this.renderMessages(); this.controls(); this.input.focus();
      }, 'cs-history-item');
      item.append(el('span', 'cs-history-title', s.title));
      if (s.id === this.state.activeId) {
        item.setAttribute('aria-current', 'true');
        const mark = el('span', 'cs-history-check'); mark.innerHTML = icon('check'); item.append(mark);
      }
      const row = el('div', 'cs-history-row');
      const star = iconButton('star', `${s.favorite ? '取消收藏' : '收藏'}：${s.title}`, () => {
        const rows = [...this.sessionsNode.children];
        const rowIndex = rows.indexOf(row);
        const scrollTop = this.sessionsNode.scrollTop;
        s.favorite = !s.favorite; this.persist(); this.renderSessions();
        const nextRows = [...this.sessionsNode.querySelectorAll('.cs-history-row')];
        const targetRow = nextRows.find(node => node.dataset.sessionId === s.id) || nextRows[Math.min(rowIndex, nextRows.length - 1)];
        (targetRow?.querySelector('.cs-favorite-button') || this.favoritesButton).focus({ preventScroll: true });
        this.sessionsNode.scrollTop = scrollTop;
      }, 'cs-favorite-button');
      star.setAttribute('aria-pressed', String(!!s.favorite));
      row.dataset.sessionId = s.id; row.append(item, star); this.sessionsNode.append(row);
    }
  }
  closeHistory() {
    if (this.historyPanel) this.historyPanel.hidden = true;
    this.historyButton?.setAttribute('aria-expanded', 'false');
    this.favoritesButton?.setAttribute('aria-expanded', 'false');
  }
  closeModelPanel() {
    if (this.modelPanel) this.modelPanel.hidden = true;
    this.modelTrigger?.setAttribute('aria-expanded', 'false');
  }
  showContextUsage(visible) {
    if (!this.contextTooltip) return;
    if (visible) { this.closeModelPanel(); this.renderContextUsage(); }
    this.contextTooltip.hidden = !visible;
  }
  contextUsage(session = this.session()) {
    const usage = session?.tokenUsage;
    const used = usage?.last?.totalTokens;
    const capacity = usage?.modelContextWindow;
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(capacity) || capacity <= 0) return null;
    const percent = Math.min(100, Math.max(0, Math.round(used / capacity * 100)));
    return { used, capacity, percent, remaining: 100 - percent };
  }
  renderContextUsage() {
    if (!this.contextButton) return;
    const usage = this.contextUsage();
    const compact = value => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
    this.contextProgress.setAttribute('stroke-dasharray', `${usage?.percent || 0} 100`);
    this.contextPercent.textContent = usage ? `${usage.percent}% 已用（剩余 ${usage.remaining}%）` : '暂无上下文用量';
    this.contextTokens.textContent = usage ? `已用 ${compact(usage.used)} 标记，共 ${compact(usage.capacity)}` : '等待 Codex 返回数据';
    this.contextButton.setAttribute('aria-label', usage ? `上下文窗口：${usage.percent}% 已用，剩余 ${usage.remaining}%，已用 ${usage.used} 标记，共 ${usage.capacity}` : '上下文窗口用量：暂无数据');
  }
  toggleModelPanel() {
    if (this.busy) return;
    if (!this.modelPanel.hidden) { this.closeModelPanel(); return; }
    this.closeHistory(); this.showContextUsage(false); this.renderModels(); this.modelPanel.hidden = false;
    this.modelTrigger.setAttribute('aria-expanded', 'true');
    this.refreshModels();
    this.effortSlider.disabled ? this.modelSelect.focus() : this.effortSlider.focus();
  }
  toggleHistory(mode = 'history') {
    if (this.busy || this.editing) return;
    if (!this.historyPanel.hidden && this.historyMode === mode) { this.closeHistory(); return; }
    this.closeHistory(); this.closeModelPanel(); this.showContextUsage(false); this.historyMode = mode;
    this.renderSessions(); this.historyPanel.hidden = false;
    (mode === 'favorites' ? this.favoritesButton : this.historyButton).setAttribute('aria-expanded', 'true');
    (this.sessionsNode.querySelector('[aria-current]') || this.sessionsNode.querySelector('button'))?.focus();
  }
  renderMessages() {
    if (!this.messagesNode) return;
    const node = this.messagesNode;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    const oldScroll = node.scrollTop; node.replaceChildren();
    const messages = this.session()?.messages || [];
    this.editButtons = [];
    this.inlineInput = null; this.inlineSend = null; this.inlineCancel = null;
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    for (const [index, message] of messages.entries()) {
      const item = el('article', `cs-message cs-${message.role}`);
      if (this.editing?.sessionId === this.session().id && this.editing.index === index) {
        item.classList.add('cs-editing');
        const input = this.inlineInput = el('textarea', 'cs-inline-input');
        input.setAttribute('aria-label', '编辑最近一条消息'); input.rows = 3; input.value = this.editing.text;
        const resize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(320, Math.max(90, input.scrollHeight))}px`; };
        input.addEventListener('input', () => { this.editing.text = input.value; resize(); this.controls(); });
        input.addEventListener('keydown', e => {
          if (e.isComposing) return;
          if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(true); }
        });
        const actions = el('div', 'cs-inline-actions');
        this.inlineCancel = button('取消', '取消编辑', () => this.cancelEdit());
        this.inlineSend = button('发送', '发送编辑后的消息', () => this.send(true), 'cs-primary');
        actions.append(this.inlineCancel, this.inlineSend);
        item.append(input, actions); node.append(item); resize(); continue;
      }
      item.append(el('div', 'cs-role', message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '工具'));
      const body = el('div', 'cs-body');
      if (message.role === 'assistant') renderMarkdown(body, message.text);
      else { body.textContent = message.text; body.classList.add('cs-plain'); }
      item.append(body);
      if (message.role === 'user' && index === lastUser) {
        const actions = el('div', 'cs-message-actions');
        const edit = button('', '编辑消息', () => this.beginEdit(index), 'cs-edit-button');
        edit.innerHTML = icon('edit');
        edit.disabled = this.busy; this.editButtons.push(edit); actions.append(edit); item.append(actions);
      }
      node.append(item);
    }
    if (atBottom) node.scrollTop = node.scrollHeight; else node.scrollTop = oldScroll;
  }
  beginEdit(index) {
    if (this.busy) return;
    const session = this.session();
    if (index !== session.messages.findLastIndex(m => m.role === 'user')) return;
    if (!this.editing) this.editing = { sessionId: session.id, index, text: session.messages[index].text };
    this.renderMessages(); this.controls(); this.inlineInput?.focus();
  }
  cancelEdit() {
    if (!this.editing || this.busy) return;
    this.editing = null;
    this.renderMessages(); this.controls();
  }
  async prepareEditedThread(session, index, params) {
    if (!session.threadId) return (await this.client.request('thread/start', params)).thread.id;
    const result = await this.client.request('thread/read', { threadId: session.threadId, includeTurns: true });
    const turns = result.thread.turns || [];
    const message = session.messages[index];
    const last = turns[turns.length - 1];
    const matches = last && (message.turnId ? last.id === message.turnId : last.items?.some(item =>
      item.type === 'userMessage' && item.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') === message.text));
    if (!matches || last.status === 'inProgress') throw new Error('无法确认最近一轮对话，请检查连接后再编辑');
    const prior = turns[turns.length - 2];
    const fork = prior
      ? await this.client.request('thread/fork', { ...params, threadId: session.threadId, lastTurnId: prior.id })
      : await this.client.request('thread/start', params);
    return fork.thread.id;
  }
  controls() {
    if (!this.root) return;
    this.renderModels();
    this.modelSelect.disabled = this.busy;
    this.modelTrigger.disabled = this.busy;
    this.renderContextUsage();
    if (this.busy) this.closeModelPanel();
    this.effortSelect.disabled = this.busy || !this.effortAvailable;

    for (const edit of this.editButtons || []) edit.disabled = this.busy;
    this.sendButton.textContent = '发送';
    if (this.inlineInput) this.inlineInput.disabled = this.busy;
    if (this.inlineCancel) this.inlineCancel.disabled = this.busy;
    if (this.inlineSend) this.inlineSend.disabled = this.busy || !this.editing?.text.trim();
    this.input.readOnly = !!this.editing;
    this.newButton.disabled = this.busy || !!this.editing; this.historyButton.disabled = this.busy || !!this.editing;
    this.favoritesButton.disabled = this.busy || !!this.editing;
    if (this.busy || this.editing) this.closeHistory();
    this.sendButton.disabled = this.busy || !!this.editing || !this.input.value.trim();
    this.stopButton.hidden = !this.busy; this.stopButton.disabled = this.stopping;
    this.settingsSave && (this.settingsSave.disabled = this.busy);
  }
  toggleSettings() {
    if (this.settingsDialog?.open) this.settingsDialog.close(); else this.openSetting();
  }
  openSetting() {
    if (!this.settingsDialog) {
      const dialog = this.settingsDialog = el('dialog', 'cs-settings-dialog');
      dialog.setAttribute('aria-label', 'Codex 设置');
      const header = el('header', 'cs-dialog-header');
      header.append(el('h2', '', 'Codex 设置'));
      const close = iconButton('close', '关闭设置', () => dialog.close());
      header.append(close);
      this.settingsNode = el('section', 'cs-settings');
      dialog.append(header, this.settingsNode); document.body.append(dialog);
      let backdropPress = false;
      const outside = event => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      };
      dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
      dialog.addEventListener('click', event => { if (backdropPress && outside(event)) dialog.close(); backdropPress = false; });
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const items = [...dialog.querySelectorAll('button, input, textarea, select, summary, [tabindex]')]
          .filter(node => !node.disabled && node.tabIndex >= 0 && node.checkVisibility());
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      this.renderSettings();
    }
    if (this.settingsDialog.open) return;
    this.settingsDialog.showModal(); this.promptInput.focus();
    this.settingsSave.disabled = this.busy; this.refreshModels();
  }
  renderModels(value = this.session()?.model ?? this.state.settings.model) {
    if (!this.modelSelect) return;
    this.modelSelect.replaceChildren();
    const add = (id, text) => { const option = el('option', '', text); option.value = id; this.modelSelect.append(option); };
    if (!value) { add('', '请选择模型'); this.modelSelect.lastElementChild.disabled = true; }
    for (const model of this.codexModels || []) add(model.model, model.displayName || model.model);
    if (value && !(this.codexModels || []).some(m => m.model === value)) add(value, `${value}（已保存，未在列表中）`);
    this.modelSelect.value = value;
    this.modelSelect.title = this.modelSelect.selectedOptions[0]?.textContent || '选择模型';
    this.renderEfforts();
  }
  renderEfforts() {
    if (!this.effortSelect) return;
    const session = this.session();
    const model = this.codexModels?.find(m => m.model === session.model);
    const options = model?.supportedReasoningEfforts || [];
    this.effortAvailable = options.length > 0;
    this.effortSelect.replaceChildren();
    const add = (value, label) => { const option = el('option', '', label); option.value = value; this.effortSelect.append(option); };
    const defaultEffort = model?.defaultReasoningEffort;
    add('', defaultEffort ? `默认 · ${EFFORT_LABELS[defaultEffort] || defaultEffort}` : '默认强度');
    for (const option of options) add(option.reasoningEffort, EFFORT_LABELS[option.reasoningEffort] || option.reasoningEffort);
    if (session.effort && !options.some(o => o.reasoningEffort === session.effort)) add(session.effort, `${EFFORT_LABELS[session.effort] || session.effort}（待验证）`);
    this.effortSelect.value = session.effort || '';
    this.effortSelect.title = '思考强度：' + this.effortSelect.selectedOptions[0]?.textContent;
    this.effortSelect.disabled = this.busy || !this.effortAvailable;
    if (this.modelTrigger) {
      const effort = session.effort || defaultEffort;
      const label = EFFORT_LABELS[effort] || effort || '默认';
      const name = (model?.displayName || session.model || '选择模型').replace(/^(GPT-\d+(?:\.\d+)?)-/, '$1 ');
      this.modelName.textContent = name; this.effortName.textContent = label;
      this.modelTrigger.title = `${name} · ${label}`;
      this.effortHeading.textContent = label;
      this.effortOptions = options;
      const index = options.findIndex(o => o.reasoningEffort === effort);
      this.effortSlider.max = String(Math.max(0, options.length - 1));
      this.effortSlider.value = String(Math.max(0, index));
      this.effortSlider.disabled = this.busy || options.length < 2;
      this.effortSlider.setAttribute('aria-valuetext', label);
      this.effortSlider.style.setProperty('--cs-effort-fill', `${options.length > 1 ? Math.max(0, index) / (options.length - 1) * 100 : 0}%`);
      this.effortDots.replaceChildren(...options.map(() => el('span')));
    }
  }
  async changeSelection(modelChanged) {
    if (this.busy) return;
    const session = this.session();
    if (modelChanged && session.model !== this.modelSelect.value) delete session.tokenUsage;
    session.model = this.modelSelect.value;
    session.effort = modelChanged ? '' : this.effortSelect.value;
    this.state.settings.model = session.model; this.state.settings.effort = session.effort;
    this.controls();
    try { await this.persist(); } catch { /* persist reports save errors */ }
  }
  async turnSelection(session) {
    const id = session.model;
    const model = this.codexModels?.find(m => m.model === id);
    if (!id) throw new Error('请先在输入框下方选择模型');
    const supported = model?.supportedReasoningEfforts || [];
    let effort = session.effort || model?.defaultReasoningEffort;
    if (effort && supported.length && !supported.some(o => o.reasoningEffort === effort)) {
      if (session.effort) throw new Error('该模型不支持所选思考强度，请重新选择');
      effort = model.defaultReasoningEffort;
    }
    return { model: id, ...(effort ? { effort } : {}) };
  }
  async refreshModels() {
    if (this.modelsLoading || this.busy) return;
    this.modelsLoading = true;
    try {
      await this.client.start({ ...this.state.settings, cwd: os.homedir() });
        const models = []; const cursors = new Set(); let cursor;
      do {
        const result = await this.client.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const model of result.data || []) if (!model.hidden && !models.some(m => m.model === model.model)) models.push(model);
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('模型列表分页异常，请重试。');
        cursors.add(cursor);
      } while (cursor);
      this.codexModels = models; this.renderModels();
      if (this.modelHint) { this.modelHint.textContent = models.length ? '' : '暂未返回模型，请登录后重新打开模型面板。'; this.modelHint.hidden = !!models.length; }
    } catch (e) { if (this.modelHint) { this.modelHint.textContent = `读取失败：${e.message} 请重新打开模型面板重试。`; this.modelHint.hidden = false; } }
    finally { this.modelsLoading = false; this.controls(); }
  }
  renderSettings() {
    const panel = this.settingsNode; panel.replaceChildren();
    const field = (title, hint, value, multiline = false) => {
      const label = el('label', 'cs-field'); label.append(el('span', 'cs-label', title));
      const input = el(multiline ? 'textarea' : 'input', 'cs-field-input'); input.value = value || '';
      if (multiline) input.rows = 6;
      label.append(input, el('span', 'cs-muted', hint)); panel.append(label); return input;
    };
    const settings = this.state.settings;
    this.promptInput = field('前置提示词', '保存后对新对话生效；已有对话保留原提示词。', settings.prompt, true);
    const details = el('details', 'cs-advanced'); details.append(el('summary', '', '连接设置'));
    const fields = [];
    for (const [key, title, hint] of [
      ['executable', 'Codex 可执行文件', '留空自动检测 codex.exe。'],
      ['codexHome', 'Codex 配置目录', '留空使用用户目录下的 .codex，复用登录与 MCP。']
    ]) {
      const input = field(title, hint, settings[key]); details.append(input.parentElement); fields.push([key, input]);
    }
    panel.append(details);
    this.settingsSave = button('保存设置', '保存前置提示词与连接设置', async () => {
      if (this.busy) return;
      const old = this.state.settings;
      const next = { ...old, prompt: this.promptInput.value };
      for (const [key, input] of fields) next[key] = input.value.trim();
      this.state.settings = next;
      try {
        await this.persist();
        if (next.executable !== old.executable || next.codexHome !== old.codexHome) {
          this.client.stop(); this.connected = false; this.authenticated = false; this.loadedThreads.clear();
          this.codexModels = []; this.renderModels(); this.refreshModels();
          this.reconnectAttempts = 0; this.autoConnect();
        }
        this.status('设置已保存。新建对话后使用前置提示词。'); this.controls();
        this.settingsFeedback.textContent = '设置已保存。新建对话后生效。';
        this.settingsFeedback.classList.remove('cs-error');
      } catch {
        this.state.settings = old;
        this.settingsFeedback.textContent = '设置保存失败，请检查思源存储空间后重试。';
        this.settingsFeedback.classList.add('cs-error');
      }
    }, 'cs-primary');
    this.settingsFeedback = el('div', 'cs-muted'); this.settingsFeedback.setAttribute('role', 'status');
    const footer = el('footer', 'cs-settings-footer'); footer.append(this.settingsFeedback, this.settingsSave);
    panel.append(footer);
  }
  async connect() {
    if (this.unloading) return;
    if (this.connecting) return this.connecting;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    this.connecting = this._connect(); this.controls();
    try { const result = await this.connecting; this.reconnectAttempts = 0; return result; }
    finally { this.connecting = null; this.controls(); }
  }
  async _connect() {
    this.status('正在连接本机 Codex…');
    await this.client.start({ ...this.state.settings, cwd: os.homedir() });
    const account = await this.client.request('account/read', {});
    this.authenticated = !!account.account || account.requiresOpenaiAuth === false; this.connected = true;
    if (!this.authenticated) { this.status('Codex 尚未登录，请在本地 Codex 完成登录后重新发送。'); return; }
    this.status('Codex 已连接，正在检查思源 MCP…');
    try {
      const result = await this.client.request('mcpServerStatus/list', {});
      const siyuan = result.data?.find(s => /siyuan/i.test(s.name));
      this.status(siyuan && Object.keys(siyuan.tools || {}).length ? '已连接 · 思源 MCP 可用' : 'Codex 已连接；尚未发现可用的思源 MCP，请检查 Codex 配置。', !siyuan);
    } catch { this.status('Codex 已连接；MCP 状态暂时不可用。'); }
  }
  async send(edited = false) {
    if (!!this.editing !== edited) return;
    const text = (edited ? this.editing.text : this.input.value).trim(); if (!text || this.busy) return;
    this.busy = true; this.stopping = false; this.turnId = null; this.controls();
    const session = this.session(); this.runningSession = session;
    try {
      if (!this.connected || !this.authenticated) await this.connect();
      if (!this.authenticated) throw new Error('请先在本地 Codex 完成登录，再发送消息。');
      if (this.stopping) return;
      const selection = await this.turnSelection(session);
      const params = threadParams({ ...session, model: selection.model }, { ...this.state.settings, cwd: os.homedir() });
      if (this.editing?.sessionId === session.id) {
        const index = this.editing.index;
        const threadId = await this.prepareEditedThread(session, index, params);
        if (this.stopping) return;
        session.threadId = threadId; delete session.tokenUsage; this.renderContextUsage(); this.loadedThreads.add(threadId);
        session.messages = session.messages.slice(0, index);
        if (!session.messages.some(m => m.role === 'user')) session.title = text.slice(0, 32);
        this.editing = null;
      }
      if (!session.threadId) {
        const result = await this.client.request('thread/start', params);
        session.threadId = result.thread.id; this.loadedThreads.add(session.threadId);
      } else if (!this.loadedThreads.has(session.threadId)) {
        await this.client.request('thread/resume', { ...params, threadId: session.threadId });
        this.loadedThreads.add(session.threadId);
      }
      if (this.stopping) return;
      const userMessage = { role: 'user', text };
      session.messages.push(userMessage); session.draft = edited ? this.input.value : '';
      if (session.title === '新对话') session.title = text.slice(0, 32);
      if (!edited) this.input.value = '';
      this.renderSessions(); this.renderMessages(); await this.persist();
      this.status('Codex 正在思考…');
      const result = await this.client.request('turn/start', { threadId: session.threadId, ...selection, input: [{ type: 'text', text, text_elements: [] }] });
      userMessage.turnId = result.turn.id; this.persist();
      if (this.busy) this.turnId = result.turn.id;
      if (this.stopping && this.turnId) await this.client.request('turn/interrupt', { threadId: session.threadId, turnId: this.turnId });
    } catch (e) { this.busy = false; this.status(e.message + '（可重试，或新建对话。）', true); }
    finally { if (this.stopping && !this.turnId) this.busy = false; this.controls(); }
  }
  async interrupt() {
    if (!this.busy) return; this.stopping = true; this.controls();
    try {
      this.status('正在停止…');
      if (this.turnId) await this.client.request('turn/interrupt', { threadId: this.runningSession.threadId, turnId: this.turnId });
    } catch (e) { this.stopping = false; this.status(e.message, true); this.controls(); }
  }
  event(method, p) {
    if (this.unloading) return;
    if (method === 'thread/tokenUsage/updated') {
      const session = this.state.sessions.find(s => s.threadId === p.threadId);
      if (!session) return;
      session.tokenUsage = p.tokenUsage;
      if (session === this.session()) this.renderContextUsage();
      this.persist(); return;
    }
    if (method === 'account/login/completed') {
      if (p.success) this.connect().catch(e => this.status(e.message, true));
      else this.status(p.error || '登录未完成，请重试。', true);
      this.controls(); return;
    }
    const s = this.runningSession;
    if (!s || p.threadId !== s.threadId) return;
    if (method === 'turn/started') this.turnId = p.turn.id;
    if (method === 'item/agentMessage/delta') {
      let item = s.messages.find(m => m.itemId === p.itemId);
      if (!item) { item = { role: 'assistant', text: '', itemId: p.itemId }; s.messages.push(item); }
      item.text += p.delta; this.renderMessages();
    }
    if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      let item = s.messages.find(m => m.itemId === p.item.id);
      if (!item) { item = { role: 'assistant', text: '', itemId: p.item.id }; s.messages.push(item); }
      item.text = p.item.text; this.renderMessages(); this.persist();
    }
    if (method === 'item/started' && p.item?.type === 'mcpToolCall') this.status(`正在调用 ${p.item.server} · ${p.item.tool}…`);
    if (method === 'item/completed' && p.item?.type === 'mcpToolCall') {
      s.messages.push({ role: 'tool', text: `${p.item.server} · ${p.item.tool}${p.item.error ? '：调用失败' : '：完成'}` }); this.renderMessages();
    }
    if (method === 'error') this.status(p.error?.message || 'Codex 执行出错。', true);
    if (method === 'turn/completed') {
      this.busy = false; this.stopping = false; this.turnId = null; this.approvals.clear();
      const turn = p.turn || {};
      this.status(turn.status === 'failed' ? (turn.error?.message || '本轮执行失败，可重试。') : turn.status === 'interrupted' ? '已停止' : '已完成', turn.status === 'failed');
      this.renderApprovals(); this.controls(); this.persist();
    }
  }
  serverRequest(msg) {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(msg.method)) {
      this.approvals.set(msg.id, msg); this.renderApprovals(); this.status('Codex 需要你的回复。');
    } else if (msg.method === 'item/permissions/requestApproval') {
      this.client.reply(msg.id, { permissions: {}, scope: 'turn' });
      this.status('本轮未授予额外权限。');
    } else this.client.replyError(msg.id, '此侧栏暂不支持该交互，请通过普通消息继续。');
  }
  renderApprovals() {
    if (!this.approvalsNode) return; this.approvalsNode.replaceChildren();
    for (const [id, msg] of this.approvals) {
      const panel = el('section', 'cs-approval');
      const respond = result => { this.client.reply(id, result); this.approvals.delete(id); this.renderApprovals(); this.status('Codex 正在继续…'); };
      if (msg.method === 'item/tool/requestUserInput') {
        const fields = [];
        for (const q of msg.params.questions || []) {
          const label = el('label', 'cs-field'); label.append(el('span', '', q.question));
          const input = el('input', 'cs-field-input'); input.type = q.isSecret ? 'password' : 'text'; label.append(input);
          for (const option of q.options || []) label.append(button(option.label, option.description || option.label, () => { input.value = option.label; }));
          panel.append(label); fields.push([q.id, input]);
        }
        panel.append(button('回复', '提交回答', () => respond({ answers: Object.fromEntries(fields.map(([key, input]) => [key, { answers: [input.value] }])) }), 'cs-primary'));
      } else if (msg.method === 'mcpServer/elicitation/request') {
        const p = msg.params;
        const isToolApproval = p._meta?.codex_approval_kind === 'mcp_tool_call' && p.mode === 'form' && Object.keys(p.requestedSchema?.properties || {}).length === 0;
        panel.append(el('strong', '', isToolApproval ? `允许调用 ${p.serverName}？` : 'MCP 请求'), el('p', '', p.message));
        if (isToolApproval) {
          panel.append(el('pre', 'cs-approval-detail', JSON.stringify(p._meta.tool_params || {}, null, 2)));
          panel.append(button('允许这次', '允许本次 MCP 工具调用', () => respond({ action: 'accept', content: {} }), 'cs-primary'));
        } else panel.append(el('p', 'cs-muted', '本版不支持此 MCP 表单，请拒绝后用消息继续。'));
        panel.append(button('拒绝', '拒绝此请求', () => respond({ action: 'decline', content: null })));
      } else {
        panel.append(el('strong', '', msg.method.includes('fileChange') ? '允许修改文件？' : '允许运行命令？'));
        panel.append(el('pre', 'cs-approval-detail', msg.params.command || msg.params.reason || JSON.stringify(msg.params, null, 2)));
        panel.append(button('拒绝', '拒绝本次操作', () => respond({ decision: 'decline' })), button('允许这次', '仅允许本次操作', () => respond({ decision: 'accept' }), 'cs-primary'));
      }
      this.approvalsNode.append(panel);
    }
  }
};
