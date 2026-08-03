/* 全局默认分享：包装 Page，未自定义 onShareAppMessage 的页面自动获得"转发给朋友"能力。
 * 注意：
 * 1. 未定义该钩子的页面，胶囊菜单"转发给朋友"是灰色不可点的（微信现行规则）
 * 2. 卡片统一落到首页——records 是"仅创建者可读写"，朋友打开详情页会查不到数据
 * 3. 某页面想自定义卡片，在该页 JS 里写自己的 onShareAppMessage 即可覆盖此默认
 * 4. "被分享"能力还需小程序完成微信认证并发布上线后才会真正生效
 */
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
    pendingList: []
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
