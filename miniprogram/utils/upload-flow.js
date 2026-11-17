const api = require('./api');
const KEY = 'upload_cleanup_v1';
const controllers = new Set();
let foreground = true, online = true, initialized = false, drainPromise = null;
let queue = [];
const requestId = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + '_' + Math.random().toString(36).slice(2);
function store() {
  try { wx.setStorageSync(KEY, queue); }
  catch (_) { wx.showToast({ title: '暂存失败，云端仍会回收未保存图片', icon: 'none' }); }
}
function add(entry) {
  if (!queue.some(q => q.requestId === entry.requestId)) { queue.push(entry); store(); }
}
function remove(request) { queue = queue.filter(q => q.requestId !== request); store(); }
function dirty() { api.invalidate(); }
function flush() {
  if (drainPromise) return drainPromise;
  if (!online || !queue.length) return Promise.resolve();
  drainPromise = drain().finally(() => { drainPromise = null; });
  return drainPromise;
}
async function drain() {
  try {
    if (!queue.length) return;
    const status = await api.getAccessStatus({ force: true });
    for (const entry of queue.slice()) {
      // 归属摘要不用于授权，只防设备旧账号任务混入当前账号。
      if (entry.scope !== status.uploadScope) continue;
      if (controllers.size && Array.from(controllers).some(c => !c.cancelled && c.requestId === entry.requestId)) continue;
      try {
        let sid = entry.sessionId;
        if (!sid) sid = (await api.beginUploadSession({
          requestId: entry.requestId, kind: entry.kind, targetRecordId: entry.targetRecordId
        })).sessionId;
        const result = await api.closeUploadSession(sid, 'leave');
        if (result.jobs.some(j => j.state === 'committed')) dirty();
        if (result.state === 'closed') remove(entry.requestId);
      } catch (_) { /* 断网、失效账号、未知创建结果保留，云端过期仍兜底 */ }
    }
  } catch (_) { /* 下次启动/重连重试 */ }
}
function init() {
  if (initialized) return;
  initialized = true;
  try {
    const saved = wx.getStorageSync(KEY);
    queue = Array.isArray(saved) ? saved.filter(q => q && typeof q.requestId === 'string' && typeof q.scope === 'string') : [];
  } catch (_) { queue = []; }
  if (wx.onNetworkStatusChange) wx.onNetworkStatusChange(result => {
    online = !!result.isConnected;
    if (online) flush();
    controllers.forEach(c => c.wake());
  });
  if (wx.getNetworkType) wx.getNetworkType({ success: r => { online = r.networkType !== 'none'; } });
  flush();
}
function appHide() { foreground = false; controllers.forEach(c => c.wake()); }
function appShow() {
  foreground = true;
  controllers.forEach(c => { c.needsCheck = true; c.wake(); });
  flush();
}
class Controller {
  constructor(page, kind, targetRecordId) {
    init();
    this.page = page;
    this.kind = kind;
    this.targetRecordId = targetRecordId || '';
    this.requestId = requestId();
    this.tasks = new Set();
    this.waiters = [];
    this.visible = true;
    this.external = 0;
    this.cancelled = false;
    controllers.add(this);
  }
  alive() { return !this.cancelled; }
  wake() { const waiters = this.waiters.splice(0); waiters.forEach(resolve => resolve()); }
  async checkpoint() {
    while (this.alive() && (!foreground || !this.visible)) await new Promise(resolve => this.waiters.push(resolve));
    if (!this.alive()) throw new Error('已放弃未保存图片');
    if (this.sessionId && this.expiresAt <= Date.now()) {
      await this.cancel('leave');
      throw new Error('该批图片已失效，请重新选图');
    }
    if (!online) throw new Error('网络已断开，请恢复网络后点击重试');
    if ((this.needsCheck || this.checkPromise) && this.sessionId) {
      if (!this.checkPromise) this.checkPromise = (async () => {
        try {
          const status = await api.requireAccess();
          if (status.uploadScope !== this.scope) throw new Error('账号已变化，请重新选图');
          const state = await api.readUploadSession(this.sessionId);
          if (state.state !== 'open' || state.expired || state.expiresAt <= Date.now()) throw new Error('该批图片已失效，请重新选图');
          if (this.kind === 'extra') await api.getRecord(this.targetRecordId);
          this.needsCheck = false;
        } catch (error) {
          this.needsCheck = true;
          if (/失效|不存在|无权|正在删除|先在|账号已变化/.test(error.message || '')) await this.cancel('leave');
          throw error;
        }
      })().finally(() => { this.checkPromise = null; });
      await this.checkPromise;
      return this.checkpoint();
    }
  }
  async begin() {
    await this.checkpoint();
    const status = await api.requireAccess();
    await this.checkpoint();
    this.scope = status.uploadScope;
    if (typeof this.scope !== 'string' || !this.scope) throw new Error('上传服务尚未更新，请更新服务后重试');
    const entry = { requestId: this.requestId, scope: this.scope, kind: this.kind, targetRecordId: this.targetRecordId, sessionId: '' };
    add(entry); // 必须早于创建请求；响应丢失仍能用原 requestId 找回。
    const result = await api.beginUploadSession({
      requestId: this.requestId, kind: this.kind, targetRecordId: this.targetRecordId
    });
    this.sessionId = result.sessionId;
    this.expiresAt = result.expiresAt;
    const saved = queue.find(q => q.requestId === this.requestId);
    if (saved) { saved.sessionId = result.sessionId; store(); }
    if (!this.alive()) { await this.cancel('leave'); throw new Error('已放弃未保存图片'); }
    await this.checkpoint();
  }
  async prepare(slot, path) {
    await this.checkpoint();
    const match = /\.([a-z0-9]{1,10})(?:\?|$)/i.exec(path);
    const job = await api.prepareUploadJob({
      sessionId: this.sessionId, requestId: requestId(), slot,
      originalExt: match ? match[1].toLowerCase() : 'jpg', thumbExt: 'jpg'
    });
    if (!this.alive()) { await this.cancel('leave'); throw new Error('已放弃未保存图片'); }
    await this.checkpoint();
    return job;
  }
  track(task) {
    if (!task) return;
    if (!this.alive()) { if (task.abort) task.abort(); }
    else this.tasks.add(task);
  }
  async abandon(jobId) {
    await this.checkpoint();
    return api.abandonUploadJob(this.sessionId, jobId);
  }
  async cancel(reason = 'cancel') {
    this.cancelled = true;
    this.handoff = false;
    this.tasks.forEach(task => { try { if (task.abort) task.abort(); } catch (_) { } });
    this.tasks.clear();
    this.wake();
    controllers.delete(this);
    if (this.page && typeof this.page.onUploadCancelled === 'function') this.page.onUploadCancelled(this);
    if (!this.sessionId) { flush(); return false; }
    try {
      const result = await api.closeUploadSession(this.sessionId, reason);
      if (result.jobs.some(j => j.state === 'committed')) dirty();
      if (result.state === 'closed') remove(this.requestId);
      return true;
    } catch (_) { return false; }
  }
  hide() {
    this.visible = false;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.visible && foreground && !this.external && !this.handoff) this.cancel('leave');
    }, 100);
  }
  show() {
    clearTimeout(this.hideTimer);
    this.visible = true;
    this.needsCheck = true;
    this.wake();
  }
  unload() {
    clearTimeout(this.hideTimer);
    if (!this.handoff) this.cancel('leave');
  }
  async systemCall(operation) {
    this.external++;
    try { return await operation(); }
    finally {
      // chooseMedia/previewImage 可能先回调再 page.onShow；留一个生命周期仲裁窗口。
      setTimeout(() => {
        this.external = Math.max(0, this.external - 1);
        if (!this.visible && foreground && !this.external && !this.handoff) this.cancel('leave');
      }, 150);
    }
  }
  transfer(page) {
    this.handoff = false;
    this.page = page;
    this.show();
  }
}
async function cancelAll() { await Promise.all(Array.from(controllers).map(c => c.cancel('clear'))); }
module.exports = { Controller, init, appHide, appShow, flush, cancelAll, dirty };
