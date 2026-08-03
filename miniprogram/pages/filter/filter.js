const api = require('../../utils/api');
const { DIMENSIONS } = require('../../utils/tagdict');

const ROLE_TABS = [
  { key: 'any', name: '任意位置' },
  { key: 'main', name: '作为主花' },
  { key: 'sub', name: '作为辅花' },
  { key: 'leaf', name: '作为叶材' }
];

Page({
  data: {
    dims: [],          // [{ key, name, options:[{name,count,on}] }]
    flowers: [],       // [{ name, main, sub, leaf, on }]
    roleTabs: ROLE_TABS,
    roleMode: 'any',
    records: [],
    results: [],
    loading: true,
    hasFilter: false
  },

  onShow() {
    this.loadAll();
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const records = await api.fetchAllRecords();
      this.setData({ records });
      this.aggregate();
      this.compute();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  /** 从全部记录聚合各维度标签及使用次数 */
  aggregate() {
    const keep = this.snapshotSelection();
    const countMap = {};
    DIMENSIONS.forEach(d => (countMap[d.key] = {}));
    const flowerMap = {};

    this.data.records.forEach(r => {
      (r.colors || []).forEach(n => this.inc(countMap.colors, n));
      if (r.colorScheme) this.inc(countMap.colorScheme, r.colorScheme);
      if (r.category) this.inc(countMap.category, r.category);
      if (r.style) this.inc(countMap.style, r.style);
      (r.occasion || []).forEach(n => this.inc(countMap.occasion, n));
      (r.flowersMain || []).forEach(n => this.incFlower(flowerMap, n, 'main'));
      (r.flowersSub || []).forEach(n => this.incFlower(flowerMap, n, 'sub'));
      (r.flowersLeaf || []).forEach(n => this.incFlower(flowerMap, n, 'leaf'));
    });

    const dims = DIMENSIONS.map(d => ({
      key: d.key,
      name: d.name,
      options: Object.keys(countMap[d.key])
        .map(name => ({ name, count: countMap[d.key][name], on: !!(keep[d.key] && keep[d.key][name]) }))
        .sort((a, b) => b.count - a.count)
    }));

    const flowers = Object.keys(flowerMap)
      .map(name => ({
        name,
        main: flowerMap[name].main || 0,
        sub: flowerMap[name].sub || 0,
        leaf: flowerMap[name].leaf || 0,
        on: !!(keep.flowers && keep.flowers[name])
      }))
      .sort((a, b) => (b.main + b.sub + b.leaf) - (a.main + a.sub + a.leaf));

    this.setData({ dims, flowers });
  },

  inc(map, name) { map[name] = (map[name] || 0) + 1; },
  incFlower(map, name, role) {
    if (!map[name]) map[name] = {};
    map[name][role] = (map[name][role] || 0) + 1;
  },

  /** 聚合后保留用户已选状态 */
  snapshotSelection() {
    const sel = {};
    (this.data.dims || []).forEach(d => {
      d.options.forEach(o => {
        if (o.on) {
          if (!sel[d.key]) sel[d.key] = {};
          sel[d.key][o.name] = true;
        }
      });
    });
    (this.data.flowers || []).forEach(f => {
      if (f.on) {
        if (!sel.flowers) sel.flowers = {};
        sel.flowers[f.name] = true;
      }
    });
    return sel;
  },

  toggleDim(e) {
    const { dim, index } = e.currentTarget.dataset;
    const key = `dims[${dim}].options[${index}].on`;
    this.setData({ [key]: !this.data.dims[dim].options[index].on });
    this.compute();
  },

  toggleFlower(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ [`flowers[${i}].on`]: !this.data.flowers[i].on });
    this.compute();
  },

  setRoleMode(e) {
    this.setData({ roleMode: e.currentTarget.dataset.mode });
    this.compute();
  },

  clearAll() {
    const dims = this.data.dims.map(d => ({
      key: d.key, name: d.name,
      options: d.options.map(o => ({ name: o.name, count: o.count, on: false }))
    }));
    const flowers = this.data.flowers.map(f => ({ name: f.name, main: f.main, sub: f.sub, leaf: f.leaf, on: false }));
    this.setData({ dims, flowers, roleMode: 'any' });
    this.compute();
  },

  /** 同维度内「或」，跨维度「与」 */
  compute() {
    const sel = this.snapshotSelection();
    const dimKeys = Object.keys(sel).filter(k => k !== 'flowers');
    const flowerSel = sel.flowers ? Object.keys(sel.flowers) : [];
    const hasFilter = dimKeys.length > 0 || flowerSel.length > 0;
    const role = this.data.roleMode;

    const matched = this.data.records.filter(r => {
      for (const key of dimKeys) {
        const wanted = Object.keys(sel[key]);
        const val = r[key];
        const arr = Array.isArray(val) ? val : (val ? [val] : []);
        if (!wanted.some(w => arr.indexOf(w) >= 0)) return false;
      }
      if (flowerSel.length) {
        let pool;
        if (role === 'main') pool = r.flowersMain || [];
        else if (role === 'sub') pool = r.flowersSub || [];
        else if (role === 'leaf') pool = r.flowersLeaf || [];
        else pool = (r.flowersMain || []).concat(r.flowersSub || [], r.flowersLeaf || []);
        if (!flowerSel.some(f => pool.indexOf(f) >= 0)) return false;
      }
      return true;
    });

    this.setData({ hasFilter, results: matched.slice(0, 60) });
    this.resolveUrls(matched.slice(0, 60));
  },

  async resolveUrls(list) {
    if (!list.length) return;
    try {
      const map = await api.getTempUrls(list.map(r => r.thumbFileID || r.fileID)); // 展示用缩略图，旧记录回退原图
      const results = list.map(r => ({
        _id: r._id,
        url: map[r.thumbFileID || r.fileID] || '',
        desc: [r.category, (r.flowersMain || [])[0], r.style].filter(Boolean).join(' · ')
      }));
      this.setData({ results });
    } catch (e) { console.error(e); }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  }
});
