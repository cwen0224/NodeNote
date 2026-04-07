const ROOT_FOLDER_ID = 'folder_root';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function createFallbackFolder({
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

export function resolveVisibleEntityId(entityId, document = {}, currentFolderId = ROOT_FOLDER_ID) {
  const folders = isPlainObject(document.folders) ? document.folders : {};
  const nodes = isPlainObject(document.nodes) ? document.nodes : {};
  const entity = nodes[entityId] || folders[entityId];
  if (!entity) {
    return null;
  }

  if (entity.type === 'folder') {
    if (entity.id === currentFolderId) {
      return entity.id;
    }

    let cursor = entity;
    while (cursor && cursor.parentFolderId && cursor.parentFolderId !== currentFolderId) {
      cursor = folders[cursor.parentFolderId];
    }

    if (cursor?.parentFolderId === currentFolderId) {
      return cursor.id;
    }

    return null;
  }

  if (entity.folderId === currentFolderId) {
    return entity.id;
  }

  let cursor = folders[entity.folderId];
  while (cursor) {
    if (cursor.parentFolderId === currentFolderId) {
      return cursor.id;
    }
    if (!cursor.parentFolderId) {
      break;
    }
    cursor = folders[cursor.parentFolderId];
  }

  return null;
}

export function projectEdgesForFolderView(document = {}, folderId = ROOT_FOLDER_ID) {
  const nodes = isPlainObject(document.nodes) ? document.nodes : {};
  const folders = isPlainObject(document.folders) ? document.folders : {};
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const visibleIds = new Set();

  const currentFolder = folders[folderId];
  if (currentFolder) {
    visibleIds.add(currentFolder.id);
  }

  Object.values(nodes).forEach((node) => {
    if (node?.folderId === folderId) {
      visibleIds.add(node.id);
    }
  });

  Object.values(folders).forEach((folder) => {
    if (folder?.parentFolderId === folderId) {
      visibleIds.add(folder.id);
    }
  });

  return edges
    .map((edge) => {
      if (!isPlainObject(edge)) {
        return null;
      }

      const projectedSourceId = resolveVisibleEntityId(edge.fromNodeId || edge.sourceNodeId, document, folderId);
      const projectedTargetId = resolveVisibleEntityId(edge.toNodeId || edge.targetNodeId, document, folderId);
      if (!projectedSourceId || !projectedTargetId || projectedSourceId === projectedTargetId) {
        return null;
      }

      if (!visibleIds.has(projectedSourceId) || !visibleIds.has(projectedTargetId)) {
        return null;
      }

      return {
        ...clone(edge),
        fromNodeId: projectedSourceId,
        toNodeId: projectedTargetId,
      };
    })
    .filter(Boolean);
}

export function buildFolderDocumentView(document = {}, folderId = ROOT_FOLDER_ID) {
  const rootFolderId = normalizeString(document.rootFolderId, ROOT_FOLDER_ID) || ROOT_FOLDER_ID;
  const folders = isPlainObject(document.folders) ? document.folders : {};
  const nodes = isPlainObject(document.nodes) ? document.nodes : {};
  const currentFolderId = folders[folderId] ? folderId : rootFolderId;
  const currentFolder = folders[currentFolderId] || createFallbackFolder({
    id: currentFolderId,
    parentFolderId: currentFolderId === rootFolderId ? null : rootFolderId,
    name: currentFolderId === rootFolderId ? normalizeString(document.meta?.title, 'Root') : currentFolderId,
    depth: currentFolderId === rootFolderId ? 0 : 1,
    colorIndex: currentFolderId === rootFolderId ? 0 : 1,
  });

  const visible = {};
  const orderedIds = [];
  const pushId = (id) => {
    if (!id || !visible[id] || orderedIds.includes(id)) {
      return;
    }
    orderedIds.push(id);
  };

  currentFolder.children.forEach((ref) => {
    if (ref.kind === 'node' && nodes[ref.id]) {
      visible[ref.id] = nodes[ref.id];
      pushId(ref.id);
    } else if (ref.kind === 'folder' && folders[ref.id]) {
      visible[ref.id] = folders[ref.id];
      pushId(ref.id);
    }
  });

  Object.values(nodes).forEach((node) => {
    if (node.folderId === currentFolderId) {
      visible[node.id] = node;
      pushId(node.id);
    }
  });

  Object.values(folders).forEach((folder) => {
    if (folder.id !== currentFolderId && folder.parentFolderId === currentFolderId) {
      visible[folder.id] = folder;
      pushId(folder.id);
    }
  });

  const orderedNodes = {};
  orderedIds.forEach((id) => {
    if (visible[id]) {
      orderedNodes[id] = visible[id];
    }
  });

  const visibleEdges = projectEdgesForFolderView(document, currentFolderId);
  const fallbackEntry = currentFolder.entryNodeId && orderedNodes[currentFolder.entryNodeId]
    ? currentFolder.entryNodeId
    : orderedIds[0] || null;

  return {
    schemaVersion: document.schemaVersion || '2.0.0',
    meta: clone(document.meta || {
      title: 'Untitled',
      description: '',
      tags: [],
      createdAt: null,
      updatedAt: null,
    }),
    rootFolderId,
    currentFolderId,
    entryNodeId: fallbackEntry,
    nodes: orderedNodes,
    edges: visibleEdges,
    assets: Array.isArray(document.assets) ? document.assets : [],
    extras: isPlainObject(document.extras) ? document.extras : {},
    folders,
    folder: currentFolder,
  };
}
