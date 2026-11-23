'use strict';
/* 回归共用桩：SDK 拦截 + 云数据库模拟 + 静态加载器。 */
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..');
const MP = path.join(ROOT, 'miniprogram');

let srv = null;
const cloudSdkStub = {
  DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
  init() {},
  database: () => srv.db,
  getWXContext: () => ({ OPENID: srv.openid }),
  getTempFileURL: async function (params) {
    return {
      fileList: (params.fileList || []).map(function (id) {
        return { fileID: id, status: 0, tempFileURL: 'https://signed.example/' + encodeURIComponent(id) };
      })
    };
  },
  deleteFile: async function (params) {
    return { fileList: (params.fileList || []).map(function (id) { return { fileID: id, status: 0 }; }) };
  },
  openapi: {
    security: {
      msgSecCheck: async function () { return { errCode: 0, result: { suggest: 'pass' } }; }
    }
  }
};

const nodeSdkStub = {
  init: function () {
    return {
      getUploadMetadata: async function () { return { data: { fileId: 'cloud://stub/seed' } }; }
    };
  }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') { return cloudSdkStub; }
  if (request === '@cloudbase/node-sdk') { return nodeSdkStub; }
  return origLoad.call(Module, request, parent, isMain);
};

/* 云数据库条件匹配 */
const op = function (name, v) { return { __op: name, v: v }; };
function matchCond(doc, cond) {
  if (cond === null || cond === undefined) { return true; }
  if (cond.__op === 'and') { return cond.arr.every(x => matchCond(doc, x)); }
  if (cond.__op === 'or') { return cond.arr.some(x => matchCond(doc, x)); }
  if (typeof cond !== 'object' || Array.isArray(cond)) { return true; }
  return Object.keys(cond).every(function (key) {
    const v = cond[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__op) {
      if (v.__op === 'in') { return v.v.indexOf(doc[key]) >= 0; }
      if (v.__op === 'gt') { return doc[key] !== undefined && doc[key] > v.v; }
      if (v.__op === 'neq') { return doc[key] !== v.v; }
      if (v.__op === 'exists') { return (doc[key] !== undefined) === v.v; }
    }
    return doc[key] === v;
  });
}

/* 云数据库集合桩 */
function makeDb(fixture) {
  const buckets = fixture.collections;
  function collection(name) {
    const bucket = buckets[name] || (buckets[name] = { rows: [] });
    function query() {
      let cond = null;
      const order = [];
      let lim = Infinity;
      let skipCount = 0;
      const q = {
        where: function (x) { cond = x; return q; },
        field: function () { return q; },
        orderBy: function (key, dir) { order.push([key, dir === 'desc' ? -1 : 1]); return q; },
        skip: function (n) { skipCount = n; return q; },
        limit: function (n) { lim = n; return q; },
        get: async function () {
          fixture.log.queries.push({ collection: name, scan: order.length > 0 });
          let rows = bucket.rows.filter(r => matchCond(r, cond));
          if (order.length) {
            rows = rows.slice().sort(function (a, b) {
              let i;
              for (i = 0; i < order.length; i++) {
                const av = a[order[i][0]];
                const bv = b[order[i][0]];
                if (av !== bv) { return (av < bv ? -1 : 1) * order[i][1]; }
              }
              return 0;
            });
          }
          const capped = lim === Infinity ? rows : rows.slice(skipCount, skipCount + lim);
          return { data: capped.map(r => JSON.parse(JSON.stringify(r))) };
        },
        count: async function () {
          return { total: bucket.rows.filter(r => matchCond(r, cond)).length };
        }
      };
      return q;
    }
    return Object.assign(query(), docApi(bucket, name, fixture));
  }
  return {
    command: {
      or: arr => ({ __op: 'or', arr: arr }),
      and: arr => ({ __op: 'and', arr: arr }),
      in: v => op('in', v),
      gt: v => op('gt', v),
      neq: v => op('neq', v),
      exists: v => op('exists', v),
      serverDate: () => ({ __serverDate: true })
    },
    collection: collection,
    runTransaction: async function (fn) { return fn({ collection: collection }); }
  };
}

/* 集合的文档级 API */
function docApi(bucket, name, fixture) {
  return {
    doc: function (id) {
      return {
        get: async function () {
          const row = bucket.rows.find(r => r._id === id);
          if (!row || (fixture.failDocGets && fixture.failDocGets.has(name + '/' + id))) {
            throw new Error('document.get:fail document not exist');
          }
          return { data: JSON.parse(JSON.stringify(row)) };
        },
        update: async function (params) {
          const row = bucket.rows.find(r => r._id === id);
          if (!row) { throw new Error('document.update:fail document not exist'); }
          Object.assign(row, JSON.parse(JSON.stringify(params.data)));
          return {};
        },
        set: async function (params) {
          const clean = JSON.parse(JSON.stringify(params.data));
          delete clean._id;
          const row = bucket.rows.find(r => r._id === id);
          if (row) { Object.assign(row, clean); } else { bucket.rows.push(Object.assign({ _id: id }, clean)); }
          return {};
        },
        remove: async function () {
          const idx = bucket.rows.findIndex(r => r._id === id);
          if (idx >= 0) { bucket.rows.splice(idx, 1); }
          return {};
        }
      };
    },
    add: async function (params) {
      bucket.rows.push(JSON.parse(JSON.stringify(params.data)));
      return { _id: 'new-' + crypto.randomBytes(8).toString('hex') };
    }
  };
}

/* 服务端夹具 */
function newServerFixture(options) {
  const opts = options || {};
  process.env.ADMIN_OPENIDS = '';
  delete process.env.ACCESS_CODES;
  delete process.env.ACCESS_CODE_HASH;
  const openid = 'openid-A';
  const hashA = crypto.createHash('sha256').update(openid).digest('hex');
  const prefix = 'userFiles/' + hashA + '/';
  const records = [];
  const count = opts.recordCount || 6;
  let i;
  for (i = 0; i < count; i++) {
    records.push({
      _id: 'r' + ((i * 7 + 3) % count),
      _openid: openid,
      createdAt: new Date(Date.now() - i * 1000),
      fileID: 'cloud://env.appid/' + prefix + 'works/w' + i + '.jpg',
      thumbFileID: 'cloud://env.appid/' + prefix + 'thumbs/t' + i + '.jpg',
      deleting: false
    });
  }
  srv = {
    openid: openid,
    prefix: prefix,
    records: records,
    collections: {
      accessAccounts: { rows: [{ _id: openid, activated: true, name: 'A' }] },
      admins: { rows: [] },
      records: { rows: records },
      tags: { rows: [] },
      shareLinks: { rows: [] },
      uploadJobs: { rows: [] }
    },
    log: { queries: [] },
    failDocGets: opts.failDocGets || null
  };
  srv.db = makeDb(srv);
  return srv;
}

/* require 缓存清理 + 静态字面量加载器 */
function purgeAll() {
  const sep = path.sep;
  const sepAG = sep + 'accessGate' + sep;
  const sepMP = sep + 'miniprogram' + sep;
  Object.keys(require.cache).forEach(function (key) {
    if (key.indexOf(ROOT) === 0 && (key.indexOf(sepAG) >= 0 || key.indexOf(sepMP) >= 0)) {
      delete require.cache[key];
    }
  });
}
function loadGate() { purgeAll(); return require('../../cloudfunctions/accessGate/index.js'); }
function loadApi() { purgeAll(); return require('../../miniprogram/utils/api.js'); }
function loadIndexPage() { purgeAll(); require('../../miniprogram/pages/index/index.js'); return global.__pageConfig; }
function loadFilterPage() { purgeAll(); require('../../miniprogram/pages/filter/filter.js'); return global.__pageConfig; }
function loadImageUtil() { purgeAll(); return require('../../miniprogram/utils/image.js'); }

/* 客户端全局桩与页面实例构造 */
function installClientGlobals() {
  const store = new Map();
  const calls = [];
  const uploadScope = 'a'.repeat(64);
  const app = {
    globalData: {
      envId: 'env1', dbUpdateTime: Date.now(), pendingList: [],
      accessStatus: {
        ok: true, activated: true, isAdmin: false, role: 'florist', name: 'A',
        cleanupPending: false, canUpload: true, canShare: true, uploadScope,
        filePrefix: 'userFiles/x/'
      },
      accessStatusTime: Date.now()
    }
  };
  function respond(name, data) {
    if (data.action === 'getOwnFileUrls') {
      const urls = {};
      (data.fileIDs || []).forEach(function (id) {
        urls[id] = 'https://signed.example/' + encodeURIComponent(id);
      });
      return { result: { ok: true, urls: urls, expiresAt: Date.now() + 3600000 } };
    }
    if (data.action === 'countRecords') { return { result: { ok: true, total: 3 } }; }
    if (data.action === 'status') { return { result: Object.assign({}, app.globalData.accessStatus) }; }
    return { result: { ok: true } };
  }
  global.getApp = function () { return app; };
  global.Page = function (config) { global.__pageConfig = config; return config; };
  global.Component = function (config) { return config; };
  global.getCurrentPages = function () { return []; };
  global.wx = {
    cloud: {
      init() {},
      callFunction: async function (params) { calls.push(params); return respond(params.name, params.data); },
      deleteFile: async function () { return { fileList: [] }; },
      uploadFile: async function () { return { fileID: 'cloud://stub/x' }; }
    },
    getStorageSync: k => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k, v) => { store.set(k, v); },
    removeStorageSync: k => { store.delete(k); },
    showToast() {}, showLoading() {}, hideLoading() {}, showModal() {}, showActionSheet() {},
    onNetworkStatusChange() {}, getNetworkType() {},
    switchTab() {}, navigateTo() {}, navigateBack() {}, hideShareMenu() {}, showShareMenu() {},
    pageScrollTo() {}, stopPullDownRefresh() {}, previewImage() {}, chooseMedia() {},
    compressImage() {}, getImageInfo() {}
  };
  return { app: app, calls: calls, store: store, uploadScope: uploadScope };
}

/* setData 路径键解析（如 list[150].imageLoading） */
function parseKey(key) {
  const segs = [];
  let buf = '';
  let i;
  for (i = 0; i < key.length; i++) {
    const ch = key.charAt(i);
    if (ch === '.' || ch === '[' || ch === ']') {
      if (buf) { segs.push(buf); buf = ''; }
    } else {
      buf += ch;
    }
  }
  if (buf) { segs.push(buf); }
  return segs;
}
function applyPath(root, key, value) {
  const segs = parseKey(key);
  let cur = root;
  let i;
  for (i = 0; i < segs.length; i++) {
    const raw = segs[i];
    const isLast = i === segs.length - 1;
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw);
      if (isLast) { cur[idx] = value; return; }
      if (cur[idx] === undefined) { cur[idx] = {}; }
      cur = cur[idx];
    } else {
      if (isLast) { cur[raw] = value; return; }
      if (cur[raw] === undefined) { cur[raw] = {}; }
      cur = cur[raw];
    }
  }
}

/* 页面实例：setData 记录载荷并按路径键更新 data */
function makePageInstance(config, data) {
  const inst = Object.create(config);
  inst.data = data;
  const payloads = [];
  inst.setData = function (p) {
    payloads.push(p);
    Object.keys(p).forEach(function (key) {
      if (key.indexOf('.') >= 0 || key.indexOf('[') >= 0) { applyPath(inst.data, key, p[key]); }
      else { inst.data[key] = p[key]; }
    });
    return p;
  };
  inst.__payloads = payloads;
  return inst;
}

module.exports = {
  newServerFixture, installClientGlobals, makePageInstance,
  loadGate, loadApi, loadIndexPage, loadFilterPage, loadImageUtil, MP
};
