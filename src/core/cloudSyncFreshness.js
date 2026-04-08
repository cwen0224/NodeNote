import { sanitizeText as sanitizeString } from './cloudSyncUtils.js';

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function formatTimestamp(value) {
  return sanitizeString(value, '');
}

export function resolveCloudSyncFreshness({
  localSavedAt = null,
  remoteSavedAt = null,
  toleranceMs = 15000,
} = {}) {
  const localTime = parseTimestamp(localSavedAt);
  const remoteTime = parseTimestamp(remoteSavedAt);
  const hasLocalTime = Number.isFinite(localTime);
  const hasRemoteTime = Number.isFinite(remoteTime);

  const result = {
    winner: 'unknown',
    shouldApplyRemote: true,
    localSavedAt: formatTimestamp(localSavedAt),
    remoteSavedAt: formatTimestamp(remoteSavedAt),
    deltaMs: null,
    reason: 'timestamp-unavailable',
  };

  if (!hasLocalTime && !hasRemoteTime) {
    return result;
  }

  if (!hasRemoteTime) {
    result.winner = 'local';
    result.shouldApplyRemote = false;
    result.reason = 'remote-timestamp-missing';
    return result;
  }

  if (!hasLocalTime) {
    result.winner = 'remote';
    result.shouldApplyRemote = true;
    result.reason = 'local-timestamp-missing';
    return result;
  }

  const deltaMs = remoteTime - localTime;
  result.deltaMs = deltaMs;

  if (Math.abs(deltaMs) <= Math.max(0, Number(toleranceMs) || 0)) {
    result.winner = 'tie';
    result.shouldApplyRemote = true;
    result.reason = 'within-tolerance';
    return result;
  }

  if (deltaMs > 0) {
    result.winner = 'remote';
    result.shouldApplyRemote = true;
    result.reason = 'remote-newer';
    return result;
  }

  result.winner = 'local';
  result.shouldApplyRemote = false;
  result.reason = 'local-newer';
  return result;
}
