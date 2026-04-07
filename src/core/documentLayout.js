import { resolveNodeSize } from './nodeSizing.js';

const ROOT_FOLDER_ID = 'folder_root';

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

function collectEntities(document = {}) {
  return {
    ...(isPlainObject(document.nodes) ? document.nodes : {}),
    ...(isPlainObject(document.folders) ? document.folders : {}),
  };
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

function getFolderMemberIds(document = {}, folderId = ROOT_FOLDER_ID) {
  const folder = document.folders?.[folderId];
  if (!folder || !Array.isArray(folder.children)) {
    return [];
  }

  return folder.children
    .map((child) => (isPlainObject(child) ? child.id : null))
    .filter((id) => Boolean((document.nodes?.[id]) || (document.folders?.[id])));
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

function getFolderLayoutLayers(document = {}, folderId = ROOT_FOLDER_ID) {
  const folder = document.folders?.[folderId];
  if (!folder) {
    return null;
  }

  const memberIds = getFolderMemberIds(document, folderId);
  if (memberIds.length < 3) {
    return null;
  }

  const memberSet = new Set(memberIds);
  const entities = collectEntities(document);
  const orientation = countFolderEdgeOrientation(document, memberIds);
  const adjacency = new Map(memberIds.map((id) => [id, []]));
  const indegree = new Map(memberIds.map((id) => [id, 0]));

  (Array.isArray(document.edges) ? document.edges : []).forEach((edge) => {
    if (!isPlainObject(edge)) {
      return;
    }

    const sourceId = normalizeString(edge.fromNodeId, normalizeString(edge.sourceNodeId, ''));
    const targetId = normalizeString(edge.toNodeId, normalizeString(edge.targetNodeId, ''));
    if (!memberSet.has(sourceId) || !memberSet.has(targetId)) {
      return;
    }

    adjacency.get(sourceId)?.push(targetId);
    indegree.set(targetId, (indegree.get(targetId) || 0) + 1);
  });

  const roots = [];
  if (folder.entryNodeId && memberSet.has(folder.entryNodeId)) {
    roots.push(folder.entryNodeId);
  }

  memberIds
    .filter((id) => (indegree.get(id) || 0) === 0)
    .sort((leftId, rightId) => compareEntityPosition(entities[leftId], entities[rightId]))
    .forEach((id) => {
      if (!roots.includes(id)) {
        roots.push(id);
      }
    });

  if (!roots.length) {
    const first = [...memberIds]
      .sort((leftId, rightId) => compareEntityPosition(entities[leftId], entities[rightId]))[0];
    if (first) {
      roots.push(first);
    }
  }

  const levelMap = new Map();
  const queue = [];
  roots.forEach((id) => {
    levelMap.set(id, 0);
    queue.push(id);
  });

  while (queue.length) {
    const sourceId = queue.shift();
    const nextLevel = (levelMap.get(sourceId) || 0) + 1;
    (adjacency.get(sourceId) || []).forEach((targetId) => {
      const previousLevel = levelMap.get(targetId);
      if (!Number.isFinite(previousLevel) || nextLevel < previousLevel) {
        levelMap.set(targetId, nextLevel);
        queue.push(targetId);
      }
    });
  }

  const remaining = memberIds
    .filter((id) => !levelMap.has(id))
    .sort((leftId, rightId) => compareEntityPosition(entities[leftId], entities[rightId]));
  const maxLevel = levelMap.size > 0 ? Math.max(...levelMap.values()) : 0;

  remaining.forEach((id, index) => {
    const spillLevel = maxLevel + 1 + Math.floor(index / 3);
    levelMap.set(id, spillLevel);
  });

  const layers = new Map();
  memberIds.forEach((id) => {
    const level = levelMap.get(id) || 0;
    if (!layers.has(level)) {
      layers.set(level, []);
    }
    layers.get(level).push(id);
  });

  layers.forEach((ids) => {
    ids.sort((leftId, rightId) => compareEntityPosition(entities[leftId], entities[rightId]));
  });

  return {
    folderId,
    memberIds,
    layers: [...layers.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids),
    orientation,
  };
}

function applyFolderAutoLayout(document = {}, folderId = ROOT_FOLDER_ID) {
  const layout = getFolderLayoutLayers(document, folderId);
  if (!layout) {
    return false;
  }

  const entities = collectEntities(document);
  const memberEntities = layout.memberIds
    .map((id) => entities[id])
    .filter(Boolean);
  if (memberEntities.length < 2) {
    return false;
  }

  const bounds = computeBounds(entities, layout.memberIds);
  const centerX = bounds.minX + (bounds.width / 2);
  const centerY = bounds.minY + (bounds.height / 2);
  const sizeStats = memberEntities.reduce((acc, entity) => {
    const size = resolveNodeSize(entity);
    return {
      width: Math.max(acc.width, size.width),
      height: Math.max(acc.height, size.height),
    };
  }, {
    width: 240,
    height: 160,
  });

  const layerGap = layout.orientation === 'horizontal'
    ? Math.max(280, sizeStats.width + 180)
    : Math.max(240, sizeStats.height + 180);
  const crossGap = layout.orientation === 'horizontal'
    ? Math.max(180, sizeStats.height + 100)
    : Math.max(180, sizeStats.width + 100);

  const layerCount = layout.layers.length;
  const baseMain = layout.orientation === 'horizontal'
    ? centerX - (((layerCount - 1) * layerGap) / 2)
    : centerY - (((layerCount - 1) * layerGap) / 2);

  layout.layers.forEach((ids, layerIndex) => {
    const totalCrossSpan = Math.max(1, (ids.length - 1) * crossGap);
    const baseCross = layout.orientation === 'horizontal'
      ? centerY - (totalCrossSpan / 2)
      : centerX - (totalCrossSpan / 2);

    ids.forEach((id, index) => {
      const entity = entities[id];
      if (!entity) {
        return;
      }

      const size = resolveNodeSize(entity);
      const mainPos = baseMain + (layerIndex * layerGap);
      const crossPos = baseCross + (index * crossGap);

      if (layout.orientation === 'horizontal') {
        entity.x = mainPos - (size.width / 2);
        entity.y = crossPos - (size.height / 2);
      } else {
        entity.x = crossPos - (size.width / 2);
        entity.y = mainPos - (size.height / 2);
      }
    });
  });

  return true;
}

export function applyImportedDocumentLayout(document = {}) {
  if (!isPlainObject(document)) {
    return document;
  }

  const folders = isPlainObject(document.folders) ? document.folders : {};
  const folderIds = Object.values(folders)
    .map((folder) => folder?.id)
    .filter(Boolean)
    .sort((a, b) => (folders[a]?.depth ?? 0) - (folders[b]?.depth ?? 0));

  folderIds.forEach((folderId) => {
    applyFolderAutoLayout(document, folderId);
  });

  return document;
}

export { applyFolderAutoLayout, getFolderLayoutLayers };
