/** 账号、作品和词库全部经云函数鉴权；客户端数据库不再直接读写。 */
const session = require('./session-cache');
const mutations = new Set([
  'redeem', 'updateName', 'revoke', 'cleanup', 'shareRecord', 'createPortfolioShare',
  'stopPortfolioShare', 'updatePortfolioMetadata', 'saveRecord', 'updateRecord', 'removeRecord',
  'commitUploadRecord', 'commitExtraUploads', 'addFlowerTag', 'removeTag',
  'abandonUploadJob', 'closeUploadSession', 'closeOwnUploadSessions'
]);
const publicReads = new Set(['readShared', 'readPortfolioShare', 'readPortfolioRecord', 'submitFeedback']);
let firstPageInFlight = null;
async function accessGate(action, data = {}) {
  const stamp = publicReads.has(action) ? null : session.capture();
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'accessGate', data: Object.assign({}, data, { action }) });
  } catch (error) {
    const details = String(error && (error.errMsg || error.message) || '');
    if (/ECONNREFUSED|tunneling socket|proxy/i.test(details)) throw new Error('云服务连接失败，请检查登录与代理设置');
    if (/FUNCTION_NOT_FOUND|function not found|FUNCTION_NAME_NOT_EXIST/i.test(details)) throw new Error('账号服务尚未部署，请检查 accessGate');
    throw new Error('账号服务暂不可用，请稍后重试');
  }
  if (!response.result || !response.result.ok) {
    if (stamp) session.fail(stamp);
    const error = new Error(response.result && response.result.error || '账号服务暂不可用');
    error.validationFailed = !!(response.result && response.result.validationFailed);
    throw error;
  }
  if (mutations.has(action)) session.invalidate();
  return response.result;
}
function getAccessStatus(options = {}) {
  const stamp = options.force ? session.forceReview() : session.capture();
  return session.share(stamp, 'status', async () => {
    try {
      const status = await accessGate('status');
      session.commitStatus(stamp, status);
      return status;
    } catch (error) {
      session.fail(stamp);
      throw error;
    }
  });
}
async function requireAccess() {
  const status = await getAccessStatus({ force: true });
  if (!status.canUpload || status.cleanupPending) throw new Error('请先在「我的」输入校验码成为花艺师');
  return status;
}
async function ownStamp() {
  const stamp = session.capture();
  if (!session.privateReady()) {
    const status = await getAccessStatus();
    if (!status.canUpload || status.cleanupPending) throw new Error('请先在「我的」输入校验码成为花艺师');
    const accepted = session.capture();
    if (stamp.env !== accepted.env || stamp.entryGeneration !== accepted.entryGeneration
      || stamp.mutationGeneration !== accepted.mutationGeneration) throw session.staleError();
    return accepted;
  }
  return stamp;
}
async function ownRead(action, data = {}) {
  const stamp = session.capture();
  try {
    const result = await accessGate(action, data);
    session.assertCurrent(stamp);
    return result;
  } catch (error) {
    session.fail(stamp);
    throw error;
  }
}
function getRecordPage({ skip = 0, limit = 20 } = {}) {
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    return Promise.reject(new Error('作品分页参数无效'));
  }
  const stamp = session.capture();
  const promise = session.share(stamp, JSON.stringify(['recordPage', skip, limit]), async () => {
    try {
      const result = await accessGate('getRecordPage', { skip, limit });
      if (!result.status || !Array.isArray(result.records) || result.records.length > limit
        || !result.urls || typeof result.urls !== 'object' || Array.isArray(result.urls)
        || typeof result.hasMore !== 'boolean' || !Number.isSafeInteger(result.nextSkip)
        || (result.hasMore && !result.records.length)
        || result.nextSkip !== skip + result.records.length) throw new Error('作品分页服务尚未更新，请更新后重试');
      const accepted = session.commitStatus(stamp, result.status);
      if (stamp.identityKey && stamp.identityKey !== accepted.identityKey) throw session.staleError();
      if (!result.status.canUpload || result.status.cleanupPending) {
        return Object.assign({}, result, { records: [], urls: {}, hasMore: false, nextSkip: skip });
      }
      cacheUrls(accepted, result.urls, result);
      return result;
    } catch (error) {
      session.fail(stamp);
      throw error;
    }
  }).then(session.copy);
  if (skip === 0) {
    const flight = { stamp, promise };
    firstPageInFlight = flight;
    // No detached rejected promise: cleanup is attached to both outcomes.
    const clearFlight = () => { if (firstPageInFlight === flight) firstPageInFlight = null; };
    promise.then(clearFlight, clearFlight);
  }
  return promise;
}
async function redeemAccessCode(code, name) { return accessGate('redeem', { code, name }); }
async function listAccessRecords(skip = 0) { return accessGate('list', { skip }); }
async function updateAccessName(name) { return accessGate('updateName', { name }); }
async function revokeFlorist(id) { return accessGate('revoke', { id }); }
async function cleanupFlorist(id) { return accessGate('cleanup', { id }); }
async function shareRecord(id, enabled) { return accessGate('shareRecord', { id, enabled }); }
async function readSharedRecord(token) { return accessGate('readShared', { token }); }
async function submitFeedback(payload = {}) {
  const { type, content, phone, requestId, diagnostics } = payload;
  return accessGate('submitFeedback', { type, content, phone, requestId, diagnostics });
}
async function createPortfolioShare(mode, recordIds) {
  return accessGate('createPortfolioShare', { mode, recordIds });
}
async function listPortfolioShares(cursor) { return accessGate('listPortfolioShares', { cursor }); }
async function stopPortfolioShare(id) { return accessGate('stopPortfolioShare', { id }); }
async function updatePortfolioMetadata(id, title, description) {
  return accessGate('updatePortfolioMetadata', { id, title, description });
}
async function readPortfolioShare(token, cursor, limit = 20) {
  return accessGate('readPortfolioShare', { token, cursor, limit });
}
async function readPortfolioRecord(token, recordId, original = false) {
  return accessGate('readPortfolioRecord', { token, recordId, original });
}

async function uploadImage(filePath, thumbnail, onProgress, registration) {
  const status = registration ? null : await requireAccess();
  const match = /\.(\w+)(\?|$)/.exec(filePath);
  const ext = thumbnail ? '.jpg' : match ? '.' + match[1].toLowerCase() : '.jpg';
  const cloudPath = registration ? (thumbnail ? registration.job.thumbCloudPath : registration.job.cloudPath)
    : status.filePrefix + (thumbnail ? 'thumbs/' : 'works/') + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext;
  if (registration) await registration.controller.checkpoint();
  // 回调形式返回 UploadTask，才能订阅真实上传进度。
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath, filePath,
      success: result => {
        const expected = registration && (thumbnail ? registration.job.thumbFileID : registration.job.fileID);
        if (expected && result.fileID !== expected) reject(new Error('图片上传状态不一致，请重新上传'));
        else resolve(result.fileID);
      },
      fail: reject
    });
    if (registration) registration.controller.track(task);
    if (typeof onProgress === 'function' && task && task.onProgressUpdate) {
      task.onProgressUpdate(result => onProgress(result.progress));
    }
  });
}
async function uploadWorkImage(filePath, onProgress, registration) { return uploadImage(filePath, false, onProgress, registration); }
async function uploadThumbImage(filePath, onProgress, registration) { return uploadImage(filePath, true, onProgress, registration); }
async function beginUploadSession(data) { return accessGate('beginUploadSession', data); }
async function prepareUploadJob(data) { return accessGate('prepareUploadJob', data); }
async function readUploadSession(sessionId) { return accessGate('readUploadSession', { sessionId }); }
async function abandonUploadJob(sessionId, jobId) { return accessGate('abandonUploadJob', { sessionId, jobId }); }
async function closeUploadSession(sessionId, reason) { return accessGate('closeUploadSession', { sessionId, reason }); }
async function closeOwnUploadSessions(cursor) { return accessGate('closeOwnUploadSessions', { cursor }); }
async function commitUploadRecord(sessionId, jobId, tags) { return accessGate('commitUploadRecord', { sessionId, jobId, tags }); }
async function commitExtraUploads(sessionId, jobIds) { return accessGate('commitExtraUploads', { sessionId, jobIds }); }
async function deleteCloudFiles(fileIDs) {
  const ids = [...new Set((fileIDs || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    let result;
    try { result = await wx.cloud.deleteFile({ fileList: ids.slice(i, i + 50) }); }
    catch (error) { session.invalidate(); throw error; }
    if ((result.fileList || []).some(file => file.status !== 0 && !/not.?exist|not.?found/i.test(file.errMsg || ''))) {
      session.invalidate();
      throw new Error('图片清理失败，请重试');
    }
  }
  if (ids.length) session.invalidate();
}
function knownExpiry(result, id) {
  const value = result.expiresAt && (typeof result.expiresAt === 'object' ? result.expiresAt[id] : result.expiresAt);
  let time = value === undefined || value === null ? Infinity : typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(time)) time = Date.now();
  // COS signed URLs carry absolute expiry in the q-sign-time range.
  const match = /[?&](q-sign-time|Expires)=([^&#]+)/i.exec(result.urls && result.urls[id] || '');
  if (match) {
    try {
      const raw = decodeURIComponent(match[2]);
      const seconds = Number(match[1].toLowerCase() === 'q-sign-time' ? raw.split(';')[1] : raw);
      if (Number.isFinite(seconds)) time = Math.min(time, seconds * 1000);
    } catch (_) { time = Date.now(); }
  }
  return time;
}
function cacheUrls(stamp, urls, result = {}) {
  Object.keys(urls).forEach(id => {
    if (typeof urls[id] === 'string' && urls[id]) {
      session.write(stamp, 'url:' + id, urls[id], session.URL_TTL, knownExpiry(result, id));
    }
  });
}
async function getTempUrls(fileIDs, options = {}) {
  const ready = await ownStamp();
  session.assertCurrent(ready);
  const stamp = options.force ? session.forceReview() : ready;
  const map = {};
  const ids = [...new Set((fileIDs || []).filter(Boolean))];
  const missing = [];
  ids.forEach(id => {
    if (options.force) session.forget('url:' + id);
    const cached = options.force ? null : session.read('url:' + id, session.URL_TTL);
    if (cached) map[id] = cached;
    else missing.push(id);
  });
  // 附带文件所在记录 ID 供服务端加速定位；仅作提示，服务端仍完整校验归属。
  const recordIDs = [...new Set((options.recordIDs || [])
    .filter(id => typeof id === 'string' && id && id.length <= 256))];
  const hint = recordIDs.length && recordIDs.length <= 50 ? recordIDs : undefined;
  try {
    const signed = await session.share(stamp, JSON.stringify(['urls', !!options.force, missing.slice().sort()]), async () => {
      const urls = {};
      for (let i = 0; i < missing.length; i += 50) {
        session.assertCurrent(stamp);
        const result = await accessGate('getOwnFileUrls',
          hint ? { fileIDs: missing.slice(i, i + 50), recordIDs: hint } : { fileIDs: missing.slice(i, i + 50) });
        session.assertCurrent(stamp);
        cacheUrls(stamp, result.urls || {}, result);
        Object.assign(urls, result.urls);
      }
      return urls;
    });
    session.assertCurrent(stamp);
    return Object.assign(map, signed);
  } catch (error) {
    session.fail(stamp);
    throw error;
  }
}
async function analyzeImage(fileID) {
  try { return (await wx.cloud.callFunction({ name: 'analyzeImage', data: { fileID } })).result; }
  catch (error) { return { ok: false, error: error.errMsg || '分析服务暂不可用' }; }
}
async function imgSecCheck(fileID, job) {
  try { return (await wx.cloud.callFunction({ name: 'imgSecCheck', data: { fileID, jobId: job && job.jobId } })).result; }
  catch (error) { return { ok: false, error: error.errMsg || '安全检测暂不可用', accessDenied: true }; }
}
async function addRecord(record) { return (await accessGate('saveRecord', { record })).id; }
async function getRecord(id) { return (await ownRead('getRecord', { id })).record; }
async function updateRecordTags(id, tags) { return accessGate('updateRecord', { id, tags }); }
async function updateRecordExtras(id, extraFiles) { return accessGate('updateRecord', { id, extraFiles }); }
async function removeRecord(id) { return accessGate('removeRecord', { id }); }
async function countRecords() {
  // Cold entry: use the combined page's identity, not an extra status request.
  const flight = firstPageInFlight;
  if (!session.privateReady() && flight && session.isCurrent(flight.stamp)) await flight.promise;
  return (await ownRead('countRecords')).total;
}
async function listRecords(skip = 0, limit = 20) {
  return (await ownRead('listRecords', { skip, limit })).records;
}
async function fetchAll(action, options = {}, stamp) {
  const records = [];
  for (;;) {
    if (stamp) session.assertCurrent(stamp);
    const page = (await accessGate(action, Object.assign({}, options, { skip: records.length, limit: 100 }))).records;
    if (stamp) session.assertCurrent(stamp);
    if (!Array.isArray(page)) throw new Error('作品列表响应无效，请重试');
    records.push(...page);
    if (page.length < 100) return records;
  }
}
async function fetchAllRecords(options = {}) {
  const ready = await ownStamp();
  session.assertCurrent(ready);
  const stamp = options.force ? session.forceReview() : ready;
  const includeDeleting = options.includeDeleting === true;
  const name = JSON.stringify(['allRecords', includeDeleting]);
  const cached = !options.force && session.read(name);
  if (cached && cached.complete === true) return cached.records;
  if (options.force) session.forget(name);
  try {
    const result = await session.share(stamp, name, async () => {
      const records = await fetchAll('listRecords', { includeDeleting }, stamp);
      session.write(stamp, name, { complete: true, records });
      return records;
    });
    session.assertCurrent(stamp);
    return session.copy(result);
  } catch (error) {
    session.fail(stamp);
    throw error;
  }
}
async function bumpTagUsage() { /* 标签使用次数由作品实时聚合。 */ }
async function listTags() {
  const stamp = await ownStamp();
  session.assertCurrent(stamp);
  const [records, custom] = await Promise.all([fetchAllRecords(), fetchAll('listTags', {}, stamp)]);
  session.assertCurrent(stamp);
  const groups = {};
  function inc(dimension, name, role = '') {
    const key = JSON.stringify([dimension, name, role]);
    if (!groups[key]) groups[key] = { _id: key, dimension, name, role, count: 0 };
    groups[key].count++;
  }
  records.forEach(record => {
    (record.colors || []).forEach(name => inc('color', name));
    ['colorScheme', 'category', 'style'].forEach(key => { if (record[key]) inc(key, record[key]); });
    (record.occasion || []).forEach(name => inc('occasion', name));
    ['Main', 'Sub', 'Leaf'].forEach(role => (record['flowers' + role] || []).forEach(name => inc('flower', name, role.toLowerCase())));
  });
  return Object.keys(groups).map(key => groups[key]).concat(custom.filter(tag => tag.custom));
}
async function addFlowerTag(name) { return (await accessGate('addFlowerTag', { name })).added; }
async function removeTag(id) { return accessGate('removeTag', { id }); }
module.exports = {
  getRecordPage, invalidate: session.invalidate, beginEntry: session.beginEntry, appHide: session.appHide,
  beginUploadSession, prepareUploadJob, readUploadSession, abandonUploadJob, closeUploadSession,
  closeOwnUploadSessions, commitUploadRecord, commitExtraUploads,
  getAccessStatus, requireAccess, redeemAccessCode, listAccessRecords, updateAccessName,
  revokeFlorist, cleanupFlorist, shareRecord, readSharedRecord,
  submitFeedback,
  createPortfolioShare, listPortfolioShares, stopPortfolioShare, updatePortfolioMetadata, readPortfolioShare, readPortfolioRecord,
  uploadWorkImage, uploadThumbImage, deleteCloudFiles, getTempUrls, analyzeImage, imgSecCheck,
  addRecord, getRecord, updateRecordTags, updateRecordExtras, removeRecord,
  countRecords, listRecords, fetchAllRecords, bumpTagUsage, listTags, addFlowerTag, removeTag
};
