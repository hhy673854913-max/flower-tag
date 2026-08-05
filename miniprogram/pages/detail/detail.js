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
      
      const extraIDs = (record.extraFiles || []).map(f => f.thumbFileID || f.fileID);
      const allIDs = [displayID].concat(extraIDs);
      const map = await api.getTempUrls(allIDs);
      
      this.setData({
        record,
        url: map[displayID] || '',
        extraUrls: extraIDs.map(id => map[id] || ''),
        dimView: this.buildDimView(record)
      });
    } catch (e) {
      wx.showToast({ title: '记录不存在或已删除', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  onSwiperChange(e) {
    this.setData({ currentSwiperIdx: e.detail.current });
  },

  async addExtraImages() {
    if (this.data.editing) return;
    const r = this.data.record;
    const remain = 8 - (r.extraFiles || []).length;
    if (remain <= 0) return;

    try {
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
        // 2. 上传缩略图
        let thumbPath = f.tempFilePath;
        try {
          // 增大压缩强度，确保绝大多数图片缩略图 <= 1MB，以满足 imgSecCheck 接口限制
          const c = await wx.compressImage({ src: f.tempFilePath, quality: 20 });
          thumbPath = c.tempFilePath;
        } catch (e) { }
        const thumbFileID = await api.uploadThumbImage(thumbPath);

        // 3. 安全检测
        const secRes = await api.imgSecCheck(thumbFileID);
        if (!secRes.ok) {
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
      getApp().globalData.dbUpdateTime = Date.now();
      
      wx.hideLoading();
      wx.showToast({ title: '添加成功' });
      this.loadRecord(); // 重新加载
    } catch (err) {
      wx.hideLoading();
      if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
        wx.showToast({ title: '添加失败', icon: 'none' });
      }
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
      getApp().globalData.dbUpdateTime = Date.now();
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
          const r = this.data.record;
          const filesToDelete = [r.fileID, r.thumbFileID];
          (r.extraFiles || []).forEach(f => {
            filesToDelete.push(f.fileID, f.thumbFileID);
          });
          await api.deleteCloudFiles(filesToDelete.filter(Boolean));
          getApp().globalData.dbUpdateTime = Date.now();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        } catch (e) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      }
    });
  },

  /** 查看原图：按需换取原图临时链接后全屏预览（原图体积大，仅此处加载） */
  async previewOriginal(e) {
    if (this.data.loadingOriginal) return;
    const r = this.data.record;
    if (!r) return;
    
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
      const map = await api.getTempUrls(allOriginalIDs);
      const urls = allOriginalIDs.map(id => map[id]).filter(Boolean);
      
      if (urls.length > 0 && urls[targetIdx]) {
        // 提示用户如何返回
        wx.showToast({ title: '轻触图片任意位置返回', icon: 'none', duration: 2000 });
        
        setTimeout(async () => {
          await wx.previewImage({ urls, current: urls[targetIdx] });
          this.setData({ loadingOriginal: false });
        }, 300); //
      } else {
        wx.hideLoading();
        wx.showToast({ title: '原图加载失败', icon: 'none' });
        this.setData({ loadingOriginal: false });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '原图加载失败', icon: 'none' });
      this.setData({ loadingOriginal: false });
    }
  }
});
