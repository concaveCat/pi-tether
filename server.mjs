#!/usr/bin/env node
/**
 * pi-web — mobile-friendly web front-end for the `pi` coding agent on this WSL box.
 *
 *  - file browser limited to PIWEB_ROOT (defaults to $HOME, realpath-checked)
 *  - persistent per-directory `pi` sessions inside tmux (survive disconnects)
 *  - real PTY (node-pty) + tmux attach over WebSocket => full TUI fidelity
 *
 * Env: HOST (127.0.0.1)  PORT (8765)  WEB_PASS (required)  WEB_SECRET (optional, cookie signing key)
 */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { Chat, findLatestSession, SESSIONS_ROOT, SHELL_BIN } from './chat.mjs';

// node-pty is a native module: if it cannot be built/loaded the chat still works,
// only the terminal view is unavailable (PIWEB_NO_PTY=1 forces that state).
let pty = null;
if (process.env.PIWEB_NO_PTY !== '1') {
  try { pty = (await import('node-pty')).default; } catch (err) {
    console.error(`[pi-web] WARN: node-pty 不可用（${err.code || err.message}），终端视图已禁用；` +
      ' 其余功能正常。装构建工具后 npm rebuild node-pty 即可恢复。');
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST_SPEC = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8765);
const WEB_PASS = process.env.WEB_PASS || '';
/** sandbox root: PIWEB_ROOT, else the invoking user's home */
const ROOT = (() => {
  const wanted = process.env.PIWEB_ROOT || os.homedir();
  try { return fs.realpathSync(wanted); } catch {
    console.error(`[pi-web] FATAL: PIWEB_ROOT 不存在: ${wanted}`);
    process.exit(1);
  }
})();
const TLS_CERT = process.env.PIWEB_TLS_CERT || '';
const TLS_KEY = process.env.PIWEB_TLS_KEY || '';
const USE_TLS = !!(TLS_CERT && TLS_KEY);
const MAX_PREVIEW = 200 * 1024;          // 200 KB text preview cap
const SESSION_RE = /^pi-[a-zA-Z0-9_-]+$/;
const CHAT_RE = /^chat-[a-zA-Z0-9_-]+$/;
const SESSION_PREFIX = 'pi-';
const COOKIE = 'piweb';
const MAX_AGE_S = 30 * 24 * 3600;

if (!WEB_PASS) {
  console.error('[pi-web] FATAL: WEB_PASS is not set. Refusing to start an unauthenticated shell service.');
  console.error('         export WEB_PASS="<your password>" && node server.mjs');
  process.exit(1);
}
if (WEB_PASS.length < 6) console.warn('[pi-web] WARNING: WEB_PASS is shorter than 6 chars — pick something stronger.');

const SECRET = process.env.WEB_SECRET || crypto.randomBytes(32).toString('hex');

// tmux config used for servers pi-web starts (xterm-256color + extended keys)
const TMUX_CONF = path.join(__dirname, 'tmux.conf');
fs.writeFileSync(TMUX_CONF, [
  '# written by pi-web/server.mjs — used via `tmux -f`',
  'set -g default-terminal "xterm-256color"',
  'set -g extended-keys on',
  'set -as terminal-features "xterm*:extkeys"',
  '',
].join('\n'));
if (!process.env.WEB_SECRET) {
  console.warn('[pi-web] note: WEB_SECRET unset -> random per-process cookie key (restart logs you out).');
}

/* ------------------------------------------------------------------ helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Base env for anything we spawn: keep the operator's environment (PATH, proxy, keys). */
const BASE_ENV = { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' };
delete BASE_ENV.WEB_PASS;
delete BASE_ENV.WEB_SECRET;

/** Resolve a caller-supplied relative path inside ROOT, defeating `..` and symlink escapes. */
function sandbox(input) {
  const raw = typeof input === 'string' ? input : '';
  let rel = raw.trim();
  if (rel.startsWith('/')) {
    // absolute paths are only honored inside the sandbox (/root itself or below)
    if (rel === ROOT) rel = '';
    else if (rel.startsWith(ROOT + '/')) rel = rel.slice(ROOT.length + 1);
    else throw new HttpError(400, 'outside sandbox');
  }
  if (rel.split(/[\\/]+/).some((seg) => seg === '..')) throw new HttpError(400, 'path traversal rejected');
  if (rel.includes('\0')) throw new HttpError(400, 'invalid path');

  const abs = path.resolve(ROOT, rel || '.');
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new HttpError(400, 'outside sandbox');

  let real;
  try {
    real = fs.realpathSync(abs);                               // resolves symlinks
  } catch (err) {
    if (err.code === 'ENOENT') throw new HttpError(404, 'not found');
    if (err.code === 'EACCES') throw new HttpError(403, 'permission denied');
    if (err.code === 'ELOOP') throw new HttpError(400, 'symlink loop');
    throw new HttpError(400, err.code || 'bad path');
  }
  // 403 when a symlink leads out of /root even though the lexical path looked fine
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new HttpError(403, 'resolved outside sandbox');
  return real;
}

const relOf = (abs) => (abs === ROOT ? '' : path.relative(ROOT, abs).split(path.sep).join('/'));

function tmux(args, opts = {}) {
  return execFileSync('tmux', ['-f', TMUX_CONF, ...args], {
    encoding: 'utf8',
    env: BASE_ENV,
    timeout: opts.timeout ?? 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tmuxList() {
  let out;
  try {
    out = tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}']);
  } catch (err) {
    const msg = `${err.stderr || ''}${err.message || ''}`;
    if (/no server running|error connecting|No such file or directory/i.test(msg)) return [];
    throw err;
  }
  const rows = out.split('\n').filter(Boolean).map((line) => {
    const [name, created, attached, windows] = line.split('\t');
    return { name, created: Number(created) * 1000, attached: Number(attached) > 0, windows: Number(windows) };
  }).filter((s) => s.name.startsWith(SESSION_PREFIX) && SESSION_RE.test(s.name));

  // working directory / foreground command = first pane of each session
  try {
    const panes = tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_index}\t#{pane_current_path}\t#{pane_current_command}']);
    for (const line of panes.split('\n')) {
      if (!line) continue;
      const [sname, idx, cwd, cmd] = line.split('\t');
      const rec = rows.find((r) => r.name === sname);
      if (rec && Number(idx) === 0) { rec.path = relOf(cwd || ''); rec.absPath = cwd; rec.command = cmd; }
    }
  } catch { /* ignore */ }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

const sessionExists = (name) => tmuxList().some((s) => s.name === name);

function sessionNameFor(dirAbs) {
  const slug = relOf(dirAbs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha256').update(dirAbs).digest('hex').slice(0, 6);
  return `pi-${slug ? slug + '-' : ''}${hash}`;
}

/** Launch tmux + login shell + pi. pi exit keeps an interactive shell (window not destroyed). */
function createSession(name, dirAbs) {
  // tmux only reads -f when it starts the server, so keep the config on disk and
  // also (re)apply the options afterwards for servers that predate us.
  for (const opt of [
    ['set-option', '-g', 'default-terminal', 'xterm-256color'],
    ['set-option', '-g', 'extended-keys', 'on'],
    ['set-option', '-s', 'extended-keys', 'on'],
    ['set-option', '-as', 'terminal-features', 'xterm*:extkeys'],
  ]) {
    try { tmux(opt); } catch { /* older tmux: ignore */ }
  }
  tmux([
    'new-session', '-d', '-s', name, '-c', dirAbs,
    '-e', `PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    '-e', 'TERM=xterm-256color',
    SHELL_BIN, '-lic', `pi; exec ${SHELL_BIN} -i`,
  ], { timeout: 20000 });
  // apply again now that the server surely exists (no-op for a fresh server that
  // already loaded TMUX_CONF)
  try { tmux(['set-option', '-g', 'extended-keys', 'on']); } catch {}
  if (!sessionExists(name)) throw new HttpError(500, 'tmux session did not come up');
}

/* -------------------------------------------------------------------- auth */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function makeToken() {
  const exp = Date.now() + MAX_AGE_S * 1000;
  const payload = b64u(JSON.stringify({ exp, n: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${sign(payload)}`;
}

function tokenValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const want = sign(payload);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now(); } catch { return false; }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const passOk = (given) => {
  if (typeof given !== 'string' || given.length !== WEB_PASS.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(WEB_PASS));
};

/** Auth check shared by HTTP and the WebSocket upgrade. */
function isAuthed(req) {
  if (tokenValid(parseCookies(req.headers.cookie)[COOKIE])) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const dec = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i >= 0 && passOk(dec.slice(i + 1))) return true;
  }
  return false;
}

// crude brute-force brake
const fails = new Map();
function noteFail(ip) {
  const now = Date.now();
  const rec = fails.get(ip) || { n: 0, t: now };
  if (now - rec.t > 5 * 60_000) { rec.n = 0; rec.t = now; }
  rec.n += 1; fails.set(ip, rec);
  return rec.n;
}
function throttled(ip) {
  const rec = fails.get(ip);
  return rec && Date.now() - rec.t < 5 * 60_000 && rec.n >= 12;
}

/* ------------------------------------------------------------------ server */

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.json({ limit: '24mb' }));   // 附件走 WS，这里给浏览器重发/粘贴留余量

const noCache = (res, extra = {}) => res.set({ 'Cache-Control': 'no-store', ...extra });

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect('/');
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

app.post('/login', (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  if (throttled(ip)) return res.status(429).type('html').send('<p>Too many attempts. Wait 5 minutes.</p>');
  const pwd = req.body?.password;
  if (!passOk(String(pwd ?? ''))) {
    noteFail(ip);
    return res.status(401).type('html').send(LOGIN_HTML.replace('id="err" hidden', 'id="err"'));
  }
  fails.delete(ip);
  res.cookie(COOKIE, makeToken(), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE_S * 1000,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
  res.redirect('/');
});

app.get('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });

// ---- gate everything below ----
// PWA 图标与 manifest 免鉴权：加到主屏时系统抓图不带 cookie
const PUBLIC_DIR = path.join(__dirname, 'public');
for (const f of ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png', '/favicon.ico']) {
  app.get(f, (req, res) => res.sendFile(path.join(PUBLIC_DIR, f.replace(/^\//, '')), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  }));
}
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    noCache(res, { 'WWW-Authenticate': 'Basic realm="pi-web", charset="UTF-8"' });
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.redirect('/login');
});

// locally hosted xterm assets (no CDN)
const NODE_MODULES = path.join(__dirname, 'node_modules');
const vendor = (url, file, type) =>
  app.get(url, (req, res) => res.type(type).set('Cache-Control', 'public, max-age=86400').sendFile(path.join(NODE_MODULES, file)));
vendor('/vendor/xterm.js', '@xterm/xterm/lib/xterm.js', 'application/javascript');
vendor('/vendor/xterm.css', '@xterm/xterm/css/xterm.css', 'text/css');
vendor('/vendor/addon-fit.js', '@xterm/addon-fit/lib/addon-fit.js', 'application/javascript');

app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: false }));

/* -------------------------------------------------------------- file APIs */

app.get('/api/me', (req, res) => res.json({
  ok: true, root: ROOT, sessionsRoot: SESSIONS_ROOT, shell: SHELL_BIN,
  pty: !!pty, tls: USE_TLS, node: process.version, port: PORT,
}));

app.get('/api/files', async (req, res, next) => {
  try {
    const dir = sandbox(req.query.path);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new HttpError(400, 'not a directory');

    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      let s;
      try { s = await fsp.lstat(abs); } catch { continue; }
      let type = ent.isDirectory() ? 'dir' : 'file';
      if (ent.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(abs);
          const inside = real === ROOT || real.startsWith(ROOT + path.sep);
          const rst = await fsp.stat(real);
          type = inside ? (rst.isDirectory() ? 'dir' : 'file') : 'link-out';
        } catch { type = 'broken'; }
      }
      items.push({
        name: ent.name,
        type,
        size: type === 'dir' ? 0 : s.size,
        mtime: Math.round(s.mtimeMs),
        path: relOf(path.join(dir, ent.name)),
        symlink: ent.isSymbolicLink(),
      });
    }
    items.sort((a, b) => {
      const ad = a.type === 'dir' ? 0 : 1, bd = b.type === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    res.json({ path: relOf(dir), absPath: dir, parent: dir === ROOT ? null : relOf(path.dirname(dir)), entries: items });
  } catch (err) { next(err); }
});

app.get('/api/file', async (req, res, next) => {
  try {
    const file = sandbox(req.query.path);
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new HttpError(400, 'not a regular file');

    const readBytes = Math.min(st.size, MAX_PREVIEW);
    const fh = await fsp.open(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(readBytes);
      await fh.read(buf, 0, readBytes, 0);
    } finally { await fh.close(); }

    const probe = buf.subarray(0, 8192);
    if (probe.includes(0)) throw new HttpError(415, 'binary file — preview disabled');

    res.json({
      path: relOf(file),
      name: path.basename(file),
      size: st.size,
      mtime: Math.round(st.mtimeMs),
      truncated: st.size > MAX_PREVIEW,
      content: buf.toString('utf8'),
    });
  } catch (err) { next(err); }
});

/* ----------------------------------------------------------- session APIs */

app.get('/api/sessions', (req, res, next) => {
  try {
    const sessions = tmuxList().map((s) => ({
      name: s.name,
      path: s.path ?? null,
      absPath: s.absPath ?? null,
      command: s.command ?? null,
      attached: s.attached,
      created: s.created,
      windows: s.windows,
    }));
    res.json({ sessions });
  } catch (err) { next(err); }
});

app.post('/api/launch', (req, res, next) => {
  try {
    const dir = sandbox(req.body?.path);
    if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'not a directory');
    const forceNew = req.body?.forceNew === true;

    let name = sessionNameFor(dir);
    const existed = sessionExists(name);
    if (existed && !forceNew) {
      return res.json({ name, path: relOf(dir), created: false, reused: true });
    }
    if (existed && forceNew) {
      name = `${name}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 60);
    }
    createSession(name, dir);
    res.json({ name, path: relOf(dir), absPath: dir, created: true, reused: false });
  } catch (err) { next(err); }
});

app.delete('/api/sessions/:name', (req, res, next) => {
  try {
    const name = String(req.params.name || '');
    if (!SESSION_RE.test(name)) throw new HttpError(400, 'invalid session name');
    if (!sessionExists(name)) throw new HttpError(404, 'no such session');
    tmux(['kill-session', '-t', name]);        // exact name verified above; no shell involved
    res.json({ ok: true, killed: name });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- chat APIs */

const chats = new Map();                 // name -> Chat (one long-lived pi --mode rpc per chat)

/** attachment guard: base64 images only, bounded count/size */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_COUNT = 6;

function normalizeImages(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input.slice(0, IMAGE_MAX_COUNT)) {
    if (!raw || typeof raw !== 'object') continue;
    const mimeType = String(raw.mimeType || '').toLowerCase();
    if (!IMAGE_MIME.has(mimeType)) continue;
    let data = String(raw.data || '');
    if (data.startsWith('data:')) data = data.slice(data.indexOf(',') + 1);
    if (!data || data.length > IMAGE_MAX_BYTES * 1.4) continue;   // base64 is ~1.33x
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) continue;
    out.push({ type: 'image', data: data.replace(/\s+/g, ''), mimeType });
  }
  return out;
}

/**
 * Session-file ownership. pi itself takes no lock on a session .jsonl, so two
 * live `pi --mode rpc` processes on the same file append two parentId chains:
 * whichever writes last becomes the leaf and the other branch is dropped from
 * context. We therefore enforce "one live process per session file" here.
 */
const sessionOwners = new Map();         // realpath(session.jsonl) -> chat name

/**
 * Canonical key for a session path. pi reports the *planned* session file in
 * get_state before the .jsonl exists, so realpath alone would fail and the
 * claim would be silently skipped; resolve the parent directory instead.
 */
const canonSessionPath = (p) => {
  if (typeof p !== 'string' || !p) return null;
  try { return fs.realpathSync(p); } catch { /* not written yet */ }
  const dir = path.dirname(p);
  const base = path.basename(p);
  try { return path.join(fs.realpathSync(dir), base); } catch { return path.resolve(p); }
};
const realOrNull = canonSessionPath;
const OWN_DEBUG = process.env.PIWEB_DEBUG === '1';
const ownLog = (...a) => { if (OWN_DEBUG) console.log('[own]', ...a); };
const ownerOf = (p) => {
  const real = realOrNull(p);
  if (!real) return null;
  const name = sessionOwners.get(real);
  if (!name) return null;
  const chat = chats.get(name);
  if (!chat || !chat.alive) { sessionOwners.delete(real); return null; }
  return name;
};
const claimSession = (chat, file) => {
  const real = realOrNull(file);
  if (!real) { ownLog(`claim ${chat.name}: 无法规范化 ${file}`); return true; }
  const owner = ownerOf(real);
  if (owner && owner !== chat.name) { ownLog(`claim ${chat.name} 被拒：${real.split('/').pop()} 属于 ${owner}`); return false; }
  sessionOwners.set(real, chat.name);
  chat.claimedReal = real;
  ownLog(`claim ${chat.name} ← ${real.split('/').pop()}`);
  return true;
};
const releaseChat = (name) => {
  for (const [real, owner] of [...sessionOwners]) {
    if (owner !== name) continue;
    sessionOwners.delete(real);
    ownLog(`release ${name} → ${real.split('/').pop()}`);
  }
};

const chatNameFor = (dirAbs) => {
  const slug = relOf(dirAbs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha256').update(dirAbs).digest('hex').slice(0, 6);
  return `chat-${slug ? slug + '-' : ''}${hash}`;
};

function spawnChat(name, dirAbs, opts = {}) {
  // claim the file we are about to adopt, before spawning (closes the race)
  if (opts.resumePath) {
    const owner = ownerOf(opts.resumePath);
    if (owner && owner !== name) {
      const err = new HttpError(409, `该会话正在「${owner}」里使用`);
      err.owner = owner;
      throw err;
    }
  }
  const chat = new Chat({ name, dir: dirAbs, env: BASE_ENV, resume: opts.resume });
  chat.scopeCount = 0;
  chat.lastSeen = Date.now();
  chats.set(name, chat);

  if (opts.resumePath) claimSession(chat, opts.resumePath);
  chat.on('session', (file) => {
    if (!claimSession(chat, file)) {
      const owner = ownerOf(file);
      chat.notice(`会话文件已被「${owner}」占用，本窗口不能再写它（两个进程写同一个 .jsonl 会分叉）。请改用那个窗口。`, 'error');
      return;
    }
    chat.startForeignWatch();
  });
  chat.on('foreign', (file) => {
    console.warn(`[pi-web] foreign writer on ${file} while ${name} is idle`);
  });
  chat.start();
  return chat;
}

const chatMeta = (chat) => ({
  name: chat.name, path: relOf(chat.dir), absPath: chat.dir,
  alive: chat.alive, streaming: chat.state.streaming, model: chat.state.model,
  thinkingLevel: chat.state.thinkingLevel, messageCount: chat.state.messageCount,
  sessionName: chat.state.sessionName, statusLine: chat.publicState().statusLine,
  items: chat.items.length,
});

app.get('/api/chats', (req, res) => {
  res.json({ chats: [...chats.values()].map(chatMeta) });
});

app.post('/api/chats', async (req, res, next) => {
  try {
    const dir = sandbox(req.body?.path);
    if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'not a directory');
    const forceNew = req.body?.forceNew === true;

    const base = chatNameFor(dir);

    // reuse the live chat for this directory: several browser windows then share
    // ONE pi process, which is the only arrangement that stays in sync
    if (!forceNew) {
      const live = chats.get(base);
      if (live && live.alive) {
        await Promise.race([live.ready, new Promise((r) => setTimeout(r, 6000))]);
        return res.json({ ...chatMeta(live), created: false, reused: true, joined: true, resume: true });
      }
    }

    let name = base;
    let resumeSpec;
    if (forceNew) {
      // 新对话 = 新会话文件；绝不沿用别人正在写的那个
      if (chats.has(name)) name = `${name}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 60);
      resumeSpec = false;
    } else {
      const latest = findLatestSession(dir);
      const owner = latest ? ownerOf(latest) : null;
      if (owner) {
        // the newest session is being written by another chat: don't fork it
        const other = chats.get(owner);
        if (other && other.alive) {
          await Promise.race([other.ready, new Promise((r) => setTimeout(r, 6000))]);
          return res.json({ ...chatMeta(other), created: false, reused: true, joined: true, resume: true });
        }
      }
      resumeSpec = latest || false;
    }

    let chat = chats.get(name);
    if (chat && !chat.alive) { releaseChat(name); chats.delete(name); chat = null; }
    const created = !chat;
    if (!chat) chat = spawnChat(name, dir, { resume: resumeSpec, resumePath: typeof resumeSpec === 'string' ? resumeSpec : null });
    const resumeAvailable = !!chat.state.sessionFile;
    // give the child a moment to report model / thinking level / history
    await Promise.race([chat.ready, new Promise((r) => setTimeout(r, 6000))]);
    res.json({ ...chatMeta(chat), created, reused: !created, resume: resumeAvailable });
  } catch (err) { next(err); }
});

app.delete('/api/chats/:name', (req, res, next) => {
  try {
    const name = String(req.params.name || '');
    if (!CHAT_RE.test(name)) throw new HttpError(400, 'invalid chat name');
    const chat = chats.get(name);
    if (!chat) throw new HttpError(404, 'no such chat');
    chat.close();
    releaseChat(name);
    chats.delete(name);
    res.json({ ok: true, closed: name });
  } catch (err) { next(err); }
});

// close chats that nobody watches and that are idle for a long while
setInterval(() => {
  const now = Date.now();
  for (const [name, chat] of chats) {
    if (chat.state.streaming || chat.scopeCount > 0) { chat.lastSeen = now; continue; }
    if (!chat.lastSeen) chat.lastSeen = now;
    if (now - chat.lastSeen > 30 * 60_000) {
      console.log(`[pi-web] closing idle chat ${name}`);
      chat.close();
      releaseChat(name);
      chats.delete(name);
    }
  }
}, 5 * 60_000).unref();

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));


// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error('[pi-web]', err);
  if (res.headersSent) return res.end();
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message || 'error' });
  res.status(status).type('text').send(`${status} ${err.message || 'error'}`);
});

/* ------------------------------------------------------------------- ws */

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssChat = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 12 * 1024 * 1024 });

/** Reject a WebSocket upgrade with a well-formed, immediately-closed HTTP response. */
function rejectUpgrade(socket, code, reason) {
  try {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.end();
  } catch { socket.destroy(); }
}

function onUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const isChat = url.pathname === '/ws/chat';
  if (!isChat && url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
  if (!isAuthed(req)) return rejectUpgrade(socket, 401, 'Unauthorized');

  if (isChat) {
    const name = url.searchParams.get('chat') || '';
    if (!CHAT_RE.test(name)) return rejectUpgrade(socket, 400, 'Bad Request');
    const chat = chats.get(name);
    if (!chat || !chat.alive) return rejectUpgrade(socket, 404, 'Not Found');
    return wssChat.handleUpgrade(req, socket, head, (ws) => wssChat.emit('connection', ws, req, chat));
  }

  if (!pty) return rejectUpgrade(socket, 501, 'Terminal disabled: node-pty unavailable (chat still works)');

  const session = url.searchParams.get('session') || '';
  if (!SESSION_RE.test(session)) return rejectUpgrade(socket, 400, 'Bad Request');
  let alive = false;
  try { alive = sessionExists(session); } catch { alive = false; }
  if (!alive) return rejectUpgrade(socket, 404, 'Not Found');

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url));
}

/* --------------------------------------------------------- ws: chat stream */

wssChat.on('connection', (ws, req, chat) => {
  chat.scopeCount = (chat.scopeCount || 0) + 1;
  chat.lastSeen = Date.now();
  const send = (obj) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* client gone */ }
  };
  const onItem = (item) => send({ t: 'item', item });
  const onItems = (items) => send({ t: 'items', items });
  const onState = (state) => send({ t: 'state', state });
  const onPanel = (panel) => send({ t: 'panel', panel });
  chat.on('item', onItem);
  chat.on('items', onItems);
  chat.on('state', onState);
  chat.on('panel', onPanel);
  chat.watchPanel(true);

  send({ t: 'items', items: chat.items });
  send({ t: 'state', state: chat.publicState() });
  if (chat.panel) send({ t: 'panel', panel: chat.panel });

  const stopPing = setInterval(() => {
    if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch {} }
  }, 30000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const ack = (ok, extra = {}) => send({ t: 'ack', ok, ...extra });
    try {
      switch (msg.t) {
        case 'prompt': {
          const text = String(msg.text || '').slice(0, 200000);
          const images = normalizeImages(msg.images);
          if (!text.trim() && !images.length) return ack(false, { error: 'empty' });
          const disposition = await chat.prompt(text, images);
          return ack(true, { disposition });
        }
        case 'abort':
          await chat.abort();
          return ack(true);
        case 'new_session':
          await chat.newSession();
          return ack(true);
        case 'cycle_model': {
          const name = await chat.cycleModel();
          return ack(true, { model: name });
        }
        case 'cycle_thinking': {
          const level = await chat.cycleThinking();
          return ack(true, { thinkingLevel: level });
        }
        case 'refresh':
          await chat.refreshState();
          chat.refreshPanel(true);
          send({ t: 'items', items: chat.items });
          return ack(true);
        case 'ui_response':
          chat.answerDialog(String(msg.id || ''), msg.payload || { cancelled: true });
          return ack(true);
        /* ---- slash commands: discovery ---------------------------------- */
        case 'commands': {
          const commands = await chat.commands(msg.refresh === true);
          return send({ t: 'commands', commands });
        }
        case 'models': {
          const models = await chat.models();
          if (msg.query) {
            const q = String(msg.query).toLowerCase();
            const hits = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(q));
            if (hits.length === 1) {
              await chat.setModel(hits[0].provider, hits[0].id);
              return ack(true, { model: chat.state.model });
            }
            return send({ t: 'models', models: hits.length ? hits : models, current: chat.state.model });
          }
          return send({ t: 'models', models, current: chat.state.model });
        }
        case 'thinking_levels': {
          const levels = await chat.thinkingLevels();
          return send({ t: 'thinking_levels', levels, current: chat.state.thinkingLevel });
        }
        /* ---- slash commands: actions ------------------------------------ */
        case 'set_model': {
          const provider = String(msg.provider || '');
          const modelId = String(msg.modelId || '');
          if (!provider || !modelId) return ack(false, { error: 'provider/modelId 必填' });
          await chat.setModel(provider, modelId);
          return ack(true, { model: chat.state.model });
        }
        case 'set_thinking': {
          const level = String(msg.level || '');
          if (!level) return ack(false, { error: 'level 必填' });
          await chat.setThinkingLevel(level);
          return ack(true, { thinkingLevel: chat.state.thinkingLevel });
        }
        case 'compact': {
          const instructions = typeof msg.instructions === 'string' ? msg.instructions.slice(0, 4000) : '';
          const res = await chat.compact(instructions || undefined);
          return ack(true, { compacted: !!res?.success });
        }
        case 'session_info': {
          const stats = await chat.stats();
          return send({ t: 'session_info', stats, file: chat.state.sessionFile });
        }
        case 'set_name': {
          await chat.setName(String(msg.name || '').slice(0, 120));
          return ack(true, { name: chat.state.sessionName });
        }
        /* ---- /resume ---------------------------------------------------- */
        case 'sessions': {
          const sessions = chat.sessions();
          return send({ t: 'sessions', sessions, current: chat.state.sessionFile || chat.lastSessionPath });
        }
        case 'resume': {
          const path = String(msg.path || '');
          const owner = ownerOf(path);
          if (owner && owner !== chat.name) {
            return ack(false, { error: `该会话正在「${owner}」里使用（同一 .jsonl 不能两个进程同时写）`, owner });
          }
          await chat.switchSession(path);
          releaseChat(chat.name);          // this chat holds exactly one session at a time
          claimSession(chat, path);
          send({ t: 'items', items: chat.items });
          send({ t: 'state', state: chat.publicState() });
          chat.refreshPanel(true);
          return ack(true);
        }
        case 'ping':
          return send({ t: 'pong' });
        default:
          return ack(false, { error: 'unknown command' });
      }
    } catch (err) {
      send({ t: 'ack', ok: false, error: err.message });
    }
  });

  ws.on('close', () => {
    clearInterval(stopPing);
    chat.off('item', onItem);
    chat.off('items', onItems);
    chat.off('state', onState);
    chat.off('panel', onPanel);
    chat.watchPanel(false);
    chat.scopeCount = Math.max(0, (chat.scopeCount || 1) - 1);
    chat.lastSeen = Date.now();
  });
  ws.on('error', () => ws.close());
});

wss.on('connection', (ws, req, url) => {
  const session = url.searchParams.get('session');
  const cols = Math.max(20, Math.min(400, Number(url.searchParams.get('cols')) || 80));
  const rows = Math.max(6, Math.min(200, Number(url.searchParams.get('rows')) || 24));

  if (!pty) {
    ws.send(JSON.stringify({ t: 'error', m: '终端视图不可用：node-pty 未加载（装好构建工具后 npm rebuild node-pty，或用 PIWEB_NO_PTY=1 明确禁用）。对话视图不受影响。' }));
    ws.close();
    return;
  }

  let term;
  try {
    term = pty.spawn('tmux', ['attach-session', '-t', session], {
      name: 'xterm-256color',
      cols, rows,
      cwd: ROOT,
      env: { ...BASE_ENV, TERM: 'xterm-256color' },
    });
  } catch (err) {
    ws.send(JSON.stringify({ t: 'error', m: `attach failed: ${err.message}` }));
    ws.close(1011, 'spawn failed');
    return;
  }

  let closed = false;
  let pingTimer = null;
  const cleanup = (reason) => {
    if (closed) return;
    closed = true;
    if (pingTimer) clearInterval(pingTimer);
    try { term.kill(); } catch { /* already gone */ }   // kills the tmux CLIENT only -> detach
    if (reason !== 'term-exit' && ws.readyState === ws.OPEN) { try { ws.close(); } catch {} }
    console.log(`[pi-web] ws detached from ${session} (${reason}) — tmux session kept alive`);
  };

  term.onData((chunk) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'o', d: chunk })); });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'exit' }));
      ws.close(1000, 'session ended');
    }
    cleanup('term-exit');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { msg = { t: 'i', d: raw.toString() }; }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'resize') {
      const c = Math.max(20, Math.min(400, Number(msg.cols) || cols));
      const r = Math.max(6, Math.min(200, Number(msg.rows) || rows));
      try { term.resize(c, r); } catch {}
    } else if (msg.t === 'p') { try { ws.send(JSON.stringify({ t: 'p' })); } catch {} }
  });

  pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) { try { ws.ping(); } catch {} }
  }, 30000);

  ws.on('close', () => cleanup('ws-close'));
  ws.on('error', () => cleanup('ws-error'));
  console.log(`[pi-web] ws attached to ${session} ${cols}x${rows}`);
});

/* ------------------------------------------------------------------ boot */

async function tailscaleIps(waitMs) {
  if (!HAS_TAILSCALE) {
    console.warn('[pi-web] WARN: HOST 里写了 tailscale，但本机没有 tailscale 命令，跳过该地址');
    return [];
  }
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const ips = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 })
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (ips.length) {
        if (attempt > 1) console.log(`[pi-web] tailscale 就绪（${attempt} 次尝试）: ${ips.join(', ')}`);
        return ips;
      }
    } catch { /* socket/daemon not up yet */ }
    if (Date.now() >= deadline) return [];
    if (attempt === 1) console.log(`[pi-web] 等待 tailscale 分配 IPv4（最多 ${Math.round(waitMs / 1000)}s）…`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const SCHEME = USE_TLS ? 'https' : 'http';
const listeners = [];
const boundHosts = new Set();
const pendingHosts = new Set();       // tailnet address not on the interface yet
let tailscalePending = false;          // `tailscale` keyword resolved to nothing yet
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const hostUrl = (host) => `${SCHEME}://${host.includes(':') ? `[${host}]` : host}:${PORT}`;

/** one bind attempt on a fresh server object; resolves { ok, err } */
const bindHost = (host) => new Promise((resolve) => {
  const srv = USE_TLS
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, app)
    : http.createServer(app);
  srv.on('upgrade', onUpgrade);
  const onErr = (err) => { srv.removeAllListeners('error'); resolve({ ok: false, err }); };
  srv.once('error', onErr);
  srv.listen(PORT, host, () => {
    srv.off('error', onErr);
    srv.on('error', (err) => console.error(`[pi-web] ${hostUrl(host)} 错误: ${err.code || err.message}`));
    listeners.push(srv);
    boundHosts.add(host);
    console.log(`[pi-web] listening on ${hostUrl(host)}`);
    const loopback = host.startsWith('127.') || host === '::1' || host === 'localhost';
    if (!loopback && !USE_TLS && process.env.PIWEB_ALLOW_PLAINTEXT !== '1') {
      console.warn(`[pi-web] ⚠ ${hostUrl(host)} 是明文 HTTP：只应经 Tailscale/WireGuard 等私有网络访问。`);
      console.warn('           公网或不可信 LAN 请配置 PIWEB_TLS_CERT / PIWEB_TLS_KEY，或设 PIWEB_ALLOW_PLAINTEXT=1 关闭此提醒。');
    }
    resolve({ ok: true, srv });
  });
});

async function bindWithRetry(host, attempts, gapMs) {
  for (let i = 1; i <= attempts; i += 1) {
    const r = await bindHost(host);
    if (r.ok) return true;
    if (r.err.code !== 'EADDRNOTAVAIL') {
      console.error(`[pi-web] 监听 ${hostUrl(host)} 失败: ${r.err.code || r.err.message}`);
      return false;
    }
    if (i === 1 && attempts > 1) console.log(`[pi-web] 等待 ${host} 出现在接口上…`);
    if (i < attempts) await sleepMs(gapMs);
  }
  pendingHosts.add(host);   // healed by the retry timer below
  return false;
}

const HAS_TAILSCALE = (() => {
  try { execFileSync('tailscale', ['version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
})();

const tailscaleIpOnce = () => {
  if (!HAS_TAILSCALE) return [];
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
};

/** keep trying to bind addresses that were not available at startup */
function startBindHealer() {
  if (!pendingHosts.size && !tailscalePending) return;
  const timer = setInterval(async () => {
    if (tailscalePending) {
      const ips = tailscaleIpOnce().filter((ip) => !boundHosts.has(ip));
      if (ips.length) {
        console.log(`[pi-web] tailscale 迟到了 ${Math.round((Date.now() - healStart) / 1000)}s，补绑 ${ips.join(', ')}`);
        tailscalePending = false;
        for (const ip of ips) await bindWithRetry(ip, 3, 1000);
      }
    }
    for (const host of [...pendingHosts]) {
      const r = await bindHost(host);
      if (r.ok) pendingHosts.delete(host);
    }
    if (!pendingHosts.size && !tailscalePending) clearInterval(timer);
  }, 15000);
  timer.unref?.();
}
const healStart = Date.now();

{
  const spec = String(HOST_SPEC);
  let hosts = [];
  let wantedTailscale = false;
  for (const raw of spec.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    if (tok === 'tailscale' || tok === 'auto') {
      wantedTailscale = true;
      // On a cold boot systemd may start us before tailscaled has an address;
      // wait a little, then fall back to the healer instead of dying.
      hosts.push(...await tailscaleIps(30000));
    } else {
      hosts.push(tok);
    }
  }
  hosts = [...new Set(hosts)];
  if (!hosts.length) hosts = ['127.0.0.1'];

  for (const host of hosts) await bindWithRetry(host, host === '127.0.0.1' ? 1 : 20, 1500);
  if (!listeners.length) {
    console.error('[pi-web] 没有任何监听地址，退出');
    process.exit(1);
  }
  // `tailscale` was requested but resolved to nothing (or its IP is still not
  // on the interface): keep watching so a slow tailscaled still gets served.
  tailscalePending = wantedTailscale && ![...boundHosts].some((h) => !h.startsWith('127.') && h !== '::1');
  startBindHealer();
}

setTimeout(() => {
  console.log(`[pi-web] root sandbox: ${ROOT} · auth: WEB_PASS (${WEB_PASS.length} chars) + HttpOnly cookie`);
  console.log(`[pi-web] pi sessions: ${SESSIONS_ROOT} · shell: ${SHELL_BIN} · pty: ${pty ? 'on' : 'OFF'} · tls: ${USE_TLS ? 'on' : 'off'}`);
  try { const s = tmuxList(); console.log(`[pi-web] live pi sessions at boot: ${s.length}`); } catch {}
}, 200);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[pi-web] ${sig} — shutting down (tmux sessions / chat processes untouched)`);
    for (const s of listeners) s.close();
    setTimeout(() => process.exit(0), 300);
    setTimeout(() => process.exit(0), 1500);
  });
}
