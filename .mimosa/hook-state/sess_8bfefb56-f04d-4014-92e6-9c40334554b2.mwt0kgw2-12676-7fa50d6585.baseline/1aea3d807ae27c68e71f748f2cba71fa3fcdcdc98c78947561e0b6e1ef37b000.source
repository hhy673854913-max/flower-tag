/**
 * 标准标签词库（与 AI 提示词、确认页、筛选页共用）
 */

const COLORS = ['红', '粉', '橙', '黄', '绿', '紫', '蓝', '白', '香槟色', '复古色', '混色'];

// AI 常见说法 → 标准枚举 的映射
const COLOR_ALIAS = {
  '香槟': '香槟色', '奶白': '白', '米白': '白', '纯白': '白', '象牙白': '白', '乳白': '白',
  '橘': '橙', '橘红': '橙', '橘黄': '橙', '金黄': '黄', '淡黄': '黄', '鹅黄': '黄',
  '粉红': '粉', '桃红': '粉', '玫红': '粉', '裸粉': '粉', '肉粉': '粉',
  '酒红': '红', '正红': '红', '深红': '红',
  '复古': '复古色', '莫兰迪': '复古色', '焦糖': '复古色', '咖': '复古色', '咖啡': '复古色', '奶茶': '复古色',
  '彩色': '混色', '多色': '混色', '缤纷': '混色', '彩虹': '混色'
};

/** 把颜色说法归一到枚举；归一不了返回 null */
function normColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (COLORS.indexOf(s) >= 0) return s;
  if (COLOR_ALIAS[s]) return COLOR_ALIAS[s];
  const bare = s.replace(/色$/, '');
  if (COLORS.indexOf(bare) >= 0) return bare;
  if (COLOR_ALIAS[bare]) return COLOR_ALIAS[bare];
  const byLen = COLORS.slice().sort((a, b) => b.length - a.length);
  for (const c of byLen) {
    if (c.length >= 2 && s.indexOf(c) >= 0) return c;
  }
  return null;
}

// 色系：作品整体归属，单选，兜底「混合颜色」
const COLOR_SCHEMES = ['红色系', '粉色系', '橙色系', '黄色系', '绿色系', '紫色系', '蓝色系', '白色系', '香槟色系', '复古色系', '混合颜色'];

const CATEGORIES = ['婚车', '花束', '开业花篮', '手提花篮', '手捧花', '桌花/瓶插花', '花盒', '其他'];

const STYLES = ['清新', '韩式', '欧式古典', '自然风', 'ins风', '中式', '复古', '森系', '现代简约', '其他'];

const OCCASIONS = ['日常花礼', '生日', '表白/纪念日', '婚礼', '开业', '探望', '丧葬/祭奠', '节日', '家居装饰', '商务', '其他'];

// 常见花材（供确认页快速点选；AI 可输出词库之外的花材名，保存时自动入库）
const COMMON_FLOWERS = [
  '玫瑰', '月季', '康乃馨', '百合', '郁金香', '洋桔梗', '桔梗', '向日葵', '绣球',
  '牡丹', '芍药', '雏菊', '洋甘菊', '满天星', '勿忘我', '薰衣草', '风信子',
  '蝴蝶兰', '大花蕙兰', '马蹄莲', '非洲菊', '扶郎', '紫罗兰', '银莲花',
  '毛茛', '洋牡丹', '大丽花', '睡莲', '荷花', '茉莉', '栀子花', '桂花',
  '腊梅', '梅花', '桃花', '樱花', '玉兰', '杜鹃', '山茶', '鸢尾',
  '剑兰', '天堂鸟', '红掌', '鹤望兰', '帝王花', '针垫花', '木绣球',
  '尤加利叶', '龟背竹叶', '散尾葵', '蕨叶', '常春藤', '银叶菊',
  '栀子叶', '高山羊齿', '蓬莱松', '情人草', '黄莺', '小米叶', '雪柳叶'
];

const FLOWER_ROLES = [
  { key: 'flowersMain', name: '主花' },
  { key: 'flowersSub', name: '辅花' },
  { key: 'flowersLeaf', name: '叶材' }
];

const DIMENSIONS = [
  { key: 'colors', name: '颜色', multi: true, options: COLORS },
  { key: 'colorScheme', name: '色系', multi: false, options: COLOR_SCHEMES },
  { key: 'category', name: '种类', multi: false, options: CATEGORIES },
  { key: 'style', name: '风格', multi: false, options: STYLES },
  { key: 'occasion', name: '用途', multi: true, options: OCCASIONS }
];

/** 归一化一份 AI 输出，保证字段完整、枚举合法 */
function normalizeTags(raw) {
  raw = raw || {};
  const pick = (val, allowed, fallback) => (allowed.indexOf(val) >= 0 ? val : fallback);
  const pickMulti = (arr, allowed) =>
    (Array.isArray(arr) ? arr : []).filter(x => allowed.indexOf(x) >= 0);
  const flowers = (raw.flowers && typeof raw.flowers === 'object') ? raw.flowers : {};
  const strArr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []);
  // 兼容两种结构：云函数已拍平的 flowersMain，或 AI 原始嵌套的 flowers.main
  const pickFlowers = (flat, nested) => {
    const a = strArr(flat);
    return a.length ? a : strArr(nested);
  };
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .map(normColor)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3);

  return {
    colors,
    colorScheme: pick(raw.colorScheme, COLOR_SCHEMES, '混合颜色'),
    flowersMain: pickFlowers(raw.flowersMain, flowers.main),
    flowersSub: pickFlowers(raw.flowersSub, flowers.sub),
    flowersLeaf: pickFlowers(raw.flowersLeaf, flowers.leaf),
    category: pick(raw.category, CATEGORIES, '其他'),
    style: pick(raw.style, STYLES, '其他'),
    occasion: pickMulti(raw.occasion, OCCASIONS),
    confidence: (raw.confidence && typeof raw.confidence === 'object') ? raw.confidence : {}
  };
}

module.exports = {
  COLORS,
  COLOR_SCHEMES,
  CATEGORIES,
  STYLES,
  OCCASIONS,
  COMMON_FLOWERS,
  FLOWER_ROLES,
  DIMENSIONS,
  normalizeTags
};
