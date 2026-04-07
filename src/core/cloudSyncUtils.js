import { normalizeDocument } from './documentSchema.js';

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeViewport(viewport) {
  if (!isPlainObject(viewport)) {
    return null;
  }

  const x = Number.isFinite(viewport.x) ? viewport.x : 0;
  const y = Number.isFinite(viewport.y) ? viewport.y : 0;
  const scale = Number.isFinite(viewport.scale) ? viewport.scale : 1;

  return { x, y, scale };
}

export function normalizeWorkspaceSnapshot(workspace, fallback = {}) {
  const source = isPlainObject(workspace) ? workspace : fallback;
  return {
    navigation: isPlainObject(source.navigation) ? source.navigation : null,
    viewport: normalizeViewport(source.viewport),
  };
}

export function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

export function decodeUtf8Base64(base64) {
  const binary = atob(String(base64 ?? '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function formatClockStamp(isoString) {
  const value = isoString ? new Date(isoString) : null;
  if (!value || Number.isNaN(value.getTime())) {
    return '--:--';
  }

  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatLogStamp(isoString) {
  const value = isoString ? new Date(isoString) : null;
  if (!value || Number.isNaN(value.getTime())) {
    return '--:--:--';
  }

  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

export function withLogHint(text) {
  const value = String(text || '').trim();
  return value ? `${value}（點擊查看本機同步日誌）` : '點擊查看本機同步日誌';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function compactLogText(value, limit = 220) {
  if (value == null) {
    return '';
  }

  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (isPlainObject(value) || Array.isArray(value)) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = '';
    }
  } else {
    text = String(value);
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > limit) {
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
  return text;
}

export function normalizeLogLevel(level) {
  const value = String(level || 'info').toLowerCase();
  if (value === 'ok') {
    return 'success';
  }
  if (value === 'warning') {
    return 'warn';
  }
  if (['info', 'success', 'warn', 'error'].includes(value)) {
    return value;
  }
  return 'info';
}

export function createLogId() {
  return `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildDocumentFingerprint(document) {
  return JSON.stringify(document ?? null);
}

export function isDeepEqual(a, b) {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    for (let index = 0; index < a.length; index += 1) {
      if (!isDeepEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }

  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
    return false;
  }

  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) {
    return false;
  }

  for (let index = 0; index < keysA.length; index += 1) {
    if (keysA[index] !== keysB[index]) {
      return false;
    }
    const key = keysA[index];
    if (!isDeepEqual(a[key], b[key])) {
      return false;
    }
  }

  return true;
}

export function createClientId() {
  return `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function readOrCreateClientId(storageKey = 'nodenote.sheet.client-id.v1') {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      return stored;
    }
    const next = createClientId();
    localStorage.setItem(storageKey, next);
    return next;
  } catch {
    return createClientId();
  }
}

export function buildFingerprint(snapshot) {
  const workspace = normalizeWorkspaceSnapshot(snapshot?.workspace, snapshot);
  return JSON.stringify({
    document: snapshot?.document ?? null,
    workspace,
  });
}

export function normalizeCloudSnapshot(payload) {
  if (!isPlainObject(payload)) {
    return null;
  }

  if (isPlainObject(payload.document)) {
    const workspace = normalizeWorkspaceSnapshot(payload.workspace, payload);
    return {
      schema: typeof payload.schema === 'string' ? payload.schema : 'nodenote.autosave',
      version: typeof payload.version === 'string' ? payload.version : '1.0.0',
      revision: Number.isFinite(payload.revision) ? payload.revision : 0,
      savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : null,
      document: normalizeDocument(payload.document),
      workspace,
      navigation: workspace.navigation,
      viewport: workspace.viewport,
    };
  }

  if (
    typeof payload.schemaVersion === 'string' ||
    isPlainObject(payload.meta) ||
    Object.prototype.hasOwnProperty.call(payload, 'entryNodeId') ||
    Array.isArray(payload.edges)
  ) {
    return {
      schema: 'nodenote.autosave',
      version: '1.0.0',
      revision: 0,
      savedAt: null,
      document: normalizeDocument(payload),
      workspace: {
        navigation: null,
        viewport: null,
      },
      navigation: null,
      viewport: null,
    };
  }

  return null;
}

export function cloneValue(value) {
  return clone(value);
}

export function sanitizeText(value, fallback = '') {
  return sanitizeString(value, fallback);
}
