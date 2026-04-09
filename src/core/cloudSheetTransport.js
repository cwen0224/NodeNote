import { sanitizeText } from './cloudSyncUtils.js';

export const DEFAULT_SHEET_POLL_MS = 5000;

function hashText(value) {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) || 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function compactProjectKeySeed(value) {
  const text = sanitizeText(value).trim();
  if (!text) {
    return '';
  }

  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

export function resolveSheetClientName(config, fallback = 'NodeNote') {
  const explicit = sanitizeText(config?.sheetClientName);
  return explicit || fallback;
}

export function resolveSheetProjectKey(config, fallback = 'project') {
  const explicit = sanitizeText(config?.sheetProjectKey);
  if (explicit) {
    return explicit;
  }

  const seed = sanitizeText(config?.sheetProjectName)
    || sanitizeText(fallback)
    || 'project';
  const compact = compactProjectKeySeed(seed) || 'project';
  const suffix = hashText(`${seed}:${Date.now()}:${Math.random()}`).slice(0, 6);
  return `project_${compact}_${suffix}`;
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
