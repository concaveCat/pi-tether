# 60 秒跑起来

```bash
git clone <this-repo> pi-web && cd pi-web           # 需要 node >= 20 / tmux / pi
npm install && cp .env.example .env && chmod 600 .env
sed -i "s|^WEB_PASS=.*|WEB_PASS=$(node -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')|" .env
./start.sh start && ./start.sh status               # 打印监听地址
```

浏览器打开 `http://127.0.0.1:8765`，用 `.env` 里的 `WEB_PASS` 登录。

- 手机访问：`.env` 里改成 `HOST=127.0.0.1,tailscale`（需装 tailscale），然后在手机上访问 `http://<tailnet-ip>:8765`。
- 自检：`node selftest.mjs`（45 项）。会话归属回归：`node tests/ownership.mjs`。
- 排错先看 `GET /api/me`：它直接告诉你当前生效的 `root` / `sessionsRoot` / `shell` / `pty` / `tls` / `piVersion`。

完整说明见 [`../README.md`](../README.md)。
