const api = require('../../utils/api');
const PAGE_SIZE = 20;
const MAX_SELECTED = 1000;
const MAX_SELECTION_BYTES = 128 * 1024;

function metadataError(title, description) {
  const length = Array.from(title.trim()).length;
  if (!length) return '请填写作品集标题';
  if (/[\r\n\u2028\u2029]/.test(title.trim())) return '标题请使用单行文字';
  if (length > 40) return '标题最多 40 字，请减少文字后保存';
  if (Array.from(description.trim()).length > 300) return '描述最多 300 字，请减少文字后保存';
  return '';
}

function metadataFields(row) {
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const description = typeof row.description === 'string' ? row.description.trim() : '';
  return {
    title: title && !metadataError(title, '') ? title : '',
    description: Array.from(description).length <= 300 ? description : ''
  };
}

function selectionError(ids) {
  if (ids.length > MAX_SELECTED) return '最多选择 1000 件作品，请减少选择';
  const json = JSON.stringify(ids);
  let bytes = 0;
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes > MAX_SELECTION_BYTES ? '所选作品 ID 超过 128 KiB，请减少选择' : '';
}

function confirm(options) {
  return new Promise((resolve, reject) => wx.showModal(Object.assign({
    confirmColor: '#2d6543',
    success: result => resolve(result.confirm),
    fail: () => reject(new Error('确认窗口打开失败，请重试'))
  }, options)));
}

function dateLabel(value) {
  const date = new Date(value);
  if (!value || isNaN(date.getTime())) return '时间未知';
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

Page({
  data: {
    accessLoading: true, accessError: '', canManage: false, cleanupPending: false,
    name: '', selecting: false, selectedCount: 0,
    works: [], worksSkip: 0, worksHasMore: true, worksLoading: false, worksError: '',
    links: [], linksCursor: '', linksHasMore: false, linksLoading: false, linksError: '',
    busy: false, creating: '', stoppingId: '', openingId: '',
    editingId: '', editTitle: '', editDescription: '', titleCount: 0, descriptionCount: 0,
    editError: '', savingMetadata: false
  },

  onLoad() {
    this._epoch = 0;
    this._linksSeq = 0;
    this._worksSeq = 0;
    this._selected = new Set();
    this._imageSeq = {};
    this._identity = '';
    this._editSeq = 0;
    this._drafts = new Map();
    this._metadataRevision = 0;
    this._metadataUpdates = new Map();
  },

  onShow() {
    this._visible = true;
    this.setData({ busy: false, creating: '', stoppingId: '', openingId: '', savingMetadata: false });
    return this.refreshAccess();
  },

  onHide() { this._visible = false; this._epoch++; this._editSeq++; },
  onUnload() {
    this.onHide();
    this._drafts.clear();
    this._metadataUpdates.clear();
  },
  current(epoch) { return this._visible && epoch === this._epoch; },

  applyStatus(status) {
    const allowed = !!(status.activated || status.isAdmin) && !status.cleanupPending
      && status.canShare !== false;
    const identity = allowed ? status.filePrefix || status.role : '';
    if (!allowed || (this._identity && this._identity !== identity)) {
      this._linksSeq++;
      this._worksSeq++;
      this._selected.clear();
      this._imageSeq = {};
      this.clearEditor(true);
      this._metadataUpdates.clear();
      this.setData({
        works: [], worksSkip: 0, worksHasMore: true, selectedCount: 0, selecting: false,
        links: [], linksCursor: '', linksHasMore: false, linksLoading: false, worksLoading: false
      });
    }
    this._identity = identity;
    this.setData({
      canManage: allowed, cleanupPending: !!status.cleanupPending,
      name: status.name || '花艺师', accessError: ''
    });
    return allowed;
  },

  async refreshAccess() {
    if (this.data.busy && this._visible) return;
    const epoch = ++this._epoch;
    this.setData({
      accessLoading: true, accessError: '', canManage: false,
      worksLoading: false, linksLoading: false, busy: false,
      creating: '', stoppingId: '', openingId: ''
    });
    try {
      const status = await api.getAccessStatus();
      if (!this.current(epoch)) return;
      if (!this.applyStatus(status)) return;
      await Promise.all([this.loadLinks(false), this.data.selecting ? this.loadWorks(false) : Promise.resolve()]);
    } catch (error) {
      if (this.current(epoch)) this.setData({ accessError: error.message || '暂时无法确认账号', canManage: false });
    } finally {
      if (this.current(epoch)) this.setData({ accessLoading: false });
    }
  },

  async onPullDownRefresh() {
    try { await this.refreshAccess(); } finally { wx.stopPullDownRefresh(); }
  },

  onReachBottom() {
    if (this.data.selecting) this.loadMoreWorks();
    else this.loadMoreLinks();
  },

  async checkAccess(epoch) {
    const identity = this._identity;
    const status = await api.getAccessStatus();
    if (!this.current(epoch)) return false;
    const allowed = this.applyStatus(status);
    if (!allowed) throw new Error('账号未开通或已失效，请前往「我的」查看');
    if (identity && identity !== this._identity) throw new Error('账号状态已变化，请重新选择作品');
    return true;
  },

  async reconcileAccess(epoch) {
    try { await this.checkAccess(epoch); }
    catch (error) {
      if (this.current(epoch) && this.data.canManage) {
        this.setData({ canManage: false, accessError: error.message || '暂时无法确认账号' });
      }
    }
  },

  async loadLinks(append = false) {
    if (!this.data.canManage || this.data.linksLoading || (append && !this.data.linksHasMore)) return;
    const epoch = this._epoch;
    const seq = ++this._linksSeq;
    const metadataRevision = this._metadataRevision;
    const cursor = append ? this.data.linksCursor : '';
    this.setData({ linksLoading: true, linksError: '' });
    try {
      const result = await api.listPortfolioShares(cursor);
      if (!this.current(epoch) || seq !== this._linksSeq) return;
      if (result.hasMore && (!result.nextCursor || result.nextCursor === cursor)) {
        throw new Error('链接分页异常，请刷新重试');
      }
      const rows = result.records.map(row => {
        const saved = this._metadataUpdates.get(row.id);
        // 保存前已发出的分页只能更新列表结构，不能回退刚保存的文本。
        const fields = saved && saved.revision > metadataRevision ? saved.fields : metadataFields(row);
        const modeLabel = row.mode === 'all' ? '全部作品' : '精选作品';
        return Object.assign({}, row, fields, {
          date: dateLabel(row.createdAt), modeLabel, displayTitle: fields.title || modeLabel
        });
      });
      const links = append ? this.data.links.concat(rows) : rows;
      const seen = new Set();
      this.setData({
        links: links.filter(row => !seen.has(row.id) && seen.add(row.id)),
        linksCursor: result.nextCursor || '', linksHasMore: !!result.hasMore
      });
      for (const row of rows) {
        if (!row.enabled || !row.token) {
          this._drafts.delete(row.id);
          if (this.data.editingId === row.id) this.clearEditor();
        }
      }
      if (this.data.editingId && !this.data.links.some(row => row.id === this.data.editingId)) {
        this.clearEditor(false, true);
      }
    } catch (error) {
      if (!this.current(epoch) || seq !== this._linksSeq) return;
      this.setData({ linksError: error.message || '链接加载失败，请重试' });
      await this.reconcileAccess(epoch);
    } finally {
      if (this.current(epoch) && seq === this._linksSeq) this.setData({ linksLoading: false });
    }
  },

  loadMoreLinks() { if (!this.data.busy) return this.loadLinks(true); },
  retryLinks() { if (!this.data.busy) return this.loadLinks(!!this.data.links.length); },

  startSelecting() {
    if (!this.ready()) return;
    this.setData({ selecting: true });
    if (!this.data.works.length) this.loadWorks(false);
  },

  closeSelecting() {
    if (!this.data.busy) this.setData({ selecting: false });
  },

  async loadWorks(append = false) {
    if (!this.data.canManage || this.data.worksLoading || (append && !this.data.worksHasMore)) return;
    const epoch = this._epoch;
    const seq = ++this._worksSeq;
    const skip = append ? this.data.worksSkip : 0;
    this.setData({ worksLoading: true, worksError: '' });
    try {
      const records = await api.listRecords(skip, PAGE_SIZE);
      if (!this.current(epoch) || seq !== this._worksSeq) return;
      let urls = {};
      // 换图失败不丢掉本页作品，允许逐图重试。
      try { urls = await api.getTempUrls(records.map(row => row.thumbFileID || row.fileID).filter(Boolean)); }
      catch (error) { /* 图片失败状态由每张卡片展示。 */ }
      if (!this.current(epoch) || seq !== this._worksSeq) return;
      const rows = records.map(row => ({
        _id: row._id, fileID: row.thumbFileID || row.fileID || '',
        url: urls[row.thumbFileID || row.fileID] || '', imageFailed: !urls[row.thumbFileID || row.fileID],
        imageLoading: false, selected: this._selected.has(row._id),
        desc: [row.category, row.style].filter(Boolean).join(' · ') || '花艺作品'
      }));
      const works = append ? this.data.works.concat(rows) : rows;
      const seen = new Set();
      this.setData({
        works: works.filter(row => !seen.has(row._id) && seen.add(row._id)),
        worksSkip: skip + records.length, worksHasMore: records.length === PAGE_SIZE
      });
    } catch (error) {
      if (!this.current(epoch) || seq !== this._worksSeq) return;
      this.setData({ worksError: error.message || '作品加载失败，请重试' });
      await this.reconcileAccess(epoch);
    } finally {
      if (this.current(epoch) && seq === this._worksSeq) this.setData({ worksLoading: false });
    }
  },

  loadMoreWorks() { if (!this.data.busy) return this.loadWorks(true); },
  retryWorks() { if (!this.data.busy) return this.loadWorks(!!this.data.works.length); },

  toggleWork(e) {
    if (!this.ready()) return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.works.some(row => row._id === id)) return;
    if (this._selected.has(id)) this._selected.delete(id);
    else {
      const error = selectionError(Array.from(this._selected).concat(id));
      if (error) { wx.showToast({ title: error, icon: 'none' }); return; }
      this._selected.add(id);
    }
    this.setData({
      works: this.data.works.map(row => Object.assign({}, row, { selected: this._selected.has(row._id) })),
      selectedCount: this._selected.size
    });
  },

  imageError(e) {
    const { id, url } = e.currentTarget.dataset;
    this.setData({ works: this.data.works.map(row => row._id === id && row.url === url
      ? Object.assign({}, row, { imageFailed: true }) : row) });
  },

  async retryImage(e) {
    if (!this.ready()) return;
    const id = e.currentTarget.dataset.id;
    const row = this.data.works.find(item => item._id === id);
    if (!row || row.imageLoading || !row.fileID) return;
    const epoch = this._epoch;
    const seq = (this._imageSeq[id] || 0) + 1;
    this._imageSeq[id] = seq;
    this.setData({ works: this.data.works.map(item => item._id === id
      ? Object.assign({}, item, { imageLoading: true }) : item) });
    try {
      const urls = await api.getTempUrls([row.fileID]);
      if (!this.current(epoch) || this._imageSeq[id] !== seq) return;
      this.setData({ works: this.data.works.map(item => item._id === id
        ? Object.assign({}, item, { url: urls[row.fileID] || '', imageFailed: !urls[row.fileID] }) : item) });
    } catch (error) {
      if (this.current(epoch)) wx.showToast({ title: '图片加载失败，请重试', icon: 'none' });
    } finally {
      if (this.current(epoch) && this._imageSeq[id] === seq) {
        this.setData({ works: this.data.works.map(item => item._id === id
          ? Object.assign({}, item, { imageLoading: false }) : item) });
      }
    }
  },

  ready() { return this._visible && this.data.canManage && !this.data.accessLoading && !this.data.busy; },

  clearEditor(all = false, keepDraft = false) {
    this._editSeq++;
    if (all) this._drafts.clear();
    else if (!keepDraft) this._drafts.delete(this.data.editingId);
    this.setData({
      editingId: '', editTitle: '', editDescription: '', titleCount: 0, descriptionCount: 0,
      editError: '', savingMetadata: false
    });
  },

  editLink(e) {
    if (!this.ready()) return;
    const row = this.data.links.find(item => item.id === e.currentTarget.dataset.id);
    if (!row || !row.enabled || !row.token) return;
    this._editSeq++;
    const fields = metadataFields(row);
    const draft = this._drafts.get(row.id) || { title: fields.title || row.modeLabel, description: fields.description };
    this._drafts.set(row.id, draft);
    this.setData({
      editingId: row.id, editTitle: draft.title, editDescription: draft.description,
      titleCount: Array.from(draft.title.trim()).length,
      descriptionCount: Array.from(draft.description.trim()).length, editError: ''
    });
  },

  inputMetadata(e) {
    if (!this.ready() || !this.data.editingId) return;
    const field = e.currentTarget.dataset.field;
    if (field !== 'title' && field !== 'description') return;
    const value = e.detail.value;
    if (typeof value !== 'string') return;
    const draft = Object.assign({}, this._drafts.get(this.data.editingId), { [field]: value });
    this._drafts.set(this.data.editingId, draft);
    this.setData(field === 'title'
      ? { editTitle: value, titleCount: Array.from(value.trim()).length, editError: '' }
      : { editDescription: value, descriptionCount: Array.from(value.trim()).length, editError: '' });
  },

  cancelMetadata() {
    if (this.ready()) this.clearEditor();
  },

  async saveMetadata() {
    if (!this.ready() || !this.data.editingId) return;
    const id = this.data.editingId;
    const row = this.data.links.find(item => item.id === id);
    if (!row || !row.enabled || !row.token) { this.clearEditor(); return; }
    const title = this.data.editTitle.trim();
    const description = this.data.editDescription.trim();
    const error = metadataError(title, description);
    if (error) { this.setData({ editError: error }); return; }
    const epoch = this._epoch;
    const seq = ++this._editSeq;
    const active = () => this.current(epoch) && seq === this._editSeq && this.data.editingId === id;
    this.setData({ busy: true, savingMetadata: true, editError: '' });
    try {
      if (!await this.checkAccess(epoch) || !active()) return;
      const result = await api.updatePortfolioMetadata(id, title, description);
      if (!active()) return;
      if (!await this.checkAccess(epoch) || !active()) return;
      if (!result || !result.ok || result.id !== id || typeof result.title !== 'string'
        || typeof result.description !== 'string' || metadataError(result.title, result.description)) {
        throw new Error(result && result.error || '保存结果暂无法确认，请重试或刷新链接');
      }
      const fields = Object.assign(metadataFields(result), { updatedAt: result.updatedAt });
      this._metadataUpdates.set(id, { revision: ++this._metadataRevision, fields });
      this.setData({
        links: this.data.links.map(item => item.id === id
          ? Object.assign({}, item, fields, { displayTitle: fields.title || item.modeLabel }) : item),
        busy: false
      });
      this.clearEditor();
      wx.showToast({ title: '作品集文字已保存', icon: 'none' });
    } catch (error) {
      if (!active()) return;
      this.setData({ editError: error.message || '保存失败，输入已保留，请重试' });
      await this.reconcileAccess(epoch);
      if (active()) await this.loadLinks(false);
    } finally {
      if (this.current(epoch) && (seq === this._editSeq || !this.data.editingId)) {
        this.setData({ busy: false, savingMetadata: false });
      }
    }
  },

  createAll() { return this.createShare('all'); },
  createSelected() { return this.createShare('selected'); },

  async createShare(mode) {
    if (!this.ready() || (mode === 'selected' && !this._selected.size)) return;
    const epoch = this._epoch;
    const recordIds = mode === 'selected' ? Array.from(this._selected) : undefined;
    const error = recordIds ? selectionError(recordIds) : '';
    if (error) { wx.showToast({ title: error, icon: 'none' }); return; }
    this.setData({ busy: true, creating: mode });
    try {
      const accepted = await confirm({
        title: mode === 'all' ? '分享全部作品' : `分享 ${recordIds.length} 件精选作品`,
        content: mode === 'all'
          ? '链接持有者可查看你的全部作品及附加图，包括未开启单件分享的作品；后续新增作品也会自动展示。作品集与单件分享分别管理。已下载图片或仍有效的临时图片链接无法追溯收回。确定创建吗？'
          : `仅分享本次选中的 ${recordIds.length} 件作品及附加图，后续新增作品不会自动加入。不会修改单件分享状态，也不会替换已有作品集链接。已下载图片或仍有效的临时图片链接无法追溯收回。确定创建吗？`,
        confirmText: '创建链接'
      });
      if (!accepted || !this.current(epoch) || !await this.checkAccess(epoch)) return;
      if (mode === 'all' && !((await api.countRecords()) > 0)) throw new Error('还没有可分享作品，请先上传作品');
      if (!this.current(epoch)) return;
      const result = await api.createPortfolioShare(mode, recordIds);
      if (!this.current(epoch)) return;
      if (!result.token) throw new Error('未取得分享链接，请刷新已有链接查看');
      await this.navigatePreview(result.token);
    } catch (error) {
      if (!this.current(epoch)) return;
      wx.showToast({ title: error.message || '创建失败，请重试', icon: 'none' });
      await this.reconcileAccess(epoch);
      if (this.current(epoch)) await this.loadLinks(false);
    } finally {
      if (this.current(epoch)) this.setData({ busy: false, creating: '' });
    }
  },

  async openLink(e) {
    if (!this.ready()) return;
    const row = this.data.links.find(item => item.id === e.currentTarget.dataset.id);
    if (!row || !row.enabled || !row.token) return;
    const epoch = this._epoch;
    this.setData({ busy: true, openingId: row.id });
    try {
      if (!await this.checkAccess(epoch)) return;
      await api.readPortfolioShare(row.token, '', 1);
      if (this.current(epoch)) await this.navigatePreview(row.token);
    } catch (error) {
      if (!this.current(epoch)) return;
      wx.showToast({ title: error.message || '链接无法打开，请刷新重试', icon: 'none' });
      await this.reconcileAccess(epoch);
      if (this.current(epoch)) await this.loadLinks(false);
    } finally {
      if (this.current(epoch)) this.setData({ busy: false, openingId: '' });
    }
  },

  navigatePreview(token) {
    return new Promise((resolve, reject) => wx.navigateTo({
      url: '/pages/portfolio-share/portfolio-share?portfolioToken=' + encodeURIComponent(token),
      success: resolve,
      fail: () => reject(new Error('预览页面打开失败，可从已有链接重试'))
    }));
  },

  async stopLink(e) {
    if (!this.ready()) return;
    const row = this.data.links.find(item => item.id === e.currentTarget.dataset.id);
    if (!row || !row.enabled) return;
    const epoch = this._epoch;
    this.setData({ busy: true, stoppingId: row.id });
    try {
      const accepted = await confirm({
        title: '停止此作品集分享',
        content: '仅此链接永久失效，旧令牌不能重新启用；其他作品集与单件分享不受影响。停止后新的读取将被阻断，但已下载图片或仍有效的临时图片链接无法追溯收回。',
        confirmText: '停止分享', confirmColor: '#a36759'
      });
      if (!accepted || !this.current(epoch) || !await this.checkAccess(epoch)) return;
      await api.stopPortfolioShare(row.id);
      if (!this.current(epoch)) return;
      // 废弃停止前的列表请求，避免旧响应把链接恢复成有效状态。
      this._linksSeq++;
      this.setData({
        linksLoading: false,
        links: this.data.links.map(item => item.id === row.id ? Object.assign({}, item, { enabled: false }) : item)
      });
      this._drafts.delete(row.id);
      if (this.data.editingId === row.id) this.clearEditor();
      wx.showToast({ title: '此链接已停止分享', icon: 'none' });
    } catch (error) {
      if (!this.current(epoch)) return;
      wx.showToast({ title: error.message || '停止失败，请重试', icon: 'none' });
      await this.reconcileAccess(epoch);
    } finally {
      if (this.current(epoch)) this.setData({ busy: false, stoppingId: '' });
    }
  },

  goMy() { wx.switchTab({ url: '/pages/my/my' }); }
});
