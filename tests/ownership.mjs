#!/usr/bin/env node
/**
 * Ownership regression suite: one session file may only have one writer.
 *
 *   node tests/ownership.mjs                 # uses PORT from .env (default 8765)
 *   B=http://127.0.0.1:8765 P=<password> node tests/ownership.mjs
 *
 * Creates two chats in a scratch directory (default /tmp/pitether-own-test) and
 * deletes them afterwards. Takes ~3 minutes because the foreign-writer check
 * needs an idle window before it may fire.
 */
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ENV = path.join(HERE, '..', '.env');
const readEnv = (k, d = '') => {
  try { return (fs.readFileSync(ENV, 'utf8').match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || d; } catch { return d; }
};
const PORT = readEnv('PORT', '8765');
const BASE = process.env.B || `http://127.0.0.1:${PORT}`;
const PASS = process.env.P || readEnv('WEB_PASS');
const AUTH = 'Basic ' + Buffer.from(`root:${PASS}`).toString('base64');
const DIR = process.env.DIR || 'pitether-own-test';   // 相对服务端的沙箱根

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, o = {}) => {
  const r = await fetch(BASE + p, { headers: { Authorization: AUTH, ...(o.body ? { 'Content-Type': 'application/json' } : {}) }, ...o });
  return r.json().catch(() => null);
};
let fails = 0;
const pass = (n, ok, x = '') => { if (!ok) fails += 1; console.log(`${ok ? '[PASS]' : '[FAIL]'} ${n}${x ? '  — ' + x : ''}`); };

/** open a chat socket and collect every event it receives */
async function openChat(name) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws/chat?chat=${encodeURIComponent(name)}`, { headers: { Authorization: AUTH }, maxPayload: 32 * 1024 * 1024 });
  const log = [];
  ws.on('message', (r) => log.push(JSON.parse(r.toString())));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return { ws, log, send: (o) => ws.send(JSON.stringify(o)) };
}

const waitFor = async (source, pred, ms) => {
  const view = () => (typeof source === 'function' ? source() : source);
  const t0 = Date.now();
  for (;;) {
    const hit = view().find(pred);
    if (hit) return hit;
    if (Date.now() - t0 > ms) return null;
    await sleep(200);
  }
};

// 沙箱根由服务端决定（PITETHER_ROOT 或 $HOME），测试目录建在它下面
const ME = await api('/api/me');
const ABS = path.join(ME.root, DIR);
fs.mkdirSync(ABS, { recursive: true });
console.log(`scratch: ${ABS}`);

const A = await api('/api/chats', { method: 'POST', body: JSON.stringify({ path: DIR, forceNew: true }) });
const a = await openChat(A.name);
await sleep(1500);
a.send({ t: 'prompt', text: '只回答：OWN-A' });
await sleep(9000);
a.send({ t: 'session_info' });
const infoA = await waitFor(a.log, (m) => m.t === 'session_info', 15000);
const fileA = infoA?.stats?.sessionFile;
pass('会话 A 有会话文件', !!fileA, (fileA || '').split('/').pop());

// 1) 同目录再开一个（不带 forceNew）→ 复用同一进程
const A2 = await api('/api/chats', { method: 'POST', body: JSON.stringify({ path: DIR }) });
pass('同目录第二次建对话 = 复用同一进程', A2.joined === true && A2.name === A.name, `name=${A2.name}`);

// 2) 两个窗口订阅同一 chat → 收到同一份流
const a2 = await openChat(A.name);
await sleep(1500);
const markA = a.log.length; const markA2 = a2.log.length;
a.send({ t: 'prompt', text: '只回答：SHARED1' });
await sleep(9000);
const bytesA = JSON.stringify(a.log.slice(markA)).length;
const bytesA2 = JSON.stringify(a2.log.slice(markA2)).length;
const shared1 = a2.log.slice(markA2).some((m) => JSON.stringify(m).includes('SHARED1'));
pass('两个 WS 客户端看到同一份流', Math.abs(bytesA - bytesA2) < 200 && shared1, `w1=${bytesA}B w2=${bytesA2}B`);

// 3) forceNew 开新会话，绝不接管 A 的文件
const B = await api('/api/chats', { method: 'POST', body: JSON.stringify({ path: DIR, forceNew: true }) });
const b = await openChat(B.name);
await sleep(1500);
b.send({ t: 'prompt', text: '只回答：OWN-B' });
await sleep(9000);
b.send({ t: 'session_info' });
const infoB = await waitFor(b.log, (m) => m.t === 'session_info', 15000);
const fileB = infoB?.stats?.sessionFile;
pass('forceNew 建出新对话且未接管 A 的会话', B.name !== A.name && !!fileB && fileB !== fileA, `B=${(fileB || '').split('/').pop()}`);
pass('A/B 是两个不同会话文件', fileA !== fileB);

const countUser = (f) => {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"role":"user"')).length; } catch { return -1; }
};
const beforeA = countUser(fileA);
pass('B 的对话没有写进 A 的会话文件', beforeA >= 2, `A 用户消息 ${beforeA}`);

// 4) /resume 冲突：别人正在写的会话必须被拒
b.send({ t: 'resume', path: fileA });
const ackConflict = await waitFor(b.log, (m) => m.t === 'ack' && m.ok === false && m.owner, 12000);
pass('/resume 到别人正在写的会话 → 拒绝并指出 owner', !!ackConflict && ackConflict.owner === A.name, `ok=${ackConflict?.ok} owner=${ackConflict?.owner}`);

// 5) /resume 自己的会话 → 允许
a.send({ t: 'resume', path: fileA });
const ackSelf = await waitFor(a.log, (m) => m.t === 'ack' && m.ok === true, 20000);
pass('/resume 到自己的会话 → 允许', !!ackSelf);

// 6) A 关掉后该会话可被接管
a.ws.close(); a2.ws.close();
await api('/api/chats/' + A.name, { method: 'DELETE' });
await sleep(2000);
b.send({ t: 'resume', path: fileA });
const ackTake = await waitFor(b.log, (m) => m.t === 'ack' && (m.ok === true || m.owner), 25000);
pass('A 关闭后该会话可被接管', !!ackTake && ackTake.ok === true, `ok=${ackTake?.ok} owner=${ackTake?.owner}`);

// 7) 外部进程写入检测（空闲 ≥60s + 连续两轮巡检）
await sleep(5000);   // 等接管后的 switch 完成（它会重新记 fileSizeSeen）
console.log('已向会话文件追加一行外部写入，等空闲门槛 + 两轮巡检（~110s）…');
const markB = b.log.length;
fs.appendFileSync(fileA, JSON.stringify({
  type: 'message', id: 'foreign-probe', parentId: 'x', timestamp: new Date().toISOString(),
  message: { role: 'user', content: '外部写入探针' },
}) + '\n');
// 传函数：每轮重新取 slice，否则看到的是调用时的快照
const warned = await waitFor(() => b.log.slice(markB), (m) => JSON.stringify(m).includes('另一进程'), 140000);
pass('外部写入被检出并告警', !!warned);

b.ws.close();
await api('/api/chats/' + B.name, { method: 'DELETE' });
console.log(fails ? `\n===== ${fails} 项失败 =====` : '\n===== 全部通过 =====');
setTimeout(() => process.exit(fails ? 1 : 0), 300);
