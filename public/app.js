// B站音乐随身听 — 前端逻辑
const $ = (s) => document.querySelector(s);
// 统一网关前缀：由 index.html 中服务端注入的 window.__BASE__ 提供，
// 根路径部署（Docker / 本地直跑）时为空串，行为与原来完全一致。
let BASE = window.__BASE__ || '';
// 飞牛远程访问（FN Connect）会把页面路径改写成 /<fnid>/app/bilimusic/
// （例如 https://<域名>/<fnid>/app/bilimusic/）。服务端无从得知这层
// 动态前缀，所以在这里按当前 URL 自动补齐，否则所有 API/音频请求都会 404。
(function fixRemotePrefix() {
  try {
    const m = location.pathname.match(/^(.*)\/app\/[A-Za-z0-9_-]+(?=\/|$)/);
    if (m && m[1] && BASE.indexOf(m[1]) !== 0) BASE = m[1] + BASE;
  } catch {}
})();
const apiUrl = (p) => BASE + p;
const $$ = (s) => document.querySelectorAll(s);

// ---------------------------------------------------------------------------
// 双音频元素交替（本轮核心）。
// 真机日志证明：后台切歌时 JS 是活的、advance 也正常触发，但换源后新音频
// 在外网要十几秒才到（iOS 3 秒没数据就判 stalled），一旦音频停下，iOS 立刻
// 冻结页面 JS；之后音频由系统媒体引擎自己播完，可 JS 已死 —— 于是"放完就停"。
// 对策：下一首提前缓冲到备用元素里（此时上一首还在响，加载不受限），切歌时
// 直接换元素播放，本地就有数据 → 零等待 → 音频从不停下 → 页面不会被冻结。
// A() = 当前在播的元素，B() = 预备下一首的元素。
// ---------------------------------------------------------------------------
const audioEls = [$('#audio'), $('#audio2')];
let audioIdx = 0;
const A = () => audioEls[audioIdx];
const B = () => audioEls[1 - audioIdx];

// ---------------------------------------------------------------------------
// iOS 播放解锁（2026-10-17 真机事故修复：老汪反馈「一点都播放不了」）
//
// 现象：iPhone 上点了歌毫无反应。服务端日志显示 206 一片片都在往外发，
//   数据链路完全正常；客户端诊断日志里 play-fail 全是 **NotAllowedError**。
// 根因：iOS Safari 要求 play() 必须在**用户手势的同步调用栈**里发起。
//   而 playIndex() 是 async —— 中间要 await ensureWarm() 预热、
//   await fetchChunked() 把整首拉成 blob，等拿到 src 再调 play() 时，
//   用户激活早已失效，必被拒绝。页面刚打开时第一次点歌 100% 中招；
//   之后 armAutoResume() 的定时重试同样不在手势内，于是永远起不来。
// 解法：在任何触摸/点击的**捕获阶段**（同步、早于业务 handler）先让每个
//   <audio> 真的出声一次 —— 没有 src 就临时挂一段静音 wav。元素一旦在手势内
//   play() 过，后续对它的异步 play() 就被放行（iOS 的授权是 per-element 的）。
// ---------------------------------------------------------------------------
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAAAAAA==';
function unlockAudioEl(el) {
  if (!el) return;
  if (el._iosUnlocked) return;
  try {
    // 只有「空着」的元素才需要垫静音源；已经在预载下一首的元素不能动它的 src
    if (!el.src) el.src = SILENT_WAV;
    const p = el.play();          // ⚠️ 必须同步调用，绝不能 await
    if (p && p.then) {
      p.then(() => {
        el._iosUnlocked = true;
        // 静音 wav 只是敲门砖：出过声就立刻还原成空元素。
        // 不清的话备用元素会一直挂着一个「有 src、readyState Ready」的假象，
        // 被其它逻辑（换元素判断、诊断取元素）误认成已经缓冲好的一首。
        setTimeout(() => {
          try {
            if (el.src === SILENT_WAV) { el.pause(); el.removeAttribute('src'); el.load(); }
          } catch {}
        }, 0);
      }).catch(() => {});
    } else {
      el._iosUnlocked = true;
    }
  } catch {}
}
['touchend', 'pointerdown', 'click'].forEach((n) => {
  document.addEventListener(n, () => {
    // ⚠️ 只解锁「空着」的元素。带 src 的那个要么是正在播、要么是预载着下一首，
    //    对它调 play() 会真的放出声音，绝对不能碰。
    audioEls.forEach((el) => { if (!el.src) unlockAudioEl(el); });
  }, { capture: true, passive: true });
});
// 只在「当前在播的元素」上生效的事件绑定：备用元素里的预载事件不干扰 UI
function onA(ev, fn) {
  audioEls.forEach((el) => el.addEventListener(ev, () => { if (el === A()) fn(); }));
}
const player = $('#player');

let queue = [];        // 当前播放队列（合辑会展开成单曲）
let current = -1;      // 当前曲目在队列中的索引
let lyricLines = [];   // [{time, text}]
let lyricTimed = false;

// 播放模式：seq 顺序播完停 / loop 列表循环 / single 单曲循环 / shuffle 随机
let playMode = localStorage.getItem('bm_mode') || 'seq';
// 歌词时间轴人为偏移（秒）：正=歌词延后，负=提前。按曲目分别记
let lyricOffset = 0;
// 睡眠定时：结束时间戳（0=未启用）
let sleepEndAt = 0;
// 搜索分页
let searchPage = 1;
let searchNumPages = 1;
let searchLoading = false;
let searchAppend = [];
// 收藏列表排序模式
let favSortMode = false;
// 最近播放
let historyItems = [];
// 本次播放是否需要从指定位置续播
let pendingStart = 0;
// 期望"正在播"（用户点暂停 = false，被系统拦下 = 仍 true），诊断日志也用
let wantPlay = false;

// 是否走远程隧道（FN Connect 中转 / DDNS 公网）。远程下媒体栈的 Range 流式握手
// 实测极不稳定（缓存命中也 rs=0 卡 14 秒+），而普通 fetch 同一隧道秒通 ——
// 所以远程一律走「分片下载整首 → blob 播放」，局域网保持媒体栈直连（零等待）。
const IS_REMOTE = (() => {
  const h = location.hostname;
  if (!h || h === 'localhost' || h === '127.0.0.1') return false;
  return !/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
})();

// ---------------------------------------------------------------------------
// 诊断日志（临时：定位 iOS 后台连播用）
// 记关键事件 + 每秒心跳（hidden / paused / currentTime / readyState / buffered），
// 每 5 秒批量 POST 到 /api/log 落盘到 NAS，页面隐藏或关闭时用 sendBeacon 补发。
// 这样老汪在 iPhone 上实测完，我直接读日志复盘，不用靠猜。
// 关闭：URL 加 ?diag=0
// ---------------------------------------------------------------------------
const DIAG_ON = new URLSearchParams(location.search).get('diag') !== '0';
const DIAG = { buf: [], max: 900, client: '' };
if (DIAG_ON) {
  DIAG.client = localStorage.getItem('bm_diagid') || '';
  if (!DIAG.client) {
    DIAG.client = 'c' + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem('bm_diagid', DIAG.client); } catch {}
  }
}
const T0 = Date.now();
function curCid() {
  try { return A() && A().src ? (new URL(A().src).searchParams.get('cid') || '') : ''; } catch { return ''; }
}
function dlog(ev, extra) {
  if (!DIAG_ON) return;
  try {
    const rec = {
      ms: Date.now() - T0,
      hm: new Date().toTimeString().slice(0, 8),
      ev,
      hid: document.visibilityState,
      psd: A().paused,
      ct: A().currentTime != null ? Math.round(A().currentTime * 10) / 10 : null,
      du: A().duration != null && isFinite(A().duration) ? Math.round(A().duration * 10) / 10 : null,
      rs: A().readyState,
      ns: A().networkState,
      bf: A().buffered && A().buffered.length ? Math.round(A().buffered.end(A().buffered.length - 1) * 10) / 10 : null,
      b2: B().readyState,   // 备用元素（下一首预载）就绪度
      b2c: (() => { try { return B().src ? (new URL(B().src).searchParams.get('cid') || '') : ''; } catch { return ''; } })(),
      ci: curCid(),
      wp: wantPlay,
    };
    if (extra) Object.assign(rec, extra);
    DIAG.buf.push(rec);
    if (DIAG.buf.length > DIAG.max) DIAG.buf.shift();
  } catch {}
}
function flushDiag(beacon) {
  if (!DIAG_ON || !DIAG.buf.length) return;
  const logs = DIAG.buf.splice(0, DIAG.buf.length);
  const body = JSON.stringify({ client: DIAG.client, logs });
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(apiUrl('/api/log'), new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(apiUrl('/api/log'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtPlay(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, '') + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return String(n);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
}

// 网关鉴权诊断：统一网关在登录态失效时不返回 401，而是 200 + text/plain
// 「invalid token」，fetch 拿到非 JSON 会在 res.json() 处炸出莫名错误、页面
// 表现为「数据全空」。这里显式识别并挂出持久横幅，告诉用户去登录一次。
function showAuthWarn(detail) {
  if (document.querySelector('.wvbar-auth')) return;
  const bar = document.createElement('div');
  bar.className = 'wvbar wvbar-auth';
  bar.innerHTML = `
    <div class="wvb-txt">
      <b>数据加载失败：飞牛登录态无效</b>
      <span>${detail}。先在浏览器打开飞牛主页登录一次，再回到本页刷新即可。</span>
    </div>
    <div class="wvb-ops">
      <button class="wvb-login" type="button">去登录</button>
      <button class="wvb-x" type="button" aria-label="关闭">×</button>
    </div>`;
  Object.assign(bar.style, {
    position: 'fixed', left: '0', right: '0', top: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 12px', background: '#3a1212', color: '#ffb3b3',
    borderBottom: '1px solid #5c2020', font: '400 13px/1.5 system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box',
  });
  const txt = bar.querySelector('.wvb-txt');
  Object.assign(txt.style, { flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
  txt.querySelector('b').style.cssText = 'font-size:13px';
  txt.querySelector('span').style.cssText = 'font-size:12px;opacity:.85;word-break:break-all';
  const ops = bar.querySelector('.wvb-ops');
  Object.assign(ops.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });
  const login = bar.querySelector('.wvb-login');
  Object.assign(login.style, {
    padding: '6px 10px', borderRadius: '8px', border: '1px solid #6b2626',
    background: '#240c0c', color: '#ffb3b3', font: '400 12px/1 system-ui, sans-serif', cursor: 'pointer',
  });
  const x = bar.querySelector('.wvb-x');
  Object.assign(x.style, {
    width: '28px', height: '28px', borderRadius: '8px', border: '1px solid #6b2626',
    background: 'transparent', color: '#ffb3b3', fontSize: '18px', lineHeight: '1', cursor: 'pointer',
  });
  // 登录地址：远程形态 /<fnid>/app/xxx -> origin+/<fnid>/；根部署 -> origin+/
  // 第一段是 app 本身（/app/bilimusic）时不当前缀，退回 origin 根。
  const m = location.pathname.match(/^\/(?!app\b)([^/]+)\/app\//);
  const loginUrl = location.origin + (m ? '/' + m[1] + '/' : '/');
  login.addEventListener('click', () => { window.open(loginUrl, '_blank'); });
  x.addEventListener('click', () => bar.remove());
  document.body.appendChild(bar);
  const app = document.querySelector('.app');
  if (app) app.style.paddingTop = (bar.offsetHeight + 4) + 'px';
}

async function checkGateResponse(res, tag) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return null;
  const body = await res.text().catch(() => '');
  const short = body.trim().slice(0, 40) || '(空)';
  showAuthWarn(`接口返回 ${res.status} ${ct || '无类型'}「${short}」`);
  return new Error(`登录态失效（${short}）`);
}

// ---------------------------------------------------------------------------
// 登录态自愈（2026-10-10 实锤的机制）：网关 cookie（ost/osrt）按「最后登录的
// 域名」隔离——在 <fnid>.<远程域名> 登录过，而 app 链接经远程隧道落在
// <远程域名>/<fnid>/...（另一个域），cookie 不跟着走 → invalid token；
// 手动去根域转一圈才会往正确的域补发 cookie。
// 对策：启动时先探测 API，被拦就在隐藏 iframe（同源）里加载根域，让
// FN Connect 自己补 cookie，再重试 —— 免掉「先去主页转一圈」的手工动作。
// iframe 被同网判定重定向走也无妨（相当于替用户访问了一次主页）。
// ---------------------------------------------------------------------------
let authHealTried = false;
function loginRootUrl() {
  const m = location.pathname.match(/^\/(?!app\b)([^/]+)\/app\//);
  return location.origin + (m ? '/' + m[1] + '/' : '/');
}
async function authProbe() {
  try {
    const r = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
    const t = await r.text();
    return !/invalid token/i.test(t);
  } catch { return true; }
}
async function healAuth() {
  if (authHealTried) return true;
  authHealTried = true;
  if (await authProbe()) return true;
  dlog('heal-begin');
  toast('正在恢复登录态…');
  await new Promise((resolve) => {
    try {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9px;top:-9px;width:1px;height:1px;opacity:0;border:0;';
      f.src = loginRootUrl();
      f.onload = () => setTimeout(resolve, 5000);
      f.onerror = () => resolve();
      document.body.appendChild(f);
      setTimeout(resolve, 15000);
    } catch { resolve(); }
  });
  const ok = await authProbe();
  dlog('heal-done', { ok });
  return ok;
}

async function apiGet(url) {
  const res = await fetch(apiUrl(url));
  const gateErr = await checkGateResponse(res, url);
  if (gateErr) throw gateErr;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------------
// Tab 切换
// ---------------------------------------------------------------------------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $$('.view').forEach((v) => v.classList.remove('active'));
    $('#view-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'fav') loadFavorites();
    if (tab.dataset.tab === 'recent') loadRecent();
  });
});

// ---------------------------------------------------------------------------
// 搜索 + 排序 + 首屏热门榜
// order: totalrank 默认综合 / click 播放次数 / pubdate 上传时间（搜索、榜单通用）
// range: week 近7天 / month 近30天 / total 累计榜（仅榜单）
// 视图状态: 'hot' 榜单 | 'search' 搜索结果
// ---------------------------------------------------------------------------
let searchOrder = 'totalrank';
let hotRange = 'week';
let viewMode = 'hot';
let lastKeyword = '';
let hotItems = [];

function setResLabel(text) { $('#resLabel').textContent = text; }

function syncResSwitch() {
  const btn = $('#resSwitch');
  btn.classList.remove('hidden');
  btn.textContent = viewMode === 'hot' ? '刷新' : '← 热门榜';
}

// 排序对「搜索结果」和「热门榜」都生效，点了一定有可见反馈
$$('.sort[data-order]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.sort[data-order]').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    searchOrder = btn.dataset.order;
    if (viewMode === 'search' && lastKeyword) doSearch();
    else if (viewMode === 'hot') loadHot();
  });
});

// 榜单时间范围（本周 / 本月 / 累计）
$$('.rchip').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.rchip').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    hotRange = btn.dataset.range;
    loadHot();
  });
});

// hasMore 由服务端按 B 站返回的 numPages 判断
function updateMoreBar(hasMore) {
  const wrap = $('#moreWrap');
  if (!hasMore && $(`#results .trk`).children.length === 0) return wrap.classList.add('hidden');
  wrap.classList.remove('hidden');
  $('#loadMore').classList.toggle('hidden', !hasMore);
  $('#noMore').classList.toggle('hidden', !!hasMore);
}

async function doSearch(page = 1, append = false) {
  const kw = $('#kw').value.trim();
  if (!kw) return loadHot();
  if (searchLoading) return;
  lastKeyword = kw;
  searchLoading = true;
  const box = $('#results');
  if (!append) {
    box.innerHTML = '<div class="loading">搜索中…</div>';
    searchAppend = [];
    hideAlbumBar();
  }
  $('#searchHint').classList.add('hidden');
  $('#rangebar').classList.add('hidden');
  $('#moreWrap').classList.add('hidden');
  try {
    const data = await apiGet(`/api/search?keyword=${encodeURIComponent(kw)}&page=${page}&order=${encodeURIComponent(searchOrder)}`);
    viewMode = 'search';
    const results = data.results || [];
    searchAppend = append ? searchAppend.concat(results) : results;
    searchPage = Number(data.page) || page;
    searchNumPages = Number(data.numPages) || 1;
    setResLabel(`搜索 · ${kw}`);
    syncResSwitch();
    // B 站偶尔对某一页返回空（code=0 但没结果），追加模式下要留住已有结果，
    // 并保留"加载更多"让用户能再试一次，不能把列表刷成空白
    if (!results.length && append) {
      toast('这一页没取到内容，再点一次试试');
      updateMoreBar(true);
      return;
    }
    if (!searchAppend.length) {
      box.innerHTML = '<div class="hint">没找到相关结果，换个词试试</div>';
      return;
    }
    renderCards(box, searchAppend, (item, idx) => {
      queue = searchAppend.slice();
      playIndex(idx);
    }, { onCollect: (it) => openPlSheet(it) });
    markPlaying();
    refreshRowHearts();
    updateMoreBar(Boolean(data.hasMore));
  } catch (e) {
    if (append) toast('加载失败：' + e.message);
    else box.innerHTML = `<div class="hint">搜索出错：${esc(e.message)}</div>`;
  } finally {
    searchLoading = false;
  }
}

// 「加载更多」按钮 + 触底自动翻页（移动端习惯 seamless）
$('#loadMore').addEventListener('click', () => {
  if (searchLoading || searchPage >= searchNumPages) return;
  doSearch(searchPage + 1, true);
});
let scrollCooldown = 0;
window.addEventListener('scroll', () => {
  if (viewMode !== 'search' || searchLoading) return;
  if ($('#moreWrap').classList.contains('hidden')) return;
  if (searchPage >= searchNumPages) return;
  const now = Date.now();
  if (now - scrollCooldown < 400) return;
  const rect = $('#moreWrap').getBoundingClientRect();
  if (rect.top < window.innerHeight + 120) {
    scrollCooldown = now;
    $('#loadMore').click();
  }
});

// 首屏榜单：week=近7天 / month=近30天 / total=累计榜；排序键同样生效
async function loadHot(force = false) {
  const box = $('#results');
  if (!force) box.innerHTML = '<div class="loading">正在加载…</div>';
  $('#searchHint').classList.add('hidden');
  $('#rangebar').classList.remove('hidden');
  $('#moreWrap').classList.add('hidden');
  hideAlbumBar();
  try {
    const data = await apiGet(`/api/hot?range=${encodeURIComponent(hotRange)}&order=${encodeURIComponent(searchOrder)}${force ? '&refresh=1' : ''}`);
    hotItems = data.items || [];
    viewMode = 'hot';
    setResLabel(data.title || '热门');
    syncResSwitch();
    if (!hotItems.length) {
      box.innerHTML = '<div class="hint">榜单暂时取不到，先搜首歌吧</div>';
      return;
    }
    renderCards(box, hotItems, (item, idx) => {
      queue = hotItems.slice();
      playIndex(idx);
    }, { onCollect: (it) => openPlSheet(it) });
    markPlaying();
    refreshRowHearts();
    if (force) toast('榜单已刷新');
  } catch (e) {
    box.innerHTML = `<div class="hint">榜单加载失败：${esc(e.message)}</div>`;
  }
}

$('#searchBtn').addEventListener('click', () => doSearch());
$('#kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// 区块标题右边的动作键：热门态=刷新，搜索态=回到热门榜
$('#resSwitch').addEventListener('click', () => {
  if (viewMode === 'hot') loadHot(true);
  else { $('#kw').value = ''; loadHot(); }
});

// ---------------------------------------------------------------------------
// BV 直通输入：默认收起，点搜索框旁边的 BV 键才展开
// ---------------------------------------------------------------------------
$('#bvToggle').addEventListener('click', () => {
  const row = $('#bvRow');
  const opening = row.classList.contains('hidden');
  row.classList.toggle('hidden', !opening);
  $('#bvToggle').classList.toggle('on', opening);
  $('#bvToggle').setAttribute('aria-expanded', String(opening));
  if (opening) $('#bv').focus();
  else $('#bv').value = '';
});

// 统一的曲目行：序号 | 缩略图（顶满整行） | 标题/作者/时长+播放量 | 行内按钮组
// 行内按钮组：♥=免播放直接收藏（搜索/榜单行），DEL=移出列表（收藏行）
function rowEl(it, idx, opts = {}) {
  const card = document.createElement('div');
  card.className = 'trk';
  card.dataset.bvid = it.bvid || '';
  card.dataset.cid = String(it.cid || '');
  const isAlbum = (it.videos || 1) > 1;
  card.innerHTML = `
    <span class="idx">${String(idx + 1).padStart(2, '0')}</span>
    <div class="thumb"><img src="${esc(it.pic)}" loading="lazy" onerror="this.style.visibility='hidden'" /></div>
    <div class="meta">
      <div class="t">${esc(it.title)}</div>
      ${it.author ? `<div class="a">${esc(it.author)}</div>` : ''}
      <div class="stats">
        <span class="dur">${fmtTime(it.duration)}</span>
        ${it.play ? `<span>${fmtPlay(it.play)}</span>` : ''}
        ${isAlbum ? '<span class="badge">合辑</span>' : ''}
      </div>
    </div>
    <div class="rowbtns"></div>`;
  const btns = card.querySelector('.rowbtns');
  if (opts.onCollect) {
    const add = document.createElement('button');
    add.className = 'c-add';
    add.setAttribute('aria-label', '收藏到列表');
    add.innerHTML = '<svg width="15" height="15" viewBox="0 0 22 22" fill="none" stroke-width="1.6"><path d="M11 18.5S3.5 14 3.5 8.6C3.5 6 5.6 4 8 4c1.3 0 2.4.6 3 1.6C11.6 4.6 12.7 4 14 4c2.4 0 4.5 2 4.5 4.6C18.5 14 11 18.5 11 18.5z"/></svg>';
    add.addEventListener('click', (e) => { e.stopPropagation(); opts.onCollect(it, idx); });
    btns.appendChild(add);
  }
  if (opts.onDelete) {
    const del = document.createElement('button');
    del.className = 'c-del';
    del.textContent = 'DEL';
    del.setAttribute('aria-label', '从列表移除');
    del.addEventListener('click', (e) => { e.stopPropagation(); opts.onDelete(it, idx); });
    btns.appendChild(del);
  }
  // 排序模式：把收藏/删除换成三个位置键（置顶 / 上移 / 下移）
  if (opts.onSort) {
    for (const spec of [['⇈', 'top', '置顶'], ['↥', 'up', '上移'], ['↧', 'down', '下移']]) {
      const b = document.createElement('button');
      b.className = 'c-mv';
      b.textContent = spec[0];
      b.setAttribute('aria-label', spec[2]);
      b.addEventListener('click', (e) => { e.stopPropagation(); opts.onSort(it, idx, spec[1]); });
      btns.appendChild(b);
    }
  }
  return card;
}

function renderCards(container, list, onPlay, opts = {}) {
  container.innerHTML = '';
  list.forEach((it, idx) => {
    const card = rowEl(it, idx, opts);
    card.addEventListener('click', () => onPlay(it, idx));
    container.appendChild(card);
  });
}

// 列表里标记正在播放的那一条（粉色边条 + EQ 动画）
function markPlaying() {
  const item = queue[current];
  $$('.trk').forEach((el) => {
    const sameVideo = el.dataset.bvid === (item && item.bvid);
    const samePart = !item || !item.cid || !el.dataset.cid || el.dataset.cid === String(item.cid);
    el.classList.toggle('on', !!item && sameVideo && samePart);
  });
}

// 给所有可见行的 ♡ 点亮"已在任一列表"状态（依赖行上的 data-bvid/cid）
async function refreshRowHearts() {
  try {
    const map = await fetchMembership();
    $$('.trk').forEach((el) => {
      const key = `${el.dataset.bvid}|${el.dataset.cid}`;
      let inAny = false;
      for (const set of map.values()) if (set.has(key)) { inAny = true; break; }
      el.classList.toggle('fav', inAny);
    });
  } catch { /* 点不亮就算了，不影响使用 */ }
}

// ---------------------------------------------------------------------------
// BV 直接播放
// ---------------------------------------------------------------------------
async function playBv(raw) {
  const bvid = (raw || '').trim();
  if (!/^BV\w+$/i.test(bvid)) return toast('BV 号格式不对');
  toast('解析中…');
  try {
    const item = { bvid };
    queue = [item];
    await playIndex(0);
  } catch (e) {
    toast('解析失败：' + e.message);
  }
}
$('#bvBtn').addEventListener('click', () => playBv($('#bv').value));
$('#bv').addEventListener('keydown', (e) => { if (e.key === 'Enter') playBv($('#bv').value); });

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------
// opts.startAt：从指定秒数开始播（断点续播用）
async function playIndex(idx, opts = {}) {
  if (idx < 0 || idx >= queue.length) return;
  let playIdx = idx;
  let item = queue[idx];

  // 还没解析过的视频先 resolve；遇到多P合辑或B站合集就把整份列表展开进队列
  if (!item.cid) {
    toast('加载中…');
    try {
      const r = await apiGet(`/api/resolve?bvid=${encodeURIComponent(item.bvid)}`);
      if (r.pages && r.pages.length > 1) {
        // 多P视频：每个分P = 一首歌
        const parts = r.pages.map((pg) => ({
          bvid: item.bvid,
          cid: pg.cid,
          title: pg.part && pg.part !== r.title ? (pg.part || r.title) : r.title,
          lyricKey: pg.part && pg.part !== r.title ? pg.part : '',
          author: r.author || item.author,
          pic: r.pic || item.pic,
          duration: pg.duration || 0,
          _partsResolved: true,
        }));
        queue.splice(idx, 1, ...parts);
        playIdx = idx;
        item = queue[playIdx];
        toast(`合辑：${parts.length} 首已加入队列`);
        showAlbumBar(parts, `合辑 · ${parts.length} 首`);
      } else if (r.season && r.season.items.length > 1 && !item._seasonSeen) {
        // B站合集（跨视频歌单）：整季插进队列，从点击的这首开始连播
        const items = r.season.items.map((x) => ({ ...x, _seasonSeen: true, _partsResolved: true }));
        const at = Math.max(0, items.findIndex((x) => x.bvid === item.bvid));
        queue.splice(idx, 1, ...items);
        playIdx = idx + at;
        item = queue[playIdx];
        // 点的这首直接复用本次 resolve 的数据，省一次往返
        item.cid = r.cid || item.cid;
        item.title = r.title || item.title;
        item.author = r.author || item.author;
        item.pic = r.pic || item.pic;
        item.duration = r.duration || item.duration;
        toast(`合集「${r.season.title || '歌单'}」：${items.length} 首已加入队列`);
        showAlbumBar(items, `合集 · ${items.length} 首`);
      } else {
        item.title = r.title || item.title;
        item.author = r.author || item.author;
        item.pic = r.pic || item.pic;
        item.duration = r.duration || item.duration;
        item.cid = r.cid || item.cid;
      }
    } catch (e) {
      toast('播放失败：' + e.message);
      return;
    }
  } else if (!item._partsResolved) {
    // 从收藏夹 / 最近播放进来时 item 已经带 cid，以前这里直接跳过解析，
    // 于是多P合辑只剩当前这一段，放完就停、手动点下一首也切不动。
    // 现在后台把同一视频的后续段落补进队列（不打断正在起的这一首）。
    item._partsResolved = true;
    fillRestParts(item, playIdx);
  }

  current = playIdx;
  audioRetry = 0;
  queueEnded = false;
  rescueTried = false;
  releaseBlob();   // 换歌时回收上一首的 blob URL，避免内存越攒越多
  dlog('src-set', { idx: playIdx, mode: playMode, bvid: item.bvid, cid: item.cid, qlen: queue.length });
  updatePlayerMeta(item);
  player.classList.remove('hidden');
  pendingStart = Number(opts.startAt) || 0;

  // 备用元素里已经缓冲好这一首 → 直接换元素播（数据在本地，切换是零等待的）
  const wantKey = `${item.bvid}|${item.cid}`;
  const bx = B();
  const canSwap = !!bx.src && preloadKey === wantKey && bx.readyState >= 2;
  let oldEl = null;
  if (canSwap) {
    oldEl = A();
    audioIdx = 1 - audioIdx;
    dlog('swap', { idx: playIdx, rs: bx.readyState, bf: bufEnd(bx) });
    if (pendingStart > 0) {
      // 预载元素早就 loadedmetadata 过了，续播点要在这里补上
      try { A().currentTime = pendingStart; } catch {}
      pendingStart = 0;
    }
  } else {
    // 备用元素里不是这一首 → 停掉它的下载，别白耗流量
    if (bx.src) { try { bx.pause(); bx.removeAttribute('src'); bx.load(); } catch {} }
    // 上一首播放期间已经把这一首整段拉到内存了 → 直接建 blob，零网络零等待。
    // 这条路径是 iOS 后台连播的关键：切歌时不发任何 fetch、不碰媒体栈，
    // 只换一个内存 blob，页面即便被系统挂起也不会卡住。
    const preHit = (IS_REMOTE && remotePreload && remotePreload.key === wantKey && remotePreload.parts)
      ? remotePreload : null;
    if (!preHit) {
      // 先把整首拉到 NAS 本地缓存，再设 src —— 播放请求就走本地磁盘直读。
      // 原因：让播放请求自己去打 B 站 CDN 的话，那趟往返要穿过「网关 + 远程中转」，
      // iPhone Safari 每 3~4 秒判 stall 一次，readyState 永远停在 0（点了不响）。
      // 预取已命中时跳过这一步：后台里每个 await 都是一次被系统掐断的机会。
      const warmHint = setTimeout(() => toast('正在缓冲…'), 400);
      await ensureWarm(item);
      clearTimeout(warmHint);
    }
    // 远程走「客户端自己分片」：带 full=1 让服务端不再截到 192KB。
    // 局域网/媒体栈路径不加 —— 那条路仍需要小分片来避免弱网重传风暴。
    const playUrl = apiUrl(`/api/play?bvid=${encodeURIComponent(item.bvid)}&cid=${item.cid}${IS_REMOTE ? '&full=1' : ''}`);
    if (IS_REMOTE) {
      if (preHit) {
        dlog('rp-hit', { cid: item.cid, bytes: partsBytes(preHit.parts) });
        blobFromBytes(preHit.parts);
        remotePreload = null;   // 已消费，释放这几 MB
        A().src = blobUrl;
      } else {
        try {
          await fetchChunked(item, playUrl);
        } catch (e) {
          dlog('blob-prim-fail', { msg: String((e && e.message) || e).slice(0, 60) });
          toast('直连模式重试…');
          A().src = playUrl;   // 分片失败退回媒体栈，后面还有 stall 兜底
        }
      }
    } else {
      A().src = playUrl;
    }
  }
  preloadKey = '';
  armStallWatch();
  try {
    await A().play();
    setPlayIcon(true);
    wantPlay = true;
    stopResumeRetry();
    dlog('play-ok', { idx: playIdx, swap: canSwap });
  } catch (e) {
    setPlayIcon(false);
    dlog('play-fail', { idx: playIdx, name: e && e.name, msg: String((e && e.message) || e).slice(0, 80) });
    // 系统（尤其 iOS 后台）拒绝了这次自动播放：不要只弹提示，挂自动重试，
    // 回到前台 / 系统放行时会自己接着播。
    armAutoResume();
    // 但 NotAllowedError 是「没拿到用户手势」——定时器重试同样不在手势内，
    // 干等 48 秒到 armGestureResume 是纯浪费（真机日志：连试 11 次全被拒）。
    // 这种错直接把「轻点屏幕继续播放」摆出来，用户碰一下立刻就响。
    if (e && e.name === 'NotAllowedError') armGestureResume();
  }
  // 新的一首已经出声，这时才停旧元素 —— 保证整个过程声音从没断过
  if (oldEl) { try { oldEl.pause(); oldEl.removeAttribute('src'); oldEl.load(); } catch {} }
  loadLyrics(item);
  markPlaying();
  reportPosition(true);
  // 顺手把下一首的取流地址算好（只取地址不下音频），切歌时省两次 B 站往返。
  // 远程模式下一开播就把下一首整段拉到内存：当前这首已经在内存里播，
  // 带宽是空的，提前拉完 = 切歌时零网络，后台也不会因为等下载而卡住。
  prefetchNext(IS_REMOTE);
}

// ---------------------------------------------------------------------------
// 起播前先把整首拉到服务端本地缓存（wait=1 同步等）。
// 本机/局域网用不到这段 CDN 等待，远程访问（FN Connect 中转）必须靠它。
// 失败也不阻塞播放 —— 只是退回原来的“边代理边播”路径。
// ---------------------------------------------------------------------------
const warmedDone = Object.create(null);
// 预热失败回滚（评审 P1-2/P1-3）：以前失败也照样闩死（warmedDone 置位 /
// warmedKey 不清），一首歌预热失败就 30 分钟锁死最慢路径，通勤时信号弱一下
// 之后每首都得现场下载。现在失败只记 60 秒退避，之后自动重试。
const warmFailAt = Object.create(null);
const WARM_RETRY_MS = 60000;
function warmBlocked(key) {
  const t = warmFailAt[key];
  if (!t) return false;
  if (Date.now() - t > WARM_RETRY_MS) { delete warmFailAt[key]; return false; }
  return true;
}
async function ensureWarm(item) {
  if (!item || !item.cid) return;
  const key = `${item.bvid}|${item.cid}`;
  if (warmedDone[key] || warmBlocked(key)) return;
  const qs = `bvid=${encodeURIComponent(item.bvid)}&cid=${encodeURIComponent(item.cid)}&warm=1&wait=1`;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const r = await fetch(apiUrl(`/api/prefetch?${qs}`), { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json().catch(() => ({}));
    if (j.ok === false || !j.cached) {
      warmFailAt[key] = Date.now();     // 不闩死，60 秒后可重试
      dlog('warm-fail', { cid: item.cid, cached: !!j.cached, err: String(j.error || '').slice(0, 60), ms: Date.now() - t0 });
      return;
    }
    warmedDone[key] = true;
    dlog('warm-resp', { cid: item.cid, cached: !!j.cached, size: j.size || 0, ms: Date.now() - t0 });
  } catch (e) {
    warmFailAt[key] = Date.now();
    dlog('warm-err', { cid: item.cid, ms: Date.now() - t0, err: String(e).slice(0, 60) });
  }
}

// ---------------------------------------------------------------------------
// 预取下一首：实测切歌时如果不预取，要等上一首播完才去打 view + playurl，
// 局域网就有 1.4s 空档，外网更久。这里在当前歌一开播就把下一首的地址算出来。
// warm=true 时连音频本体一起让服务端拉到磁盘缓存（iOS 后台连播用）。
// ---------------------------------------------------------------------------
let prefetchedKey = '';
let warmedKey = '';
let preloadKey = '';   // 备用元素里当前缓冲的是哪一首
function bufEnd(el) {
  try {
    return el.buffered && el.buffered.length
      ? Math.round(el.buffered.end(el.buffered.length - 1) * 10) / 10 : null;
  } catch { return null; }
}
// ⚠️ 2026-10-11 关键修复（后台连播的真凶）：
// 热门/搜索列表里的曲目只是"壳"，cid=0，要点播那一刻才去 resolve。
// 之前预取前不补这一步 → 下一首拿不到 cid → **预取整个被跳过** →
// 后台切歌时还得现场 resolve + 整首下载，iOS 一挂起就永远卡住
// （真机日志实锤：切歌全是 `blob-ok mode:chunked` 现场下载，0 次预取命中）。
// 现在先把下一首解析出来（顺带补全标题/时长），再预取；解析结果写回队列，
// 真正切到它时连那次 resolve 往返都省了。
let resolvingNextKey = '';
async function ensureNextResolved(n) {
  if (!n || n.cid || !n.bvid) return null;
  if (resolvingNextKey === n.bvid) return null;
  resolvingNextKey = n.bvid;
  try {
    const r = await apiGet(`/api/resolve?bvid=${encodeURIComponent(n.bvid)}`);
    if (r && r.cid) {
      n.cid = r.cid;
      n.title = r.title || n.title;
      n.author = r.author || n.author;
      n.pic = r.pic || n.pic;
      n.duration = r.duration || n.duration;
      dlog('next-resolved', { cid: n.cid });
      return n;
    }
    return null;
  } catch (e) {
    dlog('next-resolve-fail', { msg: String((e && e.message) || e).slice(0, 50) });
    return null;
  } finally {
    if (resolvingNextKey === n.bvid) resolvingNextKey = '';
  }
}

function prefetchNext(warm) {
  const n = queue[current + 1];
  if (!n) return;
  // 下一首还没解析过：先解析，好了再真正预取（不阻塞当前播放）
  if (!n.cid) {
    ensureNextResolved(n).then((x) => { if (x && x.cid) prefetchNext(warm); });
    return;
  }
  const key = `${n.bvid}|${n.cid || 0}`;
  const qs = `bvid=${encodeURIComponent(n.bvid)}&cid=${encodeURIComponent(n.cid || 0)}`;
  if (key !== prefetchedKey) {
    prefetchedKey = key;
    dlog('pf-send', { cid: n.cid, warm: false });
    fetch(apiUrl(`/api/prefetch?${qs}`)).catch(() => {});
  }
  if (warm && n.cid && key !== warmedKey && !warmBlocked(key)) {
    warmedKey = key;
    dlog('pf-send', { cid: n.cid, warm: true });
    fetch(apiUrl(`/api/prefetch?${qs}&warm=1`))
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        if (j && j.ok === false) {
          // 服务端明确失败：回滚闩锁，下一轮 prefetchNext 还能再试
          warmedKey = (warmedKey === key) ? '' : warmedKey;
          warmFailAt[key] = Date.now();
          dlog('pf-fail', { cid: n.cid, warm: true, err: String(j.error || 'ok:false').slice(0, 60) });
          return;
        }
        dlog('pf-resp', { cid: n.cid, warm: true, cached: !!(j && j.cached) });
      })
      .catch((e) => {
        warmedKey = (warmedKey === key) ? '' : warmedKey;   // 网络失败同样允许重试
        warmFailAt[key] = Date.now();
        dlog('pf-resp', { cid: n.cid, warm: true, err: String(e).slice(0, 60) });
      });
    if (IS_REMOTE) {
      // 远程：不用备用元素（fMP4 + 隧道双坑），改预取整首字节，切歌秒开
      preloadNextRemote(n);
    } else {
      preloadNext(n);
    }
  }
}

// ---------------------------------------------------------------------------
// 把下一首提前缓冲到备用元素（本轮核心）。
// 延迟 2.5s 再开始：留给服务端 warm 先把文件落到 NAS 磁盘，这样手机是从自己
// 的服务器拿，不会两边同时去 B 站拉一份。
// ---------------------------------------------------------------------------
function preloadNext(n) {
  if (!n || !n.cid) return;
  const key = `${n.bvid}|${n.cid}`;
  if (key === preloadKey) return;
  preloadKey = key;
  const el = B();
  setTimeout(() => {
    if (preloadKey !== key) return;   // 期间已经切歌 / 换了预载目标
    try {
      el.preload = 'auto';
      el.src = apiUrl(`/api/play?bvid=${encodeURIComponent(n.bvid)}&cid=${encodeURIComponent(n.cid)}`);
      el.load();
      dlog('pre-set', { cid: n.cid });
    } catch {}
  }, 2500);
}

// ---------------------------------------------------------------------------
// 兜底 A：整首下载到内存，转 blob: URL 再播。
//
// 真机日志（2026-10-09 23:44，iPhone Safari + 远程 FN Connect）证明这条链路会把
// <audio> 的流式请求整个卡死：readyState 恒为 0、buffered 恒为空，每 4 秒一轮重试。
// 但同一时刻页面壳、API、连音频本体的普通 fetch 都能正常拿到 200 ——
// 说明网络本身是通的，卡的是媒体栈的「Range 流式握手」这条路。
// 于是：真起不来时就把整首 fetch 下来（只有 3MB 左右，带进度），转成 blob: URL
// 交给 <audio>，完全绕开 Range 握手。iOS Safari 播同源 blob 音频没问题。
// ---------------------------------------------------------------------------
let blobUrl = '';
let prevBlobUrl = '';   // 上一首的 blob：等下一首建好才吊销
// ⚠️ 2026-10-11：不要在切歌「开始」时就吊销当前 blob —— 非预取命中时切歌要等
// ensureWarm + 整首下载（可能数秒），这期间上一首还在放，吊销它等于边放边拆台。
// 改成惰性回收：建新 blob 时把旧的挪到 prevBlobUrl，下一次再真正 revoke。
function releaseBlob() {
  if (prevBlobUrl) { try { URL.revokeObjectURL(prevBlobUrl); } catch {} prevBlobUrl = ''; }
}
// 传数组时零拷贝合并：直接把分片交给 Blob，不再先合成一个几十 MB 的 Uint8Array
function makeBlobUrl(bytesOrParts, type) {
  prevBlobUrl = blobUrl;
  const blob = Array.isArray(bytesOrParts)
    ? new Blob(bytesOrParts, { type: type || 'audio/mp4' })
    : new Blob([bytesOrParts], { type: type || 'audio/mp4' });
  blobUrl = URL.createObjectURL(blob);
  return blobUrl;
}

async function rescueViaBlob(item, url) {
  dlog('blob-begin', { cid: item && item.cid });
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const ct = res.headers.get('content-type') || '';
  // 网关鉴权失效时返回的是纯文本 invalid token / HTML 壳页，这里必须挡住，
  // 否则会造出一个 0 字节 blob，播放器报 MEDIA_ERR_SRC_NOT_SUPPORTED 很难查。
  if (!/audio|mp4|octet-stream/i.test(ct)) {
    const t = await res.text().catch(() => '');
    throw new Error('网关返回的不是音频(' + ct + '): ' + t.slice(0, 40));
  }
  const total = Number(res.headers.get('content-length') || 0);
  let bytes;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    let last = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      got += r.value.length;
      if (Date.now() - last > 800) {
        last = Date.now();
        const mb = (n) => Math.round((n / 1048576) * 10) / 10;
        toast(total ? `下载音频 ${mb(got)}MB / ${mb(total)}MB` : `下载音频 ${mb(got)}MB`);
      }
    }
    bytes = new Uint8Array(got);
    let off = 0;
    for (const p of parts) { bytes.set(p, off); off += p.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  makeBlobUrl(bytes, 'audio/mp4');
  const a = A();
  const at = pendingStart || 0;
  a.src = blobUrl;
  pendingStart = 0;
  try { if (at > 0) a.currentTime = at; } catch {}
  await a.play();
  dlog('blob-ok', { cid: item && item.cid, bytes: bytes.length, ms: Date.now() - t0 });
}

// blob 兜底用「自己分片拉」而不是一个无 Range 的全量请求。
// 原因：全量 3.4MB 在弱网隧道里要传近 30 秒，那期间播放器的原始请求还挂着，
// 两者抢带宽，反而更慢（2026-10-10 极弱网实测）。改成主动按小块拉、串行拼接，
// 进度可见，且可以随时估算「还要多久」。
//
// ⚠️ 2026-10-11 关键修复：服务端对**每个** 206 响应有 192KB 上限
// （server.js 里的 RANGE_CHUNK，本意是让媒体栈在弱网下不触发重传风暴）。
// 旧实现按「我要多少就必须回多少」校验长度，于是每一片都判「长度不符」→
// 远程 blob 路径 100% 失败 → 每次都退回媒体栈 → 后台被 iOS 冻住。
// 真机日志实锤：`blob-prim-fail 分片 0 长度不符` + `play-fail AbortError`。
// 现在改为**按响应里的 content-range 实际推进**：服务端回多少就收多少，
// 天然适配任何分片上限，也不再需要单独发一个 1 字节探测包。
// fetchBytesChunked 只管拉字节（播放/预取共用）；fetchChunked 拉完直接接管播放。
//
// ⚠️ 2026-10-13 提速（评审 P0-4）：
// 原来「串行 192KB 一片」= 35MB 音频要 180 次往返，弱网下光 RTT 就吃掉十几秒。
// 现在改两件事：
//   1) 服务端给客户端专用的 `full=1` 参数（不截断，媒体栈那条路径仍保持 192KB 不变，
//      避免把「重传风暴」的老毛病引回来），客户端分片因此可以从 192KB 提到 2MB；
//   2) 3 路并行。串行变 3 路后，同样的 RTT 下吞吐大致翻三倍。
// 返回的是**分片数组**而不是合并后的大 Uint8Array —— 直接交给 new Blob() 就不再有
// 「先合成 35MB 再整段拷贝」这一步，省掉一份峰值内存（评审 P0-3 的一半）。
const CHUNK_STEP = 192 * 1024;      // 媒体栈/兼容路径：与服务端 RANGE_CHUNK 对齐
const BIG_STEP = 2 * 1024 * 1024;   // 客户端专用路径（配合 full=1）
const PARALLEL = 3;                 // 并线路数：再多会挤占弱网带宽，收益递减

// 单次区间请求：带重试，429 按服务端给的 Retry-After 退避（原来不看，直接三次报废）
async function fetchRange(url, start, end, signal) {
  let lastErr = null;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
      if (r.ok || r.status === 206) return r;
      // 416 = 我们排的区间越界了（服务端严格按 RFC 回的）。重试没有任何意义，
      // 立刻抛出去，好让日志里留下真凶而不是淹没在三次无效重试里。
      if (r.status === 416) throw new Error('HTTP 416 @bytes=' + start);
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after') || 0);
        const wait = ra > 0 ? Math.min(ra, 10) : 2;
        dlog('range-429', { at: start, wait });
        await new Promise((res) => setTimeout(res, wait * 1000));
        lastErr = new Error('HTTP 429');
        continue;
      }
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
      if (/HTTP 416/.test(String(e && e.message))) throw e;
    }
    await new Promise((res) => setTimeout(res, 200 * (tries + 1)));
  }
  throw lastErr || new Error('取流失败 @' + start);
}

async function fetchBytesChunked(url, { onProgress, signal, parallel, big } = {}) {
  const t0 = Date.now();
  const step = big ? BIG_STEP : CHUNK_STEP;
  const P = Math.max(1, Math.min(parallel || 1, 4));

  // ① 第一块兼作「探测」——必须**先**知道文件总长，才敢多线程排区间。
  //   2026-10-13 外网真机实锤：上一版 3 路 worker 在首片响应回来（total 才有值）
  //   之前就各自盲目排区间，第 3 路的起点直接飞过文件末尾，服务端按 RFC 回 416，
  //   整条 blob 路径报废 → iPhone 上就是「点了歌半天起不来」。
  //   为什么会漏测：内网走媒体栈路径（本地 home name）根本不进这里；
  //   而远程冒烟挑中的恰好是不足 2MB 的小文件，只够一个 worker，永不越界。
  const first = await fetchRange(url, 0, step - 1, signal);
  const ct = (first.headers.get('content-type') || '').toLowerCase();
  if (!/audio|mp4|octet-stream/i.test(ct)) {
    // 鉴权失效 / 错误页返回的不是音频，早拦掉，否则会造出 0 字节 blob
    const t = await first.text().catch(() => '');
    throw new Error('返回的不是音频(' + ct + '): ' + t.slice(0, 40));
  }
  const firstBuf = new Uint8Array(await first.arrayBuffer());
  if (!firstBuf.length) throw new Error('未取到音频数据');
  const fm = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(first.headers.get('content-range') || '');
  if (!fm || !Number(fm[3])) {
    // 服务端没给总长（忽略 Range、200 全量吐回来了）：一次就收完，也没有并行余地
    if (onProgress) onProgress(firstBuf.length, firstBuf.length, t0);
    return [firstBuf];
  }
  const total = Number(fm[3]);
  let done = firstBuf.length;
  if (onProgress) onProgress(Math.min(done, total), total, t0);
  let pos = Number(fm[2]) + 1;      // 按服务端**实际**给的末字节推进（它可能截得更小）
  if (pos >= total) return [firstBuf];

  // ② 拿到总长后再精确切块：每块的 end 都 clamp 到 total-1 —— 从根上不可能越界
  const blocks = [];
  for (let s = pos; s < total; s += step) blocks.push([s, Math.min(s + step - 1, total - 1)]);
  const slots = new Array(blocks.length).fill(null);   // 按块号落位：谁先回来都不打乱顺序
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= blocks.length) return;
      const bs = blocks[i][0];
      const be = blocks[i][1];
      const acc = [];
      let off = bs;
      // 服务端仍可能把一块拆成多次吐（例如退回到 192KB 上限）：循环补齐这一块为止
      while (off <= be) {
        const r = await fetchRange(url, off, be, signal);
        if (r.status !== 206) {
          // 中间层忽略 Range 会回 200 全量：静默拼下去得到的是
          // [首块, 整首, 整首…] 的坏数据，听感是杂音/卡死还查不出原因。
          // 当场报错，让上层走兜底路径。
          dlog('chunk-200', { at: off, st: r.status });
          throw new Error('Range 被忽略(HTTP ' + r.status + ') @' + off);
        }
        const b = new Uint8Array(await r.arrayBuffer());
        if (!b.length) throw new Error('空响应 @' + off);
        acc.push(b);
        const mm = /bytes\s+(\d+)-(\d+)\//.exec(r.headers.get('content-range') || '');
        off = mm ? Number(mm[2]) + 1 : be + 1;   // 无 content-range = 200 全量，到头了
        done += b.length;
        if (onProgress) onProgress(Math.min(done, total), total, t0);
      }
      slots[i] = acc;
    }
  }
  await Promise.all(Array.from({ length: P }, () => worker()));

  const out = [firstBuf];
  for (const seg of slots) { for (const b of seg) out.push(b); }
  const got = partsBytes(out);
  if (got !== total) dlog('chunk-len-mismatch', { got, total });
  return out;
}

function partsBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  return n;
}

function blobFromBytes(bytes) {
  return makeBlobUrl(bytes, 'audio/mp4');
}

async function fetchChunked(item, url) {
  const t0 = Date.now();
  const parts = await fetchBytesChunked(url, {
    big: true,
    parallel: PARALLEL,
    onProgress: (got, total, t0_) => {
      const mb = (n) => Math.round((n / 1048576) * 10) / 10;
      const eta = Math.round((Date.now() - t0_) / got * (total - got) / 1000);
      toast(`下载音频 ${mb(got)}MB / ${mb(total)}MB（约 ${eta}s）`);
    },
  });
  blobFromBytes(parts);
  const a = A();
  const at = pendingStart || 0;
  a.src = blobUrl;
  pendingStart = 0;
  try { if (at > 0) a.currentTime = at; } catch {}
  await a.play();
  dlog('blob-ok', {
    cid: item && item.cid, bytes: partsBytes(parts), ms: Date.now() - t0,
    mode: 'chunked', par: PARALLEL, chunks: parts.length,
  });
}

// ---------------------------------------------------------------------------
// 远程预取：当前歌播放期间，把下一首整首拉成字节放在内存里。
// 远程隧道下媒体栈连「预载到备用元素」都不靠谱（备用元素里也是 fMP4，
// iOS 只解析出 20s，切过去一样坏），所以远程干脆不用备用元素，
// 改成纯字节预取 —— 切歌时 blob 秒建，体验与局域网换元素相当。
// ---------------------------------------------------------------------------
let remotePreload = null;   // { key, parts }
let remotePreloadFailAt = 0;
function preloadNextRemote(n) {
  const key = `${n.bvid}|${n.cid}`;
  if (remotePreload && remotePreload.key === key) return;
  // 失败退避（评审 P1-3）：以前预取一失败就永远不再试，之后每首都现场下载。
  // 现在 60 秒后允许重试 —— 通勤时信号弱一下，出隧道还能恢复。
  if (Date.now() - remotePreloadFailAt < WARM_RETRY_MS) return;
  const url = apiUrl(`/api/play?bvid=${encodeURIComponent(n.bvid)}&cid=${encodeURIComponent(n.cid)}&full=1`);
  const my = { key, parts: null };
  remotePreload = my;
  fetchBytesChunked(url, { big: true, parallel: PARALLEL }).then((parts) => {
    if (remotePreload === my) my.parts = parts;
    dlog('rp-ok', { cid: n.cid, bytes: partsBytes(parts), chunks: parts.length });
  }).catch((e) => {
    if (remotePreload === my) remotePreload = null;
    remotePreloadFailAt = Date.now();
    warmedKey = (warmedKey === key) ? '' : warmedKey;   // 允许下一轮重试
    dlog('rp-fail', { cid: n.cid, msg: String(e).slice(0, 60) });
  });
}

// ---------------------------------------------------------------------------
// stall 自愈：换源后迟迟一个字节都不到时主动 load() 重试 —— 总好过干等 iOS 冻结页面。
//
// 关键（2026-10-09 实测教训）：弱网（远程 FN Connect 隧道）下下载一首要十几秒，
// 旧版「4 秒没到就 reload」等于每 4 秒把已经传了一半的数据全部作废重来 ——
// 传得越慢越被重置，形成永远播不出来的死锁（真机日志里就是每 4 秒一轮 stall-retry）。
// 现在改成：只要 buffer 还在长，就认定链路是通的，绝不打断；只有真的
// 「连续 15 秒一个字节都没多」才重试，且最多重试 5 次，避免重试风暴。
// ---------------------------------------------------------------------------
let rescueTried = false;
let stallTimer = 0;
function armStallWatch() {
  if (stallTimer) { clearInterval(stallTimer); stallTimer = 0; }
  let bad = 0;
  let retries = 0;
  let lastEnd = 0;
  stallTimer = setInterval(() => {
    const a = A();
    if (!a.src || (a.paused && !wantPlay)) {
      clearInterval(stallTimer);
      stallTimer = 0;
      return;
    }
    if (a.readyState >= 3) { bad = 0; retries = 0; return; }
    // buffer 还在增长 = 正在下载，慢一点没关系，别去打断它
    let end = 0;
    try { end = a.buffered.length ? a.buffered.end(a.buffered.length - 1) : 0; } catch {}
    if (end > lastEnd + 0.01) { lastEnd = end; bad = 0; return; }
    if (a.networkState === 2 || a.networkState === 3) {
      bad++;
      // 14 秒还一个字节都没进来 → 媒体栈这条路确认废了，切 blob 兜底。
      // 之所以不是 8 秒：过早切换时<audio> 的原始请求还挂着，会和 blob 下载抢带宽，
      // 反而更慢（2026-10-10 极弱网实测）。切之前先把原请求 abort 掉。
      if (!rescueTried && bad >= 14) {
        rescueTried = true;
        bad = 0;
        const it = queue[current];
        const u = a.src;
        dlog('blob-switch', { rs: a.readyState, ns: a.networkState });
        try { a.pause(); a.removeAttribute('src'); a.load(); } catch {}
        fetchChunked(it, u).catch((e) => {
          dlog('blob-fail', { msg: String((e && e.message) || e).slice(0, 100) });
          toast('音频加载失败：' + String((e && e.message) || e).slice(0, 40));
        });
        return;
      }
      const limit = a.networkState === 3 ? 3 : 15;
      if (bad >= limit && retries < 5) {
        bad = 0;
        retries++;
        lastEnd = 0;
        dlog('stall-retry', { rs: a.readyState, ns: a.networkState, retries });
        try { a.load(); a.play().catch(() => {}); } catch {}
      }
    } else { bad = 0; }
  }, 1000);
}

// ---------------------------------------------------------------------------
// 补齐后续段落：从收藏夹 / 最近播放进来时只知道某一个 cid，但这个视频可能是
// 十几段的分P合辑。这里后台把"当前段之后"的其余段插进队列，让连播接得上。
// 只补后面的，不往前回溯（用户点第 5 段就从第 5 段往后听）。
// ---------------------------------------------------------------------------
async function fillRestParts(item, atIdx) {
  try {
    const r = await apiGet(`/api/resolve?bvid=${encodeURIComponent(item.bvid)}`);
    let group = null;
    let label = '';
    if (r.pages && r.pages.length > 1) {
      group = r.pages.map((pg) => ({
        bvid: item.bvid,
        cid: pg.cid,
        title: pg.part && pg.part !== r.title ? (pg.part || r.title) : r.title,
        lyricKey: pg.part && pg.part !== r.title ? pg.part : '',
        author: r.author || item.author,
        pic: r.pic || item.pic,
        duration: pg.duration || 0,
        _partsResolved: true,
      }));
      label = `合辑 · ${group.length} 首`;
    } else if (r.season && r.season.items.length > 1) {
      group = r.season.items.map((x) => ({ ...x, _seasonSeen: true, _partsResolved: true }));
      label = `合集「${r.season.title || '歌单'}」 · ${group.length} 首`;
    }
    if (!group) return;

    let at = group.findIndex((x) => String(x.cid) === String(item.cid));
    if (at < 0) at = 0;
    const rest = group.slice(at + 1);
    if (!rest.length) return;

    // 已经在队列里的不再重复插
    const have = new Set(queue.map((x) => String(x.cid)));
    const add = rest.filter((x) => !have.has(String(x.cid)));
    if (!add.length) return;

    const at2 = Math.max(0, Math.min(atIdx, queue.length - 1));
    queue.splice(at2 + 1, 0, ...add);
    showAlbumBar(group, label);
    toast(`已续接 ${add.length} 首`);
    prefetchNext();
  } catch { /* 补不齐也不影响当前这首正常播 */ }
}

// ---------------------------------------------------------------------------
// 自动续播被系统拦下时的恢复机制。
// wantPlay：用户期望"正在播"的状态（点了暂停就是 false，被系统拦下仍是 true）。
// armAutoResume：被拒后每 0.8s 重试一次 play()。iOS 后台会节流定时器，但回到
//   前台那一刻 visibilitychange 会立刻补一次，所以不需要用户点屏幕。
//   重试 60 次（约 48 秒）还不行，才退化成"轻点屏幕继续播放"。
// ---------------------------------------------------------------------------
let resumeTimer = 0;
function stopResumeRetry() {
  if (resumeTimer) {
    clearInterval(resumeTimer);
    resumeTimer = 0;
  }
}
function armAutoResume() {
  wantPlay = true;
  dlog('ar-arm');
  if (resumeTimer) return;
  let tries = 0;
  resumeTimer = setInterval(() => {
    if (!A().paused || !A().src) {
      stopResumeRetry();
      return;
    }
    tries++;
    A().play().then(() => {
      stopResumeRetry();
      setPlayIcon(true);
      dlog('ar-ok', { tries });
    }).catch((e) => {
      dlog('ar-try', { tries, name: e && e.name });
      if (tries >= 60) {
        stopResumeRetry();
        armGestureResume();
      }
    });
  }, 800);
}
function tryResumeNow() {
  if (wantPlay && A().src && A().paused) {
    dlog('resume-now');
    A().play().then(() => { setPlayIcon(true); stopResumeRetry(); }).catch((e) => {
      dlog('resume-fail', { name: e && e.name });
    });
  }
}

let gestureArmed = false;
function armGestureResume() {
  if (gestureArmed) return;
  gestureArmed = true;
  toast('轻点屏幕继续播放');
  const names = ['touchend', 'pointerdown', 'click'];
  const resume = () => {
    gestureArmed = false;
    names.forEach((n) => window.removeEventListener(n, resume));
    A().play().then(() => setPlayIcon(true)).catch(() => {});
  };
  names.forEach((n) => window.addEventListener(n, resume, { passive: true }));
}

// ---------------------------------------------------------------------------
// 最近播放 / 断点续播：每 8 秒记一次进度，页面退到后台或暂停也会记一次。
// 记在服务端是为了换手机打开也是同一份记录。
// ---------------------------------------------------------------------------
let lastReportAt = 0;
function reportPosition(force) {
  const item = queue[current];
  if (!item || !item.cid) return;
  const now = Date.now();
  if (!force && now - lastReportAt < 8000) return;
  lastReportAt = now;
  // 退后台/锁屏瞬间（pagehide、visibilitychange=hidden）用 sendBeacon：
  // iOS 在这两个时机基本不发普通 fetch（评审 P1-5），续播进度经常就这么丢了。
  // sendBeacon 是浏览器承诺「页面死了也会发出去」的通道，正好用来做这件事。
  const body = JSON.stringify({ item, position: A().currentTime || 0 });
  const url = apiUrl('/api/history');
  if (force && navigator.sendBeacon) {
    try { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); return; } catch {}
  }
  apiSend('/api/history', 'POST', { item, position: A().currentTime || 0 }).catch(() => {});
}

// 元数据就绪后应用"续播起点"（不能直接 seek，得等 duration 出来）
onA('loadedmetadata', () => {
  if (pendingStart > 0 && pendingStart < (A().duration || Infinity) - 2) {
    try { A().currentTime = pendingStart; } catch {}
    toast(`已从第 ${fmtTime(pendingStart)} 接着听`);
  }
  pendingStart = 0;
});
document.addEventListener('visibilitychange', () => {
  dlog('vis', { hidden: document.hidden });
  if (document.hidden) { reportPosition(true); flushDiag(true); return; }
  // 回到前台：iOS 在后台经常把 'ended' 吞掉（拖到回前台才补发，甚至不补发），
  // 所以这里主动检查"停在结尾"的情况，立刻接下一首。这正是老汪反馈的
  // 「只有打开界面才会自动播放下一首」——回到界面就该马上接上。
  const dur = A().duration || 0;
  if (dur && A().paused && A().currentTime >= dur - 1.5) {
    reportPosition(true);
    advance('resume');
    return;
  }
  // 后台期间被 stall 卡住的：回到前台立刻重拉一次，不等它自己缓
  if (wantPlay && A().src && A().readyState < 3) {
    dlog('resume-reload', { rs: A().readyState, ns: A().networkState });
    try { A().load(); } catch {}
  }
  tryResumeNow();
  prefetchNext(A().duration ? (A().duration - A().currentTime) < WARM_LEFT : false);
});
window.addEventListener('pagehide', () => reportPosition(true));

// 断网恢复自动续播（评审 P1-6）：以前 online 事件只写日志 —— 地铁出隧道、
// WiFi 切回蜂窝后音乐不会自己回来，锁屏下用户甚至不知道已经停了。
// 只在「本来就该在放」（wantPlay）时才接，用户手动暂停的不算。
window.addEventListener('online', () => {
  dlog('net:online');
  if (wantPlay && A().src && A().paused) {
    dlog('net:resume');
    A().play().catch(() => armAutoResume());
  }
});

// ---------------------------------------------------------------------------
// 播放失败自动恢复：移动网络下 CDN 断流很常见，error 后带断点重连（最多 2 次）
// ---------------------------------------------------------------------------
let audioRetry = 0;
onA('playing', () => { audioRetry = 0; });
// 错误要分类说人话（评审 P1-7）：以前一律「网络抖动，再点一次」——
// B 站风控 412 时引导用户反复点 = 越点越糟；解码错误重试一百次也没用。
function mediaErrText(code) {
  switch (code) {
    case 1: return '播放被打断';
    case 2: return '网络中断';
    case 3: return '音频解码失败（文件可能不完整，去服务端缓存里删掉这首可恢复）';
    case 4: return '拿不到音频（可能触发 B 站风控，或这首没有单独音轨）';
    default: return '播放出错';
  }
}
onA('error', () => {
  const item = queue[current];
  if (!item || !item.cid || !A().src) return;
  const code = A().error && A().error.code;
  dlog('a-err', { code, msg: (A().error && A().error.message || '').slice(0, 60) });
  // 解码错误（3）：源文件坏了，重试同一份没有意义，直接停并说清楚
  if (code === 3) {
    pauseByUser('decode-err');
    toast(mediaErrText(3));
    return;
  }
  // 拿不到资源（4）：多半是 B 站风控/直链失效 —— 自动重试一次（服务端会刷直链），
  // 但文案要引导等一等，而不是「再点一次」
  const maxRetry = code === 4 ? 1 : 2;
  if (audioRetry >= maxRetry) {
    setPlayIcon(false);
    toast(code === 4
      ? '取不到音频，等一两分钟再试（B 站风控通常很快解除）'
      : '网络不稳，点一下 ▶ 再试试');
    return;
  }
  audioRetry++;
  const el = A();
  const resumeAt = el.currentTime || 0;
  toast(`${mediaErrText(code)}，自动重连（${audioRetry}/${maxRetry}）…`);
  if (code === 4) {
    // 让服务端作废 playurl 缓存重新取直链：加 _r 已经换 URL，服务端 playurlCache
    // 按 bvid|cid 键 —— 失效直链的典型表现就是重连也 403，这里靠服务端重取
    el.src = apiUrl(`/api/play?bvid=${encodeURIComponent(item.bvid)}&cid=${item.cid}&refresh=1&_r=${Date.now()}`);
  } else {
    el.src = apiUrl(`/api/play?bvid=${encodeURIComponent(item.bvid)}&cid=${item.cid}&_r=${Date.now()}`);
  }
  el.load();
  const onMeta = () => {
    el.removeEventListener('loadedmetadata', onMeta);
    if (resumeAt > 0 && resumeAt < (el.duration || Infinity) - 2) {
      try { el.currentTime = resumeAt; } catch {}
    }
    el.play().catch(() => {});
  };
  el.addEventListener('loadedmetadata', onMeta);
});

function updatePlayerMeta(item) {
  $('#pCover').src = item.pic || '';
  $('#pTitle').textContent = item.title || '未知标题';
  $('#pAuthor').textContent = item.author || '';
  // 歌词面板头部
  $('#lyPic').src = item.pic || '';
  $('#lyTitle').textContent = item.title || '未知标题';
  $('#lyAuthor').textContent = item.author || '';
  updateMediaSession(item);
  refreshFavState();
}

// ---------------------------------------------------------------------------
// 锁屏 / 控制中心媒体信息：iOS 锁屏界面显示歌名、封面，可直接切歌
// ---------------------------------------------------------------------------
// 锁屏界面要显示"正在播放/已暂停"，iOS 才不会提前回收这个音频会话
function setMSPlaybackState(s) {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = s; } catch {}
}

// 锁屏「上一首/下一首」必须走 advance()，不能自己算索引：
//   a) 随机模式下 playIndex(current+1) 播的是队列里的下一首，不是随机下一首 —— 语义错；
//   b) 单曲循环模式下应该重播本首，而不是跳走；
//   c) 顺序模式到队尾时 playIndex(越界) 会静默失败 —— 表现就是「锁屏点了没反应」。
// advance() 内部已经按 playMode 处理了全部四种情况，这里复用它。
const MS_SKIP = 15;
function msNext() { advance('ms-next'); }

function msPrev() {
  const a = A();
  // 与主流播放器一致：已经听了 3 秒以上，「上一首」= 重头听这一首
  if (a.currentTime > 3) {
    try { a.currentTime = 0; syncPositionState(true); } catch {}
    return;
  }
  if (!queue.length) return;
  if (playMode === 'shuffle') { advance('ms-prev'); return; }
  let idx = current - 1;
  if (idx < 0) idx = playMode === 'loop' ? queue.length - 1 : 0;
  playIndex(idx);
}

function msSeekBy(delta) {
  const a = A();
  if (!a.duration) return;
  try {
    a.currentTime = Math.max(0, Math.min(a.currentTime + delta, a.duration));
    syncPositionState(true);
  } catch {}
}

function updateMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title || '未知标题',
      artist: item.author || '',
      album: 'B站音乐 · 随身听',
      artwork: item.pic ? [
        { src: item.pic, sizes: '512x512', type: 'image/jpeg' },
        { src: item.pic, sizes: '256x256', type: 'image/jpeg' },
      ] : [],
    });
    navigator.mediaSession.setActionHandler('play', () => A().play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => A().pause());
    navigator.mediaSession.setActionHandler('previoustrack', msPrev);
    navigator.mediaSession.setActionHandler('nexttrack', msNext);
    // 快进 / 快退 / 定位：有这几个，iOS 控制中心与 CarPlay 才显示进度条并允许拖动
    try {
      navigator.mediaSession.setActionHandler('seekbackward', (d) => msSeekBy(-((d && d.seekOffset) || MS_SKIP)));
      navigator.mediaSession.setActionHandler('seekforward', (d) => msSeekBy((d && d.seekOffset) || MS_SKIP));
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        const a = A();
        if (!a.duration || !d || d.seekTime == null) return;
        try {
          a.currentTime = Math.max(0, Math.min(d.seekTime, a.duration));
          syncPositionState(true);
        } catch {}
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        try { A().currentTime = 0; } catch {}
        pauseByUser('ms-stop');   // 锁屏「停止」同样要清 wantPlay
      });
    } catch {}
  } catch {}
}

let lastPosSync = 0;
function syncPositionState(force) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (!force && now - lastPosSync < 3000) return;  // 3 秒同步一次足够
  lastPosSync = now;
  try {
    if (A().duration) {
      navigator.mediaSession.setPositionState({
        duration: A().duration,
        playbackRate: A().playbackRate,
        position: Math.min(A().currentTime, A().duration),
      });
    }
  } catch {}
}

// iOS 会拿 MediaSession 判断"这个页面还在不在放歌"，后台时更要定期刷新 ——
// 刷得不勤，系统可能提前回收音频会话 / 冻结页面（真机日志里正是这个现象）。
setInterval(() => {
  if (!A().src) return;
  setMSPlaybackState(A().paused ? 'paused' : 'playing');
  syncPositionState(true);
}, 3000);

// ---------------------------------------------------------------------------
// 播放/暂停按钮（SVG 图标切换）
// ---------------------------------------------------------------------------
const ICON_PLAY = '<path d="M6 3.5v11l9-5.5z" fill="currentColor" stroke="none"/>';
const ICON_PAUSE = '<path d="M6 4v10M12 4v10"/>';
function setPlayIcon(playing) {
  $('#playIcon').innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
}

$('#playBtn').addEventListener('click', () => {
  if (!A().src) return;
  if (A().paused) {
    wantPlay = true;
    A().play().then(() => { setPlayIcon(true); stopResumeRetry(); }).catch(() => armAutoResume());
  } else {
    pauseByUser('tap');
  }
});

// 「暂停」必须统一走这里 —— 只 pause() 不清 wantPlay，回到前台会被自动续播：
// 睡眠定时到点后第二天一开 app 音乐自己响起来，就是这个洞（wantPlay 还挂着 true）。
function pauseByUser(reason) {
  wantPlay = false;
  stopResumeRetry();
  try { A().pause(); } catch {}
  setPlayIcon(false);
  if (reason) dlog('pause-by-user', { reason });
}

// 界面上的上一首/下一首也必须走 advance()/retreat()，不能自己算索引 ——
// 理由和上面锁屏那段注释一样（单曲循环会跳歌、随机不对、队尾静默没反应）。
// 以前这里写的是 playIndex(current±1)，锁屏做对了而界面没跟上。
$('#prevBtn').addEventListener('click', () => retreat('btn'));
$('#nextBtn').addEventListener('click', () => advance('btn'));

onA('play', () => { setPlayIcon(true); setMSPlaybackState('playing'); });
onA('pause', () => { setPlayIcon(false); setMSPlaybackState('paused'); });
// 一首放完：按播放模式决定下一首（以前只有"顺序播到尾就停"）
onA('ended', () => {
  dlog('ended');
  reportPosition(true);
  advance('ended');
});

function pickShuffle() {
  if (queue.length <= 1) return -1;
  let idx = current;
  for (let guard = 0; guard < 20 && idx === current; guard++) {
    idx = Math.floor(Math.random() * queue.length);
  }
  return idx === current ? -1 : idx;
}

// ---------------------------------------------------------------------------
// iOS 后台连播（本轮重点修的 BUG）
// 现象：iPhone 上只有界面在前台才会自动播下一首，锁屏 / 切到别的 App 就不播。
// 两条原因，方案同时覆盖：
//   ① iOS 后台会节流甚至挂起页面 JS，'ended' 事件经常不派发，要等回到前台才补
//      → 不等 ended：还剩 GAP_LEAD 秒时就在"播放中"切换（此时 JS 还活着、
//        元素处于 playing 且已被用户手势解锁，换 src 属于续播而非新的播放请求）；
//        另外回到前台时再补一次检查（见上面的 visibilitychange）。
//   ② 切歌是一次全新网络请求，iOS 后台对新资源加载不友好，play() 也常在
//      非手势上下文被拒 → 服务端提前把下一首音频预热到磁盘（prefetch warm=1），
//      切歌时本地直读；被拒后自动重试（armAutoResume）。
// ---------------------------------------------------------------------------
const GAP_LEAD = 0.5;    // 提前多少秒切（顺带做到近乎无缝连播）
const WARM_LEFT = 90;    // 剩多少秒时开始把下一首整段拉到服务端缓存
let advancing = false;
let queueEnded = false;  // 队列已播完（避免提前切 + ended 各弹一次提示）

// ⚠️ 2026-10-11 修复「后台切歌连跳好几首」：旧版 advancing 只在同步段内有效，
// playIndex 是异步的（要等 warm / 取流），这期间 <audio> 还是上一首的尾部，
// timeupdate 会一遍遍判定 left<=GAP_LEAD → 反复 advance → 一秒内跳掉 3 首
// （真机日志：09:38:46→09:38:47 连跳 idx 8/10/11，全是 AbortError）。
// 现在把 advance 全程 async 化，整个切换过程都持有锁，一次切换只发生一次。
async function advance(reason) {
  dlog('advance', { reason, from: current, mode: playMode, qlen: queue.length, dup: advancing });
  if (advancing) return;
  advancing = true;
  try {
    await advanceInner(reason);
  } catch (e) {
    dlog('advance-err', { msg: String((e && e.message) || e).slice(0, 60) });
  } finally {
    advancing = false;
  }
}

async function advanceInner() {
  const len = queue.length;
  if (!len) return;
  if (playMode === 'single') {
    A().currentTime = 0;
    await A().play().catch(() => armAutoResume());
    return;
  }
  if (playMode === 'shuffle') {
    const idx = pickShuffle();
    if (idx < 0) { setPlayIcon(false); return; }
    await playIndex(idx);
    return;
  }
  if (playMode === 'loop') {
    await playIndex((current + 1) % len);
    return;
  }
  // seq：到队尾自然停止（提前切和 ended 会各触发一次，用 queueEnded 去重）
  if (current + 1 < len) await playIndex(current + 1);
  else if (!queueEnded) {
    queueEnded = true;
    setPlayIcon(false);
    wantPlay = false;
    toast('队列播完了');
  }
}

// 「上一首」：和 advance 对称的一套。以前界面按钮直接 playIndex(current-1)，
// 顺序模式到第一首点了没反应、列表循环不会绕回最后一首、随机也失效。
async function retreat(reason) {
  dlog('retreat', { reason, from: current, mode: playMode, qlen: queue.length });
  if (advancing) return;
  advancing = true;
  try { await retreatInner(); } catch (e) {
    dlog('retreat-err', { msg: String((e && e.message) || e).slice(0, 60) });
  } finally { advancing = false; }
}

async function retreatInner() {
  const len = queue.length;
  if (!len) return;
  queueEnded = false;
  if (playMode === 'single') {
    A().currentTime = 0;
    await A().play().catch(() => armAutoResume());
    return;
  }
  if (playMode === 'shuffle') {
    const idx = pickShuffle();
    if (idx < 0) { setPlayIcon(false); return; }
    await playIndex(idx);
    return;
  }
  if (playMode === 'loop') {
    await playIndex((current - 1 + len) % len);
    return;
  }
  if (current - 1 >= 0) await playIndex(current - 1);
  else toast('已经是第一首了');
}

// ---------------------------------------------------------------------------
// 诊断接线：媒体事件 + 每秒心跳 + 每 5 秒上报（DIAG_ON 时才挂）
// 心跳是关键：如果后台心跳断了，就证明 iOS 把页面 JS 整个挂起了 —— 那时
// 页面里再怎么写定时器都没用，只能靠系统侧的 MediaSession / 回前台补切。
// ---------------------------------------------------------------------------
if (DIAG_ON) {
  dlog('boot', {
    ua: navigator.userAgent.slice(0, 140),
    ios: /iP(hone|ad|od)/.test(navigator.userAgent),
    ms: 'mediaSession' in navigator,
    sw: 'serviceWorker' in navigator,
    sec: window.isSecureContext,
    mode: playMode,
  });
  ['play', 'pause', 'ended', 'waiting', 'stalled', 'suspend', 'canplay', 'canplaythrough',
    'playing', 'loadstart', 'emptied', 'seeked', 'ratechange', 'durationchange'].forEach((n) => {
    audioEls.forEach((el, i) => {
      el.addEventListener(n, () => dlog('m:' + n, { el: i === audioIdx ? 'A' : 'B' }));
    });
  });
  audioEls.forEach((el, i) => {
    el.addEventListener('error', () => {
      const e = el.error;
      dlog('m:error', {
        el: i === audioIdx ? 'A' : 'B',
        code: e && e.code,
        msg: e && e.message ? String(e.message).slice(0, 80) : '',
      });
    });
  });
  setInterval(() => dlog('tick'), 1000);
  setInterval(() => flushDiag(false), 5000);
  window.addEventListener('pagehide', () => { dlog('pagehide'); flushDiag(true); });
  window.addEventListener('offline', () => dlog('net:offline'));

  // ?diag=1 时显示"导出诊断日志"按钮：点了会立刻上传并尝试复制到剪贴板
  if (new URLSearchParams(location.search).get('diag') === '1') {
    const btn = document.createElement('button');
    btn.textContent = '⤴ 导出诊断日志';
    btn.style.cssText = 'position:fixed;right:8px;bottom:104px;z-index:9999;font-size:12px;'
      + 'padding:7px 11px;border-radius:10px;border:1px solid #666;background:#1b1b1b;'
      + 'color:#eee;opacity:.9;box-shadow:0 2px 8px rgba(0,0,0,.4)';
    btn.addEventListener('click', () => {
      const txt = DIAG.buf.map((r) => JSON.stringify(r)).join('\n');
      flushDiag(false);
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt);
          copied = true;
        }
      } catch {}
      alert(`已导出 ${DIAG.buf.length || 0} 条（共记录 ${txt ? txt.split('\n').length : 0} 行）\n`
        + (copied ? '已尝试复制到剪贴板；' : '') + '同时已上传到 NAS 日志。');
    });
    document.body.appendChild(btn);
  }
}

const MODE_LABEL = { seq: '顺序播放', loop: '列表循环', single: '单曲循环', shuffle: '随机播放' };
function syncModeUI() {
  $$('#modeBtns .mchip').forEach((b) => b.classList.toggle('on', b.dataset.mode === playMode));
}
$$('#modeBtns .mchip').forEach((b) => {
  b.addEventListener('click', () => {
    playMode = b.dataset.mode;
    localStorage.setItem('bm_mode', playMode);
    syncModeUI();
    toast(MODE_LABEL[playMode] || playMode);
  });
});
syncModeUI();

// ---------------------------------------------------------------------------
// 睡眠定时：睡前听歌场景。到点暂停播放，迷你条上显示剩余时间。
// ---------------------------------------------------------------------------
let sleepTimer = null;
function setSleep(min) {
  if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
  $$('#sleepBtns .mchip').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === min));
  if (!min) {
    sleepEndAt = 0;
    $('#sleepTag').classList.add('hidden');
    toast('睡眠定时已关闭');
    return;
  }
  sleepEndAt = Date.now() + min * 60000;
  $('#sleepTag').classList.remove('hidden');
  toast(`${min} 分钟后停止播放`);
  sleepTimer = setInterval(tickSleep, 1000);
  tickSleep();
}
function tickSleep() {
  if (!sleepEndAt) return;
  const left = Math.max(0, sleepEndAt - Date.now());
  if (left <= 0) {
    setSleep(0);
    pauseByUser('sleep');   // 必须清 wantPlay，否则下次打开 app 会从昨天的进度自动放起来
    toast('睡眠定时到，已停止播放');
    return;
  }
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  $('#sleepTag').textContent = ` ⏲ ${m}:${String(s).padStart(2, '0')}`;
}
$$('#sleepBtns .mchip').forEach((b) => {
  b.addEventListener('click', () => setSleep(Number(b.dataset.min) || 0));
});

onA('timeupdate', () => {
  const cur = A().currentTime;
  const dur = A().duration || 0;
  $('#curTime').textContent = fmtTime(cur);
  $('#durTime').textContent = fmtTime(dur);
  if (dur) $('#seek').value = (cur / dur) * 100;
  if (dur && !A().paused) {
    const left = dur - cur;
    // 还剩 GAP_LEAD 秒就切下一首 —— 不等 ended：iOS 后台经常不派发这个事件。
    // 用「窗口判定」而不是精确等号：后台 timeupdate 会被节流到 1~2 秒一次，
    // 窗口太窄会整段被跳过（这就是"有时能连播、有时停住"的来源之一）。
    if (left <= GAP_LEAD && left > -2) {
      dlog('early', { left: Math.round(left * 100) / 100 });
      reportPosition(true);
      advance('early');
      return;
    }
    // 快播到尾时把下一首准备好；最后 WARM_LEFT 秒把音频本体也预载好
    if (cur / dur > 0.4) prefetchNext(left < WARM_LEFT);
  }
  highlightLyric(cur);
  syncPositionState();
  reportPosition();
});

$('#seek').addEventListener('input', () => {
  const dur = A().duration || 0;
  if (dur) A().currentTime = (Number($('#seek').value) / 100) * dur;
});

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------
const LYRIC_SRC_LABEL = { tencent: 'QQ音乐', netease: '网易云', lrclib: 'lrclib', none: '' };

// 歌词时间轴偏移按曲目分别记忆：同一个合辑里不同歌的 LRC 质量不一样
function offsetKey(item) { return item ? `${item.bvid}|${item.cid || 0}` : ''; }
function fmtOffset(v) { return (v > 0 ? '+' : '') + v.toFixed(1) + 's'; }
function loadLyricOffset(item) {
  const k = offsetKey(item);
  lyricOffset = Number(localStorage.getItem('bm_lyoff_' + k) || 0) || 0;
  $('#lyOffset').textContent = fmtOffset(lyricOffset);
}
function adjustLyricOffset(delta, reset) {
  lyricOffset = reset ? 0 : Math.round((lyricOffset + delta) * 10) / 10;
  lyricOffset = Math.max(-10, Math.min(10, lyricOffset));
  const k = offsetKey(queue[current]);
  if (k) localStorage.setItem('bm_lyoff_' + k, String(lyricOffset));
  $('#lyOffset').textContent = fmtOffset(lyricOffset);
  highlightLyric(A().currentTime, true);
}
$('#lyMinus').addEventListener('click', () => adjustLyricOffset(-0.5));
$('#lyPlus').addEventListener('click', () => adjustLyricOffset(0.5));
$('#lyReset').addEventListener('click', () => adjustLyricOffset(0, true));

async function loadLyrics(item) {
  lyricLines = [];
  lyricTimed = false;
  $('#lyricsBody').innerHTML = '<div class="line">歌词加载中…</div>';
  loadLyricOffset(item);
  try {
    // 多P合辑用分P歌名查（lyricKey），比视频标题准；再把 UP 主名传给后端做第二候选词
    const t = item.lyricKey || item.title || '';
    let url = `/api/lyrics?bvid=${encodeURIComponent(item.bvid)}&title=${encodeURIComponent(t)}`;
    if (item.author) url += `&author=${encodeURIComponent(item.author)}`;
    const r = await apiGet(url);
    if (!r.found) {
      lyricLines = [{ time: -1, text: '暂无歌词' }];
    } else {
      lyricLines = parseLyric(r.lines || []);
      lyricTimed = lyricLines.some((l) => l.time >= 0);
      if (!lyricTimed) lyricLines.unshift({ time: -1, text: '（这份歌词没有时间轴）' });
      const label = LYRIC_SRC_LABEL[r.source];
      if (label) $('#lyAuthor').textContent = (item.author ? item.author + ' · ' : '') + '词源 ' + label;
    }
    renderLyrics();
    highlightLyric(A().currentTime, true);
  } catch {
    lyricLines = [{ time: -1, text: '歌词加载失败' }];
    renderLyrics();
  }
}

function parseLyric(rawLines) {
  const out = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  // LRC 元数据头（[ti:..] [ar:..] [al:..] [offset:..] 等）不是歌词行，剥掉
  const metaRe = /\[[a-zA-Z]+:[^\]]*\]/g;
  for (const line of rawLines) {
    const text = line.replace(re, '').replace(metaRe, '').trim();
    const m = re.exec(line);
    re.lastIndex = 0;
    if (m) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0);
      out.push({ time: t, text: text || '♪' });
    } else if (text) {
      out.push({ time: -1, text });
    }
  }
  if (!out.length) rawLines.forEach((l) => out.push({ time: -1, text: l }));
  return out.sort((a, b) => a.time - b.time);
}

function renderLyrics() {
  const body = $('#lyricsBody');
  body.innerHTML = '';
  lyricLines.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'line';
    div.dataset.idx = i;
    if (l.time >= 0) {
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(l.time);
      div.appendChild(ts);
    }
    div.appendChild(document.createTextNode(l.text));
    body.appendChild(div);
  });
}

function highlightLyric(cur, force) {
  if (!lyricTimed) return;
  // 正偏移 = 歌词整体延后出现，所以拿"当前时间 - 偏移"去比对行
  const base = (cur || 0) - lyricOffset;
  let idx = 0;
  for (let i = 0; i < lyricLines.length; i++) {
    if (lyricLines[i].time <= base) idx = i; else break;
  }
  const active = $(`#lyricsBody .line[data-idx="${idx}"]`);
  if (!active) return;
  if (force || !active.classList.contains('active')) {
    $$('#lyricsBody .line').forEach((el) => el.classList.remove('active'));
    active.classList.add('active');
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

$('#lyricsBtn').addEventListener('click', () => $('#lyricsPanel').classList.remove('hidden'));
$('#lyricsClose').addEventListener('click', () => $('#lyricsPanel').classList.add('hidden'));
// 点迷你条的封面 / 歌名区域也能展开歌词
document.querySelector('.mini .thumb').addEventListener('click', () => $('#lyricsPanel').classList.remove('hidden'));
document.querySelector('.mini .info').addEventListener('click', () => $('#lyricsPanel').classList.remove('hidden'));

// ---------------------------------------------------------------------------
// 文本输入弹层：inputSheet({title, value, okText}) -> Promise<string|null>
// iOS 原生 prompt 在 standalone 模式下样式割裂，统一换成自家弹层
// ---------------------------------------------------------------------------
function inputSheet({ title, value = '', placeholder = '', okText = '确定' }) {
  return new Promise((resolve) => {
    const sheet = $('#inSheet');
    const mask = $('#inMask');
    const input = $('#inValue');
    $('#inTitle').textContent = title || '';
    input.placeholder = placeholder || '';
    input.value = value || '';
    $('#inOk').textContent = okText;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sheet.classList.add('hidden');
      mask.classList.add('hidden');
      resolve(v);
    };
    const submit = () => done((input.value || '').trim() || null);
    $('#inOk').onclick = submit;
    $('#inNo').onclick = () => done(null);
    mask.onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    sheet.classList.remove('hidden');
    mask.classList.remove('hidden');
    setTimeout(() => { try { input.focus(); } catch {} }, 260);
  });
}

// ---------------------------------------------------------------------------
// 合辑 / 合集展开后的一键收藏条
// ---------------------------------------------------------------------------
let albumItems = [];
function showAlbumBar(items, info) {
  albumItems = (items || []).slice();
  if (!albumItems.length) return;
  $('#albumInfo').textContent = info || `已展开 ${albumItems.length} 首`;
  $('#albumBar').classList.remove('hidden');
}
function hideAlbumBar() {
  $('#albumBar').classList.add('hidden');
  albumItems = [];
}
$('#albumCollect').addEventListener('click', () => {
  if (!albumItems.length) return toast('没有可收藏的曲目');
  openPlSheet(null, albumItems);
});
$('#albumDismiss').addEventListener('click', hideAlbumBar);

// ---------------------------------------------------------------------------
// 最近播放
// ---------------------------------------------------------------------------
async function loadRecent() {
  const box = $('#recentList');
  try {
    const h = await apiGet('/api/history');
    historyItems = h.items || [];
    $('#recLabel').textContent = `最近播放 · ${historyItems.length}`;
    if (!historyItems.length) {
      box.innerHTML = '';
      $('#recentHint').style.display = 'block';
      return;
    }
    $('#recentHint').style.display = 'none';
    renderCards(box, historyItems, (item, idx) => {
      queue = historyItems.slice();
      // 上次听到哪就从哪接着播
      playIndex(idx, { startAt: item.position && item.position < (item.duration || 0) - 15 ? item.position : 0 });
    }, {
      onCollect: (it) => openPlSheet(it),
      onDelete: async (it) => {
        await apiSend(`/api/history?key=${encodeURIComponent(favKey(it))}`, 'DELETE');
        toast('已从最近播放移除');
        loadRecent();
      },
    });
    markPlaying();
    refreshRowHearts();
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e.message)}</div>`;
  }
}

$('#recClear').addEventListener('click', async () => {
  if (!historyItems.length) return;
  const ok = await confirmSheet({
    title: '清空最近播放？',
    msg: `${historyItems.length} 条记录会被删掉，收藏列表不受影响`,
    okText: '清空',
  });
  if (!ok) return;
  try {
    await apiSend('/api/history?all=1', 'DELETE');
    toast('已清空');
    loadRecent();
  } catch (e) { toast('清空失败：' + e.message); }
});

// 首屏「继续上次」卡片
async function refreshResumeCard() {
  const el = $('#resumeCard');
  try {
    const h = await apiGet('/api/history');
    const last = (h.items || [])[0];
    historyItems = h.items || [];
    if (!last || !last.position || last.position < 5 || last.position > (last.duration || 0) - 15) {
      el.classList.add('hidden');
      return;
    }
    $('#rsCover').src = last.pic || '';
    $('#rsTitle').textContent = last.title || '未知标题';
    const pct = last.duration ? Math.min(100, (last.position / last.duration) * 100) : 0;
    $('#rsFill').style.width = pct.toFixed(1) + '%';
    $('#rsPos').textContent = `${fmtTime(last.position)} / ${fmtTime(last.duration)}`;
    $('#rsPlay').onclick = () => {
      queue = [last];
      playIndex(0, { startAt: last.position });
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $('[data-tab="search"]').classList.add('active');
      hideAlbumBar();
    };
    el.classList.remove('hidden');
  } catch {
    el.classList.add('hidden');
  }
}
let playlists = [];     // [{id, name, count}]
let plActive = null;    // 收藏视图当前查看的列表 id
let plItems = [];       // 当前列表的曲目
let memberCache = null; // Map<listId, Set<key>>，短时缓存，判断爱心是否点亮

function favKey(item) { return `${item && item.bvid}|${(item && item.cid) || ''}`; }

async function apiSend(url, method, body) {
  const res = await fetch(apiUrl(url), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const gateErr = await checkGateResponse(res, url);
  if (gateErr) throw gateErr;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadPlaylists() {
  const r = await apiGet('/api/playlists');
  playlists = r.lists || [];
  if (!plActive || !playlists.some((p) => p.id === plActive)) {
    plActive = r.active || (playlists[0] && playlists[0].id) || null;
  }
  renderPlChips();
  return playlists;
}

function renderPlChips() {
  const box = $('#plChips');
  box.innerHTML = '';
  playlists.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip' + (p.id === plActive ? ' on' : '');
    b.innerHTML = `${esc(p.name)}<span class="n">${String(p.count).padStart(2, '0')}</span>`;
    b.addEventListener('click', () => { plActive = p.id; loadFavorites(); });
    box.appendChild(b);
  });
}

async function loadFavorites() {
  const box = $('#favList');
  box.innerHTML = '<div class="loading">加载中…</div>';
  $('#favHint').style.display = 'none';
  try {
    await loadPlaylists();
    const cur = playlists.find((p) => p.id === plActive) || playlists[0];
    if (!cur) { box.innerHTML = ''; return; }
    plActive = cur.id;
    renderPlChips();
    const r = await apiGet(`/api/playlists/items?id=${encodeURIComponent(cur.id)}`);
    plItems = r.items || [];
    $('#favLabel').textContent = `${r.name} · ${plItems.length} 首`;
    if (!plItems.length) {
      box.innerHTML = '';
      $('#favHint').style.display = 'block';
      $('#plPlayAll').style.display = 'none';
      return;
    }
    $('#plPlayAll').style.display = '';
    const playOpts = favSortMode
      ? { onSort: (it, idx, dir) => moveFavItem(it, dir) }
      : {
          // 收藏行也给 ♥：可以把这首再加进别的列表
          onCollect: (it) => openPlSheet(it),
          onDelete: async (it) => {
            const ok = await confirmSheet({
              title: '移出列表？',
              msg: `《${it.title || '这首歌'}》将从「${cur.name}」移除`,
              okText: '移除',
            });
            if (!ok) return;
            await apiSend(`/api/playlists/items?id=${encodeURIComponent(cur.id)}&bvid=${encodeURIComponent(it.bvid)}&cid=${encodeURIComponent(it.cid || '')}`, 'DELETE');
            memberCache = null;
            toast('已从列表移除');
            loadFavorites();
            refreshFavState();
          },
        };
    renderCards(box, plItems, (item, idx) => { queue = plItems.slice(); playIndex(idx); }, playOpts);
    markPlaying();
    refreshRowHearts();
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败：${esc(e.message)}</div>`;
  }
}

// 所有列表的曲目键集合（判断当前歌是否已收藏）
async function fetchMembership() {
  if (memberCache && Date.now() - memberCache.at < 5000) return memberCache.map;
  const lists = playlists.length ? playlists : (await loadPlaylists());
  const map = new Map();
  await Promise.all(lists.map(async (p) => {
    try {
      const r = await apiGet(`/api/playlists/items?id=${encodeURIComponent(p.id)}`);
      map.set(p.id, new Set((r.items || []).map(favKey)));
    } catch { map.set(p.id, new Set()); }
  }));
  memberCache = { at: Date.now(), map };
  return map;
}

function refreshFavState() {
  const item = queue[current];
  const heart = $('#pFav');
  if (!item) { heart.classList.remove('on'); return; }
  fetchMembership().then((map) => {
    const key = favKey(item);
    let inAny = false;
    for (const set of map.values()) if (set.has(key)) { inAny = true; break; }
    heart.classList.toggle('on', inAny);
  }).catch(() => {});
}

// 点爱心 → 弹出「收藏到…」选列表（参数为空 = 收藏正在播放的这首）
let sheetItem = null;
let sheetBatch = null;   // 合辑一键收藏时的整份曲目

$('#pFav').addEventListener('click', () => openPlSheet());

async function openPlSheet(item, batchItems) {
  item = item || queue[current];
  if (!item && !(batchItems && batchItems.length)) return toast('先播放一首歌，或在列表里点 ♡');
  sheetItem = item || (batchItems && batchItems[0]);
  sheetBatch = batchItems && batchItems.length > 1 ? batchItems : null;
  try {
    await loadPlaylists();
    const map = await fetchMembership();
    if (sheetBatch) $('#plSheetTitle').textContent = `共 ${sheetBatch.length} 首 · 勾选要收进的列表`;
    else $('#plSheetTitle').textContent = (item && item.title) || '未知标题';
    renderSheetRows(item, map);
    $('#plSheet').classList.remove('hidden');
    $('#plSheetMask').classList.remove('hidden');
  } catch (e) { toast('加载列表失败：' + e.message); }
}

// 弹层行渲染：勾选态一目了然；切换后弹层不关闭，可以连续勾多个列表
function renderSheetRows(item, map) {
  const targets = sheetBatch || [item].filter(Boolean);
  const box = $('#plSheetList');
  box.innerHTML = '';
  playlists.forEach((p) => {
    const set = map.get(p.id) || new Set();
    // 批量模式下：全部在内才算 ✓，否则显示未勾选（点一下会补齐缺的那几首）
    const on = targets.length > 0 && targets.every((x) => set.has(favKey(x)));
    const row = document.createElement('div');
    row.className = 'sh-row' + (on ? ' on' : '');
    row.innerHTML = `
      <span class="nm">${esc(p.name)}</span>
      <span class="ct">${String(p.count).padStart(2, '0')}</span>
      <span class="box">${on ? '✓' : ''}</span>`;
    row.addEventListener('click', async () => {
      row.style.opacity = '.5';
      try {
        if (on) {
          for (const t of targets) {
            await apiSend(`/api/playlists/items?id=${encodeURIComponent(p.id)}&bvid=${encodeURIComponent(t.bvid)}&cid=${encodeURIComponent(t.cid || '')}`, 'DELETE');
          }
          toast(targets.length > 1 ? `已从「${p.name}」移除 ${targets.length} 首` : `已从「${p.name}」移除`);
        } else if (sheetBatch) {
          const r = await apiSend(`/api/playlists/items/bulk?id=${encodeURIComponent(p.id)}`, 'POST', { items: sheetBatch });
          toast(r.added ? `已把 ${r.added} 首收进「${p.name}」${r.skipped ? `（${r.skipped} 首已在）` : ''}` : '这些歌已经都在里面了');
        } else {
          await apiSend(`/api/playlists/items?id=${encodeURIComponent(p.id)}`, 'POST', { item });
          toast(`已收藏到「${p.name}」`);
        }
        memberCache = null;
        await loadPlaylists();
        const fresh = await fetchMembership();
        renderSheetRows(item, fresh);   // 弹层保持打开，勾选态与计数即时更新
        refreshRowHearts();
        refreshFavState();
        if ($('#view-fav').classList.contains('active')) loadFavorites();
      } catch (e) { toast('操作失败：' + e.message); }
      row.style.opacity = '';
    });
    box.appendChild(row);
  });
}

function closePlSheet() {
  $('#plSheet').classList.add('hidden');
  $('#plSheetMask').classList.add('hidden');
  sheetItem = null;
  sheetBatch = null;
  refreshFavState();
}
$('#plSheetClose').addEventListener('click', closePlSheet);
$('#plSheetMask').addEventListener('click', closePlSheet);

// ---------------------------------------------------------------------------
// 确认操作弹层（防误删）：confirmSheet({title, msg, okText}) -> Promise<bool>
// ---------------------------------------------------------------------------
function confirmSheet({ title, msg, okText = '删除' }) {
  return new Promise((resolve) => {
    const sheet = $('#cfSheet'), mask = $('#cfMask');
    $('#cfTitle').textContent = title || '确认操作';
    $('#cfMsg').textContent = msg || '';
    $('#cfOk').textContent = okText;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sheet.classList.add('hidden');
      mask.classList.add('hidden');
      resolve(v);
    };
    $('#cfOk').onclick = () => done(true);
    $('#cfNo').onclick = () => done(false);
    mask.onclick = () => done(false);
    sheet.classList.remove('hidden');
    mask.classList.remove('hidden');
  });
}

// 新建列表（在弹层里新建时，顺带把当前这首收进新列表）
async function createPlaylist(name, collectItem) {
  name = (name || '').trim();
  if (!name) return toast('先给列表起个名字');
  try {
    const r = await apiSend('/api/playlists', 'POST', { name });
    memberCache = null;
    toast(`已新建列表「${name}」`);
    if (collectItem && r.active) {
      if (sheetBatch && sheetBatch.length > 1) {
        const bulk = await apiSend(`/api/playlists/items/bulk?id=${encodeURIComponent(r.active)}`, 'POST', { items: sheetBatch });
        toast(`已新建列表，收进 ${bulk.added} 首`);
      } else {
        await apiSend(`/api/playlists/items?id=${encodeURIComponent(r.active)}`, 'POST', { item: collectItem });
        toast(`已收藏到「${name}」`);
      }
    }
    await loadPlaylists();
    if (sheetItem) {
      const map = await fetchMembership();
      renderSheetRows(sheetItem, map);
    } else {
      closePlSheet();
    }
    if ($('#view-fav').classList.contains('active')) loadFavorites();
  } catch (e) { toast('新建失败：' + e.message); }
}
$('#plNewBtn').addEventListener('click', () => {
  const name = $('#plNewName').value;
  if (name.trim()) { createPlaylist(name, sheetItem); $('#plNewName').value = ''; }
});
$('#plNewName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { createPlaylist($('#plNewName').value, sheetItem); $('#plNewName').value = ''; }
});

// 收藏页工具栏：新建 / 重命名 / 删除 / 排序
$('#plNew').addEventListener('click', async () => {
  const name = await inputSheet({ title: '新建列表', placeholder: '给列表起个名字', okText: '新建' });
  if (name) createPlaylist(name);
});
$('#plRename').addEventListener('click', async () => {
  const cur = playlists.find((p) => p.id === plActive);
  if (!cur) return;
  const name = await inputSheet({ title: '重命名列表', value: cur.name, okText: '确定' });
  if (!name) return;
  try {
    await apiSend('/api/playlists', 'PUT', { id: cur.id, name });
    toast('已重命名');
    loadFavorites();
  } catch (e) { toast('重命名失败：' + e.message); }
});
$('#plSort').addEventListener('click', () => {
  favSortMode = !favSortMode;
  const btn = $('#plSort');
  btn.textContent = favSortMode ? '完成' : '排序';
  btn.classList.toggle('play', favSortMode);
  loadFavorites();
  toast(favSortMode ? '排序模式：用 ⇈ ↥ ↧ 调整曲目顺序' : '已退出排序模式');
});

// 排序模式下的三种位置操作（置顶 / 上移 / 下移）
async function moveFavItem(it, dir) {
  const cur = playlists.find((p) => p.id === plActive);
  if (!cur) return;
  try {
    await apiSend(`/api/playlists/items?id=${encodeURIComponent(cur.id)}`, 'PUT', { key: favKey(it), dir });
    memberCache = null;
    await loadFavorites();
  } catch (e) { toast('移动失败：' + e.message); }
}

$('#plDelete').addEventListener('click', async () => {
  const cur = playlists.find((p) => p.id === plActive);
  if (!cur) return;
  if (playlists.length <= 1) return toast('至少保留一个列表');
  const ok = await confirmSheet({
    title: '删除列表？',
    msg: `「${cur.name}」里的 ${cur.count} 首歌会一起删掉，此操作无法撤销`,
    okText: '删除列表',
  });
  if (!ok) return;
  try {
    await apiSend(`/api/playlists?id=${encodeURIComponent(cur.id)}`, 'DELETE');
    memberCache = null;
    plActive = null;
    await loadFavorites();
    toast('列表已删除');
  } catch (e) { toast('删除失败：' + e.message); }
});
$('#plPlayAll').addEventListener('click', () => {
  if (!plItems.length) return;
  queue = plItems.slice();
  playIndex(0);
});

// 启动检查 + 首屏内容（别让用户一进来对着空白页发呆）
// 先过一遍登录态自愈（远程下直开链接常被网关拦），再拉首屏
(async () => {
  await healAuth();
  apiGet('/api/health')
    .then(() => {
      refreshResumeCard();   // 「继续上次」卡片
      loadHot();
    })
    .catch(() => toast('后端未连接'));
})();

// PWA：注册 Service Worker（离线兜底壳页面）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(apiUrl('/sw.js')).catch(() => {});
}

// ---------------------------------------------------------------------------
// 内嵌浏览器提示：飞牛 App 自带 WebView（iOS Flutter）不允许 <audio> 出声，
// 网页侧无解，只能提示用系统浏览器打开。Safari / Chrome 不受影响。
// ---------------------------------------------------------------------------
(function warnEmbeddedWebView() {
  const ua = navigator.userAgent || '';
  const embedded = /FNAppType|FNAppVer|FNOS\//.test(ua);
  // 兜底：非 Safari/Chrome 标准内核且带明显 App 容器特征时也提示一次
  if (!embedded) return;
  if (sessionStorage.getItem('wvbarClosed') === '1') return;

  const isiOS = /iPhone|iPad|iPod/i.test(ua);
  const bar = document.createElement('div');
  bar.className = 'wvbar';
  bar.innerHTML = `
    <div class="wvb-txt">
      <b>当前在飞牛 App 内置浏览器里，无法播放声音</b>
      <span>${isiOS ? '请点右上角「···」→ 用 Safari 打开' : '请用系统浏览器打开本页'}；或复制下面的地址到 Safari / Chrome。</span>
    </div>
    <div class="wvb-ops">
      <button class="wvb-copy" type="button">复制链接</button>
      <button class="wvb-x" type="button" aria-label="关闭">×</button>
    </div>`;
  Object.assign(bar.style, {
    position: 'fixed', left: '0', right: '0', top: '0', zIndex: '9999',
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 12px', background: '#3a2a12', color: '#ffd88a',
    borderBottom: '1px solid #5c4520', font: '400 13px/1.5 system-ui, -apple-system, sans-serif',
    boxSizing: 'border-box',
  });
  const txt = bar.querySelector('.wvb-txt');
  Object.assign(txt.style, { flex: '1', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '0' });
  txt.querySelector('b').style.cssText = 'font-size:13px';
  txt.querySelector('span').style.cssText = 'font-size:12px;opacity:.82';
  const ops = bar.querySelector('.wvb-ops');
  Object.assign(ops.style, { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: '0' });
  const copy = bar.querySelector('.wvb-copy');
  Object.assign(copy.style, {
    padding: '6px 10px', borderRadius: '8px', border: '1px solid #6b5126',
    background: '#241a0c', color: '#ffd88a', font: '400 12px/1 system-ui, sans-serif', cursor: 'pointer',
  });
  const x = bar.querySelector('.wvb-x');
  Object.assign(x.style, {
    width: '28px', height: '28px', borderRadius: '8px', border: '1px solid #6b5126',
    background: 'transparent', color: '#ffd88a', fontSize: '18px', lineHeight: '1', cursor: 'pointer',
  });

  copy.addEventListener('click', async () => {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = '已复制';
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); copy.textContent = '已复制'; } catch { copy.textContent = '请长按地址栏'; }
      ta.remove();
    }
    setTimeout(() => { copy.textContent = '复制链接'; }, 2000);
  });
  const close = () => {
    bar.remove();
    sessionStorage.setItem('wvbarClosed', '1');
  };
  x.addEventListener('click', close);

  document.body.appendChild(bar);
  // 把内容整体下推，避免横幅盖住标题栏
  const app = document.querySelector('.app');
  if (app) app.style.paddingTop = (bar.offsetHeight + 4) + 'px';
})();
