import { commitCloudSyncStatePatch } from './cloudSyncStateCommit.js';
import { buildCloudSyncErrorPatch, buildCloudSyncSuccessPatch } from './cloudSyncOutcome.js';

export function finishCloudSyncSuccess(target, {
  patch = {},
  statusMessage = '',
  statusDetail = '',
  logScope = 'sheet',
  logTitle = '同步完成',
  logDetail = '',
  logKind = 'success',
  logContext = {},
} = {}) {
  if (!target) {
    return false;
  }

  commitCloudSyncStatePatch(target, buildCloudSyncSuccessPatch(patch));

  if (typeof target.setStatus === 'function') {
    target.setStatus('ok', statusMessage, statusDetail);
  }

  if (typeof target.appendSyncLog === 'function') {
    target.appendSyncLog(logKind, logScope, logTitle, logDetail, logContext);
  }

  return true;
}

export function finishCloudSyncIdle(target, {
  patch = {},
  statusMessage = '',
  statusDetail = '',
  logScope = 'sheet',
  logTitle = '同步保留本機版本',
  logDetail = '',
  logKind = 'info',
  logContext = {},
} = {}) {
  if (!target) {
    return false;
  }

  commitCloudSyncStatePatch(target, buildCloudSyncSuccessPatch(patch));

  if (typeof target.setStatus === 'function') {
    target.setStatus('idle', statusMessage, statusDetail);
  }

  if (typeof target.appendSyncLog === 'function') {
    target.appendSyncLog(logKind, logScope, logTitle, logDetail, logContext);
  }

  return true;
}

export function finishCloudSyncError(target, {
  error,
  fallbackMessage = '同步失敗',
  logScope = 'sheet',
  logTitle = '同步失敗',
  logDetail = '',
  logContext = {},
} = {}) {
  if (!target) {
    return false;
  }

  const message = typeof error === 'string' ? error : error?.message || fallbackMessage;
  commitCloudSyncStatePatch(target, buildCloudSyncErrorPatch(message, fallbackMessage));

  if (typeof target.setStatus === 'function') {
    target.setStatus('error', message);
  }

  if (typeof target.appendSyncLog === 'function') {
    target.appendSyncLog('error', logScope, logTitle, logDetail || message, logContext);
  }

  return false;
}
