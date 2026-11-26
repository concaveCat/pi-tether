# pi-web — 手机上的 WSL `pi` 工作台

手机浏览器（经 Tailscale 私网）访问 `/root`，以**对话形式**使用 `pi`：正文、思考过程、bash 调用、
文件编辑 diff、返回结果都是结构化渲染，输入在最下方的对话框里。需要原生 TUI 时再切到终端视图
（`node-pty` + `tmux`，`/resume` 等一切照旧）。

```
/root/pi-web
├── server.mjs       HTTP/WS 层：鉴权、文件 API、tmux 会话 API、对话 API、终端 PTY 桥
├── chat.mjs         对话引擎：每个对话一个常驻 `pi --mode rpc` 子进程 + 结构化 transcript
├── public/index.html 手机端 UI（对话 / 文件 / 终端 三视图，纯白纸+细线排版）
├── public/login.html 登录页（密码换 HttpOnly Cookie）
├── tmux.conf        pi-web 启动 tmux server 时用的配置（xterm-256color + extended-keys）
├── start.sh         一键后台常驻（start/stop/restart/status/logs/install-systemd）
├── selftest.mjs     45 项端到端自检（鉴权/沙箱/会话/对话/TUI/断线存活/清理）
├── .env             首次启动生成：HOST / PORT / WEB_PASS / WEB_SECRET（600）
└── logs/server.log
```

## 快速开始

```bash
cd /root/pi-web
./start.sh start          # 生成 .env（随机密码）并在 tmux 里常驻
cat .env                  # 看密码，也可改成自己的 WEB_PASS 后 restart
./start.sh status         # 端口 + 存活会话
./start.sh logs           # 跟踪日志
./start.sh stop           # 只停 web 服务，pi-* / 对话进程内存里的东西不受影响（见下）
cd /root/pi-web && node selftest.mjs    # 自检（会临时起会话并自动清理）
```

手动前台运行：`WEB_PASS='...' HOST=127.0.0.1 PORT=8765 node server.mjs`（未设 `WEB_PASS` 拒绝启动）

## 三个视图

**对话（默认）** — 主体是聊天记录：

| 元素 | 呈现 |
|---|---|
| 你的消息 | `你` 标签 + 正文（细线分隔，气泡已去掉） |
| 正文 | 轻量 markdown：粗体、行内代码、代码块、标题、链接、列表 |
| 思考过程 | 折叠行 `▸ 思考 696 字`，点开是灰色斜体原文；流式时自动展开 |
| 工具调用 | 折叠行 `▸ bash find /root …    ok · 16ms`；点开是命令 + 输出（失败自动展开） |
| 文件编辑 | 折叠行 `▸ edit /path (1)`；点开是真实 unified diff，绿加红删 |
| 写入/读取 | 折叠行 + 路径 + 内容/输出 |
| 确认弹窗 | 扩展的 `confirm/select` 请求变成内联卡片（是/否/取消） |
| 状态 | 顶栏显示当前目录、模型、思考档位；⚠ 长按「思考」可看扩展状态（context%） |

底部只有一个输入框：`Enter` 发送、`Shift+Enter` 换行，生成中按钮变成 `■` 停止。

**`/` 命令** — 在输入框开头敲 `/` 就弹出命令面板（↑↓ 选、`Tab`/`Enter` 确认、`Esc` 关）：

| 组 | 命令 | 说明 |
|---|---|---|
| pi-web | `/resume` | 列该目录的 pi 会话（时间 · 条数 · 模型 · 当前），选一个用 `switch_session` 热切换，**不重启对话进程** |
| | `/model` `/thinking` | 弹选择器写回 live 进程（`set_model` / `set_thinking_level`） |
| | `/new` `/compact` `/session` `/name` `/stop` `/help` | 新会话、压缩上下文、用量与上下文占比、命名、中止、命令清单 |
| pi 扩展 / 模板 / 技能 | `/goal` `/goal-status` `/council` `/skill:…` … | 直接转发给 `pi`（RPC 的 `prompt` 会展开扩展命令与模板），不当作聊天文本 |

切换走的是 RPC 的 `switch_session`：**对话进程不重启**，只是换会话文件并重放 `get_messages`。
代价是超大会话在 RPC 下会卡住（实测 34M / 6670 条的那个切不动，pi 不回复但进程仍可用；
6M 的 170ms 就好）。`/resume` 列表里 >12M 的条目会标「大会话，切换可能失败」，
切换超时（120s）会明确报错并保持原会话不变——真要开这种会话请用终端视图的 `/resume`。

分界的由来：pi 的内置 TUI 命令（`/resume`、`/settings`…）**不在 `get_commands` 里**，
RPC 模式也不会展开它们，原样发出去就是一段聊天文本——所以 `/resume` 这类由 pi-web 自己实现；
其余命令走 `get_commands` 拿到清单后原样转发。裸的内置命令（如整条消息就是 `/resume`）
即使在面板关闭时也不会被发给模型，`sendChat()` 会先拦一层。
点项目胶囊切换对话、`×` 关闭；`新对话` 开新会话（旧会话仍在 pi 的会话文件里，终端里 `/resume` 可找回）。

**状态抽屉** — 输入框上方一行细线（点开是折叠面板），把两个扩展的状态做成只读投影：

| 行 | 内容 |
|---|---|
| 折叠时 | `目标 1/8 进行中 · 审计未通过 · 子代理 1` |
| 目标 | 目标正文（截 2 行）+ 步进表：`✓` 已完成、`▶` 当前步、`·` 待办；带 rev / tokens / 已用时长 |
| 审计 | 最近一次 auditor 结论（`通过`/`未通过`）、轮数、花费；报告前 320 字，>320 字时附「全文 N 字」 |
| 子代理 | 每个 run：模式、run id、状态、时长、tokens、子任务数；每个子任务：agent、状态、**工具调用数**、**模型**、时长 |

数据来自它们自己的落盘状态（RPC 拿不到：两个扩展发的都是 TUI 组件 widget，
`pi --mode rpc` 只接受字符串数组）：
`<cwd>/.pi/goals/active_goal_*.md`、`<cwd>/.pi/goals/goal_events.jsonl`、
`/tmp/pi-subagents-uid-<uid>/async-subagent-runs/*/status.json`（模型与工具数从子会话 jsonl 数出来，按 mtime 缓存）。
有客户端在看时每 4s 轮询一次，内容变了才推；没人看就停。折叠/展开状态记在 localStorage。

**文件** — `/root` 目录浏览（目录优先、名称排序）。行内显示大小，点目录进入，点文本文件弹层预览
（200KB 上限，二进制拒绝）。三个动作：`在此对话`（该目录的确定性对话，存在即复用）、`新对话`、`终端`。

**终端** — 全屏 xterm（本地托管 `xterm.js` + `FitAddon`，零 CDN），真 `node-pty` + `tmux`。
软键盘弹出/收起由 `visualViewport` 实时重算行列。常驻横向快捷键栏：
`Esc` `Tab` `↑` `↓` `←` `→` `Enter` `Ctrl+C` `/resume` `重连` `PgUp` `PgDn` `C-b`。

## 架构

```
浏览器 ⇄ HTTP/WS ⇄ server.mjs ─┬─ fs（/root 沙箱）              → 文件 API
                               ├─ execFileSync tmux …            → 终端会话 API
                               ├─ node-pty ⇄ tmux attach        → /ws   终端 PTY 桥
                               └─ chat.mjs ⇄ pi --mode rpc      → /ws/chat 对话流
                                     ↑ 常驻子进程，不属于任何一条 WebSocket
```

- **对话进程独立于连接**：`pi --mode rpc` 由服务器持有。关网页 / 锁屏只断开 WS，
  生成不会中断；重新打开时服务端直接把内存里的完整 transcript（`items`）推给客户端，无需重放。
- **断线不杀会话（终端）**：WS 关闭只 `kill` 掉 `tmux attach` 的客户端（=detach），
  tmux 会话与 `pi` 任务保持运行。
- **可续接**：对话进程若退出（或服务器重启），下次打开同一目录的对话会用
  `pi --session <该目录最近的会话文件>` 恢复历史；`forceNew` 则全新开始。
- **环境一致**：两种会话都由登录 shell 拉起（`bash -lic 'exec "$@"' pi …`），
  `/etc/profile.d/*`（代理、license）、`~/.bashrc`(nvm→`pi`)、API Key 与手工开终端一致；
  tmux 侧额外 `-e PATH=…` 钉住环境。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/files?path=` | 列目录（目录优先、名称排序；含 type/size/mtime/相对路径） |
| GET | `/api/file?path=` | 预览文本（≤200KB，含 NUL 视为二进制 → 415） |
| GET | `/api/chats` | 对话列表（目录/模型/思考档位/是否生成中/消息数） |
| POST | `/api/chats` | `{path, forceNew}` 找到或创建该目录的对话进程 |
| DELETE | `/api/chats/:name` | 关闭对话进程（`^chat-[a-zA-Z0-9_-]+$`） |
| GET | `/api/sessions` | 存活 `pi-*` tmux 会话（含工作目录/前台命令） |
| POST | `/api/launch` | `{path, forceNew}` 起/复用 tmux + `pi`，退出 pi 保留交互 shell |
| DELETE | `/api/sessions/:name` | 关闭 tmux 会话（`^pi-[a-zA-Z0-9_-]+$`） |
| WS | `/ws/chat?chat=` | 服务端 → `items`/`item`/`state`/`ack`；客户端 → `prompt`/`abort`/`new_session`/`cycle_model`/`cycle_thinking`/`ui_response` |
| WS | `/ws?session=&cols=&rows=` | 终端字节流 + `resize` |

## 安全边界

| 项 | 实现 |
|---|---|
| 鉴权 | 登录 POST → HMAC token 存 `HttpOnly` Cookie（30 天）；同时接受 Basic（curl 友好）。**HTTP API 与两个 WS Upgrade 握手都校验**，未鉴权 `/api/*` → 401、`/ws*` → 401 断开 |
| 路径沙箱 | `path.resolve` + `fs.realpathSync` 双检，真实路径须严格在 `/root` 内；含 `..` → 400，绝对路径只在 `/root` 前缀下接受，软链接逃逸 → 403 |
| 命令注入 | tmux / pi 一律 `execFileSync('tmux',[argv])` / `pty.spawn` / `spawn(bash,['-lic','exec "$@"',…])`，从不用 shell 拼串；对话内容只走 RPC JSON |
| 会话名 | `^pi-…$` / `^chat-…$` 前缀白名单，`kill-session` 前再核对确实存在 |
| 网络 | 默认只听 `127.0.0.1`；只面向 Tailscale 私网，无公网暴露方案 |
| 前端 | 所有模型输出先 HTML 转义再上极小 markdown 白名单；无 CDN、无第三方脚本 |
| 暴力破解 | 5 分钟内 12 次失败 → 登录锁 5 分钟 |

## 手机访问（仅 tailnet）

`.env` 里 `HOST=127.0.0.1,tailscale`：`tailscale` 关键字会在启动时展开成
本机的 tailnet IPv4，因此**同时**有 loopback 与 tailnet 监听：

```
LISTEN 127.0.0.1:8765
LISTEN 100.101.102.103:8765      # 手机打开 http://100.101.102.103:8765
```

手机（Tailscale App 已连接）直接用浏览器/IP 访问即可；tailnet 内流量本身就是
WireGuard 加密的，HTTP 只是跑在这条私有链路上，没有公网暴露。

也支持逗号列表与 IPv6，例如 `HOST=127.0.0.1,100.101.102.103,fd7a:115c:a1e0::1`。

**HTTPS + 域名（`tailscale serve`）需要先在 tailnet 管理台开启**：
Enable HTTPS Certificates + MagicDNS（本机当前 `Self.CapMap` 无 `https`、
MagicDNS 关闭，`tailscale serve` 直接报 "Serve is not enabled on your tailnet"）。
开启后：

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8765   # https://desktop-q11gfsl.tail05515.ts.net
tailscale serve status
tailscale serve --https=443 off
```

绝不用 `tailscale funnel`（会暴露公网）。

## 开机自启（WSL 一启动就在线）

`/etc/wsl.conf` 已开 `[boot] systemd = true`，所以两个服务开机即起：

```bash
./start.sh install-systemd        # 写 /etc/systemd/system/pi-web.service 并 enable --now
systemctl status pi-web tailscaled
systemctl is-enabled pi-web tailscaled   # 都应是 enabled
```

冷启动的两处竞态已经处理：

| 场景 | 处理 |
|---|---|
| pi-web 先起、tailscaled 还没分到 tailnet IPv4 | `HOST=…,tailscale` 会**等 60s**（1.5s 一次重试 `tailscale ip -4`），拿到地址再绑定，日志里是 `等待 tailscale 分配 IPv4 …` / `tailscale 就绪（N 次尝试）` |
| 地址已拿到但还没落到接口上（`EADDRNOTAVAIL`） | 该地址单独重试 20 次（≤30s），不会因此让整个服务退出；`127.0.0.1` 始终先绑好 |
| tailscaled 冷启动 >30s 才给地址 | 先只服务 loopback，随后每 15s 复查一次；地址一出现就**补绑**（日志 `tailscale 迟到了 45s，补绑 100.101.102.103`），不需要重启服务 |

> 单元里 `Environment=PATH=` 必须是**不含空格的干净 Linux PATH**（`install-systemd`
> 会自动从当前 `$PATH` 里滤掉 Windows `/mnt/*` 与含空白的项）。直接把宿主 `$PATH`
> 写进去会被 systemd 按空白切碎，日志里出现
> `Invalid environment assignment, ignoring: Files`。

unit 里写的是 `After=network-online.target tailscaled.service` + `Wants=tailscaled.service`
+ `Restart=always`，所以 tailscaled 崩了重启后 pi-web 也会被一起拉起来。

> WSL 发行版本身仍是**按需启动**的（Windows 上有人打开终端/`wsl.exe` 才起 VM）。
> 想让「Windows 登录后手机就能连」，在 Windows 侧加一个登录时运行的计划任务：
> `schtasks /create /tn WSL-EXP /sc onlogon /tr "wsl.exe -d EXP -u root --exec /usr/bin/sleep infinity"`
> （发行版名是 `EXP`；`-u root` 是为了不依赖哪个用户先登录）。

## 设计语言

纯白纸式排版，没有卡片/气泡/色块容器：分隔只有 1px 细线（`#1b2431`），
容器一律无边框圆角、无背景填充；重点靠**字号层级 + 等宽字体 + 单色强调**区分。
`你是谁 / pi` 这样的角色标签只在说话人切换时出现，连续的工具行自动合并成日志流。
唯一例外是浮动的「↓ 最新」和预览弹层，它们必须压在内容之上。

## 已知细节

- xterm 侧：tmux attach 后处于 **alternate screen**，本地 scrollback 不适用 ——
  历史回滚用 `PgUp/PgDn`（pi/分页器）或 `C-b` `[`（tmux copy-mode），`Esc` 退出。
- tmux 3.4 没有 `extended-keys-format`；`tmux.conf` 已开 `extended-keys on`，
  否则 pi 会提示 "Modified Enter keys may not work"。
- 对话进程空闲 30 分钟且无人连接时自动关闭，进程表不会越攒越多。
- 服务器重启后，对话按「该目录最近一次 pi 会话」恢复；这与终端里 `pi -c` 语义一致。
