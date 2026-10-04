'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const runtime = process.env.CODEX_TEST_NODE_MODULES || 'C:/Users/jkjk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const { chromium } = require(require.resolve('playwright', { paths: [runtime] }));
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-results'); fs.mkdirSync(out, { recursive: true });
const source = fs.readFileSync(path.join(root, 'src/index.cjs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/index.css'), 'utf8');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CODEX_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 820 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent(`<style>:root{--b3-theme-background:#fff;--b3-theme-on-background:#242424;--b3-theme-surface:#f3f3f3;--b3-theme-on-surface:#606060;--b3-theme-primary:#3574d4;--b3-theme-on-primary:#fff;--b3-border-color:#dadada;--b3-theme-error:#b42318;--b3-font-family:"Segoe UI","Microsoft YaHei",sans-serif;--b3-font-family-code:Consolas,monospace}body{margin:0}#host{height:100vh}${css}</style><div id="host"></div>`);
    await page.addScriptTag({ path: process.env.CODEX_TEST_LUTE || 'D:/siyuan xin/resources/stage/protyle/js/lute/lute.min.js' });
    await page.evaluate(source => {
      window.saved = null; window.calls = []; window.codexConfig = { model: 'model-a', model_reasoning_effort: 'medium' };
      class Plugin {
        // SiYuan 3.8.6 Plugin constructor owns this map for custom tabs.
        constructor() { this.models = {}; }
        async loadData() { return window.saved; }
        async saveData(_key, value) { window.saved = structuredClone(value); }
        addIcons() {} addDock(options) { options.init({ element: document.querySelector('#host') }); }
      }
      class CodexClient {
        constructor(hooks) { Object.assign(this, hooks); }
        async start() {} stop() {} reply(id, result) { window.lastReply = { id, result }; } replyError() {}
        async request(method, params) {
          window.calls.push({ method, params });
          if (method === 'config/read') return { config: window.codexConfig };
          if (method === 'account/read') return { account: { type: 'chatgpt' } };
          if (method === 'model/list') return params.cursor ? { data: [{ model: 'model-b', displayName: 'Model B', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null } : { data: [{ model: 'model-a', displayName: 'Model A', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: 'page2' };
          if (method === 'mcpServerStatus/list') return { data: [{ name: 'siyuan', tools: { search: {}, document: {} } }] };
          if (method === 'thread/start') return { thread: { id: 'thread-' + window.calls.length } };
          if (method === 'thread/resume') return { thread: { id: params.threadId } };
          if (method === 'turn/start') {
            this.thread = params.threadId;
            return { turn: { id: 'turn-1' } };
          }
          if (method === 'turn/interrupt') this.onEvent('turn/completed', { threadId: this.thread, turn: { status: 'interrupted' } });
          return {};
        }
      }
      const require = name => name === 'siyuan' ? { Plugin } : name === './client.cjs' ? { CodexClient, threadParams: (s, opts) => ({ developerInstructions: s.prompt, cwd: opts.cwd }) } : name === 'os' ? { homedir: () => 'C:/Users/test' } : {};
      const module = { exports: {} };
      new Function('require', 'module', source)(require, module);
      window.PluginClass = module.exports; window.plugin = new module.exports(); return window.plugin.onload();
    }, source);
    assert.equal(await page.getByRole('button', { name: '通过浏览器登录 Codex' }).count(), 0);
    await page.evaluate(() => { window.plugin.authenticated = false; window.plugin.controls(); });
    assert.equal(await page.getByRole('button', { name: '通过浏览器登录 Codex' }).count(), 0);
    await page.evaluate(() => { window.plugin.authenticated = true; window.plugin.controls(); });
    assert.equal(await page.locator('.cs-composer select[aria-label="选择模型"]').count(), 1, '模型选择应在输入框内');
    assert.equal(await page.locator('.cs-composer select[aria-label="思考强度"]').count(), 1, '输入框应提供思考强度');
    await page.waitForFunction(() => window.plugin.codexModels?.length === 2);
    await page.getByRole('button', { name: '新建对话，使用当前前置提示词' }).click();
    await page.getByRole('button', { name: '新建对话，使用当前前置提示词' }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('尚未发送的草稿');
    await page.getByRole('button', { name: '历史记录', exact: true }).click();
    assert.equal(await page.locator('.cs-history-item').count(), 0, '空白对话和未发送草稿不能出现在历史记录');
    assert.equal(await page.locator('.cs-history-list').textContent(), '暂无历史对话');
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '尚未发送的草稿');
    const modelTrigger = page.getByRole('button', { name: '选择模型与思考强度', exact: true });
    assert.equal(await page.getByRole('combobox', { name: '选择模型' }).isVisible(), false);
    await modelTrigger.click();
    assert.equal(await page.locator('.cs-model-panel button').count(), 0);
    assert.equal(await page.locator('.cs-model-panel').innerText().then(t => /跟随|1\.5|重置/.test(t)), false);
    await page.getByRole('combobox', { name: '选择模型' }).selectOption('model-b');
    const effortSlider = page.getByRole('slider', { name: '思考强度' });
    await effortSlider.focus(); await page.keyboard.press('End');
    assert.equal(await effortSlider.getAttribute('aria-valuetext'), '高');
    assert.equal(await effortSlider.getAttribute('max'), '1');
    await page.waitForFunction(() => window.saved?.settings.effort === 'high');
    assert.equal(await page.locator('.cs-status').textContent().then(t => t.includes('已选择')), false);
    await page.screenshot({ path: path.join(out, 'model-panel.png') });
    await page.keyboard.press('Escape');
    assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await modelTrigger.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.cs-model-trigger').textContent(), 'Model B高');
    await page.screenshot({ path: path.join(out, 'sidebar-empty.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addStyleTag({ content: '#host{width:380px;margin-left:auto}' });
    const chatBounds = await page.locator('.cs-messages').boundingBox();
    await page.getByRole('button', { name: '设置前置提示词与 Codex 连接' }).click();
    assert.deepEqual(await page.locator('.cs-messages').boundingBox(), chatBounds);
    const dialogBounds = await page.getByRole('dialog', { name: 'Codex 设置' }).boundingBox();
    assert.ok(Math.abs(dialogBounds.x + dialogBounds.width / 2 - 640) < 1);
    assert.ok(Math.abs(dialogBounds.y + dialogBounds.height / 2 - 450) < 1);
    await page.getByRole('button', { name: '保存前置提示词与连接设置' }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('dialog') !== null), true);
    assert.equal(await page.locator('.cs-settings-dialog select').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.plugin.models), {});
    await page.locator('.cs-field textarea').fill('用中文回答，先给结论，再解释。');
    await page.getByRole('button', { name: '保存前置提示词与连接设置' }).click();
    await page.waitForFunction(() => window.saved?.settings.prompt.includes('先给结论'));
    assert.equal(await page.evaluate(() => window.plugin.session().prompt), '');
    assert.equal(await page.evaluate(() => window.saved.settings.model), 'model-b');
    assert.equal(await page.evaluate(() => window.plugin.session().model), 'model-b');
    await page.screenshot({ path: path.join(out, 'sidebar-settings.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '设置前置提示词与 Codex 连接' }).evaluate(node => node === document.activeElement), true);
    await page.getByRole('button', { name: '设置前置提示词与 Codex 连接' }).click();
    await page.mouse.click(10, 10);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.setViewportSize({ width: 380, height: 820 });
    await page.addStyleTag({ content: '#host{width:100%}' });
    await page.getByRole('button', { name: '新建对话，使用当前前置提示词' }).click();
    assert.equal(await page.evaluate(() => window.plugin.session().model), 'model-b');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('请通过思源 MCP 查找我的阅读笔记');
    await page.getByRole('button', { name: '发送消息（Enter）；Shift+Enter 换行' }).click();
    await page.waitForFunction(() => window.calls.some(c => c.method === 'turn/start'));
    assert.deepEqual(await page.evaluate(() => { const p = window.calls.find(c => c.method === 'turn/start').params; return { model: p.model, effort: p.effort }; }), { model: 'model-b', effort: 'high' });
    assert.equal(await page.evaluate(() => window.calls.find(c => c.method === 'thread/start').params.developerInstructions), '用中文回答，先给结论，再解释。');
    await page.evaluate(() => {
      const p = window.plugin; const threadId = p.session().threadId;
      p.event('item/started', { threadId, item: { type: 'mcpToolCall', server: 'siyuan', tool: 'search' } });
      p.event('item/completed', { threadId, item: { type: 'mcpToolCall', server: 'siyuan', tool: 'search' } });
      p.event('item/agentMessage/delta', { threadId, itemId: 'm1', delta: '找到了相关的阅读笔记。\n\n笔记讨论了如何将信息整理成可复用的知识。这里是根据原文整理的说明。' });
      p.event('item/completed', { threadId, item: { type: 'agentMessage', id: 'm1', text: '找到了相关的阅读笔记。\n\n笔记讨论了如何将信息整理成可复用的知识。这里是根据原文整理的说明。' } });
      p.event('turn/completed', { threadId, turn: { status: 'completed' } });
    });
    await page.screenshot({ path: path.join(out, 'sidebar-chat.png') });
    await page.evaluate(() => {
      const p = window.plugin;
      p.event('thread/tokenUsage/updated', { threadId: p.session().threadId, tokenUsage: { last: { totalTokens: 116000 }, total: { totalTokens: 9000000 }, modelContextWindow: 486000 } });
    });
    await page.locator('.cs-context-button').hover();
    assert.equal(await page.getByRole('tooltip').innerText(), '背景信息窗口：\n24% 已用（剩余 76%）\n已用 116k 标记，共 486k');
    assert.equal(await page.locator('.cs-context-progress').getAttribute('stroke-dasharray'), '24 100');
    assert.equal(await page.locator('.cs-context-progress').evaluate(n => parseFloat(getComputedStyle(n).strokeDasharray)), 24);
    await page.screenshot({ path: path.join(out, 'context-usage.png') });
    await page.locator('.cs-context-button').focus(); await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('tooltip').isVisible(), false);
    await modelTrigger.click();
    await page.getByRole('combobox', { name: '选择模型' }).selectOption('model-a');
    assert.equal(await page.evaluate(() => window.plugin.contextUsage()), null);
    await effortSlider.focus(); await page.keyboard.press('End');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.codexConfig = { model: 'model-a', model_reasoning_effort: 'high' }; });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('继续解释第二点');
    await page.getByRole('button', { name: '发送消息（Enter）；Shift+Enter 换行' }).click();
    await page.waitForFunction(() => window.calls.filter(c => c.method === 'turn/start').length === 2);
    assert.equal(await page.evaluate(() => window.calls.filter(c => c.method === 'thread/start').length), 1);
    assert.deepEqual(await page.evaluate(() => { const p = window.calls.filter(c => c.method === 'turn/start')[1].params; return { model: p.model, effort: p.effort }; }), { model: 'model-a', effort: 'high' });
    assert.equal(await modelTrigger.isDisabled(), true);
    await page.evaluate(() => window.plugin.serverRequest({ id: 7, method: 'mcpServer/elicitation/request', params: { serverName: 'siyuan', mode: 'form', message: 'Allow system?', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { action: 'version' } }, requestedSchema: { properties: {} } } }));
    await page.getByRole('button', { name: '允许本次 MCP 工具调用' }).click();
    assert.deepEqual(await page.evaluate(() => window.lastReply), { id: 7, result: { action: 'accept', content: {} } });
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.waitForFunction(() => !window.plugin.busy);
    await page.evaluate(() => {
      const p = window.plugin;
      p.event('thread/tokenUsage/updated', { threadId: p.session().threadId, tokenUsage: { last: { totalTokens: 116000 }, total: { totalTokens: 9999999 }, modelContextWindow: 486000 } });
      return p.writeQueue;
    });
    await page.evaluate(async () => { window.plugin.onunload(); window.plugin = new window.PluginClass(); await window.plugin.onload(); });
    assert.equal(await page.evaluate(() => window.plugin.contextUsage().percent), 24);
    assert.equal(await page.evaluate(() => window.plugin.state.settings.prompt), '用中文回答，先给结论，再解释。');
    assert.equal(await page.locator('.cs-user').count(), 2);
    await page.setViewportSize({ width: 280, height: 650 });
    await page.screenshot({ path: path.join(out, 'sidebar-narrow.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.addStyleTag({ content: ':root{--b3-theme-background:#1e1e1e;--b3-theme-on-background:#ddd;--b3-theme-surface:#2b2b2b;--b3-theme-on-surface:#aaa;--b3-border-color:#444;--b3-theme-primary:#74a7f5;--b3-theme-on-primary:#151515}' });
    await page.screenshot({ path: path.join(out, 'sidebar-dark.png') });
    await page.locator('.cs-context-button').hover();
    const tooltipBounds = await page.getByRole('tooltip').boundingBox();
    assert.ok(tooltipBounds.x >= 0 && tooltipBounds.x + tooltipBounds.width <= 280);
    await page.screenshot({ path: path.join(out, 'context-usage-narrow-dark.png') });
    await page.locator('.cs-header strong').click();
    await modelTrigger.click();
    const modelPanelBounds = await page.locator('.cs-model-panel').boundingBox();
    assert.ok(modelPanelBounds.x >= 0 && modelPanelBounds.x + modelPanelBounds.width <= 280);
    await page.screenshot({ path: path.join(out, 'model-panel-narrow-dark.png') });
    await page.locator('.cs-header strong').click();
    assert.equal(await modelTrigger.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => window.plugin.openSetting());
    await page.locator('.cs-advanced summary').click();
    await page.screenshot({ path: path.join(out, 'settings-narrow-dark.png') });
    assert.equal(await page.evaluate(() => document.querySelector('.cs-settings').scrollWidth > document.querySelector('.cs-settings').clientWidth), false);
    await page.getByRole('button', { name: '关闭设置' }).click();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.evaluate(() => {
      window.plugin.session().messages.push({ role: 'assistant', text: '**加粗测试**\n\n<script>window.pwned=true</script>\n<a href="javascript:alert(1)" onclick="window.pwned=true">bad</a>\n<img src=x onerror="window.pwned=true">\n\n[正常链接](https://example.com)' });
      window.plugin.renderMessages();
    });
    assert.equal(await page.locator('.cs-body strong').last().textContent(), '加粗测试');
    assert.equal(await page.locator('.cs-body script,.cs-body img,.cs-body [onclick],.cs-body a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => !!window.pwned), false);
    // History replaces the always-visible select and preserves per-chat drafts.
    await page.evaluate(() => {
      const p = window.plugin;
      p.session().title = '当前对话';
      p.state.sessions.unshift({ id: 'history-test', title: '一条很长的历史记录标题，用来验证窄侧栏中的省略显示与布局', messages: [{ role: 'user', text: '历史问题' }], draft: '历史草稿', prompt: '', model: '' });
      p.renderSessions();
    });
    const history = page.getByRole('button', { name: '历史记录', exact: true });
    const historyPanel = page.locator('.cs-history');
    assert.equal(await page.locator('select.cs-sessions').count(), 0);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('当前草稿');
    await history.click();
    assert.equal(await history.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.cs-history-item[aria-current]').evaluate(n => n === document.activeElement), true);
    const panelBounds = await historyPanel.boundingBox();
    assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 280);
    await page.screenshot({ path: path.join(out, 'history-narrow-dark.png') });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '历史草稿');
    assert.equal(await historyPanel.isVisible(), false);
    await history.click();
    await page.getByRole('button', { name: '当前对话', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '当前草稿');
    await history.click();
    await page.keyboard.press('Escape');
    assert.equal(await historyPanel.isVisible(), false);
    assert.equal(await history.evaluate(n => n === document.activeElement), true);
    await history.click();
    await page.getByRole('textbox', { name: '消息', exact: true }).click();
    assert.equal(await historyPanel.isVisible(), false);
    await page.evaluate(() => { window.plugin.busy = true; window.plugin.controls(); });
    assert.equal(await history.isDisabled(), true);
    await page.evaluate(() => { window.plugin.busy = false; window.plugin.controls(); });
    await page.setViewportSize({ width: 430, height: 700 });
    // Load the real host stylesheet: its svg { fill: currentColor } overrides SVG attributes.
    const hostStyleDir = process.env.CODEX_TEST_HOST_CSS_DIR || 'D:/siyuan xin/resources/stage/build/desktop';
    const hostStyle = fs.readdirSync(hostStyleDir).find(name => /^base\..*\.css$/.test(name));
    await page.addStyleTag({ path: path.join(hostStyleDir, hostStyle) });
    assert.equal(await page.getByRole('button', { name: '收起侧栏', exact: true }).evaluate(node => getComputedStyle(node).opacity), '1', '收起按钮不能被思源默认样式隐藏');
    const iconStyles = await page.locator('.cs-header .cs-icon').evaluateAll(nodes => nodes.map(node => ({ fill: getComputedStyle(node).fill, stroke: getComputedStyle(node).stroke, width: getComputedStyle(node).width })));
    assert.ok(iconStyles.every(style => style.fill === 'none'), `Host CSS filled outline icons: ${JSON.stringify(iconStyles)}`);
    assert.ok(iconStyles.every(style => style.stroke !== 'none' && style.width === '18px'));
    await page.addStyleTag({ content: ':root{--b3-theme-background:#faf9f6;--b3-theme-on-background:#343b32;--b3-theme-surface:#eeeee7;--b3-theme-on-surface:#626b5b;--b3-border-color:#e3e0d9;--b3-theme-primary:#769267;--b3-theme-primary-light:#e7edde;--b3-theme-on-primary:#fff}' });
    await page.locator('.cs-header').screenshot({ path: path.join(out, 'toolbar-refined.png') });
    await history.click();
    await page.screenshot({ path: path.join(out, 'history-refined.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.calls.some(c => c.method === 'config/read')), false);
    assert.deepEqual(errors, []);
    await page.evaluate(() => { window.plugin.openSetting(); window.plugin.onunload(); });
    assert.equal(await page.locator('.cs-settings-dialog').count(), 0);
    console.log('UI_OK: prompt persistence, prompt snapshot, continuity, MCP approval, stop, reload, narrow layout, light/dark, host Lute Markdown and HTML sanitization; no console errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
