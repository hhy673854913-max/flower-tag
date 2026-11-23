// 上传登记是文件归属的唯一入口；提交与回收都写会话文档形成事务冲突。
const crypto = require('crypto');
const https = require('https');
const DAY = 24 * 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const random = () => crypto.randomBytes(16).toString('hex');
const idValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestValue = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
const ext = value => typeof value === 'string' && /^[a-z0-9]{1,10}$/.test(value.toLowerCase()) ? value.toLowerCase() : 'jpg';

module.exports = function ({ db, cloud, userWrite, owner, filePrefix, pickTags, checkedTags, fail, metadata }) {
  const jobs = db.collection('uploadJobs');
  async function get(collection, id) {
    if (typeof id !== 'string' || !id || id.length > 256) fail('上传任务参数无效');
    // where 能明确区分文档不存在与查询失败；查询失败绝不猜测可以删图。
    return (await collection.where({ _id: id }).limit(1).get()).data[0] || null;
  }
  async function session(tx, id, openid, active = false, account) {
    if (!idValue(id)) fail('上传会话参数无效');
    const s = await get(tx.collection('uploadJobs'), id);
    if (!s || s.type !== 'session' || s.ownerOpenid !== openid) fail('上传会话不存在或无权访问');
    if (active && (s.state !== 'open' || s.expiresAt <= Date.now()
      || !account || account.uploadVersion !== s.uploadVersion)) fail('该批图片已失效，请重新选图');
    return s;
  }
  async function image(tx, s, id) {
    if (!idValue(id)) fail('上传图片任务无效');
    const j = await get(tx.collection('uploadJobs'), id);
    if (!j || j.type !== 'image' || j.sessionId !== s._id || j.ownerOpenid !== s.ownerOpenid) fail('上传图片任务无效');
    return j;
  }
  const publicJob = j => ({
    jobId: j._id, slot: j.slot, state: j.state, recordId: j.recordId || '',
    commitFingerprint: j.commitFingerprint || ''
  });
  const prepared = j => Object.assign(publicJob(j), {
    cloudPath: j.cloudPath, thumbCloudPath: j.thumbCloudPath, fileID: j.fileID, thumbFileID: j.thumbFileID
  });
  async function touch(tx, s, patch = {}) {
    await tx.collection('uploadJobs').doc(s._id).update({
      data: Object.assign({ revision: (s.revision || 0) + 1 }, patch)
    });
  }
  async function readUploadSession(event, openid) {
    const s = await session(db, event.sessionId, openid);
    const result = await jobs.where({ type: 'image', sessionId: s._id }).orderBy('_id', 'asc').limit(100).get();
    return { ok: true, sessionId: s._id, state: s.state, expiresAt: s.expiresAt,
      expired: s.expiresAt <= Date.now(), jobs: result.data.map(publicJob) };
  }
  async function beginUploadSession(event, openid) {
    if (!requestValue(event.requestId) || !['primary', 'extra'].includes(event.kind)) fail('上传会话参数无效');
    if (event.kind === 'extra' && (typeof event.targetRecordId !== 'string' || !event.targetRecordId)) fail('附加图目标无效');
    const id = digest(['session', openid, event.requestId]);
    const fingerprint = digest([event.kind, event.kind === 'extra' ? event.targetRecordId : '']);
    return userWrite(openid, async (tx, account) => {
      const existing = await get(tx.collection('uploadJobs'), id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('上传请求参数冲突，请重新选图');
        await session(tx, id, openid, true, account);
        return { ok: true, sessionId: id, expiresAt: existing.expiresAt };
      }
      if (event.kind === 'extra') {
        const r = (await tx.collection('records').doc(event.targetRecordId).get()).data;
        if (!r || owner(r) !== openid || r.deleting) fail('目标作品不可添加图片');
      }
      const version = account && account.uploadVersion || random();
      if (!account || !account.uploadVersion) await tx.collection('accessAccounts').doc(openid).update({ data: { uploadVersion: version } });
      const expiresAt = Date.now() + DAY;
      await tx.collection('uploadJobs').doc(id).set({ data: {
        type: 'session', ownerOpenid: openid, uploadVersion: version,
        kind: event.kind, targetRecordId: event.kind === 'extra' ? event.targetRecordId : '',
        fingerprint, state: 'open', createdAt: db.serverDate(), expiresAt,
        gcDueAt: expiresAt, gcCursor: '', attempts: 0, revision: 0
      } });
      return { ok: true, sessionId: id, expiresAt };
    });
  }
  async function prepareUploadJob(event, openid) {
    if (!requestValue(event.requestId) || !Number.isInteger(event.slot) || event.slot < 0 || event.slot > 8) fail('图片登记参数无效');
    const s = await session(db, event.sessionId, openid);
    const id = digest(['image', openid, s._id, event.requestId]);
    const originalExt = ext(event.originalExt), thumbExt = ext(event.thumbExt);
    const fingerprint = digest([event.slot, originalExt, thumbExt]);
    const existing = await get(jobs, id);
    if (existing && existing.fingerprint !== fingerprint) fail('图片登记请求参数冲突');
    const cloudPath = filePrefix(openid) + 'works/uploads/' + s._id + '/' + id + '.' + originalExt;
    const thumbCloudPath = filePrefix(openid) + 'thumbs/uploads/' + s._id + '/' + id + '.' + thumbExt;
    const sealedPrefix = 'sealedFiles/' + crypto.createHash('sha256').update(openid).digest('hex') + '/' + s._id + '/' + id + '/';
    const sealedPath = sealedPrefix + 'original.' + originalExt;
    const sealedThumbPath = sealedPrefix + 'thumb.' + thumbExt;
    // SDK 返回准确 fileId；签名、token 等从不落库或回传客户端。
    const ids = existing ? [existing.fileID, existing.thumbFileID, existing.sealedFileID, existing.sealedThumbFileID] : await Promise.all(
      [cloudPath, thumbCloudPath, sealedPath, sealedThumbPath].map(async path => {
        const result = await metadata({ cloudPath: path });
        const fileID = result && result.data && result.data.fileId;
        if (typeof fileID !== 'string' || !fileID.startsWith('cloud://') || !fileID.endsWith('/' + path)) fail('图片登记服务暂不可用');
        return fileID;
      })
    );
    return userWrite(openid, async (tx, account) => {
      const current = await session(tx, s._id, openid, true, account);
      if (current.kind === 'extra' && event.slot > 7) fail('附加图最多 8 张');
      const old = await get(tx.collection('uploadJobs'), id);
      if (old) {
        if (old.fingerprint !== fingerprint || old.state !== 'pending') fail('旧上传尝试已失效，请重新上传');
        return Object.assign({ ok: true }, prepared(old));
      }
      if (current.attempts >= 100) fail('该批尝试次数已用完，请重新选图');
      const j = {
        type: 'image', sessionId: s._id, ownerOpenid: openid, slot: event.slot,
        fingerprint, state: 'pending', cloudPath, thumbCloudPath, fileID: ids[0], thumbFileID: ids[1],
        sealedPath, sealedThumbPath, sealedFileID: ids[2], sealedThumbFileID: ids[3],
        recordId: current.kind === 'primary' ? digest(['record', openid, id]) : current.targetRecordId,
        createdAt: db.serverDate(), gcDueAt: current.expiresAt, gcAttempts: 0
      };
      await tx.collection('uploadJobs').doc(id).set({ data: j });
      await touch(tx, current, { attempts: current.attempts + 1 });
      return Object.assign({ ok: true }, prepared(Object.assign({ _id: id }, j)));
    });
  }
  async function abandonUploadJob(event, openid) {
    return db.runTransaction(async tx => {
      const s = await session(tx, event.sessionId, openid);
      const j = await image(tx, s, event.jobId);
      if (j.state === 'pending') await tx.collection('uploadJobs').doc(j._id).update({ data: { state: 'abandoned', gcDueAt: Date.now() } });
      await touch(tx, s, { gcDueAt: Math.min(s.gcDueAt, Date.now()), gcCursor: '' });
      return { ok: true, state: j.state === 'pending' ? 'abandoned' : j.state };
    });
  }
  async function closeState(event, openid) {
    await db.runTransaction(async tx => {
      const s = await session(tx, event.sessionId, openid);
      await touch(tx, s, {
        state: 'closed', closeReason: ['cancel', 'leave', 'finish', 'replace', 'clear', 'revoke'].includes(event.reason) ? event.reason : 'cancel',
        gcDueAt: Math.min(s.gcDueAt, Date.now()), gcCursor: ''
      });
    });
  }
  async function closeUploadSession(event, openid) {
    await closeState(event, openid);
    // 即时尽力回收；失败仍由定时器兜底，不把已关闭误报为关闭失败。
    try { await reap({ sessionId: event.sessionId, budget: 10 }); } catch (_) { /* 台账保留 */ }
    return readUploadSession(event, openid);
  }
  async function closeOwnUploadSessions(event, openid) {
    if (event.cursor && !idValue(event.cursor)) fail('上传会话游标无效');
    const where = { type: 'session', ownerOpenid: openid, state: 'open' };
    if (event.cursor) where._id = db.command.gt(event.cursor);
    const rows = (await jobs.where(where).orderBy('_id', 'asc').limit(10).get()).data;
    for (const s of rows) await closeState({ sessionId: s._id, reason: 'clear' }, openid);
    return { ok: true, hasMore: rows.length === 10, nextCursor: rows.length ? rows[rows.length - 1]._id : '' };
  }
  function head(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      const req = https.request(url, { method: 'HEAD' }, res => {
        res.resume();
        finish(res.statusCode === 200 ? null : new Error('图片尚未上传完整，请重试'));
      });
      const timer = setTimeout(() => { req.destroy(); finish(new Error('图片状态确认超时，请重试')); }, 5000);
      req.on('error', () => finish(new Error('图片状态暂时无法确认，请重试')));
      req.end();
    });
  }
  async function verifyFiles(list) {
    const ids = list.reduce((all, j) => all.concat(j.fileID, j.thumbFileID), []);
    const result = await cloud.getTempFileURL({ fileList: ids });
    const files = result.fileList || [];
    await Promise.all(ids.map(async id => {
      const f = files.find(item => item.fileID === id);
      if (!f || f.status !== 0 || !/^https:\/\//.test(f.tempFileURL || '')) fail('图片尚未上传完整，请重试');
      await head(f.tempFileURL);
    }));
  }
  async function commit(event, openid, extra) {
    const s = await session(db, event.sessionId, openid);
    if (s.kind !== (extra ? 'extra' : 'primary')) fail('上传会话类型不匹配');
    const ids = extra ? event.jobIds : [event.jobId];
    if (!Array.isArray(ids) || !ids.length || ids.length > (extra ? 8 : 1)
      || ids.some(id => !idValue(id)) || new Set(ids).size !== ids.length) fail('上传提交参数无效');
    const tags = extra ? {} : await checkedTags(event.tags, openid);
    if (Buffer.byteLength(JSON.stringify(tags), 'utf8') > 64 * 1024) fail('标签内容过长');
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
      ? Object.keys(value).sort().reduce((obj, key) => { obj[key] = stable(value[key]); return obj; }, {}) : value;
    const fingerprint = digest(extra ? ids.slice().sort() : stable(tags));
    const list = await Promise.all(ids.map(id => image(db, s, id)));
    // 已提交的重试不依赖文件仍存在（作品可能已被用户删除）。
    if (!list.every(j => j.state === 'committed')) {
      await verifyFiles(list);
      for (const j of list) {
        if (!j.audit || j.audit.version !== 1 || j.audit.uploadVersion !== s.uploadVersion) fail('图片尚未通过安全审核，请重试上传');
        if (!j.sealedFileID || !j.sealedThumbFileID) fail('请重新登记上传图片');
        const buffers = await Promise.all([j.fileID, j.thumbFileID].map(fileID => cloud.downloadFile({ fileID })));
        if (buffers.some((f, i) => crypto.createHash('sha256').update(f.fileContent).digest('hex')
          !== (i ? j.audit.thumbHash : j.audit.originalHash))) fail('图片内容已变化，请重新审核');
        // 正式路径只允许服务端写；先永久绑定摘要，同任务并发只能复制相同字节。
        const sealedHash = digest([j.audit.originalHash, j.audit.thumbHash]);
        await userWrite(openid, async (tx, account) => {
          const current = await session(tx, s._id, openid, true, account);
          const entry = await image(tx, current, j._id);
          if (entry.state !== 'pending' || JSON.stringify(entry.audit) !== JSON.stringify(j.audit)
            || (entry.sealedHash && entry.sealedHash !== sealedHash)) fail('图片状态已变化，请重新上传');
          await tx.collection('uploadJobs').doc(j._id).update({ data: { sealedHash } });
          await touch(tx, current);
        });
        for (const [i, path] of [j.sealedPath, j.sealedThumbPath].entries()) {
          const copied = await cloud.uploadFile({ cloudPath: path, fileContent: buffers[i].fileContent });
          if (!copied || copied.fileID !== (i ? j.sealedThumbFileID : j.sealedFileID)) fail('图片归档未完成，请重试保存');
        }
      }
    }
    return userWrite(openid, async (tx, account) => {
      const current = await session(tx, s._id, openid);
      const entries = await Promise.all(ids.map(id => image(tx, current, id)));
      if (entries.some(j => j.compacted)) fail('保存结果已归档，请查看现有作品');
      if (entries.every(j => j.state === 'committed' && j.commitFingerprint === fingerprint)) {
        return { ok: true, id: entries[0].recordId, committed: true };
      }
      if (entries.some(j => j.state === 'committed')) fail('该图片已保存，请在作品详情编辑');
      await session(tx, s._id, openid, true, account);
      if (entries.some(j => j.state !== 'pending')) fail('上传已取消或正在回收');
      if (entries.some((j, i) => JSON.stringify(j.audit) !== JSON.stringify(list[i].audit))) fail('图片审核状态已变化，请重试');
      if (entries.some(j => j.sealedHash !== digest([j.audit.originalHash, j.audit.thumbHash])
        || !j.sealedFileID.endsWith('/' + j.sealedPath) || !j.sealedThumbFileID.endsWith('/' + j.sealedThumbPath))) fail('图片归档状态无效');
      // 防御固定任务路径，不接受客户端文件参数。
      if (entries.some(j => !j.fileID.endsWith('/' + j.cloudPath) || !j.thumbFileID.endsWith('/' + j.thumbCloudPath))) fail('图片登记状态无效');
      const records = tx.collection('records');
      const recordId = entries[0].recordId;
      if (extra) {
        const r = (await records.doc(current.targetRecordId).get()).data;
        if (!r || owner(r) !== openid || r.deleting) fail('目标作品不可添加图片');
        if ((r.extraFiles || []).length + entries.length > 8) fail('附加图最多 8 张，请重新选择');
        await records.doc(recordId).update({ data: {
          extraFiles: (r.extraFiles || []).concat(entries.map(j => ({ fileID: j.sealedFileID, thumbFileID: j.sealedThumbFileID })))
        } });
      } else {
        const old = await get(records, recordId);
        if (old) fail('该作品已经保存，请查看作品墙');
        await records.doc(recordId).set({ data: Object.assign({}, tags, {
          _openid: openid, fileID: entries[0].sealedFileID, thumbFileID: entries[0].sealedThumbFileID,
          createdAt: db.serverDate(), isPublic: false
        }) });
      }
      for (const j of entries) await tx.collection('uploadJobs').doc(j._id).update({ data: {
        state: 'committed', commitFingerprint: fingerprint, committedAt: Date.now(), gcDueAt: Date.now(), stagingCleaned: false
      } });
      await touch(tx, current);
      return { ok: true, id: recordId, committed: true };
    });
  }
  async function referenced(j) {
    const r = await get(db.collection('records'), j.recordId);
    if (!r) return false;
    const pairs = [{ fileID: r.fileID, thumbFileID: r.thumbFileID }].concat(r.extraFiles || []);
    // 任一文件已有引用也保留整对，不能猜测另一个可以删除。
    return pairs.some(p => [j.fileID, j.sealedFileID].includes(p.fileID)
      || [j.thumbFileID, j.sealedThumbFileID].filter(Boolean).includes(p.thumbFileID));
  }
  async function removeFiles(ids) {
    ids = [...new Set(ids.filter(Boolean))];
    if (!ids.length) return true;
    const result = await cloud.deleteFile({ fileList: ids });
    return ids.every(id => (result.fileList || []).some(f => f.fileID === id
      && (f.status === 0 || /not.?exist|not.?found|不存在/i.test(f.errMsg || ''))));
  }
  async function cleanOne(sid, jid, lease) {
    const j = await db.runTransaction(async tx => {
      const s = await get(tx.collection('uploadJobs'), sid);
      const current = await get(tx.collection('uploadJobs'), jid);
      if (!s || s.gcLease !== lease || !current) return null;
      if (current.state === 'committed') {
        if (current.recoveredReference) return null;
        // 暂存必须持续扫七天，覆盖入库并发请求晚落盘；正式副本由作品删除负责。
        if (current.committedAt + 7 * DAY <= Date.now() && current.stagingCleaned && !current.compacted) {
          await tx.collection('uploadJobs').doc(jid).update({ data: {
            compacted: true, cloudPath: '', thumbCloudPath: '', fileID: '', thumbFileID: '',
            sealedPath: '', sealedThumbPath: '', sealedFileID: '', sealedThumbFileID: '', gcDueAt: 8640000000000000
          } });
        }
        return current.compacted || (current.committedAt + 7 * DAY <= Date.now() && current.stagingCleaned) ? null : current;
      }
      if ((current.state !== 'pending' && current.gcDueAt > Date.now())
        || (current.state === 'pending' && s.state === 'open')) return null;
      if (current.leaseUntil > Date.now()) return null;
      await tx.collection('uploadJobs').doc(jid).update({ data: { state: 'cleaning', gcLease: lease, leaseUntil: Date.now() + 60000 } });
      await touch(tx, s);
      return current;
    });
    if (!j) return false;
    if (j.state === 'committed') {
      let success = false;
      try {
        // 作品已删时也收回并发请求可能晚落盘的正式副本。
        const keep = await referenced(j);
        success = await removeFiles([j.fileID, j.thumbFileID].concat(keep ? [] : [j.sealedFileID, j.sealedThumbFileID]));
      } catch (_) { /* 保留重试 */ }
      await db.runTransaction(async tx => {
        const current = await get(tx.collection('uploadJobs'), jid);
        if (current && current.state === 'committed' && !current.compacted) {
          await tx.collection('uploadJobs').doc(jid).update({ data: {
            stagingCleaned: success, gcDueAt: Date.now() + TEN_MIN,
            cleanupError: success ? '' : '暂存文件回收待重试'
          } });
        }
      });
      return true;
    }
    let success = false, keep = false;
    try {
      keep = await referenced(j);
      if (!keep) {
        success = await removeFiles([j.fileID, j.thumbFileID, j.sealedFileID, j.sealedThumbFileID]);
      }
    } catch (_) { /* 查询失败和删除失败都保留准确引用 */ }
    await db.runTransaction(async tx => {
      const current = await get(tx.collection('uploadJobs'), jid);
      if (!current || current.gcLease !== lease || current.state !== 'cleaning') return;
      if (keep) {
        await tx.collection('uploadJobs').doc(jid).update({ data: {
          state: 'committed', committedAt: Date.now(), gcLease: '', leaseUntil: 0, recoveredReference: true,
          gcDueAt: 8640000000000000
        } });
      } else if (success && j.tombstoneUntil && j.tombstoneUntil <= Date.now()) {
        await tx.collection('uploadJobs').doc(jid).remove();
      } else {
        await tx.collection('uploadJobs').doc(jid).update({ data: {
          state: success ? 'cleaned' : 'abandoned', gcLease: '', leaseUntil: 0,
          gcAttempts: (j.gcAttempts || 0) + 1, cleanupError: success ? '' : '文件回收待重试',
          tombstoneUntil: j.tombstoneUntil || (success ? Date.now() + 7 * DAY : 0),
          gcDueAt: Date.now() + (success && j.tombstoneUntil ? DAY : TEN_MIN)
        } });
      }
    });
    return true;
  }
  async function reap(options = {}) {
    const started = Date.now(), deadline = started + 45000;
    const budget = Math.min(options.budget || 10, 10);
    const rows = options.sessionId ? [await get(jobs, options.sessionId)]
      : (await jobs.where({ type: 'session', gcDueAt: db.command.lte(Date.now()) })
        .orderBy('gcDueAt', 'asc').orderBy('_id', 'asc').limit(10).get()).data;
    let processed = 0;
    for (const row of rows.filter(Boolean)) {
      if (Date.now() >= deadline || processed >= budget) break;
      const lease = random();
      const s = await db.runTransaction(async tx => {
        const current = await get(tx.collection('uploadJobs'), row._id);
        if (!current || current.leaseUntil > Date.now()) return null;
        const patch = { gcLease: lease, leaseUntil: Date.now() + 60000 };
        if (current.state === 'open' && current.expiresAt <= Date.now()) Object.assign(patch, { state: 'closed', closeReason: 'expired' });
        await touch(tx, current, patch);
        return Object.assign({}, current, patch);
      });
      if (!s) continue;
      try {
        const where = { type: 'image', sessionId: s._id };
        if (s.gcCursor) where._id = db.command.gt(s.gcCursor);
        const entries = (await jobs.where(where).orderBy('_id', 'asc').limit(budget - processed).get()).data;
        let last = s.gcCursor || '';
        for (const j of entries) {
          if (Date.now() >= deadline || processed >= budget) break;
          await cleanOne(s._id, j._id, lease);
          processed++; last = j._id;
        }
        const hasMore = last && (await jobs.where({ type: 'image', sessionId: s._id, _id: db.command.gt(last) }).limit(1).get()).data.length;
        const all = hasMore ? [] : (await jobs.where({ type: 'image', sessionId: s._id }).limit(100).get()).data;
        const nextDue = all.reduce((due, j) => Math.min(due, j.state === 'committed'
          ? j.compacted ? 8640000000000000 : j.gcDueAt
          : j.state === 'pending' && s.state === 'open' ? s.expiresAt : j.gcDueAt), 8640000000000000);
        await db.runTransaction(async tx => {
          const current = await get(tx.collection('uploadJobs'), s._id);
          if (!current || current.gcLease !== lease) return;
          // 关闭/放弃可能在清理期间重置游标，不能覆盖新安排。
          const changed = (current.gcCursor || '') !== (s.gcCursor || '') || current.state !== s.state;
          await touch(tx, current, { gcLease: '', leaseUntil: 0,
            gcCursor: changed ? '' : hasMore ? last : '',
            gcDueAt: hasMore || changed ? Date.now() : Math.max(Date.now() + TEN_MIN,
              current.state === 'open' ? Math.min(current.expiresAt, nextDue) : nextDue)
          });
        });
      } catch (_) {
        // 租约超时可接管，台账/游标仍在。日志不包含文件/作者/请求体。
        console.warn('uploadGc', { session: s._id.slice(0, 10), state: 'retry' });
      }
    }
    console.info('uploadGc', { processed, elapsedMs: Date.now() - started });
    return { ok: true, processed };
  }
  async function cleanupOwner(openid) {
    // 旧环境尚未创建集合时，不妨碍旧作品撤销；新版上传初始化仍必须失败。
    try {
      const result = await closeOwnUploadSessions({}, openid);
      if (result.hasMore) return true;
      const account = (await db.collection('accessAccounts').doc(openid).get()).data;
      const where = { type: 'session', ownerOpenid: openid, state: 'closed' };
      if (account.uploadCleanupCursor) where._id = db.command.gt(account.uploadCleanupCursor);
      const rows = (await jobs.where(where).orderBy('_id', 'asc').limit(10).get()).data;
      let budget = 10;
      for (const s of rows) {
        const result = await reap({ sessionId: s._id, budget });
        budget -= result.processed;
        const pending = (await jobs.where({ type: 'image', sessionId: s._id }).limit(100).get()).data;
        if (pending.some(j => !['committed', 'cleaned'].includes(j.state))) {
          if (budget <= 0) return true;
          fail('上传图片回收未完成，请十分钟后继续清理');
        }
        await db.collection('accessAccounts').doc(openid).update({ data: { uploadCleanupCursor: s._id } });
        if (budget <= 0) return true;
      }
      return rows.length === 10;
    } catch (error) {
      if (/collection not exists|COLLECTION_NOT_EXIST|Db or Table not exist/i.test(String(error.message || error))) return false;
      throw error;
    }
  }
  return {
    actions: { beginUploadSession, prepareUploadJob, readUploadSession, abandonUploadJob, closeUploadSession,
      closeOwnUploadSessions, commitUploadRecord: (e, o) => commit(e, o, false), commitExtraUploads: (e, o) => commit(e, o, true) },
    reap, cleanupOwner
  };
};
