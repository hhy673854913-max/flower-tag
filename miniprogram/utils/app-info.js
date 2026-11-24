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
  '新增关于页面、共享运行版本信息、产品历史与隐私说明。',
  '筛选页支持折叠条件，并可在结果末尾多选作品创建精选集。',
  '新增极简花艺名片，展示名字与作品数，并连接作品集分享。',
  '作品墙的作品卡片与总数分别加载，切换 Tab 时复用会话数据。',
  '上传增加任务登记、幂等保存与未保存图片回收。',
  '新增四类可配置公告：新用户欢迎、待开通提醒、全员每次与全员首次。',
  '筛选结果支持触底加载，未开通或无作品时提供开通与上传入口。',
  '详情区分缩略图预览与原图预览，缩略图上传前自动降尺寸。'
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
