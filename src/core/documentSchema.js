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

export function normalizeDocument(input = {}) {
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
  next.entryNodeId = input.entryNodeId ?? null;
  next.nodes = typeof input.nodes === 'object' && input.nodes ? cloneDocument(input.nodes) : {};
  next.edges = Array.isArray(input.edges) ? cloneDocument(input.edges) : [];
  next.assets = Array.isArray(input.assets) ? cloneDocument(input.assets) : [];
  next.extras = typeof input.extras === 'object' && input.extras ? cloneDocument(input.extras) : {};

  return next;
}

