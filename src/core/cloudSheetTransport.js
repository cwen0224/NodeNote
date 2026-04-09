import { sanitizeText } from './cloudSyncUtils.js';

export const DEFAULT_SHEET_POLL_MS = 5000;

export function resolveSheetClientName(config, fallback = 'NodeNote') {
  const explicit = sanitizeText(config?.sheetClientName);
  return explicit || fallback;
}

export function resolveSheetPollIntervalMs(config, defaultMs = DEFAULT_SHEET_POLL_MS) {
  const raw = Number(config?.sheetPollIntervalMs);
  if (!Number.isFinite(raw) || raw <= 0) {
    return defaultMs;
  }
  return Math.max(defaultMs, raw);
}

export function buildSheetRequestUrl({
  baseUrl,
  action = 'state',
  projectKey = 'default',
  clientId = '',
  secret = '',
  extraParams = {},
} = {}) {
  const base = sanitizeText(baseUrl);
  if (!base) {
    return '';
  }

  let url;
  try {
    url = new URL(base);
  } catch {
    return base;
  }

  url.searchParams.set('action', action);
  url.searchParams.set('projectKey', sanitizeText(projectKey, 'default'));
  url.searchParams.set('clientId', sanitizeText(clientId));
  const safeSecret = sanitizeText(secret);
  if (safeSecret) {
    url.searchParams.set('secret', safeSecret);
  }

  Object.entries(extraParams || {}).forEach(([key, value]) => {
    if (typeof value !== 'undefined' && value !== null && String(value).length > 0) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

export function buildSheetCommitPayload({
  patch,
  projectKey = 'default',
  projectName = '',
  clientId = '',
  clientName = 'NodeNote',
  secret = '',
  baseRevision = 0,
  savedAt = new Date().toISOString(),
  editedAt = savedAt,
  version = '1.0.0',
} = {}) {
  return {
    action: 'commit',
    schema: 'nodenote.sheet.cocollab',
    version,
    projectKey: sanitizeText(projectKey, 'default'),
    projectName: sanitizeText(projectName),
    clientId: sanitizeText(clientId),
    clientName: sanitizeText(clientName, 'NodeNote'),
    secret: sanitizeText(secret),
    baseRevision,
    savedAt,
    editedAt,
    patch,
  };
}
