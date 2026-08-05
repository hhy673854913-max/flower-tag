const api = require('../../utils/api');

// 注意：小程序客户端数据库 .limit() 单次上限为 20，PAGE_SIZE 不得超过 20，
// 否则第一页只返回 20 条，records.length < PAGE_SIZE 恒为 true，会误判 noMore 导致永远无法加载更多
const PAGE_SIZE = 20;

Page({
  data: {
    list: [],
    loading: false,
    noMore: false,
    total: 0 // 记录总数（云端 count），与 list.length（已加载数）配合展示
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    this.reload();
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.loading) {
      // 加载期间触底事件会被微信吞掉（已停在底部时不会重复触发），记下来事后补发
      this._reachBottomPending = true;
      return;
    }
    this.loadMore();
  },

  async reload() {
    this.setData({ list: [], noMore: false });
    // 先取总数，再加载第一页；总数失败不阻塞列表加载
    try {
      const total = await api.countRecords();
      this.setData({ total });
    } catch (e) {
      console.error('countRecords failed', e);
    }
    await this.loadMore();
  },

  async loadMore() {
    if (this.data.loading || this.data.noMore) return;
    this.setData({ loading: true });
    try {
      const records = await api.listRecords(this.data.list.length, PAGE_SIZE);
      // 列表展示用缩略图（旧记录没有 thumbFileID，回退原图）
      const displayID = r => r.thumbFileID || r.fileID;
      // 防御：个别异常记录可能连 fileID 都没有，直接调 getTempFileURL 会整批报错，
      // 先过滤出有效 fileID 再换临时链接，避免一页数据被一条坏记录拖死
      const validIDs = records.map(displayID).filter(id => !!id);
      const urlMap = await api.getTempUrls(validIDs);
      const rows = records.map(r => ({
        _id: r._id,
        url: urlMap[displayID(r)] || '',
        desc: this.buildDesc(r)
      }));
      const list = this.data.list.concat(rows);
      this.setData({
        list,
        // 总数兜底：若 count 失败或期间有新数据，至少与已加载数一致
        total: Math.max(this.data.total, list.length),
        noMore: records.length < PAGE_SIZE
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
    // 补发加载期间被吞掉的触底事件
    if (this._reachBottomPending) {
      this._reachBottomPending = false;
      this.loadMore();
    }
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
