const api = require('../../utils/api');

Page({
  data: {
    total: 0,
    topColor: '-',
    topStyle: '-',
    topFlower: '-',
    lossless: true,
    accessLoading: true,
    accessError: '',
    activated: false,
    isAdmin: false,
    role: 'other',
    name: '',
    nameInput: '',
    savingName: false,
    cleanupPending: false,
    code: '',
    redeeming: false,
    accessRecords: [],
    recordsLoading: false,
    recordsError: '',
    recordsHasMore: false,
    recordsSkip: 0,
    revokingId: '',
    revokeProgress: ''
  },
  
  _lastLoadTime: 0,

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    
    this.loadAccess();
  },

  async loadAccess() {
    this.setData({ accessLoading: true, accessError: '' });
    try {
      const status = await api.getAccessStatus();
      this.setData({
        activated: status.activated,
        isAdmin: status.isAdmin,
        role: status.role,
        name: status.name,
        nameInput: status.name,
        cleanupPending: status.cleanupPending,
        accessLoading: false
      });
      if (status.activated) {
        this.loadStatsIfNeeded();
      }
      if (status.isAdmin) this.loadAccessRecords();
    } catch (error) {
      this.setData({
        accessLoading: false,
        accessError: error.message || '暂时无法确认账号',
        activated: false,
        isAdmin: false
      });
    }
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value });
  },

  onNameInput(e) {
    this.setData({ nameInput: e.detail.value });
  },

  async saveName() {
    if (this.data.savingName) return;
    this.setData({ savingName: true });
    try {
      const result = await api.updateAccessName(this.data.nameInput);
      this.setData({ name: result.name });
      wx.showToast({ title: '名字已保存', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' });
    } finally { this.setData({ savingName: false }); }
  },

  async redeemCode() {
    if (this.data.redeeming || this.data.accessError || this.data.accessLoading) return;
    if (this.data.cleanupPending) {
      wx.showToast({ title: '旧作品清理完成后才可重新开通', icon: 'none' });
      return;
    }
    const code = this.data.code.trim();
    if (!code) {
      wx.showToast({ title: '请输入校验码', icon: 'none' });
      return;
    }
    this.setData({ redeeming: true });
    try {
      const status = await api.redeemAccessCode(code, this.data.nameInput);
      this.setData({ code: '', activated: status.activated, isAdmin: status.isAdmin,
        role: status.role, name: status.name, nameInput: status.name });
      wx.showToast({ title: '已开通，可以开始整理作品', icon: 'none' });
      this.loadStats();
      if (status.isAdmin) this.loadAccessRecords();
    } catch (error) {
      wx.showToast({ title: error.message || '校验失败', icon: 'none' });
    } finally {
      this.setData({ redeeming: false });
    }
  },

  async loadAccessRecords(append = false) {
    if (this.data.recordsLoading) return;
    this.setData({ recordsLoading: true, recordsError: '' });
    try {
      const result = await api.listAccessRecords(append ? this.data.recordsSkip : 0);
      const rows = result.records.map(item => Object.assign({}, item, {
        date: item.activatedAt ? new Date(item.activatedAt).toLocaleString() : '时间未知'
      }));
      this.setData({
        accessRecords: append ? this.data.accessRecords.concat(rows) : rows,
        recordsHasMore: result.hasMore,
        recordsSkip: result.nextSkip
      });
    } catch (error) {
      this.setData({ recordsError: error.message || '列表加载失败' });
    } finally {
      this.setData({ recordsLoading: false });
    }
  },

  refreshAccessRecords() {
    if (this.data.isAdmin && !this.data.revokingId) this.loadAccessRecords();
  },

  loadMoreFlorists() {
    if (this.data.recordsHasMore && !this.data.revokingId) this.loadAccessRecords(true);
  },

  revokeFlorist(e) {
    if (!this.data.isAdmin || this.data.revokingId || this._revokeConfirming) return;
    const item = this.data.accessRecords.find(row => row.id === e.currentTarget.dataset.id);
    if (!item) {
      wx.showToast({ title: '账号列表已变化，请刷新后重试', icon: 'none' });
      return;
    }
    this._revokeConfirming = true;
    wx.showModal({
      title: item.cleanupPending ? '继续清理作品' : '撤销花艺师权限',
      content: `将「${item.name}」降级为其他用户，并永久删除其全部作品、原图、缩略图、附加图与自定义标签。已有作品分享立即失效。确定继续吗？`,
      // 微信原生确认按钮最多 4 个字符，超长会导致弹窗调用失败。
      confirmText: item.cleanupPending ? '继续清理' : '确认撤销',
      confirmColor: '#a36759',
      success: res => { if (res.confirm) this.performRevoke(item); },
      fail: error => {
        console.error('撤销确认弹窗失败:', error);
        wx.showToast({ title: '确认窗口打开失败，请重试', icon: 'none' });
      },
      complete: () => { this._revokeConfirming = false; }
    });
  },

  async performRevoke(item) {
    if (!this.data.isAdmin || this.data.revokingId) return;
    this.setData({ revokingId: item.id, revokeProgress: '正在撤销权限并清理作品…' });
    let deleted = 0;
    try {
      let result = item.cleanupPending ? await api.cleanupFlorist(item.id) : await api.revokeFlorist(item.id);
      deleted += result.deleted || 0;
      while (result.hasMore) {
        this.setData({ revokeProgress: `已清理 ${deleted} 件作品，正在继续…` });
        result = await api.cleanupFlorist(item.id);
        deleted += result.deleted || 0;
      }
      getApp().globalData.dbUpdateTime = Date.now();
      wx.showToast({ title: '权限已撤销，作品已清理', icon: 'none' });
    } catch (error) {
      wx.showModal({
        title: '操作未完成',
        content: (error.message || '服务暂不可用') + '。请刷新列表确认账号状态；显示“作品待清理”时，权限已关闭，可继续清理。',
        showCancel: false,
        fail: () => wx.showToast({ title: '操作未完成，请刷新列表查看', icon: 'none' })
      });
    } finally {
      this.setData({ revokingId: '', revokeProgress: '' });
      this.loadAccessRecords();
    }
  },

  loadStatsIfNeeded() {
    const app = getApp();
    if (!this._lastLoadTime || this._lastLoadTime < (app.globalData.dbUpdateTime || 0)) {
      this.loadStats();
    }
  },

  async loadStats() {
    this._lastLoadTime = Date.now();
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
    if (!this.data.activated) return;
    wx.navigateTo({ url: '/pages/tags/tags' });
  },

  clearAll() {
    if (!this.data.activated) return;
    wx.showModal({
      title: '清空全部数据',
      content: '将删除所有标签记录和云端图片，不可恢复！确定继续吗？',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm) return;
        wx.showLoading({ title: '清空中…' });
        try {
          const records = await api.fetchAllRecords();
          for (const r of records) {
            await api.removeRecord(r._id);
          }
          getApp().globalData.dbUpdateTime = Date.now();
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
