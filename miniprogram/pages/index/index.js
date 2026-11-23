const api = require('../../utils/api');
const onboarding = require('../../utils/onboarding');
const DATA_TTL = 10 * 60 * 1000;
const URL_TTL = 8 * 60 * 1000;

Page({
  data: {
    list: [], loading: true, refreshing: false, checking: false, error: '',
    noMore: false, total: 0, countReady: false, countLoading: false, countError: '',
    initialized: false, allowed: false, skeleton: [0, 1, 2, 3]
  },
  _lastLoadTime: 0,
  current(epoch) { return this._visible && epoch === this._epoch; },
  validCache() {
    return this._lastLoadTime && Date.now() - this._lastLoadTime < DATA_TTL
      && this._dirty === (getApp().globalData.dbUpdateTime || 0);
  },
  applyStatus(status) {
    const identity = [getApp().globalData.envId, status.uploadScope, status.role, status.cleanupPending].join(':');
    const allowed = !!(status.activated || status.isAdmin) && !status.cleanupPending;
    if (identity !== this._identity || !allowed) this.clearContent();
    this._identity = identity;
    this._allowed = allowed;
    this.setData({ allowed });
    return allowed;
  },
  clearContent() {
    this._lastLoadTime = 0;
    this._nextSkip = 0;
    this._countSeq = (this._countSeq || 0) + 1;
    this.setData({ list: [], total: 0, countReady: false, countLoading: false, countError: '', noMore: false });
  },
  async onShow() {
    onboarding.pageShow(this);
    this._visible = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this._allowed = false;
    this.setData({ allowed: false, checking: true, error: '' });
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setData({ selected: 0 });
    if (!this.validCache()) return this.reload();
    const ticket = onboarding.capture(this);
    try {
      const status = await api.getAccessStatus();
      if (!this.current(epoch)) return;
      const allowed = this.applyStatus(status);
      onboarding.present(this, status, ticket);
      if (!allowed) return;
      if (!this.validCache()) return this.reload();
      if (Date.now() - (this._urlTime || 0) >= URL_TTL) await this.refreshImages(epoch);
    } catch (error) {
      if (!this.current(epoch)) return;
      this.failIdentity(error);
    } finally {
      if (this.current(epoch)) this.setData({ checking: false, loading: false });
    }
  },
  failIdentity(error) {
    this._allowed = false;
    this.clearContent();
    this.setData({ allowed: false, initialized: false, error: error.message || '账号检查失败' });
  },
  onHide() {
    onboarding.pageHide(this);
    this._visible = false;
    this._allowed = false;
    this._epoch = (this._epoch || 0) + 1;
    this._countSeq = (this._countSeq || 0) + 1;
    this.setData({ allowed: false, loading: false, refreshing: false, checking: false, countLoading: false });
  },
  onUnload() { this.onHide(); this.clearContent(); },
  onWelcomeActivate() {},
  async onPullDownRefresh() {
    api.invalidate();
    try { await this.reload(); } finally { wx.stopPullDownRefresh(); }
  },
  async reload() {
    if (!this._visible) return;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this._allowed = false;
    this._lastLoadTime = 0;
    this._countSeq = (this._countSeq || 0) + 1;
    const ticket = onboarding.capture(this);
    this.setData({ allowed: false, loading: !this.data.list.length, refreshing: !!this.data.list.length,
      checking: true, error: '', countReady: false, countError: '', countLoading: false });
    try {
      const page = await api.getRecordPage({ skip: 0, limit: 20 });
      if (!this.current(epoch)) return;
      const allowed = this.applyStatus(page.status);
      onboarding.present(this, page.status, ticket);
      if (!allowed) {
        this.setData({ initialized: true, noMore: true });
        return;
      }
      this._nextSkip = page.nextSkip;
      this._dirty = getApp().globalData.dbUpdateTime || 0;
      this._lastLoadTime = Date.now();
      this._urlTime = Date.now();
      this.setData({ list: this.rows(page), noMore: !page.hasMore, initialized: true });
      this.retryCount();
    } catch (error) {
      if (this.current(epoch)) this.failIdentity(error);
    } finally {
      if (this.current(epoch)) this.setData({ loading: false, refreshing: false, checking: false });
    }
  },
  rows(page) {
    const seen = new Set();
    return page.records.filter(r => r._id && !seen.has(r._id) && seen.add(r._id)).map(r => {
      const fileID = r.thumbFileID || r.fileID || '';
      const url = page.urls[fileID] || '';
      return { _id: r._id, fileID, url, desc: this.buildDesc(r), imageLoading: !!url, imageFailed: !url };
    });
  },
  async retryCount() {
    if (!this._visible || !this._allowed || this.data.countLoading) return;
    const epoch = this._epoch;
    const seq = this._countSeq = (this._countSeq || 0) + 1;
    this.setData({ countLoading: true, countError: '' });
    try {
      const total = await api.countRecords();
      if (this.current(epoch) && seq === this._countSeq) this.setData({ total, countReady: true });
    } catch (error) {
      if (this.current(epoch) && seq === this._countSeq) this.setData({ countError: '总数获取失败，点击重试' });
    } finally {
      if (this.current(epoch) && seq === this._countSeq) this.setData({ countLoading: false });
    }
  },
  onReachBottom() { if (!this.data.error) return this.loadMore(); },
  async loadMore() {
    if (!this._allowed || !this._visible || this.data.loading || this.data.checking
      || this.data.refreshing || this.data.noMore) return;
    if (!this.validCache()) { api.invalidate(); return this.reload(); }
    const epoch = this._epoch;
    const identity = this._identity;
    const ticket = onboarding.capture(this);
    this.setData({ loading: true, error: '' });
    try {
      const page = await api.getRecordPage({ skip: this._nextSkip, limit: 20 });
      if (!this.current(epoch)) return;
      if (!this.applyStatus(page.status) || identity !== this._identity) {
        this._allowed = false;
        this.setData({ allowed: false, error: '账号状态已变化，请刷新' });
        return;
      }
      onboarding.present(this, page.status, ticket);
      const seen = new Set(this.data.list.map(r => r._id));
      this.setData({ list: this.data.list.concat(this.rows(page).filter(r => !seen.has(r._id))),
        noMore: !page.hasMore });
      this._nextSkip = page.nextSkip;
      this._dirty = getApp().globalData.dbUpdateTime || 0;
    } catch (error) {
      if (!this.current(epoch)) return;
      if (error.staleSession) this.failIdentity(error);
      else {
        // A failed read also invalidates API caches, but retry must keep this server cursor.
        this._dirty = getApp().globalData.dbUpdateTime || 0;
        this.setData({ error: '加载失败，点击重试' });
      }
    } finally {
      if (this.current(epoch)) this.setData({ loading: false });
    }
  },
  retryLoad() { return this.data.list.length && this._allowed ? this.loadMore() : this.onPullDownRefresh(); },
  async refreshImages(epoch = this._epoch, force = false, id = '') {
    const rows = this.data.list.filter(r => r.fileID && (!id || r._id === id));
    if (!this._allowed || !this.current(epoch) || !rows.length) return;
    const seq = this._imageSeq = (this._imageSeq || 0) + 1;
    this.setData({ list: this.data.list.map(r => rows.some(v => v._id === r._id)
      ? Object.assign({}, r, { imageLoading: true, imageFailed: false }) : r) });
    try {
      const urls = await api.getTempUrls(rows.map(r => r.fileID),
        { force, recordIDs: rows.map(r => r._id) });
      if (!this.current(epoch) || seq !== this._imageSeq) return;
      if (!id) this._urlTime = Date.now();
      this.setData({ list: this.data.list.map(r => rows.some(v => v._id === r._id)
        ? Object.assign({}, r, { url: urls[r.fileID] || '', imageLoading: !!urls[r.fileID], imageFailed: !urls[r.fileID] }) : r) });
    } catch (error) {
      if (!this.current(epoch) || seq !== this._imageSeq) return;
      if (error.staleSession) this.failIdentity(error);
      else this.setData({ list: this.data.list.map(r => rows.some(v => v._id === r._id)
        ? Object.assign({}, r, { imageLoading: false, imageFailed: true }) : r) });
    }
  },
  imageLoad(e) { this.imageState(e, false); },
  imageError(e) { this.imageState(e, true); },
  imageState(e, failed) {
    if (!this._visible) return;
    const { id, url } = e.currentTarget.dataset;
    const index = this.data.list.findIndex(r => r._id === id && r.url === url);
    if (index < 0) return;
    // 定向更新单张图片状态；整表 setData 会让每次图片回调的开销随列表长度线性放大。
    this.setData({ ['list[' + index + '].imageLoading']: false, ['list[' + index + '].imageFailed']: failed });
  },
  retryImage(e) { return this.refreshImages(this._epoch, true, e.currentTarget.dataset.id); },
  buildDesc(r) {
    return [r.category, (r.flowersMain || [])[0], r.style].filter(Boolean).join(' · ');
  },
  goDetail(e) {
    if (!this._visible || !this._allowed || this.data.checking || this.data.refreshing) return;
    const id = e.currentTarget.dataset.id;
    if (this.data.list.some(r => r._id === id)) wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(id) });
  }
});
