const api = require('../../utils/api');
const flow = require('../../utils/upload-flow');
const onboarding = require('../../utils/onboarding');

const STAGES = {
  uploading: { label: '正在保存原图', hint: '原图单独保存，方便以后查看高清细节', step: 1 },
  compressing: { label: '正在生成缩略图', hint: '为图片分析和作品列表准备轻量副本', step: 2 },
  thumbnail: { label: '正在上传缩略图', hint: '接下来会检查图片并整理标签', step: 2 },
  checking: { label: '正在检查图片', hint: '图片检查结束后开始分析', step: 3 },
  analyzing: { label: 'AI 正在整理标签', hint: '', step: 4 }
};
// 这些是等待提示，并非模型内部各维度的识别进度。
const ANALYSIS_HINTS = [
  '这次会整理颜色、色系、花材、种类、风格和用途',
  '不确定的花材会留空，稍后可以手动补充',
  '标签生成后，你可以逐张校对再保存',
  '作品保存后，可以用标签快速找到它'
];

Page({
  data: {
    items: [],        // { tempPath, status, error, fileID, tags }
    running: false,
    lossless: true,   // 默认原图无损上传
    doneCount: 0,
    failCount: 0,
    accessState: 'loading',
    accessMessage: ''
  },

  onShow() {
    onboarding.pageShow(this);
    this._hidden = false;
    this._visible = true;
    if (this._flow) this._flow.show();
    if (this._activeStage) this.startStageTimer();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    this.refreshAccess();
  },

  onHide() {
    onboarding.pageHide(this);
    this._accessSeq = (this._accessSeq || 0) + 1;
    this._hidden = true;
    this._visible = false;
    if (this._flow) this._flow.hide();
    this.stopStageTimer();
  },

  onUnload() {
    onboarding.pageHide(this);
    this._accessSeq = (this._accessSeq || 0) + 1;
    this._disposed = true;
    this.stopStageTimer();
    if (this._flow) this._flow.unload();
  },

  onUploadCancelled(controller) {
    if (controller !== this._flow) return;
    this.stopStageTimer();
    this._activeStage = null;
    if (!this._disposed) this.setData({ items: [], running: false, doneCount: 0, failCount: 0 });
  },

  stopStageTimer() {
    if (this._stageTimer) clearInterval(this._stageTimer);
    this._stageTimer = null;
  },

  startStageTimer() {
    this.stopStageTimer();
    if (this._hidden || this._disposed || !this._activeStage) return;
    this.updateStageFeedback();
    this._stageTimer = setInterval(() => this.updateStageFeedback(), 1000);
  },

  setStage(index, status) {
    if (this._disposed) return;
    const stage = STAGES[status];
    this._activeStage = { index, status, startedAt: Date.now() };
    const key = 'items[' + index + ']';
    this.setData({
      [key + '.status']: status,
      [key + '.stageLabel']: stage.label,
      [key + '.stageStep']: stage.step,
      [key + '.elapsedSeconds']: 0,
      [key + '.uploadProgress']: 0,
      [key + '.hint']: stage.hint
    });
    this.startStageTimer();
  },

  updateStageFeedback() {
    if (!this._activeStage || this._disposed || this._hidden) return;
    const { index, status, startedAt } = this._activeStage;
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const key = 'items[' + index + ']';
    let hint = STAGES[status].hint;
    if (status === 'analyzing') {
      hint = ANALYSIS_HINTS[Math.floor(elapsed / 5) % ANALYSIS_HINTS.length];
      if (elapsed >= 25) hint = '这张图片等待较久，仍在等待分析结果。' + hint;
    }
    this.setData({ [key + '.elapsedSeconds']: elapsed, [key + '.hint']: hint });
  },

  uploadProgress(index, status, progress) {
    if (this._disposed || this._hidden || !this._activeStage ||
        this._activeStage.index !== index || this._activeStage.status !== status) return;
    const value = Math.max(0, Math.min(100, Math.floor(Number(progress) || 0)));
    const key = 'items[' + index + '].uploadProgress';
    if (this.data.items[index].uploadProgress !== value) this.setData({ [key]: value });
  },

  ensurePageAlive() {
    if (this._disposed) throw new Error('页面已关闭');
  },

  async refreshAccess() {
    const seq = this._accessSeq = (this._accessSeq || 0) + 1;
    this.setData({ accessState: 'loading', accessMessage: '' });
    const ticket = onboarding.capture(this);
    try {
      const status = await api.getAccessStatus();
      if (this._disposed || seq !== this._accessSeq || this._hidden) return;
      const allowed = status.canUpload && !status.cleanupPending;
      if (!allowed && this._flow) await this._flow.cancel('leave');
      if (this._disposed || seq !== this._accessSeq || this._hidden) return;
      this.setData({ accessState: allowed ? 'active' : 'locked' });
      onboarding.present(this, status, ticket);
    } catch (error) {
      if (this._disposed || seq !== this._accessSeq || this._hidden) return;
      this.setData({
        accessState: 'error',
        accessMessage: error.message || '云服务暂不可用，请稍后重试'
      });
    }
  },

  async ensureAccess() {
    const seq = this._accessSeq;
    const ticket = onboarding.capture(this);
    try {
      const status = await api.requireAccess();
      if (this._disposed || this._hidden || seq !== this._accessSeq) return false;
      onboarding.present(this, status, ticket);
      this.setData({ accessState: status.canUpload ? 'active' : 'locked' });
      if (status.canUpload && !status.cleanupPending) return true;
      if (this._flow) await this._flow.cancel('leave');
      wx.showToast({ title: '请先在「我的」输入校验码', icon: 'none' });
    } catch (error) {
      if (this._disposed || this._hidden || seq !== this._accessSeq) return false;
      if (this._flow) await this._flow.cancel('leave');
      if (this._disposed || this._hidden || seq !== this._accessSeq) return false;
      this.setData({
        accessState: 'error',
        accessMessage: error.message || '云服务暂不可用，请稍后重试'
      });
    }
    return false;
  },
  onWelcomeActivate() {},

  /** 选图（相册 / 拍照） */
  async choose(e) {
    if (this.data.running || this._choosing || this._opening) return;
    this._choosing = true;
    const sourceType = e.currentTarget.dataset.source === 'camera' ? ['camera'] : ['album'];
    const guard = this._flow && this._flow.alive() ? this._flow : new flow.Controller(this, 'primary');
    if (!this._flow || !this._flow.alive()) this._flow = guard;
    try {
      if (!await this.ensureAccess()) return;
      const res = await guard.systemCall(() => wx.chooseMedia({
        count: 9,
        mediaType: ['image'],
        // 无损模式只允许原图；省流模式交给微信系统压缩（有损，设置中可切换）
        sizeType: this.data.lossless ? ['original'] : ['compressed'],
        sourceType
      }));
      await guard.checkpoint();
      if (this._disposed || this.data.running) return;
      const items = res.tempFiles.map(f => ({
        tempPath: f.tempFilePath,
        status: 'pending',
        error: '',
        fileID: '',
        tags: null
      }));
      await this.clearList('replace');
      if (this._disposed || this._hidden) return;
      this._flow = new flow.Controller(this, 'primary');
      await this._flow.begin();
      this.setData({ items, doneCount: 0, failCount: 0 });
      this.processAll();
    } catch (err) {
      if (!/cancel/.test(err && err.errMsg || '') && !this._hidden && !this._disposed) {
        wx.showToast({ title: err.message || '选图失败', icon: 'none' });
      }
    } finally { this._choosing = false; }
  },

  /** 逐张处理：原图入库 → 生成分析副本 → AI 打标 */
  async processAll() {
    const controller = this._flow;
    this.setData({ running: true });
    for (let i = 0; i < this.data.items.length; i++) {
      if (this._disposed || controller !== this._flow || !controller.alive()) break;
      await this.processOne(i, controller);
    }
    if (!this._disposed && controller === this._flow) this.setData({ running: false });
  },

  async processOne(i, controller = this._flow) {
    const key = 'items[' + i + ']';
    const item = this.data.items[i];
    const attempt = this._attemptSeq = (this._attemptSeq || 0) + 1;
    this.setData({ [key + '.attempt']: attempt });
    let fileID = '';
    let thumbFileID = '';
    const current = () => !this._disposed && controller === this._flow && controller.alive()
      && this.data.items[i] && this.data.items[i].attempt === attempt;
    const checkpoint = async () => { await controller.checkpoint(); if (!current()) throw new Error('上传已取消'); };
    try {
      await checkpoint();
      const job = await controller.prepare(i, item.tempPath);
      await checkpoint();
      this.setData({ [key + '.jobId']: job.jobId, [key + '.sessionId']: controller.sessionId });
      // 1. 原图无损存入云存储 works/
      this.setData({ [key + '.error']: '' });
      this.setStage(i, 'uploading');
      fileID = await api.uploadWorkImage(item.tempPath,
        progress => { if (current()) this.uploadProgress(i, 'uploading', progress); }, { job, controller });
      await checkpoint();
      this.setData({ [key + '.fileID']: fileID });

      // 2. 生成压缩缩略图上传 thumbs/（长期保存：列表/详情展示 + AI 分析共用，不覆盖原图）
      this.setStage(i, 'compressing');
      let thumbPath = item.tempPath;
      try {
        // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
        const c = await wx.compressImage({ src: item.tempPath, quality: 20 });
        thumbPath = c.tempFilePath;
      } catch (e) { /* PNG 等格式压不了就直接用原图 */ }
      await checkpoint();
      this.setStage(i, 'thumbnail');
      thumbFileID = await api.uploadThumbImage(thumbPath,
        progress => { if (current()) this.uploadProgress(i, 'thumbnail', progress); }, { job, controller });
      await checkpoint();
      this.setData({ [key + '.thumbFileID']: thumbFileID });

      // 3. 安全审查 (imgSecCheck)
      // 注意：imgSecCheck 接口限制图片大小必须 <= 1MB，如果压缩后的 thumbFile 依然超过 1MB 会报错 invalid media size
      // 云端从登记原图生成审核副本，普通错误同样阻断。
      this.setStage(i, 'checking');
      const secRes = await api.imgSecCheck(thumbFileID, job);
      await checkpoint();
      if (!secRes || !secRes.ok) throw new Error(secRes && secRes.error || '安全检测失败，请重试');

      // 4. 云函数调视觉模型打标（直接复用 thumbs/ 缩略图，云函数不再删图）
      this.setStage(i, 'analyzing');
      const result = await api.analyzeImage(thumbFileID);
      await checkpoint();
      if (!result || !result.ok) throw new Error(result && result.error || 'AI 分析失败');

      this.setData({
        [key + '.status']: 'done',
        [key + '.tags']: result.tags,
        doneCount: this.data.doneCount + 1
      });
    } catch (e) {
      if (current()) {
        this.setData({
          [key + '.status']: 'error',
          [key + '.error']: (e && e.message) || '处理失败',
          failCount: this.data.failCount + 1
        });
      }
    } finally {
      if (controller === this._flow) { this.stopStageTimer(); this._activeStage = null; }
    }
  },

  async retry(e) {
    if (this.data.running || this._retrying || this._opening) return;
    this._retrying = true;
    try {
      if (!await this.ensureAccess()) return;
      if (this._disposed || this.data.running) return;
      const controller = this._flow;
      const i = Number(e.currentTarget.dataset.index);
      const old = this.data.items[i];
      if (!old || old.status !== 'error' || !controller || !controller.alive()) return;
      try {
        if (old.jobId) await controller.abandon(old.jobId);
        if (this._disposed || controller !== this._flow || !controller.alive()) return;
        this.setData({ ['items[' + i + '].fileID']: '', ['items[' + i + '].thumbFileID']: '' });
      } catch (error) {
        if (!this._disposed && controller === this._flow && controller.alive()) wx.showToast({ title: '旧图片放弃未完成，请重试', icon: 'none' });
        return;
      }
      this.setData({ running: true, failCount: Math.max(0, this.data.failCount - 1) });
      await this.processOne(i, controller);
      if (!this._disposed && controller === this._flow && controller.alive()) this.setData({ running: false });
    } finally { this._retrying = false; }
  },

  /** 去确认标签 */
  async goConfirm() {
    if (this.data.running || this._opening) return;
    this._opening = true;
    let navigating = false;
    try {
    if (!await this.ensureAccess()) return;
    if (this.data.running || this._disposed) return;
    if (!this._flow || !this._flow.alive()) return;
    await this._flow.checkpoint();
    const ready = this.data.items.filter(x => x.status === 'done');
    if (!ready.length) {
      wx.showToast({ title: '没有可确认的记录', icon: 'none' });
      return;
    }
    const controller = this._flow;
    controller.handoff = true;
    getApp().globalData.pendingUpload = {
      controller,
      onClaim: () => {
        if (this._flow !== controller) return;
        this._flow = null;
        if (!this._disposed) this.setData({ items: [], doneCount: 0, failCount: 0 });
      }
    };
    getApp().globalData.pendingList = ready.map(x => ({
      sessionId: controller.sessionId,
      jobId: x.jobId,
      fileID: x.fileID,
      thumbFileID: x.thumbFileID,
      tempPath: x.tempPath,
      tags: x.tags
    }));
    navigating = true;
    wx.navigateTo({
      url: '/pages/confirm/confirm',
      success: () => {
        setTimeout(() => {
          if (controller.page !== this) return;
          controller.handoff = false; controller.cancel('leave');
          getApp().globalData.pendingUpload = null; getApp().globalData.pendingList = [];
        }, 1000);
      },
      fail: () => {
        controller.handoff = false;
        controller.show();
        getApp().globalData.pendingUpload = null;
        getApp().globalData.pendingList = [];
        wx.showToast({ title: '确认页打开失败，请重试', icon: 'none' });
      },
      complete: () => { this._opening = false; }
    });
    } catch (error) {
      if (!this._disposed && !this._hidden) wx.showToast({ title: error.message || '确认页暂不可用', icon: 'none' });
    } finally { if (!navigating) this._opening = false; }
  },

  async clearList(reason = 'cancel') {
    const controller = this._flow;
    const closed = controller ? await controller.cancel(typeof reason === 'string' ? reason : 'cancel') : true;
    const owned = controller === this._flow;
    if (owned) this._flow = null;
    if (owned && !this._disposed) this.setData({ items: [], running: false, doneCount: 0, failCount: 0 });
    if (owned && !closed && controller && controller.sessionId && !this._hidden && !this._disposed) {
      wx.showToast({ title: '已停止，恢复网络后回收未保存图片', icon: 'none' });
    }
  },

  cancelUpload() {
    if (this._cancelConfirming) return;
    this._cancelConfirming = true;
    const controller = this._flow;
    wx.showModal({
      title: '取消上传', content: '停止当前批次并回收未保存图片，已保存作品会保留。',
      confirmText: '确认取消',
      success: r => { if (r.confirm && controller === this._flow) this.clearList(); },
      complete: () => { this._cancelConfirming = false; }
    });
  }
});
