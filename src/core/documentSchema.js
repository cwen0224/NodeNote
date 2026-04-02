import { resolveNodeSize } from './nodeSizing.js';

export const DOCUMENT_SCHEMA_VERSION = '1.0.0';

export function createDefaultDocument() {
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    meta: {
      title: 'Untitled',
      description: '',
      tags: [],
      createdAt: null,
      updatedAt: null,
    },
    entryNodeId: null,
    nodes: {},
    edges: [],
    assets: [],
    extras: {},
  };
}

export function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNode(node = {}, depth = 0) {
  const next = cloneDocument(isPlainObject(node) ? node : {});
  next.id = typeof next.id === 'string' ? next.id : '';
  next.type = typeof next.type === 'string' ? next.type : 'note';
  next.title = typeof next.title === 'string' ? next.title : '';
  next.x = Number.isFinite(next.x) ? next.x : 0;
  next.y = Number.isFinite(next.y) ? next.y : 0;
  next.content = typeof next.content === 'string' ? next.content : '';
  next.params = isPlainObject(next.params) ? next.params : {};
  next.assets = Array.isArray(next.assets) ? cloneDocument(next.assets) : [];
  next.tags = Array.isArray(next.tags) ? cloneDocument(next.tags) : [];
  next.meta = isPlainObject(next.meta) ? cloneDocument(next.meta) : {};
  next.ui = isPlainObject(next.ui) ? cloneDocument(next.ui) : {};

  if (next.type === 'folder' || isPlainObject(next.folder)) {
    const folderSource = isPlainObject(next.folder) ? next.folder : {};
    const folderDocument = isPlainObject(folderSource.document) ? folderSource.document : createDefaultDocument();
    next.folder = {
      ...cloneDocument(folderSource),
      summary: typeof folderSource.summary === 'string' ? folderSource.summary : '',
      depth: Number.isFinite(folderSource.depth) ? folderSource.depth : depth + 1,
      colorIndex: Number.isFinite(folderSource.colorIndex) ? folderSource.colorIndex : depth + 1,
      collapsed: Boolean(folderSource.collapsed),
      boundaryLinks: Array.isArray(folderSource.boundaryLinks) ? cloneDocument(folderSource.boundaryLinks) : [],
      document: normalizeDocument(folderDocument, { depth: depth + 1 }),
    };
  }

  const size = resolveNodeSize(next);
  next.size = {
    width: size.width,
    height: size.height,
  };

  return next;
}

function normalizeNodeMap(inputNodes = {}, depth = 0) {
  const normalized = {};

  const entries = Array.isArray(inputNodes)
    ? inputNodes.map((node) => [node?.id, node])
    : Object.entries(isPlainObject(inputNodes) ? inputNodes : {});

  entries.forEach(([key, rawNode]) => {
    if (!rawNode || typeof rawNode !== 'object') {
      return;
    }

    const nodeId = String(rawNode.id ?? key ?? '');
    const node = normalizeNode(rawNode, depth);
    node.id = nodeId;
    normalized[nodeId] = node;
  });

  return normalized;
}

export function normalizeDocument(input = {}, { depth = 0 } = {}) {
  const defaults = createDefaultDocument();
  const next = cloneDocument(defaults);

  if (typeof input !== 'object' || input === null) {
    return next;
  }

  next.schemaVersion = typeof input.schemaVersion === 'string' ? input.schemaVersion : defaults.schemaVersion;
  next.meta = {
    ...defaults.meta,
    ...(typeof input.meta === 'object' && input.meta ? input.meta : {}),
  };
  next.entryNodeId = typeof input.entryNodeId === 'string' ? input.entryNodeId : null;
  next.nodes = normalizeNodeMap(input.nodes, depth);
  next.edges = Array.isArray(input.edges) ? cloneDocument(input.edges) : [];
  next.assets = Array.isArray(input.assets) ? cloneDocument(input.assets) : [];
  next.extras = typeof input.extras === 'object' && input.extras ? cloneDocument(input.extras) : {};

  if (!next.entryNodeId || !next.nodes[next.entryNodeId]) {
    next.entryNodeId = Object.keys(next.nodes)[0] || null;
  }

  return next;
}
