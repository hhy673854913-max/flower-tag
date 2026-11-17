const api = require('../../utils/api');
const flow = require('../../utils/upload-flow');
const { DIMENSIONS, FLOWER_ROLES } = require('../../utils/tagdict');

Page({
  data: {
    record: null,
    url: '',
    extraUrls: [], // 附加图临时链接
    currentSwiperIdx: 0,
    editing: false,
    dimView: [],   // 各维度选项 + 选中态（WXML 不支持 indexOf 等方法调用，选中态必须在 JS 预计算）
    roles: FLOWER_ROLES,
    saving: false,
    loadingOriginal: false,  // "查看原图"按钮加载态
    canManage: false,
    shared: false,
    authorName: '',
    shareToken: '',
    shareBusy: false,
    loadError: '',
    portfolio: false,
    imageErrors: [],
    loading: false,
    extrasBusy: false,
    extrasUnknown: false,
    extrasMessage: ''
  },

  async onLoad(query) {
    this.id = query.id;
    this.token = query.shareToken || '';
    this.portfolioToken = query.portfolioToken || '';
    this._alive = true;
    this._loadSeq = 0;
    this._previewSeq = 0;
    this.setData({ shared: !!(this.portfolioToken || this.token), portfolio: !!this.portfolioToken });
    await this.loadRecord();
  },

  onShow() {
    this._visible = true;
    if (this._extrasFlow && this._extrasFlow.alive()) {
      this._extrasFlow.show();
      this._extrasFlow.checkpoint().then(() => {
        if (this._alive && this._extrasFlow.alive()) this.setData({ canManage: true });
      }).catch(() => {});
      return;
    }
    if (this._shown && (this.id || this.token || this.portfolioToken)) this.loadRecord();
    this._shown = true;
  },

  onHide() {
    this._visible = false;
    if (this._extrasFlow) this._extrasFlow.hide();
    if (this.data.loadingOriginal) wx.hideLoading();
    this._loadSeq++;
    this._previewSeq++;
    this.setData({ canManage: false, editing: false, loadingOriginal: false });
    wx.hideShareMenu();
  },

  onUnload() {
    if (this._extrasFlow) this._extrasFlow.unload();
    if (this.data.loadingOriginal) wx.hideLoading();
    this._alive = false;
    this._loadSeq++;
    this._previewSeq++;
  },

  isCurrent(seq) {
    return this._alive && seq === this._loadSeq;
  },

  isShareInvalid(error) {
    return /失效|停止分享|取消分享|撤销|清理中|不存在|无权|无效|不在.*范围|已删除|invalid|expired|denied/i.test(error && (error.message || error.code) || '');
  },

  clearRecord(message) {
    this.setData({
      record: null, url: '', extraUrls: [], dimView: [], imageErrors: [],
      canManage: false, editing: false, shareToken: '', authorName: '', loadError: message
    });
    wx.hideShareMenu();
  },

  async loadRecord() {
    if (this.data.loadingOriginal) wx.hideLoading();
    const seq = ++this._loadSeq;
    this._previewSeq++;
    this.clearRecord('');
    this.setData({ loading: true, loadingOriginal: false, currentSwiperIdx: 0 });
    try {
      let record, map, authorName = '', canManage = false;
      if (this.portfolioToken) {
        const result = await api.readPortfolioRecord(this.portfolioToken, this.id, false);
        record = result.record;
        map = result.urls || {};
        authorName = result.name || '花艺师';
      } else if (this.token) {
        const result = await api.readSharedRecord(this.token);
        record = result.record;
        map = result.urls || {};
        authorName = result.name || '花艺师';
      } else {
        await api.requireAccess();
        if (!this.isCurrent(seq)) return;
        record = await api.getRecord(this.id);
        canManage = true;
      }
      if (!this.isCurrent(seq)) return;
      // 详情页默认展示缩略图（旧记录没有 thumbFileID，回退原图）；原图点"查看原图"时才加载
      const displayID = record.thumbFileID || record.fileID;
      
      const extraIDs = (record.extraFiles || []).map(f => f.thumbFileID || f.fileID);
      const allIDs = [displayID].concat(extraIDs);
      if (!map) map = await api.getTempUrls(allIDs);
      if (!this.isCurrent(seq)) return;
      this.setData({
        record,
        authorName,
        canManage,
        editing: false,
        shareToken: canManage ? record.shareToken || '' : '',
        url: map[displayID] || '',
        extraUrls: extraIDs.map(id => map[id] || ''),
        imageErrors: allIDs.map(id => !map[id]),
        dimView: this.buildDimView(record),
        loadError: ''
      });
      if (canManage && record.isPublic && record.shareToken) wx.showShareMenu({ menus: ['shareAppMessage'] });
    } catch (e) {
      if (!this.isCurrent(seq)) return;
      this.clearRecord((this.portfolioToken || this.token) && this.isShareInvalid(e)
        ? '分享已失效、作品不可访问或花艺师权限已撤销'
        : e.message || '读取失败，请重试');
    } finally {
      if (this.isCurrent(seq)) this.setData({ loading: false });
    }
  },

  onImageError(e) {
    if (!this._alive) return;
    const index = Number(e.currentTarget.dataset.idx);
    const urls = [this.data.url].concat(this.data.extraUrls);
    if (urls[index] !== e.currentTarget.dataset.url) return;
    this.setData({ ['imageErrors[' + index + ']']: true });
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  goBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ fail: () => this.goHome() });
    else this.goHome();
  },

  onSwiperChange(e) {
    this.setData({ currentSwiperIdx: e.detail.current });
  },

  async addExtraImages() {
    if (this.data.editing || !this.data.canManage || this.data.extrasBusy || this.data.saving || this.data.shareBusy) return;
    const r = this.data.record;
    const remain = 8 - (r.extraFiles || []).length;
    if (remain <= 0) return;

    const controller = new flow.Controller(this, 'extra', this.id);
    this._extrasFlow = controller;
    this.setData({ extrasBusy: true, extrasUnknown: false, extrasMessage: '正在选择附加图' });
    const current = () => this._alive && this._extrasFlow === controller && controller.alive();
    try {
      await api.requireAccess();
      await controller.checkpoint();
      const lossless = wx.getStorageSync('upload_lossless') !== false;
      const res = await controller.systemCall(() => wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sizeType: lossless ? ['original'] : ['compressed']
      }));
      await controller.checkpoint();
      await controller.begin();
      const jobIds = [];

      for (let i = 0; i < res.tempFiles.length; i++) {
        const f = res.tempFiles[i];
        await controller.checkpoint();
        const job = await controller.prepare(i, f.tempFilePath);
        await controller.checkpoint();
        if (!current()) return;
        this.setData({ extrasMessage: '正在上传附加图 ' + (i + 1) + ' / ' + res.tempFiles.length });
        // 1. 上传原图
        await api.uploadWorkImage(f.tempFilePath, null, { job, controller });
        await controller.checkpoint();
        // 2. 上传缩略图
        let thumbPath = f.tempFilePath;
        try {
          // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
          const c = await wx.compressImage({ src: f.tempFilePath, quality: 20 });
          thumbPath = c.tempFilePath;
        } catch (e) { }
        await controller.checkpoint();
        const thumbFileID = await api.uploadThumbImage(thumbPath, null, { job, controller });
        await controller.checkpoint();

        // 3. 安全检测
        const secRes = await api.imgSecCheck(thumbFileID, job);
        await controller.checkpoint();
        if (!secRes || !secRes.ok) throw new Error(secRes && secRes.error || '安全检测失败，请重试');

        jobIds.push(job.jobId);
      }
      await controller.checkpoint();
      this.setData({ extrasMessage: '正在保存附加图' });
      this._extraJobIds = jobIds;
      try {
        await api.commitExtraUploads(controller.sessionId, jobIds);
        flow.dirty();
      } catch (_) {
        if (current()) this.setData({ extrasUnknown: true, extrasMessage: '保存结果待确认，请核对或放弃未保存' });
        await this.checkExtraResult(true);
        return;
      }
      await controller.cancel('finish');
      if (this._alive && this._extrasFlow === controller && this._visible) {
        wx.showToast({ title: '添加成功' });
        this.loadRecord();
      }
    } catch (err) {
      await controller.cancel('cancel');
      if (this._alive && this._visible && !/cancel/.test(err && err.errMsg || '')) wx.showToast({ title: err.message || '添加失败', icon: 'none' });
    } finally {
      if (this._alive && this._extrasFlow === controller && !this.data.extrasUnknown) this.setData({ extrasBusy: false });
    }
  },

  onUploadCancelled(controller) {
    if (this._alive && this._extrasFlow === controller) this.setData({ extrasBusy: false, extrasUnknown: false, extrasMessage: '' });
  },

  async checkExtraResult(internal = false) {
    internal = internal === true;
    const controller = this._extrasFlow;
    if (!controller || !controller.alive() || this._checkingExtras) return;
    this._checkingExtras = true;
    try {
      const state = await api.readUploadSession(controller.sessionId);
      const committed = (this._extraJobIds || []).length && this._extraJobIds.every(id =>
        state.jobs.some(j => j.jobId === id && j.state === 'committed'));
      if (committed) {
        flow.dirty();
        await controller.cancel('finish');
        if (this._alive && this._visible) { wx.showToast({ title: '添加成功' }); this.loadRecord(); }
      } else if (state.state !== 'open' || state.expired || state.expiresAt <= Date.now()) {
        await controller.cancel('leave');
      } else if (!internal) {
        // 只重试同一组任务，云端幂等并读取最新 extraFiles，不重新上传。
        await controller.checkpoint();
        await api.commitExtraUploads(controller.sessionId, this._extraJobIds);
        flow.dirty();
        await controller.cancel('finish');
        if (this._alive && this._visible) this.loadRecord();
      }
    } catch (_) {
      if (this._alive && controller.alive() && this._visible) this.setData({
        extrasUnknown: true, extrasMessage: '保存结果待确认，请恢复网络后核对'
      });
    } finally { this._checkingExtras = false; }
  },

  cancelExtras() {
    if (!this._extrasFlow || this._extraCancelling) return;
    this._extraCancelling = true;
    const controller = this._extrasFlow;
    wx.showModal({
      title: '放弃附加图', content: '回收本次未保存的附加图，已成功保存的图片会保留。',
      confirmText: '确认放弃',
      success: async r => {
        if (!r.confirm) return;
        const closed = await controller.cancel('cancel');
        if (this._alive && this._visible && this._extrasFlow === controller) {
          if (!closed) wx.showToast({ title: '已停止，恢复网络后回收未保存图片', icon: 'none' });
          this.loadRecord();
        }
      },
      complete: () => { this._extraCancelling = false; }
    });
  },

  toggleEdit() {
    if (!this.data.canManage || this.data.extrasBusy) return;
    this.setData({ editing: !this.data.editing });
  },

  /** 由当前记录计算各维度每个选项的选中态 */
  buildDimView(record) {
    if (this.data.shared) {
      return DIMENSIONS.map(d => ({
        key: d.key, name: d.name, multi: d.multi,
        options: (d.multi ? record[d.key] || [] : [record[d.key]])
          .filter(name => typeof name === 'string' && name)
          .map(name => ({ name, on: true }))
      })).filter(d => d.options.length);
    }
    return DIMENSIONS.map(d => ({
      key: d.key,
      name: d.name,
      multi: d.multi,
      options: d.options.map(name => ({
        name,
        on: d.multi ? ((record[d.key] || []).indexOf(name) >= 0) : record[d.key] === name
      }))
    }));
  },

  toggleTag(e) {
    if (!this.data.canManage || !this.data.editing) return;
    const { key, value, multi } = e.currentTarget.dataset;
    const record = this.data.record;
    if (multi === true || multi === 'true') {
      const arr = (record[key] || []).slice();
      const idx = arr.indexOf(value);
      if (key === 'colors' && ((idx >= 0 && arr.length === 1) || (idx < 0 && arr.length >= 3))) {
        wx.showToast({ title: '颜色需选择 1～3 个', icon: 'none' }); return;
      }
      if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
      this.setData({ ['record.' + key]: arr });
    } else {
      this.setData({ ['record.' + key]: value });
    }
    // 标签变化后重算选中态
    this.setData({ dimView: this.buildDimView(this.data.record) });
  },

  addFlower(e) {
    if (!this.data.canManage || !this.data.editing) return;
    const role = e.currentTarget.dataset.role;
    wx.showModal({
      title: '添加花材',
      editable: true,
      placeholderText: '如：玫瑰、洋桔梗',
      success: res => {
        if (!res.confirm || !this._alive || !this.data.canManage || !this.data.editing) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const arr = (this.data.record[role] || []).slice();
        if (arr.indexOf(name) < 0) arr.push(name);
        this.setData({ ['record.' + role]: arr });
      }
    });
  },

  removeFlower(e) {
    if (!this.data.canManage || !this.data.editing) return;
    const { role, index } = e.currentTarget.dataset;
    const arr = (this.data.record[role] || []).slice();
    arr.splice(Number(index), 1);
    this.setData({ ['record.' + role]: arr });
  },

  moveFlower(e) {
    if (!this.data.canManage || !this.data.editing) return;
    const { role, index } = e.currentTarget.dataset;
    const i = Number(index);
    const others = FLOWER_ROLES.filter(r => r.key !== role);
    wx.showActionSheet({
      itemList: others.map(r => '调整为' + r.name),
      success: res => {
        if (!this._alive || !this.data.canManage || !this.data.editing) return;
        const from = (this.data.record[role] || []).slice();
        const name = from[i];
        const target = others[res.tapIndex].key;
        from.splice(i, 1);
        const to = (this.data.record[target] || []).slice();
        if (to.indexOf(name) < 0) to.push(name);
        this.setData({ ['record.' + role]: from, ['record.' + target]: to });
      }
    });
  },

  async save() {
    if (this.data.saving || !this.data.canManage || this.data.extrasBusy) return;
    this.setData({ saving: true });
    try {
      const r = this.data.record;
      const tags = {
        colors: r.colors || [],
        colorScheme: r.colorScheme || '混合颜色',
        flowersMain: r.flowersMain || [],
        flowersSub: r.flowersSub || [],
        flowersLeaf: r.flowersLeaf || [],
        category: r.category || '其他',
        style: r.style || '其他',
        occasion: r.occasion || []
      };
      await api.updateRecordTags(this.id, tags);
      api.bumpTagUsage(tags);
      api.invalidate();
      this.setData({ editing: false });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },

  remove() {
    if (!this.data.canManage || this.data.extrasBusy) return;
    wx.showModal({
      title: '删除记录',
      content: '将同时删除云端图片与标签，不可恢复，确定吗？',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm || !this._alive || !this.data.canManage || this.data.extrasBusy) return;
        try {
          await api.removeRecord(this.id);
          api.invalidate();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  setSharing() {
    if (!this.data.canManage || this.data.shareBusy || this.data.extrasBusy) return;
    const enabled = !this.data.shareToken;
    wx.showModal({
      title: enabled ? '开启单件分享' : '停止单件分享',
      content: enabled
        ? '持有单件链接的人可查看这件作品及附加图。单件与作品集授权分别管理，此操作不改变作品集范围。已下载图片或仍有效的临时图片链接无法追溯收回。'
        : '停止后，旧单件链接不能再获取作品；已授权的作品集仍可展示此作品。两种授权分别管理，已下载图片或仍有效的临时图片链接无法追溯收回。',
      success: async res => {
        if (!res.confirm || !this._alive || !this.data.canManage || this.data.shareBusy || this.data.extrasBusy) return;
        const seq = this._loadSeq;
        this.setData({ shareBusy: true });
        try {
          const result = await api.shareRecord(this.id, enabled);
          if (!this.isCurrent(seq) || !this.data.canManage) return;
          this.setData({ shareToken: result.shareToken, 'record.isPublic': enabled });
          if (enabled) wx.showShareMenu({ menus: ['shareAppMessage'] });
          else wx.hideShareMenu();
          wx.showToast({ title: enabled ? '现在可以分享给好友' : '已停止分享', icon: 'none' });
        } catch (error) { if (this.isCurrent(seq)) wx.showToast({ title: error.message, icon: 'none' }); }
        finally { if (this._alive) this.setData({ shareBusy: false }); }
      }
    });
  },

  onShareAppMessage() {
    if (this.portfolioToken || !this.data.canManage || !this.data.record || !this.data.shareToken) {
      return { title: '花艺图库', path: '/pages/index/index' };
    }
    const card = {
      title: [this.data.record.category, (this.data.record.flowersMain || [])[0]].filter(Boolean).join(' · ') || '花艺作品',
      path: '/pages/detail/detail?shareToken=' + encodeURIComponent(this.data.shareToken)
    };
    if (this.data.url && !this.data.imageErrors[0]) card.imageUrl = this.data.url;
    return card;
  },

  /** 查看原图：按需换取原图临时链接后全屏预览（原图体积大，仅此处加载） */
  async previewOriginal(e) {
    if (this.data.loadingOriginal) return;
    const r = this.data.record;
    if (!r) return;
    const seq = this._loadSeq;
    const previewSeq = ++this._previewSeq;
    
    let targetIdx = 0;
    if (e && e.currentTarget && e.currentTarget.dataset.idx !== undefined) {
      targetIdx = Number(e.currentTarget.dataset.idx);
    } else {
      targetIdx = this.data.currentSwiperIdx || 0;
    }

    this.setData({ loadingOriginal: true });
    wx.showLoading({ title: '加载原图…', mask: true });
    try {
      const allOriginalIDs = [r.fileID].concat((r.extraFiles || []).map(f => f.fileID));
      const map = this.portfolioToken
        ? (await api.readPortfolioRecord(this.portfolioToken, this.id, true)).urls || {}
        : this.token ? (await api.readSharedRecord(this.token)).urls || {} : await api.getTempUrls(allOriginalIDs);
      if (!this.isCurrent(seq) || previewSeq !== this._previewSeq) return;
      const urls = allOriginalIDs.map(id => map[id]).filter(Boolean);
      const current = map[allOriginalIDs[targetIdx]];
      
      if (urls.length > 0 && current) {
        wx.hideLoading();
        if (this._extrasFlow && this._extrasFlow.alive()) {
          await this._extrasFlow.systemCall(() => wx.previewImage({ urls, current }));
        } else await wx.previewImage({ urls, current });
      } else {
        wx.hideLoading();
        wx.showToast({ title: '原图加载失败', icon: 'none' });
      }
    } catch (e) {
      if (!this.isCurrent(seq) || previewSeq !== this._previewSeq) return;
      if ((this.portfolioToken || this.token) && this.isShareInvalid(e)) {
        this.clearRecord('分享已失效或作品不可访问');
      } else if (this.portfolioToken && /作品已发生变化/.test(e.message || '')) {
        this.clearRecord('作品已更新，请重新读取');
      } else wx.showToast({ title: '原图加载失败，请重试', icon: 'none' });
    } finally {
      if (previewSeq === this._previewSeq) wx.hideLoading();
      if (this.isCurrent(seq) && previewSeq === this._previewSeq) this.setData({ loadingOriginal: false });
    }
  }
});
