const api = require('../../utils/api');
const onboarding = require('../../utils/onboarding');

Page({
  data: { name: '', total: 0, scope: '', publicView: false, loading: false, valid: false, error: '' },

  onLoad(query = {}) {
    this.token = query.portfolioToken || '';
    this._alive = true;
    this._seq = 0;
    this.setData({ publicView: !!this.token });
    wx.hideShareMenu();
  },
  onShow() {
    this._visible = true;
    onboarding.pageShow(this);
    onboarding.maybePresent(this);
    return this.refresh();
  },
  onHide() {
    this._visible = false;
    this._seq++;
    onboarding.pageHide(this);
    this.setData({ valid: false, loading: false });
    wx.hideShareMenu();
  },
  onUnload() { this._alive = false; this._seq++; onboarding.pageHide(this); },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()); },

  async refresh() {
    const seq = ++this._seq;
    const current = () => this._alive && this._visible && seq === this._seq;
    this.setData({ loading: true, valid: false, error: '', name: '', total: 0, scope: '' });
    wx.hideShareMenu();
    try {
      let result;
      if (this.token) {
        const portfolio = await api.readPortfolioShare(this.token, '', 1);
        result = { name: portfolio.name || '花艺师', total: portfolio.total,
          scope: portfolio.mode === 'all' ? '分享的全部作品' : '分享的精选作品' };
      } else {
        const status = await api.requireAccess();
        const total = await api.countRecords();
        const latest = await api.requireAccess();
        if (latest.uploadScope !== status.uploadScope) throw new Error('账号已变化，请重试');
        result = { name: latest.name || '花艺师', total, scope: '我的作品' };
      }
      if (!current()) return;
      this.setData(Object.assign(result, { valid: true }));
      if (this.token) wx.showShareMenu({ menus: ['shareAppMessage'] });
    } catch (error) {
      if (current()) this.setData({ error: error.message || '名片暂不可访问，请重试' });
    } finally {
      if (current()) this.setData({ loading: false });
    }
  },

  openWorks() {
    if (!this.data.valid || this.data.loading) return;
    if (this.token) wx.navigateTo({
      url: '/pages/portfolio-share/portfolio-share?portfolioToken=' + encodeURIComponent(this.token),
      fail: () => wx.showToast({ title: '作品集打开失败，请重试', icon: 'none' })
    });
    else wx.switchTab({ url: '/pages/index/index' });
  },
  editName() {
    if (!this.data.publicView && this.data.valid) wx.switchTab({ url: '/pages/my/my' });
  },
  manageShares() {
    if (!this.data.publicView && this.data.valid) wx.navigateTo({ url: '/pages/portfolio-manage/portfolio-manage' });
  },
  onShareAppMessage() {
    if (!this.token || !this.data.valid || this.data.loading) return { title: '花艺图库', path: '/pages/index/index' };
    return { title: this.data.name + '的花艺名片',
      path: '/pages/creator-card/creator-card?portfolioToken=' + encodeURIComponent(this.token) };
  }
});
