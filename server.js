// Bili Music Web — 自托管 B 站音乐播放器后端
// 零依赖，仅用 Node 标准库。复用 bili-music 桌面版的游客免登录取流逻辑。
// 架构：手机浏览器 -> 本服务 -> B 站（WBI 签名取流 + 音频流式代理）

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PREFERRED_PORT = 8350; // 仅用于提示，实际端口由 docker compose 决定

// 飞牛 fnOS 应用中心（统一网关）支持：
//   SOCKET_PATH -> 监听 Unix Socket，由 fnOS 网关转发请求（带登录态）
//   BASE_PATH   -> 网关前缀，如 /app/bilimusic；为空表示按根路径部署（Docker / 本地直跑）
// 两个变量都为空时行为与原来完全一致，Docker 部署不受影响。
const SOCKET_PATH = process.env.SOCKET_PATH || '';
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
// 远程直连模式的访问口令（仅在设置了 ACCESS_TOKEN 时启用；网关模式不设，行为不变）
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN || '').trim();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

const HOME_URL = 'https://www.bilibili.com/';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SPI_URL = 'https://api.bilibili.com/x/frontend/finger/spi';
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/wbi/playurl';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const LYRIC_BASE = 'https://api.vkeys.cn/v2/music/tencent';
// 歌词多源回退（2026-09 实测）：
//   vkeys 只有腾讯路径活着（酷狗 / 网易路径都 404）
//   网易官方 /api/search/get + /api/song/lyric 中文覆盖最好，lv=1 返回带时间的 LRC
//   lrclib.net 是开源 LRC 库，免 key，作最后兜底（偶发 503 过载，忽略即可）
const NETEASE_SEARCH = 'https://music.163.com/api/search/get';
const NETEASE_LYRIC = 'https://music.163.com/api/song/lyric';
const NETEASE_REFERER = 'https://music.163.com/';
const LRCLIB_SEARCH = 'https://lrclib.net/api/search';
const LYRIC_SOURCE_ORDER = ['tencent', 'netease', 'lrclib'];
const LYRIC_FETCH_TIMEOUT_MS = 9000;

// 服务端音频缓存：常听的歌落盘 NAS，二次播放秒开，也省 B 站请求和外网上行
const AUDIO_CACHE_DIR = path.join(DATA_DIR, 'audio-cache');
// 上限可配：小容量设备上把缓存压小，别让它跟照片/备份抢盘
const MAX_CACHE_FILES = Math.max(10, Number(process.env.MAX_CACHE_FILES || 200));
const MAX_CACHE_BYTES = Math.max(64 * 1024 * 1024, Number(process.env.MAX_CACHE_BYTES || 1536 * 1024 * 1024)); // 默认 1.5GB
const AUDIO_CACHE_MIN_BYTES = 64 * 1024;    // 小于这个多半是错误响应，不落盘
const DL_TIMEOUT_MS = 5 * 60 * 1000;

// 播放历史上限（服务端持久化，跨设备共享）
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 60;

// ---------------------------------------------------------------------------
// 跨实例协调（v1.1.0）：同一份 DATA_DIR 可能被多个实例共享
// 典型场景 = fnOS 网关实例（/app/bilimusic）+ 远程直连实例（:8361）同时跑。
// 三个真实风险：
//   a) 两个进程写同一个 .tmp：一个 O_TRUNC 会截断另一个正在写的流 → 文件损坏；
//   b) 启动清理 / LRU 清扫删掉别的实例正在下载或正在读的文件 → 缓存失效甚至播放中断；
//   c) playlists / history 的「读-改-写」交错 → 丢更新。
// 对策：临时文件一律带 process.pid；写 JSON 走目录锁（mkdir 是原子的）；
//       清理残留前先确认持有者进程还在不在。
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// "40284065742.m4a.1234.part" -> 1234；老格式（不带 pid）返回 0
function ownerPidOf(name) {
  const m = String(name).match(/\.(\d+)\.(?:tmp|part|remux)$/);
  return m ? Number(m[1]) : 0;
}

// 别的实例正在写的文件不能碰
function heldByOtherInstance(name) {
  const owner = ownerPidOf(name);
  return owner > 0 && owner !== process.pid && pidAlive(owner);
}

const LOCK_DIR = path.join(DATA_DIR, '.locks');

// 同步小睡：写 JSON 是同步路径，竞争时等 20ms 再试（Atomics.wait 不占用事件循环线程争用）
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

// 拿不到锁就返回 null（调用方跳过写入并告警），绝不无限等待卡死播放请求
function acquireDataLock(name, staleMs = 15000) {
  const d = path.join(LOCK_DIR, name + '.lock');
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
  for (let i = 0; i < 25; i++) {
    try {
      fs.mkdirSync(d);
      try { fs.writeFileSync(path.join(d, 'owner'), String(process.pid)); } catch {}
      return d;
    } catch {
      // 锁已存在：持有者进程已死、或占用超过 staleMs（异常退出遗留）→ 强抢
      let steal = false;
      try {
        const owner = Number(String(fs.readFileSync(path.join(d, 'owner'), 'utf8')).trim());
        const age = Date.now() - fs.statSync(d).mtimeMs;
        if (!pidAlive(owner) || age > staleMs) steal = true;
      } catch { steal = true; }
      if (steal) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} continue; }
      syncSleep(20);
    }
  }
  return null;
}

function releaseDataLock(d) {
  if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// 前端诊断日志（iOS 后台连播定位用）：前端把事件流水批量 POST 上来落盘，
// 手机实测完直接读这份 jsonl 复盘。单文件超过 4MB 轮转。
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_MAX_BYTES = 4 * 1024 * 1024;
// 音乐区（tid=3）数据源：
//   ranking/v2 = 累计排行，实测条目全是 18 个月前的老内容，只能当"经典"兜底
//   更鲜的源 = 限定音乐区 + 发布时间窗口 + 按播放/发布时间排序（近 7 / 30 天）
const RANK_URL = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular';
const MUSIC_TID = '3';
// 空关键词 B 站不给结果，所以用两个宽泛关键词各取一页再合并去重
const HOT_KEYWORDS = ['音乐', '歌'];
const HOT_RANGES = new Set(['week', 'month', 'total']);

// 允许的搜索排序档位：默认综合 / 播放量 / 最新发布
const ALLOWED_ORDERS = new Set(['totalrank', 'click', 'pubdate']);

// WBI 混淆表（与 bili-music 完全一致，不可改动）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

// 优先音轨 ID（高音质），以及需要规避的特例音轨
const PREFERRED_AUDIO_IDS = [30232, 30216];
const SPECIAL_AUDIO_IDS = [30250, 30251];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function md5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function genMixinKey(raw) {
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length < 64) throw new Error('combined WBI key shorter than 64 bytes');
  let out = '';
  for (let i = 0; i < 32; i++) out += String.fromCharCode(bytes[MIXIN_KEY_ENC_TAB[i]]);
  return out;
}

// 编码除 A-Za-z0-9 - _ . ~ 之外的所有字符（对应 Rust 的 WBI_ENCODE_SET）
// 关键：必须按 UTF-8 字节编码（中文等多字节字符），不能用 charCodeAt（那是 UTF-16 码元）
function wbiEncode(str) {
  let out = '';
  for (const ch of String(str)) {
    const bytes = Buffer.from(ch, 'utf8');
    for (const b of bytes) {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
      else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// 复刻 bili-music 的 sign_parameters
function signParameters(params, mixinKey, wts) {
  const withTs = { ...params, wts: String(wts) };
  const keys = Object.keys(withTs).sort();
  const query = keys
    .map((k) => {
      let v = String(withTs[k]);
      // 过滤掉 " ' ! ( ) * 这几个字符
      v = v.replace(/["'!()*]/g, '');
      return wbiEncode(k) + '=' + wbiEncode(v);
    })
    .join('&');
  const w_rid = md5(query + mixinKey);
  return query + '&w_rid=' + w_rid;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function keyFromUrl(url) {
  const fname = url.split('/').pop() || '';
  return fname.split('.')[0] || '';
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// 游客身份 + WBI 密钥缓存
// ---------------------------------------------------------------------------
let guestCookies = {};
let wbiKeyCache = { key: null, fetchedAt: 0 };
const WBI_TTL_MS = 60 * 60 * 1000;
// 游客指纹定期换：长时间用同一组 buvid 打接口更容易撞上 B 站风控
const BUVID_TTL_MS = 6 * 60 * 60 * 1000;
let buvidFetchedAt = 0;

// 风控兜底：一旦出现 412（风控）或 WBI 失效，把身份和密钥全部作废重新洗一遍再试。
// 不这么做的话，一次风控会让之后所有请求连环失败，表现为"整个应用突然都播不了"。
function resetIdentity() {
  wbiKeyCache = { key: null, fetchedAt: 0 };
  guestCookies = {};
  buvidFetchedAt = 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureGuestIdentity() {
  const fresh = guestCookies.buvid3 && guestCookies.buvid4 && Date.now() - buvidFetchedAt < BUVID_TTL_MS;
  if (fresh) return;
  if (guestCookies.buvid3) { guestCookies = {}; } // 过期重洗
  buvidFetchedAt = Date.now();
  try {
    const res = await fetch(HOME_URL, {
      headers: { 'User-Agent': UA, Referer: REFERER, 'Accept-Encoding': 'identity' },
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      if (idx < 0) continue;
      const name = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      if (['buvid3', 'buvid4', 'b_nut'].includes(name)) guestCookies[name] = val;
    }
  } catch (e) {
    console.warn('[guest] homepage buvid fetch failed:', e.message);
  }

  if (!guestCookies.buvid3 || !guestCookies.buvid4) {
    try {
      const headers = { 'User-Agent': UA, Referer: REFERER, 'Accept-Encoding': 'identity' };
      const ch = cookieHeader(guestCookies);
      if (ch) headers['Cookie'] = ch;
      const res = await fetch(SPI_URL, { headers });
      const data = await res.json();
      if (data && data.code === 0 && data.data) {
        if (data.data.b_3) guestCookies.buvid3 = data.data.b_3;
        if (data.data.b_4) guestCookies.buvid4 = data.data.b_4;
      }
    } catch (e) {
      console.warn('[guest] SPI buvid fetch failed:', e.message);
    }
  }
}

async function getMixinKey() {
  const now = Date.now();
  if (wbiKeyCache.key && now - wbiKeyCache.fetchedAt < WBI_TTL_MS) return wbiKeyCache.key;
  await ensureGuestIdentity();
  const headers = {
    'User-Agent': UA,
    Referer: REFERER,
    'Accept-Encoding': 'identity',
    Cookie: cookieHeader(guestCookies),
  };
  const res = await fetch(NAV_URL, { headers });
  const data = await res.json();
  if (data.code !== 0 && data.code !== -101) {
    throw new Error('WBI nav failed: ' + (data.message || data.code));
  }
  const wbi = data.data && data.data.wbi_img;
  if (!wbi) throw new Error('WBI nav response missing wbi_img');
  const mixin = genMixinKey(keyFromUrl(wbi.img_url) + keyFromUrl(wbi.sub_url));
  wbiKeyCache = { key: mixin, fetchedAt: now };
  return mixin;
}

// ---------------------------------------------------------------------------
// B 站接口封装
// ---------------------------------------------------------------------------
// B 站接口统一超时（评审共识 #2）：全项目有超时的 fetch 有好几处，
// 唯独调用最频繁的这条主路径裸奔 —— 一条半开连接能把搜索/取流全部挂死，
// 而 /api/health 不经过 B 站、恒返回正常，结果就是服务已经废了却没人发现。
const BILI_TIMEOUT_MS = Number(process.env.BILI_TIMEOUT_MS || 10000);

async function biliGetOnce(url, params, { signed = true, raw = false } = {}) {
  await ensureGuestIdentity();
  let full = url;
  if (params) {
    const qs = signed
      ? signParameters(params, await getMixinKey(), unixNow())
      : new URLSearchParams(params).toString();
    full = url + '?' + qs;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`B 站接口超时（${BILI_TIMEOUT_MS}ms）`)), BILI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(full, {
      headers: {
        'User-Agent': UA,
        Referer: REFERER,
        'Accept-Encoding': 'identity',
        Cookie: cookieHeader(guestCookies),
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 412) throw new Error('B 站返回 412（风控），请稍后重试');
  if (raw) return res;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('B 站响应非 JSON: ' + text.slice(0, 200));
  }
}

// 统一重试层：撞上 412 风控 / WBI 失效时重洗身份再来一次。
// 只重试一次，避免把正常错误（400 参数错、404 没有资源）也拖成两遍往返。
async function biliGet(url, params, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await biliGetOnce(url, params, opts);
    } catch (e) {
      lastErr = e;
      const m = (e && e.message) || '';
      const retriable = /412|风控|nav failed|非 JSON|wbi_img|ECONNRESET|ETIMEDOUT/i.test(m);
      if (attempt === 0 && retriable) {
        console.warn(`[bili] 临时错误，重洗身份后重试：${m}`);
        resetIdentity();
        await sleep(600);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function fetchView(bvid) {
  const data = await biliGet(VIEW_URL, { bvid });
  if (data.code !== 0) throw new Error('view 失败: ' + (data.message || data.code));
  const d = data.data;
  const pages = Array.isArray(d.pages) ? d.pages : [];
  const firstCid = pages.length ? pages[0].cid : d.cid;
  // B站合集（ugc_season）：网页播放器右侧那个"几十首的列表"
  let season = null;
  const sec0 = d.ugc_season;
  if (sec0 && Array.isArray(sec0.sections)) {
    const items = [];
    for (const sec of sec0.sections) {
      for (const it of (sec.items || [])) {
        if (!it || !it.bvid) continue;
        items.push({
          bvid: it.bvid,
          title: it.title || '',
          author: (it.owner && it.owner.name) || '',
          pic: normalizePic(it.pic),
          duration: it.duration || 0,
        });
      }
    }
    if (items.length > 1) season = { title: sec0.title || '', items };
  }
  return {
    bvid: d.bvid || bvid,
    cid: firstCid,
    title: d.title || '',
    author: (d.owner && d.owner.name) || '',
    pic: normalizePic(d.pic),
    duration: d.duration || 0,
    pages: pages.map((p, i) => ({
      page: p.page || i + 1,
      cid: p.cid,
      part: p.part || d.title || '',
      duration: p.duration || d.duration || 0,
    })),
    season,
  };
}

async function fetchPlayurl(bvid, cid) {
  const data = await biliGet(PLAYURL_URL, {
    bvid,
    cid: String(cid),
    fnval: '4048',
    fnver: '0',
    qn: '0',
  });
  if (data.code !== 0) throw new Error('playurl 失败: ' + (data.message || data.code));
  return data.data;
}

function selectAudio(dash) {
  if (!dash || !dash.audio || !dash.audio.length) return null;
  const audio = dash.audio;
  for (const id of PREFERRED_AUDIO_IDS) {
    const hit = audio.find((s) => s.id === id);
    if (hit) return normalizeStream(hit);
  }
  const filtered = audio.filter((s) => !SPECIAL_AUDIO_IDS.includes(s.id));
  const pool = filtered.length ? filtered : audio;
  // 选码率最高
  const best = pool.reduce((a, b) => ((b.bandwidth || 0) > (a.bandwidth || 0) ? b : a));
  return normalizeStream(best);
}

function normalizeStream(s) {
  // 收齐 baseUrl + backupUrl，普通 upos 节点优先，mcdn/p2p 边缘节点排最后
  const urls = [s.baseUrl || s.base_url, ...(s.backup_url || [])].filter(Boolean);
  const rank = (u) => (/mcdn|p2p/i.test(u) ? 1 : 0);
  urls.sort((a, b) => rank(a) - rank(b));
  return { id: s.id, urls, bandwidth: s.bandwidth || 0 };
}

// ---------------------------------------------------------------------------
// playurl 缓存：浏览器播一首歌会发 5~10 个 Range 请求，若每个都重新打
// B 站 playurl 接口（WBI 签名 + 往返几百 ms），首字节太慢会被手机端
// 判为断流而重试，也有触发风控的隐患。B 站 CDN 直链有效期 1 小时以上，
// 这里缓存 30 分钟足够安全。
// ---------------------------------------------------------------------------
const playurlCache = new Map(); // key: bvid|cid -> { urls, expiresAt }
const PLAYURL_TTL_MS = 30 * 60 * 1000;

async function getAudioCandidates(bvid, cid) {
  const key = `${bvid}|${cid}`;
  const hit = playurlCache.get(key);
  if (hit && Date.now() < hit.expiresAt) {
    console.log(`[playurl] cache hit ${key} (${hit.urls.length} candidates)`);
    return hit.urls;
  }
  const playurl = await fetchPlayurl(bvid, cid);
  const audio = selectAudio(playurl && playurl.dash);
  if (!audio || !audio.urls || !audio.urls.length) return null;
  playurlCache.set(key, { urls: audio.urls, expiresAt: Date.now() + PLAYURL_TTL_MS });
  console.log(`[playurl] fetched ${key} -> ${audio.urls.length} candidates`);
  return audio.urls;
}

// 把 B 站搜索结果里的 HTML 标签剥掉
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// 封面统一 https：rank/popular 接口会返回 http://，在 https 页面里会被浏览器当混合内容拦掉
function normalizePic(pic) {
  if (!pic) return '';
  if (pic.startsWith('//')) return 'https:' + pic;
  if (pic.startsWith('http://')) return 'https://' + pic.slice(7);
  return pic;
}

function parseDuration(raw) {
  if (typeof raw === 'number') return raw;
  const s = String(raw || '');
  const m = s.match(/(\d+):(\d+)/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// 搜索结果项 -> 前端行数据（搜索接口不给 cid，播放时再 resolve；
// 多P合辑更不能预置 cid，否则会被当单曲直接播，整份歌单就丢了）
function mapVideoItem(it) {
  return {
    bvid: it.bvid,
    title: stripHtml(it.title),
    author: it.author || (it.mid ? 'UP主' + it.mid : ''),
    pic: normalizePic(it.pic),
    duration: parseDuration(it.duration),
    play: Number(it.play) || 0,
    pubdate: Number(it.pubdate) || 0,
    videos: Number(it.videos) || 1,   // 分P数：>1 说明是合辑
    cid: 0,
  };
}

async function searchVideos(keyword, page = 1, order = 'totalrank') {
  const sort = ALLOWED_ORDERS.has(order) ? order : 'totalrank';
  const data = await biliGet(SEARCH_URL, {
    keyword,
    search_type: 'video',
    page: String(page),
    duration: '0',
    order: sort,
    tids: '0',
  });
  if (data.code !== 0) throw new Error('搜索失败: ' + (data.message || data.code));
  const d = data.data || {};
  const list = (d.result || []).filter((it) => it && it.bvid).map(mapVideoItem);
  // numPages 用来告诉前端还有没有下一页（B 站会一并返回，拿不到就按"还有"处理）
  const numPages = Number(d.numPages) || 1;
  console.log(`[search] "${keyword}" order=${sort} page=${page} -> ${list.length} items (numPages=${numPages}, code=${data.code})`);
  return { list, numPages };
}

// ---------------------------------------------------------------------------
// 搜索结果缓存：同一关键词来回切排序时没必要反复打 B 站，5 分钟内直接回吐，
// 这是"点了排序像没反应"的体验修复之一（切一次 ≤ 20ms，肉眼跟手）。
// ---------------------------------------------------------------------------
const searchCache = new Map(); // key: keyword|order|page -> { results, numPages, expiresAt }
const SEARCH_TTL_MS = 5 * 60 * 1000;

async function getSearchResults(keyword, page, order) {
  const key = `${keyword}|${order}|${page}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() < hit.expiresAt) {
    console.log(`[search] cache hit ${key}`);
    return { ...hit, cached: true };
  }
  const { list, numPages } = await searchVideos(keyword, page, order);
  const entry = { results: list, numPages, cached: false, expiresAt: Date.now() + SEARCH_TTL_MS };
  // 空结果不进缓存：B 站偶尔会对某一页返回 code=0 但 result 为空（实测
  // "周杰伦" 第 2 页稳定为空、第 4 页正常）。缓存空页的话，用户点"加载更多"
  // 会在 5 分钟内一直拿到空，表现为"翻页坏了"。
  if (list.length) searchCache.set(key, entry);
  return entry;
}
// ---------------------------------------------------------------------------
// 首屏热门：音乐区排行榜（tid=3）
// 打开就有内容，不用先想搜什么。榜单本身几分钟才动一次，缓存 10 分钟，
// 免得每次刷新都打一遍 B 站（也降低风控概率）。
// 排行接口挂了就降级到全站热门，保证首屏永远不是空白。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 首屏热门
// 三档时间范围：week 近 7 天 / month 近 30 天 / total 累计榜（老对老桦的老内容，仅兜底）
// week、month 走「音乐区 + 发布时间窗口 + 指定排序」，实测条目最新才 1~3 天前。
// 每档按 range|order 单独缓存，来回切档不必重打 B 站，也降低风控概率。
// 排行接口挂了就降级到全站热门，保证首屏永远不是空白。
// ---------------------------------------------------------------------------
const hotCache = new Map(); // key: range|order -> { items, source, title, note, expiresAt }
const HOT_TTL_MS = 30 * 60 * 1000;
const HOT_LIMIT = 30;

function mapRankItem(it) {
  const videos = Number(it.videos) || 1;
  return {
    bvid: it.bvid,
    title: stripHtml(it.title),
    author: (it.owner && it.owner.name) || it.author || '',
    pic: normalizePic(it.pic),
    duration: parseDuration(it.duration),
    play: (it.stat && Number(it.stat.view)) || Number(it.play) || 0,
    pubdate: Number(it.pubdate) || 0,
    videos,
    // 多P合辑故意不给 cid：留给播放流程 resolve 时把整份歌单展开
    cid: videos > 1 ? 0 : Number(it.cid) || 0,
  };
}

function sortItems(items, order) {
  const arr = items.slice();
  if (order === 'click') arr.sort((a, b) => b.play - a.play);
  else if (order === 'pubdate') arr.sort((a, b) => b.pubdate - a.pubdate);
  return arr;
}

// 近 N 天音乐区：多个关键词各取一页，合并去重后按指定排序
async function searchRecentMusic(days, order) {
  const now = unixNow();
  const seen = new Map();
  for (const kw of HOT_KEYWORDS) {
    try {
      const data = await biliGet(SEARCH_URL, {
        search_type: 'video',
        keyword: kw,
        tids: MUSIC_TID,
        order: ALLOWED_ORDERS.has(order) ? order : 'click',
        pubtime_begin_s: String(now - days * 86400),
        pubtime_end_s: String(now),
        page: '1',
      });
      const list = (data.data && data.data.result) || [];
      for (const it of list) {
        if (!it || !it.bvid || seen.has(it.bvid)) continue;
        seen.set(it.bvid, mapVideoItem(it));
      }
    } catch (e) {
      console.warn(`[hot] keyword ${kw} failed: ${e.message}`);
    }
  }
  return sortItems([...seen.values()], order);
}

async function fetchRankFallback(order) {
  for (const [url, params, source] of [
    [RANK_URL, { rid: MUSIC_TID, type: 'all' }, 'rank'],
    [POPULAR_URL, { ps: '30', pn: '1' }, 'popular'],
  ]) {
    try {
      const data = await biliGet(url, params);
      const list = ((data.data && data.data.list) || []).filter((it) => it && it.bvid);
      if (list.length) {
        console.log(`[hot] ${source} -> ${list.length}`);
        return { items: sortItems(list.map(mapRankItem), order), source };
      }
    } catch (e) {
      console.warn(`[hot] ${source} failed: ${e.message}`);
    }
  }
  return { items: [], source: 'none' };
}

async function fetchHotMusic(range, order, force) {
  const rng = HOT_RANGES.has(range) ? range : 'week';
  const ord = ALLOWED_ORDERS.has(order) ? order : 'click';
  const key = `${rng}|${ord}`;
  const now = Date.now();
  const cached = hotCache.get(key);
  if (!force && cached && now < cached.expiresAt) {
    console.log(`[hot] cache hit ${key} (${cached.items.length})`);
    return cached;
  }

  let items = [];
  let source = 'search';
  if (rng === 'total') {
    const fb = await fetchRankFallback(ord);
    items = fb.items;
    source = fb.source;
  } else {
    const days = rng === 'week' ? 7 : 30;
    items = await searchRecentMusic(days, ord);
    console.log(`[hot] ${key} -> ${items.length}`);
    if (!items.length) {
      const fb = await fetchRankFallback(ord);
      items = fb.items;
      source = fb.source;
    }
  }
  const entry = { items, source, rng, expiresAt: now + HOT_TTL_MS };
  hotCache.set(key, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// 歌词：视频标题（或分P歌名）-> 多源查找（腾讯 -> 网易 -> lrclib）
// 单源实测命中率大概六七成，"基本都有词"靠串起来。
// 结果按 bvid|标题 缓存 6 小时：同一首歌切来切去不该反复打第三方接口，
// 也免得触发对方限流（网易官方接口被高频打会回 -462 风控）。
// ---------------------------------------------------------------------------
const lyricCache = new Map(); // key -> { found, song, lines, source, expiresAt }
const LYRIC_TTL_MS = 6 * 60 * 60 * 1000;
const LYRIC_CACHE_MAX = 400;

async function fetchJsonWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeout || LYRIC_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: opts.referer || REFERER, 'Accept-Encoding': 'identity' },
      signal: ctrl.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 把标题里的噪音去掉再搜，命中率明显更高
function lyricQueries(title, author) {
  const clean = (s) => String(s || '')
    .replace(/[（(【[][^）)】\]]*[）)】\]]/g, ' ')
    .replace(/\b(ft\.?|feat\.?)\b[\s\S]*$/i, ' ')
    .replace(/(高清|无损|HQ|SQ|官方音频|官方MV|MV|Live|现场版|伴奏|翻唱|纯音乐|钢琴版|吉他版)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const t = clean(title);
  const a = clean(author);
  const qs = [];
  if (t) qs.push(t);
  if (t && a && !t.includes(a)) qs.push(`${t} ${a}`);
  return qs.slice(0, 2);
}

function linesFromRaw(raw) {
  return String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// 只有作词/作曲元信息头不算命中，至少要有 2 行真歌词
function hasEnough(lines) {
  return lines.filter((l) => !/^\[(ti|ar|al|by|offset|re|ve|au|length):/i.test(l)).length >= 2;
}

async function lyricFromTencent(kw) {
  const s = await fetchJsonWithTimeout(`${LYRIC_BASE}/search/song?word=${encodeURIComponent(kw)}`);
  const list = (s.data && (s.data.list || s.data)) || [];
  const first = Array.isArray(list) ? list[0] : null;
  if (!first || !first.id) return null;
  const l = await fetchJsonWithTimeout(`${LYRIC_BASE}/lyric?id=${encodeURIComponent(first.id)}`);
  const raw = extractLyricRaw(l);
  if (!raw) return null;
  return { song: first.song || first.name || '', lines: linesFromRaw(raw), source: 'tencent' };
}

async function lyricFromNetease(kw) {
  const s = await fetchJsonWithTimeout(
    `${NETEASE_SEARCH}?s=${encodeURIComponent(kw)}&limit=5&type=1`,
    { referer: NETEASE_REFERER },
  );
  const songs = (s.result && s.result.songs) || [];
  // 前 3 个候选里挑第一个真有词的：翻唱、伴奏版常常挂着空歌词
  for (const song of songs.slice(0, 3)) {
    try {
      const l = await fetchJsonWithTimeout(
        `${NETEASE_LYRIC}?id=${song.id}&lv=1&kv=1&tv=-1`,
        { referer: NETEASE_REFERER },
      );
      const raw = l && l.lrc && l.lrc.lyric;
      if (raw && hasEnough(linesFromRaw(raw))) {
        return { song: song.name || '', lines: linesFromRaw(raw), source: 'netease' };
      }
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

async function lyricFromLrclib(kw) {
  const list = await fetchJsonWithTimeout(`${LRCLIB_SEARCH}?q=${encodeURIComponent(kw)}`);
  const arr = Array.isArray(list) ? list : [];
  // 优先要带时间轴的，没有就退化成纯文本
  const hit =
    arr.find((x) => x && x.syncedLyrics && x.syncedLyrics.trim()) ||
    arr.find((x) => x && x.plainLyrics && x.plainLyrics.trim());
  if (!hit) return null;
  const raw = hit.syncedLyrics || hit.plainLyrics || '';
  return { song: hit.trackName || hit.name || '', lines: linesFromRaw(raw), source: 'lrclib' };
}

const LYRIC_FETCHERS = { tencent: lyricFromTencent, netease: lyricFromNetease, lrclib: lyricFromLrclib };

async function lookupLyrics(title, author) {
  for (const q of lyricQueries(title, author)) {
    for (const src of LYRIC_SOURCE_ORDER) {
      try {
        const got = await LYRIC_FETCHERS[src](q);
        if (got && hasEnough(got.lines)) return got;
      } catch (e) {
        console.warn(`[lyrics] ${src} failed (${q.slice(0, 20)}): ${e.message}`);
      }
    }
  }
  return null;
}

async function fetchLyrics(bvid, titleOverride, authorHint, refresh) {
  let title = titleOverride || '';
  let author = authorHint || '';
  if (!title) {
    try {
      const view = await fetchView(bvid);
      title = view.title || '';
      author = author || view.author || '';
    } catch (e) {
      return { found: false, error: e.message };
    }
  }
  const key = `${bvid}|${title}`;
  if (!refresh) {
    const hit = lyricCache.get(key);
    if (hit && Date.now() < hit.expiresAt) {
      console.log(`[lyrics] cache hit ${key} (${hit.source || '?'})`);
      return { found: hit.found, song: hit.song, lines: hit.lines, source: hit.source, cached: true };
    }
  }
  const got = await lookupLyrics(title, author);
  const entry = got
    ? { found: true, song: got.song || title, lines: got.lines, source: got.source }
    : { found: false, song: '', lines: [], source: 'none' };
  if (lyricCache.size > LYRIC_CACHE_MAX) lyricCache.delete(lyricCache.keys().next().value);
  lyricCache.set(key, { ...entry, expiresAt: Date.now() + LYRIC_TTL_MS });
  console.log(`[lyrics] ${key} -> ${entry.found ? entry.source : 'miss'}`);
  return entry;
}

function extractLyricRaw(ldata) {
  if (typeof ldata === 'string') return ldata;
  if (ldata && ldata.data) {
    const d = ldata.data;
    return d.lyric || d.lrc || (d.lyricList && d.lyricList.join('\n')) || '';
  }
  if (ldata && ldata.lyric) return ldata.lyric;
  return '';
}

// ---------------------------------------------------------------------------
// 音频流式代理（带 Range 透传 + 多 CDN 候选回退）
// B 站 playurl 会返回多个 CDN（普通 upos / mcdn p2p 边缘节点），后者 Node fetch
// 经常握手失败，所以：候选择优 + 8 秒超时 + 逐个回退。
// ---------------------------------------------------------------------------
const STREAM_TIMEOUT_MS = 8000;

async function tryStream(cdnUrl, req, res, wantFull) {
  const headers = { 'User-Agent': UA, Referer: REFERER, 'Accept-Encoding': 'identity' };
  const ch = cookieHeader(guestCookies);
  if (ch) headers['Cookie'] = ch;
  // 分片上限（评审 P1-1）：缓存命中那条路早就按 RANGE_CHUNK 截了，
  // 但代理路径（缓存 miss）把客户端的 Range 原样透传 —— 无 Range / 开放右端时
  // 上游会把整首（几十 MB）一口气吐回来，弱网下就是一场重传风暴。
  // 现在与缓存路径对齐：默认截到 RANGE_CHUNK，播放器会自己带着新偏移回来；
  // full=1（客户端分片下载器）不受限，它本来就会按 content-range 推进。
  let range = req.headers['range'];
  if (!wantFull) {
    const m = /^bytes=(\d+)-(\d*)/.exec(range || '');
    if (m) {
      const s = Number(m[1]);
      const e = m[2] === '' ? s + RANGE_CHUNK - 1 : Math.min(Number(m[2]), s + RANGE_CHUNK - 1);
      range = `bytes=${s}-${e}`;
    } else {
      range = `bytes=0-${RANGE_CHUNK - 1}`;
    }
  }
  if (range) headers['Range'] = range;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), STREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(cdnUrl, { headers, redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  // 只有拿到可用响应（200/206）才"承诺"写响应头；其余状态换下一个候选
  if (upstream.status !== 200 && upstream.status !== 206) {
    upstream.body?.cancel?.();
    throw new Error('upstream HTTP ' + upstream.status);
  }
  console.log(`[stream] ok status=${upstream.status} type=${upstream.headers.get('content-type')} len=${upstream.headers.get('content-length')} cdn=${cdnUrl.slice(0, 50)}...`);

  res.statusCode = upstream.status;
  res.setHeader('x-audio-cache', 'miss');
  // 统一强制 audio/mp4：上游 CDN 的 content-type 很杂（有 octet-stream、
  // 甚至 application/json），透传出去手机浏览器会拒播，这是之前“播放老失败”的主因之一
  res.setHeader('content-type', 'audio/mp4');
  // 别让上游 nginx 缓冲这条流，否则手机端首帧迟迟拿不到数据会被判 stall
  res.setHeader('x-accel-buffering', 'no');
  for (const h of ['content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) {
    res.end();
    return true;
  }
  const nodeStream = Readable.fromWeb(upstream.body);
  // 空闲超时 + 客户端断开主动回收：
  // 浏览器播媒体时会频繁掐断 Range 请求再按新偏移重连（正常行为），掐断后必须
  // 立刻回收上游连接，否则 30s 空闲定时器触发 teardown。
  // 注意：upstream.body.cancel() 在流已被 fromWeb 锁定时会返回被拒绝的 Promise，
  // 必须用 Promise.resolve().catch() 接住，否则 unhandledRejection 会崩掉整个进程
  //（这是上一版"播放老失败"的真正元凶：进程崩 -> 容器重启 -> 正在播的歌全断）。
  const IDLE_TIMEOUT_MS = 30000;
  let torn = false;
  let idleTimer = null;
  const teardown = (why) => {
    if (torn) return;
    torn = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (why !== 'client-closed') console.log(`[stream] teardown (${why})`);
    try {
      const c = upstream.body && upstream.body.cancel ? upstream.body.cancel() : null;
      if (c && typeof c.catch === 'function') c.catch(() => {});
    } catch {}
    try { nodeStream.destroy(); } catch {}
    try { res.destroy(); } catch {}
  };
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => teardown('no-data-30s'), IDLE_TIMEOUT_MS);
  };
  resetIdle();
  nodeStream.on('data', resetIdle);
  nodeStream.on('error', () => teardown('upstream-error'));
  // 流正常结束：只清空闲计时器，让 pipe 自己调 res.end() 优雅收尾。
  // 千万不能在这里 destroy(res)——手机读得慢，Node 缓冲区里没发完的尾巴会被
  // 一起丢掉，浏览器看到"响应比 Content-Range 短"直接判为致命错误（点开就报错）。
  nodeStream.on('end', () => { if (idleTimer) clearTimeout(idleTimer); });
  res.on('close', () => teardown('client-closed'));
  nodeStream.pipe(res);
  return true;
}

// 返回 true=已成功开始响应；false=全部候选失败（响应头未发出时由调用方决定如何回错）
async function proxyStream(candidates, req, res, wantFull) {
  const errors = [];
  for (const url of candidates) {
    try {
      console.log(`[stream] trying ${url.slice(0, 60)}... range=${req.headers['range'] || '<none>'}`);
      const done = await tryStream(url, req, res, wantFull);
      if (done) return true;
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'timeout' : (e.message || String(e));
      console.log(`[stream] candidate failed: ${msg}`);
      errors.push(msg);
    }
  }
  console.log('[stream] ALL candidates failed: ' + errors.join('; '));
  return false;
}

// ---------------------------------------------------------------------------
// 服务端音频缓存（常听的歌落 NAS 本地盘）
// 一首歌第一次播完就存下来，之后直接读本地文件：
//   ① 二次播放秒开，不再依赖 B 站直链当时的质量
//   ② 手机上听可以减少一次外网上行，也不再重复触发取流（少撞风控）
// key 用 cid —— 同一 cid 恒等于同一条音轨。
// ---------------------------------------------------------------------------
function ensureAudioCacheDir() {
  if (!fs.existsSync(AUDIO_CACHE_DIR)) fs.mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
}

function audioCacheFile(cid) {
  return path.join(AUDIO_CACHE_DIR, `${cid}.m4a`);
}

function cachedAudioSize(cid) {
  try {
    const st = fs.statSync(audioCacheFile(cid));
    return st && st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

// 单个 206 响应允许返回的最大字节数。
//
// 背景（2026-10-09 真机实测）：iPhone Safari 经 FN Connect 远程访问时点歌不响，
// 服务端每次都看到了完整请求、也正常吐了数据（206 + 整首 2.6~3.4MB），
// 但播放器 readyState 一直 0、buffered 为空，每 4 秒 stalled 重试一次，无限循环。
// 原因：一次性吐整首时，这条请求要在弱网隧道里传十几秒；浏览器等不到首包就判卡死，
// 重试又把已经传到一半的数据全丢掉 —— 永远传不完（典型的「重传风暴」死锁）。
//
// 对策：单个响应最多吐 RANGE_CHUNK 字节。RFC 7233 允许服务端返回一个比请求更小的范围，
// 播放器会自己接着请求后续区间。这样每个 HTTP 响应都在亚秒级完成，
// 弱网下也能边下边播，不会触发重试风暴。
const RANGE_CHUNK = 192 * 1024;

// 本地命中：直接 fs 流式返回 + 手算 Range。
// Content-Range 算错一个字节，浏览器就会判定"响应不完整"并直接报错，
// 所以这里严格按 RFC 7233 处理三种形态： a-b / a- / -b，越界回 416。
// noChunk=true 时不截断（客户端专用，见下）：客户端自己分片并发下载时，
// 192KB 的上限会让一次下载变成上百次往返；而媒体栈路径必须保持小分片，
// 否则又会回到「整首一次性吐出 → 弱网重传风暴」的老问题上。
function serveCachedAudio(req, res, cid, size, noChunk) {
  const file = audioCacheFile(cid);
  res.setHeader('content-type', 'audio/mp4');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('x-audio-cache', 'hit');
  // cid 唯一对应一份音频，内容永不变化 —— 允许浏览器整段缓存，
  // 切歌时（预载元素 → 主元素）即使不走元素切换也能零网络命中。
  res.setHeader('cache-control', 'private, max-age=3600, immutable');
  // 告诉上游 nginx 别缓冲这条流（网关 /app/ location 自己没关 buffering）
  res.setHeader('x-accel-buffering', 'no');
  const range = req.headers['range'];
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1]) start = Number(m[1]);
    if (m[2]) {
      const tail = Number(m[2]);
      if (!m[1]) { start = Math.max(0, size - tail); }  // "-N" = 末尾 N 字节
      else end = tail;
    }
    if (!Number.isFinite(start) || start >= size) {
      res.writeHead(416, { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    end = Math.min(end, size - 1);
    if (end < start) end = start;
    // 分片上限：一次最多吐 RANGE_CHUNK 字节，剩下的让播放器自己继续要。
    // bytes=0-1 这类探测包本来就没超过上限，不受影响。
    if (!noChunk && end - start + 1 > RANGE_CHUNK) {
      end = start + RANGE_CHUNK - 1;
      res.setHeader('x-range-policy', 'chunk');
    }
    res.statusCode = 206;
    res.setHeader('content-length', String(end - start + 1));
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  } else {
    // 无 Range 请求（渐进下载）同样分片：整首一次吐出去，弱网下会被中途重试打回
    res.statusCode = 200;
    res.setHeader('content-length', String(size));
  }
  const rs = fs.createReadStream(file, m ? { start, end } : {});
  rs.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => { try { rs.destroy(); } catch {} });
  rs.pipe(res);
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch {}   // 触达时间用于 LRU
  console.log(`[cache] hit cid=${cid} ${start}-${end}/${size}`);
}

// ---------------------------------------------------------------------------
// B 站 DASH fMP4 重混流（2026-10-10 真机实锤的 iOS 大坑）：
// B 站音频流是分片式 MP4（ftyp 带 dash 品牌、805B 空 moov + mvex + 45 个 moof/mdat）。
// 桌面 Chrome 能完整解析（mvhd 说 253.9s 就是 253.9s），但 iOS Safari 只解析出
// 前 20.1s —— 表现为「一首 4 分钟的歌只播十几秒就没了」，进度冻在 13s 附近。
// 对策：落盘后用 ffmpeg -c copy 重混成普通 faststart MP4（不转码，秒级），
// moov 重建后 iOS 解析正常。ffmpeg 在 fnOS 上自带（/usr/bin/ffmpeg）。
// ---------------------------------------------------------------------------
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';

// 并发防护：启动迁移和播放懒迁移可能撞同一个文件（实测 466MB 大文件真的撞了，
// 还留下了 406MB 的 .remux 残留）。同一文件同时只允许一个 ffmpeg。
const remuxInFlight = new Set();

// 失败负标记（v1.3.0 · 评审 P0-5）：以前 ffmpeg 失败既没日志也没标记，
// 下一次 /api/play 又会从头再试一遍 —— 同一个坏文件每小时能吃掉几十次
// 180 秒的空等。现在失败记 24 小时，期间直接跳过（桌面端不受影响，
// 这类文件本来就不是标准 MP4，重混失败多半是源流真的有问题）。
const REMUX_FAIL_TTL = 24 * 3600 * 1000;
const remuxFailAt = new Map();
function remuxRecentlyFailed(file) {
  const t = remuxFailAt.get(file);
  if (!t) return false;
  if (Date.now() - t > REMUX_FAIL_TTL) { remuxFailAt.delete(file); return false; }
  return true;
}

function fileLooksDash(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, 0);
    fs.closeSync(fd);
    return buf.includes(Buffer.from('dash'));
  } catch { return false; }
}

async function remuxDashToFaststart(file) {
  if (remuxInFlight.has(file) || remuxRecentlyFailed(file)) return false;
  // 只处理 DASH 分片式文件；普通 MP4 原样返回
  if (!fileLooksDash(file)) return false;
  remuxInFlight.add(file);
  try {
    const tmp = `${file}.${process.pid}.remux`;
    try { fs.unlinkSync(tmp); } catch {}
    // -loglevel error：stderr 只留错误（以前全量进度输出，几 MB 的 stderr
    // 直接把默认 1MB 的 maxBuffer 撑爆，node 会杀掉 ffmpeg —— 表现为重混
    // 静默失败，没有任何日志，坏文件还留在缓存里被反复使用）。
    // maxBuffer 提到 8MB 双保险；-nostdin 防止它挂在 stdin 上。
    const ok = await new Promise((resolve) => {
      try {
        execFile(FFMPEG_BIN,
          ['-nostdin', '-loglevel', 'error', '-y', '-i', file, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp],
          { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
          (err, _so, se) => {
            if (err) console.error(`[remux] 失败 ${path.basename(file)}: ${(se || err.message).slice(0, 200)}`);
            resolve(!err);
          });
      } catch (e) {
        console.error(`[remux] 启动失败: ${e.message}`);
        resolve(false);
      }
    });
    if (!ok) {
      remuxFailAt.set(file, Date.now());
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
    try {
      const st = fs.statSync(tmp);
      if (st.size >= 64 * 1024) {
        fs.renameSync(tmp, file);
        console.log(`[cache] remuxed dash->faststart ${(st.size / 1048576).toFixed(1)}MB ${path.basename(file)}`);
        return true;
      }
      fs.unlinkSync(tmp);
    } catch {}
    remuxFailAt.set(file, Date.now());
    return false;
  } finally {
    remuxInFlight.delete(file);
  }
}

// 后台完整拉取并落盘，不阻塞当前播放：
// 正在播的那条流照旧走 CDN 转发，同时悄悄把整首拉下来存好，
// 下次播放（以及之后每次）就直接读本地文件了。
const pendingDownloads = new Map();

// 下载并发闸门 + 磁盘水位（评审共识 #3）：
// 以前只按 cid 去重，没有全局上限 —— 在收藏夹里快速划过一排没缓存过的歌，
// 就是 N 个并发几十 MB 的下载同时写盘；更糟的是磁盘写满之后，收藏夹的
// JSON 写入也开始失败。现在：
//   ① 最多同时 DL_CONCURRENCY 个下载在跑，排队的走队列（FIFO）；
//   ② 下载前查磁盘剩余空间，低于 DL_MIN_FREE_BYTES 就不下载（缓存 miss 不致命，
//     收藏写不进去才致命）。
const DL_CONCURRENCY = Math.max(1, Number(process.env.DL_CONCURRENCY || 2));
const DL_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;   // 剩余 < 2GB 就不再往缓存里写
const dlQueue = [];
let dlActive = 0;

function diskFreeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bsize * st.bavail;
  } catch { return Number.MAX_SAFE_INTEGER; }   // statfs 不可用的平台当作无限
}

function scheduleDownload(run) {
  return new Promise((resolve, reject) => {
    const start = () => {
      dlActive++;
      run().then(resolve, reject).finally(() => {
        dlActive--;
        const next = dlQueue.shift();
        if (next) next();
      });
    };
    if (dlActive < DL_CONCURRENCY) start();
    else dlQueue.push(start);
  });
}

function downloadToCache(cid, candidates) {
  const key = String(cid);
  if (pendingDownloads.has(key)) return;
  const file = audioCacheFile(cid);
  const task = (async () => {
    const tmp = `${file}.${process.pid}.part`;
    let saved = false;
    try {
      ensureAudioCacheDir();
      // 磁盘水位：宁可放弃缓存（大不了现场代理），不能把盘写满拖垮收藏写入
      const free = diskFreeBytes(AUDIO_CACHE_DIR);
      if (free < DL_MIN_FREE_BYTES) {
        console.warn(`[cache] 跳过下载：磁盘仅剩 ${(free / 1048576 / 1024).toFixed(1)}GB（阈值 2GB）`);
        return;
      }
      await scheduleDownload(async () => {
        for (const url of candidates.slice(0, 2)) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(new Error('download timeout')), DL_TIMEOUT_MS);
          try {
            const up = await fetch(url, {
              headers: { 'User-Agent': UA, Referer: REFERER, 'Accept-Encoding': 'identity' },
              signal: ctrl.signal,
            });
            if (up.status !== 200 || !up.body) continue;
            await pipeline(Readable.fromWeb(up.body), fs.createWriteStream(tmp));
            const size = fs.statSync(tmp).size;
            if (size >= AUDIO_CACHE_MIN_BYTES) {
              fs.renameSync(tmp, file);
              saved = true;
              console.log(`[cache] saved cid=${cid} ${(size / 1048576).toFixed(1)}MB (active=${dlActive}, queued=${dlQueue.length})`);
              await remuxDashToFaststart(file);
              break;
            }
            console.warn(`[cache] too small (${size}B), skip`);
          } catch (e) {
            console.warn(`[cache] candidate failed: ${e.message}`);
          } finally {
            clearTimeout(timer);
          }
        }
      });
      if (!saved) { try { fs.unlinkSync(tmp); } catch {} }
      sweepAudioCache();
    } catch (e) {
      console.warn('[cache] download task failed:', e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  })();
  pendingDownloads.set(key, task);
  const done = () => pendingDownloads.delete(key);
  if (task.finally) task.finally(done); else task.then(done, done);
  // 同步等待用：返回同一个 task，/api/prefetch?wait=1 会 await 它
  return task;
}

// LRU 清理：超过文件数或总量就删最久没听的
function sweepAudioCache() {
  try {
    ensureAudioCacheDir();
    const list = fs.readdirSync(AUDIO_CACHE_DIR)
      .filter((f) => f.endsWith('.m4a'))
      .map((f) => {
        const p = path.join(AUDIO_CACHE_DIR, f);
        const s = fs.statSync(p);
        return { p, size: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime);   // 最久没听的排前面
    let total = list.reduce((a, b) => a + b.size, 0);
    let removed = 0;
    while (list.length && (total > MAX_CACHE_BYTES || list.length > MAX_CACHE_FILES)) {
      const victim = list.shift();
      try {
        fs.unlinkSync(victim.p);
        total -= victim.size;
        removed++;
      } catch {}
    }
    if (removed) console.log(`[cache] swept ${removed} -> ${list.length} files / ${(total / 1048576).toFixed(0)}MB`);
    return { files: list.length, bytes: total, removed };
  } catch (e) {
    console.warn('[cache] sweep failed:', e.message);
    return { files: 0, bytes: 0, removed: 0 };
  }
}

function audioCacheStats() {
  try {
    ensureAudioCacheDir();
    const list = fs.readdirSync(AUDIO_CACHE_DIR).filter((f) => f.endsWith('.m4a'));
    let bytes = 0;
    for (const f of list) {
      try { bytes += fs.statSync(path.join(AUDIO_CACHE_DIR, f)).size; } catch {}
    }
    return { files: list.length, bytes, maxBytes: MAX_CACHE_BYTES, maxFiles: MAX_CACHE_FILES };
  } catch {
    return { files: 0, bytes: 0, maxBytes: MAX_CACHE_BYTES, maxFiles: MAX_CACHE_FILES };
  }
}

// ---------------------------------------------------------------------------
// IP 限流
// 本服务原本只在家里用，端口一转发到公网就是"谁都能访问"。没有上限时
// 被人扫到会变成免费代理，还可能把 B 站风控引到家里。令牌桶够自家正常听歌，
// 挡得住脚本式高频请求。
// ---------------------------------------------------------------------------
const RATE_BUCKETS = {
  play:    { cap: 240, per: 60 },  // Range 请求多，一首歌几分钟能有几十次
  api:     { cap: 120, per: 60 },
  search:  { cap: 40,  per: 60 },
  resolve: { cap: 30,  per: 60 },  // 最贵：view + playurl 两次 B 站往返
  hot:     { cap: 20,  per: 60 },
  lyrics:  { cap: 40,  per: 60 },
  write:   { cap: 60,  per: 60 },
};
const rateState = new Map(); // ip|kind -> { tokens, at }

function clientIp(req) {
  const ra = req.socket.remoteAddress || 'unknown';
  // X-Forwarded-For 只在「连接确实来自本机反代（Caddy）」时才信，而且取最后一跳：
  // Caddy 会把真实客户端 IP 追加到末尾，攻击者自己伪造的前面几跳污染不了它。
  // 以前无条件信任第一跳 —— 直连 8362 的任何人带个假 XFF 就能换着 IP 绕过限流。
  const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  if (isLocal) {
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return ra;
}

function rateAllow(ip, kind) {
  const cfg = RATE_BUCKETS[kind] || RATE_BUCKETS.api;
  const now = Date.now();
  const key = `${ip}|${kind}`;
  let b = rateState.get(key);
  if (!b) {
    b = { tokens: cfg.cap, at: now };
    rateState.set(key, b);
  }
  const refill = ((now - b.at) / 1000) * (cfg.cap / cfg.per);
  if (refill > 0) {
    b.tokens = Math.min(cfg.cap, b.tokens + refill);
    b.at = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// 定期回收长时间没动静的桶，避免 Map 无限增长
const rateSweeper = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of rateState) if (v.at < cutoff) rateState.delete(k);
}, 5 * 60 * 1000);
if (rateSweeper.unref) rateSweeper.unref();

// ---------------------------------------------------------------------------
// 播放列表（多列表，JSON 持久化）
// 数据文件 playlists.json：
//   { version:2, active:'<id>', order:['<id>',…],
//     lists:{ <id>: { id, name, createdAt, items:[ {bvid,cid,title,author,pic,duration,lyricKey,addedAt} ] } } }
// 旧版单收藏夹 favorites.json 首次读取时自动迁移成名为「我的收藏」的列表。
// ---------------------------------------------------------------------------
const PL_FILE = path.join(DATA_DIR, 'playlists.json');
const LEGACY_FAV_FILE = path.join(DATA_DIR, 'favorites.json');
const DEFAULT_PL_NAME = '我的收藏';
const MAX_PLAYLISTS = 30;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 同一视频的不同分P是不同曲目，去重键必须带 cid
function itemKey(it) {
  return `${(it && it.bvid) || ''}|${(it && it.cid) || ''}`;
}

function newPlaylist(name) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || DEFAULT_PL_NAME,
    createdAt: Date.now(),
    items: [],
  };
}

// ---------------------------------------------------------------------------
// 数据文件读写保护（v1.3.0 · 第二轮评审 P0-1/P0-2/P0-3）
//
// 以前的写法：readPlaylists 用一个无条件的 catch 把「文件不存在」「读不出来」
// 「JSON 是半截的」全当成"重建"，然后 writePlaylists(新建空结构) 把原文件盖掉。
// 后果：USB 盘抖一下读出 EIO、或者掉电落了个半截 JSON —— 用户恰好刷新一次页面，
//       几十个收藏夹就没了，而且程序亲手销毁了唯一的现场。
// 收藏夹是这个项目里唯一没有备份的数据，这个 catch 就是最危险的一行。
//
// 现在的原则：**只有"文件确实不存在"才允许重建**。
// 读不出来 / 解析不了 -> ①改名隔离到 .corrupt-<时间戳> 保留现场 ②打日志
//                       ③返回只读的空结构，并且**禁止本次进程做任何回写**。
// 这样最坏情况只是"这次看起来是空的"，数据还在盘上，可以手工救回来。
// ---------------------------------------------------------------------------
const dataWritable = { playlists: true, history: true };
let readonlyPlaylists = null;

// P0-2：写入失败必须让用户知道。以前 writePlaylists/writeHistory 返回的 false
// 被十几个调用点全部忽略 —— 前端收到 200 以为收藏上了，其实一个字节都没进盘。
// 现在凡是写失败一律 503，前端可以明确提示"没保存成功"。
function sendSaveFailed(res, what) {
  return sendJson(res, 503, {
    error: `${what}没能保存：数据文件当前不可写（源文件可能已损坏被隔离为 *.corrupt-*）。请到服务器上处理后重试。`,
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// 把坏文件挪到一边留证据，而不是原地覆盖
function quarantineCorrupt(file, err) {
  const dst = `${file}.corrupt-${stamp()}`;
  try {
    fs.renameSync(file, dst);
    console.error(`[data] ${file} 无法解析（${err && err.message}），已隔离为 ${dst}；保留现场，不会自动重建。`);
  } catch (e) {
    // 挪不动（比如盘只读）也不能继续往下写，靠 writable 标志挡住
    console.error(`[data] ${file} 无法解析且无法隔离（${e && e.code}），本次会话禁止写入。`);
  }
}

// 落盘三件事：写 -> fsync 文件 -> rename -> fsync 目录。
// rename 保证原子替换，但**内容真正进磁盘**需要 fsync；少了它，掉电后会留下半截文件，
// 下次启动撞上这个半截文件 —— 正好串联成上面那个灾难（现在已经被 dWritable 挡住了，但还是要写对）。
function writeFileFsync(file, content) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, content);
    try { fs.fsyncSync(fd); } catch { /* 某些平台/文件系统不支持，能写多少算多少 */ }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } catch {}
  } catch { /* Windows 上目录 fsync 直接不支持 */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
}

// 只读兜底结构：进程内保持稳定，避免每次调用生成新 id
function emptyPlaylists() {
  if (!readonlyPlaylists) {
    const pl = newPlaylist(DEFAULT_PL_NAME);
    readonlyPlaylists = { version: 2, active: pl.id, order: [pl.id], lists: { [pl.id]: pl } };
  }
  return readonlyPlaylists;
}

function readPlaylists() {
  ensureDataDir();
  let raw = null;
  let readErr = null;
  try {
    raw = fs.readFileSync(PL_FILE, 'utf8');
  } catch (e) {
    readErr = e;
  }

  // 情况一：读不出来。ENOENT = 确实没有（首次启动），其他错误 = 盘有问题。
  if (raw === null) {
    if (readErr && readErr.code !== 'ENOENT') {
      dataWritable.playlists = false;
      console.error(`[playlists] 读取失败（${readErr.code}），拒绝重建以免覆盖原数据。`);
      return emptyPlaylists();
    }
    return migrateLegacyOrNew();
  }

  // 情况二：读出来了但解析不了 / 结构不对 —— 隔离后禁写，绝不重建
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    quarantineCorrupt(PL_FILE, e);
    dataWritable.playlists = false;
    return emptyPlaylists();
  }
  if (data && data.lists && typeof data.lists === 'object') {
    if (!Array.isArray(data.order) || !data.order.length) data.order = Object.keys(data.lists);
    data.order = data.order.filter((id) => data.lists[id]);
    // 补齐历史上可能存在但不在 order 里的列表，避免"看不见但删不掉"
    for (const id of Object.keys(data.lists)) if (!data.order.includes(id)) data.order.push(id);
    if (!data.active || !data.lists[data.active]) data.active = data.order[0];
    for (const id of data.order) {
      const l = data.lists[id];
      if (!Array.isArray(l.items)) l.items = [];
    }
    return data;
  }
  quarantineCorrupt(PL_FILE, new Error('顶层结构不符（缺 lists）'));
  dataWritable.playlists = false;
  return emptyPlaylists();
}

// 只在"两个数据文件都不存在"时才走：迁移旧版单收藏夹，或建一个空的默认收藏夹
function migrateLegacyOrNew() {
  let legacy = [];
  try {
    const arr = JSON.parse(fs.readFileSync(LEGACY_FAV_FILE, 'utf8'));
    if (Array.isArray(arr)) legacy = arr;
  } catch { /* 没有旧数据 */ }
  const pl = newPlaylist(DEFAULT_PL_NAME);
  pl.items = legacy.map((f) => ({
    bvid: f.bvid,
    cid: Number(f.cid) || 0,
    title: f.title || '',
    author: f.author || '',
    pic: f.pic || '',
    duration: Number(f.duration) || 0,
    lyricKey: f.lyricKey || '',
    addedAt: f.addedAt || Date.now(),
  }));
  const data = { version: 2, active: pl.id, order: [pl.id], lists: { [pl.id]: pl } };
  writePlaylists(data);
  if (legacy.length) console.log(`[playlists] migrated ${legacy.length} legacy favorites`);
  return data;
}

function writePlaylists(data) {
  if (!dataWritable.playlists) {
    console.error('[playlists] 拒绝写入：原数据已隔离为 .corrupt-*，先手工确认再删掉它才会重建。');
    return false;
  }
  ensureDataDir();
  const lock = acquireDataLock('playlists');
  if (!lock) { console.warn('[playlists] 写入跳过：未能在 500ms 内拿到数据锁'); return false; }
  try {
    const tmp = `${PL_FILE}.${process.pid}.tmp`;
    writeFileFsync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, PL_FILE);
    fsyncDir(path.dirname(PL_FILE));
    return true;
  } catch (e) {
    console.error('[playlists] 写入失败：', e && e.message);
    return false;
  } finally { releaseDataLock(lock); }
}

// 最近播放 / 续播进度。history.json：{ items:[ {bvid,cid,title,author,pic,duration,lyricKey,position,updatedAt} ] }
// 记 position 是为了"上次听到哪就从哪接着听"——手机场景真正需要的东西。
function readHistory() {
  ensureDataDir();
  let raw = null;
  let readErr = null;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch (e) {
    readErr = e;
  }
  if (raw === null) {
    // 同样只有"确实是空的"才当空；读不出来时禁写，避免把续播记录用空数组盖掉
    if (readErr && readErr.code !== 'ENOENT') {
      dataWritable.history = false;
      console.error(`[history] 读取失败（${readErr.code}），本次会话禁止写入以免覆盖原数据。`);
    }
    return { items: [] };
  }
  try {
    const h = JSON.parse(raw);
    if (h && Array.isArray(h.items)) return h;
  } catch (e) {
    quarantineCorrupt(HISTORY_FILE, e);
    dataWritable.history = false;
    return { items: [] };
  }
  quarantineCorrupt(HISTORY_FILE, new Error('顶层结构不符（缺 items）'));
  dataWritable.history = false;
  return { items: [] };
}

function writeHistory(h) {
  if (!dataWritable.history) {
    console.error('[history] 拒绝写入：原数据已隔离为 .corrupt-*，先手工处理才会继续。');
    return false;
  }
  ensureDataDir();
  const lock = acquireDataLock('history');
  if (!lock) { console.warn('[history] 写入跳过：未能在 500ms 内拿到数据锁'); return false; }
  try {
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    writeFileFsync(tmp, JSON.stringify(h, null, 2));
    fs.renameSync(tmp, HISTORY_FILE);
    fsyncDir(path.dirname(HISTORY_FILE));
    return true;
  } catch (e) {
    console.error('[history] 写入失败：', e && e.message);
    return false;
  } finally { releaseDataLock(lock); }
}

// 对外只暴露摘要（不含 items），避免列表多时一次拉太多
function publicLists(data) {
  return {
    active: data.active,
    lists: data.order.map((id) => ({
      id,
      name: data.lists[id].name,
      count: data.lists[id].items.length,
    })),
  };
}

function normalizeItem(src) {
  return {
    bvid: String(src.bvid || ''),
    cid: Number(src.cid) || 0,
    title: src.title || '',
    author: src.author || '',
    pic: src.pic || '',
    duration: Number(src.duration) || 0,
    lyricKey: src.lyricKey || '',
    addedAt: Date.now(),
  };
}

// 兼容旧客户端：把隐藏的当前列表当收藏夹用
function readFavorites() {
  const d = readPlaylists();
  return d.lists[d.active].items;
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function parseCookieHeader(h) {
  const o = {};
  String(h || '').split(';').forEach((s) => {
    const i = s.indexOf('=');
    if (i > 0) o[s.slice(0, i).trim()] = decodeURIComponent(s.slice(i + 1).trim());
  });
  return o;
}

// 前端诊断日志里可能带 location.href（含 ?k=），落盘前递归打码
function redactSecrets(v, depth = 0) {
  if (!ACCESS_TOKEN || depth > 6) return v;
  if (typeof v === 'string') return v.includes(ACCESS_TOKEN) ? v.split(ACCESS_TOKEN).join('***') : v;
  if (Array.isArray(v)) return v.map((x) => redactSecrets(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = redactSecrets(val, depth + 1);
    return o;
  }
  return v;
}

// /api/log?f= 只允许读日志目录里的 .log 文件：
// 直接把参数拼进 path.join 等于开放任意文件读取（?f=../../../etc/passwd）。
function safeLogName(n) {
  if (!n) return '';
  const s = String(n);
  if (s !== path.basename(s)) return '';            // 任何带 / 或 .. 的一律拒绝
  if (!/^[A-Za-z0-9._-]+\.log$/.test(s)) return ''; // 只认日志文件
  const root = path.resolve(LOG_DIR);
  const full = path.resolve(root, s);
  return full.startsWith(root + path.sep) ? s : '';
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // 限流：health 放行（探活用），其余按接口代价分桶
  if (p !== '/api/health') {
    const kind =
      p === '/api/search' ? 'search' :
      p === '/api/resolve' || p === '/api/prefetch' ? 'resolve' :
      p === '/api/play' ? 'play' :
      p === '/api/hot' ? 'hot' :
      p === '/api/lyrics' ? 'lyrics' :
      req.method !== 'GET' ? 'write' : 'api';
    if (!rateAllow(clientIp(req), kind)) {
      console.warn(`[rate] 429 ${clientIp(req)} ${p}`);
      res.setHeader('Retry-After', '10');
      return sendJson(res, 429, { error: '手速太快了，歇 10 秒再试', retry: true });
    }
  }

  if (p === '/api/health') {
    // health 必须说真话（评审 P2-13）：以前恒 ok:true —— B 站接口挂死、
    // 磁盘写满、ffmpeg 不在，对外全是"健康"，坏一整天没人知道。
    // 现在检查三件真正影响使用的事：磁盘可写性、剩余空间、ffmpeg 在不在。
    // 注意它仍不主动打 B 站（探活不能被上游故障放大），B 站可用性看 bili 字段。
    const checks = { diskWritable: false, diskFreeBytes: 0, ffmpeg: false };
    try {
      const probe = path.join(DATA_DIR, `.health-${process.pid}`);
      fs.writeFileSync(probe, String(Date.now()));
      fs.unlinkSync(probe);
      checks.diskWritable = true;
    } catch {}
    checks.diskFreeBytes = diskFreeBytes(DATA_DIR);
    if (checks.diskFreeBytes === Number.MAX_SAFE_INTEGER) checks.diskFreeBytes = -1;
    checks.ffmpeg = fs.existsSync(FFMPEG_BIN);
    const ok = checks.diskWritable && checks.diskFreeBytes > 512 * 1024 * 1024;
    return sendJson(res, ok ? 200 : 503, {
      ok,
      service: 'bili-music-web',
      features: ['history', 'prefetch', 'lyric-multi-source', 'audio-cache', 'rate-limit'],
      audioCache: audioCacheStats(),
      checks,
      bili: { note: '本接口不探测 B 站（探活不应被上游故障放大）；搜索/取流失败会在响应里体现' },
    });
  }

  // -------------------------------------------------------------------------
  // 最近播放 / 断点续播进度
  //   GET    /api/history              -> { items:[…最近 60 条] }
  //   POST   /api/history {item,position} -> upsert（同一首覆盖并提到最前）
  //   DELETE /api/history?all=1        -> 清空；?key=bvid|cid -> 删单条
  // -------------------------------------------------------------------------
  // 诊断日志：POST 批量写入，GET ?n=200 取最后 N 行（远程复盘 iOS 后台行为用）
  if (p === '/api/log') {
    if (req.method === 'GET') {
      try {
        const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log'));
        if (!files.length) return sendJson(res, 200, { files: [], file: null, lines: [] });
        const stats = files.map((f) => {
          const st = fs.statSync(path.join(LOG_DIR, f));
          return { f, size: st.size, mtime: st.mtimeMs };
        }).sort((a, b) => b.mtime - a.mtime);
        const want = safeLogName(q.get('f')) || stats[0].f;
        const n = Math.min(Number(q.get('n') || 200), 3000);
        const raw = fs.readFileSync(path.join(LOG_DIR, want), 'utf8').trim().split('\n');
        return sendJson(res, 200, {
          files: stats,
          file: want,
          lines: raw.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }),
        });
      } catch (e) {
        return sendJson(res, 200, { files: [], file: null, lines: [], error: e.message });
      }
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const arr = Array.isArray(body && body.logs) ? body.logs : [];
      console.log(`[log] arrived keys=${Object.keys(body || {}).join(',')} arr=${arr.length} ct=${req.headers['content-type']} len=${req.headers['content-length']}`);
      let written = 0;
      if (arr.length) {
        try {
          fs.mkdirSync(LOG_DIR, { recursive: true });
          const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
          const ip = String(clientIp(req) || 'unknown').replace(/[^\w.:-]/g, '_');
          const tag = (body && body.client) ? String(body.client).replace(/[^\w-]/g, '_').slice(0, 16) : '';
          const file = path.join(LOG_DIR, `${day}-${ip}${tag ? '-' + tag : ''}.log`);
          let rotate = false;
          try { if (fs.statSync(file).size > LOG_MAX_BYTES) rotate = true; } catch {}
          if (rotate) {
            try { fs.renameSync(file, file.replace(/\.log$/, '.1.log')); } catch {}
          }
          fs.appendFileSync(file, arr.map((r) => JSON.stringify(redactSecrets(r))).join('\n') + '\n');
          written = arr.length;
        } catch (e) {
          console.warn('[log] write failed: ' + e.message);
        }
      }
      return sendJson(res, 200, { ok: true, n: written });
    }
    return sendJson(res, 405, { error: 'POST or GET only' });
  }

  if (p === '/api/history') {
    if (req.method === 'GET') {
      const h = readHistory();
      return sendJson(res, 200, { items: h.items });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const src = (body && body.item) || {};
      if (!/^BV\w+$/i.test(String(src.bvid || ''))) return sendJson(res, 400, { error: 'bvid 缺失' });
      const pos = Number(body.position) || 0;
      const h = readHistory();
      const key = `${src.bvid}|${Number(src.cid) || 0}`;
      const entry = {
        bvid: String(src.bvid),
        cid: Number(src.cid) || 0,
        title: src.title || '',
        author: src.author || '',
        pic: src.pic || '',
        duration: Number(src.duration) || 0,
        lyricKey: src.lyricKey || '',
        position: pos,
        updatedAt: Date.now(),
      };
      h.items = h.items.filter((x) => `${x.bvid}|${x.cid || 0}` !== key);
      h.items.unshift(entry);
      if (h.items.length > HISTORY_MAX) h.items = h.items.slice(0, HISTORY_MAX);
      if (!writeHistory(h)) return sendSaveFailed(res, '播放记录');
      return sendJson(res, 200, { items: h.items.slice(0, 1) });
    }
    if (req.method === 'DELETE') {
      const h = readHistory();
      if (q.get('all') === '1') h.items = [];
      else {
        const key = q.get('key') || '';
        h.items = h.items.filter((x) => `${x.bvid}|${x.cid || 0}` !== key);
      }
      if (!writeHistory(h)) return sendSaveFailed(res, '播放记录');
      return sendJson(res, 200, { items: h.items });
    }
  }

  // 预取下一首：只把 playurl 算出来放缓存，不下载音频、不阻塞响应。
  // 前端在当前歌播到 40% 时调用，切歌时省掉 view + playurl 两次往返。
  // warm=1 时连音频本体一起拉到磁盘缓存 —— 这是给 iOS 后台连播用的：
  // iPhone 锁屏后 Safari 对"全新的网络请求"很不友好，切歌如果还要等 B 站 CDN
  // 往返，很容易直接判定失败而不播。提前落盘后 /api/play 是本地直读，没有这个窗口。
  if (p === '/api/prefetch') {
    const bvid = (q.get('bvid') || '').trim();
    if (!/^BV\w+$/i.test(bvid)) return sendJson(res, 400, { error: 'bvid 格式不正确' });
    let cid = Number(q.get('cid') || '0');
    const warm = q.get('warm') === '1';
    const wait = q.get('wait') === '1';
    // wait=1：把整首拉到 NAS 本地缓存后再返回（远程/移动端播放的主路径）。
    // 目的 —— 播放器发出的第一个请求必须是本地磁盘直读，不能扛 B 站 CDN 那趟往返：
    // 经「网关 + FN Connect 中转」后，这段等待会超过 Safari 的 stall 判定窗口。
    if (warm && wait) {
      try {
        if (!cid) cid = (await fetchView(bvid)).cid;
        let size = cid ? cachedAudioSize(cid) : 0;
        if (!size && cid) {
          const cands = await getAudioCandidates(bvid, cid);
          if (cands && cands.length) {
            const task = downloadToCache(cid, cands);
            if (task && task.then) await task;
            size = cachedAudioSize(cid);
          }
        }
        // ok 必须如实：cached=false 却报 ok=true 的话，前端会把这首标记为
        // 「已预热」，30 分钟内（playurl TTL）一直走最慢路径还不自知
        return sendJson(res, 200, { ok: size > 0, cid, cached: size > 0, size });
      } catch (e) {
        return sendJson(res, 200, { ok: false, cid, cached: false, size: 0, error: e.message });
      }
    }
    (async () => {
      try {
        if (!cid) {
          const v = await fetchView(bvid);
          cid = v.cid;
        }
        if (!cid) return;
        const cands = await getAudioCandidates(bvid, cid);
        if (warm && cands && cands.length && cachedAudioSize(cid) <= 0) {
          downloadToCache(cid, cands);
          console.log(`[prefetch] warming audio body ${bvid}|${cid}`);
        } else {
          console.log(`[prefetch] warmed ${bvid}|${cid}`);
        }
      } catch (e) {
        console.warn('[prefetch] failed: ' + e.message);
      }
    })();
    return sendJson(res, 200, { ok: true, deferred: true, warm });
  }

  if (p === '/api/search') {
    const keyword = (q.get('keyword') || '').trim();
    const page = Number(q.get('page') || '1');
    const rawOrder = q.get('order') || 'totalrank';
    const order = ALLOWED_ORDERS.has(rawOrder) ? rawOrder : 'totalrank';
    if (!keyword) return sendJson(res, 400, { error: '缺少 keyword' });
    try {
      const { results, numPages, cached } = await getSearchResults(keyword, page, order);
      return sendJson(res, 200, { results, page, keyword, order, numPages, hasMore: page < numPages, cached: !!cached });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  // 首屏热门：GET /api/hot?range=week|month|total&order=click|pubdate|totalrank&refresh=1
  if (p === '/api/hot') {
    const range = q.get('range') || 'week';
    const order = q.get('order') || 'click';
    const force = q.get('refresh') === '1';
    const title = range === 'week' ? '近 7 天热门' : range === 'month' ? '近 30 天热门' : '音乐区累计排行';
    try {
      const h = await fetchHotMusic(range, order, force);
      if (!h.items || !h.items.length) {
        return sendJson(res, 502, { error: '热门榜拉取失败，稍后再试' });
      }
      return sendJson(res, 200, {
        title,
        range: h.rng,
        source: h.source,
        note: h.rng === 'total' ? 'B站长年累计榜，内容偏老' : '限定音乐区 · 按发布时间窗口筛',
        items: h.items.slice(0, HOT_LIMIT),
      });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (p === '/api/resolve') {
    const bvid = (q.get('bvid') || '').trim();
    if (!/^BV\w+$/i.test(bvid)) return sendJson(res, 400, { error: 'bvid 格式不正确' });
    try {
      const view = await fetchView(bvid);
      const playurl = await fetchPlayurl(bvid, view.cid);
      const audio = selectAudio(playurl && playurl.dash);
      if (!audio || !audio.urls || !audio.urls.length) return sendJson(res, 404, { error: '该视频暂无可播放音频（可能仅含音视频混合流）' });
      return sendJson(res, 200, {
        bvid: view.bvid,
        cid: view.cid,
        title: view.title,
        author: view.author,
        pic: view.pic,
        duration: view.duration,
        pages: view.pages,
        season: view.season,
        audioUrl: `${BASE_PATH}/api/play?bvid=${encodeURIComponent(view.bvid)}&cid=${view.cid}`,
      });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  if (p === '/api/play') {
    console.log(`[play] hit bvid=${q.get('bvid')} cid=${q.get('cid')} range=${req.headers['range'] || '<none>'}`);
    const bvid = (q.get('bvid') || '').trim();
    const cid = Number(q.get('cid') || '0');
    if (!/^BV\w+$/i.test(bvid) || !cid) return sendJson(res, 400, { error: '参数缺失' });
    // refresh=1：前端报告「拿不到音频」时主动要求作废直链缓存重取
    //（B 站 CDN 直链失效的典型表现就是重连也 403/404）
    if (q.get('refresh') === '1') playurlCache.delete(`${bvid}|${cid}`);

    // 本地有缓存：直读磁盘，不再打 B 站（二次播放基本是秒开）
    // 懒迁移（v1.3.0 改后台）：以前这里 await 重混，iOS 的播放请求最长
    // 卡 180 秒（ffmpeg 慢或挂了就一直等）。现在改为发现 DASH 就丢后台重混，
    // 本次请求把原文件照常 serve（桌面端本来就播得了）；重混完成后播放器的
    // 下一个 Range 请求自动落到 faststart 版本，iOS 下一次播放即正常。
    let size = cachedAudioSize(cid);
    if (size) {
      const cacheFile = audioCacheFile(cid);
      if (fileLooksDash(cacheFile) && !remuxRecentlyFailed(cacheFile)) {
        remuxDashToFaststart(cacheFile).catch(() => {});   // 内部有 in-flight 去重
      }
      console.log(`[play] local cache ${cid} (${(size / 1048576).toFixed(1)}MB)`);
      try {
        serveCachedAudio(req, res, cid, size, q.get('full') === '1');
        return;
      } catch (e) {
        console.warn('[play] local cache read failed: ' + e.message);
        if (res.headersSent) return;
      }
    }

    try {
      let candidates = await getAudioCandidates(bvid, cid);
      if (!candidates || !candidates.length) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('no audio');
      }
      let ok = await proxyStream(candidates, req, res, q.get('full') === '1');
      if (ok) downloadToCache(cid, candidates);   // 后台补一份本地副本，下次直接命中
      if (!ok) {
        // 缓存里的直链可能已过期/失效：作废缓存重新取一次，再试一轮
        console.log('[play] first round failed, refreshing playurl and retrying');
        playurlCache.delete(`${bvid}|${cid}`);
        candidates = await getAudioCandidates(bvid, cid);
        if (candidates && candidates.length) ok = await proxyStream(candidates, req, res, q.get('full') === '1');
      }
      if (!ok && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('all CDN candidates failed');
      }
      return;
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('proxy error: ' + e.message);
      }
      try { res.destroy(); } catch {}
      return;
    }
  }

  if (p === '/api/lyrics') {
    const bvid = (q.get('bvid') || '').trim();
    if (!/^BV\w+$/i.test(bvid)) return sendJson(res, 400, { error: 'bvid 格式不正确' });
    const title = (q.get('title') || '').trim();
    const author = (q.get('author') || '').trim();
    const refresh = q.get('refresh') === '1';
    const result = await fetchLyrics(bvid, title || null, author, refresh);
    return sendJson(res, 200, result);
  }

  // -------------------------------------------------------------------------
  // 多播放列表
  //   GET    /api/playlists            -> { active, lists:[{id,name,count}] }
  //   POST   /api/playlists {name}     -> 新建列表
  //   PUT    /api/playlists {id,name}  -> 重命名；{active:id} -> 切换当前列表
  //   DELETE /api/playlists?id=        -> 删除列表（至少保留一个）
  //   GET    /api/playlists/items?id=  -> { id, name, items:[…] }
  //   POST   /api/playlists/items {id,item}      -> 增删 toggled add（同键去重）
  //   DELETE /api/playlists/items?id=&bvid=&cid= -> 移除曲目
  // -------------------------------------------------------------------------
  if (p === '/api/playlists') {
    if (req.method === 'GET') return sendJson(res, 200, publicLists(readPlaylists()));

    if (req.method === 'POST') {
      const body = await readBody(req);
      const name = String((body && body.name) || '').trim().slice(0, 24) || `列表 ${Date.now().toString().slice(-4)}`;
      const data = readPlaylists();
      if (data.order.length >= MAX_PLAYLISTS) return sendJson(res, 400, { error: `列表太多了（上限 ${MAX_PLAYLISTS} 个）` });
      const pl = newPlaylist(name);
      data.lists[pl.id] = pl;
      data.order.push(pl.id);
      data.active = pl.id;
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, publicLists(data));
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      const data = readPlaylists();
      if (body && body.active && data.lists[body.active]) {
        data.active = body.active;
        if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
        return sendJson(res, 200, publicLists(data));
      }
      const id = body && body.id;
      if (!id || !data.lists[id]) return sendJson(res, 404, { error: '列表不存在' });
      const name = String(body.name || '').trim().slice(0, 24);
      if (!name) return sendJson(res, 400, { error: '名称不能为空' });
      data.lists[id].name = name;
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, publicLists(data));
    }

    if (req.method === 'DELETE') {
      const id = (q.get('id') || '').trim();
      const data = readPlaylists();
      if (!id || !data.lists[id]) return sendJson(res, 404, { error: '列表不存在' });
      if (data.order.length <= 1) return sendJson(res, 400, { error: '至少保留一个列表' });
      delete data.lists[id];
      data.order = data.order.filter((x) => x !== id);
      if (data.active === id) data.active = data.order[0];
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, publicLists(data));
    }
  }

  if (p === '/api/playlists/items') {
    if (req.method === 'GET') {
      const data = readPlaylists();
      const id = (q.get('id') || '').trim() || data.active;
      const list = data.lists[id];
      if (!list) return sendJson(res, 404, { error: '列表不存在' });
      return sendJson(res, 200, { id: list.id, name: list.name, items: list.items });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const data = readPlaylists();
      // 目标列表优先级：URL 参数 > body > 当前列表。
      // 之前只读 body.id，而前端把 id 放在 query 里 → 永远落到 data.active
      //（active 又总是最新建的列表），表现就是"勾哪个都收进最新收藏夹"。
      const id = (q.get('id') || '').trim() || (body && body.id) || data.active;
      const list = data.lists[id];
      if (!list) return sendJson(res, 404, { error: '列表不存在' });
      const src = (body && body.item) || body || {};
      if (!/^BV\w+$/i.test(String(src.bvid || ''))) return sendJson(res, 400, { error: 'bvid 缺失' });
      const item = normalizeItem(src);
      const key = itemKey(item);
      const at = list.items.findIndex((f) => itemKey(f) === key);
      if (at >= 0) return sendJson(res, 200, { id: list.id, name: list.name, items: list.items, duplicated: true });
      list.items.unshift(item);
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, { id: list.id, name: list.name, items: list.items });
    }

    // 曲目排序 / 置顶 / 沉底：{from,to} 或 {key:'bvid|cid', dir:'up'|'down'|'top'|'bottom'}
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const data = readPlaylists();
      const id = (q.get('id') || '').trim() || (body && body.id) || data.active;
      const list = data.lists[id];
      if (!list) return sendJson(res, 404, { error: '列表不存在' });
      let from = Number(body ? body.from : NaN);
      let to = Number(body ? body.to : NaN);
      if (body && body.key) {
        const key = String(body.key);
        from = list.items.findIndex((f) => itemKey(f) === key);
        const dir = body.dir || 'up';
        if (dir === 'top') to = 0;
        else if (dir === 'bottom') to = list.items.length - 1;
        else to = dir === 'down' ? from + 1 : from - 1;
      }
      if (!Number.isInteger(from) || from < 0 || from >= list.items.length || !Number.isInteger(to)) {
        return sendJson(res, 400, { error: '位置无效' });
      }
      to = Math.max(0, Math.min(list.items.length - 1, to));
      if (from !== to) {
        const [moved] = list.items.splice(from, 1);
        list.items.splice(to, 0, moved);
        if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      }
      return sendJson(res, 200, { id: list.id, name: list.name, items: list.items });
    }

    if (req.method === 'DELETE') {
      const data = readPlaylists();
      const id = (q.get('id') || '').trim() || data.active;
      const list = data.lists[id];
      if (!list) return sendJson(res, 404, { error: '列表不存在' });
      const key = `${(q.get('bvid') || '').trim()}|${(q.get('cid') || '').trim()}`;
      list.items = list.items.filter((f) => itemKey(f) !== key);
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, { id: list.id, name: list.name, items: list.items });
    }
  }

  // 合辑 / 合集一键全收藏：逐个去重后入列（保持原顺序追加在末尾）
  //   POST /api/playlists/items/bulk {id, items:[…]} -> { added, skipped, items }
  if (p === '/api/playlists/items/bulk') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const data = readPlaylists();
      const id = (q.get('id') || '').trim() || (body && body.id) || data.active;
      const list = data.lists[id];
      if (!list) return sendJson(res, 404, { error: '列表不存在' });
      const srcs = Array.isArray(body && body.items) ? body.items : [];
      const have = new Set(list.items.map(itemKey));
      let added = 0;
      let skipped = 0;
      for (const s of srcs) {
        if (!s || !/^BV\w+$/i.test(String(s.bvid || ''))) { skipped++; continue; }
        const item = normalizeItem(s);
        const k = itemKey(item);
        if (have.has(k)) { skipped++; continue; }
        have.add(k);
        list.items.push(item);
        added++;
      }
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      console.log(`[playlists] bulk into ${list.name}: added=${added} skipped=${skipped}`);
      return sendJson(res, 200, { id: list.id, name: list.name, items: list.items, added, skipped });
    }
  }

  // 旧版单收藏夹接口：映射到当前列表，保证老客户端不炸
  if (p === '/api/favorites') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { favorites: readFavorites() });
    }
    if (req.method === 'POST') {
      const src = await readBody(req);
      if (!/^BV\w+$/i.test(String((src && src.bvid) || ''))) return sendJson(res, 400, { error: 'bvid 缺失' });
      const data = readPlaylists();
      const list = data.lists[data.active];
      const item = normalizeItem(src);
      const key = itemKey(item);
      if (!list.items.find((f) => itemKey(f) === key)) {
        list.items.unshift(item);
        if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      }
      return sendJson(res, 200, { favorites: list.items });
    }
    if (req.method === 'DELETE') {
      const data = readPlaylists();
      const list = data.lists[data.active];
      const key = `${(q.get('bvid') || '').trim()}|${(q.get('cid') || '').trim()}`;
      list.items = list.items.filter((f) => itemKey(f) !== key);
      if (!writePlaylists(data)) return sendSaveFailed(res, '收藏夹');
      return sendJson(res, 200, { favorites: list.items });
    }
  }

  return sendJson(res, 404, { error: 'unknown api' });
}

// 请求体上限（评审 P1-11）：/api/login 免鉴权，以前一个 512MB 的 POST
// 就能把进程内存打爆。本应用最大的合法请求体（收藏条目 JSON）也就几 KB，
// 1MB 绰绰有余；超限直接 413 并掐断。
const BODY_LIMIT = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    let size = 0;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        try { req.destroy(); } catch {}
        finish({});
        return;
      }
      buf += c;
    });
    req.on('end', () => {
      if (done) return;
      const ct = String(req.headers['content-type'] || '');
      // 口令登录走的是普通表单提交（application/x-www-form-urlencoded）
      if (/application\/x-www-form-urlencoded/i.test(ct)) {
        const o = {};
        try { new URLSearchParams(buf).forEach((v, k) => { o[k] = v; }); } catch {}
        return finish(o);
      }
      try {
        finish(buf ? JSON.parse(buf) : {});
      } catch {
        finish({});
      }
    });
    req.on('error', () => finish({}));
    // 30 秒还传不完的请求体只有一种解释：有人在慢慢打 —— 丢弃
    setTimeout(() => { try { req.destroy(); } catch {} finish({}); }, 30000).unref();
  });
}

// ---------------------------------------------------------------------------
// 静态文件 + 路由分发
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  // 防目录穿越
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // 网关前缀注入：index.html / manifest.json 里的 %BASE% 换成真实前缀
    // （根路径部署时替换为空串，所以 Docker 版行为不变）
    if ((ext === '.html' || ext === '.json') && data.includes(Buffer.from('%BASE%'))) {
      data = Buffer.from(data.toString('utf8').split('%BASE%').join(BASE_PATH), 'utf8');
    }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // html/js/css 强制每次回源校验：改了前端代码，手机浏览器必须拿到新版，
    // 否则会一直跑缓存的旧 app.js（没有自动重连逻辑）
    if (['.html', '.js', '.css'].includes(ext)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// 统一网关转发过来的路径带前缀（/app/bilimusic/xxx），先剥掉再进路由，
// 这样 handleApi / serveStatic 内部逻辑完全不用感知前缀。
function stripBase(url) {
  if (!BASE_PATH) return url;
  const p = url.pathname;
  if (p === BASE_PATH) return new URL('/', url.origin);
  if (p.startsWith(BASE_PATH + '/')) return new URL(p.slice(BASE_PATH.length) + url.search, url.origin);
  return url;
}

// 脱敏：URL / Referer 里可能带口令（?k=xxx）、SESSDATA 之类，落盘前一律打码。
// 日志会被打包发给别人复盘，明文口令等于把家门钥匙贴出去。
const SECRET_QUERY_KEYS = new Set([
  'k', 'token', 'access_token', 'accesstoken', 'bm_k', 'key', 'pwd',
  'password', 'passwd', 'secret', 'sessdata', 'bili_jct', 'credential',
]);

function redactUrl(u) {
  let s = String(u || '');
  if (!s) return s;
  // 兜底：口令字符串本身出现在任何位置都要抹掉
  if (ACCESS_TOKEN && s.includes(ACCESS_TOKEN)) s = s.split(ACCESS_TOKEN).join('***');
  const i = s.indexOf('?');
  if (i < 0) return s;
  const base = s.slice(0, i);
  const qs = s.slice(i + 1).split('&').map((kv) => {
    const p = kv.indexOf('=');
    const k = (p < 0 ? kv : kv.slice(0, p)).toLowerCase();
    return SECRET_QUERY_KEYS.has(k) ? (p < 0 ? kv : kv.slice(0, p) + '=***') : kv;
  }).join('&');
  return base + '?' + qs;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 访问口令（v1.1.0 改造）
//   - 比较用 timingSafeEqual（先 sha256 成定长再比，避免长度本身泄露信息）
//   - cookie 加 HttpOnly（JS 读不到）+ 走 HTTPS 时加 Secure
//   - 不再只能靠 ?k= 传口令：401 页直接给一个表单，POST 到 /api/login
//     —— 口令因此不会留在浏览历史、Referer 或分享出去的链接里
// ---------------------------------------------------------------------------
function tokenMatch(given, expected) {
  if (!expected) return false;
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// 登录失败锁定：连续 5 次错 → 锁 10 分钟（按 clientIp 记）
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const loginFails = new Map();   // ip -> { n, until }
function loginLocked(ip) {
  const s = loginFails.get(ip);
  if (!s) return false;
  if (s.until) {
    if (Date.now() < s.until) return true;
    loginFails.delete(ip);      // 锁定期满，重新计数
    return false;
  }
  return false;
}
function loginFail(ip) {
  const s = loginFails.get(ip) || { n: 0, until: 0 };
  s.n++;
  if (s.n >= LOGIN_MAX_FAILS) { s.until = Date.now() + LOGIN_LOCK_MS; s.n = 0; console.warn(`[auth] ${ip} 连续口令错误，锁定 10 分钟`); }
  loginFails.set(ip, s);
}

// 反代终止 TLS 时，node 这边看到的是 http，只能靠 X-Forwarded-Proto 判断
function requestIsHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return !!req.socket.encrypted || proto === 'https';
}

function cookieAttrs(req) {
  const secure = requestIsHttps(req) ? '; Secure' : '';
  return `bm_k=${encodeURIComponent(ACCESS_TOKEN)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`;
}

function denyPage(req, res) {
  const action = `${BASE_PATH || ''}/api/login`;
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('<!doctype html><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>需要访问口令</title>'
    + '<div style="font-family:system-ui,-apple-system;padding:2rem;line-height:1.8;color:#222;max-width:22rem;margin:0 auto">'
    + '<h3 style="margin:0 0 .4rem">需要访问口令</h3>'
    + '<p style="color:#666;margin:0 0 1rem;font-size:14px">输入口令即可进入，浏览器会记住一年。</p>'
    + `<form method="post" action="${action}" style="display:flex;gap:8px">`
    + '<input name="k" type="password" autocomplete="current-password" autofocus required '
    + 'style="flex:1;min-width:0;padding:.7rem .8rem;border:1px solid #ccc;border-radius:8px;font-size:16px">'
    + '<button type="submit" style="padding:.7rem 1.1rem;border:0;border-radius:8px;background:#222;color:#fff;font-size:16px">进入</button>'
    + '</form></div>');
}

// 服务端访问日志（v1.0.3）：网关转发模式下排查「App 内能开页面但 API 全空」
// 这类问题必须看到网关转发来的真实请求：路径形态 / UA / 有无凭据头。
// 记录：时间 方法 原始路径 状态码 UA Referer 凭据线索。4MB 轮转，读数走 /api/log。
const ACCESS_LOG_DIR = LOG_DIR;
const ACCESS_LOG_MAX = 4 * 1024 * 1024;

function accessLog(req, res, rawUrl) {
  try {
    const h = req.headers || {};
    const cred = {
      cookie: h.cookie ? h.cookie.length : 0,
      auth: h.authorization ? h.authorization.slice(0, 24) : undefined,
      xAccessSource: h['x-access-source'],
      xDeviceId: h['x-device-id'],
      xTrimToken: h['x-trim-token'],
    };
    const line = JSON.stringify({
      t: new Date().toISOString(),
      m: req.method,
      u: redactUrl(rawUrl).slice(0, 200),
      s: res.statusCode,
      // 音频请求这条最关键：回放是否命中本地缓存、range 处理策略
      ac: res.getHeader ? (res.getHeader('x-audio-cache') || undefined) : undefined,
      rp: res.getHeader ? (res.getHeader('x-range-policy') || undefined) : undefined,
      rg: String(h.range || '').slice(0, 40) || undefined,
      cl: res.getHeader ? (res.getHeader('content-length') || undefined) : undefined,
      ua: String(h['user-agent'] || '').slice(0, 120),
      ref: redactUrl(h.referer).slice(0, 160),
      ...cred,
    });
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const file = path.join(ACCESS_LOG_DIR, `req-${day}.log`);
    let rotate = false;
    try { if (fs.statSync(file).size > ACCESS_LOG_MAX) rotate = true; } catch {}
    if (rotate) { try { fs.renameSync(file, file.replace(/\.log$/, '.1.log')); } catch {} }
    fs.appendFile(file, line + '\n', () => {});
  } catch {}
}

const server = http.createServer(async (req, res) => {
  const url = stripBase(parseUrl(req));
  res.on('finish', () => accessLog(req, res, req.url));
  try {
    // 口令登录：表单 POST。口令不进 URL，也就不会留在浏览历史 / Referer / 日志里。
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!rateAllow(clientIp(req), 'write')) {
        res.setHeader('Retry-After', '10');
        return sendJson(res, 429, { error: '试得太快了，歇 10 秒' });
      }
      // 登录失败锁定（评审 P1-10）：单口令体系里口令就是全部家当，
      // 连续错 5 次锁 10 分钟，让在线爆破变得不现实。
      const ip = clientIp(req);
      if (loginLocked(ip)) {
        res.setHeader('Retry-After', '600');
        return sendJson(res, 429, { error: '错误次数太多，锁定 10 分钟' });
      }
      const body = await readBody(req);
      if (tokenMatch(body.k, ACCESS_TOKEN)) {
        loginFails.delete(ip);
        res.writeHead(303, { 'Set-Cookie': cookieAttrs(req), Location: `${BASE_PATH || ''}/` });
        return res.end();
      }
      loginFail(ip);
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('口令不对');
    }

    // 访问口令：health 与 login 放行（探活 / 登录用），其余一律要口令或已下发的 cookie
    if (ACCESS_TOKEN && url.pathname !== '/api/health' && url.pathname !== '/api/login') {
      const ck = parseCookieHeader(req.headers.cookie);
      const qk = url.searchParams.get('k');
      if (qk && tokenMatch(qk, ACCESS_TOKEN)) {
        // 兼容旧书签里的 ?k= 链接：命中后同样下发 cookie，之后 URL 里的口令就不必再带着了
        res.setHeader('Set-Cookie', cookieAttrs(req));
      } else if (!tokenMatch(ck.bm_k, ACCESS_TOKEN)) {
        denyPage(req, res);
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    console.error('[server] unhandled:', e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else try { res.destroy(); } catch {}
  }
});

// 进程级兜底：媒体代理场景边界情况多（客户端中途断开、上游流锁定等），
// 异步拒绝绝不能崩进程——崩一次 = 所有正在听歌的人全部断流。
process.on('unhandledRejection', (e) => {
  console.warn('[proc] unhandledRejection (swallowed):', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[proc] uncaughtException (kept alive):', (e && e.message) || e);
});

// 启动清理：上次运行中断留下的半成品 .part 清掉，顺带跑一遍 LRU
try {
  ensureAudioCacheDir();
  fs.mkdirSync(LOG_DIR, { recursive: true }); // 访问日志目录，第一条请求就要写
  for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
    if (f.endsWith('.part') || f.endsWith('.remux')) {
      // 别的实例正在下载的半成品不能删（否则它白下一遍，用户侧表现为缓存迟迟不生效）
      if (heldByOtherInstance(f)) continue;
      try { fs.unlinkSync(path.join(AUDIO_CACHE_DIR, f)); } catch {}
    }
  }
  sweepAudioCache();
  // 存量迁移：把历史下载的 DASH fMP4 全部重混成 faststart（后台串行，不阻塞启动）
  (async () => {
    try {
      const files = fs.readdirSync(AUDIO_CACHE_DIR).filter((f) => f.endsWith('.m4a'));
      let n = 0;
      for (const f of files) {
        try { if (await remuxDashToFaststart(path.join(AUDIO_CACHE_DIR, f))) n++; } catch {}
        await new Promise((r) => setTimeout(r, 200)); // 给 J1800 留口气
      }
      if (n) console.log(`[cache] startup remux done: ${n}/${files.length} files converted`);
    } catch (e) { console.warn('[cache] startup remux failed:', e.message); }
  })();
} catch (e) {
  console.warn('[cache] startup cleanup failed:', e.message);
}

// 定期维护（评审共识 #7）：LRU 原本只在「有新下载」和「启动时」才跑，
// 一台常年开机的 NAS 上，缓存会一路涨到配额上限然后永远停在那儿占着盘；
// 而半成品文件只有在下次启动时才清理 —— 崩一次留下几十 MB 垃圾，得等到
// 重启才收得走。现在每 6 小时做三件事：
//   ① 跑一遍 LRU（按 mtime 淘汰最久没听的）
//   ② 清掉超过 1 小时没动静的 .part/.remux（别的实例正在用的跳过）
//   ③ 修剪内存里的重混失败标记（Map 只增不减，长跑进程会一直涨）
const MAINT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_TEMP_MS = 60 * 60 * 1000;

function sweepStaleTempFiles() {
  let n = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(AUDIO_CACHE_DIR)) {
      if (!/\.(part|remux|tmp)$/.test(f)) continue;
      if (heldByOtherInstance(f)) continue;
      const p = path.join(AUDIO_CACHE_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs < STALE_TEMP_MS) continue;   // 还在写，别动
        fs.unlinkSync(p);
        n++;
      } catch {}
    }
  } catch (e) { console.warn('[maint] stale temp cleanup failed:', e.message); }
  return n;
}

const maintTimer = setInterval(() => {
  try {
    const stale = sweepStaleTempFiles();
    const swept = sweepAudioCache();
    let pruned = 0;
    for (const [k, t] of remuxFailAt) {
      if (Date.now() - t > REMUX_FAIL_TTL) { remuxFailAt.delete(k); pruned++; }
    }
    if (stale || swept.removed || pruned) {
      console.log(`[maint] temp=${stale} swept=${swept.removed} negPruned=${pruned} -> ${swept.files} files / ${(swept.bytes / 1048576).toFixed(0)}MB`);
    }
  } catch (e) { console.warn('[maint] failed:', e.message); }
}, MAINT_INTERVAL_MS);
if (maintTimer.unref) maintTimer.unref();   // 不阻止进程退出

// 鉴权 fail-closed（评审 P1-9）：独立端口模式（TCP 监听，会暴露到公网/局域网）
// 若没设 ACCESS_TOKEN，整站就是无门状态 —— 以前只是控制台提一句，环境变量
// 一丢（改 compose 忘了抄、systemd 单元被覆盖）鉴权就静默消失。
// 现在：网关模式（SOCKET_PATH，由飞牛登录态保护）不受此限；直跑 TCP 必须
// 显式设 ALLOW_NO_TOKEN=1 才允许无口令启动。
if (!SOCKET_PATH && !ACCESS_TOKEN && process.env.ALLOW_NO_TOKEN !== '1') {
  console.error('[boot] 拒绝启动：独立端口模式必须设置 ACCESS_TOKEN（访问口令）。');
  console.error('       如果确实是纯内网临时调试，设 ALLOW_NO_TOKEN=1 可跳过此检查。');
  process.exit(1);
}

if (SOCKET_PATH) {
  // 网关转发模式：监听 Unix Socket。残留的旧 socket 会让 listen 直接 EADDRINUSE，
  // 先清掉；chmod 666 是为了让网关进程（非本应用用户）也能连上来。
  try { fs.rmSync(SOCKET_PATH, { force: true }); } catch {}
  server.listen(SOCKET_PATH, () => {
    try { fs.chmodSync(SOCKET_PATH, 0o666); } catch {}
    console.log(`[bili-music-web] listening on socket ${SOCKET_PATH} (base: ${BASE_PATH || '/'} , data dir: ${DATA_DIR})`);
  });
} else {
  server.listen(PORT, () => {
    console.log(`[bili-music-web] listening on :${PORT} (data dir: ${DATA_DIR}${ACCESS_TOKEN ? ', token: on' : ', token: OFF(允许无口令模式)'})`);
  });
}
