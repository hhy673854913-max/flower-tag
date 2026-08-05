// app.js
const _Page = Page;
Page = function (config) {
  if (!config.onShareAppMessage) {
    config.onShareAppMessage = function () {
      return {
        title: '花艺图库｜花艺作品 AI 打标与检索',
        path: '/pages/index/index'
      };
    };
  }
  return _Page(config);
};

App({
  globalData: {
    // 微信云开发环境 ID，部署时替换为你自己的环境 ID
    envId: 'florist-prod-d4gtxxh7s9a071ff0',
    // 上传流程中待确认的分析结果（上传页 → 确认页 传递）
    pendingList: [],
    // 记录数据库最后更新时间，用于优化 Tab 页面按需刷新
    dbUpdateTime: Date.now()
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('当前微信版本过低，请升级后使用云开发能力');
      return;
    }
    wx.cloud.init({
      env: this.globalData.envId,
      traceUser: true
    });
  }
});
