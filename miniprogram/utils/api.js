/** 账号、作品和词库全部经云函数鉴权；客户端数据库不再直接读写。 */
async function accessGate(action, data = {}) {
  let response;
  try {
    response = await wx.cloud.callFunction({ name: 'accessGate', data: Object.assign({ action }, data) });
  } catch (error) {
    const details = String(error && (error.errMsg || error.message) || '');
    if (/ECONNREFUSED|tunneling socket|proxy/i.test(details)) throw new Error('云服务连接失败，请检查登录与代理设置');
    if (/FUNCTION_NOT_FOUND|function not found|FUNCTION_NAME_NOT_EXIST/i.test(details)) throw new Error('账号服务尚未部署，请检查 accessGate');
    throw new Error('账号服务暂不可用，请稍后重试');
  }
  if (!response.result || !response.result.ok) throw new Error(response.result && response.result.error || '账号服务暂不可用');
  return response.result;
}
async function getAccessStatus() {
  const status = await accessGate('status');
  const app = getApp();
  const previous = app.globalData.accessStatus;
  app.globalData.accessStatus = status;
  if (!previous || previous.role !== status.role || previous.activated !== status.activated) {
    app.globalData.dbUpdateTime = Date.now();
  }
  return status;
}
async function requireAccess() {
  const status = await getAccessStatus();
  if (!status.canUpload) throw new Error('请先在「我的」输入校验码成为花艺师');
  return status;
}
async function redeemAccessCode(code, name) { return accessGate('redeem', { code, name }); }
async function listAccessRecords(skip = 0) { return accessGate('list', { skip }); }
async function updateAccessName(name) { return accessGate('updateName', { name }); }
async function revokeFlorist(id) { return accessGate('revoke', { id }); }
async function cleanupFlorist(id) { return accessGate('cleanup', { id }); }
async function shareRecord(id, enabled) { return accessGate('shareRecord', { id, enabled }); }
async function readSharedRecord(token) { return accessGate('readShared', { token }); }

async function uploadImage(filePath, thumbnail) {
  const status = await requireAccess();
  const match = /\.(\w+)(\?|$)/.exec(filePath);
  const ext = thumbnail ? '.jpg' : match ? '.' + match[1].toLowerCase() : '.jpg';
  const cloudPath = status.filePrefix + (thumbnail ? 'thumbs/' : 'works/')
    + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + ext;
  return (await wx.cloud.uploadFile({ cloudPath, filePath })).fileID;
}
async function uploadWorkImage(filePath) { return uploadImage(filePath, false); }
async function uploadThumbImage(filePath) { return uploadImage(filePath, true); }
async function deleteCloudFiles(fileIDs) {
  const ids = [...new Set((fileIDs || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const result = await wx.cloud.deleteFile({ fileList: ids.slice(i, i + 50) });
    if ((result.fileList || []).some(file => file.status !== 0 && !/not.?exist|not.?found/i.test(file.errMsg || ''))) {
      throw new Error('图片清理失败，请重试');
    }
  }
}
async function getTempUrls(fileIDs) {
  const map = {};
  const ids = [...new Set((fileIDs || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const result = await wx.cloud.getTempFileURL({ fileList: ids.slice(i, i + 50) });
    (result.fileList || []).forEach(file => { if (file.status === 0) map[file.fileID] = file.tempFileURL; });
  }
  return map;
}
async function analyzeImage(fileID) {
  try { return (await wx.cloud.callFunction({ name: 'analyzeImage', data: { fileID } })).result; }
  catch (error) { return { ok: false, error: error.errMsg || '分析服务暂不可用' }; }
}
async function imgSecCheck(fileID) {
  try { return (await wx.cloud.callFunction({ name: 'imgSecCheck', data: { fileID } })).result; }
  catch (error) { return { ok: false, error: error.errMsg || '安全检测暂不可用', accessDenied: true }; }
}
async function addRecord(record) { return (await accessGate('saveRecord', { record })).id; }
async function getRecord(id) { return (await accessGate('getRecord', { id })).record; }
async function updateRecordTags(id, tags) { return accessGate('updateRecord', { id, tags }); }
async function updateRecordExtras(id, extraFiles) { return accessGate('updateRecord', { id, extraFiles }); }
async function removeRecord(id) { return accessGate('removeRecord', { id }); }
async function countRecords() { return (await accessGate('countRecords')).total; }
async function listRecords(skip = 0, limit = 20) {
  return (await accessGate('listRecords', { skip, limit })).records;
}
async function fetchAll(action) {
  const records = [];
  for (;;) {
    const page = (await accessGate(action, { skip: records.length })).records;
    records.push(...page);
    if (page.length < 100) return records;
  }
}
async function fetchAllRecords() { return fetchAll('listRecords'); }
async function bumpTagUsage() { /* 标签使用次数由作品实时聚合。 */ }
async function listTags() {
  const [records, custom] = await Promise.all([fetchAllRecords(), fetchAll('listTags')]);
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
  getAccessStatus, requireAccess, redeemAccessCode, listAccessRecords, updateAccessName,
  revokeFlorist, cleanupFlorist, shareRecord, readSharedRecord,
  uploadWorkImage, uploadThumbImage, deleteCloudFiles, getTempUrls, analyzeImage, imgSecCheck,
  addRecord, getRecord, updateRecordTags, updateRecordExtras, removeRecord,
  countRecords, listRecords, fetchAllRecords, bumpTagUsage, listTags, addFlowerTag, removeTag
};
