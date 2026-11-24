// 缩略图用于列表/详情展示与 AI 分析：超过 MAX_SIDE 先等比降尺寸再压缩，
// 避免只压质量不降分辨率导致的大文件慢上传。任何失败都回退原图路径。
const MAX_SIDE = 1600;
const QUALITY = 60;

function getImageInfo(src) {
  return new Promise(resolve => {
    wx.getImageInfo({
      src,
      success: info => resolve(info && info.width > 0 && info.height > 0 ? info : null),
      fail: () => resolve(null)
    });
  });
}

function compress(options) {
  return new Promise(resolve => {
    wx.compressImage(Object.assign({}, options, {
      success: res => resolve(res && res.tempFilePath || ''),
      fail: () => resolve('')
    }));
  });
}

/** 生成展示/分析用缩略图路径；失败时返回原路径，不阻断上传流程。 */
function compressThumb(src) {
  return getImageInfo(src).then(info => {
    const options = { src, quality: QUALITY };
    if (info && Math.max(info.width, info.height) > MAX_SIDE) {
      const scale = MAX_SIDE / Math.max(info.width, info.height);
      options.compressedWidth = Math.round(info.width * scale);
      options.compressedHeight = Math.round(info.height * scale);
    }
    return compress(options).then(path => path || src);
  }).catch(() => src);
}

// 与服务端 imgSecCheck 的硬性限制保持一致，只用于选图时提前提示、避免无效上传；
// 服务端仍按实际字节独立校验，这里的判断不能替代它。
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_EXTS = ['jpg', 'jpeg', 'png'];

/** 从临时路径取扩展名；取不到返回空串 */
function extOf(src) {
  const match = typeof src === 'string' ? src.match(/\.([a-z0-9]{1,10})(?:\?|#|$)/i) : null;
  return match ? match[1].toLowerCase() : '';
}

/**
 * 校验选中的图片，返回 { accepted, skipped }。
 * 无法从路径判断格式时不拦截，交由服务端按实际内容校验。
 */
function checkFiles(tempFiles) {
  const accepted = [], skipped = [];
  (Array.isArray(tempFiles) ? tempFiles : []).forEach(file => {
    if (!file || typeof file.tempFilePath !== 'string') return;
    const tooLarge = typeof file.size === 'number' && file.size > MAX_FILE_BYTES;
    const ext = extOf(file.tempFilePath);
    const badType = !!(ext && SUPPORTED_EXTS.indexOf(ext) < 0);
    if (tooLarge || badType) skipped.push({ tooLarge, badType });
    else accepted.push(file);
  });
  return { accepted, skipped };
}

/** 被跳过图片的提示文案：按原因提示，多张时带上跳过数量 */
function skipToast(skipped) {
  const reasons = [];
  if (skipped.some(item => item.badType)) reasons.push('仅支持 JPG、PNG 图片');
  if (skipped.some(item => item.tooLarge)) reasons.push('图片不能超过 20MB');
  const prefix = skipped.length > 1 ? '已跳过 ' + skipped.length + ' 张图片：' : '';
  return { title: prefix + reasons.join('，且'), icon: 'none' };
}

module.exports = { compressThumb, checkFiles, skipToast };
