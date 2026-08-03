const api = require('../../utils/api');
const { DIMENSIONS, FLOWER_ROLES } = require('../../utils/tagdict');

Page({
  data: {
    record: null,
    url: '',
    editing: false,
    dimView: [],   // 各维度选项 + 选中态（WXML 不支持 indexOf 等方法调用，选中态必须在 JS 预计算）
    roles: FLOWER_ROLES,
    saving: false,
    loadingOriginal: false   // "查看原图"按钮加载态
  },

  async onLoad(query) {
    this.id = query.id;
    await this.loadRecord();
  },

  async loadRecord() {
    try {
      const record = await api.getRecord(this.id);
      // 详情页默认展示缩略图（旧记录没有 thumbFileID，回退原图）；原图点"查看原图"时才加载
      const displayID = record.thumbFileID || record.fileID;
      const map = await api.getTempUrls([displayID]);
      this.setData({
        record,
        url: map[displayID] || '',
        dimView: this.buildDimView(record)
      });
    } catch (e) {
      wx.showToast({ title: '记录不存在或已删除', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  toggleEdit() {
    this.setData({ editing: !this.data.editing });
  },

  /** 由当前记录计算各维度每个选项的选中态 */
  buildDimView(record) {
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
    if (!this.data.editing) return;
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
    if (!this.data.editing) return;
    const role = e.currentTarget.dataset.role;
    wx.showModal({
      title: '添加花材',
      editable: true,
      placeholderText: '如：玫瑰、洋桔梗',
      success: res => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const arr = (this.data.record[role] || []).slice();
        if (arr.indexOf(name) < 0) arr.push(name);
        this.setData({ ['record.' + role]: arr });
      }
    });
  },

  removeFlower(e) {
    if (!this.data.editing) return;
    const { role, index } = e.currentTarget.dataset;
    const arr = (this.data.record[role] || []).slice();
    arr.splice(Number(index), 1);
    this.setData({ ['record.' + role]: arr });
  },

  moveFlower(e) {
    if (!this.data.editing) return;
    const { role, index } = e.currentTarget.dataset;
    const i = Number(index);
    const others = FLOWER_ROLES.filter(r => r.key !== role);
    wx.showActionSheet({
      itemList: others.map(r => '调整为' + r.name),
      success: res => {
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
    if (this.data.saving) return;
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
      this.setData({ editing: false });
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
    this.setData({ saving: false });
  },

  remove() {
    wx.showModal({
      title: '删除记录',
      content: '将同时删除云端图片与标签，不可恢复，确定吗？',
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm) return;
        try {
          await api.removeRecord(this.id);
          await api.deleteCloudFiles([this.data.record.fileID, this.data.record.thumbFileID].filter(Boolean));
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  /** 查看原图：按需换取原图临时链接后全屏预览（原图体积大，仅此处加载） */
  async previewOriginal() {
    if (this.data.loadingOriginal) return;
    const r = this.data.record;
    if (!r) return;
    this.setData({ loadingOriginal: true });
    wx.showLoading({ title: '加载原图…', mask: true });
    try {
      const map = await api.getTempUrls([r.fileID]);
      const url = map[r.fileID];
      if (url) {
        await wx.previewImage({ urls: [url] });
      } else {
        wx.showToast({ title: '原图加载失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '原图加载失败', icon: 'none' });
    }
    wx.hideLoading();
    this.setData({ loadingOriginal: false });
  }
});
