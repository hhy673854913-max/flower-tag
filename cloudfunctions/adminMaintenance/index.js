const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const MIN_BATCH_SIZE = 1;
const DOC_BATCH_SIZE = 20;
const FILE_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 20;
const DEFAULT_CONFIRM = 'WIPE_ALL_DATA';
const INCLUDE_ADMINS_CONFIRM = 'WIPE_ALL_DATA_AND_ADMINS';

const DEFAULT_COLLECTIONS = [
  { name: 'records', enabled: true },
  { name: 'tags', enabled: true },
  { name: 'accessAccounts', enabled: true },
  { name: 'floristApplications', enabled: true },
  { name: 'shareLinks', enabled: true },
  { name: 'florists', enabled: true },
  { name: 'admins', enabled: false }
];

function fail(message) {
  throw new Error(message);
}

function isCollectionMissing(error) {
  return /collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(
    String((error && error.message) || error || '')
  );
}

async function isAdmin(openid) {
  if (!openid) return false;
  const envAdmins = (process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (envAdmins.includes(openid)) return true;
  try {
    const result = await db.collection('admins').where({ openid }).limit(1).get();
    return result.data.length > 0;
  } catch (error) {
    if (isCollectionMissing(error)) return false;
    fail('暂时无法确认管理员身份，请稍后重试');
  }
}

async function collectionExists(name) {
  try {
    await db.collection(name).limit(1).get();
    return true;
  } catch (error) {
    if (isCollectionMissing(error)) return false;
    throw error;
  }
}

function collectFileIDs(value, fileIDs) {
  if (!value) return;
  if (typeof value === 'string') {
    if (value.startsWith('cloud://')) fileIDs.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectFileIDs(item, fileIDs));
    return;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach(key => collectFileIDs(value[key], fileIDs));
  }
}

async function deleteFiles(fileIDs) {
  let deleted = 0;
  for (let i = 0; i < fileIDs.length; i += FILE_BATCH_SIZE) {
    const batch = fileIDs.slice(i, i + FILE_BATCH_SIZE);
    const result = await cloud.deleteFile({ fileList: batch });
    const rows = result.fileList || [];
    const failed = rows.filter(item =>
      item.status !== 0 && !/not.?exist|not.?found|不存在/i.test(item.errMsg || '')
    );
    if (failed.length) fail('云存储文件删除未完成，请重试');
    deleted += batch.length;
  }
  return deleted;
}

function availableCollections(includeAdmins) {
  return DEFAULT_COLLECTIONS.map(item => (
    item.name === 'admins'
      ? Object.assign({}, item, { enabled: includeAdmins === true })
      : item
  )).filter(item => item.enabled);
}

function normalizeBatchSize(value) {
  const size = Math.floor(Number(value) || DOC_BATCH_SIZE);
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, size));
}

function resolveCollections(includeAdmins, collectionName) {
  const collections = availableCollections(includeAdmins);
  if (!collectionName) return collections;
  const target = collections.find(item => item.name === collectionName);
  if (!target) fail(`不支持集合 ${collectionName}`);
  return [target];
}

async function countCollection(name) {
  if (!(await collectionExists(name))) {
    return { name, exists: false, docs: 0 };
  }
  const result = await db.collection(name).count();
  return { name, exists: true, docs: result.total || 0 };
}

async function firstPendingCollection(collections, startIndex = 0) {
  for (let index = startIndex; index < collections.length; index += 1) {
    const name = collections[index].name;
    if (!(await collectionExists(name))) continue;
    const result = await db.collection(name).field({ _id: true }).limit(1).get();
    if ((result.data || []).length) return { index, name };
  }
  return null;
}

async function wipeNextBatch(collections, batchSize) {
  const pending = await firstPendingCollection(collections);
  if (!pending) {
    return {
      done: true,
      hasMore: false,
      processedCollection: '',
      deletedDocs: 0,
      deletedFileIDs: 0,
      nextCollection: ''
    };
  }

  const result = await db.collection(pending.name).limit(batchSize).get();
  const rows = result.data || [];
  const fileIDs = new Set();
  rows.forEach(row => collectFileIDs(row, fileIDs));

  const ids = Array.from(fileIDs);
  const deletedFileIDs = ids.length ? await deleteFiles(ids) : 0;
  await Promise.all(rows.map(row => db.collection(pending.name).doc(row._id).remove()));

  const nextPending = await firstPendingCollection(collections, pending.index);
  return {
    done: !nextPending,
    hasMore: !!nextPending,
    processedCollection: pending.name,
    deletedDocs: rows.length,
    deletedFileIDs,
    nextCollection: nextPending ? nextPending.name : ''
  };
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, error: '无法识别当前微信用户' };

  try {
    if (!(await isAdmin(openid))) fail('仅管理员可执行该操作');

    const includeAdmins = event.includeAdmins === true;
    const dryRun = event.dryRun !== false;
    const batchSize = normalizeBatchSize(event.batchSize);
    const collectionName = typeof event.collectionName === 'string' ? event.collectionName.trim() : '';
    const confirm = typeof event.confirm === 'string' ? event.confirm.trim() : '';
    const expectedConfirm = includeAdmins ? INCLUDE_ADMINS_CONFIRM : DEFAULT_CONFIRM;
    const collections = resolveCollections(includeAdmins, collectionName);

    if (!dryRun && confirm !== expectedConfirm) {
      fail(`确认口令错误，请使用 ${expectedConfirm}`);
    }

    if (dryRun) {
      const summary = [];
      for (const item of collections) {
        summary.push(await countCollection(item.name));
      }
      return {
        ok: true,
        dryRun: true,
        includeAdmins,
        collectionName: collectionName || 'ALL',
        confirmRequired: expectedConfirm,
        batchSize,
        scope: '预演只统计各集合文档数；正式执行时按批删除数据库文档，并删除文档中可追踪到的 cloud:// 文件引用',
        warning: '若开发者工具仍提示 3 秒超时，可继续缩小 batchSize，或传 collectionName 只处理单个集合。当前 SDK 不支持按目录枚举云存储，未被数据库引用的历史孤儿文件不在扫描范围内',
        summary
      };
    }

    const result = await wipeNextBatch(collections, batchSize);
    return {
      ok: true,
      dryRun: false,
      includeAdmins,
      collectionName: collectionName || 'AUTO',
      confirmRequired: expectedConfirm,
      batchSize,
      scope: '单次删除一批数据库文档，并删除该批文档中可追踪到的 cloud:// 文件引用',
      warning: '若开发者工具仍提示 3 秒超时，可继续缩小 batchSize，或传 collectionName 只处理单个集合。当前 SDK 不支持按目录枚举云存储，未被数据库引用的历史孤儿文件不在扫描范围内',
      result
    };
  } catch (error) {
    const message = String(error.message || error);
    if (isCollectionMissing(error)) {
      return { ok: false, error: '目标集合不存在，请检查当前云环境或初始化状态' };
    }
    return { ok: false, error: /fail|database|cloud|request/i.test(message) ? '管理员清理服务暂不可用，请稍后重试' : message };
  }
};
