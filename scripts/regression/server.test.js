'use strict';
/* 服务端回归：getOwnFileUrls 提示加速与安全边界 + 冒烟。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const stubs = require('./stubs.js');
const CF = path.join(stubs.MP, '..', 'cloudfunctions', 'accessGate');

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
  console.log('\n[1] accessGate.getOwnFileUrls');
  await test('T1 提示命中：仅提示查询，零全表扫描', async function () {
    const f = stubs.newServerFixture({ recordCount: 6 });
    const gate = stubs.loadGate();
    const r0 = f.records[0];
    const r1 = f.records[1];
    const result = await gate.main({
      action: 'getOwnFileUrls',
      fileIDs: [r0.thumbFileID, r1.thumbFileID],
      recordIDs: [r0._id, r1._id, f.records[2]._id]
    });
    assert.strictEqual(result.ok, true, '应成功: ' + result.error);
    assert.strictEqual(result.urls[r0.thumbFileID],
      'https://signed.example/' + encodeURIComponent(r0.thumbFileID));
    assert.strictEqual(result.urls[r1.thumbFileID],
      'https://signed.example/' + encodeURIComponent(r1.thumbFileID));
    const recordQueries = f.log.queries.filter(q => q.collection === 'records');
    assert.ok(recordQueries.some(q => !q.scan), '应执行提示查询');
    assert.ok(!recordQueries.some(q => q.scan), '提示命中时不得全表扫描');
    assert.strictEqual(Object.keys(result.urls).length, 2, '只返回请求过的文件');
  });

  await test('T2 无提示：回退全表扫描仍可返回（兼容旧客户端）', async function () {
    const f = stubs.newServerFixture({ recordCount: 6 });
    const gate = stubs.loadGate();
    const r0 = f.records[0];
    const r3 = f.records[3];
    const result = await gate.main({ action: 'getOwnFileUrls', fileIDs: [r0.thumbFileID, r3.fileID] });
    assert.strictEqual(result.ok, true, '应成功: ' + result.error);
    assert.ok(f.log.queries.some(q => q.collection === 'records' && q.scan), '应回退扫描');
    assert.ok(result.urls[r0.thumbFileID] && result.urls[r3.fileID]);
  });

  await test('T3 提示含他人记录 ID：不采信，扫描兜底且越权文件被拒绝', async function () {
    const f = stubs.newServerFixture({ recordCount: 6 });
    const gate = stubs.loadGate();
    const r0 = f.records[0];
    const crypto = require('crypto');
    const hashB = crypto.createHash('sha256').update('openid-B').digest('hex');
    const foreign = 'cloud://env.appid/userFiles/' + hashB + '/works/evil.jpg';
    const result = await gate.main({
      action: 'getOwnFileUrls',
      fileIDs: [r0.thumbFileID, foreign],
      recordIDs: [r0._id, 'zzz-not-owned']
    });
    assert.strictEqual(result.ok, false, '越权文件应拒绝');
    assert.ok(String(result.error).indexOf('不存在或无权访问') >= 0, '实际文案: ' + result.error);
    assert.strictEqual(Object.keys(result.urls || {}).length, 0);
    assert.ok(f.log.queries.some(q => q.collection === 'records' && q.scan), '覆盖不全应回退扫描');
  });

  await test('T4 二次校验遇并发删除：返回「图片已变化，请刷新」', async function () {
    const f = stubs.newServerFixture({ recordCount: 6, failDocGets: new Set(['records/r3']) });
    const gate = stubs.loadGate();
    const row = f.records[0];
    const result = await gate.main({
      action: 'getOwnFileUrls',
      fileIDs: [row.thumbFileID],
      recordIDs: [row._id]
    });
    assert.strictEqual(result.ok, false, '并发删除应失败');
    assert.ok(String(result.error).indexOf('图片已变化，请刷新') >= 0, '实际文案: ' + result.error);
  });

  await test('T5 deleting 中的作品文件：扫描兜底也不发 URL', async function () {
    const f = stubs.newServerFixture({ recordCount: 3 });
    f.records[0].deleting = true;
    const gate = stubs.loadGate();
    const result = await gate.main({ action: 'getOwnFileUrls', fileIDs: [f.records[0].thumbFileID] });
    assert.strictEqual(result.ok, false, '删除中的文件应拒绝');
    assert.ok(String(result.error).indexOf('不存在或无权访问') >= 0);
  });

  console.log('\n[2] accessGate 冒烟');
  await test('S1 status 正常返回', async function () {
    stubs.newServerFixture({ recordCount: 2 });
    const gate = stubs.loadGate();
    const result = await gate.main({ action: 'status' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.role, 'florist');
  });

  await test('S2 getRecordPage 正常分页并带 URL', async function () {
    const f = stubs.newServerFixture({ recordCount: 6 });
    const gate = stubs.loadGate();
    const result = await gate.main({ action: 'getRecordPage', skip: 0, limit: 20 });
    assert.strictEqual(result.ok, true, result.error);
    assert.strictEqual(result.records.length, 6);
    assert.strictEqual(result.nextSkip, 6);
    assert.ok(Object.keys(result.urls).length >= 6);
    assert.strictEqual(result.hasMore, false);
  });

  await test('S3 死代码已移除', async function () {
    const src = fs.readFileSync(path.join(CF, 'index.js'), 'utf8');
    assert.ok(src.indexOf('assertFile') < 0, 'assertFile 应已删除');
    assert.ok(src.indexOf('assertLegacyFile') < 0, 'assertLegacyFile 应已删除');
  });

  console.log('\n[回归结果] 服务端: 通过 ' + passed + ' / 失败 ' + failed);
  if (failed) {
    failures.forEach(function (item) {
      console.log('\n失败: ' + item[0] + '\n  ' + (item[1] && item[1].stack || item[1]));
    });
    process.exit(1);
  }
}

main().catch(function (e) { console.error(e); process.exit(1); });
