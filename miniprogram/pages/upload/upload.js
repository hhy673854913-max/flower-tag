const api = require('../../utils/api');

Page({
  data: {
    items: [],        // { tempPath, status, error, fileID, tags }
    running: false,
    lossless: true,   // 默认原图无损上传
    doneCount: 0,
    failCount: 0
  },

  onShow() {
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
  },

  /** 选图（相册 / 拍照） */
  async choose(e) {
    if (this.data.running) return;
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
        const c = await wx.compressImage({ src: item.tempPath, quality: 60 });
        thumbPath = c.tempFilePath;
      } catch (e) { /* PNG 等格式压不了就直接用原图 */ }
      const thumbFileID = await api.uploadThumbImage(thumbPath);
      this.setData({ [key + '.thumbFileID']: thumbFileID });

      // 3. 云函数调 Kimi 打标（直接复用 thumbs/ 缩略图，云函数不再删图）
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

  retry(e) {
    if (this.data.running) return;
    const i = Number(e.currentTarget.dataset.index);
    this.setData({ running: true, failCount: Math.max(0, this.data.failCount - 1) });
    this.processOne(i).then(() => this.setData({ running: false }));
  },

  /** 去确认标签 */
  goConfirm() {
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
    this.setData({ items: [], doneCount: 0, failCount: 0 });
  }
});
