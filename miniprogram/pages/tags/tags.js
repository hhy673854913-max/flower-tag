const api = require('../../utils/api');

const DIM_NAMES = {
  flower: '花材',
  color: '颜色',
  colorScheme: '色系',
  category: '种类',
  style: '风格',
  occasion: '用途'
};
const ROLE_NAMES = { main: '主花', sub: '辅花', leaf: '叶材', '': '自定义' };

Page({
  data: {
    groups: [],
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true });
    try {
      await api.requireAccess();
      const tags = await api.listTags();
      const groups = Object.keys(DIM_NAMES).map(dim => ({
        dim,
        name: DIM_NAMES[dim],
        items: tags
          .filter(t => t.dimension === dim)
          .map(t => ({
            _id: t._id,
            name: t.name,
            count: t.count || 0,
            roleName: t.role ? ROLE_NAMES[t.role] : (t.custom ? ROLE_NAMES[''] : ''),
            deletable: !!t.custom
          }))
          .sort((a, b) => b.count - a.count)
      }));
      this.setData({ groups });
    } catch (e) {
      this.setData({ groups: [] });
      console.error(e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
    this.setData({ loading: false });
  },

  addFlower() {
    wx.showModal({
      title: '新增自定义花材',
      editable: true,
      placeholderText: '输入花材名称，如：洛神玫瑰',
      success: async res => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        try {
          const ok = await api.addFlowerTag(name);
          wx.showToast({ title: ok ? '已添加' : '已存在', icon: 'none' });
          this.load();
        } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
      }
    });
  },

  removeTag(e) {
    const { id, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除词条',
      content: `删除「${name}」词条？已有记录上的标签不受影响。`,
      confirmColor: '#c0392b',
      success: async res => {
        if (!res.confirm) return;
        try {
          await api.removeTag(id);
          this.load();
        } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
      }
    });
  }
});
