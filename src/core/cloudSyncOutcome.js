import { isPlainObject, sanitizeText as sanitizeString } from './cloudSyncUtils.js';

function assignIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') {
    target[key] = value;
  }
}

export function buildCloudSyncSuccessPatch({
  fingerprint = null,
  syncedAt = null,
  remoteRevision = null,
  remoteSha = null,
  spreadsheetUrl = null,
  spreadsheetId = null,
  syncCountDelta = 0,
  clearLastError = true,
} = {}) {
  const patch = {};
  assignIfPresent(patch, 'lastFingerprint', fingerprint);
  assignIfPresent(patch, 'lastSyncedAt', syncedAt);
  assignIfPresent(patch, 'lastRemoteRevision', remoteRevision);
  assignIfPresent(patch, 'lastRemoteSha', remoteSha);
  assignIfPresent(patch, 'spreadsheetUrl', spreadsheetUrl);
  assignIfPresent(patch, 'spreadsheetId', spreadsheetId);

  if (Number.isFinite(syncCountDelta) && syncCountDelta !== 0) {
    patch.syncCountDelta = syncCountDelta;
  }

  if (clearLastError) {
    patch.clearLastError = true;
  }

  return patch;
}

export function buildCloudSyncErrorPatch(error, fallbackMessage = '同步失敗') {
  if (!error) {
    return { lastError: sanitizeString(fallbackMessage, '同步失敗') };
  }

  if (typeof error === 'string') {
    return { lastError: sanitizeString(error, fallbackMessage) };
  }

  if (isPlainObject(error) && typeof error.message === 'string' && error.message.trim()) {
    return { lastError: sanitizeString(error.message, fallbackMessage) };
  }

  return { lastError: sanitizeString(fallbackMessage, '同步失敗') };
}
