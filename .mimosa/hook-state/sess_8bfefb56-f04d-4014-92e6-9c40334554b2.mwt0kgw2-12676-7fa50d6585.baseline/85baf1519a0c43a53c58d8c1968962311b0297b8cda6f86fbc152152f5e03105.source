const CARD_FIELDS = ['_id', 'fileID', 'thumbFileID', 'category', 'style', 'flowersMain'];

module.exports = function createRecordPage({
  db, cloud, works, getAccount, isAdmin, owner, ownedWhere, usable, publicStatus, fail
}) {
  function displayID(record) {
    return record.thumbFileID || record.fileID || '';
  }
  function card(record) {
    const result = {};
    CARD_FIELDS.forEach(key => {
      if (record[key] !== undefined) result[key] = record[key];
    });
    return result;
  }
  function canRead(account, admin) {
    return usable(account, admin) && !(account && account.cleanupPending);
  }
  function rows(result) {
    if (!result || !Array.isArray(result.data)) fail('作品读取失败，请重试');
    return result.data;
  }
  const fields = CARD_FIELDS.concat(['_openid', 'ownerOpenid', 'deleting'])
    .reduce((result, key) => { result[key] = true; return result; }, {});

  return async function getRecordPage(event, openid, account, admin) {
    const skip = event.skip === undefined ? 0 : event.skip;
    const limit = event.limit === undefined ? 20 : event.limit;
    if (!Number.isSafeInteger(skip) || skip < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      fail('作品分页参数无效');
    }
    if (!canRead(account, admin)) {
      return {
        ok: true, status: publicStatus(account, openid, admin),
        records: [], urls: {}, hasMore: false, nextSkip: skip
      };
    }
    const condition = db.command.and([ownedWhere(openid), { deleting: db.command.neq(true) }]);
    const queried = rows(await works.where(condition).field(fields)
      .orderBy('createdAt', 'desc').orderBy('_id', 'desc').skip(skip).limit(limit + 1).get());
    const page = queried.slice(0, limit);
    if (page.some(record => owner(record) !== openid || record.deleting)) fail('作品已变化，请刷新');
    const ids = [...new Set(page.map(displayID).filter(id =>
      typeof id === 'string' && id.startsWith('cloud://')))];
    const urls = {};
    if (ids.length) {
      // Only the server-selected display files on this page may receive URLs.
      const signed = await cloud.getTempFileURL({ fileList: ids });
      if (!signed || !Array.isArray(signed.fileList)) fail('图片链接读取失败，请重试');
      for (const id of ids) {
        const file = signed.fileList.find(item => item.fileID === id);
        if (!file || !Number.isInteger(file.status)) fail('图片链接读取失败，请重试');
        if (file.status === 0) {
          if (typeof file.tempFileURL !== 'string' || !file.tempFileURL) fail('图片链接读取失败，请重试');
          urls[id] = file.tempFileURL;
        } else if (!/non.?exist|not.?exist|not.?found|不存在/i.test(file.errMsg || '')) {
          fail('图片链接读取失败，请重试');
        }
      }
    }
    // Recheck even empty pages; failed reads must not become successful empty data.
    const current = page.length ? rows(await works.where(db.command.and([
      condition, { _id: db.command.in(page.map(record => record._id)) }
    ])).field(fields).limit(limit).get()) : [];
    const currentById = new Map(current.map(record => [record._id, record]));
    const records = page.map(record => {
      const latest = currentById.get(record._id);
      if (!latest || owner(latest) !== openid || latest.deleting
        || displayID(latest) !== displayID(record)
        || latest.fileID !== record.fileID || latest.thumbFileID !== record.thumbFileID) {
        fail('作品已变化，请刷新');
      }
      return card(latest);
    });
    const currentAccount = await getAccount(openid);
    const currentAdmin = await isAdmin(openid);
    if (!canRead(currentAccount, currentAdmin)) fail('账号权限已变化，请刷新');
    const nextSkip = skip + page.length;
    if (!Number.isSafeInteger(nextSkip)) fail('作品分页参数无效');
    return {
      ok: true, status: publicStatus(currentAccount, openid, currentAdmin),
      records, urls, hasMore: queried.length > limit, nextSkip
    };
  };
};
