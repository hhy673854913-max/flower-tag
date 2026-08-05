// 云函数入口文件
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 云函数入口函数
exports.main = async (event, context) => {
  const { fileID } = event
  if (!fileID) return { ok: false, error: '缺少 fileID' }

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
