/**
 * chat.mjs — structured chat sessions for pi-web.
 *
 * Each chat is a long-lived `pi --mode rpc` child process owned by the web
 * server (NOT by the WebSocket), so closing the phone browser never interrupts
 * a running task. The child streams JSONL records; we fold them into a
 * transcript (`items`) that any number of clients can subscribe to.
 *
 * This is the structured counterpart of the tmux/PTY terminal view: same pi,
 * same session files, but rendered as a chat (thinking / tool calls / diffs).
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPanel } from './panel.mjs';

const PANEL_POLL_MS = 4000;
/** pi's agent dir: PI_CODING_AGENT_DIR is pi's own override, default ~/.pi/agent */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
const SESSIONS_ROOT = path.join(AGENT_DIR, 'sessions');

/**
 * Login shell used for pi child processes. `-l` is what makes PATH / proxy /
 * API keys match the terminal, so we honour $SHELL / PIWEB_SHELL — but only for
 * shells that can run the POSIX form `exec "$@"` (fish/csh/nu cannot).
 */
const SHELL_BIN = (() => {
  const POSIX = /(bash|zsh|sh|ksh|dash|ash)$/;
  const candidates = [process.env.PIWEB_SHELL, process.env.SHELL, '/bin/bash', '/bin/sh'];
  for (const c of candidates) {
    if (!c || !POSIX.test(c)) continue;
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
  }
  return '/bin/sh';
})();
const MAX_OUT = 16000;            // characters kept per tool output block
const MAX_ITEMS = 600;
const FLUSH_MS = 60;              // coalesce streaming patches

let uid = 0;
const newId = (p) => `${p}${Date.now().toString(36)}${(++uid).toString(36)}`;

const clip = (s, n = MAX_OUT) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}\n… （已截断，原始 ${str.length} 字符）` : str;
};

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  }
  return '';
};

/** newest pi session file whose header.cwd === cwd (used to resume after restarts) */
export function findLatestSession(cwd) {
  let dirs;
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  let best = null;
  for (const d of dirs) {
    const dirPath = path.join(SESSIONS_ROOT, d.name);
    let files;
    try { files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    if (!files.length) continue;
    const withTime = files.map((f) => {
      const p = path.join(dirPath, f);
      try { return { p, t: fs.statSync(p).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.t - a.t);
    if (!withTime.length) continue;
    const cand = withTime[0];
    if (best && cand.t <= best.t) continue;
    try {
      const line = fs.readFileSync(cand.p, 'utf8').split('\n', 1)[0];
      const header = JSON.parse(line);
      if (header?.cwd === cwd) best = { path: cand.p, t: cand.t, header };
    } catch { /* ignore unreadable session */ }
  }
  return best?.path ?? null;
}

const SESSION_PARSE_MAX = 4 * 1024 * 1024;

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** first JSON line of a session file (the header with cwd/id/timestamp) */
function readSessionHeader(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      return JSON.parse(buf.toString('utf8', 0, n).split('\n', 1)[0]);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function describeSession(file, size) {
  const empty = { preview: '', messages: null, model: null, name: '' };
  let raw;
  try {
    if (size > SESSION_PARSE_MAX) {
      // huge sessions: read the head only, so the picker still shows a preview
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(192 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        raw = buf.toString('utf8', 0, n);
        raw = raw.slice(0, raw.lastIndexOf('\n') + 1);
      } finally { fs.closeSync(fd); }
    } else {
      raw = fs.readFileSync(file, 'utf8');
    }
  } catch { return empty; }
  let preview = '', messages = 0, model = null, name = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'session_info' && typeof e.name === 'string') { name = e.name; continue; }
    if (e.type !== 'message') continue;
    messages += 1;
    const m = e.message || {};
    if (!preview && m.role === 'user') preview = oneLine(textOf(m.content), 90);
    if (!model && m.role === 'assistant' && m.model) model = m.model;
  }
  return { preview, messages: size > SESSION_PARSE_MAX ? null : messages, model, name };
}

/** /resume only accepts session files inside pi's own session root */
export function isSessionPath(p) {
  if (typeof p !== 'string' || !p) return false;
  try {
    const real = fs.realpathSync(p);
    const root = fs.realpathSync(SESSIONS_ROOT);
    return real.startsWith(`${root}/`) && real.endsWith('.jsonl');
  } catch { return false; }
}

/** pi sessions belonging to `cwd`, newest first (this is what `/resume` shows) */
export function listSessions(cwd, limit = 40) {
  let dirs;
  try { dirs = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const cands = [];
  for (const d of dirs) {
    const dirPath = path.join(SESSIONS_ROOT, d.name);
    let files;
    try { files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dirPath, f);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      cands.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const c of cands) {
    if (out.length >= limit) break;
    const head = readSessionHeader(c.path);
    if (!head || head.cwd !== cwd) continue;
    out.push({
      path: c.path,
      id: head.id ?? null,
      startedAt: head.timestamp ?? null,
      mtimeMs: c.mtimeMs,
      size: c.size,
      ...describeSession(c.path, c.size),
    });
  }
  return out;
}

export { SESSIONS_ROOT, SHELL_BIN };

export class Chat extends EventEmitter {
  constructor({ name, dir, env, resume }) {
    super();
    this.name = name;
    this.dir = dir;
    this.env = env;
    /** undefined = adopt the newest session for this cwd, false = force a new one, string = exact file */
    this.resumeSpec = resume;
    this.fileSizeSeen = 0;
    this.foreignWarned = false;
    this.lastEventAt = Date.now();
    this.idleWatch = null;
    this.items = [];
    this.state = {
      alive: false, streaming: false, model: null, thinkingLevel: null,
      messageCount: 0, sessionName: null, sessionFile: null, statuses: {},
      error: null,
    };
    this.child = null;
    this.buf = '';
    this.cmdSeq = 0;
    this.pending = new Map();
    this.booting = true;
    this.queue = [];
    this.dirty = new Set();
    this.flushTimer = null;
    this.lastSessionPath = null;
    this.ready = Promise.resolve();
    this.panel = null;
    this.panelSig = null;
    this.panelWatchers = 0;
    this.panelTimer = null;
    this.refreshPanel(true);
  }

  /* ---------------------------------------------------------------- panel */

  /**
   * Recompute the goal / subagent projection. Polled while someone watches:
   * pi-goal-x and pi-subagents own their on-disk state, so there is no event
   * to subscribe to over RPC (their widgets are TUI components).
   */
  refreshPanel(force = false) {
    let panel;
    try { panel = readPanel(this.dir); } catch { return; }
    const sig = JSON.stringify(panel.goal) + '|' + JSON.stringify(panel.agents.map((a) => [
      a.runId, a.state, Math.round((a.elapsedMs ?? 0) / 2000),
      a.children.map((c) => `${c.status}:${c.tools ?? 0}:${c.model ?? ''}`).join(','),
    ]));
    if (!force && sig === this.panelSig) return;
    this.panelSig = sig;
    this.panel = panel;
    this.emit('panel', panel);
  }

  watchPanel(on) {
    this.panelWatchers = Math.max(0, this.panelWatchers + (on ? 1 : -1));
    if (this.panelWatchers > 0) {
      if (!this.panelTimer) {
        this.panelTimer = setInterval(() => this.refreshPanel(), PANEL_POLL_MS);
        this.panelTimer.unref?.();
      }
      this.refreshPanel();
    } else if (this.panelTimer) {
      clearInterval(this.panelTimer);
      this.panelTimer = null;
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  start() {
    const args = ['pi', '--mode', 'rpc'];
    // resumeSpec=false must NEVER adopt a live session: two processes appending
    // to the same .jsonl fork the tree and one branch is silently dropped
    const resume = this.lastSessionPath
      || (this.resumeSpec === false ? null : (typeof this.resumeSpec === 'string' ? this.resumeSpec : findLatestSession(this.dir)));
    if (resume) { this.lastSessionPath = resume; args.push('--session', resume); }
    // login shell so PATH / proxy / model config match the real terminal;
    // `exec "$@"` keeps argument boundaries intact (no shell string building)
    this.child = spawn(SHELL_BIN, ['-lic', 'exec "$@"', 'pi-web', ...args], {
      cwd: this.dir,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.state.alive = true;
    this.state.error = null;

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (/error|fatal|not found/i.test(text)) this.notice(text.trim().slice(0, 400), 'error');
    });
    this.child.on('exit', (code, signal) => {
      this.state.alive = false;
      this.state.streaming = false;
      for (const { reject } of this.pending.values()) reject(new Error('pi 进程已退出'));
      this.pending.clear();
      if (code !== 0 && code !== null) this.notice(`pi 进程退出（code ${code}${signal ? `, ${signal}` : ''}）`, 'error');
      this.emit('state', this.publicState());
    });
    this.child.on('error', (err) => {
      this.state.alive = false;
      this.notice(`无法启动 pi: ${err.message}`, 'error');
      this.emit('state', this.publicState());
    });

    // resume/seed the transcript from pi's own session state
    this.ready = this.seedFromSession(30000)
      .catch((err) => this.notice(`读取会话历史失败：${err.message}`, 'error'))
      .finally(() => {
        this.booting = false;
        const q = this.queue; this.queue = [];
        for (const rec of q) this.applyEvent(rec);
        this.emit('items', this.items);
      })
      .then(() => this.refreshState());
    return this;
  }

  /** replace the transcript with the process's current session (after /resume) */
  async seedFromSession(timeoutMs = 60000) {
    const res = await this.send({ type: 'get_messages' }, timeoutMs);
    const messages = res?.data?.messages || [];
    this.items = [];
    this.dirty.clear();
    for (const m of messages) this.ingestMessage(m, { quiet: true });
    this.state.messageCount = messages.length;
    this.emit('items', this.items);
    return messages.length;
  }

  /* ------------------------------------------------- slash-command support */

  /** extension commands, prompt templates and skills (built-in TUI commands are absent) */
  async commands(force = false) {
    if (!force && this._cmds && Date.now() - this._cmdsAt < 60000) return this._cmds;
    const res = await this.send({ type: 'get_commands' }, 20000);
    this._cmds = res?.data?.commands || [];
    this._cmdsAt = Date.now();
    return this._cmds;
  }

  async models() {
    const res = await this.send({ type: 'get_available_models' }, 20000);
    return res?.data?.models || [];
  }

  async setModel(provider, modelId) {
    await this.send({ type: 'set_model', provider, modelId }, 30000);
    await this.refreshState();
  }

  async thinkingLevels() {
    const res = await this.send({ type: 'get_available_thinking_levels' }, 15000);
    return res?.data?.levels || res?.data?.thinkingLevels || [];
  }

  async setThinkingLevel(level) {
    await this.send({ type: 'set_thinking_level', level }, 20000);
    await this.refreshState();
  }

  async compact(instructions) {
    return this.send({ type: 'compact', ...(instructions ? { instructions } : {}) }, 900000);
  }

  async stats() {
    const res = await this.send({ type: 'get_session_stats' }, 20000);
    return res?.data || null;
  }

  async setName(name) {
    await this.send({ type: 'set_session_name', name }, 20000);
    await this.refreshState();
  }

  sessions() {
    return listSessions(this.dir, 80);
  }

  /** /resume: switch the live process to another session file and re-render it */
  async switchSession(sessionPath) {
    if (!isSessionPath(sessionPath)) throw new Error('路径不在 pi 会话目录内');
    let sizeMb = 0;
    try { sizeMb = fs.statSync(sessionPath).size / 1048576; } catch { /* ignore */ }
    let res;
    try {
      res = await this.send({ type: 'switch_session', sessionPath }, 120000);
    } catch (err) {
      // pi stays usable after a stuck switch (verified), it just does not switch
      throw new Error(`切换超时${sizeMb ? `（会话 ${sizeMb.toFixed(1)}M，可能过大）` : ''}；本会话未受影响，可在终端视图用 /resume`);
    }
    if (res?.data?.cancelled) throw new Error('切换被扩展取消');
    this.lastSessionPath = sessionPath;
    this.claimed = null;
    this.foreignWarned = false;
    await this.seedFromSession();
    await this.refreshState();
    this.noteFileSize();
    this.refreshPanel(true);
    return true;
  }

  close() {
    if (this.panelTimer) { clearInterval(this.panelTimer); this.panelTimer = null; }
    if (this.idleWatch) { clearInterval(this.idleWatch); this.idleWatch = null; }
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    const kill = setTimeout(() => { try { this.child.kill('SIGTERM'); } catch {} }, 1200);
    const hard = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 5000);
    this.child.once('exit', () => { clearTimeout(kill); clearTimeout(hard); });
  }

  get alive() { return !!this.child && this.state.alive; }

  /** slash commands pi can expand (extensions, prompt templates, skills) */
  async commands() {
    const now = Date.now();
    if (this.cmdCache && now - this.cmdCache.at < 60000) return this.cmdCache.list;
    const res = await this.send({ type: 'get_commands' }, 20000);
    const list = (res?.data?.commands || []).map((c) => ({
      name: String(c.name),
      description: String(c.description ?? ''),
      source: String(c.source ?? 'extension'),
    }));
    this.cmdCache = { at: now, list };
    return list;
  }

  /**
   * `/resume`: pi keeps session switching inside the TUI, but the RPC server
   * exposes it — so the web UI can pick a session file and keep the same
   * conversation process (no re-spawn, no lost state).
   */
  async switchSession(file) {
    let abs;
    try { abs = fs.realpathSync(String(file)); } catch { throw new Error('会话文件不存在'); }
    if (!abs.startsWith(`${SESSIONS_ROOT}/`) || !abs.endsWith('.jsonl')) throw new Error('非法会话路径');
    const head = readSessionHeader(abs);
    if (!head || head.cwd !== this.dir) throw new Error('该会话不属于当前目录');
    if (abs === this.lastSessionPath) return { switched: false, same: true };

    const res = await this.send({ type: 'switch_session', sessionPath: abs }, 30000);
    if (res?.data?.cancelled) return { switched: false, cancelled: true };

    this.items = [];
    this.dirty.clear();
    this.state.messageCount = 0;
    this.state.sessionName = null;
    this.lastSessionPath = abs;
    this.emit('items', this.items);
    try {
      const m = await this.send({ type: 'get_messages' }, 30000);
      const messages = m?.data?.messages || [];
      for (const msg of messages) this.ingestMessage(msg, { quiet: true });
      this.state.messageCount = messages.length;
    } catch (err) {
      this.notice(`读取会话历史失败：${err.message}`, 'error');
    }
    this.notice(`已切换会话：${path.basename(abs)}`);
    this.emit('items', this.items);
    await this.refreshState();
    this.refreshPanel(true);
    return { switched: true, sessionFile: abs, messages: this.state.messageCount };
  }

  async compact(instructions) {
    const res = await this.send({
      type: 'compact',
      ...(instructions ? { customInstructions: String(instructions) } : {}),
    }, 600000);
    return res?.data ?? null;
  }

  /* ---------------------------------------------------------------- rpc io */

  send(cmd, timeoutMs = 20000) {
    if (!this.child || !this.state.alive) return Promise.reject(new Error('chat 进程未运行'));
    const id = cmd.id || `c${++this.cmdSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('pi 响应超时')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  onStdout(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      this.onRecord(rec);
    }
  }

  onRecord(rec) {
    this.lastEventAt = Date.now();
    if (rec.type === 'response') {
      const p = this.pending.get(rec.id);
      if (p) {
        this.pending.delete(rec.id);
        if (rec.success === false) p.reject(new Error(rec.error || 'command failed'));
        else p.resolve(rec);
      }
      return;
    }
    if (rec.type === 'extension_ui_request') return this.onUiRequest(rec);
    if (rec.type === 'bash_execution_update') return;          // only for direct bash cmd
    if (this.booting) { this.queue.push(rec); return; }
    this.applyEvent(rec);
  }

  /* ------------------------------------------------------------- transcript */

  push(item) {
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.emit('item', item);
    return item;
  }

  bump(item, { immediate = false } = {}) {
    if (!item) return;
    this.dirty.add(item.id);
    if (immediate) return this.flush();
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_MS);
  }

  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    for (const id of this.dirty) {
      const item = this.items.find((i) => i.id === id);
      if (item) this.emit('item', item);
    }
    this.dirty.clear();
  }

  notice(text, level = 'info') {
    if (!text) return;
    this.push({ id: newId('n'), role: 'notice', level, text: clip(text, 2000), ts: Date.now() });
  }

  /** upsert the streaming assistant item */
  currentAssistant() {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (it.role === 'assistant' && it.streaming) return it;
    }
    return null;
  }

  findTool(callId) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const it = this.items[i];
      if (!it.blocks) continue;
      for (const b of it.blocks) if (b.type === 'tool' && b.callId === callId) return b;
    }
    return null;
  }

  applyEvent(rec) {
    switch (rec.type) {
      case 'agent_start':
        this.state.streaming = true;
        this.emit('state', this.publicState());
        break;
      case 'agent_settled':
        this.state.streaming = false;
        if (rec.aborted) this.notice('已中止本轮生成');
        this.emit('state', this.publicState());
        this.refreshState();
        this.refreshPanel();
        this.noteFileSize();
        break;
      case 'message_start': {
        const m = rec.message;
        if (m?.role === 'assistant') {
          const item = { id: newId('a'), role: 'assistant', streaming: true, blocks: [], ts: Date.now(), model: m.model };
          this.push(item);
          this.state.streaming = true;
          this.emit('state', this.publicState());
        }
        break;
      }
      case 'message_update':
        this.applyDelta(rec.assistantMessageEvent);
        break;
      case 'message_end':
        this.ingestMessage(rec.message);
        break;
      case 'tool_execution_start': {
        const tool = this.findTool(rec.toolCallId)
          || this.ensureToolBlock({ callId: rec.toolCallId, name: rec.toolName, args: rec.args });
        if (tool) {
          tool.state = 'running';
          tool.args = rec.args ?? tool.args;
          tool.startedAt = Date.now();
          this.bump(this.ownerOf(tool));
        }
        break;
      }
      case 'tool_execution_update': {
        const tool = this.findTool(rec.toolCallId);
        if (tool) {
          const out = textOf(rec.partialResult?.content);
          if (out) { tool.output = clip(out); this.bump(this.ownerOf(tool)); }
        }
        break;
      }
      case 'tool_execution_end': {
        const tool = this.findTool(rec.toolCallId);
        if (tool) {
          tool.state = rec.isError ? 'error' : 'ok';
          tool.durationMs = rec.durationMs;
          const out = textOf(rec.result?.content);
          if (out) tool.output = clip(out);
          if (rec.result?.details?.diff) tool.diff = clip(rec.result.details.diff, 20000);
          this.bump(this.ownerOf(tool), { immediate: true });
        }
        break;
      }
      case 'turn_end':
        break;
      case 'auto_retry_start':
        this.notice(`重试中（${rec.attempt}/${rec.maxAttempts}）：${rec.errorMessage || ''}`);
        break;
      case 'auto_retry_end':
        if (!rec.success) this.notice(`重试失败：${rec.finalError || ''}`, 'error');
        break;
      case 'compaction_start':
        this.notice(`压缩上下文（${rec.reason}）…`);
        break;
      case 'compaction_end':
        this.notice(rec.aborted ? '压缩被中止' : `上下文已压缩：${rec.result?.tokensBefore ?? '?'} → ${rec.result?.estimatedTokensAfter ?? '?'} tokens`);
        break;
      case 'extension_error':
        this.notice(`扩展错误 ${rec.extensionPath} (${rec.event}): ${rec.error}`, 'error');
        break;
      case 'session_info_changed':
        this.state.sessionName = rec.name || null;
        this.emit('state', this.publicState());
        break;
      case 'thinking_level_changed':
        this.state.thinkingLevel = rec.level;
        this.emit('state', this.publicState());
        break;
      case 'queue_update':
        this.state.queued = (rec.steering?.length || 0) + (rec.followUp?.length || 0);
        this.emit('state', this.publicState());
        break;
      default:
        break;
    }
  }

  ownerOf(block) {
    for (const it of this.items) if (it.blocks && it.blocks.includes(block)) return it;
    return null;
  }

  /** find or create the tool block (creates a standalone assistant item when needed) */
  ensureToolBlock({ callId, name, args }) {
    const existing = this.findTool(callId);
    if (existing) return existing;
    let host = this.currentAssistant();
    if (!host) host = this.push({ id: newId('a'), role: 'assistant', streaming: false, blocks: [], ts: Date.now() });
    const block = { type: 'tool', callId, name, args: args || {}, state: 'pending', output: '' };
    host.blocks.push(block);
    this.bump(host, { immediate: true });
    return block;
  }

  applyDelta(ev) {
    if (!ev) return;
    const item = this.currentAssistant();
    if (!item) return;
    const idx = Number.isInteger(ev.contentIndex) ? ev.contentIndex : 0;
    const ensure = (type) => {
      let b = item.blocks[idx];
      if (!b || b.type !== type) {
        while (item.blocks.length < idx) item.blocks.push({ type: 'text', text: '' });
        b = item.blocks[idx] = type === 'tool'
          ? { type: 'tool', callId: '', name: '', args: {}, state: 'pending', output: '' }
          : { type, text: '' };
      }
      return b;
    };
    switch (ev.type) {
      case 'text_start': ensure('text'); break;
      case 'text_delta': ensure('text').text += ev.delta || ''; this.bump(item); break;
      case 'text_end': ensure('text').text = ev.content ?? ''; this.bump(item, { immediate: true }); break;
      case 'thinking_start': ensure('thinking').streaming = true; this.bump(item); break;
      case 'thinking_delta': ensure('thinking').text += ev.delta || ''; this.bump(item); break;
      case 'thinking_end': {
        const b = ensure('thinking');
        b.text = ev.content ?? b.text;
        b.streaming = false;
        this.bump(item, { immediate: true });
        break;
      }
      case 'toolcall_start': {
        const b = ensure('tool');
        b.callId = ev.id;
        b.name = ev.toolName;
        this.bump(item, { immediate: true });
        break;
      }
      case 'toolcall_delta': break;
      case 'toolcall_end': {
        const b = ensure('tool');
        b.callId = ev.toolCall?.id || b.callId;
        b.name = ev.toolCall?.name || b.name;
        b.args = ev.toolCall?.arguments || b.args;
        this.bump(item, { immediate: true });
        break;
      }
      default: break;
    }
  }

  /** authoritative message (history seed, message_end, toolResult) */
  ingestMessage(msg, { quiet = false } = {}) {
    if (!msg || !msg.role) return;
    if (msg.role === 'user') {
      if (quiet) this.push({ id: newId('u'), role: 'user', text: clip(textOf(msg.content), 20000), ts: msg.timestamp || Date.now() });
      else this.push({ id: newId('u'), role: 'user', text: clip(textOf(msg.content), 20000), ts: msg.timestamp || Date.now() });
      return;
    }
    if (msg.role === 'assistant') {
      let item = quiet ? null : this.currentAssistant();
      if (!item) item = { id: newId('a'), role: 'assistant', blocks: [], ts: msg.timestamp || Date.now() };
      item.blocks = (msg.content || []).map((b) => {
        if (b.type === 'text') return { type: 'text', text: clip(b.text, 40000) };
        if (b.type === 'thinking') return { type: 'thinking', text: clip(b.thinking, 40000), redacted: !!b.redacted };
        if (b.type === 'toolCall') {
          const prev = this.findTool(b.id);
          return {
            type: 'tool', callId: b.id, name: b.name, args: b.arguments || {},
            state: prev?.state === 'pending' ? 'running' : (prev?.state || 'pending'),
            output: prev?.output || '', diff: prev?.diff, durationMs: prev?.durationMs,
          };
        }
        return { type: 'text', text: '' };
      }).filter(Boolean);
      item.streaming = false;
      item.model = msg.model || item.model;
      item.stopReason = msg.stopReason;
      item.usage = msg.usage || null;
      item.error = msg.stopReason === 'error' ? (msg.errorMessage || '模型调用失败') : null;
      if (quiet) this.push(item);
      else this.bump(item, { immediate: true });
      if (item.error) this.notice(item.error, 'error');
      return;
    }
    if (msg.role === 'toolResult') {
      const tool = this.findTool(msg.toolCallId) || this.ensureToolBlock({ callId: msg.toolCallId, name: msg.toolName, args: {} });
      if (tool) {
        tool.name = tool.name || msg.toolName;
        tool.state = msg.isError ? 'error' : 'ok';
        const out = textOf(msg.content);
        if (out) tool.output = clip(out);
        if (msg.details?.diff) tool.diff = clip(msg.details.diff, 20000);
        this.bump(this.ownerOf(tool), { immediate: true });
      }
      return;
    }
    if (msg.role === 'bashExecution') {
      this.push({
        id: newId('b'), role: 'bash', ts: msg.timestamp || Date.now(),
        command: msg.command, output: clip(msg.output || ''),
        exitCode: msg.exitCode, cancelled: msg.cancelled, truncated: msg.truncated,
      });
      return;
    }
    if (msg.role === 'compactionSummary') {
      this.notice(`上下文已压缩（${msg.tokensBefore ?? '?'} tokens）：${clip(msg.summary, 400)}`);
      return;
    }
    if (msg.role === 'branchSummary') {
      this.notice(`分支摘要：${clip(msg.summary, 400)}`);
      return;
    }
    if (msg.role === 'custom') {
      if (msg.display) this.push({ id: newId('n'), role: 'notice', level: 'info', text: clip(textOf(msg.content), 2000), ts: Date.now() });
    }
  }

  /* --------------------------------------------------------------- ui/state */

  onUiRequest(req) {
    const FIRE_AND_FORGET = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
    if (FIRE_AND_FORGET.has(req.method)) {
      if (req.method === 'setStatus') {
        this.state.statuses = { ...this.state.statuses, [req.statusKey]: req.statusText };
      } else if (req.method === 'setWidget' && req.widgetKey === 'goal') {
        this.state.statuses = { ...this.state.statuses, goal: req.widgetLines ? req.widgetLines.join('\n') : '' };
      } else if (req.method === 'notify') {
        this.notice(req.message || '', 'info');
      }
      this.emit('state', this.publicState());
      return;
    }
    // dialog: needs an explicit answer, otherwise the agent stays blocked
    const item = {
      id: newId('d'), role: 'dialog', reqId: req.id, method: req.method,
      title: req.title || '', message: req.message || '',
      options: req.options || [], placeholder: req.placeholder || '',
      defaultValue: req.defaultValue, prefill: req.prefill ?? null, timeoutMs: req.timeout ?? null,
      resolved: false, ts: Date.now(),
    };
    this.push(item);
  }

  answerDialog(reqId, payload) {
    if (!this.child || !this.state.alive) return;
    const item = this.items.find((i) => i.role === 'dialog' && i.reqId === reqId);
    if (item) {
      item.resolved = true;
      item.answer = payload.cancelled ? '已取消' : (payload.value ?? (payload.confirmed ? '是' : '否'));
      this.bump(item, { immediate: true });
    }
    try { this.child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: reqId, ...payload })}\n`); } catch {}
  }

  publicState() {
    return {
      name: this.name, dir: this.dir, ...this.state,
      statusLine: Object.entries(this.state.statuses || {})
        .filter(([k, v]) => v && k !== 'goal')
        .map(([, v]) => v).join(' · '),
    };
  }

  async refreshState() {
    try {
      const res = await this.send({ type: 'get_state' }, 15000);
      const d = res?.data || {};
      this.state.model = d.model ? { id: d.model.id, name: d.model.name, provider: d.model.provider, contextWindow: d.model.contextWindow } : this.state.model;
      this.state.thinkingLevel = d.thinkingLevel ?? this.state.thinkingLevel;
      this.state.messageCount = d.messageCount ?? this.state.messageCount;
      this.state.sessionName = d.sessionName ?? null;
      this.state.sessionFile = d.sessionFile ?? null;
      if (d.sessionFile) this.lastSessionPath = d.sessionFile;
      this.state.streaming = !!d.isStreaming;
      this.state.compacting = !!d.isCompacting;
      if (d.sessionFile && d.sessionFile !== this.claimed) {
        this.claimed = d.sessionFile;
        this.emit('session', d.sessionFile);
      }
      if (d.sessionFile && !this.state.streaming) this.noteFileSize(d.sessionFile);
    } catch { /* process may be gone */ }
    this.emit('state', this.publicState());
  }

  /* -------------------------------------------------- external writer guard */

  /** remember how big our own session file is right now (we are the last writer) */
  noteFileSize(file = this.state.sessionFile) {
    if (!file) return;
    try { this.fileSizeSeen = fs.statSync(file).size; } catch { /* not written yet */ }
  }

  /**
   * Two pi processes on one session file fork the JSONL tree and the losing
   * branch disappears from the active context. pi has no session lock, so we
   * look for foreign appends conservatively: only *message* entries, only while
   * this chat has been idle for a minute, and only when two checks in a row see
   * growth. That keeps pi's own late bookkeeping entries (usage/cache_warm)
   * from raising a false alarm.
   */
  startForeignWatch() {
    if (this.idleWatch) return;
    let suspects = 0;
    this.idleWatch = setInterval(() => {
      const file = this.state.sessionFile;
      if (!file || !this.state.alive) return;
      if (this.state.streaming || this.booting || Date.now() - this.lastEventAt < 60000) { suspects = 0; return; }
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return; }
      if (size <= this.fileSizeSeen + 32) {
        suspects = 0;
        if (size < this.fileSizeSeen) this.fileSizeSeen = size;
        return;
      }
      // only count real conversation entries in the appended bytes
      let foreignMessages = 0;
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const len = Math.min(size - this.fileSizeSeen, 1024 * 1024);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, this.fileSizeSeen);
          foreignMessages = (buf.toString('utf8').match(/"type"\s*:\s*"message"/g) || []).length;
        } finally { fs.closeSync(fd); }
      } catch { return; }
      if (foreignMessages === 0) { suspects = 0; return; }
      suspects += 1;
      if (suspects >= 2 && !this.foreignWarned) {
        this.foreignWarned = true;
        this.notice(`另一进程也在写这个会话（${path.basename(file)}）：继续会在 JSONL 里分叉，另一支会被丢弃。`, 'error');
        this.emit('foreign', file);
      }
    }, 15000);
    this.idleWatch.unref?.();
  }

  /* ------------------------------------------------------------- commands */

  async prompt(text) {
    const res = await this.send({ type: 'prompt', message: text }, 60000);
    return res?.data?.disposition || 'started';
  }

  async abort() { await this.send({ type: 'abort' }, 30000); }

  async newSession() {
    const res = await this.send({ type: 'new_session' }, 30000);
    this.items = [];
    this.emit('items', this.items);
    await this.refreshState();
    return res?.data?.cancelled ? '已取消' : '新对话已开始';
  }

  async cycleModel() {
    const res = await this.send({ type: 'cycle_model' }, 20000);
    await this.refreshState();
    return res?.data?.model?.name || null;
  }

  async cycleThinking() {
    const res = await this.send({ type: 'cycle_thinking_level' }, 20000);
    await this.refreshState();
    return res?.data?.level || null;
  }
}
