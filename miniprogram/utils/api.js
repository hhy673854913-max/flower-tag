/**
 * 云服务工具层：云存储上传 / AI 分析 / 数据库 CRUD / 标签计数
 */

const db = () => wx.cloud.database();
const _ = () => wx.cloud.database().command;

/* ---------- 云存储 ---------- */

/** 上传原图到 works/（无损直存），返回 fileID */
async function uploadWorkImage(filePath) {
  const m = /\.(\w+)(\?|$)/.exec(filePath);
  const ext = m ? '.' + m[1].toLowerCase() : '.jpg';
  const cloudPath = 'works/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath });
  return res.fileID;
}

/** 上传压缩缩略图到 thumbs/（长期保存：列表/详情展示与 AI 分析共用，原图只在"查看原图"时加载） */
async function uploadThumbImage(filePath) {
  const cloudPath = 'thumbs/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg';
  const res = await wx.cloud.uploadFile({ cloudPath, filePath });
  return res.fileID;
}

/** 删除云端文件（支持批量，单次上限 50） */
async function deleteCloudFiles(fileIDs) {
  if (!fileIDs || !fileIDs.length) return;
  for (let i = 0; i < fileIDs.length; i += 50) {
    await wx.cloud.deleteFile({ fileList: fileIDs.slice(i, i + 50) });
  }
}

/** 批量换取图片临时访问 URL（单次上限 50） */
async function getTempUrls(fileIDs) {
  const map = {};
  for (let i = 0; i < fileIDs.length; i += 50) {
    const res = await wx.cloud.getTempFileURL({ fileList: fileIDs.slice(i, i + 50) });
    (res.fileList || []).forEach(f => {
      if (f.status === 0) map[f.fileID] = f.tempFileURL;
    });
  }
  return map;
}

/* ---------- AI 分析（云函数调 Kimi 视觉模型） ---------- */

/**
 * @param {string} fileID thumbs/ 下的压缩缩略图 fileID（云函数只读不删）
 * @returns {Promise<{ok:boolean, tags?:object, error?:string}>}
 */
async function analyzeImage(fileID) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'analyzeImage',
      data: { fileID }
    });
    return res.result;
  } catch (e) {
    return { ok: false, error: (e && e.errMsg) || '云函数调用失败' };
  }
}

/* ---------- records 记录 ---------- */

async function addRecord(rec) {
  const res = await db().collection('records').add({
    data: Object.assign({}, rec, { createdAt: db().serverDate() })
  });
  return res._id;
}

async function getRecord(id) {
  const res = await db().collection('records').doc(id).get();
  return res.data;
}

async function updateRecordTags(id, tags) {
  await db().collection('records').doc(id).update({ data: tags });
}

async function removeRecord(id) {
  await db().collection('records').doc(id).remove();
}

/** 分页取本人记录（时间倒序） */
async function listRecords(skip, limit) {
  const res = await db().collection('records')
    .orderBy('createdAt', 'desc')
    .skip(skip || 0)
    .limit(limit || 20)
    .get();
  return res.data;
}

/** 取本人全部记录（客户端聚合用；个人规模足够，超大库请改云函数聚合） */
async function fetchAllRecords() {
  const all = [];
  let skip = 0;
  const batch = 20;
  for (;;) {
    const res = await db().collection('records')
      .orderBy('createdAt', 'desc')
      .skip(skip)
      .limit(batch)
      .get();
    all.push(...res.data);
    if (res.data.length < batch) break;
    skip += batch;
    if (skip > 5000) break; // 安全上限
  }
  return all;
}

/* ---------- tags 词库与计数 ---------- */

/** 保存记录后，把各维度标签写入词库并累计使用次数 */
async function bumpTagUsage(tags) {
  const items = [];
  (tags.colors || []).forEach(name => items.push({ dimension: 'color', name, role: '' }));
  if (tags.colorScheme) items.push({ dimension: 'colorScheme', name: tags.colorScheme, role: '' });
  if (tags.category) items.push({ dimension: 'category', name: tags.category, role: '' });
  if (tags.style) items.push({ dimension: 'style', name: tags.style, role: '' });
  (tags.occasion || []).forEach(name => items.push({ dimension: 'occasion', name, role: '' }));
  (tags.flowersMain || []).forEach(name => items.push({ dimension: 'flower', name, role: 'main' }));
  (tags.flowersSub || []).forEach(name => items.push({ dimension: 'flower', name, role: 'sub' }));
  (tags.flowersLeaf || []).forEach(name => items.push({ dimension: 'flower', name, role: 'leaf' }));

  const col = db().collection('tags');
  for (const it of items) {
    const q = await col.where({ dimension: it.dimension, name: it.name, role: it.role }).get();
    if (q.data.length) {
      await col.doc(q.data[0]._id).update({ data: { count: _().inc(1) } });
    } else {
      await col.add({ data: Object.assign({ count: 1, createdAt: db().serverDate() }, it) });
    }
  }
}

async function listTags() {
  const all = [];
  let skip = 0;
  for (;;) {
    const res = await db().collection('tags').skip(skip).limit(20).get();
    all.push(...res.data);
    if (res.data.length < 20) break;
    skip += 20;
    if (skip > 2000) break;
  }
  return all;
}

async function addFlowerTag(name) {
  const col = db().collection('tags');
  const q = await col.where({ dimension: 'flower', name }).get();
  if (q.data.length) return false;
  await col.add({
    data: { dimension: 'flower', name, role: '', count: 0, custom: true, createdAt: db().serverDate() }
  });
  return true;
}

async function removeTag(id) {
  await db().collection('tags').doc(id).remove();
}

module.exports = {
  uploadWorkImage,
  uploadThumbImage,
  deleteCloudFiles,
  getTempUrls,
  analyzeImage,
  addRecord,
  getRecord,
  updateRecordTags,
  removeRecord,
  listRecords,
  fetchAllRecords,
  bumpTagUsage,
  listTags,
  addFlowerTag,
  removeTag
};