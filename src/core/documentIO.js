import { normalizeDocument, createDefaultDocument } from './documentSchema.js';
import { normalizeClipboardPayload, GRAPH_FRAGMENT_SCHEMA } from './graphClipboard.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildEdgesFromNodes(nodes = {}) {
  const edges = [];

  Object.entries(isPlainObject(nodes) ? nodes : {}).forEach(([sourceId, node]) => {
    if (!isPlainObject(node?.params)) {
      return;
    }

    Object.entries(node.params).forEach(([key, linkValue]) => {
      const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
      if (!targetId || !nodes[targetId]) {
        return;
      }

      edges.push({
        id: `${sourceId}_${key}_${targetId}`,
        kind: 'flow',
        key,
        label: key,
        fromNodeId: sourceId,
        fromPortId: typeof linkValue === 'object' && linkValue ? (linkValue.sourcePort || 'right') : 'right',
        toNodeId: targetId,
        toPortId: typeof linkValue === 'object' && linkValue ? (linkValue.targetPort || 'left') : 'left',
      });
    });
  });

  return edges;
}

function stripCommonMarkdownFencing(text = '') {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '');
}

function repairJsonText(text = '') {
  return String(text || '')
    .replace(/\\(?!["\\/bfnrtu])/g, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function extractLikelyJsonText(text = '') {
  const input = String(text || '').trim();
  if (!input) {
    return '';
  }

  const candidates = [];
  const objectStart = input.indexOf('{');
  const objectEnd = input.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(input.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = input.indexOf('[');
  const arrayEnd = input.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(input.slice(arrayStart, arrayEnd + 1));
  }

  candidates.push(input);
  return candidates[0] || '';
}

function normalizeMarkdownLinkText(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const match = value.trim().match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/i);
  if (match) {
    return match[2];
  }

  return value;
}

function clearMarkdownFormattingFromText(value) {
  if (typeof value !== 'string') {
    return value;
  }

  let next = value;

  next = next.replace(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
  next = next.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, '$1');
  next = next.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/gi, '$1');
  next = next.replace(/(^|\s)([*_]{1,3})([^*_]+?)\2(?=\s|$)/g, '$1$3');
  next = next.replace(/(^|\s)(`{1,3})([^`]+?)\2(?=\s|$)/g, '$1$3');
  next = next.replace(/^\s*>\s?/gm, '');
  next = next.replace(/^\s*#{1,6}\s*/gm, '');
  next = next.replace(/^\s*[-*+]\s+/gm, '');
  next = next.replace(/\r?\n{3,}/g, '\n\n');
  return next;
}

function normalizeImportedStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeImportedStrings(item));
  }

  if (!isPlainObject(value)) {
    return clearMarkdownFormattingFromText(normalizeMarkdownLinkText(value));
  }

  const next = {};
  Object.entries(value).forEach(([key, item]) => {
    next[key] = normalizeImportedStrings(item);
  });
  return next;
}

function isNonAsciiText(value) {
  return typeof value === 'string' && /[^\x00-\x7F]/.test(value);
}

function collectMappingWarnings(document = {}) {
  const warnings = [];
  const nodes = isPlainObject(document?.nodes) ? document.nodes : {};
  const folders = isPlainObject(document?.folders) ? document.folders : {};

  const scanParams = (entity, entityType, entityId) => {
    if (!isPlainObject(entity?.params)) {
      return;
    }

    const keys = Object.keys(entity.params).filter((key) => isNonAsciiText(key));
    if (keys.length > 0) {
      warnings.push({
        entityType,
        entityId,
        keys,
      });
    }
  };

  Object.values(nodes).forEach((node) => scanParams(node, 'node', node?.id));
  Object.values(folders).forEach((folder) => scanParams(folder, 'folder', folder?.id));

  return warnings;
}

export function buildExportMappingWarning(document = {}) {
  const warnings = collectMappingWarnings(document);
  if (!warnings.length) {
    return null;
  }

  const totalKeys = warnings.reduce((sum, item) => sum + item.keys.length, 0);
  const sample = warnings
    .slice(0, 3)
    .map((item) => `${item.entityType}:${item.entityId || '(unknown)'} -> ${item.keys.join(', ')}`)
    .join('\n');

  return {
    totalKeys,
    warnings,
    message: [
      `偵測到 ${totalKeys} 個含中文或非 ASCII 的連線 key。`,
      '這些 key 建議在匯出前先映射成固定英文 key，避免外部引擎或 AI 生成時不一致。',
      sample ? `\n範例：\n${sample}` : '',
    ].join('\n'),
  };
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatTimestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
}

export function serializeDocument(document) {
  return JSON.stringify(document, null, 2);
}

export function createDocumentFileName(document = null, now = new Date()) {
  const title = sanitizeFilenamePart(document?.meta?.title) || 'Untitled';
  return `NodeNote_${title}_${formatTimestampForFilename(now)}.json`;
}

export function downloadText(text, filename = 'NodeNote.json') {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const stripped = stripCommonMarkdownFencing(text.trim());
  const likelyJson = extractLikelyJsonText(stripped);

  try {
    return JSON.parse(likelyJson);
  } catch (firstError) {
    try {
      return JSON.parse(repairJsonText(likelyJson));
    } catch {
      return null;
    }
  }
}

function isDocumentLikePayload(payload) {
  return payload && typeof payload === 'object' && (
    typeof payload.schemaVersion === 'string' ||
    isPlainObject(payload.meta) ||
    Object.prototype.hasOwnProperty.call(payload, 'entryNodeId') ||
    Object.prototype.hasOwnProperty.call(payload, 'rootFolderId') ||
    isPlainObject(payload.folders) ||
    Array.isArray(payload.edges) ||
    Object.prototype.hasOwnProperty.call(payload, 'assets') ||
    Object.prototype.hasOwnProperty.call(payload, 'extras')
  );
}

export function normalizeImportedDocument(payload) {
  if (isDocumentLikePayload(payload)) {
    return normalizeDocument(normalizeImportedStrings(payload));
  }

  const graphPayload = normalizeClipboardPayload(payload);
  if (graphPayload?.schema === GRAPH_FRAGMENT_SCHEMA) {
    const baseDocument = createDefaultDocument();
    baseDocument.meta.title = typeof payload?.meta?.title === 'string' ? payload.meta.title : 'Imported Graph';
    baseDocument.entryNodeId = graphPayload.rootNodeIds?.[0] || graphPayload.nodeIds?.[0] || null;
    baseDocument.nodes = clone(normalizeImportedStrings(graphPayload.nodes || {}));
    baseDocument.edges = buildEdgesFromNodes(baseDocument.nodes);
    return normalizeDocument(baseDocument);
  }

  if (graphPayload) {
    const baseDocument = createDefaultDocument();
    baseDocument.meta.title = 'Imported Graph';
    baseDocument.entryNodeId = graphPayload.rootNodeIds?.[0] || graphPayload.nodeIds?.[0] || null;
    baseDocument.nodes = clone(normalizeImportedStrings(graphPayload.nodes || {}));
    baseDocument.edges = buildEdgesFromNodes(baseDocument.nodes);
    return normalizeDocument(baseDocument);
  }

  return null;
}
