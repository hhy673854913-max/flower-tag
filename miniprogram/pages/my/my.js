const api = require('../../utils/api');

Page({
  data: {
    total: 0,
    topColor: '-',
    topStyle: '-',
    topFlower: '-',
    lossless: true
  },

  onShow() {
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    this.loadStats();
  },

  async loadStats() {
    try {
      const records = await api.fetchAllRecords();
      const color = {}, style = {}, flower = {};
      records.forEach(r => {
        (r.colors || []).forEach(n => (color[n] = (color[n] || 0) + 1));
        if (r.style) style[r.style] = (style[r.style] || 0) + 1;
        (r.flowersMain || []).concat(r.flowersSub || []).forEach(n => (flower[n] = (flower[n] || 0) + 1));
      });
      const top = m => {
        const keys = Object.keys(m);
        if (!keys.length) return '-';
        return keys.sort((a, b) => m[b] - m[a])[0];
      };
      this.setData({
        total: records.length,
        topColor: top(color),
        topStyle: top(style),
        topFlower: top(flower)
      });
    } catch (e) { console.error(e); }
  },

  toggleLossless(e) {
    const v = e.detail.value;
    this.setData({ lossless: v });
    wx.setStorageSync('upload_lossless', v);
    wx.showToast({
      title: v ? '已切换：原图无损上传' : '已切换：省流压缩上传（有损）',
      icon: 'none'
    });
  },

  goTags() {
    wx.navigateTo({ url: '/pages/tags/tags' });
  },

  clearAll() {
    wx.showModal({
      title: '清空全部数据',
      content: '将删除所有标签记录和云端图片，不可恢复！确定继续吗？',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '清空中…' });
        try {
          const records = await api.fetchAllRecords();
          const filesToDelete = [];
          for (const r of records) {
            await api.removeRecord(r._id);
            filesToDelete.push(r.fileID, r.thumbFileID);
            (r.extraFiles || []).forEach(f => filesToDelete.push(f.fileID, f.thumbFileID));
          }
          await api.deleteCloudFiles(filesToDelete.filter(Boolean));
          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
          this.loadStats();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: '清空失败，请重试', icon: 'none' });
        }
      }
    });
  },

  about() {
    wx.showModal({
      title: '关于花艺图库',
      content: '上传作品照片，由 Kimi 视觉模型自动生成颜色 / 花材 / 种类 / 风格 / 用途五维标签，支持组合筛选。\n\n图片默认原图无损保存于你自己的微信云存储空间，标签数据仅本人可见。',
      showCancel: false
    });
  }
});
