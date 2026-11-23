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

  console.log('\n[5] utils/image.compressThumb');
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

  console.log('\n[回归结果] 客户端: 通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    failures.forEach(function (item) {
      console.log('\n失败: ' + item[0] + '\n  ' + (item[1] && item[1].stack || item[1]));
    });
    process.exit(1);
  }
}

main().catch(function (e) { console.error(e); process.exit(1); });
