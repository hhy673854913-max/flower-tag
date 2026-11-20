// 临时仿真：验证 onboarding.js 四类公告调度规则（非小程序环境，mock wx/getApp/页面栈）。
const storage = {};
const pages = [];
let appGlobal = { envId: 'env-test', accessStatus: undefined, accessStatusTime: 0 };

global.wx = {
  getStorageSync: k => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  switchTab: () => {}
};
global.getApp = () => ({ globalData: appGlobal });
global.getCurrentPages = () => pages.slice();

const onboarding = require('../miniprogram/utils/onboarding');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name); }
}

// mock 页面与组件
function makePage(route) {
  const page = {
    route,
    component: null,
    selectComponent() { return this.component; }
  };
  const component = {
    opened: null,
    open(view, ready) { this.opened = view; if (ready) ready(); },
    close() { this.opened = null; },
    triggerEvent() {}
  };
  page.component = component;
  pages.push(page);
  return page;
}

const NOTICES = {
  newUser: { title: '欢迎', body: ['新用户'] },
  pending: { title: '开通', body: ['校验码1125'] },
  everyEntry: { title: '全员每次', body: ['a'] },
  firstEntry: { title: '全员首次', body: ['b'] }
};
function status(over = {}) {
  return Object.assign({
    ok: true, activated: false, isAdmin: false, role: 'other', name: '',
    cleanupPending: false, canUpload: false, canShare: false,
    uploadScope: 'a'.repeat(64), onboardingEligible: true
  }, over);
}
// 普通进入（scene 1001）
function launchOrdinary() { onboarding.appLaunch({ scene: 1001, path: 'pages/index/index', query: {} }); }
// 分享进入（scene 1007）
function launchShared() { onboarding.appLaunch({ scene: 1007, path: 'pages/portfolio-share/portfolio-share', query: {} }); }
function show(page, st) { onboarding.present(page, st, onboarding.capture(page)); }

// 场景1：新用户首次进入 → 新用户公告；点「先看看」后下次进入 → 待开通公告
launchOrdinary();
let p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: { newUser: NOTICES.newUser, pending: NOTICES.pending } }));
check('场景1 首次弹新用户公告', p.component.opened && p.component.opened.title === '欢迎');
onboarding.choose(p.component, 'browse');
p.component.close();
check('场景1 browse 后关闭', p.component.opened === null);
check('场景1 已写入 welcome:v1 标记', storage['welcome:v1:env-test:' + 'a'.repeat(64)] === true);
// 同一进入内再次 present 不重复弹
show(p, status({ notices: { newUser: NOTICES.newUser, pending: NOTICES.pending } }));
check('场景1 同进入不重复弹', p.component.opened === null);
// 第二次进入（切后台再回前台新指纹）
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: { newUser: NOTICES.newUser, pending: NOTICES.pending } }));
check('场景1 第二次进入弹待开通公告', p.component.opened && p.component.opened.title === '开通');
onboarding.choose(p.component, 'browse');
// 第三次进入仍弹待开通（每次进入都弹）
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: { newUser: NOTICES.newUser, pending: NOTICES.pending } }));
check('场景1 第三次进入仍弹待开通', p.component.opened && p.component.opened.title === '开通');

// 场景2：新用户公告未配置 → 第一次进入即弹待开通
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: { pending: NOTICES.pending } }));
check('场景2 无新用户公告时首进入弹待开通', p.component.opened && p.component.opened.title === '开通');

// 场景3：管理员每次进入弹全员每次公告
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
const adminStatus = status({ activated: true, isAdmin: true, role: 'admin', canUpload: true, canShare: true, onboardingEligible: false });
show(p, Object.assign({ notices: { pending: NOTICES.pending, everyEntry: NOTICES.everyEntry } }, adminStatus));
check('场景3 管理员弹全员每次公告', p.component.opened && p.component.opened.title === '全员每次');
check('场景3 全员公告只有一个按钮', p.component.opened && p.component.opened.primaryAction === 'dismiss');
onboarding.choose(p.component, 'browse');

// 场景4：分享入口 → 不弹新用户/待开通，弹全员每次
launchShared();
pages.length = 0;
p = makePage('pages/portfolio-share/portfolio-share');
onboarding.pageShow(p);
show(p, status({ notices: NOTICES }));
check('场景4 分享入口跳过新用户/待开通弹全员每次', p.component.opened && p.component.opened.title === '全员每次');
onboarding.choose(p.component, 'browse');
show(p, status({ notices: { everyEntry: NOTICES.everyEntry } }));
check('场景4 同进入内不重复弹', p.component.opened === null);
onboarding.appHide();
launchShared();
pages.length = 0;
p = makePage('pages/portfolio-share/portfolio-share');
onboarding.pageShow(p);
show(p, status({ notices: { everyEntry: NOTICES.everyEntry } }));
check('场景4 新一次分享进入再弹全员每次', p.component.opened && p.component.opened.title === '全员每次');

// 场景5：全员首次公告只弹一次（含分享入口）
onboarding.appHide();
launchShared();
pages.length = 0;
p = makePage('pages/portfolio-share/portfolio-share');
onboarding.pageShow(p);
show(p, status({ notices: { firstEntry: NOTICES.firstEntry } }));
check('场景5 首次弹全员首次公告', p.component.opened && p.component.opened.title === '全员首次');
onboarding.choose(p.component, 'browse');
onboarding.appHide();
launchShared();
pages.length = 0;
p = makePage('pages/portfolio-share/portfolio-share');
onboarding.pageShow(p);
show(p, status({ notices: { firstEntry: NOTICES.firstEntry } }));
check('场景5 第二次不再弹全员首次', p.component.opened === null);

// 场景6：全部公告未配置 → 不弹
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: {} }));
check('场景6 无配置不弹', p.component.opened === null);
show(p, status({}));
check('场景6 notices 缺失不弹', p.component.opened === null);

// 场景7：非 Tab 页面普通冷启动 + 全员每次 → 用 maybePresent 前 present 即可弹（currentGlobal）
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/about/about');
onboarding.pageShow(p);
show(p, status({ notices: { everyEntry: NOTICES.everyEntry } }));
check('场景7 非Tab页面弹全员公告', p.component.opened && p.component.opened.title === '全员每次');

// 场景8：待开通「去开通」在 Tab 页触发跳转意图，my 页可领取
onboarding.appHide();
launchOrdinary();
pages.length = 0;
const filterPage = makePage('pages/filter/filter');
onboarding.pageShow(filterPage);
show(filterPage, status({ notices: { pending: NOTICES.pending } }));
check('场景8 待开通公告带去开通按钮', filterPage.component.opened && filterPage.component.opened.primaryAction === 'activate');
onboarding.choose(filterPage.component, 'activate');
const myPage = makePage('pages/my/my');
pages.length = 0;
pages.push(myPage);
onboarding.pageShow(myPage);
check('场景8 my 页可领取激活意图', onboarding.takeActivation(myPage) === true);

// 场景9：已开通花艺师不弹待开通，弹全员每次
onboarding.appHide();
launchOrdinary();
pages.length = 0;
p = makePage('pages/index/index');
onboarding.pageShow(p);
show(p, status({ notices: { pending: NOTICES.pending, everyEntry: NOTICES.everyEntry },
  activated: true, role: 'florist', canUpload: true, canShare: true, onboardingEligible: false }));
check('场景9 花艺师跳过待开通', p.component.opened && p.component.opened.title === '全员每次');

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
