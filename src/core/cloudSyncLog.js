import {
  compactLogText,
  createLogId,
  isPlainObject,
  normalizeLogLevel,
  sanitizeText as sanitizeString,
  formatLogStamp,
} from './cloudSyncUtils.js';

export function normalizeSyncLogEntry(entry) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const at = typeof entry.at === 'string' ? entry.at : new Date().toISOString();
  const level = normalizeLogLevel(entry.level);
  const action = sanitizeString(entry.action, 'sync');
  const message = sanitizeString(entry.message, '同步日誌');
  const detail = compactLogText(entry.detail ?? entry.summary ?? entry.note ?? '');
  const context = isPlainObject(entry.context) ? entry.context : {};

  return {
    id: sanitizeString(entry.id, createLogId()),
    at,
    level,
    action,
    message,
    detail,
    context,
  };
}

export function createSyncLogEntry({ level, action, message, detail = '', context = {} } = {}) {
  return normalizeSyncLogEntry({
    id: createLogId(),
    at: new Date().toISOString(),
    level,
    action,
    message,
    detail,
    context,
  });
}

export function buildSyncLogText(logEntries = []) {
  if (!Array.isArray(logEntries) || !logEntries.length) {
    return 'NodeNote 本機同步日誌目前是空的。';
  }

  return logEntries
    .map((entry) => {
      const parts = [
        `[${formatLogStamp(entry.at)}]`,
        entry.level.toUpperCase(),
        entry.action,
        entry.message,
      ];
      if (entry.detail) {
        parts.push(`- ${entry.detail}`);
      }
      if (entry.context && Object.keys(entry.context).length > 0) {
        parts.push(`context=${compactLogText(entry.context, 180)}`);
      }
      return parts.join(' ');
    })
    .join('\n');
}
