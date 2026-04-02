/**
 * StateStore.js
 * Holds canonical document data and ephemeral session state.
 * The public `state` view is kept for compatibility while the internal
 * separation lets us move toward a command-driven architecture.
 */

import {
  buildEdgesFromDocument,
  buildFolderDocumentView,
  cloneDocument,
  createDefaultDocument,
  normalizeDocument,
  ROOT_FOLDER_ID,
} from './core/documentSchema.js';
import { createDefaultSession } from './core/sessionSchema.js';
import { MAX_FOLDER_DEPTH } from './core/folderTheme.js';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class StateStore {
  constructor() {
    this.document = createDefaultDocument();
    this.session = createDefaultSession();
    this.listeners = {};
    this.history = [];
    this.historyIndex = -1;
    this.historyLimit = 200;
    this.state = this.createCompatibilityView();

    this.saveHistory();
  }

  createCompatibilityView() {
    const view = {};

    const define = (key, getter, setter) => {
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: false,
        get: getter,
        set: setter,
      });
    };

    define('document', () => this.getCurrentDocument());
    define('schemaVersion', () => this.document.schemaVersion);
    define('meta', () => this.document.meta);
    define('rootFolderId', () => this.document.rootFolderId || ROOT_FOLDER_ID);
    define('folders', () => this.document.folders);
    define('entryNodeId', () => this.getCurrentDocument().entryNodeId, (value) => {
      this.setCurrentEntryNodeId(value);
    });
    define('nodes', () => this.getCurrentDocument().nodes);
    define('edges', () => this.getCurrentDocument().edges);
    define('links', () => this.getCurrentDocument().edges);
    define('assets', () => this.document.assets);
    define('extras', () => this.document.extras);
    define('x', () => this.session.viewport.x, (value) => {
      this.session.viewport.x = value;
    });
    define('y', () => this.session.viewport.y, (value) => {
      this.session.viewport.y = value;
    });
    define('scale', () => this.session.viewport.scale, (value) => {
      this.session.viewport.scale = value;
    });
    define('viewport', () => this.session.viewport, (value) => {
      this.session.viewport = value;
    });
    define('selection', () => this.session.selection, (value) => {
      this.session.selection = value;
    });
    define('editing', () => this.session.editing, (value) => {
      this.session.editing = value;
    });
    define('hover', () => this.session.hover, (value) => {
      this.session.hover = value;
    });
    define('interaction', () => this.session.interaction, (value) => {
      this.session.interaction = value;
    });
    define('ui', () => this.session.ui, (value) => {
      this.session.ui = value;
    });
    define('navigation', () => this.session.navigation, (value) => {
      this.session.navigation = {
        ...createDefaultSession().navigation,
        ...(isPlainObject(value) ? value : {}),
      };
    });

    return view;
  }

  getRootFolderId() {
    return this.document.rootFolderId || ROOT_FOLDER_ID;
  }

  getFolderRecord(folderId = this.getCurrentFolderId()) {
    const rootFolderId = this.getRootFolderId();
    const safeId = typeof folderId === 'string' && folderId ? folderId : rootFolderId;
    return this.document.folders?.[safeId] || this.document.folders?.[rootFolderId] || null;
  }

  getCurrentFolderId(path = this.session.navigation?.path) {
    return this.resolveFolderPath(path).folderId;
  }

  getCurrentDepth() {
    return this.getCurrentDocumentPath().length;
  }

  resolveFolderPath(path = this.session.navigation?.path) {
    const requested = Array.isArray(path) ? path.filter((id) => typeof id === 'string' && id) : [];
    const resolved = [];
    const rootFolderId = this.getRootFolderId();
    let currentFolderId = rootFolderId;
    let currentFolder = this.getFolderRecord(rootFolderId);

    for (const folderId of requested) {
      const nextFolder = this.document.folders?.[folderId];
      if (!nextFolder || nextFolder.parentFolderId !== currentFolderId) {
        break;
      }

      resolved.push(folderId);
      currentFolderId = folderId;
      currentFolder = nextFolder;
    }

    return {
      path: resolved,
      folderId: currentFolderId,
      folder: currentFolder,
    };
  }

  getCurrentDocumentPath(path = this.session.navigation?.path) {
    return this.resolveFolderPath(path).path;
  }

  getCurrentDocument() {
    return buildFolderDocumentView(this.document, this.getCurrentFolderId());
  }

  getCurrentDocumentSnapshot() {
    return cloneDocument(this.getCurrentDocument());
  }

  getNavigationSnapshot() {
    return cloneDocument(this.session.navigation);
  }

  getDocumentSnapshot() {
    this.rebuildDerivedState();
    return cloneDocument(this.document);
  }

  getEntityById(id) {
    if (typeof id !== 'string' || !id) {
      return null;
    }

    return this.document.nodes?.[id] || this.document.folders?.[id] || null;
  }

  getVisibleEntities(folderId = this.getCurrentFolderId()) {
    return this.getCurrentDocument()?.nodes || buildFolderDocumentView(this.document, folderId).nodes;
  }

  clearTransientFocus() {
    this.session.selection.nodeIds = [];
    this.session.selection.edgeIds = [];
    this.session.editing.nodeId = null;
    this.session.editing.connectionId = null;
    this.session.hover.nodeId = null;
    this.session.hover.edgeId = null;
    this.session.hover.port = null;
    this.session.interaction.draggingNodeId = null;
    this.session.interaction.drawingEdgeFrom = null;
    this.session.interaction.lastActiveNodeId = null;
    this.session.interaction.lastActiveNodeAt = null;
  }

  setCurrentEntryNodeId(value) {
    const folder = this.getFolderRecord();
    if (folder) {
      folder.entryNodeId = typeof value === 'string' ? value : null;
    }
  }

  syncNavigationPathToDocument() {
    const resolved = this.resolveFolderPath();
    const nextPath = resolved.path;
    const currentPath = Array.isArray(this.session.navigation?.path) ? this.session.navigation.path : [];
    const currentStack = Array.isArray(this.session.navigation?.viewportStack) ? this.session.navigation.viewportStack : [];
    const pathChanged = nextPath.length !== currentPath.length || nextPath.some((id, index) => id !== currentPath[index]);

    if (!pathChanged) {
      return false;
    }

    const viewportToRestore = currentStack[nextPath.length] || null;
    this.session.navigation.path = nextPath;
    this.session.navigation.viewportStack = currentStack.slice(0, nextPath.length);
    this.clearTransientFocus();
    const currentDocument = this.getCurrentDocument();
    const entryNodeId = currentDocument?.entryNodeId || Object.keys(currentDocument?.nodes || {})[0] || null;
    if (entryNodeId) {
      this.setLastActiveNode(entryNodeId);
    }

    this.emit('selection:updated', this.session.selection);
    this.emit('navigation:updated', {
      path: this.getCurrentDocumentPath(),
      depth: this.getCurrentDepth(),
      action: 'normalize',
    });
    this.emit('state:updated', this.state);

    if (viewportToRestore) {
      const x = Number.isFinite(viewportToRestore.x) ? viewportToRestore.x : 0;
      const y = Number.isFinite(viewportToRestore.y) ? viewportToRestore.y : 0;
      const scale = Number.isFinite(viewportToRestore.scale) ? viewportToRestore.scale : 1;
      this.setTransform(x, y, scale);
    }
    return true;
  }

  enterFolder(folderId) {
    if (typeof folderId !== 'string' || !folderId.trim()) {
      return false;
    }

    const currentFolderId = this.getCurrentFolderId();
    const folderNode = this.document.folders?.[folderId];
    if (!folderNode || folderNode.parentFolderId !== currentFolderId) {
      return false;
    }

    if (this.getCurrentDepth() >= MAX_FOLDER_DEPTH) {
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(`已達最深層 ${MAX_FOLDER_DEPTH}，無法再進入下一層。`);
      }
      return false;
    }

    if (!Array.isArray(this.session.navigation.viewportStack)) {
      this.session.navigation.viewportStack = [];
    }

    const nextEntryNodeId = folderNode.entryNodeId
      || folderNode.children?.find((child) => child.kind === 'node')?.id
      || folderNode.children?.find((child) => child.kind === 'folder')?.id
      || null;
    this.session.navigation.viewportStack.push({ ...this.getTransform() });
    this.session.navigation.path = [...this.getCurrentDocumentPath(), folderId];
    this.clearTransientFocus();
    if (nextEntryNodeId) {
      this.setLastActiveNode(nextEntryNodeId);
    }

    this.emit('navigation:updated', {
      path: this.getCurrentDocumentPath(),
      depth: this.getCurrentDepth(),
      action: 'enter',
      folderId,
    });
    this.emit('selection:updated', this.session.selection);
    this.emit('state:updated', this.state);
    return true;
  }

  exitFolder() {
    const currentPath = this.getCurrentDocumentPath();
    if (!currentPath.length) {
      return false;
    }

    const exitingFolderId = currentPath[currentPath.length - 1];

    const viewportStack = Array.isArray(this.session.navigation.viewportStack)
      ? this.session.navigation.viewportStack
      : [];
    const nextViewport = viewportStack.length > 0 ? viewportStack[viewportStack.length - 1] : null;

    this.session.navigation.path = currentPath.slice(0, -1);
    this.session.navigation.viewportStack = viewportStack.slice(0, -1);
    this.clearTransientFocus();
    if (exitingFolderId) {
      this.setLastActiveNode(exitingFolderId);
    }

    this.emit('navigation:updated', {
      path: this.getCurrentDocumentPath(),
      depth: this.getCurrentDepth(),
      action: 'exit',
    });
    this.emit('selection:updated', this.session.selection);
    this.emit('state:updated', this.state);

    if (nextViewport && typeof nextViewport === 'object') {
      const x = Number.isFinite(nextViewport.x) ? nextViewport.x : 0;
      const y = Number.isFinite(nextViewport.y) ? nextViewport.y : 0;
      const scale = Number.isFinite(nextViewport.scale) ? nextViewport.scale : 1;
      this.setTransform(x, y, scale);
    }

    return true;
  }

  goToDepth(targetDepth = 0) {
    const safeTargetDepth = Math.max(0, Math.min(MAX_FOLDER_DEPTH, Number.isFinite(targetDepth) ? Math.floor(targetDepth) : 0));
    let changed = false;
    while (this.getCurrentDepth() > safeTargetDepth) {
      changed = this.exitFolder() || changed;
    }
    return changed;
  }

  goToRoot() {
    return this.goToDepth(0);
  }

  restoreNavigation(navigation = {}) {
    const nextPath = Array.isArray(navigation.path) ? navigation.path.filter((id) => typeof id === 'string' && id) : [];
    const nextStack = Array.isArray(navigation.viewportStack) ? navigation.viewportStack.map((item) => ({
      x: Number.isFinite(item?.x) ? item.x : 0,
      y: Number.isFinite(item?.y) ? item.y : 0,
      scale: Number.isFinite(item?.scale) ? item.scale : 1,
    })) : [];
    const resolved = this.resolveFolderPath(nextPath);

    this.session.navigation.path = resolved.path;
    this.session.navigation.viewportStack = nextStack.slice(0, resolved.path.length);
    this.clearTransientFocus();
    const currentDocument = this.getCurrentDocument();
    const entryNodeId = currentDocument?.entryNodeId || Object.keys(currentDocument?.nodes || {})[0] || null;
    if (entryNodeId) {
      this.setLastActiveNode(entryNodeId);
    }

    this.emit('navigation:updated', {
      path: this.getCurrentDocumentPath(),
      depth: this.getCurrentDepth(),
      action: 'restore',
    });
    this.emit('selection:updated', this.session.selection);
    this.emit('state:updated', this.state);
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb) => cb(data));
    }
  }

  _cloneDocument() {
    this.rebuildDerivedState();
    return cloneDocument(this.document);
  }

  _restoreDocument(snapshot) {
    this.document = normalizeDocument(snapshot);
    this.syncNavigationPathToDocument();
    this.emit('document:updated', this.document);
    this.emit('state:updated', this.state);
  }

  rebuildDerivedState() {
    this.document.edges = buildEdgesFromDocument(this.document);
  }

  saveHistory() {
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push(this._cloneDocument());

    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

    this.historyIndex = this.history.length - 1;
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this._restoreDocument(this.history[this.historyIndex]);
    }
  }

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this._restoreDocument(this.history[this.historyIndex]);
    }
  }

  setTransform(x, y, scale) {
    this.session.viewport.x = x;
    this.session.viewport.y = y;
    this.session.viewport.scale = scale;
    this.emit('transform:updated', { x, y, scale });
  }

  getTransform() {
    return { ...this.session.viewport };
  }

  setLastActiveNode(nodeId) {
    this.session.interaction.lastActiveNodeId = nodeId ?? null;
    this.session.interaction.lastActiveNodeAt = nodeId ? Date.now() : null;
  }

  setLastPointer(clientX, clientY) {
    this.session.interaction.lastPointer.x = Number.isFinite(clientX) ? clientX : null;
    this.session.interaction.lastPointer.y = Number.isFinite(clientY) ? clientY : null;
  }

  setSelectionNodeIds(nodeIds = []) {
    const uniqueIds = [...new Set((Array.isArray(nodeIds) ? nodeIds : []).filter(Boolean))];
    this.session.selection.nodeIds = uniqueIds;
    this.session.selection.edgeIds = [];
    if (uniqueIds.length > 0) {
      this.setLastActiveNode(uniqueIds[0]);
    }
    this.emit('selection:updated', this.session.selection);
  }

  clearSelection() {
    this.session.selection.nodeIds = [];
    this.session.selection.edgeIds = [];
    this.emit('selection:updated', this.session.selection);
  }

  addNodeToFolder(node, folderId = this.getCurrentFolderId()) {
    const safeFolderId = this.document.folders?.[folderId] ? folderId : this.getRootFolderId();
    if (!isPlainObject(node) || typeof node.id !== 'string' || !node.id) {
      return null;
    }

    const normalizedNode = node;
    normalizedNode.folderId = safeFolderId;
    this.document.nodes[normalizedNode.id] = normalizedNode;

    const folder = this.document.folders?.[safeFolderId];
    if (folder) {
      folder.children = Array.isArray(folder.children) ? folder.children : [];
      folder.children.push({ kind: 'node', id: normalizedNode.id });
    }

    return normalizedNode;
  }

  addFolderToFolder(folder, parentFolderId = this.getCurrentFolderId()) {
    const safeParentId = this.document.folders?.[parentFolderId] ? parentFolderId : this.getRootFolderId();
    if (!isPlainObject(folder) || typeof folder.id !== 'string' || !folder.id) {
      return null;
    }

    const normalizedFolder = folder;
    normalizedFolder.parentFolderId = safeParentId;
    normalizedFolder.type = 'folder';
    this.document.folders[normalizedFolder.id] = normalizedFolder;

    const parentFolder = this.document.folders?.[safeParentId];
    if (parentFolder) {
      parentFolder.children = Array.isArray(parentFolder.children) ? parentFolder.children : [];
      parentFolder.children.push({ kind: 'folder', id: normalizedFolder.id });
    }

    return normalizedFolder;
  }

  removeNodeFromFolder(nodeId) {
    const node = this.document.nodes?.[nodeId];
    if (!node) {
      return false;
    }

    const parentFolder = this.document.folders?.[node.folderId || this.getRootFolderId()];
    if (parentFolder && Array.isArray(parentFolder.children)) {
      parentFolder.children = parentFolder.children.filter((child) => !(child.kind === 'node' && child.id === nodeId));
    }

    delete this.document.nodes[nodeId];
    return true;
  }

  removeFolderRecursive(folderId) {
    const folder = this.document.folders?.[folderId];
    if (!folder || folderId === this.getRootFolderId()) {
      return false;
    }

    const children = Array.isArray(folder.children) ? [...folder.children] : [];
    children.forEach((child) => {
      if (child.kind === 'folder') {
        this.removeFolderRecursive(child.id);
      } else if (child.kind === 'node') {
        this.removeNodeFromFolder(child.id);
      }
    });

    const parentFolder = this.document.folders?.[folder.parentFolderId || this.getRootFolderId()];
    if (parentFolder && Array.isArray(parentFolder.children)) {
      parentFolder.children = parentFolder.children.filter((child) => !(child.kind === 'folder' && child.id === folderId));
    }

    delete this.document.folders[folderId];
    return true;
  }

  moveNodeToFolder(nodeId, folderId) {
    const node = this.document.nodes?.[nodeId];
    const nextFolder = this.document.folders?.[folderId];
    if (!node || !nextFolder) {
      return false;
    }

    const previousFolder = this.document.folders?.[node.folderId || this.getRootFolderId()];
    if (previousFolder && Array.isArray(previousFolder.children)) {
      previousFolder.children = previousFolder.children.filter((child) => !(child.kind === 'node' && child.id === nodeId));
    }

    nextFolder.children = Array.isArray(nextFolder.children) ? nextFolder.children : [];
    nextFolder.children.push({ kind: 'node', id: nodeId });
    node.folderId = folderId;
    return true;
  }

  moveFolderToFolder(folderId, parentFolderId) {
    const folder = this.document.folders?.[folderId];
    const nextParent = this.document.folders?.[parentFolderId];
    if (!folder || !nextParent || folderId === this.getRootFolderId()) {
      return false;
    }

    const previousParent = this.document.folders?.[folder.parentFolderId || this.getRootFolderId()];
    if (previousParent && Array.isArray(previousParent.children)) {
      previousParent.children = previousParent.children.filter((child) => !(child.kind === 'folder' && child.id === folderId));
    }

    nextParent.children = Array.isArray(nextParent.children) ? nextParent.children : [];
    nextParent.children.push({ kind: 'folder', id: folderId });
    folder.parentFolderId = parentFolderId;
    return true;
  }

  replaceDocument(nextDocument, { saveToHistory = true, resetHistory = false } = {}) {
    this.document = normalizeDocument(nextDocument);
    this.session.navigation.path = [];
    this.session.navigation.viewportStack = [];
    this.clearTransientFocus();
    this.session.selection.nodeIds = [];
    this.session.selection.edgeIds = [];
    this.emit('selection:updated', this.session.selection);
    this.emit('navigation:updated', {
      path: this.getCurrentDocumentPath(),
      depth: this.getCurrentDepth(),
      action: 'reset',
    });
    this.emit('document:updated', this.document);
    this.emit('state:updated', this.state);
    if (resetHistory) {
      this.history = [this._cloneDocument()];
      this.historyIndex = 0;
      return;
    }

    if (saveToHistory) {
      this.saveHistory();
    }
  }
}

export const store = new StateStore();
