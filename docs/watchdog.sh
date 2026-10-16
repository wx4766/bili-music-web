#!/bin/bash
# bilimusic 看门狗参考实现 —— 由 cron 每 5 分钟调用一次。
#
#   install -m 0755 watchdog.sh /usr/local/bin/bilimusic-watchdog.sh
#   (crontab -l; echo '*/5 * * * * /usr/local/bin/bilimusic-watchdog.sh') | crontab -
#
# 设计取舍（重要，改之前先读）：
#   * 只在「进程不响应 / 5xx / 连接被拒」时才重启 —— 这类故障重启能修好。
#   * HTTP 200 但 health 报 ok:false（磁盘满、ffmpeg 缺失）**只记录不重启**：
#     重启解决不了这些问题，反而会变成每 5 分钟一次的无意义重启风暴。
#   * 连续 2 次失败才动手，避免一次瞬时抖动就重启（正在听歌的人会被打断）。
#   * 探活目标请按你的部署改：这里的 8362 是 node、8361 是前端 Caddy。

LOG=/var/log/bilimusic-watchdog.log
NODE_URL=${NODE_URL:-http://127.0.0.1:8362/api/health}
EDGE_URL=${EDGE_URL:-https://127.0.0.1:8361/api/health}
NODE_UNIT=${NODE_UNIT:-bilimusic-direct}
EDGE_UNIT=${EDGE_UNIT:-caddy}
NEED=${NEED:-2}          # 连续失败几次才动手

STATE_DIR=/run/bilimusic-watchdog
mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR=/tmp/bilimusic-watchdog
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# 探活：有 HTTP 响应就认为"进程在喘气"（401/404 也算活着，只是路由或口令问题）
probe() {
  local code
  code=$(curl -s -o /dev/null -m 8 -k -w '%{http_code}' "$1" 2>/dev/null)
  case "$code" in
    200|204|401|403|404) return 0 ;;
    *) return 1 ;;
  esac
}

reached() {
  local f="$1" n
  n=$(cat "$f" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$f"
  [ "$n" -ge "$NEED" ]
}

# ---- node ----
if probe "$NODE_URL"; then
  echo 0 > "$STATE_DIR/node"
else
  log "WARN node($NODE_URL) 探活失败"
  if reached "$STATE_DIR/node"; then
    log "ACTION 重启 $NODE_UNIT（连续 $NEED 次探活失败）"
    systemctl restart "$NODE_UNIT" >>"$LOG" 2>&1
    echo 0 > "$STATE_DIR/node"
  fi
fi

# ---- 反代/TLS 终结 ----
# 只在 node 活着的前提下才判它：node 挂了的时候边缘必然也不通，
# 那时重启边缘纯属添乱。
if systemctl is-active --quiet "$NODE_UNIT" && ! probe "$EDGE_URL"; then
  log "WARN edge($EDGE_URL) 探活失败"
  if reached "$STATE_DIR/edge"; then
    log "ACTION 重启 $EDGE_UNIT（连续 $NEED 次探活失败）"
    systemctl restart "$EDGE_UNIT" >>"$LOG" 2>&1
    echo 0 > "$STATE_DIR/edge"
  fi
else
  echo 0 > "$STATE_DIR/edge"
fi

# ---- health 报真话后的软告警（只记不重启）----
BODY=$(curl -s -m 8 "$NODE_URL" 2>/dev/null)
if echo "$BODY" | grep -q '"ok":false'; then
  log "ALERT health 不健康但不自动重启（重启修不好）: $BODY"
fi

# ---- 日志自截断，避免看门狗自己把盘写满 ----
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -c 524288 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
