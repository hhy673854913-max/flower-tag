const api = require('../../utils/api');
const { DIMENSIONS, FLOWER_ROLES, normalizeTags } = require('../../utils/tagdict');

Page({
  data: {
    items: [],      // { fileID, tempPath, tags, saved, skipped }
    current: 0,
    cur: null,      // 当前编辑副本 { fileID, tempPath, tags }
    dimView: [],    // 各维度选项 + 选中态（WXML 不支持 indexOf 等方法调用，选中态必须在 JS 预计算）
    roles: FLOWER_ROLES,
    remaining: 0,
    saving: false
  },

  onLoad() {
    const list = (getApp().globalData.pendingList || []).map(x => ({
      fileID: x.fileID,
      thumbFileID: x.thumbFileID,
      tempPath: x.tempPath,
      tags: normalizeTags(x.tags),
      saved: false,
      skipped: false
    }));
    if (!list.length) {
      wx.showToast({ title: '没有待确认的记录', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ items: list, remaining: list.length });
    this.loadCur(0);
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
    this.loadCur(e.detail.current);
  },

  /** 颜色/种类/风格/用途 点选 */
  toggleTag(e) {
    const { key, value, multi } = e.currentTarget.dataset;
    const tags = this.data.cur.tags;
    if (multi === true || multi === 'true') {
      const arr = tags[key] || [];
      const idx = arr.indexOf(value);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(value);
      this.setData({ ['cur.tags.' + key]: arr });
    } else {
      this.setData({ ['cur.tags.' + key]: tags[key] === value ? '' : value });
    }
    // 标签变化后重算选中态
    this.setData({ dimView: this.buildDimView(this.data.cur.tags) });
  },

  /** 添加花材（输入名称，可识别行业通用名） */
  addFlower(e) {
    const role = e.currentTarget.dataset.role;
    wx.showModal({
      title: '添加' + this.roleName(role),
      editable: true,
      placeholderText: '如：玫瑰、洋桔梗、尤加利叶',
      success: res => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const arr = this.data.cur.tags[role] || [];
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
    const { role, index } = e.currentTarget.dataset;
    const arr = this.data.cur.tags[role] || [];
    arr.splice(Number(index), 1);
    this.setData({ ['cur.tags.' + role]: arr });
  },

  /** 长按花材：调整角色 */
  moveFlower(e) {
    const { role, index } = e.currentTarget.dataset;
    const i = Number(index);
    const others = FLOWER_ROLES.filter(r => r.key !== role);
    wx.showActionSheet({
      itemList: others.map(r => '调整为' + r.name),
      success: res => {
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
    try {
      await api.addRecord({
        fileID: it.fileID,
        thumbFileID: it.thumbFileID || '',
        colors: it.tags.colors,
        colorScheme: it.tags.colorScheme,
        flowersMain: it.tags.flowersMain,
        flowersSub: it.tags.flowersSub,
        flowersLeaf: it.tags.flowersLeaf,
        category: it.tags.category,
        style: it.tags.style,
        occasion: it.tags.occasion,
        confidence: it.tags.confidence
      });
      api.bumpTagUsage(it.tags); // 计数失败不阻塞主流程
      items[i].saved = true;
      this.setData({ items, remaining: this.data.remaining - 1 });
      return true;
    } catch (e) {
      wx.showToast({ title: '保存失败：' + ((e && e.message) || ''), icon: 'none' });
      return false;
    }
  },

  /** 保存本张并跳到下一张未处理的 */
  async saveCurrent() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    const { items, current, cur } = this.data;
    items[current].tags = cur.tags;
    this.setData({ items });
    const saved = await this.saveOne(current);
    this.setData({ saving: false });
    if (saved) this.jumpNext();
  },

  skipCurrent() {
    if (this.data.saving) return;
    const { items, current } = this.data;
    if (!items[current].saved && !items[current].skipped) {
      items[current].skipped = true;
      this.setData({ items, remaining: this.data.remaining - 1 });
    }
    this.jumpNext();
  },

  jumpNext() {
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
    if (this.data.saving) return;
    this.setData({ saving: true });
    const { items, current, cur } = this.data;
    items[current].tags = cur.tags;
    this.setData({ items });
    wx.showLoading({ title: '保存中…' });
    let allSaved = true;
    for (let i = 0; i < items.length; i++) {
      if (!await this.saveOne(i)) allSaved = false;
    }
    wx.hideLoading();
    this.setData({ saving: false });
    if (allSaved) this.finish();
  },

  finish() {
    // 找出所有被跳过（即未保存入库）的图片资源，进行清理释放
    const filesToDelete = [];
    this.data.items.forEach(it => {
      if (it.skipped && !it.saved) {
        if (it.fileID) filesToDelete.push(it.fileID);
        if (it.thumbFileID) filesToDelete.push(it.thumbFileID);
      }
    });
    if (filesToDelete.length > 0) {
      api.deleteCloudFiles(filesToDelete).catch(console.error);
    }
    
    getApp().globalData.pendingList = [];
    getApp().globalData.dbUpdateTime = Date.now();
    wx.showToast({ title: '已入库', icon: 'success' });
    setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
  }
});
