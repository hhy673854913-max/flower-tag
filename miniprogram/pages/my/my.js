const api = require('../../utils/api');
const uploadFlow = require('../../utils/upload-flow');
const onboarding = require('../../utils/onboarding');

Page({
  data: {
    total: 0,
    topColor: '-',
    topStyle: '-',
    topFlower: '-',
    statsError: '',
    statsLoading: false,
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
    onboarding.pageShow(this);
    this._visible = true;
    this._activationPending = onboarding.takeActivation(this) || false;
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 });
    }
    const v = wx.getStorageSync('upload_lossless');
    this.setData({ lossless: v === '' ? true : !!v });
    
    return this.loadAccess();
  },

  onHide() {
    onboarding.pageHide(this);
    this._activationPending = false;
    this._accessReady = false;
    this._visible = false;
    this._accessSeq = (this._accessSeq || 0) + 1;
    this._statsSeq = (this._statsSeq || 0) + 1;
    this._recordsSeq = (this._recordsSeq || 0) + 1;
    if (this.data.statsLoading) this._lastLoadTime = 0;
    this.setData({ statsLoading: false, recordsLoading: false, savingName: false, redeeming: false });
  },
  onUnload() { this.onHide(); },
  onWelcomeActivate() {
    this._activationPending = onboarding.takeActivation(this) || this._activationPending;
    this.scrollActivation();
  },
  scrollActivation() {
    if (!this._visible || !this._accessReady || !this._activationPending || this.data.accessError
      || this.data.activated || this.data.isAdmin) return;
    this._activationPending = false;
    const seq = this._accessSeq;
    this.setData({}, () => {
      if (this._visible && this._accessReady && seq === this._accessSeq) {
        wx.pageScrollTo({ selector: '#activation-area', duration: 200 });
      }
    });
  },
  async onPullDownRefresh() {
    api.invalidate();
    this._statsSeq = (this._statsSeq || 0) + 1;
    this._recordsSeq = (this._recordsSeq || 0) + 1;
    this.setData({ statsLoading: false, recordsLoading: false });
    this._lastLoadTime = 0;
    try { await this.loadAccess(); } finally { wx.stopPullDownRefresh(); }
  },
  privateReady() {
    return this._visible && this._accessReady && !this.data.accessLoading && !this.data.accessError
      && !this.data.cleanupPending && (this.data.activated || this.data.isAdmin);
  },

  clearPrivateData() {
    this._statsSeq = (this._statsSeq || 0) + 1;
    this._recordsSeq = (this._recordsSeq || 0) + 1;
    this._lastLoadTime = 0;
    this.setData({ total: 0, topColor: '-', topStyle: '-', topFlower: '-', statsError: '', statsLoading: false,
      accessRecords: [], recordsSkip: 0, recordsHasMore: false, recordsLoading: false, recordsError: '', name: '', nameInput: '', code: '' });
  },

  async loadAccess() {
    const seq = this._accessSeq = (this._accessSeq || 0) + 1;
    this._accessReady = false;
    this.setData({ accessLoading: true, accessError: '' });
    const ticket = onboarding.capture(this);
    try {
      const status = await api.getAccessStatus();
      if (seq !== this._accessSeq || this._visible === false) return;
      const identity = [getApp().globalData.envId, status.uploadScope, status.role, status.cleanupPending].join(':');
      if (identity !== this._identity) { this.clearPrivateData(); this._identity = identity; }
      if (!(status.activated || status.isAdmin) || status.cleanupPending) this.clearPrivateData();
      this._accessReady = true;
      this.setData({
        activated: status.activated,
        isAdmin: status.isAdmin,
        role: status.role,
        name: status.name,
        nameInput: status.name,
        cleanupPending: status.cleanupPending,
        accessLoading: false
      });
      onboarding.present(this, status, ticket);
      this.scrollActivation();
      if ((status.activated || status.isAdmin) && !status.cleanupPending) {
        this.loadStatsIfNeeded();
      }
      if (status.isAdmin && !status.cleanupPending) this.loadAccessRecords();
    } catch (error) {
      if (seq !== this._accessSeq || this._visible === false) return;
      this.clearPrivateData();
      this._identity = '';
      this._accessReady = false;
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
    if (!this.privateReady() || this.data.savingName) return;
    const seq = this._accessSeq;
    this.setData({ savingName: true });
    try {
      const result = await api.updateAccessName(this.data.nameInput);
      if (!this._visible || seq !== this._accessSeq) return;
      this.setData({ name: result.name });
      wx.showToast({ title: '名字已保存', icon: 'success' });
    } catch (error) {
      if (this._visible && seq === this._accessSeq) wx.showToast({ title: error.message, icon: 'none' });
    } finally { if (this._visible && seq === this._accessSeq) this.setData({ savingName: false }); }
  },

  async redeemCode() {
    if (!this._visible || !this._accessReady || this.data.redeeming || this.data.accessError || this.data.accessLoading) return;
    const seq = this._accessSeq;
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
      const ticket = onboarding.capture(this);
      const status = await api.redeemAccessCode(code, this.data.nameInput);
      if (!this._visible || seq !== this._accessSeq) return;
      onboarding.present(this, status, ticket);
      this.setData({ code: '' });
      wx.showToast({ title: '已开通，可以开始整理作品', icon: 'none' });
      await this.loadAccess();
    } catch (error) {
      if (this._visible && seq === this._accessSeq) wx.showToast({ title: error.message || '校验失败', icon: 'none' });
    } finally {
      if (this._visible) this.setData({ redeeming: false });
    }
  },

  async loadAccessRecords(append = false) {
    if (!this.privateReady() || !this.data.isAdmin || this.data.recordsLoading) return;
    const seq = this._recordsSeq = (this._recordsSeq || 0) + 1;
    this.setData({ recordsLoading: true, recordsError: '' });
    try {
      const result = await api.listAccessRecords(append ? this.data.recordsSkip : 0);
      if (seq !== this._recordsSeq || this._visible === false || !this.data.isAdmin) return;
      const rows = result.records.map(item => Object.assign({}, item, {
        date: item.activatedAt ? new Date(item.activatedAt).toLocaleString() : '时间未知'
      }));
      const seen = new Set();
      this.setData({
        accessRecords: (append ? this.data.accessRecords.concat(rows) : rows).filter(r => !seen.has(r.id) && seen.add(r.id)),
        recordsHasMore: result.hasMore,
        recordsSkip: result.nextSkip
      });
    } catch (error) {
      if (seq !== this._recordsSeq || this._visible === false) return;
      this.setData({ recordsError: error.message || '列表加载失败' });
    } finally {
      if (seq === this._recordsSeq && this._visible !== false) this.setData({ recordsLoading: false });
    }
  },

  refreshAccessRecords() {
    if (this.data.isAdmin && !this.data.revokingId) return this.loadAccessRecords();
  },

  loadMoreFlorists() {
    if (this.data.recordsHasMore && !this.data.revokingId) return this.loadAccessRecords(true);
  },
  retryAccessRecords() { return this.loadAccessRecords(!!this.data.accessRecords.length); },

  revokeFlorist(e) {
    if (!this.privateReady() || !this.data.isAdmin || this.data.revokingId || this._revokeConfirming) return;
    const item = this.data.accessRecords.find(row => row.id === e.currentTarget.dataset.id);
    if (!item) {
      wx.showToast({ title: '账号列表已变化，请刷新后重试', icon: 'none' });
      return;
    }
    this._revokeConfirming = true;
    wx.showModal({
      title: item.cleanupPending ? '继续清理作品' : '撤销花艺师权限',
      content: `将「${item.name}」降级为其他用户，并永久删除其全部作品、原图、缩略图、附加图与自定义标签。已有单件分享及作品集链接立即失效，重新开通也不会恢复旧作品集链接；已下载图片或仍有效的临时图片链接无法追溯收回。确定继续吗？`,
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
    if (!this.privateReady() || !this.data.isAdmin || this.data.revokingId) return;
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
      api.invalidate();
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
    if (!this._lastLoadTime || this._statsDirty !== (app.globalData.dbUpdateTime || 0)
      || Date.now() - this._lastLoadTime >= 10 * 60 * 1000) {
      this.loadStats();
    }
  },

  async loadStats() {
    if (!this.privateReady() || this.data.statsLoading) return;
    const seq = this._statsSeq = (this._statsSeq || 0) + 1;
    const started = Date.now();
    this._lastLoadTime = 0;
    this.setData({ statsLoading: true, statsError: '' });
    try {
      const records = await api.fetchAllRecords();
      if (seq !== this._statsSeq || this._visible === false) return;
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
      this._lastLoadTime = started;
      this._statsDirty = getApp().globalData.dbUpdateTime || 0;
    } catch (e) {
      if (seq === this._statsSeq && this._visible !== false) this.setData({
        total: 0, topColor: '-', topStyle: '-', topFlower: '-', statsError: '统计加载失败，点击重试'
      });
    } finally {
      if (seq === this._statsSeq && this._visible !== false) this.setData({ statsLoading: false });
    }
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
    if (!this.privateReady()) return;
    wx.navigateTo({ url: '/pages/tags/tags' });
  },

  goPortfolio() {
    if (!this.privateReady() || this.data.accessLoading || this.data.accessError || this.data.cleanupPending
      || !(this.data.activated || this.data.isAdmin) || this._portfolioOpening) return;
    this._portfolioOpening = true;
    wx.navigateTo({
      url: '/pages/portfolio-manage/portfolio-manage',
      fail: () => wx.showToast({ title: '作品集页面打开失败，请重试', icon: 'none' }),
      complete: () => { this._portfolioOpening = false; }
    });
  },

  goCard() {
    if (!this.privateReady() || this.data.accessLoading || this.data.accessError || this.data.cleanupPending
      || !(this.data.activated || this.data.isAdmin)) return;
    this.openPublicPage('/pages/creator-card/creator-card', '名片');
  },

  clearAll() {
    if (!this.privateReady() || this._clearingAll) return;
    wx.showModal({
      title: '清空全部数据',
      content: '将放弃未保存图片并删除全部本人作品及云端图片，保留自定义词条与反馈。不可恢复，确定继续吗？',
      confirmText: '确认清空',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm || !this.privateReady() || this._clearingAll) return;
        this._clearingAll = true;
        wx.showLoading({ title: '清空中…' });
        try {
          await uploadFlow.cancelAll();
          let sessions = await api.closeOwnUploadSessions();
          while (sessions.hasMore) sessions = await api.closeOwnUploadSessions(sessions.nextCursor);
          const records = await api.fetchAllRecords({ includeDeleting: true });
          for (const r of records) {
            await api.removeRecord(r._id);
          }
          api.invalidate();
          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
          this.loadStats();
        } catch (e) {
          wx.hideLoading();
          wx.showToast({ title: e.message || '清空未完成，请重试', icon: 'none' });
        } finally { this._clearingAll = false; }
      }
    });
  },

  goFeedback() {
    this.openPublicPage('/pages/feedback/feedback', '反馈');
  },

  about() {
    this.openPublicPage('/pages/about/about', '关于');
  },

  openPublicPage(url, label) {
    if (this._publicPageOpening) return;
    this._publicPageOpening = true;
    wx.navigateTo({
      url,
      fail: () => wx.showToast({ title: `${label}页面打开失败，请重试`, icon: 'none' }),
      complete: () => { this._publicPageOpening = false; }
    });
  }
});
