const { getVersionInfo } = require('../../utils/app-info');
const onboarding = require('../../utils/onboarding');

const PRIVACY_CONTENT = [
  '作品与标签存储在应用的微信云环境中，按用户身份隔离，并非你的个人微信云盘。应用按后台配置使用 Qwen 或 Kimi 进行 AI 图片分析。',
  '作品仅在你明确授权单件或作品集分享后供接收方只读访问。停止分享、删除或撤销权限后，后续访问需重新校验；已下载的图片和仍有效的临时图片 URL 无法追溯收回。',
  '意见反馈需选择类型并填写内容，手机号选填。反馈同时附带真实用户标识、服务端账号状态及客户端上报的基础版本／设备诊断信息，用于问题排查及必要联系，反馈不公开。',
  '不读取你的手机号码或微信个人资料，不请求微信手机号、头像昵称、定位或通讯录授权。请勿在反馈内容中填写校验码、密码或其他无关敏感信息。',
  '本弹窗仅作应用内说明，不替代微信后台的「用户隐私保护指引」配置。'
].join('\n\n');

Page({
  data: {
    version: '',
    envVersion: '',
    isLocal: true,
    versionLabel: '',
    environmentLabel: '',
    updates: [],
    developmentUpdates: [],
    history: []
  },

  onShow() {
    onboarding.pageShow(this);
    onboarding.maybePresent(this);
    const info = getVersionInfo();
    const environments = { develop: '开发版', trial: '体验版', release: '正式版', local: '本地环境' };
    this.setData(Object.assign({}, info, {
      environmentLabel: environments[info.envVersion] || `运行环境：${info.envVersion}`
    }));
  },

  onHide() { onboarding.pageHide(this); },
  onUnload() { onboarding.pageHide(this); },

  showPrivacy() {
    if (this._privacyOpening) return;
    this._privacyOpening = true;
    wx.showModal({
      title: '隐私与数据说明',
      content: PRIVACY_CONTENT,
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#2d6543',
      fail: () => wx.showToast({ title: '说明窗口打开失败，请重试', icon: 'none' }),
      complete: () => { this._privacyOpening = false; }
    });
  }
});
