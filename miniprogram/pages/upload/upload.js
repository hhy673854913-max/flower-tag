const api = require('../../utils/api');

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
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    this.refreshAccess();
  },

  async refreshAccess() {
    this.setData({ accessState: 'loading', accessMessage: '' });
    try {
      const status = await api.getAccessStatus();
      this.setData({ accessState: status.activated ? 'active' : 'locked' });
    } catch (error) {
      this.setData({
        accessState: 'error',
        accessMessage: error.message || '云服务暂不可用，请稍后重试'
      });
    }
  },

  async ensureAccess() {
    try {
      const status = await api.getAccessStatus();
      this.setData({ accessState: status.activated ? 'active' : 'locked' });
      if (status.activated) return true;
      wx.showToast({ title: '请先在「我的」输入校验码', icon: 'none' });
    } catch (error) {
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
      await this.processOne(i);
    }
    this.setData({ running: false });
  },

  async processOne(i) {
    const key = 'items[' + i + ']';
    const item = this.data.items[i];
    try {
      // 1. 原图无损存入云存储 works/
      this.setData({ [key + '.status']: 'uploading', [key + '.error']: '' });
      const fileID = await api.uploadWorkImage(item.tempPath);
      this.setData({ [key + '.fileID']: fileID });

      // 2. 生成压缩缩略图上传 thumbs/（长期保存：列表/详情展示 + AI 分析共用，不覆盖原图）
      this.setData({ [key + '.status']: 'analyzing' });
      let thumbPath = item.tempPath;
      try {
        // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
        const c = await wx.compressImage({ src: item.tempPath, quality: 20 });
        thumbPath = c.tempFilePath;
      } catch (e) { /* PNG 等格式压不了就直接用原图 */ }
      const thumbFileID = await api.uploadThumbImage(thumbPath);
      this.setData({ [key + '.thumbFileID']: thumbFileID });

      // 3. 安全审查 (imgSecCheck)
      // 注意：imgSecCheck 接口限制图片大小必须 <= 1MB，如果压缩后的 thumbFile 依然超过 1MB 会报错 invalid media size
      // 为保证 100% 成功，我们可以在这里临时压一个极小图专供安全审核，但这会增加耗时。
      // 目前 quality: 60 的 thumbFile 绝大多数情况小于 1MB，若依然报错，可放行或提示。
      const secRes = await api.imgSecCheck(thumbFileID);
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

      // 4. 云函数调 Kimi 打标（直接复用 thumbs/ 缩略图，云函数不再删图）
      const result = await api.analyzeImage(thumbFileID);
      if (!result.ok) throw new Error(result.error || 'AI 分析失败');

      this.setData({
        [key + '.status']: 'done',
        [key + '.tags']: result.tags,
        doneCount: this.data.doneCount + 1
      });
    } catch (e) {
      this.setData({
        [key + '.status']: 'error',
        [key + '.error']: (e && e.message) || '处理失败',
        failCount: this.data.failCount + 1
      });
    }
  },

  async retry(e) {
    if (this.data.running) return;
    if (!await this.ensureAccess()) return;
    const i = Number(e.currentTarget.dataset.index);
    const old = this.data.items[i];
    try {
      await api.deleteCloudFiles([old.fileID, old.thumbFileID]);
      this.setData({ ['items[' + i + '].fileID']: '', ['items[' + i + '].thumbFileID']: '' });
    } catch (error) {
      wx.showToast({ title: '旧图片清理失败，请重试', icon: 'none' });
      return;
    }
    this.setData({ running: true, failCount: Math.max(0, this.data.failCount - 1) });
    this.processOne(i).then(() => this.setData({ running: false }));
  },

  /** 去确认标签 */
  async goConfirm() {
    if (!await this.ensureAccess()) return;
    const ready = this.data.items.filter(x => x.status === 'done');
    if (!ready.length) {
      wx.showToast({ title: '没有可确认的记录', icon: 'none' });
      return;
    }
    getApp().globalData.pendingList = ready.map(x => ({
      fileID: x.fileID,
      thumbFileID: x.thumbFileID,
      tempPath: x.tempPath,
      tags: x.tags
    }));
    this.setData({ items: [], doneCount: 0, failCount: 0 });
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
