/**
 * 云函数 analyzeImage
 * 入参：{ fileID } —— thumbs/ 目录下的压缩缩略图（长期保留，本函数只读不删）
 * 行为：调视觉多模态模型生成六维标签（Qwen-VL / Kimi-VL 双模型适配）
 * 环境变量：
 *   AI_PROVIDER       可选，模型提供方：qwen（默认）/ kimi
 *   DASHSCOPE_API_KEY qwen 模式必填，阿里云百炼 API Key
 *   QWEN_MODEL        可选，默认 qwen-vl-plus
 *   KIMI_API_KEY      kimi 模式必填，Moonshot 开放平台 API Key
 *   KIMI_MODEL        可选，默认 moonshot-v1-32k-vision-preview
 */
const cloud = require('wx-server-sdk');
const https = require('https');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const accounts = db.collection('accessAccounts');

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function filePrefix(openid) {
  return 'userFiles/' + hash(openid) + '/';
}

async function getAccount(openid) {
  try {
    const result = await accounts.where({ _id: openid }).limit(1).get();
    return result.data[0] || null;
  } catch (error) {
    const message = String(error && error.message || error || '');
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
      return null;
    }
    throw error;
  }
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
    const message = String(error && error.message || error || '');
    if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(message)) {
      return false;
    }
    throw error;
  }
}

async function checkUploadAccess(fileID) {
  const openid = cloud.getWXContext().OPENID;
  if (!openid) return { ok: false, error: '无法识别当前微信用户' };
  const [admin, account] = await Promise.all([isAdmin(openid), getAccount(openid)]);
  const activated = admin || !!(account && account.activated === true && !account.cleanupPending);
  if (!activated) return { ok: false, error: '请先在「我的」输入校验码成为花艺师' };
  const prefix = '/' + filePrefix(openid);
  if (typeof fileID !== 'string' || fileID.indexOf(prefix) < 0) {
    return { ok: false, error: '图片不属于当前账号' };
  }
  return { ok: true };
}

// 两个提供方都走 OpenAI 兼容的 /chat/completions 协议，请求体可复用
const PROVIDERS = {
  qwen: {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyEnv: 'DASHSCOPE_API_KEY',
    modelEnv: 'QWEN_MODEL',
    defaultModel: 'qwen-vl-plus'
  },
  kimi: {
    url: 'https://api.moonshot.cn/v1/chat/completions',
    keyEnv: 'KIMI_API_KEY',
    modelEnv: 'KIMI_MODEL',
    defaultModel: 'moonshot-v1-32k-vision-preview'
  }
};

function getProvider() {
  const name = (process.env.AI_PROVIDER || 'qwen').trim().toLowerCase();
  const p = PROVIDERS[name];
  if (!p) {
    throw new Error('AI_PROVIDER 配置无效：' + name + '（可选值：' + Object.keys(PROVIDERS).join(' / ') + '）');
  }
  return { name, url: p.url, apiKey: process.env[p.keyEnv], model: process.env[p.modelEnv] || p.defaultModel, keyEnv: p.keyEnv };
}

const COLORS = ['红', '粉', '橙', '黄', '绿', '紫', '蓝', '白', '香槟色', '复古色', '混色'];

// AI 常见说法 → 标准枚举 的映射（含"色"字后缀的兜底在 normColor 里处理）
const COLOR_ALIAS = {
  '香槟': '香槟色', '奶白': '白', '米白': '白', '纯白': '白', '象牙白': '白', '乳白': '白',
  '橘': '橙', '橘红': '橙', '橘黄': '橙', '金黄': '黄', '淡黄': '黄', '鹅黄': '黄',
  '粉红': '粉', '桃红': '粉', '玫红': '粉', '裸粉': '粉', '肉粉': '粉',
  '酒红': '红', '正红': '红', '深红': '红',
  '复古': '复古色', '莫兰迪': '复古色', '焦糖': '复古色', '咖': '复古色', '咖啡': '复古色', '奶茶': '复古色',
  '彩色': '混色', '多色': '混色', '缤纷': '混色', '彩虹': '混色'
};

/** 把 AI 输出的颜色说法归一到枚举；归一不了返回 null */
function normColor(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (COLORS.indexOf(s) >= 0) return s;
  if (COLOR_ALIAS[s]) return COLOR_ALIAS[s];
  const bare = s.replace(/色$/, '');
  if (COLORS.indexOf(bare) >= 0) return bare;
  if (COLOR_ALIAS[bare]) return COLOR_ALIAS[bare];
  // 包含匹配（长的优先，避免“香槟色”被单字误吞）
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

const SYSTEM_PROMPT = [
  '你是一名资深花艺师，擅长分析花艺作品照片。',
  '请观察用户发送的图片，仅输出一个 JSON 对象（不要输出任何其他文字），字段如下：',
  '{',
  '  "colors": ["作品主色调，1-3个，只能从以下值中选：' + COLORS.join('、') + '"],',
  '  "colorScheme": "作品整体色系归属，单选，只能从以下值中选：' + COLOR_SCHEMES.join('、') + '"，',
  '  "flowers": {',
  '    "main": ["视觉主体花材的中文名，如 玫瑰"],',
  '    "sub": ["补充花材的中文名，如 洋桔梗"],',
  '    "leaf": ["配叶的中文名，如 尤加利叶"]',
  '  },',
  '  "category": "作品形式，单选，只能从以下值中选：' + CATEGORIES.join('、') + '"，',
  '  "style": "花艺风格，单选，只能从以下值中选：' + STYLES.join('、') + '"，',
  '  "occasion": ["适合的用途场景，可从以下值中多选：' + OCCASIONS.join('、') + '"],',
  '  "confidence": { "colors": 0到1, "colorScheme": 0到1, "flowers": 0到1, "category": 0到1, "style": 0到1, "occasion": 0到1 }',
  '}',
  '要求：',
  '1. colors 为必填项，至少给出 1 个最贴近的颜色；颜色只从枚举中选，不要自造名称。',
  '2. colorScheme 看作品整体主导色调归属；没有主导色、颜色杂糅时填"混合颜色"。',
  '3. 花材名称使用花艺行业通用中文名；玫瑰与月季请严格区分；不确定的花材不要编造，留空数组。',
  '4. 不要遗漏画面中占比较大的花材（如向日葵、绣球、百合等大花头花材）；主花是视觉占比最大、最焦点的一到两种花材；绿色配叶一律归入 leaf。',
  '5. 无法判断的维度，单选字段填"其他"，多选字段填空数组，对应 confidence 给低分；但 colors 不允许留空，colorScheme 不允许留空（兜底"混合颜色"）。',
  '6. 只输出 JSON，不要 markdown 代码块，不要解释。'
].join('\n');

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      timeout: 55000,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers)
    }, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error('AI 接口返回非 JSON：' + buf.slice(0, 200)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 接口超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function extractJson(text) {
  if (!text) throw new Error('AI 返回为空');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('未找到 JSON：' + s.slice(0, 120));
  return JSON.parse(s.slice(start, end + 1));
}

function normalize(raw) {
  raw = raw || {};
  const inList = (v, list, fb) => (list.indexOf(v) >= 0 ? v : fb);
  const arrIn = (v, list) => (Array.isArray(v) ? v.filter(x => list.indexOf(x) >= 0) : []);
  const strArr = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : []);
  const flowers = raw.flowers && typeof raw.flowers === 'object' ? raw.flowers : {};
  const conf = raw.confidence && typeof raw.confidence === 'object' ? raw.confidence : {};
  const num = v => (typeof v === 'number' && v >= 0 && v <= 1 ? v : 0.5);
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .map(normColor)
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3);
  return {
    colors,
    colorScheme: inList(raw.colorScheme, COLOR_SCHEMES, '混合颜色'),
    flowersMain: strArr(flowers.main),
    flowersSub: strArr(flowers.sub),
    flowersLeaf: strArr(flowers.leaf),
    category: inList(raw.category, CATEGORIES, '其他'),
    style: inList(raw.style, STYLES, '其他'),
    occasion: arrIn(raw.occasion, OCCASIONS),
    confidence: {
      colors: num(conf.colors),
      colorScheme: num(conf.colorScheme),
      flowers: num(conf.flowers),
      category: num(conf.category),
      style: num(conf.style),
      occasion: num(conf.occasion)
    }
  };
}

exports.main = async (event) => {
  const fileID = event && event.fileID;
  if (!fileID) return { ok: false, error: '缺少 fileID' };

  try {
    const access = await checkUploadAccess(fileID);
    if (!access.ok) return access;
  } catch (error) {
    console.error('access check:', error);
    return { ok: false, error: '账号校验失败，请稍后重试' };
  }

  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!provider.apiKey) {
    return { ok: false, error: '云函数未配置 ' + provider.keyEnv + ' 环境变量（当前 AI_PROVIDER=' + provider.name + '）' };
  }

  try {
    // 1. 下载分析副本并转 base64
    const file = await cloud.downloadFile({ fileID });
    const base64 = file.fileContent.toString('base64');

    // 2. 调视觉模型（qwen-vl-plus 或 kimi vision，均为 OpenAI 兼容协议）
    const resp = await postJson(
      provider.url,
      { Authorization: 'Bearer ' + provider.apiKey },
      {
        model: provider.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: '请分析这张花艺作品图片，按要求输出 JSON。' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } }
            ]
          }
        ]
      }
    );

    if (resp.error) throw new Error(resp.error.message || 'AI 接口报错（' + provider.name + '）');
    const content = resp.choices && resp.choices[0] && resp.choices[0].message
      ? resp.choices[0].message.content : '';
    const tags = normalize(extractJson(content));
    return { ok: true, tags };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  // 注意：入参 fileID 是 thumbs/ 下长期保存的缩略图（列表/详情展示共用），
  // 本函数只读取、绝不删除。早期的 analysis/ 一次性副本机制已废弃。
};
