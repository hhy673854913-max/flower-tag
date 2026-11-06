const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const accounts = db.collection('accessAccounts');
const works = db.collection('records');
const TAG_KEYS = ['colors', 'colorScheme', 'flowersMain', 'flowersSub', 'flowersLeaf',
  'category', 'style', 'occasion', 'confidence'];

async function isAdmin(openid) {
  if (!openid) return false;
  if ((process.env.ADMIN_OPENIDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(openid)) return true;
  try {
    // 管理员集合由控制台维护；匹配真实微信 OPENID，不使用文档 _id 或客户端角色。
    const result = await db.collection('admins').where({ openid }).limit(1).get();
    return result.data.length > 0;
  } catch (error) {
    const message = String(error.message || error);
    // 兼容仅配置环境变量、尚未创建 admins 的旧环境；其他读取失败不降级身份。
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) return false;
    fail('暂时无法确认管理员身份，请稍后重试');
  }
}

function fail(message) { throw new Error(message); }
function hash(value) { return crypto.createHash('sha256').update(value).digest(); }
function filePrefix(openid) { return 'userFiles/' + hash(openid).toString('hex') + '/'; }
function owner(record) { return record._openid || record.ownerOpenid; }
function ownedWhere(openid) {
  return db.command.or([
    { _openid: openid },
    { ownerOpenid: openid, _openid: db.command.exists(false) }
  ]);
}
function usable(account, admin) {
  return admin || !!(account && account.activated === true && !account.cleanupPending);
}
async function getAccount(openid) {
  const result = await accounts.where({ _id: openid }).limit(1).get();
  return result.data[0] || null;
}
function publicStatus(account, openid, admin) {
  const active = usable(account, admin);
  return {
    ok: true, activated: active, isAdmin: admin,
    role: admin ? 'admin' : active ? 'florist' : 'other',
    name: account && account.name || '',
    cleanupPending: !!(account && account.cleanupPending),
    canUpload: active, canShare: active,
    filePrefix: active ? filePrefix(openid) : ''
  };
}
function normalizedCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}
function legacyEncryptionKey() {
  const secret = process.env.ACCESS_CODE_ENCRYPTION_KEY || '';
  return secret.length >= 32 ? hash(secret) : null;
}
// 支持直接配置多组校验码与名额：1125(10)\A2094(2)
function accessCodePools() {
  const raw = (process.env.ACCESS_CODES || '').trim();
  if (!raw) return null;
  const entries = raw.split(/[\\\r\n,;，；]+/).map(item => item.trim()).filter(Boolean);
  if (!entries.length) fail('校验码尚未配置，请联系管理员');
  const pools = {};
  entries.forEach(item => {
    const match = /^(.+)\((\d+)\)$/.exec(item);
    if (!match) fail('校验码配置格式无效，请检查 ACCESS_CODES');
    const code = normalizedCode(match[1]);
    const limit = Number(match[2]);
    if (!code || !Number.isSafeInteger(limit) || limit <= 0) fail('校验码配置格式无效，请检查 ACCESS_CODES');
    pools[code] = { code, limit };
  });
  return pools;
}
function legacyCodeMatches(code) {
  const expected = (process.env.ACCESS_CODE_HASH || '').trim().toLowerCase();
  if (!expected) return false;
  if (!/^[a-f0-9]{64}$/.test(expected)) fail('校验码尚未配置，请联系管理员');
  return code.length >= 12 && code.length <= 64
    && crypto.timingSafeEqual(hash(code), Buffer.from(expected, 'hex'));
}
function matchedAccessCode(code) {
  const pools = accessCodePools();
  if (pools) return pools[code] || null;
  if (legacyCodeMatches(code)) return { code, limit: 0 };
  if ((process.env.ACCESS_CODE_HASH || '').trim()) return null;
  fail('校验码尚未配置，请联系管理员');
}
function revealCode(record) {
  if (!record) return '历史未记录';
  if (record.accessCode) return record.accessCode;
  if (!record.encryptedCode) return '历史未记录';
  const key = legacyEncryptionKey();
  if (!key) return '历史未记录';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.encryptedCode.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(record.encryptedCode.tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(record.encryptedCode.data, 'hex')), decipher.final()]).toString('utf8');
  } catch (_) { return '无法解密，请检查历史加密配置'; }
}
async function checkedName(value, openid) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 30) fail('请填写 1～30 字的花艺师名字');
  // 名字会出现在管理员列表和分享页；文本审核失败时不写入。
  const result = await cloud.openapi.security.msgSecCheck({ content: name, version: 2, scene: 1, openid });
  if (result.errCode || (result.result && result.result.suggest !== 'pass')) fail('名字未通过内容审核，请修改后重试');
  return name;
}
async function transactionAccount(tx, openid) {
  try {
    return (await tx.collection('accessAccounts').doc(openid).get()).data;
  } catch (error) {
    if (/document.*(not exist|不存在)/i.test(String(error.message || error))) return null;
    throw error;
  }
}
async function activatedCodeUsage(tx, code) {
  return (await tx.collection('accessAccounts').where({ activated: true, accessCode: code }).count()).total;
}
function accountData(account, patch) {
  const data = Object.assign({}, account || {}, patch);
  delete data._id;
  return data;
}
// 所有业务写入均写同一账号文档，与管理员撤销形成事务冲突，避免撤销后仍提交成功。
async function userWrite(openid, operation) {
  return db.runTransaction(async tx => {
    const account = await transactionAccount(tx, openid);
    if (!usable(account, await isAdmin(openid))) fail('请先在「我的」输入校验码成为花艺师');
    await tx.collection('accessAccounts').doc(openid).set({
      data: accountData(account, { writeVersion: (account && account.writeVersion || 0) + 1 })
    });
    return operation(tx, account);
  });
}
function pickTags(input) {
  const result = {};
  TAG_KEYS.forEach(key => { if (input[key] !== undefined) result[key] = input[key]; });
  return result;
}
function assertFile(fileID, openid) {
  if (typeof fileID !== 'string' || !fileID.startsWith('cloud://')
    || fileID.slice(fileID.indexOf('/') + 2).indexOf('/' + filePrefix(openid)) < 0) {
    fail('图片不属于当前账号，请重新上传');
  }
}
function recordFiles(record) {
  return [...new Set([record.fileID, record.thumbFileID]
    .concat((record.extraFiles || []).reduce((ids, item) => ids.concat(item.fileID, item.thumbFileID), []))
    .filter(id => typeof id === 'string' && id.startsWith('cloud://')))];
}
async function deleteFiles(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const result = await cloud.deleteFile({ fileList: ids.slice(i, i + 50) });
    if (!result.fileList || result.fileList.some(item =>
      item.status !== 0 && !/not.?exist|not.?found|不存在/i.test(item.errMsg || ''))) {
      fail('图片清理未完成，请重试');
    }
  }
}
async function ownedRecord(id, openid, collection = works) {
  if (typeof id !== 'string' || !id) fail('作品参数无效');
  const result = await collection.doc(id).get();
  if (!result.data || owner(result.data) !== openid) fail('无权操作该作品');
  return result.data;
}
async function cleanupBatch(openid) {
  const lease = crypto.randomBytes(12).toString('hex');
  const acquired = await db.runTransaction(async tx => {
    const account = await transactionAccount(tx, openid);
    if (!account || !account.cleanupPending) return false;
    if (account.cleanupLeaseUntil > Date.now()) fail('已有清理任务运行中，请一分钟后重试');
    await tx.collection('accessAccounts').doc(openid).update({
      data: { cleanupLease: lease, cleanupLeaseUntil: Date.now() + 60 * 1000 }
    });
    return true;
  });
  if (!acquired) return { ok: true, hasMore: false, deleted: 0 };
  try {
  // 每次最多 10 件，前端连续调用；图片先删，记录后删，失败仍保留可重试的引用。
  const result = await works.where(ownedWhere(openid)).limit(10).get();
  for (const record of result.data) {
    await deleteFiles(recordFiles(record));
    await works.doc(record._id).remove();
  }
  const remaining = await works.where(ownedWhere(openid)).limit(1).get();
  if (remaining.data.length) return { ok: true, hasMore: true, deleted: result.data.length };
  const tags = await db.collection('tags').where(ownedWhere(openid)).limit(100).get();
  for (const tag of tags.data) await db.collection('tags').doc(tag._id).remove();
  if (tags.data.length === 100) return { ok: true, hasMore: true, deleted: result.data.length };
  await accounts.doc(openid).update({ data: { cleanupPending: false, cleanedAt: db.serverDate() } });
  return { ok: true, hasMore: false, deleted: result.data.length };
  } finally {
    await db.runTransaction(async tx => {
      const account = await transactionAccount(tx, openid);
      if (account && account.cleanupLease === lease) {
        await tx.collection('accessAccounts').doc(openid).update({ data: { cleanupLease: '', cleanupLeaseUntil: 0 } });
      }
    });
  }
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, error: '无法识别当前微信用户' };
  const action = event.action;
  try {
    const admin = await isAdmin(openid);
    if (action === 'status') return publicStatus(await getAccount(openid), openid, admin);
    if (action === 'redeem') {
      const existing = await getAccount(openid);
      if (usable(existing, admin)) return publicStatus(existing, openid, admin);
      if (existing && existing.cleanupPending) fail('管理员正在清理旧作品，请稍后再开通');
      const code = normalizedCode(event.code);
      // 无效校验码也使用事务累计，避免并发请求绕过五次限制。
      const matched = matchedAccessCode(code);
      let name;
      if (matched) {
        name = await checkedName(event.name, openid);
      }
      return await db.runTransaction(async tx => {
        const account = await transactionAccount(tx, openid);
        const currentAdmin = await isAdmin(openid);
        if (usable(account, currentAdmin)) return publicStatus(account, openid, currentAdmin);
        if (account && account.cleanupPending) fail('旧作品清理未完成，请稍后再试');
        if (account && account.lockUntil > Date.now()) fail('尝试次数过多，请 15 分钟后再试');
        if (matched && matched.limit > 0 && await activatedCodeUsage(tx, matched.code) >= matched.limit) {
          fail('该校验码名额已用完，请联系管理员');
        }
        const failures = (account && account.failures || 0) + 1;
        const data = matched
          ? { activated: true, name, accessCode: matched.code, activatedAt: db.serverDate(),
            failures: 0, lockUntil: 0, cleanupPending: false }
          : { activated: false, failures: failures >= 5 ? 0 : failures,
            lockUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 };
        await tx.collection('accessAccounts').doc(openid).set({ data: accountData(account, data) });
        return matched ? publicStatus(data, openid, currentAdmin) : { ok: false, error: '校验码不正确，请检查后重试' };
      });
    }
    if (action === 'updateName') {
      const name = await checkedName(event.name, openid);
      await userWrite(openid, tx => tx.collection('accessAccounts').doc(openid).update({ data: { name } }));
      return { ok: true, name };
    }
    if (action === 'list') {
      if (!admin) fail('无权查看花艺师列表');
      const skip = Math.max(0, Math.floor(Number(event.skip) || 0));
      const result = await accounts.where({ activated: true }).orderBy('activatedAt', 'desc').skip(skip).limit(20).get();
      const pending = await accounts.where({ cleanupPending: true }).skip(skip).limit(20).get();
      const candidates = pending.data.concat(result.data).filter((item, index, all) =>
        all.findIndex(row => row._id === item._id) === index);
      const adminFlags = await Promise.all(candidates.map(item => isAdmin(item._id)));
      return {
        ok: true, nextSkip: skip + 20, hasMore: result.data.length === 20 || pending.data.length === 20,
        records: candidates.filter((item, index) => !adminFlags[index]).map(item => ({
          id: item._id, name: item.name || '未填写名字（历史账号）',
          code: revealCode(item), activatedAt: item.activatedAt,
          cleanupPending: !!item.cleanupPending
        }))
      };
    }
    if (action === 'revoke') {
      if (!admin) fail('无权撤销花艺师权限');
      const target = event.id;
      if (typeof target !== 'string' || !target || await isAdmin(target)) fail('不能撤销管理员权限');
      await db.runTransaction(async tx => {
        const account = await transactionAccount(tx, target);
        if (!account) fail('花艺师账号不存在');
        if (account.cleanupPending) return;
        await tx.collection('accessAccounts').doc(target).set({
          data: accountData(account, { activated: false, cleanupPending: true,
            revokedAt: db.serverDate(), revokedBy: openid,
            writeVersion: (account.writeVersion || 0) + 1 })
        });
      });
      return await cleanupBatch(target);
    }
    if (action === 'cleanup') {
      if (!admin || typeof event.id !== 'string' || !event.id || await isAdmin(event.id)) fail('无权清理该账号');
      const account = await getAccount(event.id);
      if (!account || !account.cleanupPending) return { ok: true, hasMore: false, deleted: 0 };
      return await cleanupBatch(event.id);
    }
    if (action === 'readShared') {
      if (typeof event.token !== 'string' || !/^[a-f0-9]{48}$/.test(event.token)) fail('作品分享已失效');
      const result = await works.where({ shareToken: event.token, isPublic: true }).limit(1).get();
      const record = result.data[0];
      if (!record) fail('作品分享已失效');
      const account = await getAccount(owner(record));
      if (!usable(account, await isAdmin(owner(record))) || record.deleting) fail('作品分享已失效');
      // 返回展示白名单，避免把作者 openid、校验码和分享管理字段发给访客。
      const files = recordFiles(record);
      const urls = await cloud.getTempFileURL({ fileList: files });
      return { ok: true, name: account && account.name || '花艺师',
        record: Object.assign(pickTags(record), { _id: record._id, fileID: record.fileID,
          thumbFileID: record.thumbFileID, extraFiles: record.extraFiles || [] }),
        urls: urls.fileList.reduce((map, file) => { if (file.status === 0) map[file.fileID] = file.tempFileURL; return map; }, {}) };
    }

    const account = await getAccount(openid);
    if (!usable(account, admin)) {
      if (action === 'listRecords' || action === 'listTags') return { ok: true, records: [] };
      if (action === 'countRecords') return { ok: true, total: 0 };
      fail('请先在「我的」输入校验码成为花艺师');
    }
    if (action === 'saveRecord') {
      const input = event.record || {};
      assertFile(input.fileID, openid);
      if (input.thumbFileID) assertFile(input.thumbFileID, openid);
      const result = await userWrite(openid, tx => tx.collection('records').add({
        data: Object.assign(pickTags(input), { fileID: input.fileID, thumbFileID: input.thumbFileID || '',
          _openid: openid, createdAt: db.serverDate(), isPublic: false })
      }));
      return { ok: true, id: result._id };
    }
    if (action === 'listRecords') {
      const result = await works.where(ownedWhere(openid)).orderBy('createdAt', 'desc')
        .skip(Math.max(0, Math.floor(Number(event.skip) || 0)))
        .limit(Math.max(1, Math.min(100, Math.floor(Number(event.limit) || 100)))).get();
      return { ok: true, records: result.data };
    }
    if (action === 'countRecords') {
      const result = await works.where(ownedWhere(openid)).count();
      return { ok: true, total: result.total };
    }
    if (action === 'getRecord') {
      const record = await ownedRecord(event.id, openid);
      if (record.deleting) fail('作品正在删除');
      return { ok: true, record };
    }
    if (action === 'updateRecord' || action === 'shareRecord') {
      const result = await userWrite(openid, async tx => {
        const collection = tx.collection('records');
        const record = await ownedRecord(event.id, openid, collection);
        if (record.deleting) fail('作品正在删除');
        let data = pickTags(event.tags || {});
        if (event.extraFiles !== undefined) {
          if (!Array.isArray(event.extraFiles) || event.extraFiles.length > 8) fail('附加图最多 8 张');
          event.extraFiles.forEach(file => {
            const old = (record.extraFiles || []).some(item => item.fileID === file.fileID && item.thumbFileID === file.thumbFileID);
            if (!old) { assertFile(file.fileID, openid); if (file.thumbFileID) assertFile(file.thumbFileID, openid); }
          });
          data.extraFiles = event.extraFiles.map(file => ({ fileID: file.fileID, thumbFileID: file.thumbFileID || '' }));
        }
        if (action === 'shareRecord') data = { isPublic: event.enabled === true,
          shareToken: event.enabled === true ? record.shareToken || crypto.randomBytes(24).toString('hex') : '' };
        await collection.doc(event.id).update({ data });
        return data;
      });
      return Object.assign({ ok: true }, result);
    }
    if (action === 'removeRecord') {
      const record = await userWrite(openid, async tx => {
        const record = await ownedRecord(event.id, openid, tx.collection('records'));
        await tx.collection('records').doc(event.id).update({ data: { deleting: true, isPublic: false, shareToken: '' } });
        return record;
      });
      await deleteFiles(recordFiles(record));
      await works.doc(event.id).remove();
      return { ok: true };
    }
    if (action === 'listTags') {
      const result = await db.collection('tags').where(ownedWhere(openid))
        .skip(Math.max(0, Math.floor(Number(event.skip) || 0))).limit(100).get();
      return { ok: true, records: result.data };
    }
    if (action === 'addFlowerTag' || action === 'removeTag' || action === 'bumpTags') {
      // 词库计数由作品聚合；自定义花材才单独存入 tags，避免跨用户计数写入。
      if (action === 'bumpTags') return { ok: true };
      if (action === 'addFlowerTag') {
        const name = await checkedName(event.name, openid);
        const existing = await db.collection('tags').where({ _openid: openid, name, custom: true }).limit(1).get();
        if (existing.data.length) return { ok: true, added: false };
        await userWrite(openid, tx => tx.collection('tags').add({
          data: { _openid: openid, dimension: 'flower', name, custom: true, count: 0, createdAt: db.serverDate() }
        }));
        return { ok: true, added: true };
      }
      await userWrite(openid, async tx => {
        const tag = await ownedRecord(event.id, openid, tx.collection('tags'));
        if (!tag.custom) fail('只能删除自定义词条');
        await tx.collection('tags').doc(event.id).remove();
      });
      return { ok: true };
    }
    return { ok: false, error: '不支持的操作' };
  } catch (error) {
    // 不记录请求体；其中可能包含校验码。
    const message = String(error.message || error);
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
      return { ok: false, error: '账号服务初始化未完成，请检查 accessAccounts、records、tags 集合' };
    }
    if (/transaction|conflict/i.test(message)) return { ok: false, error: '账号状态发生变化，请重新检查后重试' };
    if (/msgSecCheck|security|87014/i.test(message)) return { ok: false, error: '名字审核未通过或服务不可用，请稍后重试' };
    // SDK 内部错误不直接展示，业务校验错误可读。
    return { ok: false, error: /fail|database|cloud|request/i.test(message) ? '服务暂不可用，请稍后重试' : message };
  }
};
