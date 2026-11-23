// 云函数入口文件
const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const accounts = db.collection('accessAccounts')

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function filePrefix(openid) {
  return 'userFiles/' + hash(openid) + '/'
}

async function getAccount(openid) {
  try {
    const result = await accounts.where({ _id: openid }).limit(1).get()
    return result.data[0] || null
  } catch (error) {
    const message = String(error && error.message || error || '')
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
      return null
    }
    throw error
  }
}

async function isAdmin(openid) {
  if (!openid) return false
  const envAdmins = (process.env.ADMIN_OPENIDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  if (envAdmins.includes(openid)) return true
  try {
    const result = await db.collection('admins').where({ openid }).limit(1).get()
    return result.data.length > 0
  } catch (error) {
    const message = String(error && error.message || error || '')
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
      return false
    }
    throw error
  }
}

async function checkUploadAccess(fileID) {
  const openid = cloud.getWXContext().OPENID
  if (!openid) {
    return { ok: false, error: '无法识别当前微信用户' }
  }
  const [admin, account] = await Promise.all([isAdmin(openid), getAccount(openid)])
  const activated = admin || !!(account && account.activated === true && !account.cleanupPending)
  if (!activated) {
    return { ok: false, error: '账号未开通或图片不属于当前账号' }
  }
  const prefix = '/' + filePrefix(openid)
  if (typeof fileID !== 'string' || fileID.indexOf(prefix) < 0) {
    return { ok: false, error: '账号未开通或图片不属于当前账号' }
  }
  return { ok: true }
}

// 云函数入口函数
exports.main = async (event = {}) => {
  const { fileID, jobId } = event;
  const openid = cloud.getWXContext().OPENID;
  try {
    const access = await checkUploadAccess(fileID);
    if (!access.ok) return { ok: false, accessDenied: true, error: access.error };
    if (typeof jobId !== 'string' || !/^[a-f0-9]{64}$/.test(jobId)) throw new Error('请更新小程序并登记上传任务');
    const read = async (source, name, id) => (await source.collection(name).where({ _id: id }).limit(1).get()).data[0];
    const job = await read(db, 'uploadJobs', jobId);
    if (!job || job.ownerOpenid !== openid || job.state !== 'pending' || job.thumbFileID !== fileID) throw new Error('图片任务已失效');
    const session = await read(db, 'uploadJobs', job.sessionId);
    const account = await getAccount(openid);
    if (!session || session.state !== 'open' || session.expiresAt <= Date.now()
      || !account || account.uploadVersion !== session.uploadVersion) throw new Error('图片任务已失效');
    const hashes = [];
    const Jimp = require('jimp');
    const sizeOf = require('image-size');
    // 审核原图的服务端派生副本，不能用客户端提供的良性缩略图替代原图审核。
    for (const id of [job.fileID, job.thumbFileID]) {
      const { fileContent: buffer } = await cloud.downloadFile({ fileID: id });
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 20 * 1024 * 1024) throw new Error('图片需小于 20MB');
      const info = sizeOf(buffer);
      if (!['jpg', 'png'].includes(info.type)) throw new Error('仅支持 JPG、PNG 图片');
      if (!info.width || !info.height || info.width * info.height > 20000000) throw new Error('图片像素过大，请使用省流模式重试');
      const image = await Jimp.read(buffer);
      if (Math.max(image.bitmap.width, image.bitmap.height) > 1600) image.scaleToFit(1600, 1600);
      const media = await image.quality(75).getBufferAsync(Jimp.MIME_JPEG);
      if (!media.length || media.length > 1024 * 1024) throw new Error('审核副本过大，请使用省流模式重试');
      const result = await cloud.openapi.security.imgSecCheck({ media: { contentType: 'image/jpeg', value: media } });
      if (!result || Number(result.errCode) !== 0) {
        if (result && Number(result.errCode) === 87014) return { ok: false, isViolated: true, error: '图片包含违规内容' };
        throw new Error('安全检测暂不可用，请重试');
      }
      hashes.push(hash(buffer));
    }
    await db.runTransaction(async tx => {
      const current = await read(tx, 'uploadJobs', jobId);
      const s = await read(tx, 'uploadJobs', job.sessionId);
      const a = await read(tx, 'accessAccounts', openid);
      if (!current || current.state !== 'pending' || current.fileID !== job.fileID || current.thumbFileID !== job.thumbFileID
        || !s || s.state !== 'open' || s.expiresAt <= Date.now() || !a || a.uploadVersion !== s.uploadVersion
        || !(await isAdmin(openid) || (a.activated === true && !a.cleanupPending))) throw new Error('图片任务已失效');
      await tx.collection('uploadJobs').doc(jobId).update({ data: {
        audit: { version: 1, uploadVersion: s.uploadVersion, originalHash: hashes[0], thumbHash: hashes[1], checkedAt: Date.now() }
      } });
      await tx.collection('uploadJobs').doc(s._id).update({ data: { revision: (s.revision || 0) + 1 } });
    });
    return { ok: true };
  } catch (error) {
    if (Number(error.errCode || error.errcode) === 87014) return { ok: false, isViolated: true, error: '图片包含违规内容' };
    return { ok: false, error: '安全检测未完成：' + (error.message || '请稍后重试') };
  }
};
