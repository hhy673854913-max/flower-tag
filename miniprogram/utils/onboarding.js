const TAB_PATHS = ['pages/index/index', 'pages/filter/filter', 'pages/my/my', 'pages/upload/upload'];
const MY_PATH = 'pages/my/my';
// Official scene list: chat cards, App cards, chat history and Moments snapshots.
// https://developers.weixin.qq.com/miniprogram/dev/reference/scene-list.html
const SHARE_SCENES = [1007, 1008, 1036, 1044, 1096, 1154];
const ORDINARY_SCENES = [1001, 1005, 1006, 1023, 1024, 1027, 1042, 1053, 1089, 1090, 1103, 1104, 1106];
let epoch = 0;
let request = 0;
let foreground = false;
let source = null;
let consumed = false;
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

function present(page, status, ticket) {
  if (!current(ticket)) return false;
  if (!eligible(status) || !sameIdentity(status)) {
    closeHolder();
    activation = null;
    if (!status || status.ok !== true) consumed = true;
    return false;
  }
  if (consumed || holder || !ticket.env) return false;
  const key = 'welcome:v1:' + encodeURIComponent(ticket.env) + ':' + status.uploadScope;
  consumed = true;
  try {
    if (wx.getStorageSync(key) === true) return false;
  } catch (error) {
    return false;
  }
  let component;
  try { component = page.selectComponent('#welcome-guide'); } catch (error) { return false; }
  if (!component || typeof component.open !== 'function') return false;
  const claim = { page, component, ticket, key, status: Object.assign({}, status), ready: false, chosen: false };
  holder = claim;
  try {
    component.open(() => {
      if (holder === claim && current(ticket) && sameIdentity(claim.status)) claim.ready = true;
      else if (holder === claim) closeHolder();
    });
  } catch (error) {
    closeHolder();
    return false;
  }
  return true;
}

function choose(component, action) {
  const claim = holder;
  if (!claim || claim.component !== component || !claim.ready || claim.chosen ||
      !current(claim.ticket) || (action !== 'activate' && action !== 'browse')) return false;
  if (!sameIdentity(claim.status)) {
    closeHolder();
    activation = null;
    return false;
  }
  claim.chosen = true;
  closeHolder();
  try { wx.setStorageSync(claim.key, true); } catch (error) { /* Session stays consumed. */ }
  // Storage or component callbacks may synchronously hide/change the entry.
  if (!current(claim.ticket) || !sameIdentity(claim.status)) return true;
  if (action === 'activate') {
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

module.exports = { appLaunch, appShow, appHide, pageShow, pageHide, capture, present, choose, cancel, takeActivation };
