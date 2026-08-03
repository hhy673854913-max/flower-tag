const api = require('../../utils/api');

const PAGE_SIZE = 21;

Page({
  data: {
    list: [],
    loading: false,
    noMore: false,
    total: 0
  },

  onShow() {
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  async reload() {
    this.setData({ list: [], noMore: false });
    await this.loadMore();
  },

  async loadMore() {
    if (this.data.loading || this.data.noMore) return;
    this.setData({ loading: true });
    try {
      const records = await api.listRecords(this.data.list.length, PAGE_SIZE);
      // 列表展示用缩略图（旧记录没有 thumbFileID，回退原图）
      const displayID = r => r.thumbFileID || r.fileID;
      const urlMap = await api.getTempUrls(records.map(displayID));
      const rows = records.map(r => ({
        _id: r._id,
        url: urlMap[displayID(r)] || '',
        desc: this.buildDesc(r)
      }));
      const list = this.data.list.concat(rows);
      this.setData({
        list,
        total: list.length,
        noMore: records.length < PAGE_SIZE
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  buildDesc(r) {
    const parts = [];
    if (r.category) parts.push(r.category);
    if (r.flowersMain && r.flowersMain.length) parts.push(r.flowersMain[0]);
    if (r.style) parts.push(r.style);
    return parts.join(' · ');
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  }
});
