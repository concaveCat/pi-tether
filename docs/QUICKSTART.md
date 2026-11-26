# Quickstart

```bash
git clone https://github.com/concaveCat/pi-tether.git && cd pi-tether   # needs node >= 20, tmux, pi
npm install && cp .env.example .env && chmod 600 .env
sed -i "s|^WEB_PASS=.*|WEB_PASS=$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')|" .env
./start.sh start && ./start.sh status                                  # prints the bound addresses
```

Open `http://127.0.0.1:8765` and log in with the `WEB_PASS` from `.env`.

- Phone access: set `HOST=127.0.0.1,tailscale` in `.env` (needs the `tailscale` CLI), then open `http://<tailnet-ip>:8765`.
- Self-test: `node selftest.mjs` (45 checks). Ownership regression: `node tests/ownership.mjs`.
- Debugging starts at `GET /api/me` — it reports the effective `root`, `sessionsRoot`, `shell`, `pty`, `tls`, `piVersion`.

Full documentation: [`../README.md`](../README.md).
