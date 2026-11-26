/**
 * panel.mjs — read-only projection of pi-goal-x and pi-subagents state.
 *
 * Neither extension can report through RPC: both publish TUI *component*
 * widgets, and `pi --mode rpc` ignores component factories (only string
 * arrays survive). So we read their own on-disk state instead — the same
 * files the TUI widgets are built from:
 *
 *   <cwd>/.pi/goals/active_goal_<ts>_<id>.md   goal record (JSON + prompt)
 *   <cwd>/.pi/goals/goal_events.jsonl          ledger: audit results, pauses…
 *   <tmpdir>/pi-subagents-uid-<uid>/async-subagent-runs/<id>/status.json
 *
 * Everything here is best-effort: a missing file simply yields no panel
 * section, never an error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = os.tmpdir();
const RUN_DIR_RE = /^pi-subagents-uid-\d+$/;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_CHILD_SESSION_BYTES = 12 * 1024 * 1024;
const RUN_MAX_AGE_MS = 8 * 3600e3;      // running runs
const RUN_DONE_KEEP_MS = 2 * 3600e3;    // completed runs stay visible this long
const MAX_RUNS = 6;
const MAX_TASKS = 12;

/** ledger event type -> goal runtime status (last one wins) */
const RUNTIME_STATUS = {
  goal_created: 'active', goal_resumed: 'active', goal_focused: 'active', goal_tweaked: 'active',
  goal_paused: 'paused', goal_blocked: 'blocked', goal_completed: 'completed',
};

const candCache = new Map();     // dir -> { at, roots: string[] }
const childCache = new Map();    // session file -> { mtimeMs, size, model, tools, turns }

const oneLine = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** first JSON object of a file that may be followed by rendered markdown */
function firstJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** goal pools that may belong to this chat: the dir itself + its direct children */
function goalRoots(dir) {
  const hit = candCache.get(dir);
  if (hit && Date.now() - hit.at < 30000) return hit.roots;
  const roots = [];
  const push = (d) => {
    const p = path.join(d, '.pi', 'goals');
    try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch { /* no pool */ }
  };
  push(dir);
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      push(path.join(dir, e.name));
    }
  } catch { /* unreadable dir */ }
  candCache.set(dir, { at: Date.now(), roots });
  return roots;
}

function readTail(file, maxBytes) {
  const st = fs.statSync(file);
  if (st.size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    const text = buf.toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally { fs.closeSync(fd); }
}

/** last audit verdict / usage / runtime state for this goal */
function readLedger(root, goalId) {
  let text;
  try { text = readTail(path.join(root, 'goal_events.jsonl'), MAX_LEDGER_BYTES); } catch { return null; }
  let audit = null, usage = null, runtime = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (goalId && e.goalId && e.goalId !== goalId) continue;
    if (e.type === 'audit_result') audit = e;
    else if (e.type === 'audit_usage') usage = e;
    else if (RUNTIME_STATUS[e.type]) runtime = { status: RUNTIME_STATUS[e.type], at: e.at ?? null, reason: oneLine(e.reason ?? '', 200) };
  }
  if (!audit && !usage && !runtime) return null;
  return {
    runtime,
    audit: audit || usage ? {
      verdict: audit?.verdict ?? null,
      at: audit?.at ?? null,
      report: audit?.report ? oneLine(audit.report, 4000) : null,
      turns: usage?.turns ?? null,
      costUsd: usage?.costUsd ?? null,
    } : null,
  };
}

export function readGoal(dir) {
  let best = null;
  for (const root of goalRoots(dir)) {
    let names;
    try { names = fs.readdirSync(root).filter((f) => /^active_goal_.+\.md$/.test(f)); } catch { continue; }
    for (const name of names) {
      const p = path.join(root, name);
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtimeMs) best = { root, path: p, mtimeMs: st.mtimeMs };
      } catch { /* raced with an archive */ }
    }
  }
  if (!best) return null;

  let rec;
  try { rec = firstJson(fs.readFileSync(best.path, 'utf8')); } catch { return null; }
  if (!rec || !rec.id) return null;

  const all = Array.isArray(rec.taskList?.tasks) ? rec.taskList.tasks : [];
  const tasks = all.slice(0, MAX_TASKS).map((t) => ({
    id: String(t.id ?? ''),
    title: oneLine(t.title, 120),
    status: String(t.status ?? 'pending'),
    evidence: t.status === 'complete' ? oneLine(t.evidence ?? '', 220) : '',
    completedAt: t.completedAt ?? null,
  }));
  const done = all.filter((t) => t.status === 'complete').length;
  const ledger = readLedger(best.root, rec.id);

  return {
    id: rec.id,
    status: ledger?.runtime?.status ?? rec.status ?? 'unknown',
    recordStatus: rec.status ?? null,
    revision: rec.revision ?? null,
    objective: oneLine(rec.objective, 260),
    currentTaskId: rec.currentTaskId ?? null,
    tasks,
    taskTotal: all.length,
    taskDone: done,
    taskHidden: Math.max(0, all.length - tasks.length),
    tokens: rec.usage?.tokensUsed ?? null,
    activeSeconds: rec.usage?.activeSeconds ?? null,
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
    runtimeAt: ledger?.runtime?.at ?? null,
    runtimeReason: ledger?.runtime?.reason ?? null,
    audit: ledger?.audit ?? null,
  };
}

/* ------------------------------------------------------------- subagents */

function childStats(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = childCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let model = null, tools = 0, turns = 0;
  if (st.size <= MAX_CHILD_SESSION_BYTES) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const m = e?.message ?? e;
        if (m?.role !== 'assistant') continue;
        turns += 1;
        if (!model && m.model) model = m.model;
        for (const b of m.content || []) if (b?.type === 'toolCall') tools += 1;
      }
    } catch { /* session being written */ }
  }
  const out = { mtimeMs: st.mtimeMs, size: st.size, model, tools: tools || null, turns: turns || null };
  childCache.set(file, out);
  return out;
}

const inScope = (rec, dir) => {
  const cwd = String(rec.cwd ?? '');
  if (!cwd) return false;
  return cwd === dir || cwd.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
};

function summarizeRun(rec, mtimeMs) {
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const startedAt = rec.startedAt || null;
  const endAt = rec.endedAt || (rec.state === 'running' ? null : rec.lastUpdate) || null;
  return {
    runId: rec.runId ?? null,
    mode: rec.mode ?? 'async',
    state: rec.state ?? 'unknown',
    startedAt,
    elapsedMs: startedAt ? Math.max(0, (endAt || Date.now()) - startedAt) : null,
    turns: rec.turnCount ?? null,
    tokens: rec.totalTokens?.total ?? null,
    costUsd: rec.totalCost?.costUsd ?? null,
    children: steps.map((s) => {
      const info = s.sessionFile ? childStats(s.sessionFile) : null;
      return {
        agent: s.agent ?? '',
        label: s.label ?? s.workflowKey ?? '',
        status: s.status ?? '',
        durationMs: s.durationMs ?? null,
        turns: s.turnCount ?? info?.turns ?? null,
        tokens: s.tokens?.total ?? null,
        model: info?.model ?? null,
        tools: info?.tools ?? null,
      };
    }),
    updatedAt: Math.max(mtimeMs, rec.lastUpdate || 0),
  };
}

export function readAgents(dir) {
  const runs = [];
  let roots = [];
  try {
    roots = fs.readdirSync(TMP_DIR).filter((n) => RUN_DIR_RE.test(n))
      .map((n) => path.join(TMP_DIR, n, 'async-subagent-runs'));
  } catch { return []; }

  const now = Date.now();
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const p = path.join(root, name, 'status.json');
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (now - st.mtimeMs > RUN_MAX_AGE_MS) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (rec.state !== 'running' && now - st.mtimeMs > RUN_DONE_KEEP_MS) continue;
      if (!inScope(rec, dir)) continue;
      runs.push(summarizeRun(rec, st.mtimeMs));
    }
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  return runs.slice(0, MAX_RUNS);
}

export function readPanel(dir) {
  let goal = null, agents = [];
  try { goal = readGoal(dir); } catch { goal = null; }
  try { agents = readAgents(dir); } catch { agents = []; }
  return { goal, agents, at: Date.now() };
}
