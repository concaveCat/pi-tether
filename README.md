# pi-tether

A mobile-first web workbench for the [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent.
It tethers a phone (or any browser) to the machine where `pi` actually runs — over a private network — and gives you
three views of the same workspace: a structured **chat** transcript, a sandboxed **file** browser, and a real **terminal**.

`pi` itself is a TUI program. `pi-tether` runs it headless (`pi --mode rpc`) and re-renders its JSONL event stream as a
readable conversation: thinking blocks, tool calls, bash output, file diffs. Nothing is simulated — the terminal view is a
genuine `node-pty` PTY attached to a `tmux` session, so `/resume`, dialogs and every other TUI feature still work there.

```
pi-tether/
├── server.mjs          HTTP/WS layer: auth, file API, tmux sessions, chat API, PTY bridge
├── chat.mjs            chat engine: one long-lived `pi --mode rpc` child per chat + transcript
├── panel.mjs           read-only projection of goal/subagent state files
├── public/index.html   mobile UI (chat / files / terminal, inline CSS+JS, no CDN)
├── public/login.html   password → HttpOnly cookie
├── tmux.conf           tmux config used when pi-tether starts the tmux server
├── start.sh            background service (start/stop/restart/status/logs/install-systemd)
├── selftest.mjs        45 end-to-end checks
├── tests/ownership.mjs session-ownership regression suite
└── docs/QUICKSTART.md  5-line quickstart
```

## Features

| | |
|---|---|
| **Structured chat** | `pi`'s stream folded into a transcript: text, collapsible `thinking`, tool calls with exit codes and output, real unified diffs for edits, inline dialog cards for extension prompts |
| **Survives disconnects** | Chats run in a server-side child process; closing the tab (or losing mobile data) only detaches. Reconnect and the full transcript is replayed |
| **Images** | Attach photos/screenshots (up to 6, ≤8 MB each; png/jpeg/webp/gif) via `＋`, paste, or drag. They reach the model as `ImageContent` and are replayed from history |
| **Slash commands** | `/resume` (hot session switch, no re-spawn), `/model`, `/thinking`, `/new`, `/compact`, `/session`, `/name`, `/stop`, `/help` — plus every extension command, prompt template and skill that `pi` exposes, forwarded verbatim |
| **Status drawer** | Collapsed one-line summary of the active goal (task progress, audit verdict) and running subagents; expands to the full objective, task tree and run list. Hidden entirely when there is no goal and no subagent run |
| **File browser** | Sandboxed to `PITETHER_ROOT` (default `$HOME`), realpath-checked, symlink escapes rejected. Text preview up to 200 KB |
| **Real terminal** | `node-pty` + `tmux`, `TERM=xterm-256color`, mobile key bar (Esc/Tab/arrows/Enter/Ctrl-C/`/resume`/PgUp/PgDn/C-b), auto fit |
| **Ownership arbitration** | One session file may only ever have one writer. See [Session ownership](#session-ownership-no-forked-history) |
| **PWA** | Manifest + icons, standalone display, home-screen installable |
| **Notifications** | Turn finished while the tab is hidden → title badge `(1)` + system notification |
| **Auth** | `WEB_PASS` is required at startup; HTTP APIs and **both** WebSocket upgrades are checked |
| **Portable** | No hardcoded paths: sandbox root, `pi` config dir and login shell are all configurable |

## Requirements

| | |
|---|---|
| Node.js **≥ 20** | must be on `PATH` for the shell that runs `start.sh` (nvm users: run it from a shell that has node) |
| `pi` | `npm i -g @earendil-works/pi-coding-agent`, reachable from your login shell. **Verified against 1.5.2** — a different version prints a warning at startup (run `node selftest.mjs` first if something looks off) |
| `tmux` | session persistence for both the terminal view and `pi-*` sessions |
| Build tools | `node-pty` is a native module: `make`, `g++`, `python3` |
| Linux / macOS / WSL2 | Windows native is not supported (needs pty + tmux). On WSL2 enable `systemd` in `/etc/wsl.conf` if you want the systemd unit |

```bash
# RHEL / CentOS / Rocky
sudo dnf install -y gcc-c++ make python3 tmux
# Debian / Ubuntu
sudo apt install -y g++ make python3 tmux
# macOS
brew install tmux && xcode-select --install
```

If `node-pty` cannot be built, `PITETHER_NO_PTY=1` disables only the terminal view — chat and files keep working.
Run `npm rebuild node-pty` once the toolchain is in place to get it back.

## Quickstart

```bash
git clone https://github.com/concaveCat/pi-tether.git pi-tether && cd pi-tether
npm install
cp .env.example .env && chmod 600 .env
$EDITOR .env                      # at minimum: set WEB_PASS
./start.sh start                  # background; installs a systemd unit when available
./start.sh status                 # ports + bound addresses
```

Then open `http://127.0.0.1:8765` and log in with `WEB_PASS`.

Foreground alternative: `WEB_PASS='...' node server.mjs` — the server refuses to start without `WEB_PASS`.

`start.sh` also takes `stop`, `restart`, `logs`, and `install-systemd`. When a unit is installed, `start`/`stop`/`restart`
delegate to systemd, but only for the checkout the unit's `WorkingDirectory` points at — several checkouts on one host
do not confuse each other.

## Configuration

Everything lives in `.env` (loaded by `start.sh` / `EnvironmentFile=`), or the same variable in the environment.

| Variable | Default | Purpose |
|---|---|---|
| `WEB_PASS` | **required** | Login password. The server exits when it is missing |
| `WEB_SECRET` | random | Cookie signing key. Unset means a per-process key: every restart logs everyone out |
| `HOST` | `127.0.0.1` | Comma-separated bind list. The token `tailscale` expands to this node's tailnet IPv4 (skipped with a warning when the CLI is absent) |
| `PORT` | `8765` | Listen port |
| `PITETHER_ROOT` | `$HOME` | Sandbox root for the file browser and the agent's working directory |
| `PITETHER_SHELL` | `$SHELL` → `/bin/bash` | Login shell used to spawn `pi`. `-l` is what makes PATH, proxies and API keys match your terminal. Non-POSIX shells (fish/csh/nu) fall back to bash |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | `pi`'s own config dir; `/resume` reads `<it>/sessions` |
| `PITETHER_NO_PTY` | `0` | `1` disables the terminal view (use when `node-pty` will not build) |
| `PITETHER_TLS_CERT` / `PITETHER_TLS_KEY` | empty | Serve HTTPS directly |
| `PITETHER_ALLOW_PLAINTEXT` | `0` | `1` silences the "plaintext HTTP on a non-loopback address" warning |
| `PITETHER_DEBUG` | `0` | `1` logs session-ownership claim/release |

`GET /api/me` reports what is actually in effect — `root`, `sessionsRoot`, `shell`, `pty`, `tls`, `piVersion` — which is
the fastest way to diagnose a friend's setup.

## Views

**Chat (default)** — the transcript. Your messages, `pi`'s text with light markdown, collapsible `▸ thinking N chars`,
collapsible `▸ bash … ok · 16ms` with command and output (auto-expanded on failure), `▸ edit path (1)` with a real diff,
inline dialog cards for extension `confirm`/`select`/`input`/`editor` requests. The composer sends on `Enter`
(`Shift+Enter` for a newline) and turns into `■` while a turn is running. Long-press the thinking chip for extension status
(context usage).

**Files** — browse under `PITETHER_ROOT`, directories first, sizes on the right; tap a text file for a sheet preview.
The `chat here / new chat / terminal` actions apply to the directory you are in.

**Terminal** — full-screen xterm.js over a real PTY. The key bar exists because phone keyboards hide Esc/Ctrl.

## Session ownership (no forked history)

`pi` stores a session as an append-only JSONL tree: every record carries a `parentId`, and **`pi` has no session-level
file lock** (the `proper-lockfile` in the package is only used for MCP credentials). Two processes writing the same
`.jsonl` each grow their own branch; whichever writes last becomes the leaf and the other branch silently leaves the
context.

`pi-tether` therefore enforces *one writer per session file*:

| Situation | Behaviour |
|---|---|
| Second window for the same directory (no "new chat") | **Joins the existing chat** (`joined: true`). Both windows subscribe to one process, so they cannot diverge |
| "New chat" | Always a **new session file**. It never adopts a session another chat is writing |
| `/resume` onto a session owned by another chat | Rejected with the owner's name; the UI offers a one-tap "switch to that chat" |
| That chat is closed | Ownership is released and the session can be taken over |
| A different process (e.g. `pi` in a terminal) writes the file | Detected after ≥60 s of idleness plus two consecutive polls that see new **message** records, and reported. `pi`'s own late bookkeeping records (`usage`, `cache_warm`) do not trigger it |
| Right after a session switch | A 90 s grace window absorbs `pi`'s own follow-up writes; warnings have a 10-minute cooldown so a single false start cannot mute the feature forever |

Ownership keys are canonical paths. `pi` reports the *planned* session file in `get_state` before the JSONL exists, so
`realpath` alone would fail and silently skip the claim — the parent directory is resolved instead.

Limits: a session resumed from the terminal is only *detected*, not prevented (`pi` offers no lock), and switching to a
session larger than ~12 MB may time out (the picker marks those).

## API

All routes require auth except `/login`, `/manifest.webmanifest` and the icons (iOS fetches those without cookies).

| Route | |
|---|---|
| `GET /api/me` | effective configuration + versions |
| `GET /api/files?path=` · `GET /api/file?path=` | directory listing / text preview |
| `GET /api/sessions` · `POST /api/launch` · `DELETE /api/sessions/:name` | tmux `pi-*` sessions |
| `GET /api/chats` · `POST /api/chats` · `DELETE /api/chats/:name` | chat lifecycle (`{path, forceNew}`) |
| `WS /ws?session=&cols=&rows=` | PTY bridge (binary-safe input/output) |
| `WS /ws/chat?chat=` | transcript events, prompts, slash commands, dialogs |

Ownership conflicts surface as `ack {ok:false, owner}` on `/ws/chat`; the web client turns that into the "switch to that
chat" hint.

## Security

This is a **single-user** tool. One instance = one person; sharing an instance means sharing transcripts, shell and files.

| | |
|---|---|
| Auth | Login POST → HMAC token in an `HttpOnly; SameSite=Lax` cookie (30 days); Basic auth also accepted for curl. HTTP APIs **and** both WS upgrades are checked. `/api/*` unauthenticated → 401, `/ws*` → 401 close |
| Brute force | 12 failures in 5 minutes → login locked for 5 minutes |
| Path sandbox | `path.resolve` + `fs.realpathSync`; the real path must stay under `PITETHER_ROOT`. `..` → 400, absolute paths outside the root → 400, symlink escapes → 403 |
| No shell interpolation | `execFileSync('tmux', [argv])`, `pty.spawn`, `spawn(SHELL, ['-lic', 'exec "$@"', …])`. Chat content only ever travels as RPC JSON |
| Name whitelists | `^pi-[a-zA-Z0-9_-]+$` / `^chat-[a-zA-Z0-9_-]+$`, existence re-checked before `kill-session` |
| Network | Loopback by default. Binding a non-loopback address without TLS prints a loud warning — put it behind Tailscale / WireGuard / an SSH tunnel / a TLS reverse proxy, **never** straight on the public internet |
| Transport | Optional HTTPS via `PITETHER_TLS_CERT`/`PITETHER_TLS_KEY`; otherwise rely on the private network for encryption |
| Front end | All model output is HTML-escaped before a tiny markdown whitelist. No CDN, no third-party scripts |

## Design language

Pure dark paper, no rounded corners, no boxes, no filled containers: 1 px hairlines, whitespace, monospace for anything
that is data, and one accent colour. Every surface either shows content or disappears — the status drawer removes itself
when there is nothing to report.

## Development

```bash
npm run check            # syntax check of every entry point
node selftest.mjs        # 45 end-to-end checks (spins up sessions, cleans up after itself)
node tests/ownership.mjs # session-ownership regression (~3 min; needs a live instance)
```

`selftest.mjs` and `tests/ownership.mjs` both talk to a **running** instance and read `.env` for the port and password.
They create their own scratch chats and delete them afterwards.

Files are small on purpose: no bundler, no framework, no build step. `public/index.html` carries the CSS and JS inline.

## Notes and limitations

- `pi --version` is asserted softly at startup against the version this code was verified with. Mismatches only warn —
  but RPC field names are the fragile part, so run the self-test after upgrading `pi`.
- Android/Chrome only offers "install app" on a **secure context** (HTTPS); iOS "Add to Home Screen" works over plain HTTP,
  and iOS web notifications require an installed PWA.
- The session cookie is named `pitether`, so upgrading from an earlier build means logging in once more.
- Sessions are capped at the last 600 transcript items in memory; the JSONL on disk keeps everything.

## Licence

MIT.
