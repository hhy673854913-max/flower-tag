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
exports.main = async (event, context) => {
  const { fileID } = event
  if (!fileID) return { ok: false, error: '缺少 fileID' }

  try {
    const access = await checkUploadAccess(fileID)
    if (!access.ok) {
      return { ok: false, accessDenied: true, error: access.error || '账号未开通或图片不属于当前账号' }
    }
  } catch (err) {
    return { ok: false, accessDenied: true, error: '账号校验服务暂不可用' }
  }
    // 1. 下载图片
  try {
    // 1. 下载图片
    const file = await cloud.downloadFile({ fileID })
    const buffer = file.fileContent

    // 2. 调用微信安全接口进行内容审查 (同步校验)
    const result = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: 'image/jpeg',
        value: buffer
      }
    })

    if (result.errCode === 87014 || result.errCode === 40001) {
      return { ok: false, error: '图片包含违规内容', isViolated: true }
    } else if (result.errCode !== 0) {
      return { ok: false, error: '安全检测失败：' + result.errCode }
    }

    return { ok: true }
  } catch (err) {
    console.error('imgSecCheck error:', err);
    // 若命中违规，err 会作为抛出的异常，其中 errCode = 87014
    if (err.errCode === 87014 || (err.message && err.message.includes('87014'))) {
      return { ok: false, error: '图片包含违规内容', isViolated: true }
    }
    // 如果是图片太大等错误（如 > 1M），出于容错可以放行，或者提示。我们尽量让它抛出。
    // API v2 可能会抛出 41005 (media data missing or format error) 如果超出大小
    // 此处简化，对于非明确 87014 的错误，返回检测失败
    return { ok: false, error: (err.errMsg || err.message || '安全检测异常') }
  }
}
