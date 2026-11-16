const api = require('../../utils/api');
const { getVersionInfo } = require('../../utils/app-info');

const TYPES = [
  { code: 'bug', label: '功能异常' },
  { code: 'suggestion', label: '使用建议' },
  { code: 'recognition', label: '识别问题' },
  { code: 'account', label: '账号问题' },
  { code: 'other', label: '其他' }
];
let requestSequence = 0;

function normalized(data) {
  const type = TYPES[data.typeIndex];
  return {
    type: type ? type.code : '',
    content: typeof data.content === 'string' ? data.content.trim() : '',
    phone: typeof data.phone === 'string' ? data.phone.trim() : ''
  };
}

function formError(form) {
  if (!TYPES.some(type => type.code === form.type)) return '请选择反馈类型';
  const count = Array.from(form.content).length;
  if (!count) return '请填写反馈内容';
  if (count > 1000) return '反馈内容最多 1000 字，请减少文字后提交';
  if (form.phone && !/^1[3-9]\d{9}$/.test(form.phone)) return '请填写正确的 11 位大陆手机号，或留空';
  return '';
}

function readInfo(name) {
  try {
    const value = typeof wx[name] === 'function' ? wx[name]() : null;
    return value && typeof value === 'object' ? value : {};
  } catch (error) { return {}; }
}

function diagnosticText(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && Array.from(text).length <= 128 ? text : '';
}

function diagnostics() {
  let version = {};
  try { version = getVersionInfo() || {}; } catch (error) { /* 版本采集失败不阻断反馈。 */ }
  const base = readInfo('getAppBaseInfo');
  const device = readInfo('getDeviceInfo');
  const needsLegacy = !diagnosticText(base.version) || !diagnosticText(base.SDKVersion)
    || ['platform', 'system', 'model'].some(key => !diagnosticText(device[key]));
  const legacy = needsLegacy ? readInfo('getSystemInfoSync') : {};
  const candidates = {
    version: version.version, envVersion: version.envVersion,
    wechatVersion: diagnosticText(base.version) || legacy.version,
    SDKVersion: diagnosticText(base.SDKVersion) || legacy.SDKVersion,
    platform: diagnosticText(device.platform) || legacy.platform,
    system: diagnosticText(device.system) || legacy.system,
    model: diagnosticText(device.model) || legacy.model
  };
  const result = {};
  Object.keys(candidates).forEach(key => {
    const text = diagnosticText(candidates[key]);
    if (text) result[key] = text;
  });
  return result;
}

function createRequestId() {
  requestSequence++;
  return 'feedback_' + Date.now().toString(36) + '_' + requestSequence.toString(36)
    + '_' + Math.random().toString(36).slice(2).padEnd(13, '0')
    + Math.random().toString(36).slice(2).padEnd(13, '0');
}

function confirmFeedback(label, phone) {
  return new Promise((resolve, reject) => wx.showModal({
    title: '确认提交反馈',
    content: `反馈类型：${label}\n手机号：${phone || '未填写'}\n\n将提交本次反馈内容，并随附用户标识、账号状态、小程序与微信版本、基础库及设备信息，用于问题排查；填写的手机号仅用于必要联系。反馈不会公开。\n\n确定提交吗？`,
    confirmText: '确认提交', cancelText: '再想想', confirmColor: '#2d6543',
    success: result => resolve(!!result.confirm),
    fail: () => reject(new Error('确认窗口打开失败，内容已保留，请重试'))
  }));
}

Page({
  data: {
    types: TYPES, typeIndex: -1, content: '', contentCount: 0, phone: '',
    confirming: false, submitting: false, error: '', statusNote: '', feedbackId: ''
  },

  onLoad() {
    this._epoch = 0;
    this._visible = false;
    this._destroyed = false;
    this._operation = null;
    this._request = null;
    this._interrupted = false;
  },

  onShow() {
    if (this._destroyed) return;
    this._visible = true;
    this.refreshSubmission();
  },

  onHide() {
    this._visible = false;
    this._epoch++;
    if (this._operation && this._operation.stage === 'confirming') this._operation = null;
    else if (this._operation) this._interrupted = true;
  },

  onUnload() {
    this.onHide();
    this._destroyed = true;
    this._request = null;
    this._operation = null;
    this.data.content = '';
    this.data.phone = '';
  },

  current(operation) {
    return !this._destroyed && this._visible && operation.epoch === this._epoch
      && this._operation === operation;
  },

  ready() {
    return this._visible && !this._destroyed && !this._operation && !this.data.feedbackId;
  },

  refreshSubmission() {
    if (!this._visible || this._destroyed) return;
    const submitting = !!this._operation && this._operation.stage === 'submitting';
    this.setData({
      confirming: !!this._operation && this._operation.stage === 'confirming', submitting,
      statusNote: this._interrupted
        ? submitting
          ? '上一笔请求仍在等待结果，请勿重复发送。可点击下方刷新等待状态。'
          : '离开页面期间未确认提交结果。输入已保留，请重试；相同内容不会重复保存。'
        : ''
    });
  },

  updateForm(fields) {
    const before = JSON.stringify(normalized(this.data));
    const after = JSON.stringify(normalized(Object.assign({}, this.data, fields)));
    if (before !== after) this._request = null;
    this.setData(Object.assign({ error: '' }, fields));
  },

  changeType(e) {
    if (!this.ready()) return;
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= TYPES.length) return;
    this.updateForm({ typeIndex: index });
  },

  inputField(e) {
    if (!this.ready()) return;
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    if ((field !== 'content' && field !== 'phone') || typeof value !== 'string') return;
    this.updateForm(field === 'content'
      ? { content: value, contentCount: Array.from(value.trim()).length }
      : { phone: value });
  },

  async submit() {
    if (!this.ready()) return;
    const form = normalized(this.data);
    const error = formError(form);
    if (error) { this.setData({ error }); return; }
    const canonical = JSON.stringify(form);
    if (!this._request || this._request.canonical !== canonical) {
      this._request = { canonical, id: createRequestId() };
    }
    // 确认窗口和云请求共用锁定快照；输入事件不能改变本笔提交。
    const snapshot = Object.assign({}, form, { requestId: this._request.id, diagnostics: diagnostics() });
    const operation = { epoch: this._epoch, stage: 'confirming' };
    this._operation = operation;
    this.setData({ confirming: true, submitting: false, error: '', statusNote: '' });
    try {
      const accepted = await confirmFeedback(TYPES[this.data.typeIndex].label, snapshot.phone);
      if (!this.current(operation) || !accepted) return;
      operation.stage = 'submitting';
      this.setData({ confirming: false, submitting: true });
      const result = await api.submitFeedback(snapshot);
      if (!this.current(operation)) return;
      if (!result || result.ok !== true || typeof result.id !== 'string' || !result.id.trim()) {
        throw new Error(result && result.error || '提交结果暂无法确认，内容已保留，请重试');
      }
      this._request = null;
      this._interrupted = false;
      this.setData({
        feedbackId: result.id, typeIndex: -1, content: '', contentCount: 0, phone: '',
        error: '', statusNote: ''
      });
    } catch (error) {
      if (this.current(operation)) {
        this.setData({ error: error && error.message || '反馈提交失败，内容已保留，请重试' });
      }
    } finally {
      if (this.current(operation)) this.setData({ confirming: false, submitting: false });
      // 隐藏后只释放内部锁，不把旧响应写回已重新显示的页面。
      if (this._operation === operation) this._operation = null;
    }
  },

  continueFeedback() {
    if (!this._visible || this._destroyed || this._operation || !this.data.feedbackId) return;
    this._request = null;
    this._interrupted = false;
    this.setData({
      feedbackId: '', typeIndex: -1, content: '', contentCount: 0, phone: '',
      error: '', statusNote: '', confirming: false, submitting: false
    });
  },

  goMy() {
    if (!this._visible || this._destroyed || this._operation) return;
    const epoch = this._epoch;
    try {
      wx.switchTab({
        url: '/pages/my/my',
        fail: () => {
          if (this._visible && !this._destroyed && epoch === this._epoch) {
            this.setData({ error: '「我的」暂时无法打开，请重试' });
          }
        }
      });
    } catch (error) {
      if (this._visible && !this._destroyed && epoch === this._epoch) {
        this.setData({ error: '「我的」暂时无法打开，请重试' });
      }
    }
  }
});
