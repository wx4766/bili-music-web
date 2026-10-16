#!/bin/bash
# bili-music 数据快照参考实现 —— 每天 cron 跑一次。
#
#   install -m 0755 backup.sh /usr/local/bin/bilimusic-backup.sh
#   (crontab -l; echo '17 4 * * * /usr/local/bin/bilimusic-backup.sh >> /var/log/bilimusic-backup.err 2>&1') | crontab -
#
# 为什么要它：playlists.json / history.json 是这个服务里唯一没有冗余的数据，
# 收藏夹 + 续播进度全在里面，丢了自己是没法重建的（B 站那边的收藏跟本地不是一回事）。
# 音频缓存丢了可以再下，这两个文件不行。
#
# 关键约束：**备份不能落在源数据同一块盘上**。
# 下面默认源在 /vol2、备到 /vol4（两块物理盘）。如果两边同一块盘，
# 盘挂了就一起没 —— 那就不叫备份了。请按你的实际挂载改 SRC_DIR / DST_ROOT。
#
# 用法：改下面的变量，或用环境变量覆盖
#   SRC_DIR=/data/bilimusic DST_ROOT=/backup/bilimusic ./backup.sh

set -u

SRC_DIR=${SRC_DIR:-/vol2/@appshare/bilimusic/data}
DST_ROOT=${DST_ROOT:-/vol4/1000/bilimusic-backup}
KEEP_DAYS=${KEEP_DAYS:-14}
OWNER=${OWNER:-}                  # 例：wx4766:Users；留空则不改属主
LOG=${LOG:-$DST_ROOT/backup.log}
TODAY=$(date +%F)

mkdir -p "$DST_ROOT" 2>/dev/null
[ -n "$OWNER" ] && chown "$OWNER" "$DST_ROOT" 2>/dev/null
chmod 755 "$DST_ROOT" 2>/dev/null
# 默认 umask 会把备份目录建成 000 —— 那样在文件管理器里根本看不见，
# 等于备份存在但取不出来。统一放开：目录 755、文件 644。

log() { echo "[$(date '+%F %T')] $*" >> "$LOG" 2>/dev/null; }

# 目标盘不可写（掉了 / 满了）要让 cron 的输出被邮件或 journal 抓到
if [ ! -d "$DST_ROOT" ]; then
  echo "FATAL: 备份目标不可用 $DST_ROOT"
  exit 1
fi

TMP="$DST_ROOT/.tmp-$TODAY-$$"
rm -rf "$TMP" 2>/dev/null
mkdir -p "$TMP" || { echo "FATAL: 无法创建临时目录"; exit 1; }

n=0
for f in playlists.json history.json; do
  if [ -f "$SRC_DIR/$f" ]; then
    # 跳过空文件：半截文件备过去等于用一个坏备份把好备份盖掉
    sz=$(stat -c %s "$SRC_DIR/$f" 2>/dev/null || echo 0)
    if [ "$sz" -lt 2 ]; then
      log "跳过 $f（只有 ${sz} 字节，疑似损坏，不覆盖昨天的备份）"
      continue
    fi
    cp -a "$SRC_DIR/$f" "$TMP/$f" 2>/dev/null && n=$((n+1))
  fi
done

# 源文件自校验：JSON 必须能解析，否则不拿它覆盖好备份
ok=1
for f in playlists.json history.json; do
  if [ -f "$TMP/$f" ]; then
    python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TMP/$f" 2>/dev/null || {
      log "拒绝覆盖：$f 不是合法 JSON，昨天的备份保留"
      rm -f "$TMP/$f"
      ok=0
    }
  fi
done

if [ "$n" -eq 0 ]; then
  rm -rf "$TMP" 2>/dev/null
  log "失败：没有拷贝任何文件（源目录不可读？）"
  exit 1
fi

# 原子替换当天目录：先在临时目录里备齐，再整体落位
rm -rf "$DST_ROOT/$TODAY" 2>/dev/null
mv "$TMP" "$DST_ROOT/$TODAY" 2>/dev/null || { log "失败：无法落位到 $DST_ROOT/$TODAY"; exit 1; }
[ -n "$OWNER" ] && chown -R "$OWNER" "$DST_ROOT" 2>/dev/null
chmod 755 "$DST_ROOT/$TODAY" 2>/dev/null
chmod 644 "$DST_ROOT/$TODAY"/* "$LOG" 2>/dev/null

if [ "$ok" -eq 1 ]; then
  log "快照完成 $DST_ROOT/$TODAY（${n} 个文件）"
else
  log "快照部分完成 $DST_ROOT/$TODAY（有文件被判为损坏，已跳过）"
fi

# 保留最近 KEEP_DAYS 份
cd "$DST_ROOT" 2>/dev/null || exit 0
ls -1d 20??-??-?? 2>/dev/null | sort | head -n -"$KEEP_DAYS" | while read -r d; do
  rm -rf "$d" 2>/dev/null
  log "清理过期快照 $d"
done

# 数据完整性哨兵：如果服务端把源文件隔离成 .corrupt-*，说明出过事了，
# 至少让它出现在日志里 —— 没有监控的机器，"有人看到"就是唯一的告警。
for f in "$SRC_DIR"/*.corrupt-*; do
  [ -e "$f" ] || continue
  log "⚠️ 检测到被隔离的损坏数据文件：$(basename "$f") —— 需要人工确认后再决定是否恢复"
done
