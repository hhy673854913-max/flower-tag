const api = require('../../utils/api');
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
    loading: false
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
    if (this._shown && (this.id || this.token || this.portfolioToken)) this.loadRecord();
    this._shown = true;
  },

  onHide() {
    if (this.data.loadingOriginal) wx.hideLoading();
    this._loadSeq++;
    this._previewSeq++;
    this.setData({ canManage: false, editing: false, loadingOriginal: false });
    wx.hideShareMenu();
  },

  onUnload() {
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
    if (this.data.editing || !this.data.canManage) return;
    const r = this.data.record;
    const remain = 8 - (r.extraFiles || []).length;
    if (remain <= 0) return;

    const uploaded = [];
    let committed = false;
    try {
      await api.requireAccess();
      const lossless = wx.getStorageSync('upload_lossless') !== false;
      const res = await wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sizeType: lossless ? ['original'] : ['compressed']
      });

      wx.showLoading({ title: '处理中…', mask: true });
      const newExtras = [];

      for (let f of res.tempFiles) {
        // 1. 上传原图
        const fileID = await api.uploadWorkImage(f.tempFilePath);
        uploaded.push(fileID);
        // 2. 上传缩略图
        let thumbPath = f.tempFilePath;
        try {
          // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
          const c = await wx.compressImage({ src: f.tempFilePath, quality: 20 });
          thumbPath = c.tempFilePath;
        } catch (e) { }
        const thumbFileID = await api.uploadThumbImage(thumbPath);
        uploaded.push(thumbFileID);

        // 3. 安全检测
        const secRes = await api.imgSecCheck(thumbFileID);
        if (!secRes.ok) {
          if (secRes.accessDenied) throw new Error(secRes.error || '账号校验失败');
          console.error('安全检测失败详情:', secRes);
          if (secRes.isViolated) {
            await api.deleteCloudFiles([fileID, thumbFileID]);
            wx.hideLoading();
            wx.showModal({ title: '安全提示', content: '图片包含违规内容，已拦截', showCancel: false });
            return; // 发现违规，终止后续上传
          } else {
            // 非违规类错误（如 invalid media size 图片过大），仅警告，放行
            console.warn('安全检测异常，放行:', secRes.error);
          }
        }

        newExtras.push({ fileID, thumbFileID });
      }

      const extraFiles = (r.extraFiles || []).concat(newExtras);
      await api.updateRecordExtras(this.id, extraFiles);
      committed = true;
      getApp().globalData.dbUpdateTime = Date.now();
      
      wx.hideLoading();
      wx.showToast({ title: '添加成功' });
      this.loadRecord(); // 重新加载
    } catch (err) {
      wx.hideLoading();
      if (!/cancel/.test(err && err.errMsg || '')) wx.showToast({ title: err.message || '添加失败', icon: 'none' });
    } finally {
      if (!committed && uploaded.length) api.deleteCloudFiles(uploaded).catch(console.error);
    }
  },

  toggleEdit() {
    if (!this.data.canManage) return;
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
      if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
      this.setData({ ['record.' + key]: arr });
    } else {
      this.setData({ ['record.' + key]: record[key] === value ? '' : value });
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
    if (this.data.saving || !this.data.canManage) return;
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
      getApp().globalData.dbUpdateTime = Date.now();
      this.setData({ editing: false });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },

  remove() {
    if (!this.data.canManage) return;
    wx.showModal({
      title: '删除记录',
      content: '将同时删除云端图片与标签，不可恢复，确定吗？',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm || !this._alive || !this.data.canManage) return;
        try {
          await api.removeRecord(this.id);
          getApp().globalData.dbUpdateTime = Date.now();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  setSharing() {
    if (!this.data.canManage || this.data.shareBusy) return;
    const enabled = !this.data.shareToken;
    wx.showModal({
      title: enabled ? '开启单件分享' : '停止单件分享',
      content: enabled
        ? '持有单件链接的人可查看这件作品及附加图。单件与作品集授权分别管理，此操作不改变作品集范围。已下载图片或仍有效的临时图片链接无法追溯收回。'
        : '停止后，旧单件链接不能再获取作品；已授权的作品集仍可展示此作品。两种授权分别管理，已下载图片或仍有效的临时图片链接无法追溯收回。',
      success: async res => {
        if (!res.confirm || !this._alive || !this.data.canManage || this.data.shareBusy) return;
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
        await wx.previewImage({ urls, current });
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
