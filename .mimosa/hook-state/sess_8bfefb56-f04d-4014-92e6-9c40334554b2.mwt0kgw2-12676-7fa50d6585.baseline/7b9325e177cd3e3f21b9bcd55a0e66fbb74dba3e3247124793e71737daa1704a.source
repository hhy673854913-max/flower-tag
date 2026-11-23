// 写入约束与展示白名单分离，历史作品仍可读取。
const dict = {
  colors: ['红', '粉', '橙', '黄', '绿', '紫', '蓝', '白', '香槟色', '复古色', '混色'],
  colorScheme: ['红色系', '粉色系', '橙色系', '黄色系', '绿色系', '紫色系', '蓝色系', '白色系', '香槟色系', '复古色系', '混合颜色'],
  category: ['婚车', '花束', '开业花篮', '手提花篮', '手捧花', '桌花/瓶插花', '花盒', '其他'],
  style: ['清新', '韩式', '欧式古典', '自然风', 'ins风', '中式', '复古', '森系', '现代简约', '其他'],
  occasion: ['日常花礼', '生日', '表白/纪念日', '婚礼', '开业', '探望', '丧葬/祭奠', '节日', '家居装饰', '商务', '其他']
};
module.exports = async function checkedTags(input, openid, checkText) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('标签格式无效');
  const result = {};
  for (const key of ['colors', 'occasion']) {
    const values = input[key];
    if (!Array.isArray(values) || (key === 'colors' && (values.length < 1 || values.length > 3))
      || values.length > dict[key].length || values.some(v => !dict[key].includes(v))) {
      throw new Error(key === 'colors' ? '请选择 1～3 个标准颜色' : '请选择有效用途');
    }
    result[key] = [...new Set(values)];
  }
  for (const key of ['colorScheme', 'category', 'style']) {
    if (!dict[key].includes(input[key])) throw new Error('请选择有效的色系、种类和风格');
    result[key] = input[key];
  }
  const names = [];
  for (const key of ['flowersMain', 'flowersSub', 'flowersLeaf']) {
    if (!Array.isArray(input[key]) || input[key].length > 30
      || input[key].some(v => typeof v !== 'string' || !v.trim() || [...v.trim()].length > 30)) {
      throw new Error('每类花材最多 30 项，每项 1～30 字');
    }
    result[key] = [...new Set(input[key].map(v => v.trim()))];
    names.push(...result[key]);
  }
  if (names.length) {
    try { await checkText([...new Set(names)].join('，'), openid); }
    catch (_) { throw new Error('花材文本审核未通过或服务暂不可用，请修改或重试'); }
  }
  if (input.confidence && typeof input.confidence === 'object' && !Array.isArray(input.confidence)) {
    result.confidence = {};
    for (const key of ['colors', 'colorScheme', 'flowers', 'category', 'style', 'occasion']) {
      const value = input.confidence[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) result.confidence[key] = value;
    }
  }
  return result;
};
