/**
 * 清枢智汇（TierFlow）多账号管理面板
 * 零依赖 Node 服务：登录各账号 → 聚合推广数据 / 余额 / API Key → 前端展示
 * （纯本地运行，零依赖）
 * 启动: node server.js  访问: http://localhost:8899
 *
 * Skybaby 制作
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ACCOUNTS_FILE = path.join(ROOT, 'accounts.json');
const SESS_FILE = path.join(ROOT, 'sessions.json');
const KEYS_FILE = path.join(ROOT, 'keys.json');
let CONFIG;
try {
  CONFIG = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
} catch {
  // 首次运行：生成空白配置（之后可在面板上添加账号）
  CONFIG = { port: 8899, settings: { quotaPerUnit: 500000, dailyLimit: 5, refreshIntervalMs: 300000 }, accounts: [] };
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ port: CONFIG.port, settings: CONFIG.settings, accounts: [] }, null, 2), 'utf8'); } catch { /* 忽略 */ }
}
const PORT = CONFIG.port || 8899;
const HOST = 'tierflow.cn';
const BASE = 'https://' + HOST;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TF_VERSION = 'v5.5.6';

let quotaPerUnit = (CONFIG.settings && CONFIG.settings.quotaPerUnit) || 500000;
let dailyLimit = (CONFIG.settings && CONFIG.settings.dailyLimit) || 5;

// ---------- 账号配置持久化 ----------
function saveAccounts() {
  const out = { settings: CONFIG.settings, port: CONFIG.port, accounts: CONFIG.accounts };
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(out, null, 2), 'utf8');
}

// ---------- key 存储（面板本地，用户可编辑；与平台打码值分开） ----------
let keyStore = {};
try { keyStore = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { /* 首次运行 */ }
function saveKeys() {
  try { fs.writeFileSync(KEYS_FILE, JSON.stringify(keyStore, null, 1), 'utf8'); } catch { /* 忽略 */ }
}

// ---------- session 持久化（30 天有效，避免频繁登录触发风控） ----------
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch { /* 首次运行 */ }
function saveSessions() {
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(sessions, null, 2)); } catch { /* 忽略 */ }
}

// ---------- HTTP 请求封装 ----------
function request(method, apiPath, opts = {}) {
  const { cookie, uid, body } = opts;
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Content-Type': 'application/json',
      'X-Tf-Version': TF_VERSION,
      'Origin': BASE,
      'Referer': BASE + '/',
    };
    if (cookie) headers['Cookie'] = cookie;
    if (uid) headers['TF-User'] = uid;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: HOST, port: 443, path: apiPath, method, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let session = null;
        for (const c of res.headers['set-cookie'] || []) {
          const m = c.match(/^session=([^;]+)/);
          if (m) session = m[1];
        }
        let json = null;
        try { json = JSON.parse(buf); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, session, json, raw: buf });
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- 登录 ----------
async function login(acc) {
  const r = await request('POST', '/api/user/login', { body: { identifier: acc.phone, password: acc.password } });
  if (!r.json || !r.json.success) throw new Error((r.json && r.json.message) || '登录失败 HTTP ' + r.status);
  if (!r.session) throw new Error('登录未返回 session');
  const s = { cookie: 'session=' + r.session, uid: r.json.data.uid, username: r.json.data.username, at: Date.now() };
  sessions[acc.phone] = s;
  saveSessions();
  return s;
}

async function apiGet(acc, apiPath) {
  let s = sessions[acc.phone];
  if (!s || !s.cookie) s = await login(acc);
  let r = await request('GET', apiPath, { cookie: s.cookie, uid: s.uid });
  const unauthorized = r.status === 401 || (r.json && r.json.message && /Unauthorized|未登录/i.test(r.json.message));
  if (unauthorized) {
    s = await login(acc);
    r = await request('GET', apiPath, { cookie: s.cookie, uid: s.uid });
  }
  return r;
}

// 带会话的写请求（POST/PUT/DELETE），401 时自动重登一次
async function apiSend(acc, method, apiPath, body) {
  let s = sessions[acc.phone];
  if (!s || !s.cookie) s = await login(acc);
  let r = await request(method, apiPath, { cookie: s.cookie, uid: s.uid, body });
  const unauthorized = r.status === 401 || (r.json && r.json.message && /Unauthorized|未登录/i.test(r.json.message));
  if (unauthorized) {
    s = await login(acc);
    r = await request(method, apiPath, { cookie: s.cookie, uid: s.uid, body });
  }
  return r;
}

// ---------- 单账号数据 ----------
function yuan(quota) { return Math.round(((quota || 0) / quotaPerUnit) * 100) / 100; }

async function fetchAccount(acc) {
  const [selfR, refR, tokR] = await Promise.all([
    apiGet(acc, '/api/user/self'),
    apiGet(acc, '/api/user/referral'),
    apiGet(acc, '/api/token/?p=1&size=100').catch(() => null),
  ]);
  if (!selfR.json || !selfR.json.success) throw new Error((selfR.json && selfR.json.message) || '账户信息获取失败');
  if (!refR.json || !refR.json.success) throw new Error((refR.json && refR.json.message) || '推广信息获取失败');
  const self = selfR.json.data;
  const ref = refR.json.data;
  const lim = ref.referral_limits || {};

  // 按量 API Key（/api/token/，key 字段平台已打码，无法还原明文）
  const tokens = ((tokR && tokR.json && tokR.json.success && tokR.json.data && tokR.json.data.items) || []).map((t) => ({
    tokenNo: t.token_no,
    name: t.name || '',
    maskedKey: t.key || '',
    status: t.status,
    isSubscriptionKey: !!t.is_subscription_key,
    unlimitedQuota: !!t.unlimited_quota,
    remainYuan: yuan(t.remain_quota),
    usedYuan: yuan(t.used_quota),
    expiredTime: t.expired_time || -1,
    createdTime: t.created_time || 0,
  }));

  // 套餐 API Key（每个订阅一把，同样只有打码值）
  let subKey = null;
  try {
    const subR = await apiGet(acc, '/api/subscription/self');
    const all = (subR.json && subR.json.data && subR.json.data.all_subscriptions) || [];
    const active = all.find((x) => x.has_key) || all[0];
    if (active && active.subscription && active.subscription.sub_no) {
      const sn = active.subscription.sub_no;
      const kR = await apiGet(acc, '/api/subscription/self/token?sub_no=' + encodeURIComponent(sn));
      if (kR.json && kR.json.success && kR.json.data) {
        subKey = {
          subNo: sn,
          planTitle: active.subscription.plan_title || '',
          name: kR.json.data.name || '',
          maskedKey: kR.json.data.key || '',
          status: kR.json.data.status,
          expiredTime: kR.json.data.expired_time || 0,
        };
      }
    }
  } catch { /* 无套餐时忽略 */ }

  return {
    phone: acc.phone,
    label: acc.label || acc.phone,
    username: self.username,
    uid: self.uid,
    balanceYuan: yuan(self.quota),
    giftYuan: yuan(self.gift_quota),
    usedYuan: yuan(self.used_quota),
    giftExpiringYuan: yuan(self.gift_expiring_quota),
    giftExpiringAt: self.gift_expiring_at || 0,
    referralCode: ref.referral_code || '',
    referralLink: ref.referral_code ? BASE + '/register?referral_code=' + encodeURIComponent(ref.referral_code) : '',
    // 平台官方口径：今日计奖邀请数 / 今日未计奖邀请数（超出每日限额的部分）
    todayRewarded: ref.today_paid_count || 0,
    todayFailed: ref.today_failed_count || 0,
    totalInvites: ref.referral_registration_count || 0,
    totalFailed: ref.referral_failed_count || 0,
    totalRewardYuan: yuan(ref.referral_reward_total_quota),
    perInviteRewardYuan: yuan(ref.referrer_reward_quota),
    windowUsed: lim.window_used || 0,
    windowLimit: lim.window_limit || dailyLimit,
    rewardAvailable: lim.reward_available !== false,
    // 面板本地保存的完整 key（群聊/创建时捕获，用户可编辑）
    keys: (() => {
      const ks = keyStore[acc.phone] || {};
      const out = {};
      for (const kind of ['metered', 'subscription']) {
        if (ks[kind] && ks[kind].key) {
          out[kind] = { key: ks[kind].key, savedAt: ks[kind].savedAt || 0, source: ks[kind].source || '' };
        }
      }
      return out;
    })(),
    tokens,
    subKey,
    error: null,
  };
}

// ---------- 单账号数据（轻量：仅推广字段，每账号 1 个上游请求） ----------
async function fetchAccountLight(acc) {
  const refR = await apiGet(acc, '/api/user/referral');
  if (!refR.json || !refR.json.success) throw new Error((refR.json && refR.json.message) || '推广信息获取失败');
  const ref = refR.json.data;
  const lim = ref.referral_limits || {};
  return {
    phone: acc.phone,
    label: acc.label || acc.phone,
    referralCode: ref.referral_code || '',
    referralLink: ref.referral_code ? BASE + '/register?referral_code=' + encodeURIComponent(ref.referral_code) : '',
    todayRewarded: ref.today_paid_count || 0,
    todayFailed: ref.today_failed_count || 0,
    totalInvites: ref.referral_registration_count || 0,
    totalFailed: ref.referral_failed_count || 0,
    windowUsed: lim.window_used || 0,
    windowLimit: lim.window_limit || dailyLimit,
    rewardAvailable: lim.reward_available !== false,
    error: null,
  };
}

// ---------- 轻量聚合（15 秒缓存；/api/light 专用，与全量口分开） ----------
let lightCache = { at: 0, data: null };

async function collectLight() {
  if (lightCache.data && Date.now() - lightCache.at < CACHE_MS) return lightCache.data;
  const settled = await Promise.allSettled(CONFIG.accounts.map((acc) => fetchAccountLight(acc)));
  const accounts = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return { phone: CONFIG.accounts[i].phone, label: CONFIG.accounts[i].label || CONFIG.accounts[i].phone, error: String((s.reason && s.reason.message) || s.reason) };
  });
  const ok = accounts.filter((a) => !a.error);
  const summary = {
    accountCount: accounts.length,
    okCount: ok.length,
    todayRewarded: ok.reduce((s, a) => s + a.todayRewarded, 0),
    todayFailed: ok.reduce((s, a) => s + a.todayFailed, 0),
    totalInvites: ok.reduce((s, a) => s + a.totalInvites, 0),
    dailyLimit,
  };
  const data = { updatedAt: Date.now(), summary, accounts };
  lightCache = { at: Date.now(), data };
  return data;
}

// ---------- 聚合（15 秒缓存） ----------
const CACHE_MS = 15000;
let cache = { at: 0, data: null };

function round2(n) { return Math.round(n * 100) / 100; }

async function collectAll(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const settled = await Promise.allSettled(CONFIG.accounts.map((acc) => fetchAccount(acc)));
  const accounts = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return { phone: CONFIG.accounts[i].phone, label: CONFIG.accounts[i].label || CONFIG.accounts[i].phone, error: String((s.reason && s.reason.message) || s.reason) };
  });
  const ok = accounts.filter((a) => !a.error);
  const summary = {
    accountCount: accounts.length,
    okCount: ok.length,
    totalBalanceYuan: round2(ok.reduce((s, a) => s + a.balanceYuan, 0)),
    todayRewarded: ok.reduce((s, a) => s + a.todayRewarded, 0),
    todayFailed: ok.reduce((s, a) => s + a.todayFailed, 0),
    totalInvites: ok.reduce((s, a) => s + a.totalInvites, 0),
    totalRewardYuan: round2(ok.reduce((s, a) => s + a.totalRewardYuan, 0)),
    dailyLimit,
  };
  const data = { updatedAt: Date.now(), refreshIntervalMs: (CONFIG.settings && CONFIG.settings.refreshIntervalMs) || 60000, summary, accounts };
  cache = { at: Date.now(), data };
  return data;
}

// ---------- 账号管理 ----------
function normPhone(v) { return String(v == null ? '' : v).replace(/\s|-/g, ''); }

async function addAccount({ phone, password, label }) {
  const p = normPhone(phone);
  const pw = String(password == null ? '' : password);
  if (!/^1\d{10}$/.test(p)) throw new Error('手机号格式不正确（需 11 位、1 开头）');
  if (!pw) throw new Error('密码不能为空');
  if (CONFIG.accounts.some((a) => a.phone === p)) throw new Error('该手机号已在列表中');
  // 先真实登录验证，通过才落盘（防止加进无效账号）
  const probe = { phone: p, password: pw };
  const r = await request('POST', '/api/user/login', { body: { identifier: p, password: pw } });
  if (!r.json || !r.json.success) throw new Error('登录校验失败：' + ((r.json && r.json.message) || ('HTTP ' + r.status)));
  if (!r.session) throw new Error('登录校验失败：未返回 session');
  sessions[p] = { cookie: 'session=' + r.session, uid: r.json.data.uid, username: r.json.data.username, at: Date.now() };
  saveSessions();
  CONFIG.accounts.push({ phone: p, password: pw, label: String(label || '').trim() || ('账号 ' + (CONFIG.accounts.length + 1)) });
  saveAccounts();
  cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
  return { phone: p, username: r.json.data.username };
}

function removeAccount(phone) {
  const p = normPhone(phone);
  const i = CONFIG.accounts.findIndex((a) => a.phone === p);
  if (i < 0) throw new Error('未找到该账号');
  CONFIG.accounts.splice(i, 1);
  saveAccounts();
  if (sessions[p]) { delete sessions[p]; saveSessions(); }
  cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
  return { phone: p };
}

// 重命名账号标签
function renameAccount(phone, label) {
  const p = normPhone(phone);
  const acc = CONFIG.accounts.find((a) => a.phone === p);
  if (!acc) throw new Error('未找到该账号');
  const lb = String(label == null ? '' : label).trim();
  if (!lb) throw new Error('名称不能为空');
  if (lb.length > 30) throw new Error('名称过长（最多 30 字）');
  acc.label = lb;
  saveAccounts();
  cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
  return { phone: p, label: lb };
}

// 手动保存/编辑 key（kind: metered | subscription）
function saveKey(phone, kind, key) {
  const p = normPhone(phone);
  if (!CONFIG.accounts.some((a) => a.phone === p)) throw new Error('未找到该账号');
  if (!['metered', 'subscription'].includes(kind)) throw new Error('kind 必须是 metered 或 subscription');
  keyStore[p] = keyStore[p] || {};
  const v = String(key == null ? '' : key).trim();
  if (!v) {
    delete keyStore[p][kind];
    if (!Object.keys(keyStore[p]).length) delete keyStore[p];
  } else {
    if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(v)) throw new Error('key 格式不对（应以 sk- 开头，长度 ≥ 23）');
    keyStore[p][kind] = { key: v, savedAt: Date.now(), source: '手动编辑' };
  }
  saveKeys();
  cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
  return { phone: p, kind, saved: !!v };
}

// 从平台创建新 key（metered=新建按量 token；subscription=签发/重置套餐 key）
// 注意：两者都会返回完整明文，这是"只显示一次"的窗口，创建后立刻落盘
async function createKey(phone, kind) {
  const p = normPhone(phone);
  const acc = CONFIG.accounts.find((a) => a.phone === p);
  if (!acc) throw new Error('未找到该账号');
  if (kind === 'metered') {
    const r = await apiSend(acc, 'POST', '/api/token/', {
      name: p.slice(-3),
      remain_quota: 0,
      unlimited_quota: true,
      expired_time: -1,
      model_limits_enabled: false,
      model_limits: '',
      allow_ips: '',
      group: '',
    });
    if (!r.json || !r.json.success) throw new Error('创建按量 key 失败：' + ((r.json && r.json.message) || ('HTTP ' + r.status)));
    const key = (r.json.data && r.json.data.key) || '';
    if (!/^sk-/.test(key)) throw new Error('返回的 key 形态不对');
    keyStore[p] = keyStore[p] || {};
    keyStore[p].metered = { key, savedAt: Date.now(), source: '面板创建' };
    saveKeys();
    cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
    return { phone: p, kind, key };
  }
  if (kind === 'subscription') {
    // 找有效订阅
    const subR = await apiGet(acc, '/api/subscription/self');
    const all = (subR.json && subR.json.data && subR.json.data.all_subscriptions) || [];
    const active = all.find((x) => x.subscription) || all[0];
    if (!active) throw new Error('该账号没有订阅套餐，无法签发套餐 key');
    const sn = active.subscription.sub_no;
    const r = await apiSend(acc, 'POST', '/api/subscription/self/token/rotate', { sub_no: sn });
    if (!r.json || !r.json.success) throw new Error('签发套餐 key 失败：' + ((r.json && r.json.message) || ('HTTP ' + r.status)));
    const key = (r.json.data && r.json.data.key) || '';
    if (!/^sk-/.test(key)) throw new Error('返回的 key 形态不对');
    keyStore[p] = keyStore[p] || {};
    keyStore[p].subscription = { key, savedAt: Date.now(), source: '面板签发', subNo: sn, planTitle: active.subscription.plan_title || '' };
    saveKeys();
    cache = { at: 0, data: null };
  lightCache = { at: 0, data: null };
    return { phone: p, kind, key, subNo: sn };
  }
  throw new Error('kind 必须是 metered 或 subscription');
}

// ---------- HTTP 服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ---------- 访问控制 ----------
// 默认免密，方便本机/局域网使用（面板默认场景）。
// 如需给局域网其他设备或公网访问加密码：在面板上点「设置」，或直接改
// accounts.json 的 settings.requireAuth / authUser / authPass。
// 规则：本机访问永远免密；开启密码后，其他设备需 Basic 认证（错 3 次封 IP）。
// 设置改动即时生效，无需重启。
const BIND_HOST = '0.0.0.0'; // 监听所有网卡（局域网/手机可直接访问）

function authConfig() {
  const s = (CONFIG.settings = CONFIG.settings || {});
  return {
    require: !!s.requireAuth,
    user: String(s.authUser || 'admin'),
    pass: String(s.authPass || ''),
  };
}

const GUARD_PATH = path.join(ROOT, 'data', 'auth_guard.json');
const GUARD_LOG = path.join(path.dirname(GUARD_PATH), 'auth_guard.log');
const BAN_SCHEDULE = [3600, 6 * 3600, 24 * 3600]; // 1h / 6h / 24h
const FAIL_THRESHOLD = 3;
const FAIL_WINDOW = 24 * 3600;

function guardLoad() {
  try {
    const d = JSON.parse(fs.readFileSync(GUARD_PATH, 'utf8'));
    if (d && typeof d === 'object' && d.ips && typeof d.ips === 'object') return d;
  } catch { /* 首次运行 / 文件损坏 */ }
  return { v: 1, ips: {} };
}
function guardSave(d) {
  try {
    fs.mkdirSync(path.dirname(GUARD_PATH), { recursive: true });
    fs.writeFileSync(GUARD_PATH, JSON.stringify(d), 'utf8');
  } catch { /* 忽略 */ }
}
function guardLog(text) {
  try {
    const ts = new Date().toLocaleString('sv-SE').replace('T', ' ');
    fs.appendFileSync(GUARD_LOG, `${ts} [tierflow] ${text}\n`, 'utf8');
  } catch { /* 忽略 */ }
}
// 取客户端真实 IP（兼容反向代理场景）
function clientIp(req) {
  const c = (req.headers['cf-connecting-ip'] || '').trim();
  if (c) return c;
  const x = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (x) return x;
  const s = (req.socket && req.socket.remoteAddress) || '';
  return s.replace(/^::ffff:/, '');
}
function guardBanned(ip) {
  if (!ip) return 0;
  const d = guardLoad();
  const e = d.ips[ip];
  if (!e || typeof e !== 'object') return 0;
  return Math.max(0, (e.until || 0) - Math.floor(Date.now() / 1000));
}
function guardFail(ip) {
  if (!ip) return 0;
  const now = Math.floor(Date.now() / 1000);
  const d = guardLoad();
  const ips = d.ips;
  let e = ips[ip];
  if (!e || typeof e !== 'object') e = { fails: 0, last: 0, until: 0, level: 0 };
  if ((now - (e.last || 0)) > FAIL_WINDOW && !((e.until || 0) > now)) e.fails = 0;
  e.fails = (e.fails || 0) + 1;
  e.last = now;
  let triggered = 0;
  if (e.fails >= FAIL_THRESHOLD) {
    const lvl = Math.min(e.level || 0, BAN_SCHEDULE.length - 1);
    triggered = BAN_SCHEDULE[lvl];
    e.until = now + triggered;
    e.level = (e.level || 0) + 1;
    e.fails = 0;
    guardLog(`BAN ip=${ip} dur=${triggered}s level=${e.level}`);
  } else if (e.fails >= 2) {
    guardLog(`FAIL ip=${ip} count=${e.fails}`);
  }
  ips[ip] = e;
  guardSave(d);
  return triggered;
}
function guardSuccess(ip) {
  if (!ip) return;
  const d = guardLoad();
  if (d.ips[ip]) { delete d.ips[ip]; guardSave(d); }
}

function isLocalRequest(req) {
  // 带反向代理头（frp / 内网穿透 / 隧道）→ 说明请求从外部绕进来，不算本机
  if (req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip']) return false;
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function checkAuth(req) {
  const cfg = authConfig();
  if (!cfg.require || !cfg.pass) return true; // 未开启密码 / 密码为空：免密
  if (isLocalRequest(req)) return true;       // 本机请求免密
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return decoded.slice(0, i) === cfg.user && decoded.slice(i + 1) === cfg.pass;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    // 访问控制（/health 放行）：
    // - 未设置密码（settings.authPass 为空）→ 全程免密，适合本机/局域网使用
    // - 设置了密码 → 本机免密，其余请求需 Basic 认证；带防爆破（错 3 次封 IP）
    if (p !== '/health' && !checkAuth(req)) {
      const ip = clientIp(req);
      const rem = guardBanned(ip);
      if (rem > 0) {
        res.writeHead(403, { 'Retry-After': String(rem), 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('尝试次数过多，已临时封禁 / Too many attempts');
      }
      if (req.headers['authorization']) guardFail(ip); // 带凭证但错误才计失败
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TierFlow Panel"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Auth required');
    }

    if (p === '/health') {
      return sendJson(res, 200, { status: 'ok', accounts: CONFIG.accounts.length, cached: !!cache.data });
    }

    // 面板数据
    if (p === '/api/data' || p === '/api/refresh') {
      const data = await collectAll(p === '/api/refresh');
      return sendJson(res, 200, data);
    }

    // 轻量数据（仅推广字段，每账号 1 个上游请求）
    if (p === '/api/light') {
      const data = await collectLight();
      return sendJson(res, 200, data);
    }

    // 读取当前设置（不回密码，只回是否已设置）
    if (p === '/api/settings' && req.method === 'GET') {
      const cfg = authConfig();
      return sendJson(res, 200, {
        success: true,
        requireAuth: cfg.require,
        authUser: cfg.user,
        hasPassword: !!cfg.pass,
        port: CONFIG.port,
        refreshIntervalMs: (CONFIG.settings && CONFIG.settings.refreshIntervalMs) || 300000,
      });
    }

    // 保存设置（开启/关闭访问密码、改账号密码）
    if (p === '/api/settings' && req.method === 'POST') {
      try {
        // 安全：未开密码时，只允许本机改设置（防止同网络的人远程改/开密码把你锁外面）
        if (!isLocalRequest(req) && !authConfig().require) {
          return sendJson(res, 403, { success: false, error: '修改设置请在本机操作（或在已开启访问密码后再改）' });
        }
        const body = await readBody(req);
        const s = (CONFIG.settings = CONFIG.settings || {});
        if (typeof body.requireAuth === 'boolean') s.requireAuth = body.requireAuth;
        if (typeof body.authUser === 'string') s.authUser = body.authUser.trim().slice(0, 40);
        if (typeof body.authPass === 'string' && body.authPass !== '') s.authPass = body.authPass.slice(0, 80);
        // 开启密码但从未设过密码 → 拒绝，避免把自己锁在门外
        if (s.requireAuth && !s.authPass) throw new Error('请先设置密码，再开启访问密码');
        if (typeof body.clearPassword === 'boolean' && body.clearPassword) { s.authPass = ''; s.requireAuth = false; }
        saveAccounts();
        return sendJson(res, 200, { success: true, requireAuth: !!s.requireAuth, authUser: s.authUser || 'admin', hasPassword: !!s.authPass });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 账号列表（只回手机号/标签，绝不回密码）
    if (p === '/api/accounts' && req.method === 'GET') {
      return sendJson(res, 200, {
        accounts: CONFIG.accounts.map((a) => ({ phone: a.phone, label: a.label || a.phone })),
      });
    }

    // 新增账号
    if (p === '/api/accounts' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const r = await addAccount(body);
        return sendJson(res, 200, { success: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 重命名账号  PUT /api/accounts/<phone>/label
    if (p.startsWith('/api/accounts/') && p.endsWith('/label') && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const ph = decodeURIComponent(p.slice('/api/accounts/'.length, -'/label'.length));
        const r = renameAccount(ph, body.label);
        return sendJson(res, 200, { success: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 手动保存/编辑 key  PUT /api/accounts/<phone>/keys/<kind>
    if (p.startsWith('/api/accounts/') && p.includes('/keys/') && req.method === 'PUT') {
      try {
        const body = await readBody(req);
        const rest = p.slice('/api/accounts/'.length);
        const idx = rest.lastIndexOf('/keys/');
        const ph = decodeURIComponent(rest.slice(0, idx));
        const kind = decodeURIComponent(rest.slice(idx + '/keys/'.length));
        const r = saveKey(ph, kind, body.key);
        return sendJson(res, 200, { success: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 从平台创建/签发 key  POST /api/accounts/<phone>/keys/<kind>/create
    if (p.startsWith('/api/accounts/') && p.endsWith('/create') && req.method === 'POST') {
      try {
        const rest = p.slice('/api/accounts/'.length);
        const idx = rest.lastIndexOf('/keys/');
        if (idx < 0) throw new Error('路径不对');
        const ph = decodeURIComponent(rest.slice(0, idx));
        const kind = decodeURIComponent(rest.slice(idx + '/keys/'.length, -'/create'.length));
        const r = await createKey(ph, kind);
        return sendJson(res, 200, { success: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 删除账号  /api/accounts/<phone>
    if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
      try {
        const r = removeAccount(decodeURIComponent(p.slice('/api/accounts/'.length)));
        return sendJson(res, 200, { success: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { success: false, error: String((e && e.message) || e) });
      }
    }

    // 静态文件白名单（仅前端资源，绝不暴露 accounts.json / sessions.json / server.js）
    let file = p === '/' ? '/index.html' : p;
    if (!/^\/(index\.html|app\.js|style\.css|favicon\.ico)$/.test(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const full = path.join(ROOT, 'public', file);
    if (!fs.existsSync(full)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(full));
  } catch (e) {
    return sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

// 启动时预拉一次 quota_per_unit（用于金额换算兜底）
(async () => {
  try {
    const st = await request('GET', '/api/status');
    if (st.json && st.json.success && st.json.data && st.json.data.quota_per_unit) {
      quotaPerUnit = Number(st.json.data.quota_per_unit) || quotaPerUnit;
    }
  } catch { /* 用配置文件默认值 */ }
  server.listen(PORT, BIND_HOST, () => {
    const cfg = authConfig();
    console.log('[TierFlow 面板] 服务已启动');
    console.log('  本机访问:   http://localhost:' + PORT);
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log('  局域网访问: http://' + ni.address + ':' + PORT);
      }
    }
    console.log('  访问密码:   ' + (cfg.require && cfg.pass ? '已开启（本机免密）' : '未开启（谁打开地址都能看）'));
    console.log('  账号数:     ' + CONFIG.accounts.length);
    console.log('  额度换算:   1 元 = ' + quotaPerUnit + ' quota');
  });
})();
