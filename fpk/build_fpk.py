# -*- coding: utf-8 -*-
"""构建 bilimusic.fpk（飞牛 fnOS 应用包）。

用法：
    python build_fpk.py            # 同步源码 + 生成图标 + fnpack build
    python build_fpk.py --no-pack  # 只同步源码和图标，不调 fnpack

说明：
- 所有需要 LF 行尾的文件（manifest / cmd/main / config / ui config）都由本脚本
  以 newline='\\n' 写出，避免 Windows CRLF 导致 NAS 上脚本执行失败。
- 源码从 bili-music-web 根目录同步到 app/server/，改完代码重跑本脚本即可。
"""
import io
import json
import os
import shutil
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                       # bili-music-web/
PACK = HERE                                        # 打包根 = fpk/
APP = os.path.join(PACK, 'app')
SERVER = os.path.join(APP, 'server')

FNPAK = os.environ.get(
    'FNPAK',
    r"C:\Users\wang'xin\.workbuddy\binaries\fnpack\fnpack.exe",
)

APPNAME = 'bilimusic'
BASE_PATH = '/app/' + APPNAME
VERSION = os.environ.get('FPK_VERSION', '1.3.2')

MANIFEST = """appname={appname}
version={version}
display_name=B站音乐
desc=自托管 B 站音乐播放器：搜索、热门、收藏夹、歌词、断点续播，手机浏览器与 PWA 随身听。
source=thirdparty
platform=all
maintainer=laowang
maintainer_url=https://www.bilibili.com
distributor=laowang
os_min_version=1.1.3100
desktop_uidir=ui
desktop_applaunchname={appname}.main
install_dep_apps=nodejs_v22
ctl_stop=true
checkport=false
changelog=v1.3.2：修复 iPhone Safari「点了歌一点反应都没有」。iOS 要求 play() 必须在用户手势的同步调用栈里发起，而点播要先 await 预热再播放，用户激活早已失效，必被 NotAllowedError 拒绝。修法是在触摸/点击的捕获阶段同步给空元素垫一段静音音频并 play() 解锁。本版补完两处让 v1.3.1 失效的细节：静音素材由 0 字节 WAV（play() 要 448ms 且从未真正播放）换成 0.1s 真静音 WAV（10ms）；并保证 unlockAudioEl 的 play() 先 settle 再换 src，playIndex 不再拆掉正挂着静音 wav 的备用元素（那正是后台无手势连播赖以生效的那个）。v1.3.1：iOS 播放解锁首次尝试（不完整）。v1.3.0：韧性加固。收藏夹/播放记录改为原子写入（临时文件+fsync+改名），JSON 损坏时改名保留现场而不是回写空数据，写入失败返回 503 让前端提示；B 站请求统一加超时，避免一条半开连接把搜索和取流全部挂死；下载加并发闸门与磁盘水位（剩余不足 2GB 就不再写缓存）；独立端口模式未设访问口令时拒绝启动（fail-closed）；/api/health 改为如实报告磁盘与 ffmpeg 状态；缓存每 6 小时做一次 LRU 与残留清理。v1.2.1：修复远程/外网「点了歌起不来」—— 并行分片在拿到文件总长前就排区间，第三路的起点飞过文件末尾导致服务端回 416，小于 6MB 的歌几乎必现；改为先取首块拿到总长再精确切块。顺带加固：Caddy 收到证书里没有的主机名不再直接断 TLS。v1.2.0：锁屏补齐进度拖动/快进快退，切歌指令走统一入口（随机、单曲、队尾不再没反应）；远程下载改并行大分片，弱网起播更快；控件热区补到 44px 并放开双指缩放；支持前面挂 Caddy 上 HTTPS（PWA 与锁屏封面才真正可用）；口令改表单登录，cookie 加 HttpOnly/Secure。v1.1.0：跨实例写锁、日志脱敏、字体本地化。
""".format(appname=APPNAME, version=VERSION)

PRIVILEGE = {
    "defaults": {"run-as": "package"},
    "username": APPNAME,
    "groupname": APPNAME,
}

RESOURCE = {
    "data-share": {
        "shares": [{"name": APPNAME + "/data"}]
    }
}

UI_CONFIG = {
    ".url": {
        APPNAME + ".main": {
            "title": "B站音乐",
            "icon": "images/icon_{0}.png",
            "type": "url",
            "protocol": "",
            "gatewayPrefix": BASE_PATH,
            "gatewaySocket": "app.sock",
            "url": BASE_PATH,
            "allUsers": True,
        }
    }
}

CMD_MAIN = r"""#!/bin/bash
# bilimusic 生命周期脚本：start / stop / status
LOG_FILE="${TRIM_PKGVAR}/app.log"
PID_FILE="${TRIM_PKGVAR}/app.pid"
APP_DIR="${TRIM_APPDEST}/server"
SOCKET_PATH="${TRIM_APPDEST}/app.sock"
BASE_PATH="/app/bilimusic"

# 数据目录优先用 data-share 声明的共享目录（卸载时保留收藏夹），
# 拿不到就退回 PKGVAR，保证应用一定能起来。
DATA_DIR="${TRIM_DATA_SHARE_PATHS%%:*}"
if [ -z "$DATA_DIR" ]; then DATA_DIR="${TRIM_PKGVAR}/data"; fi

# Node 运行时由 install_dep_apps=nodejs_v22 提供
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

log_msg() { echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"; }

check_process() { kill -0 "$1" 2>/dev/null; }

status_app() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(head -n 1 "$PID_FILE" | tr -d '[:space:]')"
    if [ -n "$pid" ] && check_process "$pid"; then return 0; fi
    rm -f "$PID_FILE"
  fi
  return 1
}

start_app() {
  if status_app; then log_msg "already running"; return 0; fi
  mkdir -p "${TRIM_PKGVAR}" "$DATA_DIR" 2>/dev/null
  if ! command -v node >/dev/null 2>&1; then
    echo "未找到 node，请确认 nodejs_v22 运行时已安装" > "$TRIM_TEMP_LOGFILE"
    log_msg "node not found"
    exit 1
  fi
  log_msg "starting (data=$DATA_DIR socket=$SOCKET_PATH)"
  cd "$APP_DIR" || exit 1
  DATA_DIR="$DATA_DIR" BASE_PATH="$BASE_PATH" SOCKET_PATH="$SOCKET_PATH" \
    node server.js >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
}

stop_app() {
  log_msg "stopping"
  if [ ! -f "$PID_FILE" ]; then rm -f "$SOCKET_PATH" 2>/dev/null; return 0; fi
  local pid
  pid="$(head -n 1 "$PID_FILE" | tr -d '[:space:]')"
  if [ -z "$pid" ] || ! check_process "$pid"; then
    rm -f "$PID_FILE"; rm -f "$SOCKET_PATH" 2>/dev/null; return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  local count=0
  while check_process "$pid" && [ "$count" -lt 10 ]; do sleep 1; count=$((count + 1)); done
  if check_process "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$PID_FILE"
  rm -f "$SOCKET_PATH" 2>/dev/null
}

case "$1" in
  start)  start_app ;;
  stop)   stop_app ;;
  status) if status_app; then exit 0; fi; exit 3 ;;
  *) echo "Unknown command: $1" > "$TRIM_TEMP_LOGFILE"; exit 1 ;;
esac
"""


# 其余生命周期脚本：fnpack 会逐个检查存在性，这里给最小幂等实现。
# 原则：卸载和升级都不动 data-share 里的收藏夹与音频缓存。
def _stop_service():
    return ('if [ -f "${TRIM_APPDEST}/cmd/main" ]; then '
            '"${TRIM_APPDEST}/cmd/main" stop || true; fi\n')


LIFECYCLE = {
    'install_init': '#!/bin/bash\n# 安装前预检：无特权操作，保持幂等。\nexit 0\n',
    'install_callback': '#!/bin/bash\n'
                        '# 安装后：Windows 打包可能丢失执行位，这里补回来。\n'
                        'chmod +x "${TRIM_APPDEST}/cmd/"* 2>/dev/null\n'
                        'exit 0\n',
    'upgrade_init': '#!/bin/bash\n# 升级前：先停掉旧进程，避免 socket 残留。\n'
                    + _stop_service() + 'exit 0\n',
    'upgrade_callback': '#!/bin/bash\n'
                        '# 升级后：补执行位；升级前在跑的就重新拉起。\n'
                        'chmod +x "${TRIM_APPDEST}/cmd/"* 2>/dev/null\n'
                        'if [ "${TRIM_APP_STATUS}" = "running" ]; then\n'
                        '  "${TRIM_APPDEST}/cmd/main" start || true\n'
                        'fi\n'
                        'exit 0\n',
    'uninstall_init': '#!/bin/bash\n# 卸载前：停服务，不删用户数据。\n'
                      + _stop_service() + 'exit 0\n',
    'uninstall_callback': '#!/bin/bash\n'
                          '# 卸载后：只清理应用自己的 socket，data-share 由系统保留。\n'
                          'rm -f "${TRIM_APPDEST}/app.sock" 2>/dev/null\n'
                          'exit 0\n',
    'config_init': '#!/bin/bash\nexit 0\n',
    'config_callback': '#!/bin/bash\n# 配置变更后重启服务。\n'
                       + _stop_service()
                       + '"${TRIM_APPDEST}/cmd/main" start || true\n'
                       + 'exit 0\n',
}


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def write_json(path, obj):
    write_text(path, json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def sync_source():
    os.makedirs(SERVER, exist_ok=True)
    for name in ('server.js', 'package.json'):
        shutil.copy2(os.path.join(ROOT, name), os.path.join(SERVER, name))
    pub_dst = os.path.join(SERVER, 'public')
    if os.path.exists(pub_dst):
        shutil.rmtree(pub_dst)
    # 排除历史备份文件，别把 .bak 打进应用包
    shutil.copytree(os.path.join(ROOT, 'public'), pub_dst,
                    ignore=shutil.ignore_patterns('*.bak*'))
    inline_css(os.path.join(pub_dst, 'index.html'))
    print('[sync] server.js / package.json / public ->', SERVER)


def inline_css(index_path):
    """把 styles.css 内联进打包版的 index.html。

    根因（2026-10-10 飞牛 App 实测）：网关登录态一失效，所有子资源（包括
    styles.css）都返回 200 + "invalid token" 纯文本，页面立刻退化成
    白底纯文字。内联后样式跟着 HTML 走，HTML 能开页面就一定有样式。
    线上 <link> 仍然保留（仓库版不动），两边样式等价、重复无害。
    """
    if not os.path.exists(index_path):
        return
    html = open(index_path, encoding='utf-8').read()
    css_path = os.path.join(os.path.dirname(index_path), 'styles.css')
    if not os.path.exists(css_path):
        return
    css = open(css_path, encoding='utf-8').read()
    link = '<link rel="stylesheet" href="styles.css" />'
    if link in html:
        html = html.replace(link, '<style>\n' + css + '\n</style>\n  ' + link, 1)
        open(index_path, 'w', encoding='utf-8').write(html)
        print('[inline] styles.css -> index.html (%d bytes)' % len(css))


def make_icons():
    src = os.path.join(ROOT, 'public', 'icons', 'icon-512.png')
    img = Image.open(src).convert('RGB')
    icon_dir = os.path.join(APP, 'ui', 'images')
    os.makedirs(icon_dir, exist_ok=True)
    for size, targets in (
        (256, [os.path.join(PACK, 'ICON_256.PNG'), os.path.join(icon_dir, 'icon_256.png')]),
        (64, [os.path.join(PACK, 'ICON.PNG'), os.path.join(icon_dir, 'icon_64.png')]),
    ):
        resized = img.resize((size, size), Image.LANCZOS)
        for t in targets:
            resized.save(t, 'PNG')
    print('[icon] 64 / 256 generated')


def main():
    sync_source()
    make_icons()
    write_text(os.path.join(PACK, 'manifest'), MANIFEST)
    write_json(os.path.join(PACK, 'config', 'privilege'), PRIVILEGE)
    write_json(os.path.join(PACK, 'config', 'resource'), RESOURCE)
    write_json(os.path.join(APP, 'ui', 'config'), UI_CONFIG)
    main_sh = os.path.join(PACK, 'cmd', 'main')
    write_text(main_sh, CMD_MAIN)
    for name, text in LIFECYCLE.items():
        p = os.path.join(PACK, 'cmd', name)
        write_text(p, text)
        try:
            os.chmod(p, 0o755)
        except OSError:
            pass
    try:
        os.chmod(main_sh, 0o755)
    except OSError:
        pass
    os.makedirs(os.path.join(PACK, 'wizard'), exist_ok=True)
    print('[conf] manifest / config / cmd / ui written')

    if '--no-pack' in sys.argv:
        return 0
    if not os.path.exists(FNPAK):
        print('[fnpack] not found:', FNPAK)
        return 1
    print('[fnpack] building ...')
    r = subprocess.run([FNPAK, 'build', '--directory', PACK],
                       capture_output=True, text=True)
    print(r.stdout or '')
    if r.stderr:
        print('STDERR:', r.stderr)
    return r.returncode


if __name__ == '__main__':
    sys.exit(main())
