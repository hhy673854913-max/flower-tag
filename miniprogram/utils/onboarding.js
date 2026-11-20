const api = require('./api');
const TAB_PATHS = ['pages/index/index', 'pages/filter/filter', 'pages/my/my', 'pages/upload/upload'];
const MY_PATH = 'pages/my/my';
// Official scene list: chat cards, App cards, chat history and Moments snapshots.
// https://developers.weixin.qq.com/miniprogram/dev/reference/scene-list.html
const SHARE_SCENES = [1007, 1008, 1036, 1044, 1096, 1154];
const ORDINARY_SCENES = [1001, 1005, 1006, 1023, 1024, 1027, 1042, 1053, 1089, 1090, 1103, 1104, 1106];
// 30 秒内复用已取到的账号状态，避免每个页面重复请求云函数。
const STATUS_FRESH_TTL = 30 * 1000;
let epoch = 0;
let request = 0;
let foreground = false;
let source = null;
let consumed = false;
let presented = Object.create(null);
let visiblePage = null;
let holder = null;
let activation = null;

function pathOf(path) {
  return typeof path === 'string' ? path.replace(/^\/+/, '').split('?')[0] : '';
}

function entryOf(options) {
  const value = options || {};
  const path = pathOf(value.path);
  const query = value.query && typeof value.query === 'object' ? value.query : {};
  const has = key => Object.prototype.hasOwnProperty.call(query, key);
  const shared = has('shareToken') || has('portfolioToken') ||
    path === 'pages/portfolio-share/portfolio-share' ||
    path === 'pages/creator-card/creator-card' ||
    SHARE_SCENES.indexOf(value.scene) !== -1 || !!value.shareTicket ||
    [1, 2, 3, 4].indexOf(value.chatType) !== -1 || value.apiCategory === 'browseOnly';
  return {
    shared,
    ordinary: !shared && ORDINARY_SCENES.indexOf(value.scene) !== -1,
    fingerprint: JSON.stringify([value.scene || 0, path,
      Object.keys(query).sort().map(key => [key, query[key]]), value.shareTicket || ''])
  };
}

function closeHolder() {
  const old = holder;
  holder = null;
  if (old) {
    try { old.component.close(); } catch (error) { /* Detached component. */ }
  }
}

function newEntry(entry) {
  epoch += 1;
  request += 1;
  closeHolder();
  activation = null;
  visiblePage = null;
  consumed = false;
  presented = Object.create(null);
  source = entry;
}

function appLaunch(options) {
  newEntry(entryOf(options));
  foreground = true;
}

function appShow(options) {
  const next = entryOf(options);
  // Android can retain the old scene on resume. Identical parameters are not
  // proof of a new ordinary entry, and unknown scenes never undo share exclusion.
  const changed = !source || (next.fingerprint !== source.fingerprint && (next.shared || next.ordinary));
  if (changed) {
    newEntry(next);
  }
  foreground = true;
  return changed;
}

function appHide() {
  foreground = false;
  epoch += 1;
  request += 1;
  activation = null;
  visiblePage = null;
  closeHolder();
}

function pageShow(page) {
  if (visiblePage !== page) {
    closeHolder();
    request += 1;
  }
  visiblePage = page;
}

function pageHide(page) {
  if (visiblePage === page) {
    visiblePage = null;
    request += 1;
  }
  if (holder && holder.page === page) closeHolder();
}

function envId() {
  try { return getApp().globalData.envId || ''; } catch (error) { return ''; }
}

function capture(page) {
  closeHolder();
  return { epoch, request: ++request, page, env: envId() };
}

function current(ticket) {
  if (!ticket || !foreground || ticket.epoch !== epoch || ticket.request !== request ||
      ticket.page !== visiblePage || ticket.env !== envId() || !source || source.shared) return false;
  const pages = getCurrentPages();
  return pages.length > 0 && pages[pages.length - 1] === ticket.page &&
    TAB_PATHS.indexOf(pathOf(ticket.page.route)) !== -1;
}

// 全员公告（每次/首次）面向所有入口（含分享链接）与所有页面，不限制 Tab 页。
function currentGlobal(ticket) {
  if (!ticket || !foreground || ticket.epoch !== epoch || ticket.request !== request ||
      ticket.page !== visiblePage || ticket.env !== envId() || !source) return false;
  const pages = getCurrentPages();
  return pages.length > 0 && pages[pages.length - 1] === ticket.page;
}

function eligible(status) {
  return status && status.ok === true && status.onboardingEligible === true &&
    status.activated !== true && status.isAdmin !== true && status.role !== 'admin' &&
    status.cleanupPending !== true && typeof status.uploadScope === 'string' &&
    /^[a-f0-9]{64}$/i.test(status.uploadScope);
}

function sameIdentity(status) {
  const latest = getApp().globalData.accessStatus;
  return latest === undefined || (!!latest && latest.ok === true && latest.uploadScope === status.uploadScope &&
    latest.role === status.role && latest.activated === status.activated &&
    latest.isAdmin === status.isAdmin && latest.cleanupPending === status.cleanupPending &&
    latest.onboardingEligible === true);
}

// 公告栏的“已展示”标记按 环境 + 账号 隔离存储，键与前版欢迎弹窗保持一致。
function storageKey(prefix, status) {
  return prefix + ':' + encodeURIComponent(envId()) + ':' +
    (status && typeof status.uploadScope === 'string' ? status.uploadScope : '');
}

function seen(key) {
  try { return wx.getStorageSync(key) === true; } catch (error) { return true; }
}

// 优先级：新用户欢迎 > 待开通提醒 > 全员每次 > 全员首次；每次进入只弹一类。
function pickNotice(status) {
  const notices = status && status.notices;
  if (!notices) return null;
  const shared = !source || source.shared;
  if (!shared) {
    if (notices.newUser && eligible(status) && !seen(storageKey('welcome:v1', status))) {
      return { kind: 'newUser', config: notices.newUser };
    }
    // 未成为花艺师或管理员：新用户公告未占位的每次普通进入都提醒。
    if (notices.pending && status.activated !== true && status.isAdmin !== true
      && status.role !== 'florist' && status.role !== 'admin') {
      return { kind: 'pending', config: notices.pending };
    }
  }
  if (notices.everyEntry) return { kind: 'everyEntry', config: notices.everyEntry };
  if (notices.firstEntry && !seen(storageKey('notice:first:v1', status))) {
    return { kind: 'firstEntry', config: notices.firstEntry };
  }
  return null;
}

function noticeButtons(kind) {
  if (kind === 'newUser') {
    return { primaryText: '去开通', secondaryText: '先看看', primaryAction: 'activate' };
  }
  if (kind === 'pending') {
    return { primaryText: '去开通', secondaryText: '我知道了', primaryAction: 'activate' };
  }
  return { primaryText: '我知道了', secondaryText: '', primaryAction: 'dismiss' };
}

function present(page, status, ticket) {
  if (!currentGlobal(ticket)) return false;
  if (!status || status.ok !== true) {
    closeHolder();
    activation = null;
    consumed = true;
    return false;
  }
  if (holder || consumed) return false;
  const choice = pickNotice(status);
  if (!choice) {
    consumed = true;
    return false;
  }
  if (presented[choice.kind]) return false;
  if ((choice.kind === 'newUser' || choice.kind === 'pending') && !current(ticket)) return false;
  if (choice.kind === 'newUser' && !sameIdentity(status)) {
    closeHolder();
    activation = null;
    return false;
  }
  const seenKey = choice.kind === 'newUser' ? storageKey('welcome:v1', status)
    : choice.kind === 'firstEntry' ? storageKey('notice:first:v1', status) : '';
  if (seenKey && seen(seenKey)) {
    presented[choice.kind] = true;
    return false;
  }
  let component;
  try { component = page.selectComponent('#welcome-guide'); } catch (error) { return false; }
  if (!component || typeof component.open !== 'function') return false;
  presented[choice.kind] = true;
  consumed = true;
  const claim = { page, component, ticket, key: seenKey, status: Object.assign({}, status),
    kind: choice.kind, primaryAction: noticeButtons(choice.kind).primaryAction,
    ready: false, chosen: false };
  holder = claim;
  const view = Object.assign({}, choice.config, noticeButtons(choice.kind));
  try {
    component.open(view, () => {
      if (holder === claim && currentGlobal(ticket) && sameIdentity(claim.status)) claim.ready = true;
      else if (holder === claim) closeHolder();
    });
  } catch (error) {
    closeHolder();
    return false;
  }
  return true;
}

// 未主动取账号状态的页面（分享落地页、关于、反馈等）由全局 Page 包装器调用；
// 复用 30 秒内已取到的状态，否则取一次再按规则弹公告。
function maybePresent(page) {
  if (holder || !foreground) return;
  const data = getApp().globalData;
  const cached = data.accessStatus;
  if (cached && cached.ok === true && data.accessStatusTime
    && Date.now() - Number(data.accessStatusTime) < STATUS_FRESH_TTL) {
    return present(page, cached, capture(page));
  }
  const ticket = capture(page);
  api.getAccessStatus().then(status => {
    present(page, status, ticket);
  }).catch(() => { /* 状态不可用时跳过本轮公告。 */ });
}

function choose(component, action) {
  const claim = holder;
  if (!claim || claim.component !== component || !claim.ready || claim.chosen ||
      (action !== 'activate' && action !== 'browse') || !currentGlobal(claim.ticket)) return false;
  if ((claim.kind === 'newUser' || claim.kind === 'pending') && !current(claim.ticket)) return false;
  if (claim.kind === 'newUser' && !sameIdentity(claim.status)) {
    closeHolder();
    activation = null;
    return false;
  }
  claim.chosen = true;
  closeHolder();
  if (claim.key) {
    try { wx.setStorageSync(claim.key, true); } catch (error) { /* Session stays consumed. */ }
  }
  // Storage or component callbacks may synchronously hide/change the entry.
  if (!currentGlobal(claim.ticket)) return true;
  if (action === 'activate' && claim.primaryAction === 'activate') {
    const intent = { epoch, env: claim.ticket.env };
    activation = intent;
    if (pathOf(claim.page.route) === MY_PATH) {
      component.triggerEvent('activate');
    } else {
      try {
        wx.switchTab({
          url: '/' + MY_PATH,
          fail: () => { if (activation === intent) activation = null; }
        });
      } catch (error) {
        activation = null;
      }
    }
  }
  return true;
}

function cancel(component) {
  if (holder && holder.component === component) closeHolder();
}

function takeActivation(page) {
  if (!activation || !foreground || !source || source.shared ||
      activation.epoch !== epoch || activation.env !== envId() ||
      page !== visiblePage || pathOf(page.route) !== MY_PATH) return false;
  activation = null;
  return true;
}

module.exports = { appLaunch, appShow, appHide, pageShow, pageHide, capture, present, maybePresent, choose, cancel, takeActivation };
