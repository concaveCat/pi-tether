// Final acceptance gate: every checklist item, printed with PASS/FAIL.
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '.env');
const envPass = fs.existsSync(envFile) ? (fs.readFileSync(envFile, 'utf8').match(/^WEB_PASS=(.*)$/m) || [])[1] : '';
const PORT = process.env.PORT || (fs.existsSync(envFile) ? (fs.readFileSync(envFile, 'utf8').match(/^PORT=(.*)$/m) || [])[1] : '') || '8765';
const BASE = process.env.B || `http://127.0.0.1:${PORT}`;
const WS = BASE.replace(/^http/, 'ws');
const PASS = process.env.P || envPass;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = {};
const results = [];
const check = (name, ok, detail) => { results.push([ok ? 'PASS' : 'FAIL', name, detail || '']); console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`); };
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hasSession = (n) => { try { tmux('has-session', '-t', n); return true; } catch { return false; } };

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookieHeader()) headers.Cookie = cookieHeader();
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const wsProbe = (name) => new Promise((res) => {
  const ws = new WebSocket(`${WS}/ws?session=${encodeURIComponent(name)}&cols=100&rows=30`, { headers: { Cookie: cookieHeader() } });
  const r = { status: 0, out: '', types: [] };
  ws.on('unexpected-response', (_q, resp) => { r.status = resp.statusCode; res(r); });
  ws.on('open', () => { r.status = 101; });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); r.types.push(m.t); if (m.t === 'o') r.out += m.d; });
  ws.on('error', () => res(r));
  setTimeout(() => res({ ...r, ws }), 6000);
});

if (!PASS) { console.error('缺少密码：设置 P=... 或在 .env 里配置 WEB_PASS'); process.exit(2); }
console.log('目标:', BASE);
console.log('=== 1) 未鉴权拦截 ===');
const f1 = await fetch(BASE + '/api/files');
check('未鉴权 GET /api/files => 401', f1.status === 401, 'got ' + f1.status);
const f2 = await fetch(BASE + '/api/sessions');
check('未鉴权 GET /api/sessions => 401', f2.status === 401, 'got ' + f2.status);
const f3 = await fetch(BASE + '/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"path":""}' });
check('未鉴权 POST /api/launch => 401', f3.status === 401, 'got ' + f3.status);
const w1 = await new Promise((res) => {
  const ws = new WebSocket(WS+'/ws?session=pi-x', {});
  ws.on('unexpected-response', (_q, r) => res(r.statusCode));
  ws.on('open', () => res(101));
  ws.on('error', () => res('error'));
  setTimeout(() => res('timeout'), 3000);
});
check('未鉴权 WS /ws 拒绝连接', w1 === 401, 'got ' + w1);
const bad = await api('/login', { method: 'POST', body: JSON.stringify({ password: 'wrong-password' }) });
check('错误密码不发放 Cookie', bad.status !== 302 && !jar.piweb, 'status ' + bad.status);

console.log('\n=== 2) 登录 + 沙箱 ===');
const login = await api('/login', { method: 'POST', body: JSON.stringify({ password: PASS }) });
check('正确密码 => 302 + HttpOnly Cookie', login.status === 302 && !!jar.piweb, 'status ' + login.status);
const setCookie = login.headers.getSetCookie()[0];
check('Cookie 带 HttpOnly', /HttpOnly/i.test(setCookie), setCookie.slice(0, 60) + '…');
const ok1 = await api('/api/files?path=');
check('鉴权后 GET /api/files => 200', ok1.status === 200 && Array.isArray(ok1.json.entries), ok1.json.entries.length + ' entries, dirs first: ' + ok1.json.entries.slice(0, 3).map((e) => e.type).join(','));
const ok2 = await api('/api/sessions');
check('鉴权后 GET /api/sessions => 200', ok2.status === 200, JSON.stringify(ok2.json.sessions.length) + ' sessions');
const t1 = await api('/api/files?path=../etc');
check('?path=../etc => 400/403', t1.status === 400 || t1.status === 403, 'got ' + t1.status + ' ' + t1.json?.error);
const t2 = await api('/api/file?path=../../etc/passwd');
check('?path=../../etc/passwd => 400/403', t2.status === 400 || t2.status === 403, 'got ' + t2.status);
const t3 = await api('/api/files?path=%2Fetc');
check('?path=/etc => 400/403', t3.status === 400 || t3.status === 403, 'got ' + t3.status);
execFileSync('ln', ['-sfn', '/etc', '/root/.piweb_esc']);
const t4 = await api('/api/files?path=.piweb_esc');
check('软链接逃逸 => 403', t4.status === 403, 'got ' + t4.status + ' ' + t4.json?.error);
const t5 = await api('/api/file?path=.piweb_esc/passwd');
check('软链接内文件 => 403', t5.status === 403, 'got ' + t5.status);
execFileSync('rm', ['-f', '/root/.piweb_esc']);
const t6 = await api('/api/sessions/bad%3Brm%20-rf', { method: 'DELETE' });
check('DELETE 非法会话名 => 400', t6.status === 400, 'got ' + t6.status);
const wBad = await new Promise((res) => { const ws = new WebSocket(WS+'/ws?session=' + encodeURIComponent('pi-a;rm -rf /'), { headers: { Cookie: cookieHeader() } }); ws.on('unexpected-response', (_q, r) => res(r.statusCode)); ws.on('open', () => res(101)); ws.on('error', () => res('err')); setTimeout(() => res('timeout'), 3000); });
check('WS 非法会话名 => 400', wBad === 400, 'got ' + wBad);
const wNo = await new Promise((res) => { const ws = new WebSocket(WS+'/ws?session=pi-nosuch', { headers: { Cookie: cookieHeader() } }); ws.on('unexpected-response', (_q, r) => res(r.statusCode)); ws.on('open', () => res(101)); ws.on('error', () => res('err')); setTimeout(() => res('timeout'), 3000); });
check('WS 不存在的合法会话 => 404', wNo === 404, 'got ' + wNo);

console.log('\n=== 3) 会话 + 真实 pi TUI ===');
const launch = await api('/api/launch', { method: 'POST', body: JSON.stringify({ path: '', forceNew: false }) });
check('POST /api/launch 在 /root 起会话', launch.status === 200 && launch.json.created === true, JSON.stringify(launch.json));
const name = launch.json.name;
check('会话名匹配 ^pi-[a-zA-Z0-9_-]+$', /^pi-[a-zA-Z0-9_-]+$/.test(name), name);
const reuse = await api('/api/launch', { method: 'POST', body: JSON.stringify({ path: '', forceNew: false }) });
check('同目录再次 launch => 复用同一会话', reuse.json.reused === true && reuse.json.name === name, JSON.stringify(reuse.json));
const forced = await api('/api/launch', { method: 'POST', body: JSON.stringify({ path: '', forceNew: true }) });
check('forceNew:true => 新会话', forced.json.created === true && forced.json.name !== name, forced.json.name);
await sleep(3500);
const panes = tmux('list-panes', '-a', '-F', '#{session_name}:#{pane_current_command}:#{pane_current_path}');
check('tmux 内确实在跑 pi', new RegExp(name + ':pi:/root$', 'm').test(panes), panes.trim().split('\n').filter((l) => l.startsWith(name)).join(' '));
const a1 = await wsProbe(name);
check('WS 握手 101', a1.status === 101, 'status ' + a1.status);
check('WS 收到真实终端输出', a1.out.length > 500 && a1.types.includes('o'), a1.out.length + ' bytes, types=' + [...new Set(a1.types)].join(','));
const screen1 = execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
check('pi TUI 已渲染（含状态栏）', /deepseek|Context|~\/|pi/.test(screen1), screen1.split('\n').filter((x) => x.trim()).slice(-2).join(' | ').slice(0, 120));
a1.ws && a1.ws.close();
await sleep(1500);
check('断开 WS 后 tmux 会话仍存活', hasSession(name), 'tmux has-session ' + name);
const cmdAfter = tmux('list-panes', '-t', name, '-F', '#{pane_current_command}').trim();
check('断开 WS 后 pi 仍在运行（未被 kill）', cmdAfter === 'pi', 'pane command = ' + cmdAfter);
check('无残留 tmux 客户端', (tmux('list-clients', '-F', '#{client_name}') || '').trim() === '', 'clients=' + JSON.stringify((tmux('list-clients', '-F', '#{client_name}') || '').trim()));
const a2 = await wsProbe(name);
check('重新 attach 能恢复画面', a2.status === 101 && a2.out.length > 200, a2.out.length + ' bytes');
// /resume through the same path the keybar button uses
a2.ws && a2.ws.send(JSON.stringify({ t: 'i', d: '/resume\r' }));
await sleep(3000);
const screen2 = execFileSync('tmux', ['capture-pane', '-p', '-t', name], { encoding: 'utf8' });
check('/resume 打开 pi 会话选择器', /Resume Session/i.test(screen2), screen2.split('\n').find((l) => /Resume Session/i.test(l))?.trim().slice(0, 90) || 'not found');
a2.ws && a2.ws.close();
await sleep(600);

console.log('\n=== 4) 清理 ===');
const dels = [];
for (const n of [name, forced.json.name]) {
  const d = await api('/api/sessions/' + n, { method: 'DELETE' });
  dels.push(d.status);
}
check('DELETE 关闭测试会话', dels.every((s) => s === 200), 'status ' + dels.join(','));
const left = (await api('/api/sessions')).json.sessions;
check('无残留 pi-* 会话', left.length === 0, JSON.stringify(left.map((s) => s.name)));
let leftover = '';
try { leftover = tmux('ls').split('\n').filter((l) => l.startsWith('pi-')).join(','); } catch {}
check('tmux ls 无 pi-* 残留', leftover === '', leftover || '(none)');


console.log('\n=== 5) 对话视图（pi --mode rpc） ===');
const c1 = await api('/api/chats', { method: 'POST', body: JSON.stringify({ path: 'pi-web', forceNew: true }) });
check('POST /api/chats 起对话进程', c1.status === 200 && c1.json.alive === true, JSON.stringify({ name: c1.json.name, created: c1.json.created }));
const chatName = c1.json.name;
check('对话名匹配 ^chat-[a-zA-Z0-9_-]+$', /^chat-[a-zA-Z0-9_-]+$/.test(chatName), chatName);
check('聊天模型/思考档位已就绪', !!c1.json.model && !!c1.json.thinkingLevel, `${c1.json.model?.id} · ${c1.json.thinkingLevel}`);

const chatProbe = (name, prompt, waitMs) => new Promise((resolve) => {
  const ws = new WebSocket(`${WS}/ws/chat?chat=${encodeURIComponent(name)}`, { headers: { Cookie: cookieHeader() } });
  const r = { status: 0, items: [], states: [], streamingSeen: false };
  ws.on('unexpected-response', (_q, resp) => { r.status = resp.statusCode; resolve(r); });
  ws.on('open', () => { r.status = 101; if (prompt) ws.send(JSON.stringify({ t: 'prompt', text: prompt })); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'items') r.items = m.items;
    else if (m.t === 'item') {
      const i = r.items.findIndex((x) => x.id === m.item.id);
      if (i >= 0) r.items[i] = m.item; else r.items.push(m.item);
    } else if (m.t === 'state') { r.states.push(m.state); if (m.state.streaming) r.streamingSeen = true; }
  });
  ws.on('error', () => resolve(r));
  setTimeout(() => resolve({ ...r, ws }), waitMs);
});

const cp = await chatProbe(chatName, '用 bash 执行 echo chat-smoke，然后用一句话回复结果。', 90000);
check('对话 WS 握手 101', cp.status === 101, 'status ' + cp.status);
const assistantItems = cp.items.filter((i) => i.role === 'assistant');
const toolBlocks = assistantItems.flatMap((i) => (i.blocks || []).filter((b) => b.type === 'tool'));
check('对话收到 user 消息', cp.items.some((i) => i.role === 'user'), (cp.items.find((i) => i.role === 'user')?.text || '').slice(0, 40));
check('对话收到助手文本', assistantItems.some((i) => (i.blocks || []).some((b) => b.type === 'text' && b.text)), (assistantItems.flatMap((i) => i.blocks || []).find((b) => b.type === 'text')?.text || '').slice(0, 60));
check('工具调用被结构化渲染（bash）', toolBlocks.some((b) => b.name === 'bash' && b.state === 'ok'), JSON.stringify(toolBlocks.map((b) => `${b.name}:${b.state}`)));
check('工具输出已回填', toolBlocks.some((b) => (b.output || '').includes('chat-smoke')), (toolBlocks.find((b) => b.name === 'bash')?.output || '').trim().slice(0, 40));
check('流式状态有 streaming=true→false', cp.streamingSeen === true && cp.states.some((s) => s.streaming === false), 'states=' + cp.states.length);
if (cp.ws) cp.ws.close();
await sleep(600);

const cp2 = await chatProbe(chatName, null, 3000);
check('断开后重连可回放完整历史', cp2.status === 101 && cp2.items.length >= cp.items.length, `${cp2.items.length} vs ${cp.items.length}`);
if (cp2.ws) cp2.ws.close();

const delChat = await api('/api/chats/' + chatName, { method: 'DELETE' });
check('DELETE 关闭对话进程', delChat.status === 200, JSON.stringify(delChat.json));
const after = (await api('/api/chats')).json.chats.map((c) => c.name);
check('测试对话已从列表移除', !after.includes(chatName), JSON.stringify(after));

const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`\n===== ${results.length - fails.length}/${results.length} PASS =====`);
if (fails.length) { console.log('FAILURES:'); fails.forEach((f) => console.log(' - ' + f[1] + ' :: ' + f[2])); }
process.exit(fails.length ? 1 : 0);
