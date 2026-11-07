const api = require('../../utils/api');

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
    this._hidden = false;
    if (this._activeStage) this.startStageTimer();
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    this.refreshAccess();
  },

  onHide() {
    this._hidden = true;
    this.stopStageTimer();
  },

  onUnload() {
    this._disposed = true;
    this.stopStageTimer();
    api.deleteCloudFiles(this.data.items.reduce((ids, item) =>
      ids.concat(item.fileID || '', item.thumbFileID || ''), [])).catch(console.error);
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
    if (this._disposed || !this._activeStage ||
        this._activeStage.index !== index || this._activeStage.status !== status) return;
    const value = Math.max(0, Math.min(100, Math.floor(Number(progress) || 0)));
    const key = 'items[' + index + '].uploadProgress';
    if (this.data.items[index].uploadProgress !== value) this.setData({ [key]: value });
  },

  ensurePageAlive() {
    if (this._disposed) throw new Error('页面已关闭');
  },

  async refreshAccess() {
    this.setData({ accessState: 'loading', accessMessage: '' });
    try {
      const status = await api.getAccessStatus();
      if (this._disposed) return;
      this.setData({ accessState: status.activated ? 'active' : 'locked' });
    } catch (error) {
      if (this._disposed) return;
      this.setData({
        accessState: 'error',
        accessMessage: error.message || '云服务暂不可用，请稍后重试'
      });
    }
  },

  async ensureAccess() {
    try {
      const status = await api.getAccessStatus();
      if (this._disposed) return false;
      this.setData({ accessState: status.activated ? 'active' : 'locked' });
      if (status.activated) return true;
      wx.showToast({ title: '请先在「我的」输入校验码', icon: 'none' });
    } catch (error) {
      if (this._disposed) return false;
      this.setData({
        accessState: 'error',
        accessMessage: error.message || '云服务暂不可用，请稍后重试'
      });
    }
    return false;
  },

  /** 选图（相册 / 拍照） */
  async choose(e) {
    if (this.data.running) return;
    if (!await this.ensureAccess()) return;
    const sourceType = e.currentTarget.dataset.source === 'camera' ? ['camera'] : ['album'];
    try {
      const res = await wx.chooseMedia({
        count: 9,
        mediaType: ['image'],
        // 无损模式只允许原图；省流模式交给微信系统压缩（有损，设置中可切换）
        sizeType: this.data.lossless ? ['original'] : ['compressed'],
        sourceType
      });
      if (this._disposed || this.data.running) return;
      const items = res.tempFiles.map(f => ({
        tempPath: f.tempFilePath,
        status: 'pending',
        error: '',
        fileID: '',
        tags: null
      }));
      this.clearList();
      this.setData({ items, doneCount: 0, failCount: 0 });
      this.processAll();
    } catch (err) {
      if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
        wx.showToast({ title: '选图失败', icon: 'none' });
      }
    }
  },

  /** 逐张处理：原图入库 → 生成分析副本 → AI 打标 */
  async processAll() {
    this.setData({ running: true });
    for (let i = 0; i < this.data.items.length; i++) {
      if (this._disposed) break;
      await this.processOne(i);
    }
    if (!this._disposed) this.setData({ running: false });
  },

  async processOne(i) {
    const key = 'items[' + i + ']';
    const item = this.data.items[i];
    let fileID = '';
    let thumbFileID = '';
    try {
      // 1. 原图无损存入云存储 works/
      this.setData({ [key + '.error']: '' });
      this.setStage(i, 'uploading');
      fileID = await api.uploadWorkImage(item.tempPath,
        progress => this.uploadProgress(i, 'uploading', progress));
      this.ensurePageAlive();
      this.setData({ [key + '.fileID']: fileID });

      // 2. 生成压缩缩略图上传 thumbs/（长期保存：列表/详情展示 + AI 分析共用，不覆盖原图）
      this.setStage(i, 'compressing');
      let thumbPath = item.tempPath;
      try {
        // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
        const c = await wx.compressImage({ src: item.tempPath, quality: 20 });
        thumbPath = c.tempFilePath;
      } catch (e) { /* PNG 等格式压不了就直接用原图 */ }
      this.ensurePageAlive();
      this.setStage(i, 'thumbnail');
      thumbFileID = await api.uploadThumbImage(thumbPath,
        progress => this.uploadProgress(i, 'thumbnail', progress));
      this.ensurePageAlive();
      this.setData({ [key + '.thumbFileID']: thumbFileID });

      // 3. 安全审查 (imgSecCheck)
      // 注意：imgSecCheck 接口限制图片大小必须 <= 1MB，如果压缩后的 thumbFile 依然超过 1MB 会报错 invalid media size
      // quality: 20 不能保证所有图片均小于 1MB；沿用现有非违规错误容错策略。
      this.setStage(i, 'checking');
      const secRes = await api.imgSecCheck(thumbFileID);
      this.ensurePageAlive();
      if (!secRes.ok) {
        if (secRes.accessDenied) throw new Error(secRes.error || '账号校验失败');
        console.error('主图安全检测失败详情:', secRes);
        if (secRes.isViolated) {
          await api.deleteCloudFiles([fileID, thumbFileID]);
          throw new Error('图片包含违规内容');
        } else {
          // 非违规类错误（如 invalid media size，即图片>1M），放行不阻断主流程，避免合法大图无法上传
          console.warn('安全检测服务异常，临时放行:', secRes.error);
        }
      }

      // 4. 云函数调视觉模型打标（直接复用 thumbs/ 缩略图，云函数不再删图）
      this.setStage(i, 'analyzing');
      const result = await api.analyzeImage(thumbFileID);
      this.ensurePageAlive();
      if (!result || !result.ok) throw new Error(result && result.error || 'AI 分析失败');

      this.setData({
        [key + '.status']: 'done',
        [key + '.tags']: result.tags,
        doneCount: this.data.doneCount + 1
      });
    } catch (e) {
      if (!this._disposed) {
        this.setData({
          [key + '.status']: 'error',
          [key + '.error']: (e && e.message) || '处理失败',
          failCount: this.data.failCount + 1
        });
      }
    } finally {
      this.stopStageTimer();
      this._activeStage = null;
      // 覆盖卸载后才完成上传的文件，避免晚返回产生孤儿资源。
      if (this._disposed) await api.deleteCloudFiles([fileID, thumbFileID]).catch(console.error);
    }
  },

  async retry(e) {
    if (this.data.running) return;
    if (!await this.ensureAccess()) return;
    if (this._disposed || this.data.running) return;
    const i = Number(e.currentTarget.dataset.index);
    const old = this.data.items[i];
    if (!old || old.status !== 'error') return;
    try {
      await api.deleteCloudFiles([old.fileID, old.thumbFileID]);
      if (this._disposed) return;
      this.setData({ ['items[' + i + '].fileID']: '', ['items[' + i + '].thumbFileID']: '' });
    } catch (error) {
      if (this._disposed) return;
      wx.showToast({ title: '旧图片清理失败，请重试', icon: 'none' });
      return;
    }
    this.setData({ running: true, failCount: Math.max(0, this.data.failCount - 1) });
    this.processOne(i).then(() => {
      if (!this._disposed) this.setData({ running: false });
    });
  },

  /** 去确认标签 */
  async goConfirm() {
    if (this.data.running) return;
    if (!await this.ensureAccess()) return;
    if (this.data.running || this._disposed) return;
    const ready = this.data.items.filter(x => x.status === 'done');
    if (!ready.length) {
      wx.showToast({ title: '没有可确认的记录', icon: 'none' });
      return;
    }
    // 完成项转交确认页；失败项仍留在上传列表，供返回后重试或清空。
    getApp().globalData.pendingList = ready.map(x => ({
      fileID: x.fileID,
      thumbFileID: x.thumbFileID,
      tempPath: x.tempPath,
      tags: x.tags
    }));
    this.setData({ items: this.data.items.filter(x => x.status !== 'done'), doneCount: 0 });
    wx.navigateTo({ url: '/pages/confirm/confirm' });
  },

  clearList() {
    if (this.data.running) return;
    
    // 清理未保存的云端图片资源
    const filesToDelete = [];
    this.data.items.forEach(item => {
      if (item.fileID) filesToDelete.push(item.fileID);
      if (item.thumbFileID) filesToDelete.push(item.thumbFileID);
    });
    
    if (filesToDelete.length > 0) {
      // 异步清理，不阻塞用户操作
      api.deleteCloudFiles(filesToDelete).catch(console.error);
    }
    
    this.setData({ items: [], doneCount: 0, failCount: 0 });
  }
});
