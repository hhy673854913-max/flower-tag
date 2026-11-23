const crypto = require('crypto');

const PAGE_SIZE = 20;
const QUERY_SIZE = 100;
const MAX_SELECTED = 1000;
const MAX_BYTES = 128 * 1024;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const VERSION_RE = /^[a-f0-9]{32}$/;
const META = { _id: true, _openid: true, ownerOpenid: true, createdAt: true,
  deleting: true, deleted: true, deletedAt: true };

module.exports = function portfolioService({ db, cloud, userWrite, getAccount, isAdmin, owner, ownedWhere, fail, pickTags, checkedPortfolioText }) {
  const links = db.collection('shareLinks');
  const works = db.collection('records');
  const cmd = db.command;
  const live = record => record && !record.deleting && !record.deleted && !record.deletedAt;
  const version = account => account && account.portfolioVersion;
  const time = row => {
    const value = row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt);
    return Number.isFinite(value) ? value : 0;
  };
  const compare = (a, b) => time(b) - time(a) || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0);
  const scope = value => crypto.createHash('sha256').update(value).digest('hex');
  function id(value) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256) fail('作品集或作品 ID 参数无效');
    return value;
  }
  function text(value, title) {
    if (typeof value !== 'string') fail('作品集标题和描述必须为文本');
    const normalized = value.trim();
    const length = Array.from(normalized).length;
    if (title && (!length || length > 40 || /[\r\n\u2028\u2029]/.test(normalized))) {
      fail('作品集标题须为 1～40 字的单行文本');
    }
    if (!title && length > 300) fail('作品集描述不能超过 300 字');
    return normalized;
  }
  function metadata(link) {
    const safe = (value, title) => {
      try { return text(value, title); } catch (_) { return ''; }
    };
    return { title: safe(link.title, true), description: safe(link.description, false) };
  }
  function editable(link, account, openid) {
    if (account && account.cleanupPending) fail('账号正在清理，不能编辑作品集');
    if (!link || link.ownerOpenid !== openid || !validLink(link, account)) {
      fail('无权编辑该作品集或分享已失效，请刷新重试');
    }
  }
  function selection(value) {
    if (!Array.isArray(value) || !value.length) fail('请至少选择一件作品');
    if (value.length > MAX_SELECTED) fail('所选数量超限，最多提交 1000 件作品（含重复项），请减少选择');
    value.forEach(id);
    const ids = [...new Set(value)];
    if (Buffer.byteLength(JSON.stringify(ids), 'utf8') > MAX_BYTES) fail('所选作品 ID 字节容量超限（128 KiB），请减少选择');
    return ids;
  }
  function page(rows, cursor, context, limit) {
    let after = null;
    if (cursor !== undefined && cursor !== '') {
      try {
        if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor)) throw new Error();
        after = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        if (after.v !== 1 || after.scope !== scope(context) || !Number.isFinite(after.time)
          || typeof after.id !== 'string' || !after.id || Buffer.byteLength(after.id) > 256) throw new Error();
      } catch (_) { fail('作品集分页游标无效，请刷新重试'); }
    }
    rows.sort(compare);
    const eligible = after ? rows.filter(row => time(row) < after.time
      || (time(row) === after.time && row._id < after.id)) : rows;
    const records = eligible.slice(0, limit);
    const hasMore = eligible.length > limit;
    const last = records[records.length - 1];
    return { records, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({
      v: 1, scope: scope(context), time: time(last), id: last._id
    })).toString('base64') : '' };
  }
  // Scan only metadata with an ID keyset: no skip ceiling or missing-createdAt loss.
  async function scan(collection, where, fields, stopWhen) {
    const rows = [];
    let last = '';
    while (true) {
      const query = last ? cmd.and([where, { _id: cmd.gt(last) }]) : where;
      const batch = (await collection.where(query).field(fields).orderBy('_id', 'asc').limit(QUERY_SIZE).get()).data;
      rows.push(...batch);
      if (batch.length < QUERY_SIZE || stopWhen && batch.some(stopWhen)) return rows;
      last = batch[batch.length - 1]._id;
    }
  }
  async function byIds(collection, ids, fields) {
    const rows = [];
    for (let i = 0; i < ids.length; i += QUERY_SIZE) {
      let query = collection.where({ _id: cmd.in(ids.slice(i, i + QUERY_SIZE)) }).limit(QUERY_SIZE);
      if (fields) query = query.field(fields);
      rows.push(...(await query.get()).data);
    }
    return rows;
  }
  async function manager(openid) {
    const account = await getAccount(openid);
    if ((account && account.cleanupPending) || !(await isAdmin(openid) || account && account.activated === true)) {
      fail('账号未开通或正在清理，不能管理作品集');
    }
    return account;
  }
  function validLink(link, account) {
    return link && link.type === 'portfolio' && link.enabled === true
      && (link.mode === 'all' || link.mode === 'selected')
      && VERSION_RE.test(version(account) || '') && link.portfolioVersion === version(account);
  }
  async function authorize(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) fail('作品集分享已失效');
    const result = await links.where({ type: 'portfolio', token }).limit(2).get();
    const link = result.data[0];
    if (result.data.length !== 1 || !link || typeof link.ownerOpenid !== 'string' || !link.ownerOpenid) fail('作品集分享已失效');
    const account = await getAccount(link.ownerOpenid);
    if (!validLink(link, account) || account.cleanupPending
      || !(await isAdmin(link.ownerOpenid) || account.activated === true)) fail('作品集分享已失效');
    if (link.mode === 'selected') {
      // Unknown historical structures fail closed, never fall back to all.
      try { link.recordIds = selection(link.recordIds); } catch (_) { fail('作品集分享已失效，请作者重新创建'); }
    }
    return { link, name: typeof account.name === 'string' && account.name.trim() ? account.name : '花艺师' };
  }
  async function visible(link) {
    const rows = link.mode === 'all'
      ? await scan(works, ownedWhere(link.ownerOpenid), META)
      : await byIds(works, link.recordIds, META);
    return rows.filter(row => owner(row) === link.ownerOpenid && live(row));
  }
  async function allowedRecord(link, recordId) {
    id(recordId);
    if (link.mode === 'selected' && !link.recordIds.includes(recordId)) fail('作品不在该作品集范围内');
    const rows = await byIds(works, [recordId]);
    if (!live(rows[0]) || owner(rows[0]) !== link.ownerOpenid) fail('作品已删除或不在该作品集范围内');
    return rows[0];
  }
  function detail(record) {
    const tags = pickTags(record);
    Object.keys(tags).forEach(key => {
      const value = tags[key];
      if (Array.isArray(value)) tags[key] = value.filter(item => typeof item === 'string');
      else if (typeof value !== 'string' && typeof value !== 'number') delete tags[key];
    });
    const file = item => ({ fileID: typeof item.fileID === 'string' ? item.fileID : '',
      thumbFileID: typeof item.thumbFileID === 'string' ? item.thumbFileID : '' });
    return Object.assign(tags, { _id: record._id }, file(record), {
      extraFiles: Array.isArray(record.extraFiles) ? record.extraFiles.filter(item => item && typeof item === 'object').map(file) : []
    });
  }
  function displayFiles(record, original) {
    return [...new Set([record].concat(record.extraFiles || []).map(item =>
      original ? item.fileID : item.thumbFileID || item.fileID).filter(value =>
      typeof value === 'string' && value.startsWith('cloud://')))];
  }
  async function urlsFor(ids) {
    const urls = {};
    for (let i = 0; i < ids.length; i += 50) {
      const result = await cloud.getTempFileURL({ fileList: ids.slice(i, i + 50) });
      (result.fileList || []).forEach(file => {
        if (file.status === 0 && ids.includes(file.fileID)) urls[file.fileID] = file.tempFileURL;
      });
    }
    return urls;
  }
  return {
    async createPortfolioShare(event, openid) {
      if (event.mode !== 'all' && event.mode !== 'selected') fail('作品集 mode 必须为 all 或 selected');
      if (event.mode === 'all' && event.recordIds !== undefined) fail('全部作品模式不能指定作品 ID');
      const ids = event.mode === 'selected' ? selection(event.recordIds) : null;
      const token = crypto.randomBytes(24).toString('hex');
      return userWrite(openid, async (tx, account) => {
        if (account && account.cleanupPending) fail('账号正在清理，不能创建作品集');
        const collection = tx.collection('records');
        const rows = ids ? await byIds(collection, ids, META)
          : await scan(collection, ownedWhere(openid), META, row => owner(row) === openid && live(row));
        const valid = rows.filter(row => owner(row) === openid && live(row));
        if (ids && valid.length !== ids.length) fail('所选作品含他人、不存在或删除中的作品，请重新选择');
        if (!valid.length) fail('没有可分享的作品，请先上传作品');
        const epoch = VERSION_RE.test(version(account) || '') ? version(account) : crypto.randomBytes(16).toString('hex');
        await tx.collection('accessAccounts').doc(openid).update({ data: { portfolioVersion: epoch } });
        const data = { type: 'portfolio', ownerOpenid: openid, mode: event.mode, token,
          enabled: true, createdAt: db.serverDate(), portfolioVersion: epoch };
        if (ids) data.recordIds = ids;
        if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_BYTES + 4096) fail('作品集文档字节容量超限，请减少选择');
        const result = await tx.collection('shareLinks').add({ data });
        return { ok: true, id: result._id, token, mode: event.mode };
      });
    },
    async listPortfolioShares(event, openid) {
      await manager(openid);
      const rows = await scan(links, { type: 'portfolio', ownerOpenid: openid }, {
        _id: true, token: true, mode: true, enabled: true, createdAt: true, portfolioVersion: true, type: true,
        title: true, description: true, updatedAt: true
      });
      const result = page(rows, event.cursor, 'manage:' + openid, PAGE_SIZE);
      const account = await manager(openid);
      return { ok: true, records: result.records.map(row => Object.assign({ id: row._id, token: row.token,
        mode: row.mode, enabled: validLink(row, account), createdAt: row.createdAt,
        updatedAt: row.updatedAt === undefined ? null : row.updatedAt }, metadata(row))),
        nextCursor: result.nextCursor, hasMore: result.hasMore };
    },
    async updatePortfolioMetadata(event, openid) {
      id(event.id);
      const title = text(event.title, true);
      const description = text(event.description, false);
      const account = await manager(openid);
      const rows = (await links.where({ _id: event.id }).limit(1).get()).data;
      editable(rows[0], account, openid);
      await checkedPortfolioText(title, openid);
      if (description) await checkedPortfolioText(description, openid);
      const result = await userWrite(openid, async (tx, currentAccount) => {
        const collection = tx.collection('shareLinks');
        const current = (await collection.where({ _id: event.id }).limit(1).get()).data[0];
        editable(current, currentAccount, openid);
        await collection.doc(event.id).update({ data: { title, description, updatedAt: db.serverDate() } });
        return { ok: true, id: event.id, title, description };
      });
      // Read after commit so the response contains the resolved server timestamp.
      const saved = (await links.doc(event.id).get()).data;
      return Object.assign(result, { updatedAt: saved.updatedAt });
    },
    async stopPortfolioShare(event, openid) {
      id(event.id);
      return userWrite(openid, async (tx, account) => {
        if (account && account.cleanupPending) fail('账号正在清理，不能管理作品集');
        const collection = tx.collection('shareLinks');
        const rows = (await collection.where({ _id: event.id, type: 'portfolio', ownerOpenid: openid }).limit(1).get()).data;
        if (!rows.length) fail('无权停止该作品集分享');
        if (rows[0].enabled !== false) await collection.doc(event.id).update({
          data: { enabled: false, disabledAt: db.serverDate() }
        });
        return { ok: true };
      });
    },
    async readPortfolioShare(event) {
      const limit = event.limit === undefined ? PAGE_SIZE : event.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) fail('作品集 limit 必须为 1～20 的整数');
      const { link, name } = await authorize(event.token);
      const rows = await visible(link);
      const result = page(rows, event.cursor, 'read:' + event.token, limit);
      const fetched = await byIds(works, result.records.map(row => row._id));
      const ordered = result.records.map(row => fetched.find(item => item._id === row._id))
        .filter(row => live(row) && owner(row) === link.ownerOpenid);
      const ids = ordered.map(row => row.thumbFileID || row.fileID).filter(value =>
        typeof value === 'string' && value.startsWith('cloud://'));
      const urls = await urlsFor([...new Set(ids)]);
      const remaining = await byIds(works, ordered.map(row => row._id), META);
      const current = await authorize(event.token);
      return Object.assign({ ok: true, name, mode: link.mode, total: rows.length,
        records: ordered.filter(row => remaining.some(item => item._id === row._id
          && live(item) && owner(item) === link.ownerOpenid)).map(row => {
          const tags = detail(row);
          return { _id: row._id, category: tags.category || '', style: tags.style || '',
            colors: tags.colors || [], thumbnailUrl: urls[row.thumbFileID || row.fileID] || '' };
        }), nextCursor: result.nextCursor, hasMore: result.hasMore }, metadata(current.link));
    },
    async readPortfolioRecord(event) {
      if (event.original !== undefined && typeof event.original !== 'boolean') fail('original 必须为布尔值');
      const { link, name } = await authorize(event.token);
      const record = detail(await allowedRecord(link, event.recordId));
      const urls = await urlsFor(displayFiles(record, event.original === true));
      const current = await authorize(event.token);
      const latest = detail(await allowedRecord(current.link, event.recordId));
      if (JSON.stringify(record) !== JSON.stringify(latest)) fail('作品已发生变化，请重新加载');
      return { ok: true, name, record, urls };
    }
  };
};
