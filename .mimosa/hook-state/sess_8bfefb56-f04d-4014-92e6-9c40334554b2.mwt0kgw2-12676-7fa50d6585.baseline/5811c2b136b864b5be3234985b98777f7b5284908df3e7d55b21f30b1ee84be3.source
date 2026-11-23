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

module.exports = { compressThumb };
