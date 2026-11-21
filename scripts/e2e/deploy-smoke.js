'use strict';
/* 部署冒烟：触发 IDE 重编译以获得干净应用环境（会话内 mock 失效），
 * 然后真实调用部署后的 accessGate（只读 status），最后还原触碰的文件。 */
const fs = require('fs');
const path = require('path');
const automator = require('miniprogram-automator');
const sleep = ms => new Promise(r => { setTimeout(r, ms); });

const ROOT = path.resolve(__dirname, '..', '..');
const APP_JS = path.join(ROOT, 'miniprogram', 'app.js');
const WS = 'ws://127.0.0.1:9420';

async function connectRetry() {
  for (let i = 0; i < 20; i++) {
    try { return await automator.connect({ wsEndpoint: WS }); }
    catch (e) { await sleep(2000); }
  }
  throw new Error('重连自动化端口失败');
}
async function isMocked(mp) {
  try { return await mp.evaluate(() => !!(wx.__e2e)); }
  catch (e) { return 'conn-error'; }
}

async function main() {
  const original = fs.readFileSync(APP_JS, 'utf8');
  let mp = await connectRetry();
  let mocked = await isMocked(mp);
  if (mocked === true) {
    console.log('会话内存在 E2E 打桩，触发重编译以还原真实环境 …');
    fs.writeFileSync(APP_JS, original + '\n// deploy-smoke\n');
    await sleep(6000);
    mp = await connectRetry();
    for (let i = 0; i < 10 && (await isMocked(mp)) === true; i++) { await sleep(3000); }
    mocked = await isMocked(mp);
  }
  console.log('mock 状态:', mocked);
  if (mocked === true) {
    console.log('未能获得干净环境（可能未开启保存后自动编译），改为仅做文件核对');
    fs.writeFileSync(APP_JS, original);
    process.exit(2);
  }
  const result = await mp.evaluate(() => new Promise(resolve => {
    wx.cloud.callFunction({ name: 'accessGate', data: { action: 'status' } })
      .then(r => resolve({
        ok: r.result && r.result.ok,
        role: r.result && r.result.role,
        activated: r.result && r.result.activated,
        uploadScopeLen: r.result && r.result.uploadScope ? r.result.uploadScope.length : 0,
        notices: r.result && r.result.notices ? Object.keys(r.result.notices).join(',') : String(r.result && r.result.notices)
      }))
      .catch(e => resolve({ error: (e && e.errMsg) || String(e) }));
  }));
  console.log('真实 status 调用:', JSON.stringify(result));
  fs.writeFileSync(APP_JS, original);
  await sleep(1500);
  const ok = result && result.ok === true && typeof result.uploadScopeLen === 'number';
  console.log(ok ? '[冒烟] 部署后的 accessGate 调用成功' : '[冒烟] 调用异常，请检查部署');
  process.exit(ok ? 0 : 1);
}
main().catch(e => { console.error('SMOKE_FAIL', e && e.message); try { fs.writeFileSync(APP_JS, fs.readFileSync(APP_JS, 'utf8').replace('\n// deploy-smoke\n', '')); } catch (_) {} process.exit(1); });
