'use strict';
/* 客户端回归：getTempUrls 提示透传与缓存、页面图片事件定向 setData、compressThumb。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stubs = require('./stubs.js');
const MP = stubs.MP;

let passed = 0, failed = 0;
const failures = [];
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

async function main() {
  console.log('\n[3] api.getTempUrls');
  await test('C1 携带 recordIDs 提示调用 getOwnFileUrls', async function () {
    const fx = stubs.installClientGlobals();
    const api = stubs.loadApi();
    const fileIDs = ['cloud://env/userFiles/x/works/1.jpg', 'cloud://env/userFiles/x/works/2.jpg'];
    const map = await api.getTempUrls(fileIDs, { recordIDs: ['r1', 'r2'] });
    assert.ok(map[fileIDs[0]] && map[fileIDs[1]], '应取得 URL');
    const call = fx.calls.find(c => c.data.action === 'getOwnFileUrls');
    assert.ok(call, '应发起换链请求');
    assert.deepStrictEqual(call.data.recordIDs, ['r1', 'r2']);
  });

  await test('C2 超过 50 条 recordIDs 时不携带提示且分批请求', async function () {
    const fx = stubs.installClientGlobals();
    const api = stubs.loadApi();
    const fileIDs = [];
    const recordIDs = [];
    let i;
    for (i = 0; i < 60; i++) {
      fileIDs.push('cloud://env/userFiles/x/works/' + i + '.jpg');
      recordIDs.push('r' + i);
    }
    await api.getTempUrls(fileIDs, { recordIDs: recordIDs });
    const urlCalls = fx.calls.filter(c => c.data.action === 'getOwnFileUrls');
    assert.strictEqual(urlCalls.length, 2, '60 条应分 2 批');
    urlCalls.forEach(c => assert.strictEqual(c.data.recordIDs, undefined, '超过 50 条不应下发提示'));
  });

  await test('C3 非法 recordIDs 项被过滤；URL 缓存命中不再调用云函数', async function () {
    const fx = stubs.installClientGlobals();
    const api = stubs.loadApi();
    const fileIDs = ['cloud://env/userFiles/x/works/a.jpg'];
    await api.getTempUrls(fileIDs, { recordIDs: ['', null, 42, 'ok-id'] });
    assert.strictEqual(fx.calls.length, 1);
    assert.deepStrictEqual(fx.calls[0].data.recordIDs, ['ok-id']);
    await api.getTempUrls(fileIDs, { recordIDs: ['ok-id'] });
    assert.strictEqual(fx.calls.length, 1, '缓存命中不得再调用');
  });

  console.log('\n[4] 页面图片事件定向 setData');
  await test('P1 index.imageState 仅更新命中项，不整表 setData', async function () {
    stubs.installClientGlobals();
    const config = stubs.loadIndexPage();
    const rows = [];
    let i;
    for (i = 0; i < 200; i++) {
      rows.push({ _id: 'r' + i, fileID: 'f' + i, url: 'u' + i, imageLoading: true, imageFailed: false });
    }
    const inst = stubs.makePageInstance(config, { list: rows });
    inst._visible = true;
    inst.imageState({ currentTarget: { dataset: { id: 'r150', url: 'u150' } } }, true);
    const payload = inst.__payloads[inst.__payloads.length - 1];
    assert.strictEqual(payload['list[150].imageLoading'], false);
    assert.strictEqual(payload['list[150].imageFailed'], true);
    assert.strictEqual(payload.list, undefined, '不得整表更新 list');
    inst.imageState({ currentTarget: { dataset: { id: 'missing', url: 'x' } } }, true);
    assert.strictEqual(inst.__payloads.length, 1, '未命中不得触发 setData');
  });

  await test('P2 index.refreshImages 端到端：携带 recordIDs', async function () {
    const fx = stubs.installClientGlobals();
    const config = stubs.loadIndexPage();
    const rows = [];
    let i;
    for (i = 0; i < 5; i++) {
      rows.push({ _id: 'r' + i, fileID: 'cloud://env/f' + i, url: '', imageLoading: true, imageFailed: false });
    }
    const inst = stubs.makePageInstance(config, { list: rows });
    inst._visible = true;
    inst._allowed = true;
    inst._epoch = 1;
    await inst.refreshImages(1);
    const call = fx.calls.find(c => c.data.action === 'getOwnFileUrls');
    assert.ok(call, '应发起换链请求');
    assert.deepStrictEqual(call.data.recordIDs, ['r0', 'r1', 'r2', 'r3', 'r4']);
  });

  await test('P3 filter.imageLoad/imageError 定向更新 results[i]', async function () {
    stubs.installClientGlobals();
    const config = stubs.loadFilterPage();
    const rows = [];
    let i;
    for (i = 0; i < 80; i++) {
      rows.push({ _id: 'r' + i, fileID: 'f' + i, url: 'u' + i, imageLoading: true, imageFailed: false, selected: false });
    }
    const inst = stubs.makePageInstance(config, { results: rows });
    inst._visible = true;
    inst._images = new Map();
    inst.imageLoad({ currentTarget: { dataset: { id: 'r9', url: 'u9' } } });
    let payload = inst.__payloads[inst.__payloads.length - 1];
    assert.strictEqual(payload['results[9].imageLoading'], false);
    assert.strictEqual(payload.results, undefined, '不得整表更新 results');
    inst.imageError({ currentTarget: { dataset: { id: 'r70', url: 'u70' } } });
    payload = inst.__payloads[inst.__payloads.length - 1];
    assert.strictEqual(payload['results[70].imageFailed'], true);
    assert.strictEqual(inst._images.get('r70').imageFailed, true, '缓存 map 同步失败态');
    const stillLoading = inst.data.results.filter(r => r.imageLoading).length;
    assert.strictEqual(stillLoading, 78, '仅 r9 与 r70 两行退出加载态，其余行不受影响');
  });

  await test('P4 filter.resolveUrls 端到端：携带 recordIDs', async function () {
    const fx = stubs.installClientGlobals();
    const config = stubs.loadFilterPage();
    const rows = [];
    let i;
    for (i = 0; i < 3; i++) {
      rows.push({ _id: 'r' + i, fileID: 'cloud://env/f' + i, url: '', imageFailed: false, imageLoading: true });
    }
    const inst = stubs.makePageInstance(config, { results: rows });
    inst._visible = true;
    await inst.resolveUrls(rows);
    const call = fx.calls.find(c => c.data.action === 'getOwnFileUrls');
    assert.ok(call, '应发起换链请求');
    assert.deepStrictEqual(call.data.recordIDs, ['r0', 'r1', 'r2']);
  });

  console.log('\n[5] utils/image（compressThumb、checkFiles、skipToast）');
  await test('I1 大图等比降到 1600px 长边', async function () {
    stubs.installClientGlobals();
    const imageUtils = stubs.loadImageUtil();
    let opts = null;
    wx.getImageInfo = function (p) { p.success({ width: 4000, height: 3000 }); };
    wx.compressImage = function (p) { opts = p; p.success({ tempFilePath: 'thumb://1' }); };
    const out = await imageUtils.compressThumb('file://a.jpg');
    assert.strictEqual(out, 'thumb://1');
    assert.strictEqual(opts.quality, 60);
    assert.strictEqual(opts.compressedWidth, 1600);
    assert.strictEqual(opts.compressedHeight, 1200);
  });

  await test('I2 小于 1600px 只压质量不降尺寸', async function () {
    stubs.installClientGlobals();
    const imageUtils = stubs.loadImageUtil();
    let opts = null;
    wx.getImageInfo = function (p) { p.success({ width: 900, height: 1200 }); };
    wx.compressImage = function (p) { opts = p; p.success({ tempFilePath: 'thumb://2' }); };
    const out = await imageUtils.compressThumb('file://b.jpg');
    assert.strictEqual(out, 'thumb://2');
    assert.strictEqual(opts.compressedWidth, undefined);
    assert.strictEqual(opts.compressedHeight, undefined);
  });

  await test('I3 读取尺寸失败退化为仅质量压缩；压缩失败回退原图路径', async function () {
    stubs.installClientGlobals();
    const imageUtils = stubs.loadImageUtil();
    wx.getImageInfo = function (p) { p.fail(new Error('x')); };
    let opts = null;
    wx.compressImage = function (p) { opts = p; p.fail(new Error('compress unsupported')); };
    const out1 = await imageUtils.compressThumb('file://c.jpg');
    assert.strictEqual(out1, 'file://c.jpg', '压缩失败应回退原图路径');
    assert.strictEqual(opts.quality, 60, '读取尺寸失败仍尝试仅质量压缩');
    assert.strictEqual(opts.compressedWidth, undefined, '无尺寸信息不得降尺寸');
    wx.getImageInfo = function (p) { p.success({ width: 4000, height: 3000 }); };
    const out2 = await imageUtils.compressThumb('file://d.jpg');
    assert.strictEqual(out2, 'file://d.jpg');
  });

  await test('I4 checkFiles：超限与非法格式被跳过，无扩展名放行', function () {
    stubs.installClientGlobals();
    const imageUtils = stubs.loadImageUtil();
    const MB = 1024 * 1024;
    const out = imageUtils.checkFiles([
      { tempFilePath: 'tmp://a.jpg', size: 1 * MB },
      { tempFilePath: 'tmp://b.PNG', size: 20 * MB },
      { tempFilePath: 'tmp://c.jpeg?wx_fmt=jpeg', size: 2 * MB },
      { tempFilePath: 'tmp://d.webp', size: 1 * MB },
      { tempFilePath: 'tmp://e.HEIC', size: 1 * MB },
      { tempFilePath: 'tmp://f', size: 1 * MB },
      { tempFilePath: 'tmp://g.jpg', size: 20 * MB + 1 }
    ]);
    assert.deepStrictEqual(out.accepted.map(function (f) { return f.tempFilePath; }),
      ['tmp://a.jpg', 'tmp://b.PNG', 'tmp://c.jpeg?wx_fmt=jpeg', 'tmp://f']);
    assert.deepStrictEqual(out.skipped, [
      { tooLarge: false, badType: true },
      { tooLarge: false, badType: true },
      { tooLarge: true, badType: false }
    ], 'webp、HEIC 为格式不符；恰好 20MB 放行，多 1 字节跳过');
    assert.deepStrictEqual(imageUtils.checkFiles(undefined), { accepted: [], skipped: [] });
  });

  await test('I5 skipToast：按原因提示，多张时带跳过数量', function () {
    stubs.installClientGlobals();
    const imageUtils = stubs.loadImageUtil();
    assert.deepStrictEqual(imageUtils.skipToast([{ tooLarge: true, badType: false }]), { title: '图片不能超过 20MB', icon: 'none' });
    assert.deepStrictEqual(imageUtils.skipToast([{ tooLarge: false, badType: true }]), { title: '仅支持 JPG、PNG 图片', icon: 'none' });
    const mixed = imageUtils.skipToast([{ tooLarge: false, badType: true }, { tooLarge: true, badType: false }]);
    assert.strictEqual(mixed.title, '已跳过 2 张图片：仅支持 JPG、PNG 图片，且图片不能超过 20MB');
    const same = imageUtils.skipToast([{ tooLarge: true, badType: false }, { tooLarge: true, badType: false }]);
    assert.strictEqual(same.title, '已跳过 2 张图片：图片不能超过 20MB');
  });

  console.log('\n[6] 静态检查');
  await test('K1 upload.wxml 使用有效 wx:key', async function () {
    const wxml = fs.readFileSync(path.join(MP, 'pages', 'upload', 'upload.wxml'), 'utf8');
    assert.ok(wxml.indexOf('wx:key="tempPath"') >= 0);
    assert.ok(wxml.indexOf('wx:key="index"') < 0);
  });
  await test('K2 上传与附加图均接入 compressThumb', async function () {
    const uploadSrc = fs.readFileSync(path.join(MP, 'pages', 'upload', 'upload.js'), 'utf8');
    const detailSrc = fs.readFileSync(path.join(MP, 'pages', 'detail', 'detail.js'), 'utf8');
    assert.ok(uploadSrc.indexOf('imageUtils.compressThumb') >= 0);
    assert.ok(detailSrc.indexOf('imageUtils.compressThumb') >= 0);
    assert.ok(uploadSrc.indexOf('quality: 20') < 0, '旧的 quality:20 路径应已移除');
  });
  await test('K3 交互优化接线完整', async function () {
    const indexWxml = fs.readFileSync(path.join(MP, 'pages', 'index', 'index.wxml'), 'utf8');
    const filterWxml = fs.readFileSync(path.join(MP, 'pages', 'filter', 'filter.wxml'), 'utf8');
    const uploadSrc = fs.readFileSync(path.join(MP, 'pages', 'upload', 'upload.js'), 'utf8');
    const uploadWxml = fs.readFileSync(path.join(MP, 'pages', 'upload', 'upload.wxml'), 'utf8');
    const filterSrc = fs.readFileSync(path.join(MP, 'pages', 'filter', 'filter.js'), 'utf8');
    const detailSrc = fs.readFileSync(path.join(MP, 'pages', 'detail', 'detail.js'), 'utf8');
    const detailWxml = fs.readFileSync(path.join(MP, 'pages', 'detail', 'detail.wxml'), 'utf8');
    assert.ok(indexWxml.indexOf('empty-action') >= 0, '作品墙空状态应有引导按钮');
    assert.ok(filterWxml.indexOf('empty-action') >= 0, '筛选页空状态应有引导按钮');
    assert.ok(indexWxml.indexOf('open-type="switchTab"') >= 0);
    assert.ok(uploadWxml.indexOf('id="goConfirmBtn"') >= 0, '确认按钮应有锚点');
    assert.ok(uploadSrc.indexOf("selector: '#goConfirmBtn'") >= 0, '上传完成应滚动到确认按钮');
    assert.ok(filterSrc.indexOf('onReachBottom') >= 0, '筛选页应支持触底加载');
    assert.ok(detailWxml.indexOf('bindtap="previewThumb"') >= 0, '详情页图片应走缩略图预览');
    assert.ok(detailSrc.indexOf('previewThumb') >= 0, 'detail.js 应实现 previewThumb');
    assert.ok(detailWxml.indexOf('previewOriginal') >= 0, '查看原图按钮应保留');
    const filterJson = JSON.parse(fs.readFileSync(path.join(MP, 'pages', 'filter', 'filter.json'), 'utf8'));
    assert.ok(filterJson.onReachBottomDistance > 0, '筛选页应配置触底距离');
  });
  await test('K4 上传与附加图均接入选图预检', async function () {
    const uploadSrc = fs.readFileSync(path.join(MP, 'pages', 'upload', 'upload.js'), 'utf8');
    const detailSrc = fs.readFileSync(path.join(MP, 'pages', 'detail', 'detail.js'), 'utf8');
    const imageSrc = fs.readFileSync(path.join(MP, 'utils', 'image.js'), 'utf8');
    assert.ok(uploadSrc.indexOf('imageUtils.checkFiles') >= 0, '上传页应接入选图预检');
    assert.ok(detailSrc.indexOf('imageUtils.checkFiles') >= 0, '附加图应接入选图预检');
    assert.ok(imageSrc.indexOf('20 * 1024 * 1024') >= 0, '预检上限应与服务端 20MB 一致');
  });

  console.log();
  console.log('[7] 上传页选图预检');
  function pickUpload(inst, files) {
    // 页面以 Promise 形式调用 chooseMedia（不传 success 回调）。
    wx.chooseMedia = function () { return Promise.resolve({ tempFiles: files }); };
    return inst.choose({ currentTarget: { dataset: { source: 'album' } } });
  }

  await test('U1 全部不符：提示原因，不建上传会话，已有批次保留', async function () {
    const fx = stubs.installClientGlobals();
    const config = stubs.loadUploadPage();
    const inst = stubs.makePageInstance(config, { items: [{ tempPath: 'keep.jpg' }], running: false, accessState: 'active', accessMessage: '' });
    const toasts = [];
    wx.showToast = function (p) { toasts.push(p.title); };
    await pickUpload(inst, [{ tempFilePath: 'x.webp', size: 1 }, { tempFilePath: 'y.jpg', size: 21 * 1024 * 1024 }]);
    assert.deepStrictEqual(inst.data.items.map(function (i) { return i.tempPath; }), ['keep.jpg'], '已有批次不得被清掉');
    assert.deepStrictEqual(toasts, ['已跳过 2 张图片：仅支持 JPG、PNG 图片，且图片不能超过 20MB']);
    assert.ok(!fx.calls.some(function (c) { return c.data.action === 'beginUploadSession'; }), '不应创建上传会话');
  });

  await test('U2 部分不符：只处理通过的图片并提示跳过原因', async function () {
    const fx = stubs.installClientGlobals();
    const config = stubs.loadUploadPage();
    const inst = stubs.makePageInstance(config, { items: [], running: false, accessState: 'active', accessMessage: '' });
    inst.processAll = function () {}; // 本用例只验证选图结果，不跑上传。
    const toasts = [];
    wx.showToast = function (p) { toasts.push(p.title); };
    await pickUpload(inst, [
      { tempFilePath: 'ok1.jpg', size: 1 },
      { tempFilePath: 'big.png', size: 30 * 1024 * 1024 },
      { tempFilePath: 'ok2.png', size: 1 }
    ]);
    assert.deepStrictEqual(inst.data.items.map(function (i) { return i.tempPath; }), ['ok1.jpg', 'ok2.png']);
    assert.deepStrictEqual(toasts, ['图片不能超过 20MB']);
    assert.ok(fx.calls.some(function (c) { return c.data.action === 'beginUploadSession'; }), '应创建上传会话');
  });

  console.log();
  console.log('[8] 清空全部数据');
  // pages: 作品集分页夹具；failStopId: 让指定链接的停止请求失败。
  async function runClearAll(pages, failStopId) {
    stubs.installClientGlobals();
    const config = stubs.loadMyPage();
    const inst = stubs.makePageInstance(config, { accessLoading: false, accessError: '', activated: true, isAdmin: false, cleanupPending: false, statsLoading: false, accessRecords: [] });
    inst._visible = true;
    inst._accessReady = true;
    const byCursor = {};
    pages.forEach(function (page) { byCursor[page.cursor] = page; });
    const base = global.wx.cloud.callFunction;
    const view = { modal: '', toasts: [], log: [] };
    global.wx.cloud.callFunction = async function (p) {
      const action = p.data.action;
      view.log.push(p.data);
      if (action === 'listPortfolioShares') {
        const page = byCursor[p.data.cursor || ''];
        return { result: { ok: true, records: page.rows, hasMore: !!page.nextCursor, nextCursor: page.nextCursor || '' } };
      }
      if (action === 'stopPortfolioShare') {
        return { result: p.data.id === failStopId ? { ok: false, error: '服务暂不可用' } : { ok: true } };
      }
      if (action === 'listRecords') { return { result: { ok: true, records: [{ _id: 'r1' }, { _id: 'r2' }] } }; }
      return base(p);
    };
    wx.showToast = function (p) { view.toasts.push(p.title); };
    let done = null;
    wx.showModal = function (p) { view.modal = p.content; done = p.success({ confirm: true }); };
    inst.clearAll();
    await done;
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
    return view;
  }
  const PORTFOLIO_PAGES = [
    { cursor: '', rows: [{ id: 'l1', enabled: true }, { id: 'l2', enabled: false }], nextCursor: 'c1' },
    { cursor: 'c1', rows: [{ id: 'l3', enabled: true }], nextCursor: '' }
  ];

  await test('M1 清空时先停止全部有效作品集链接，再删除作品', async function () {
    const view = await runClearAll(PORTFOLIO_PAGES, null);
    const actions = view.log.map(function (a) { return a.action + (a.id ? ':' + a.id : ''); });
    const stops = actions.filter(function (a) { return a.indexOf('stopPortfolioShare:') === 0; });
    assert.deepStrictEqual(stops, ['stopPortfolioShare:l1', 'stopPortfolioShare:l3'], '翻页覆盖全部链接，已停止的 l2 不重复停止');
    assert.ok(actions.indexOf('stopPortfolioShare:l3') < actions.indexOf('removeRecord:r1'), '停止链接必须先于删除作品');
    assert.ok(view.modal.indexOf('停止全部作品集分享链接') >= 0, '确认弹窗应说明会停止作品集链接');
    assert.ok(view.toasts.indexOf('已清空') >= 0);
  });

  await test('M2 停止链接失败时中止并提示，不继续删除作品', async function () {
    const view = await runClearAll(PORTFOLIO_PAGES, 'l1');
    assert.ok(!view.log.some(function (a) { return a.action === 'removeRecord'; }), '失败后不得删除作品');
    assert.ok(view.toasts.indexOf('服务暂不可用') >= 0, '应提示失败原因');
  });

  console.log();
  console.log('[9] 详情页附加图选图预检');
  function pickExtras(inst, files) {
    wx.chooseMedia = function () { return Promise.resolve({ tempFiles: files }); };
    return inst.addExtraImages();
  }
  function extrasPage() {
    const config = stubs.loadDetailPage();
    const inst = stubs.makePageInstance(config, { record: { extraFiles: [] }, editing: false, canManage: true, extrasBusy: false, extrasUnknown: false, extrasMessage: '', saving: false, shareBusy: false });
    inst.id = 'rec1';
    inst._alive = true;
    inst._visible = true;
    return inst;
  }

  await test('D1 附加图全部不符：提示原因，不建会话，页面退出忙碌态', async function () {
    const fx = stubs.installClientGlobals();
    const inst = extrasPage();
    const toasts = [];
    wx.showToast = function (p) { toasts.push(p.title); };
    await pickExtras(inst, [{ tempFilePath: 'x.gif', size: 1 }, { tempFilePath: 'y.jpg', size: 25 * 1024 * 1024 }]);
    assert.deepStrictEqual(toasts, ['已跳过 2 张图片：仅支持 JPG、PNG 图片，且图片不能超过 20MB']);
    assert.strictEqual(inst.data.extrasBusy, false, '应退出忙碌态');
    assert.strictEqual(inst.data.extrasMessage, '', '应清掉进度文案');
    assert.ok(!fx.calls.some(function (c) { return c.data.action === 'beginUploadSession'; }), '不应创建上传会话');
  });

  await test('D2 附加图部分不符：只为通过的图片登记上传', async function () {
    const fx = stubs.installClientGlobals();
    const inst = extrasPage();
    const toasts = [];
    wx.showToast = function (p) { toasts.push(p.title); };
    pickExtras(inst, [{ tempFilePath: 'skip.bmp', size: 1 }, { tempFilePath: 'ok.png', size: 1 }]);
    await new Promise(function (resolve) { setTimeout(resolve, 30); });
    assert.deepStrictEqual(toasts, ['仅支持 JPG、PNG 图片']);
    const prepared = fx.calls.filter(function (c) { return c.data.action === 'prepareUploadJob'; });
    assert.deepStrictEqual(prepared.map(function (c) { return c.data.originalExt; }), ['png'], '只登记通过预检的图片');
    assert.strictEqual(inst.data.extrasMessage, '正在上传附加图 1 / 1', '进度按通过预检的数量计算');
    assert.ok(fx.calls.some(function (c) { return c.data.action === 'beginUploadSession' && c.data.targetRecordId === 'rec1'; }), '应为该作品创建附加图会话');
  });

  console.log('\n[回归结果] 客户端: 通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    failures.forEach(function (item) {
      console.log('\n失败: ' + item[0] + '\n  ' + (item[1] && item[1].stack || item[1]));
    });
    process.exit(1);
  }
}

main().catch(function (e) { console.error(e); process.exit(1); });
