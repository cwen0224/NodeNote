import { isPlainObject } from './cloudSyncUtils.js';

export function applyCloudSyncStatePatch(state = {}, patch = {}) {
  const target = isPlainObject(state) ? state : {};
  const safePatch = isPlainObject(patch) ? patch : {};

  if (Object.prototype.hasOwnProperty.call(safePatch, 'lastFingerprint')) {
    target.lastFingerprint = safePatch.lastFingerprint;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'lastSyncedAt')) {
    target.lastSyncedAt = safePatch.lastSyncedAt;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'lastRemoteRevision')) {
    target.lastRemoteRevision = safePatch.lastRemoteRevision;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'lastRemoteSha')) {
    target.lastRemoteSha = safePatch.lastRemoteSha;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'spreadsheetUrl')) {
    target.spreadsheetUrl = safePatch.spreadsheetUrl;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'spreadsheetId')) {
    target.spreadsheetId = safePatch.spreadsheetId;
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'syncCountDelta')) {
    const delta = Number(safePatch.syncCountDelta);
    target.syncCount = (Number.isFinite(target.syncCount) ? target.syncCount : 0) + (Number.isFinite(delta) ? delta : 0);
  }

  if (Object.prototype.hasOwnProperty.call(safePatch, 'lastError')) {
    target.lastError = safePatch.lastError;
  }

  if (safePatch.clearLastError) {
    target.lastError = null;
  }

  return target;
}
