'use strict';
/* 真模拟器 E2E：连接开发者工具自动化端口，云端接口在应用内打桩（不触碰真实数据）。
 * 运行：node scripts/e2e/run.js */
const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const automator = require('miniprogram-automator');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(ROOT, '.screenshots', 'e2e');
const WS = 'ws://127.0.0.1:9420';
const IMG_PORT = 9421;
const IMG_BASE = 'http://127.0.0.1:' + IMG_PORT + '/img';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
function startImageServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_1PX.length });
      res.end(PNG_1PX);
    });
    server.listen(IMG_PORT, '127.0.0.1', () => resolve(server));
  });
}

let passed = 0, failed = 0;
const failures = [];
const exceptions = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed += 1;
    failures.push([name, e]);
    console.log('  \u2717 ' + name + ' :: ' + (e && e.message));
  }
}
const sleep = ms => new Promise(r => { setTimeout(r, ms); });

async function openPage(mp, url, settleMs) {
  const page = await mp.reLaunch(url);
  await sleep(settleMs || 1200);
  return page;
}
/* 身份切换后首屏按真实应用的预期要求手动重试；模拟用户点击重试动线 */
async function openIndexSettled(mp, settleMs) {
  const page = await openPage(mp, '/pages/index/index', settleMs || 1500);
  const first = await page.data();
  if (first.error) {
    await page.callMethod('retryLoad');
    await sleep(1200);
  }
  return page;
}
async function shot(mp, name) {
  try { await mp.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); }
  catch (e) { console.log('  (截图失败: ' + name + ' :: ' + e.message + ')'); }
}

/* 在应用环境内打桩：wx.cloud.callFunction 全量接管，previewImage 记录调用 */
const MOCK_FN = function (mode, base) {
  const e2e = { mode: mode, calls: [], previews: [] };
  wx.__e2e = e2e;
  function thumbUrl(id) { return base + '/thumb/' + encodeURIComponent(id) + '.png'; }
  function origUrl(id) { return base + '/orig/' + encodeURIComponent(id) + '.png'; }
  function status(active) {
    return {
      ok: true, activated: active, isAdmin: false, role: active ? 'florist' : 'other',
      name: 'E2E', cleanupPending: false, canUpload: active, canShare: active,
      uploadScope: 'e2e0000000000000000000000000000000000000000000000000000000000ab',
      filePrefix: 'userFiles/e2e/',
      notices: { newUser: null, pending: null, everyEntry: null, firstEntry: null },
      onboardingEligible: false
    };
  }
  function rec(i, withExtra) {
    return {
      _id: 'r' + i, _openid: 'openid-E2E', createdAt: 1700000000000 - i,
      fileID: 'cloud://e2e/works/f' + i, thumbFileID: 'cloud://e2e/thumbs/t' + i,
      colors: ['红'], colorScheme: '红色系', category: '花束', style: '清新',
      occasion: ['日常花礼'], flowersMain: ['玫瑰'], flowersSub: [], flowersLeaf: [],
      deleting: false, isPublic: false, shareToken: '',
      extraFiles: withExtra
        ? [{ fileID: 'cloud://e2e/works/f' + i + 'x', thumbFileID: 'cloud://e2e/thumbs/t' + i + 'x' }]
        : []
    };
  }
  const SEED = [];
  for (let i = 0; i < 65; i++) { SEED.push(rec(i, i === 0)); }
  function respond(data) {
    const action = data && data.action;
    const active = e2e.mode === 'empty' || e2e.mode === 'seeded';
    const seeded = e2e.mode === 'seeded';
    if (action === 'status') { return status(active); }
    if (action === 'getRecordPage') {
      const skip = data.skip || 0;
      const limit = data.limit || 20;
      if (!seeded) {
        return { ok: true, status: status(active), records: [], urls: {}, hasMore: false, nextSkip: skip };
      }
      const recs = SEED.slice(skip, skip + limit);
      const urls = {};
      recs.forEach(function (r) { urls[r.thumbFileID] = thumbUrl(r.thumbFileID); });
      return {
        ok: true, status: status(true), records: recs, urls: urls,
        hasMore: skip + recs.length < SEED.length, nextSkip: skip + recs.length,
        expiresAt: Date.now() + 3600000
      };
    }
    if (action === 'getOwnFileUrls') {
      const map = {};
      (data.fileIDs || []).forEach(function (id) {
        map[id] = id.indexOf('/thumbs/') >= 0 ? thumbUrl(id) : origUrl(id);
      });
      return { ok: true, urls: map, expiresAt: Date.now() + 3600000 };
    }
    if (action === 'countRecords') { return { ok: true, total: seeded ? SEED.length : 0 }; }
    if (action === 'listRecords') {
      const s = data.skip || 0;
      return { ok: true, records: seeded ? SEED.slice(s, s + (data.limit || 100)) : [] };
    }
    if (action === 'listTags') { return { ok: true, records: [] }; }
    if (action === 'getRecord') {
      const target = SEED.filter(function (r) { return r._id === data.id; })[0];
      if (!target) { return { ok: false, error: '无权操作该作品' }; }
      return { ok: true, record: JSON.parse(JSON.stringify(target)) };
    }
    return { ok: false, error: 'E2E 未覆盖动作: ' + action };
  }
  wx.cloud.callFunction = function (params) {
    e2e.calls.push(params.data && params.data.action);
    return Promise.resolve({ result: respond(params.data) });
  };
  wx.previewImage = function (o) { e2e.previews.push(o); return Promise.resolve({}); };
};

async function setMode(mp, mode) {
  await mp.evaluate(MOCK_FN, mode, IMG_BASE);
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await startImageServer();
  console.log('连接自动化端口 ' + WS + ' …');
  let mp = null;
  for (let i = 0; i < 30 && !mp; i++) {
    try { mp = await automator.connect({ wsEndpoint: WS }); }
    catch (e) { await sleep(2000); }
  }
  if (!mp) { throw new Error('无法连接自动化端口（请确认 cli auto 已启动）'); }
  mp.on('exception', exc => { exceptions.push(exc && exc.message || String(exc)); });
  console.log('已连接。系统信息: ' + JSON.stringify(await mp.systemInfo()).slice(0, 120));

  console.log('\n[场景] 未开通用户');
  await test('S1 未开通：身份切换保护后重试，空状态出现「去开通空间」引导', async () => {
    await setMode(mp, 'unactivated');
    const page = await openIndexSettled(mp);
    const d = await page.data();
    assert(!d.error, '重试后不应再有错误: ' + d.error);
    const el = await page.$('.empty-action');
    assert(el, '空状态引导按钮应存在');
    assert(d.allowed === false, '未开通时 allowed 应为 false');
    const target = await el.attribute('url');
    assert(target === '/pages/my/my', '按钮应跳「我的」，实际: ' + target);
    await shot(mp, 's1-index-unactivated');
  });
  await test('S2 未开通：上传页为锁定态并有「前往我的空间」入口', async () => {
    const page = await openPage(mp, '/pages/upload/upload', 1500);
    const state = (await page.data()).accessState;
    assert(state === 'locked', 'accessState 实际: ' + state);
    const el = await page.$('.open-action');
    const text = el ? await el.text() : '';
    assert(text === '前往我的空间', '实际入口文案: ' + text);
    await shot(mp, 's2-upload-locked');
  });

  console.log('\n[场景] 已开通用户');
  await test('S3 已开通无作品：重试后出现「去上传作品」引导', async () => {
    await setMode(mp, 'empty');
    const page = await openIndexSettled(mp);
    const d = await page.data();
    assert(!d.error, '重试后不应再有错误: ' + d.error);
    const el = await page.$('.empty-action');
    assert(el, '空状态引导按钮应存在');
    assert(d.allowed === true, '已开通时 allowed 应为 true');
    const target = await el.attribute('url');
    assert(target === '/pages/upload/upload', '按钮应跳「上传」，实际: ' + target);
    await shot(mp, 's3-index-empty');
  });

  await test('S4 已开通有作品：作品墙渲染 20 条且缩略图有链', async () => {
    await setMode(mp, 'seeded');
    const page = await openIndexSettled(mp, 2000);
    const data = await page.data();
    assert(data.list.length === 20, '首页应加载 20 条，实际 ' + data.list.length);
    assert(data.list.every(r => r.url), '每条都应有缩略图 URL');
    assert(data.noMore === false, '还有更多（65 条）不应标记 noMore');
    await shot(mp, 's4-index-seeded');
  });

  await test('S5 详情页：点图为缩略图预览，「查看原图」拉原图', async () => {
    const page = await openPage(mp, '/pages/detail/detail?id=r0', 1800);
    await shot(mp, 's5-detail');
    const hero = await page.$('.hero');
    assert(hero, '详情主图应渲染');
    await hero.tap();
    await sleep(600);
    let previews = (await mp.evaluate(() => wx.__e2e.previews)) || [];
    assert(previews.length === 1, '点图应触发一次预览，实际 ' + previews.length);
    assert(previews[0].urls.every(u => u.indexOf('/thumb/') >= 0), '点图预览应只用缩略图');
    assert((previews[0].urls.length === 2), '主图+附加图共 2 张');
    const btns = await page.$$('.orig-btn');
    let viewOriginal = null;
    for (const b of btns) {
      if ((await b.text()) === '查看原图') { viewOriginal = b; break; }
    }
    assert(viewOriginal, '「查看原图」按钮应存在');
    await viewOriginal.tap();
    await sleep(1000);
    previews = (await mp.evaluate(() => wx.__e2e.previews)) || [];
    assert(previews.length === 2, '查看原图应再触发一次预览');
    assert(previews[1].urls.every(u => u.indexOf('/orig/') >= 0), '查看原图应使用原图 URL');
  });

  await test('S6 筛选页：结果分批展示，触底自动加载到全部', async () => {
    const page = await openPage(mp, '/pages/filter/filter', 2500);
    let data = await page.data();
    assert(data.matchedCount === 65, '命中应 65 条，实际 ' + data.matchedCount);
    assert(data.results.length === 60, '首批应 60 条，实际 ' + data.results.length);
    assert(data.hasMoreResults === true, '应还有更多结果');
    await shot(mp, 's6-filter');
    await page.callMethod('onReachBottom');
    await sleep(600);
    data = await page.data();
    assert(data.results.length === 65, '触底后应为 65 条，实际 ' + data.results.length);
    assert(data.hasMoreResults === false, '全部展示后不应再有更多');
  });

  await test('S7 我的：统计与设置正常渲染', async () => {
    const page = await openPage(mp, '/pages/my/my', 1800);
    const data = await page.data();
    assert(data.activated === true, '应为已开通态');
    assert(data.total === 65, '统计总数应 65，实际 ' + data.total);
    const stat = await page.$('.stat-num');
    const text = stat ? await stat.text() : '';
    assert(text === '65', '统计数字实际: ' + text);
    await shot(mp, 's7-my');
  });

  console.log('\n[运行时异常] ' + (exceptions.length ? JSON.stringify(exceptions) : '无'));
  console.log('\n[E2E 结果] 通过 ' + passed + ' / 失败 ' + failed);
  if (exceptions.length) { failed += exceptions.length; }
  if (failures.length) {
    failures.forEach(item => {
      console.log('\n失败: ' + item[0] + '\n  ' + (item[1] && item[1].message));
    });
  }
  console.log('\n截图目录: ' + SHOT_DIR);
  console.log('（IDE 保持打开，可继续人工检查）');
  process.exit(failed ? 1 : 0);
}

module.exports = { MOCK_FN, openPage, shot, sleep, WS };
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
