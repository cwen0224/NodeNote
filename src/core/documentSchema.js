import { resolveNodeSize } from './nodeSizing.js';
import { isDumiNodeId } from './connectionData.js';

export const DOCUMENT_SCHEMA_VERSION = '2.0.0';
export const ROOT_FOLDER_ID = 'folder_root';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normalizeUrlLikeString(value) {
  const text = normalizeString(value, '').trim();
  if (!text) {
    return '';
  }

  const firstUrlMatch = text.match(/https?:\/\/[^\s)\]]+/i);
  if (firstUrlMatch) {
    return firstUrlMatch[0].trim();
  }

  return text;
}

function normalizeChildRefs(children = []) {
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .map((child) => {
      if (typeof child === 'string') {
        return { kind: 'node', id: child };
      }

      if (!isPlainObject(child)) {
        return null;
      }

      const kind = child.kind === 'folder' ? 'folder' : 'node';
      const id = normalizeString(child.id, '');
      if (!id) {
        return null;
      }

      return { kind, id };
    })
    .filter(Boolean);
}

function normalizeAssetRecord(asset = {}, fallbackId = '') {
  if (typeof asset === 'string') {
    const url = normalizeUrlLikeString(asset);
    return url ? { id: fallbackId, type: 'asset', url, label: '' } : null;
  }

  if (!isPlainObject(asset)) {
    return null;
  }

  const next = clone(asset);
  next.id = normalizeString(next.id, fallbackId);
  next.type = normalizeString(next.type, normalizeString(next.kind, 'asset')) || 'asset';
  if (Object.prototype.hasOwnProperty.call(next, 'dataUrl')) {
    delete next.dataUrl;
  }
  if (Object.prototype.hasOwnProperty.call(next, 'svgText')) {
    delete next.svgText;
  }
  const candidateUrl = normalizeUrlLikeString(
    next.url
    || next.src
    || next.path
    || next.href
    || next.link
    || ''
  );
  next.url = candidateUrl;
  next.label = normalizeString(next.label, normalizeString(next.name, normalizeString(next.title, '')));
  if (Object.prototype.hasOwnProperty.call(next, 'src')) {
    next.src = normalizeUrlLikeString(next.src);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'path')) {
    next.path = normalizeUrlLikeString(next.path);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'href')) {
    next.href = normalizeUrlLikeString(next.href);
  }
  if (Object.prototype.hasOwnProperty.call(next, 'link')) {
    next.link = normalizeUrlLikeString(next.link);
  }

  return next;
}

function normalizeAssetList(assets = []) {
  const entries = Array.isArray(assets)
    ? assets
    : Object.values(isPlainObject(assets) ? assets : {});

  return entries
    .map((asset, index) => normalizeAssetRecord(asset, `asset_${index}`))
    .filter((asset) => Boolean(asset && (asset.url || asset.label || asset.id)));
}

function normalizeEdgeRecord(edge = {}, fallbackId = '') {
  if (!isPlainObject(edge)) {
    return null;
  }

  const next = clone(edge);
  next.id = normalizeString(next.id, fallbackId);
  next.kind = normalizeString(next.kind, 'flow') || 'flow';
  next.scopeFolderId = normalizeString(next.scopeFolderId, normalizeString(next.scopeFolder, ROOT_FOLDER_ID) || ROOT_FOLDER_ID);
  next.key = normalizeString(next.key, normalizeString(next.label, ''));
  next.label = normalizeString(next.label, next.key);
  next.fromNodeId = normalizeString(next.fromNodeId, normalizeString(next.sourceNodeId, ''));
  next.toNodeId = normalizeString(next.toNodeId, normalizeString(next.targetNodeId, ''));
  next.fromPortId = normalizeString(next.fromPortId, normalizeString(next.sourcePort, 'right')) || 'right';
  next.toPortId = normalizeString(next.toPortId, normalizeString(next.targetPort, 'left')) || 'left';

  if (!next.id) {
    next.id = `${next.fromNodeId || 'edge'}_${next.key || 'link'}_${next.toNodeId || 'target'}`;
  }

  return next;
}

function normalizeEdgeList(edges = []) {
  const entries = Array.isArray(edges)
    ? edges.map((edge) => [edge?.id, edge])
    : Object.entries(isPlainObject(edges) ? edges : {});

  return entries
    .map(([key, rawEdge], index) => normalizeEdgeRecord(rawEdge, normalizeString(key, `edge_${index}`)))
    .filter(Boolean);
}

export function createDefaultFolder({
  id = ROOT_FOLDER_ID,
  parentFolderId = null,
  name = 'Root',
  depth = 0,
  colorIndex = 0,
} = {}) {
  return {
    id,
    type: 'folder',
    parentFolderId,
    name,
    title: name,
    content: '',
    summary: '',
    depth,
    colorIndex,
    x: 0,
    y: 0,
    size: {
      width: 360,
      height: 360,
    },
    params: {},
    entryNodeId: null,
    collapsed: false,
    children: [],
    boundaryLinks: [],
    sourceNodeIds: [],
    assets: [],
    meta: {},
    ui: {},
  };
}

export function createDefaultDocument() {
  const rootFolder = createDefaultFolder({
    id: ROOT_FOLDER_ID,
    parentFolderId: null,
    name: 'Root',
    depth: 0,
    colorIndex: 0,
  });

  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    meta: {
      title: 'Untitled',
      description: '',
      tags: [],
      createdAt: null,
      updatedAt: null,
    },
    rootFolderId: ROOT_FOLDER_ID,
    folders: {
      [ROOT_FOLDER_ID]: rootFolder,
    },
    nodes: {},
    edges: [],
    assets: [],
    extras: {},
  };
}

export function cloneDocument(document) {
  return JSON.parse(JSON.stringify(document));
}

function normalizeNodeRecord(node = {}, folderId = ROOT_FOLDER_ID) {
  const next = clone(isPlainObject(node) ? node : {});
  next.id = normalizeString(next.id, '');
  next.type = typeof next.type === 'string' && next.type !== 'folder' ? next.type : 'note';
  next.folderId = normalizeString(next.folderId, folderId || ROOT_FOLDER_ID) || ROOT_FOLDER_ID;
  next.title = normalizeString(next.title, '');
  next.x = normalizeNumber(next.x, 0);
  next.y = normalizeNumber(next.y, 0);
  next.content = isDumiNodeId(next.id) ? '' : normalizeString(next.content, '');
  next.params = isPlainObject(next.params) ? next.params : {};
  next.assets = normalizeAssetList(next.assets);
  next.tags = Array.isArray(next.tags) ? clone(next.tags) : [];
  next.meta = isPlainObject(next.meta) ? clone(next.meta) : {};
  next.ui = isPlainObject(next.ui) ? clone(next.ui) : {};

  const size = resolveNodeSize(next);
  next.size = {
    width: size.width,
    height: size.height,
  };

  return next;
}

function normalizeFolderRecord(folder = {}, { fallbackId = ROOT_FOLDER_ID, fallbackParentId = null, depth = 0 } = {}) {
  const next = clone(isPlainObject(folder) ? folder : {});
  next.id = normalizeString(next.id, fallbackId || ROOT_FOLDER_ID);
  next.type = 'folder';
  next.parentFolderId = Object.prototype.hasOwnProperty.call(next, 'parentFolderId')
    ? (typeof next.parentFolderId === 'string' ? next.parentFolderId : null)
    : fallbackParentId;
  next.name = normalizeString(next.name, normalizeString(next.title, 'Folder'));
  next.title = normalizeString(next.title, next.name);
  next.content = normalizeString(next.content, '');
  next.summary = normalizeString(next.summary, normalizeString(next.content, ''));
  next.depth = Number.isFinite(next.depth) ? next.depth : depth;
  next.colorIndex = Number.isFinite(next.colorIndex) ? next.colorIndex : depth;
  next.x = normalizeNumber(next.x, 0);
  next.y = normalizeNumber(next.y, 0);
  next.params = isPlainObject(next.params) ? next.params : {};
  next.entryNodeId = typeof next.entryNodeId === 'string' ? next.entryNodeId : null;
  next.collapsed = Boolean(next.collapsed);
  next.children = normalizeChildRefs(next.children);
  next.boundaryLinks = Array.isArray(next.boundaryLinks) ? clone(next.boundaryLinks) : [];
  next.sourceNodeIds = Array.isArray(next.sourceNodeIds) ? clone(next.sourceNodeIds) : [];
  next.assets = normalizeAssetList(next.assets);
  next.meta = isPlainObject(next.meta) ? clone(next.meta) : {};
  next.ui = isPlainObject(next.ui) ? clone(next.ui) : {};

  const size = resolveNodeSize(next);
  next.size = {
    width: size.width,
    height: size.height,
  };

  return next;
}

function normalizeNodeMap(inputNodes = {}, folderId = ROOT_FOLDER_ID) {
  const normalized = {};
  const entries = Array.isArray(inputNodes)
    ? inputNodes.map((node) => [node?.id, node])
    : Object.entries(isPlainObject(inputNodes) ? inputNodes : {});

  entries.forEach(([key, rawNode]) => {
    if (!rawNode || typeof rawNode !== 'object') {
      return;
    }

    if (rawNode.type === 'folder' || isPlainObject(rawNode.folder)) {
      return;
    }

    const nodeId = normalizeString(rawNode.id, normalizeString(key, ''));
    if (!nodeId) {
      return;
    }

    const node = normalizeNodeRecord({ ...rawNode, id: nodeId }, folderId);
    normalized[nodeId] = node;
  });

  return normalized;
}

function normalizeFolderMap(inputFolders = {}, rootFolderId = ROOT_FOLDER_ID) {
  const normalized = {};
  const entries = Array.isArray(inputFolders)
    ? inputFolders.map((folder) => [folder?.id, folder])
    : Object.entries(isPlainObject(inputFolders) ? inputFolders : {});

  entries.forEach(([key, rawFolder]) => {
    if (!rawFolder || typeof rawFolder !== 'object') {
      return;
    }

    const folderId = normalizeString(rawFolder.id, normalizeString(key, ''));
    if (!folderId) {
      return;
    }

    normalized[folderId] = normalizeFolderRecord(rawFolder, {
      fallbackId: folderId,
      fallbackParentId: folderId === rootFolderId ? null : rootFolderId,
      depth: Number.isFinite(rawFolder.depth) ? rawFolder.depth : 0,
    });
  });

  return normalized;
}

function collectEntities(document = {}) {
  return {
    ...(isPlainObject(document.nodes) ? document.nodes : {}),
    ...(isPlainObject(document.folders) ? document.folders : {}),
  };
}

function applyEdgesToEntities(document, edges = []) {
  if (!Array.isArray(edges) || !edges.length) {
    return;
  }

  const entities = collectEntities(document);

  edges.forEach((edge) => {
    if (!isPlainObject(edge)) {
      return;
    }

    const sourceId = normalizeString(edge.fromNodeId, normalizeString(edge.sourceNodeId, ''));
    const targetId = normalizeString(edge.toNodeId, normalizeString(edge.targetNodeId, ''));
    const key = normalizeString(edge.key, normalizeString(edge.label, ''));
    if (!sourceId || !targetId || !key || !entities[sourceId] || !entities[targetId]) {
      return;
    }

    const sourceEntity = entities[sourceId];
    if (!isPlainObject(sourceEntity.params)) {
      sourceEntity.params = {};
    }

    sourceEntity.params[key] = {
      targetId,
      sourcePort: normalizeString(edge.fromPortId, normalizeString(edge.sourcePort, 'right')) || 'right',
      targetPort: normalizeString(edge.toPortId, normalizeString(edge.targetPort, 'left')) || 'left',
    };
  });
}

function buildEdgesFromEntities(entities = {}) {
  const edges = [];

  Object.entries(isPlainObject(entities) ? entities : {}).forEach(([sourceId, entity]) => {
    if (!isPlainObject(entity?.params)) {
      return;
    }

    const scopeFolderId = entity.type === 'folder'
      ? (typeof entity.parentFolderId === 'string' ? entity.parentFolderId : ROOT_FOLDER_ID)
      : (typeof entity.folderId === 'string' ? entity.folderId : ROOT_FOLDER_ID);

    Object.entries(entity.params).forEach(([key, linkValue]) => {
      const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
      if (!targetId || !entities[targetId]) {
        return;
      }

      edges.push({
        id: `${sourceId}_${key}_${targetId}`,
        kind: 'flow',
        scopeFolderId,
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

function ensureFolderHierarchy(document) {
  const folders = isPlainObject(document.folders) ? document.folders : {};
  const nodes = isPlainObject(document.nodes) ? document.nodes : {};

  Object.values(folders).forEach((folder) => {
    if (!folder || typeof folder !== 'object') {
      return;
    }

    folder.children = normalizeChildRefs(folder.children);
  });

  Object.values(nodes).forEach((node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (!folders[node.folderId]) {
      node.folderId = document.rootFolderId || ROOT_FOLDER_ID;
    }
  });

  Object.values(folders).forEach((folder) => {
    if (!folder || typeof folder !== 'object') {
      return;
    }

    if (folder.id !== document.rootFolderId && !folders[folder.parentFolderId]) {
      folder.parentFolderId = document.rootFolderId || ROOT_FOLDER_ID;
    }

    const childRefs = [];
    const childKeySet = new Set();
    const pushRef = (kind, id) => {
      if (!id || childKeySet.has(`${kind}:${id}`)) {
        return;
      }
      childKeySet.add(`${kind}:${id}`);
      childRefs.push({ kind, id });
    };

    folder.children.forEach((ref) => {
      if (ref.kind === 'folder' && folders[ref.id]) {
        pushRef('folder', ref.id);
      } else if (ref.kind === 'node' && nodes[ref.id]) {
        pushRef('node', ref.id);
      }
    });

    Object.values(nodes).forEach((node) => {
      if (node.folderId === folder.id) {
        pushRef('node', node.id);
      }
    });

    Object.values(folders).forEach((childFolder) => {
      if (childFolder.id !== folder.id && childFolder.parentFolderId === folder.id) {
        pushRef('folder', childFolder.id);
      }
    });

    folder.children = childRefs;
  });
}

function normalizeFlatDocument(input = {}) {
  const defaults = createDefaultDocument();
  const next = clone(defaults);

  next.schemaVersion = normalizeString(input.schemaVersion, defaults.schemaVersion);
  next.meta = {
    ...defaults.meta,
    ...(isPlainObject(input.meta) ? input.meta : {}),
  };
  next.rootFolderId = normalizeString(input.rootFolderId, defaults.rootFolderId) || defaults.rootFolderId;
  next.assets = normalizeAssetList(input.assets);
  next.extras = isPlainObject(input.extras) ? clone(input.extras) : {};
  next.nodes = normalizeNodeMap(input.nodes, next.rootFolderId);
  next.folders = normalizeFolderMap(input.folders, next.rootFolderId);

  if (!next.folders[next.rootFolderId]) {
    next.folders[next.rootFolderId] = createDefaultFolder({
      id: next.rootFolderId,
      parentFolderId: null,
      name: next.meta.title || 'Root',
      depth: 0,
      colorIndex: 0,
    });
  }

  applyEdgesToEntities(next, normalizeEdgeList(input.edges));
  ensureFolderHierarchy(next);
  next.edges = buildEdgesFromEntities(collectEntities(next));
  next.entryNodeId = next.folders[next.rootFolderId]?.entryNodeId || null;

  return next;
}

function flattenLegacyDocument(input = {}) {
  const defaults = createDefaultDocument();
  const next = clone(defaults);

  next.schemaVersion = normalizeString(input.schemaVersion, defaults.schemaVersion);
  next.meta = {
    ...defaults.meta,
    ...(isPlainObject(input.meta) ? input.meta : {}),
  };
  next.rootFolderId = ROOT_FOLDER_ID;
  next.assets = normalizeAssetList(input.assets);
  next.extras = isPlainObject(input.extras) ? clone(input.extras) : {};

  const walkDocument = (sourceDoc, folderId, parentFolderId, depth) => {
    const folderSource = isPlainObject(sourceDoc) ? sourceDoc : {};
    const folderRecord = next.folders[folderId] || createDefaultFolder({
      id: folderId,
      parentFolderId,
      name: depth === 0
        ? normalizeString(folderSource?.meta?.title, defaults.meta.title)
        : normalizeString(folderSource?.meta?.title, folderId),
      depth,
      colorIndex: depth,
    });

    folderRecord.parentFolderId = parentFolderId;
    folderRecord.depth = depth;
    folderRecord.colorIndex = depth;
    folderRecord.name = depth === 0
      ? normalizeString(folderSource?.meta?.title, defaults.meta.title)
      : normalizeString(folderSource?.meta?.title, folderId);
    folderRecord.title = folderRecord.name;
    folderRecord.content = normalizeString(folderSource?.meta?.description, folderRecord.content);
    folderRecord.summary = normalizeString(folderSource?.meta?.description, folderRecord.summary);
    folderRecord.entryNodeId = typeof folderSource.entryNodeId === 'string' ? folderSource.entryNodeId : null;
    folderRecord.children = [];
    folderRecord.params = isPlainObject(folderRecord.params) ? folderRecord.params : {};
    folderRecord.boundaryLinks = Array.isArray(folderRecord.boundaryLinks) ? folderRecord.boundaryLinks : [];
    folderRecord.sourceNodeIds = Array.isArray(folderRecord.sourceNodeIds) ? folderRecord.sourceNodeIds : [];
    next.folders[folderId] = folderRecord;

    Object.entries(isPlainObject(folderSource.nodes) ? folderSource.nodes : {}).forEach(([key, rawNode]) => {
      if (!rawNode || typeof rawNode !== 'object') {
        return;
      }

      if (rawNode.type === 'folder' && isPlainObject(rawNode.folder) && isPlainObject(rawNode.folder.document)) {
        const childFolderId = normalizeString(rawNode.id, normalizeString(key, ''));
        if (!childFolderId) {
          return;
        }

        const childFolder = normalizeFolderRecord(rawNode, {
          fallbackId: childFolderId,
          fallbackParentId: folderId,
          depth: depth + 1,
        });
        childFolder.parentFolderId = folderId;
        childFolder.depth = depth + 1;
        childFolder.colorIndex = depth + 1;
        childFolder.summary = normalizeString(rawNode.folder?.summary, childFolder.summary);
        childFolder.boundaryLinks = Array.isArray(rawNode.folder?.boundaryLinks) ? clone(rawNode.folder.boundaryLinks) : [];
        childFolder.sourceNodeIds = Array.isArray(rawNode.folder?.sourceNodeIds) ? clone(rawNode.folder.sourceNodeIds) : [];
        childFolder.entryNodeId = typeof rawNode.folder?.document?.entryNodeId === 'string' ? rawNode.folder.document.entryNodeId : null;
        childFolder.children = [];
        next.folders[childFolderId] = childFolder;
        folderRecord.children.push({ kind: 'folder', id: childFolderId });
        walkDocument(rawNode.folder.document, childFolderId, folderId, depth + 1);
        return;
      }

      const nodeId = normalizeString(rawNode.id, normalizeString(key, ''));
      if (!nodeId) {
        return;
      }

      const node = normalizeNodeRecord({ ...rawNode, id: nodeId, folderId }, folderId);
      next.nodes[nodeId] = node;
      folderRecord.children.push({ kind: 'node', id: nodeId });
    });

    if (!folderRecord.entryNodeId || (!next.nodes[folderRecord.entryNodeId] && !next.folders[folderRecord.entryNodeId])) {
      const firstChild = folderRecord.children[0];
      folderRecord.entryNodeId = firstChild ? firstChild.id : null;
    }
  };

  walkDocument(input, ROOT_FOLDER_ID, null, 0);
  ensureFolderHierarchy(next);
  next.edges = buildEdgesFromEntities(collectEntities(next));
  next.entryNodeId = next.folders[ROOT_FOLDER_ID]?.entryNodeId || null;

  return next;
}

export function normalizeDocument(input = {}) {
  if (typeof input !== 'object' || input === null) {
    return createDefaultDocument();
  }

  if (Object.prototype.hasOwnProperty.call(input, 'rootFolderId')
    || isPlainObject(input.folders)
    || normalizeString(input.schemaVersion, '') === DOCUMENT_SCHEMA_VERSION) {
    return normalizeFlatDocument(input);
  }

  return flattenLegacyDocument(input);
}

export function buildEdgesFromDocument(document = {}) {
  return buildEdgesFromEntities(collectEntities(document));
}

function getEntityById(document = {}, id = '') {
  if (typeof id !== 'string' || !id) {
    return null;
  }

  return document.nodes?.[id] || document.folders?.[id] || null;
}

function getFolderMemberIds(document = {}, folderId = ROOT_FOLDER_ID) {
  const folder = document.folders?.[folderId];
  if (!folder || !Array.isArray(folder.children)) {
    return [];
  }

  return folder.children
    .map((child) => (isPlainObject(child) ? child.id : null))
    .filter((id) => Boolean(getEntityById(document, id)));
}

function compareEntityPosition(a = {}, b = {}) {
  const posA = {
    x: normalizeNumber(a.x, 0),
    y: normalizeNumber(a.y, 0),
  };
  const posB = {
    x: normalizeNumber(b.x, 0),
    y: normalizeNumber(b.y, 0),
  };

  if (posA.y !== posB.y) {
    return posA.y - posB.y;
  }
  if (posA.x !== posB.x) {
    return posA.x - posB.x;
  }
  return String(a.id || '').localeCompare(String(b.id || ''));
}

function computeBounds(entities = {}, nodeIds = []) {
  const ids = (Array.isArray(nodeIds) && nodeIds.length > 0)
    ? nodeIds
    : Object.keys(entities || {});

  if (!ids.length) {
    return {
      minX: 0,
      minY: 0,
      width: 320,
      height: 320,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  ids.forEach((id) => {
    const entity = entities[id];
    if (!entity) {
      return;
    }

    const size = resolveNodeSize(entity);
    const position = {
      x: normalizeNumber(entity.x, 0),
      y: normalizeNumber(entity.y, 0),
    };

    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      minX: 0,
      minY: 0,
      width: 320,
      height: 320,
    };
  }

  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function countFolderEdgeOrientation(document = {}, memberIds = []) {
  const memberSet = new Set(memberIds);
  const entities = collectEntities(document);
  let horizontal = 0;
  let vertical = 0;

  (Array.isArray(document.edges) ? document.edges : []).forEach((edge) => {
    if (!isPlainObject(edge)) {
      return;
    }

    const sourceId = normalizeString(edge.fromNodeId, normalizeString(edge.sourceNodeId, ''));
    const targetId = normalizeString(edge.toNodeId, normalizeString(edge.targetNodeId, ''));
    if (!memberSet.has(sourceId) || !memberSet.has(targetId)) {
      return;
    }

    const source = entities[sourceId];
    const target = entities[targetId];
    if (!source || !target) {
      return;
    }

    const dx = Math.abs(normalizeNumber(target.x, 0) - normalizeNumber(source.x, 0));
    const dy = Math.abs(normalizeNumber(target.y, 0) - normalizeNumber(source.y, 0));
    if (dx >= dy) {
      horizontal += 1;
    } else {
      vertical += 1;
    }
  });

  if (vertical > horizontal) {
    return 'vertical';
  }
  if (horizontal > vertical) {
    return 'horizontal';
  }

  const bounds = computeBounds(collectEntities(document), memberIds);
  return bounds.width >= bounds.height ? 'horizontal' : 'vertical';
}
