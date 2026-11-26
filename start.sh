#!/usr/bin/env bash
# pi-web 一键后台常驻管理脚本（tmux 守护 + 可选 systemd 单元）
#
#   ./start.sh start     后台启动（默认 HOST=127.0.0.1 PORT=8765）
#   ./start.sh stop      停止 web 服务（不触碰任何 pi-* tmux 会话）
#   ./start.sh restart
#   ./start.sh status
#   ./start.sh logs      跟踪日志
#   ./start.sh install-systemd   生成并启用 systemd 服务（开机自启）
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENVF="$DIR/.env"
LOGD="$DIR/logs"
LOG="$LOGD/server.log"
TMUX_SESSION="piweb"
UNIT="/etc/systemd/system/pi-web.service"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
# systemd 的 Environment= 以空白分隔：PATH 里带空格的 Windows 路径会把它截断
# （/etc/systemd/system/pi-web.service: Invalid environment assignment）。
# 这里先筛掉含空白的项与 /mnt/* ，再去重，得到一条干净的 Linux PATH。
SERVICE_PATH=$(printf '%s' "${PATH:-}" | tr ':' '\n' | grep -v -e '[[:space:]]' -e '^/mnt/' | awk 'NF && !seen[$0]++' | paste -sd: -)
[ -n "$SERVICE_PATH" ] || SERVICE_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ---------- preflight ----------
if [ -z "${NODE_BIN:-}" ] || ! [ -x "$NODE_BIN" ]; then
  echo "[pi-web] 错误：找不到 node（需要 >= 20）。若用 nvm，请在能跑 node 的 shell 里执行本脚本，" >&2
  echo "         或显式指定：NODE_BIN=/path/to/node ./start.sh start" >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "[pi-web] 错误：node 版本过旧（$("$NODE_BIN" -v)，需要 >= 20）" >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "[pi-web] 警告：PATH 里没有 pi，对话功能会失败。先 npm i -g @earendil-works/pi-coding-agent" >&2
fi

mkdir -p "$LOGD"

# ---------- env ----------
if [ ! -f "$ENVF" ]; then
  umask 077
  {
    echo "# pi-web 配置 —— 由 start.sh 首次生成，rm 掉即为重置"
    echo "# 默认只绑回环；要经 tailnet 访问改用：HOST=127.0.0.1,tailscale"
    echo "# 记得只经 Tailscale / SSH 隧道 / 反代(TLS) 暴露，别直接开到公网。"
    echo "HOST=127.0.0.1"
    echo "PORT=8765"
    echo "#PIWEB_ROOT=$HOME"
    echo "#PIWEB_SHELL=$(printf '%s' "${SHELL:-/bin/bash}" | grep -Eq '(bash|zsh|sh|ksh)$' && printf '%s' "${SHELL:-/bin/bash}" || echo /bin/bash)"
    echo "#PIWEB_TLS_CERT="
    echo "#PIWEB_TLS_KEY="
    echo "#PIWEB_NO_PTY=0"
    echo "WEB_PASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
    echo "WEB_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  } > "$ENVF"
  chmod 600 "$ENVF"
  echo "[pi-web] 已生成 $ENVF （含随机密码；请 cat 查看后自行修改）"
fi
set -a
# shellcheck disable=SC1090
. "$ENVF"
set +a
: "${HOST:=127.0.0.1}"
: "${PORT:=8765}"
export HOST PORT WEB_PASS WEB_SECRET

if [ -z "${WEB_PASS:-}" ]; then
  echo "[pi-web] 错误：$ENVF 里没有 WEB_PASS" >&2
  exit 1
fi
if [ -z "$NODE_BIN" ]; then
  echo "[pi-web] 错误：找不到 node，请先加载 nvm (source ~/.nvm/nvm.sh)" >&2
  exit 1
fi

pid_alive() {
  [ -f "$DIR/.pid" ] && kill -0 "$(cat "$DIR/.pid" 2>/dev/null)" 2>/dev/null
}

do_start() {
  if pid_alive; then echo "[pi-web] 已在运行 (pid $(cat "$DIR/.pid"))"; return 0; fi

  # 装了 systemd 单元就一律走 systemd（开机自启与手工启动是同一条路径）
  if command -v systemctl >/dev/null 2>&1 && systemctl cat pi-web >/dev/null 2>&1; then
    systemctl start pi-web
    sleep 1
    if systemctl is-active --quiet pi-web; then
      echo "[pi-web] 已启动（systemd） 端口 $PORT"
      (ss -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {printf "          监听 %s\n", $4}')
      systemctl show pi-web -p MainPID --value | sed 's/^/[pi-web] pid /'
      return 0
    fi
    echo "[pi-web] systemd 启动失败，最近日志:" >&2
    systemctl status pi-web --no-pager 2>&1 | tail -12 >&2
    journalctl -u pi-web -n 10 --no-pager 2>&1 | tail -10 >&2
    return 1
  fi

  command -v tmux >/dev/null || { echo "[pi-web] 缺少 tmux" >&2; exit 1; }
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null && tmux kill-session -t "$TMUX_SESSION"
  # tmux 只从 server 继承环境，所以用 -e 把配置显式钉进会话（不受旧 server 影响）
  tmux new-session -d -s "$TMUX_SESSION" -c "$DIR" \
    -e "PATH=$PATH" -e "HOST=$HOST" -e "PORT=$PORT" \
    -e "WEB_PASS=$WEB_PASS" -e "WEB_SECRET=${WEB_SECRET:-}" \
    "exec '$NODE_BIN' '$DIR/server.mjs' >>'$LOG' 2>&1" || {
      echo "[pi-web] 无法创建 tmux 会话 $TMUX_SESSION" >&2; exit 1; }
  sleep 1.5
  pgrep -f "$DIR/server.mjs" | head -1 > "$DIR/.pid"
  if pid_alive; then
    echo "[pi-web] 已启动: 端口 $PORT   (tmux 守护会话: $TMUX_SESSION, pid $(cat "$DIR/.pid"))"
    (ss -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {printf "          监听 %s\n", $4}')
    echo "[pi-web] 日志: $LOG"
  else
    echo "[pi-web] 启动失败，最近日志:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
}

do_stop() {
  local stopped=0
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet pi-web 2>/dev/null; then
    systemctl stop pi-web && echo "[pi-web] systemd 服务已停止"
    stopped=1
  fi
  if pid_alive; then
    kill "$(cat "$DIR/.pid")" 2>/dev/null
    sleep 0.6
    pid_alive && kill -9 "$(cat "$DIR/.pid")" 2>/dev/null
    echo "[pi-web] tmux 守护进程已停止"
    stopped=1
  fi
  rm -f "$DIR/.pid"
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null && { tmux kill-session -t "$TMUX_SESSION" 2>/dev/null; stopped=1; }
  [ "$stopped" = 1 ] || echo "[pi-web] 未在运行"
  echo "[pi-web] 提示：pi-* 会话保持存活，可用 tmux ls 查看"
}

do_status() {
  if pid_alive; then
    echo "[pi-web] 运行中 pid=$(cat "$DIR/.pid")  端口 $PORT"
  elif command -v systemctl >/dev/null && systemctl is-active --quiet pi-web 2>/dev/null; then
    echo "[pi-web] 运行中（systemd） 端口 $PORT"
  else
    echo "[pi-web] 未运行"
  fi
  echo "--- 监听端口 ---"
  (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":$PORT\b" || echo "（未监听 $PORT）"
  echo "--- pi-* tmux 会话 ---"
  tmux ls 2>/dev/null | grep '^pi-' || echo "（无）"
  return 0
}

case "${1:-start}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 0.5; do_start ;;
  status) do_status ;;
  logs) tail -f "$LOG" ;;
  install-systemd)
    cat > "$UNIT" <<EOF
[Unit]
Description=pi-web (mobile web workbench for pi on /root)
# tailscaled must be up first: HOST=…,tailscale binds the function's tailnet IP
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$ENVF
Environment=PATH=$SERVICE_PATH
ExecStart=$NODE_BIN $DIR/server.mjs
Restart=always
RestartSec=3
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload && systemctl enable --now pi-web
    echo "[pi-web] systemd 服务已安装并启动: systemctl status pi-web"
    echo "[pi-web] 服务 PATH: $SERVICE_PATH" ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs|install-systemd}" >&2; exit 2 ;;
esac
