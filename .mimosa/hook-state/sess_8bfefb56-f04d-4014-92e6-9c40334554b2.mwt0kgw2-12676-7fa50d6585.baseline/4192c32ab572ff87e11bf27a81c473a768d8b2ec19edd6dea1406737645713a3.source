const crypto = require('crypto');

const TYPES = ['bug', 'suggestion', 'recognition', 'account', 'other'];
const DIAGNOSTIC_KEYS = ['version', 'envVersion', 'wechatVersion', 'SDKVersion', 'platform', 'system', 'model'];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

module.exports = function feedbackService({ db, cloud, getAccount, isAdmin }) {
  const records = db.collection('feedbackRecords');
  function reject(message) {
    const error = new Error(message);
    error.feedbackSafe = true;
    throw error;
  }
  function form(event) {
    if (!TYPES.includes(event.type)) reject('请选择有效的反馈类型');
    if (typeof event.content !== 'string') reject('反馈内容必须为文本');
    const content = event.content.trim();
    const length = Array.from(content).length;
    if (!length || length > 1000) reject('反馈内容须为 1～1000 字');
    if (event.phone !== undefined && typeof event.phone !== 'string') reject('反馈手机号格式不正确');
    const phone = event.phone === undefined ? '' : event.phone.trim();
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) reject('请填写正确的 11 位手机号或留空');
    if (typeof event.requestId !== 'string' || event.requestId.length < 16 || event.requestId.length > 64
      || /[^A-Za-z0-9_-]/.test(event.requestId)) {
      reject('反馈请求标识无效，请重新提交');
    }
    return { type: event.type, content, phone };
  }
  function diagnostics(input) {
    const result = { clientReported: true };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
    DIAGNOSTIC_KEYS.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(input, key) || typeof input[key] !== 'string') return;
      const value = input[key].trim();
      if (value && Array.from(value).length <= 128) result[key] = value;
    });
    return result;
  }
  async function existing(collection, id) {
    try {
      return (await collection.doc(id).get()).data || null;
    } catch (error) {
      // Only a missing document is an empty slot; collection/permission errors must fail.
      if (/document.*(not exist|不存在)/i.test(String(error.message || error))) return null;
      throw error;
    }
  }
  function retry(saved, fingerprint, openid, id) {
    if (!saved) return null;
    if (saved.ownerOpenid !== openid || saved.contentFingerprint !== fingerprint) {
      reject('反馈请求标识已用于不同内容，请重新提交');
    }
    return { ok: true, id };
  }
  async function checkContent(content, openid) {
    let result;
    try {
      result = await cloud.openapi.security.msgSecCheck({ content, version: 2, scene: 1, openid });
    } catch (error) {
      if (Number(error && (error.errCode || error.errcode)) === 87014) {
        reject('反馈内容未通过审核，请修改后重试');
      }
      reject('反馈内容审核服务暂不可用，请稍后重试');
    }
    const code = result && (result.errCode !== undefined ? result.errCode : result.errcode);
    if (!result || (code !== undefined && code !== 0)) {
      if (Number(code) === 87014) reject('反馈内容未通过审核，请修改后重试');
      reject('反馈内容审核服务暂不可用，请稍后重试');
    }
    if (!result.result || typeof result.result.suggest !== 'string') {
      reject('反馈内容审核服务暂不可用，请稍后重试');
    }
    if (result.result.suggest !== 'pass') reject('反馈内容未通过审核，请修改后重试');
  }
  return {
    async submitFeedback(event, openid) {
      try {
        if (typeof openid !== 'string' || !openid) reject('无法识别当前微信用户');
        const normalized = form(event);
        const id = digest([openid, event.requestId]);
        const fingerprint = digest([normalized.type, normalized.content, normalized.phone]);
        const previous = retry(await existing(records, id), fingerprint, openid, id);
        if (previous) return previous;
        await checkContent(normalized.content, openid);
        const account = await getAccount(openid);
        const admin = await isAdmin(openid);
        const activated = !!(account && account.activated === true);
        const cleanupPending = !!(account && account.cleanupPending);
        const accountSnapshot = {
          name: account && typeof account.name === 'string' ? Array.from(account.name.trim()).slice(0, 30).join('') : '',
          role: admin ? 'admin' : activated && !cleanupPending ? 'florist' : 'other',
          activated, cleanupPending
        };
        const data = Object.assign({}, normalized, {
          ownerOpenid: openid, userId: openid, accountSnapshot,
          diagnostics: diagnostics(event.diagnostics),
          requestHash: id, contentFingerprint: fingerprint, status: 'new'
        });
        // The fixed-ID read and first write conflict atomically; never write the account.
        return await db.runTransaction(async tx => {
          const collection = tx.collection('feedbackRecords');
          const committed = retry(await existing(collection, id), fingerprint, openid, id);
          if (committed) return committed;
          await collection.doc(id).set({ data: Object.assign({}, data, { createdAt: db.serverDate() }) });
          return { ok: true, id };
        });
      } catch (error) {
        if (error && error.feedbackSafe) return { ok: false, error: error.message };
        const message = String(error && error.message || error);
        if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
          return { ok: false, error: '反馈服务初始化未完成，请联系维护人员检查反馈集合及账号集合' };
        }
        return { ok: false, error: '反馈提交服务暂不可用，请稍后重试' };
      }
    }
  };
};
