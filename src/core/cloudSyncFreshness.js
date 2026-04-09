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
  localEditedAt = null,
  remoteEditedAt = null,
  localSavedAt = null,
  remoteSavedAt = null,
} = {}) {
  const localTime = parseTimestamp(localEditedAt || localSavedAt);
  const remoteTime = parseTimestamp(remoteEditedAt || remoteSavedAt);
  const hasLocalTime = Number.isFinite(localTime);
  const hasRemoteTime = Number.isFinite(remoteTime);

  const result = {
    winner: 'unknown',
    shouldApplyRemote: true,
    localEditedAt: formatTimestamp(localEditedAt || localSavedAt),
    remoteEditedAt: formatTimestamp(remoteEditedAt || remoteSavedAt),
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

  if (deltaMs >= 0) {
    result.winner = 'remote';
    result.shouldApplyRemote = true;
    result.reason = deltaMs === 0 ? 'remote-equal' : 'remote-newer';
    return result;
  }

  result.winner = 'local';
  result.shouldApplyRemote = false;
  result.reason = 'local-newer';
  return result;
}
