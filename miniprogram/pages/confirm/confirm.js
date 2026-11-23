const api = require('../../utils/api');
const flow = require('../../utils/upload-flow');
const onboarding = require('../../utils/onboarding');
const { DIMENSIONS, FLOWER_ROLES, normalizeTags } = require('../../utils/tagdict');

Page({
  data: {
    items: [],      // { fileID, tempPath, tags, saved, skipped }
    current: 0,
    cur: null,      // 当前编辑副本 { fileID, tempPath, tags }
    dimView: [],    // 各维度选项 + 选中态（WXML 不支持 indexOf 等方法调用，选中态必须在 JS 预计算）
    roles: FLOWER_ROLES,
    remaining: 0,
    saving: false,
    unknown: false,
    finished: false
  },

  onLoad() {
    this._alive = true;
    const global = getApp().globalData;
    const pending = global.pendingList || [];
    const handoff = global.pendingUpload;
    global.pendingList = [];
    global.pendingUpload = null;
    this._flow = handoff && handoff.controller;
    const list = pending.map(x => ({
      sessionId: x.sessionId,
      jobId: x.jobId,
      fileID: x.fileID,
      thumbFileID: x.thumbFileID,
      tempPath: x.tempPath,
      tags: normalizeTags(x.tags),
      saved: false,
      skipped: false
    }));
    if (!list.length || !this._flow || !this._flow.alive()) {
      wx.showToast({ title: '没有待确认的记录', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this._flow.transfer(this);
    if (handoff.onClaim) handoff.onClaim();
    this.setData({ items: list, remaining: list.length });
    this.loadCur(0);
  },

  onShow() {
    this._visible = true;
    onboarding.pageShow(this);
    onboarding.maybePresent(this);
    if (this._flow) this._flow.show();
    if (this._flow && this._flow.alive() && this.data.items.length) {
      this.setData({ items: this.data.items, remaining: this.data.items.filter(x => !x.saved && !x.skipped).length,
        unknown: this.data.items.some(x => x.unknown) });
    }
  },
  onHide() { this._visible = false; if (this._flow) this._flow.hide(); onboarding.pageHide(this); },
  onUnload() { this._alive = false; if (this._flow) this._flow.unload(); onboarding.pageHide(this); },
  onUploadCancelled() {
    if (this._alive) this.setData({ saving: false, unknown: false, finished: true });
  },
  editable() {
    const item = this.data.items[this.data.current];
    return this._alive && this._flow && this._flow.alive() && !this.data.saving && !this.data.unknown
      && item && !item.saved && !item.skipped && !item.snapshot;
  },

  /** 由当前标签计算各维度每个选项的选中态 */
  buildDimView(tags) {
    return DIMENSIONS.map(d => ({
      key: d.key,
      name: d.name,
      multi: d.multi,
      options: d.options.map(name => ({
        name,
        on: d.multi ? (tags[d.key] || []).indexOf(name) >= 0 : tags[d.key] === name
      }))
    }));
  },

  /** 把当前编辑内容写回 items，再加载第 i 张 */
  loadCur(i) {
    const { items, current, cur } = this.data;
    if (cur) items[current].tags = cur.tags;
    const it = items[i];
    const tags = JSON.parse(JSON.stringify(it.tags));
    this.setData({
      items,
      current: i,
      cur: { fileID: it.fileID, tempPath: it.tempPath, tags },
      dimView: this.buildDimView(tags)
    });
  },

  onSwiperChange(e) {
    if (this.data.saving || this.data.unknown) {
      this.setData({ current: this.data.current });
      return;
    }
    this.loadCur(e.detail.current);
  },

  /** 颜色/种类/风格/用途 点选 */
  toggleTag(e) {
    if (!this.editable()) return;
    const { key, value, multi } = e.currentTarget.dataset;
    const tags = this.data.cur.tags;
    if (multi === true || multi === 'true') {
      const arr = tags[key] || [];
      const idx = arr.indexOf(value);
      if (key === 'colors' && ((idx >= 0 && arr.length === 1) || (idx < 0 && arr.length >= 3))) {
        wx.showToast({ title: '颜色需选择 1～3 个', icon: 'none' }); return;
      }
      if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
      this.setData({ ['cur.tags.' + key]: arr });
    } else {
      this.setData({ ['cur.tags.' + key]: value });
    }
    // 标签变化后重算选中态
    this.setData({ dimView: this.buildDimView(this.data.cur.tags) });
  },

  /** 添加花材（输入名称，可识别行业通用名） */
  addFlower(e) {
    if (!this.editable()) return;
    const index = this.data.current;
    const role = e.currentTarget.dataset.role;
    wx.showModal({
      title: '添加' + this.roleName(role),
      editable: true,
      placeholderText: '如：玫瑰、洋桔梗、尤加利叶',
      success: res => {
        if (!res.confirm || !this.editable() || index !== this.data.current) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const arr = this.data.cur.tags[role] || [];
        if ([...name].length > 30 || arr.length >= 30) {
          wx.showToast({ title: '每类最多30项，每项最多30字', icon: 'none' }); return;
        }
        if (arr.indexOf(name) >= 0) {
          wx.showToast({ title: '已存在', icon: 'none' });
          return;
        }
        arr.push(name);
        this.setData({ ['cur.tags.' + role]: arr });
      }
    });
  },

  removeFlower(e) {
    if (!this.editable()) return;
    const { role, index } = e.currentTarget.dataset;
    const arr = this.data.cur.tags[role] || [];
    arr.splice(Number(index), 1);
    this.setData({ ['cur.tags.' + role]: arr });
  },

  /** 长按花材：调整角色 */
  moveFlower(e) {
    if (!this.editable()) return;
    const current = this.data.current;
    const { role, index } = e.currentTarget.dataset;
    const i = Number(index);
    const others = FLOWER_ROLES.filter(r => r.key !== role);
    wx.showActionSheet({
      itemList: others.map(r => '调整为' + r.name),
      success: res => {
        if (!this.editable() || current !== this.data.current) return;
        const from = this.data.cur.tags[role] || [];
        const name = from[i];
        const target = others[res.tapIndex].key;
        from.splice(i, 1);
        const to = this.data.cur.tags[target] || [];
        if (to.indexOf(name) < 0) to.push(name);
        this.setData({ ['cur.tags.' + role]: from, ['cur.tags.' + target]: to });
      }
    });
  },

  roleName(key) {
    const r = FLOWER_ROLES.find(x => x.key === key);
    return r ? r.name : '';
  },

  lowConf(dim) {
    const c = this.data.cur && this.data.cur.tags.confidence;
    return c && typeof c[dim] === 'number' && c[dim] < 0.6;
  },

  async saveOne(i) {
    const { items } = this.data;
    const it = items[i];
    if (it.saved || it.skipped) return true;
    if (!this._flow || !this._flow.alive()) return false;
    if (it.unknown) return this.reconcileOne(i);
    it.snapshot = it.snapshot || JSON.parse(JSON.stringify(it.tags));
    try {
      await this._flow.checkpoint();
      await api.commitUploadRecord(it.sessionId, it.jobId, it.snapshot);
      this.markSaved(i);
      return true;
    } catch (e) {
      if (e.validationFailed) {
        it.snapshot = null;
        if (this._alive && this._visible) wx.showToast({ title: e.message, icon: 'none' });
        return false;
      }
      // 任何失败都可能是成功响应丢失，不根据本地标志删图或新建。
      it.unknown = true;
      const saved = await this.reconcileOne(i);
      if (!saved && this._alive && this._flow.alive()) wx.showToast({
        title: it.unknown ? '保存结果待确认，请核对' : e.message || '保存未完成，可重试', icon: 'none'
      });
      return saved;
    }
  },

  markSaved(i) {
    flow.dirty();
    const item = this.data.items[i];
    const wasSaved = item.saved;
    item.saved = true; item.unknown = false;
    if (this._alive && this._visible && this._flow.alive()) this.setData({
      items: this.data.items, remaining: Math.max(0, this.data.remaining - (wasSaved ? 0 : 1)),
      unknown: this.data.items.some(x => x.unknown)
    });
  },

  async reconcileOne(i) {
    const item = this.data.items[i];
    try {
      const state = await api.readUploadSession(item.sessionId);
      const job = state.jobs.find(j => j.jobId === item.jobId);
      if (job && job.state === 'committed') { this.markSaved(i); return true; }
      if (job && job.state === 'pending' && state.state === 'open' && !state.expired && state.expiresAt > Date.now()) item.unknown = false;
      else if (job && ['abandoned', 'cleaning', 'cleaned'].includes(job.state) || state.state !== 'open' || state.expired || state.expiresAt <= Date.now()) {
        item.unknown = false;
        await this._flow.cancel('leave');
      }
    } catch (_) { item.unknown = true; }
    if (this._alive && this._visible && this._flow.alive()) this.setData({ items: this.data.items, unknown: this.data.items.some(x => x.unknown) });
    return false;
  },

  async checkSaveResult() {
    if (this.data.saving || !this._flow || !this._flow.alive()) return;
    this.setData({ saving: true });
    for (let i = 0; i < this.data.items.length; i++) if (this.data.items[i].unknown) await this.reconcileOne(i);
    if (this._alive && this._flow.alive()) {
      this.setData({ saving: false });
      if (!this.data.unknown && this.data.remaining <= 0) this.finish();
    }
  },

  /** 保存本张并跳到下一张未处理的 */
  async saveCurrent() {
    if (this.data.saving || this.data.unknown || this.data.finished) return;
    this.setData({ saving: true });
    const { items, current, cur } = this.data;
    items[current].tags = cur.tags;
    this.setData({ items });
    const saved = await this.saveOne(current);
    if (this._alive && this._flow.alive()) {
      this.setData({ saving: false });
      if (saved) this.jumpNext();
    }
  },

  async skipCurrent() {
    if (this.data.saving || this.data.unknown || this.data.finished) return;
    const { items, current } = this.data;
    if (!items[current].saved && !items[current].skipped) {
      this.setData({ saving: true });
      let response;
      try { response = await this._flow.abandon(items[current].jobId); }
      catch (error) {
        if (this._alive && this._flow.alive()) {
          this.setData({ saving: false });
          wx.showToast({ title: '跳过未完成，请恢复网络后重试', icon: 'none' });
        }
        return;
      }
      if (!this._alive || !this._flow.alive()) return;
      if (response.state === 'committed') {
        this.markSaved(current);
        this.setData({ saving: false });
        this.jumpNext();
        return;
      }
      items[current].skipped = true;
      this.setData({ items, remaining: this.data.remaining - 1, saving: false });
    }
    this.jumpNext();
  },

  jumpNext() {
    if (!this._alive || !this._flow.alive()) return;
    if (this.data.remaining <= 0) {
      this.finish();
      return;
    }
    const { items, current } = this.data;
    for (let step = 1; step <= items.length; step++) {
      const i = (current + step) % items.length;
      if (!items[i].saved && !items[i].skipped) {
        this.loadCur(i);
        return;
      }
    }
  },

  /** 保存全部未处理记录 */
  async saveAll() {
    if (this.data.saving || this.data.unknown || this.data.finished) return;
    this.setData({ saving: true });
    const { items, current, cur } = this.data;
    items[current].tags = cur.tags;
    this.setData({ items });
    wx.showLoading({ title: '保存中…' });
    let allSaved = true;
    for (let i = 0; i < items.length; i++) {
      if (!this._alive || !this._flow.alive() || !await this.saveOne(i)) { allSaved = false; break; }
    }
    wx.hideLoading();
    if (this._alive && this._flow.alive()) {
      this.setData({ saving: false });
      if (allSaved) this.finish();
    }
  },

  async finish() {
    if (this._finishing) return;
    this._finishing = true;
    const saved = this.data.items.some(it => it.saved);
    await this._flow.cancel('finish');
    if (!this._alive) return;
    this.setData({ finished: true, saving: false });
    wx.showToast({ title: saved ? '已保存' : '已放弃未保存图片', icon: saved ? 'success' : 'none' });
    this.returnToWall();
    this._finishing = false;
  },

  returnToWall() {
    wx.switchTab({
      url: '/pages/index/index',
      fail: () => { if (this._alive) wx.showToast({ title: '返回失败，请点击返回作品墙', icon: 'none' }); }
    });
  },

  abandonRemaining() {
    if (this.data.saving || this._abandonConfirming) return;
    this._abandonConfirming = true;
    wx.showModal({
      title: '放弃未保存', content: '回收本批尚未保存的图片，已经保存的作品会保留。',
      confirmText: '确认放弃',
      success: r => { if (r.confirm) this.finish(); },
      complete: () => { this._abandonConfirming = false; }
    });
  }
});
