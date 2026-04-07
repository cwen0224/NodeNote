import { normalizeDocument } from './documentSchema.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a, b) {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
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
    if (!deepEqual(a[key], b[key])) {
      return false;
    }
  }

  return true;
}

function diffEntityMap(baseMap = {}, nextMap = {}) {
  const base = isPlainObject(baseMap) ? baseMap : {};
  const next = isPlainObject(nextMap) ? nextMap : {};
  const upserts = {};
  const deletes = [];

  Object.entries(next).forEach(([id, record]) => {
    if (!deepEqual(base[id], record)) {
      upserts[id] = clone(record);
    }
  });

  Object.keys(base).forEach((id) => {
    if (!Object.prototype.hasOwnProperty.call(next, id)) {
      deletes.push(id);
    }
  });

  return { upserts, deletes };
}

function cleanPatchValue(value) {
  if (Array.isArray(value)) {
    return clone(value);
  }

  if (isPlainObject(value)) {
    return clone(value);
  }

  return value;
}

export function createCollaborativePatch(baseDocument = {}, nextDocument = {}) {
  const base = isPlainObject(baseDocument) ? baseDocument : {};
  const next = isPlainObject(nextDocument) ? nextDocument : {};
  const nodeDiff = diffEntityMap(base.nodes, next.nodes);
  const folderDiff = diffEntityMap(base.folders, next.folders);
  const patch = {
    schemaVersion: !deepEqual(base.schemaVersion, next.schemaVersion) ? (next.schemaVersion || base.schemaVersion || '2.0.0') : null,
    rootFolderId: !deepEqual(base.rootFolderId, next.rootFolderId) ? (next.rootFolderId || base.rootFolderId || 'folder_root') : null,
    meta: deepEqual(base.meta, next.meta) ? null : cleanPatchValue(next.meta || {}),
    assets: deepEqual(base.assets, next.assets) ? null : cleanPatchValue(next.assets || []),
    extras: deepEqual(base.extras, next.extras) ? null : cleanPatchValue(next.extras || {}),
    nodes: nodeDiff.upserts,
    deletedNodeIds: nodeDiff.deletes,
    folders: folderDiff.upserts,
    deletedFolderIds: folderDiff.deletes,
  };

  return patch;
}

export function isCollaborativePatchEmpty(patch = {}) {
  if (!isPlainObject(patch)) {
    return true;
  }

  const hasNodes = isPlainObject(patch.nodes) && Object.keys(patch.nodes).length > 0;
  const hasFolders = isPlainObject(patch.folders) && Object.keys(patch.folders).length > 0;
  const hasNodeDeletes = Array.isArray(patch.deletedNodeIds) && patch.deletedNodeIds.length > 0;
  const hasFolderDeletes = Array.isArray(patch.deletedFolderIds) && patch.deletedFolderIds.length > 0;
  const hasMeta = patch.meta !== null && typeof patch.meta !== 'undefined';
  const hasAssets = patch.assets !== null && typeof patch.assets !== 'undefined';
  const hasExtras = patch.extras !== null && typeof patch.extras !== 'undefined';
  const hasRoot = typeof patch.rootFolderId === 'string' && patch.rootFolderId.trim();

  return !(
    hasNodes ||
    hasFolders ||
    hasNodeDeletes ||
    hasFolderDeletes ||
    hasMeta ||
    hasAssets ||
    hasExtras ||
    hasRoot
  );
}

export function applyCollaborativePatch(baseDocument = {}, patch = {}) {
  const base = isPlainObject(baseDocument) ? baseDocument : {};
  const next = clone(base);
  const safePatch = isPlainObject(patch) ? patch : {};

  if (typeof safePatch.schemaVersion === 'string' && safePatch.schemaVersion.trim()) {
    next.schemaVersion = safePatch.schemaVersion.trim();
  }

  if (typeof safePatch.rootFolderId === 'string' && safePatch.rootFolderId.trim()) {
    next.rootFolderId = safePatch.rootFolderId.trim();
  }

  if (safePatch.meta && isPlainObject(safePatch.meta)) {
    next.meta = clone(safePatch.meta);
  }

  if (Array.isArray(safePatch.assets)) {
    next.assets = clone(safePatch.assets);
  }

  if (safePatch.extras && isPlainObject(safePatch.extras)) {
    next.extras = clone(safePatch.extras);
  }

  next.nodes = isPlainObject(next.nodes) ? next.nodes : {};
  next.folders = isPlainObject(next.folders) ? next.folders : {};

  if (isPlainObject(safePatch.nodes)) {
    Object.entries(safePatch.nodes).forEach(([id, record]) => {
      next.nodes[id] = clone(record);
    });
  }

  if (isPlainObject(safePatch.folders)) {
    Object.entries(safePatch.folders).forEach(([id, record]) => {
      next.folders[id] = clone(record);
    });
  }

  if (Array.isArray(safePatch.deletedNodeIds)) {
    safePatch.deletedNodeIds.forEach((id) => {
      delete next.nodes[id];
    });
  }

  if (Array.isArray(safePatch.deletedFolderIds)) {
    safePatch.deletedFolderIds.forEach((id) => {
      delete next.folders[id];
    });
  }

  return normalizeDocument(next);
}
