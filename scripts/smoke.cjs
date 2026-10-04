'use strict';
const { CodexClient, threadParams } = require('../src/client.cjs');
const os = require('os');
let finish;
let answer = '';
const events = [];
let mcpCalls = 0;
const toolEvents = [];
const client = new CodexClient({
  onEvent(method, p) {
    if (method === 'item/agentMessage/delta') answer += p.delta;
    if (method === 'turn/completed') finish?.(p.turn);
    if (method === 'error') events.push(p.error?.message);
    if (method === 'item/completed' && p.item?.type === 'mcpToolCall' && /siyuan/i.test(p.item.server) && !p.item.error) mcpCalls++;
    if (method === 'item/completed') toolEvents.push({ type: p.item?.type, server: p.item?.server, tool: p.item?.tool });
  },
  onRequest(msg) {
    const p = msg.params;
    if (process.argv.includes('--mcp') && msg.method === 'mcpServer/elicitation/request' && p.serverName === 'siyuan' &&
        p._meta?.codex_approval_kind === 'mcp_tool_call' && p._meta?.tool_params?.action === 'version' && /tool "system"/.test(p.message) &&
        Object.keys(p.requestedSchema?.properties || {}).length === 0) client.reply(msg.id, { action: 'accept', content: {} });
    else client.replyError(msg.id, 'Smoke test only permits the SiYuan version query');
  }
});
async function turn(threadId, text) {
  answer = '';
  let timer;
  const completed = new Promise((resolve, reject) => {
    finish = resolve; timer = setTimeout(() => reject(new Error('Turn timeout')), 150000);
  });
  try {
    await client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
    const result = await completed;
    if (result.status !== 'completed') throw new Error(result.error?.message || result.status);
    return answer;
  } finally { clearTimeout(timer); }
}
(async () => {
  try {
    await client.start({ cwd: process.cwd() });
    console.log('INITIALIZE_OK');
    const auth = await client.request('account/read', {});
    console.log('AUTH', auth.account?.type || 'none');
    const mcp = await client.request('mcpServerStatus/list', {});
    const sy = mcp.data.find(x => /siyuan/i.test(x.name));
    console.log('SIYUAN_MCP', sy ? Object.keys(sy.tools || {}).length + ' tools' : 'missing');
    if (!sy || !Object.keys(sy.tools || {}).length) throw new Error('SiYuan MCP unavailable');
    if (process.argv.includes('--edit')) {
      const ids = [];
      try {
        const start = await client.request('thread/start', threadParams({ prompt: '这是插件协议测试。只回复 OK，不调用工具。' }, { cwd: process.cwd() }));
        ids.push(start.thread.id);
        await turn(start.thread.id, '保留这一轮 EDIT_KEEP');
        await turn(start.thread.id, '将替换这一轮 EDIT_DROP');
        const original = await client.request('thread/read', { threadId: start.thread.id, includeTurns: true });
        if (original.thread.turns.length !== 2) throw new Error('Expected two original turns');
        const fork = await client.request('thread/fork', { threadId: start.thread.id, lastTurnId: original.thread.turns[0].id });
        ids.push(fork.thread.id);
        const branch = await client.request('thread/read', { threadId: fork.thread.id, includeTurns: true });
        const history = JSON.stringify(branch.thread.turns);
        if (!history.includes('EDIT_KEEP') || history.includes('EDIT_DROP')) throw new Error('Fork retained the replaced turn');
        console.log('EDIT_FORK_CONTEXT_OK');
      } finally {
        for (const threadId of ids) await client.request('thread/archive', { threadId });
      }
    }
    if (process.argv.includes('--chat')) {
      const start = await client.request('thread/start', {
        ...threadParams({ prompt: '每次回答以 SIDEBAR_OK 开头。回答尽量短。不要使用工具。' }, { cwd: process.cwd() }), ephemeral: true
      });
      const first = await turn(start.thread.id, '记住代号松果。仅回复已记住。');
      const second = await turn(start.thread.id, '我刚才让你记住的代号是什么？');
      if (!first.includes('SIDEBAR_OK') || !second.includes('SIDEBAR_OK') || !second.includes('松果')) throw new Error('Prompt or continuity check failed');
      console.log('PROMPT_AND_CONTINUITY_OK');
    }
    if (process.argv.includes('--mcp')) {
      const start = await client.request('thread/start', {
        ...threadParams({ prompt: '你正在测试思源 MCP 连接，只能查询版本信息，不要读取笔记内容，不要修改任何数据。' }, { cwd: process.cwd() }), ephemeral: true
      });
      const result = await turn(start.thread.id, '请调用思源 MCP 的 system 工具，action 为 version，告诉我版本号。');
      if (!mcpCalls) { console.log('MCP_DIAGNOSTIC', JSON.stringify(toolEvents), result); throw new Error('No successful SiYuan MCP tool call observed'); }
      console.log('SIYUAN_MCP_CALL_OK');
    }
  } catch (e) { console.error('SMOKE_FAILED', e.message); process.exitCode = 1; }
  finally { client.stop(); }
})();
