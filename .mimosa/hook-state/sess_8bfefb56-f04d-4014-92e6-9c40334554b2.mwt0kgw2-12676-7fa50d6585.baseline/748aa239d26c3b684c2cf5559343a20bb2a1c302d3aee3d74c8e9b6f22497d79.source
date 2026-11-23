const PRODUCT_BASELINE = '1.5.0';

// Product records are not proof that every historical module exists in this checkout.
const HISTORY = [
  {
    version: '1.5.0',
    updates: [
      '新用户准入由审核改为校验码，减少等待与逐人审核。',
      '管理员线下发码，用户开通一次后自动识别花艺师身份。'
    ]
  },
  {
    version: '1.4.0',
    updates: ['花艺师名片页上线，支持创作者信息展示。', '完善高级操作方式与列表分享。']
  },
  {
    version: '1.3.0',
    updates: [
      '优化界面与 Tab 切换体验，采用自定义 TabBar 与脏标记。',
      '采用审核准入，建立三类用户与花艺师管理。',
      '支持单件作品分享。'
    ]
  },
  {
    version: '1.2.0',
    updates: [
      '支持同一作品的附加图，最多 8 张。',
      '补充内容安全拦截、游离文件清理与双存储策略。'
    ]
  }
];

const DEVELOPMENT_UPDATES = [
  '新增独立作品集分享：全部作品或精选作品，支持管理与停止链接。',
  '新增作品集标题与描述编辑，原链接重新打开可读取最新文本。',
  '新增意见反馈：问题类型、反馈内容与选填手机号，提交前确认。',
  '新增关于页面、共享运行版本信息、产品历史与隐私说明。'
];

function boundedString(value) {
  return typeof value === 'string' && Array.from(value.trim()).length <= 128 ? value.trim() : '';
}

function getVersionInfo() {
  let runtime = {};
  try {
    if (typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function') {
      const account = wx.getAccountInfoSync();
      runtime = account && account.miniProgram || {};
    }
  } catch (error) {
    runtime = {};
  }
  const actualVersion = boundedString(runtime.version);
  const envVersion = boundedString(runtime.envVersion) || 'local';
  const isLocal = !actualVersion;
  const version = actualVersion || PRODUCT_BASELINE;
  const history = HISTORY.map(item => ({ version: item.version, updates: item.updates.slice() }));
  const known = history.find(item => item.version === version);
  return {
    version,
    envVersion,
    isLocal,
    versionLabel: isLocal ? '本地构建 / 产品基线 v1.5.0' : `v${version}`,
    updates: known ? known.updates.slice() : ['该版本暂无已记录的更新内容'],
    developmentUpdates: isLocal || envVersion === 'develop' || envVersion === 'trial'
      ? DEVELOPMENT_UPDATES.slice() : [],
    history
  };
}

module.exports = { getVersionInfo };
