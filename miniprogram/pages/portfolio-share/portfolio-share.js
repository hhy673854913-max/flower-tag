const api = require('../../utils/api');
const onboarding = require('../../utils/onboarding');

function readMetadataText(value, limit, singleLine) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (Array.from(text).length > limit || (singleLine && /[\r\n\u2028\u2029]/.test(text))) return '';
  return text;
}

Page({
  data: {
    name: '花艺师',
    title: '',
    description: '',
    mode: '',
    total: 0,
    records: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    valid: false,
    loadError: '',
    pageError: '',
    invalid: false
  },

  onLoad(query) {
    this.token = query.portfolioToken || '';
    this._seq = 0;
    this._alive = true;
    wx.hideShareMenu();
    this.refresh();
  },

  onShow() {
    onboarding.pageShow(this);
    onboarding.maybePresent(this);
    if (this._shown) this.refresh();
    this._shown = true;
  },

  onHide() {
    this._seq++;
    onboarding.pageHide(this);
    this.setData({ valid: false, loading: false, loadingMore: false });
    wx.hideShareMenu();
  },

  onUnload() {
    this._alive = false;
    this._seq++;
    onboarding.pageHide(this);
  },

  onPullDownRefresh() {
    return this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    this.loadMore();
  },

  isCurrent(seq) {
    return this._alive && seq === this._seq;
  },

  isInvalid(error) {
    const message = error && (error.message || error.code) || '';
    if (/游标|cursor/i.test(message)) return false;
    return /失效|停止分享|取消分享|撤销|清理中|不存在|无权|无效|不在.*范围|已删除|invalid|expired|denied/i.test(message);
  },

  clearInvalid() {
    this.cursor = '';
    this.setData({
      name: '花艺师', title: '', description: '', mode: '', total: 0, records: [], hasMore: false,
      valid: false, invalid: true, pageError: '', loadError: '作品集链接已失效或不可访问'
    });
    wx.hideShareMenu();
  },

  async refresh() {
    const seq = ++this._seq;
    this.setData({ loading: true, loadingMore: false, valid: false, loadError: '', pageError: '' });
    wx.hideShareMenu();
    if (!this.token) {
      this.clearInvalid();
      this.setData({ loading: false });
      return;
    }
    try {
      const result = await api.readPortfolioShare(this.token, '', 20);
      if (!this.isCurrent(seq)) return;
      this.applyPage(result, false);
    } catch (error) {
      if (!this.isCurrent(seq)) return;
      if (this.isInvalid(error)) this.clearInvalid();
      else this.setData({ loadError: '暂时无法确认作品集状态，请重试', valid: false });
    } finally {
      if (this.isCurrent(seq)) this.setData({ loading: false });
    }
  },

  applyPage(result, append) {
    const seen = new Set();
    const records = (append ? this.data.records : []).concat(result.records || []).filter(record => {
      if (!record._id || seen.has(record._id)) return false;
      seen.add(record._id);
      return true;
    }).map(record => Object.assign({}, record, {
      imageFailed: !!record.imageFailed,
      caption: [record.category, record.style].filter(Boolean).join(' · ') || '花艺作品'
    }));
    this.cursor = result.nextCursor || '';
    this.setData({
      name: result.name || '花艺师', mode: result.mode, total: result.total,
      title: readMetadataText(result.title, 40, true),
      description: readMetadataText(result.description, 300, false),
      records, hasMore: !!result.hasMore && !!this.cursor, valid: true,
      invalid: false, loadError: '', pageError: ''
    });
    wx.showShareMenu({ menus: ['shareAppMessage'] });
  },

  async loadMore() {
    if (!this.data.valid || this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    const seq = this._seq;
    const cursor = this.cursor;
    this.setData({ loadingMore: true, pageError: '' });
    try {
      const result = await api.readPortfolioShare(this.token, cursor, 20);
      if (!this.isCurrent(seq)) return;
      this.applyPage(result, true);
      if (result.hasMore && result.nextCursor === cursor) {
        this.setData({ hasMore: false, pageError: '分页状态已变化，请刷新作品集' });
      }
    } catch (error) {
      if (!this.isCurrent(seq)) return;
      if (this.isInvalid(error)) this.clearInvalid();
      else if (/游标|cursor/i.test(error.message || '')) {
        this.setData({ hasMore: false, pageError: '分页状态已变化，点击刷新' });
      } else {
        this.setData({ pageError: '暂时无法确认作品集状态，点击重试', valid: false });
        wx.hideShareMenu();
      }
    } finally {
      if (this.isCurrent(seq)) this.setData({ loadingMore: false });
    }
  },

  retryPage() {
    return this.data.valid && this.data.hasMore ? this.loadMore() : this.refresh();
  },

  onImageError(e) {
    if (!this._alive) return;
    const id = e.currentTarget.dataset.id;
    const index = this.data.records.findIndex(record => record._id === id && record.thumbnailUrl === e.currentTarget.dataset.url);
    if (index < 0) return;
    this.setData({ ['records[' + index + '].imageFailed']: true });
  },

  openRecord(e) {
    if (!this.data.valid || this.data.loading) return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.records.some(record => record._id === id)) return;
    wx.navigateTo({
      url: '/pages/detail/detail?portfolioToken=' + encodeURIComponent(this.token) + '&id=' + encodeURIComponent(id)
    });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  openCreator() {
    if (!this.data.valid || this.data.loading || !this.token) return;
    wx.navigateTo({
      url: '/pages/creator-card/creator-card?portfolioToken=' + encodeURIComponent(this.token),
      fail: () => wx.showToast({ title: '名片打开失败，请重试', icon: 'none' })
    });
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ fail: () => this.goHome() });
    else this.goHome();
  },

  onShareAppMessage() {
    if (!this.data.valid || this.data.loading || this.data.invalid) {
      return { title: '花艺图库', path: '/pages/index/index' };
    }
    const first = this.data.records[0];
    const card = {
      title: this.data.title || this.data.name + '的花艺作品集',
      path: '/pages/portfolio-share/portfolio-share?portfolioToken=' + encodeURIComponent(this.token)
    };
    if (first && first.thumbnailUrl && !first.imageFailed) card.imageUrl = first.thumbnailUrl;
    return card;
  }
});
