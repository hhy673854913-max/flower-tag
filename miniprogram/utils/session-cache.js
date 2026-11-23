// Private data lives only in this module, never in wx storage.
const DATA_TTL = 10 * 60 * 1000;
const URL_TTL = 8 * 60 * 1000;
let entryGeneration = 0, identityGeneration = 0, mutationGeneration = 0, verificationGeneration = 0;
let identityKey = '', observedDirty, observedEnv, observedAccess;
const values = new Map(), pending = new Map();

function globalData() { return getApp().globalData; }
function keyFor(status, env) {
  if (!status || typeof status.uploadScope !== 'string' || !status.uploadScope
    || typeof status.role !== 'string') return '';
  return JSON.stringify([env, status.uploadScope, status.role, !!status.cleanupPending]);
}
function accessKey(status) {
  return status ? JSON.stringify([!!status.activated, !!status.canUpload, !!status.canShare]) : '';
}
function clear() { values.clear(); pending.clear(); }
function bumpDirty() {
  const data = globalData();
  const previous = Number(data.dbUpdateTime) || 0;
  data.dbUpdateTime = Math.max(Date.now(), previous + 1);
  observedDirty = data.dbUpdateTime;
}
function sync() {
  const data = globalData();
  if (observedEnv !== undefined && observedEnv !== data.envId) {
    entryGeneration++;
    identityGeneration++;
    verificationGeneration++;
    identityKey = '';
    data.accessStatus = null;
    data.accessStatusTime = 0;
    clear();
  }
  observedEnv = data.envId;
  if (observedDirty !== undefined && observedDirty !== data.dbUpdateTime) {
    mutationGeneration++;
    verificationGeneration++;
    clear();
    // Also repair a legacy Date.now() write that moved the marker backwards.
    data.dbUpdateTime = Math.max(Date.now(), Number(data.dbUpdateTime) || 0, Number(observedDirty) + 1);
  }
  observedDirty = data.dbUpdateTime;
  const currentKey = keyFor(data.accessStatus, data.envId);
  const currentAccess = accessKey(data.accessStatus);
  if (currentKey !== identityKey) {
    identityGeneration++;
    verificationGeneration++;
    identityKey = currentKey;
    clear();
  } else if (observedAccess !== undefined && currentAccess !== observedAccess) {
    mutationGeneration++;
    verificationGeneration++;
    clear();
    bumpDirty();
  }
  observedAccess = currentAccess;
}
function capture() {
  sync();
  return { entryGeneration, identityGeneration, mutationGeneration, verificationGeneration,
    identityKey, env: observedEnv };
}
function isCurrent(stamp) {
  sync();
  return stamp.env === observedEnv && stamp.entryGeneration === entryGeneration
    && stamp.identityGeneration === identityGeneration && stamp.mutationGeneration === mutationGeneration
    && stamp.verificationGeneration === verificationGeneration && stamp.identityKey === identityKey;
}
function staleError() {
  const error = new Error('会话或数据已变化，请重试');
  error.staleSession = true;
  return error;
}
function assertCurrent(stamp) { if (!isCurrent(stamp)) throw staleError(); }
function requestKey(stamp, name) { return JSON.stringify([stamp, name]); }
function forceReview() {
  sync();
  verificationGeneration++;
  pending.clear();
  return capture();
}
function invalidate() {
  sync();
  mutationGeneration++;
  verificationGeneration++;
  clear();
  bumpDirty();
}
function beginEntry() {
  sync();
  entryGeneration++;
  identityGeneration++;
  verificationGeneration++;
  identityKey = '';
  globalData().accessStatus = null;
  globalData().accessStatusTime = 0;
  observedAccess = '';
  clear();
  return capture();
}
function appHide() { return beginEntry(); }
function fail(stamp) {
  if (!isCurrent(stamp)) return;
  identityGeneration++;
  verificationGeneration++;
  identityKey = '';
  globalData().accessStatus = null;
  globalData().accessStatusTime = 0;
  observedAccess = '';
  clear();
  bumpDirty();
}
function commitStatus(stamp, status) {
  const data = globalData(), nextKey = keyFor(status, data.envId);
  const current = capture();
  // A parallel page/status pair may confirm the same first identity.
  const sameBootstrap = !stamp.identityKey && nextKey && nextKey === current.identityKey
    && stamp.env === current.env && stamp.entryGeneration === current.entryGeneration
    && stamp.mutationGeneration === current.mutationGeneration
    && stamp.verificationGeneration === current.verificationGeneration
    && current.identityGeneration === stamp.identityGeneration + 1;
  if (!sameBootstrap) assertCurrent(stamp);
  if (!nextKey || typeof status.canUpload !== 'boolean' || typeof status.cleanupPending !== 'boolean') {
    fail(stamp);
    throw new Error('账号服务尚未更新，请更新服务后重试');
  }
  const previous = data.accessStatus;
  data.accessStatus = Object.assign({}, status);
  data.accessStatusTime = Date.now();
  observedAccess = accessKey(status);
  if (identityKey !== nextKey) {
    identityKey = nextKey;
    identityGeneration++;
    clear();
    bumpDirty();
  } else if (previous && (previous.activated !== status.activated || previous.canUpload !== status.canUpload
    || previous.canShare !== status.canShare)) {
    mutationGeneration++;
    clear();
    bumpDirty();
  }
  if (!status.canUpload || status.cleanupPending) clear();
  return capture();
}
function privateReady() {
  sync();
  const status = globalData().accessStatus;
  return !!(identityKey && status && status.canUpload && !status.cleanupPending);
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function read(name, ttl = DATA_TTL) {
  sync();
  if (!privateReady()) return null;
  const value = values.get(name);
  if (!value || value.identityKey !== identityKey || value.mutationGeneration !== mutationGeneration
    || Date.now() < value.time || Date.now() - value.time >= ttl || Date.now() >= value.expiresAt) {
    values.delete(name);
    return null;
  }
  return copy(value.data);
}
function write(stamp, name, data, ttl = DATA_TTL, expiresAt = Infinity) {
  assertCurrent(stamp);
  if (!privateReady()) return;
  const time = Date.now();
  values.set(name, { identityKey, mutationGeneration, time, expiresAt: Math.min(time + ttl, expiresAt), data: copy(data) });
}
function forget(name) { values.delete(name); }
function share(stamp, name, operation) {
  assertCurrent(stamp);
  const key = requestKey(stamp, name);
  if (pending.has(key)) return pending.get(key);
  const promise = Promise.resolve().then(() => {
    assertCurrent(stamp);
    return operation();
  }).finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}
module.exports = {
  DATA_TTL, URL_TTL, beginEntry, appHide, invalidate, capture, isCurrent, assertCurrent,
  forceReview, commitStatus, fail, privateReady, read, write, forget, share, copy, staleError
};
