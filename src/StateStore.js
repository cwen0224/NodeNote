/**
 * StateStore.js
 * Holds canonical document data and ephemeral session state.
 * The public `state` view is kept for compatibility while the internal
 * separation lets us move toward a command-driven architecture.
 */

import { cloneDocument, createDefaultDocument, normalizeDocument } from './core/documentSchema.js';
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
    define('schemaVersion', () => this.getCurrentDocument().schemaVersion);
    define('meta', () => this.getCurrentDocument().meta);
    define('entryNodeId', () => this.getCurrentDocument().entryNodeId, (value) => {
      this.getCurrentDocument().entryNodeId = value;
    });
    define('nodes', () => this.getCurrentDocument().nodes, (value) => {
      this.getCurrentDocument().nodes = value;
    });
    define('edges', () => this.getCurrentDocument().edges, (value) => {
      this.getCurrentDocument().edges = value;
    });
    define('links', () => this.getCurrentDocument().edges, (value) => {
      this.getCurrentDocument().edges = value;
    });
    define('assets', () => this.getCurrentDocument().assets, (value) => {
      this.getCurrentDocument().assets = value;
    });
    define('extras', () => this.getCurrentDocument().extras, (value) => {
      this.getCurrentDocument().extras = value;
    });
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

  getCurrentDocumentPath(path = this.session.navigation?.path) {
    return this.resolveDocumentPath(path).path;
  }

  getCurrentDepth() {
    return this.getCurrentDocumentPath().length;
  }

  resolveDocumentPath(path = this.session.navigation?.path) {
    const requested = Array.isArray(path) ? path : [];
    const resolved = [];
    let currentDocument = this.document;

    for (const folderId of requested) {
      if (!currentDocument || typeof currentDocument !== 'object') {
        break;
      }

      const folderNode = currentDocument.nodes?.[folderId];
      if (!folderNode || folderNode.type !== 'folder' || !folderNode.folder || !folderNode.folder.document) {
        break;
      }

      resolved.push(folderId);
      currentDocument = folderNode.folder.document;
    }

    return {
      path: resolved,
      document: currentDocument,
    };
  }

  getCurrentDocument() {
    return this.resolveDocumentPath().document;
  }

  getCurrentDocumentSnapshot() {
    return cloneDocument(this.getCurrentDocument());
  }

  getNavigationSnapshot() {
    return cloneDocument(this.session.navigation);
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

  syncNavigationPathToDocument() {
    const resolved = this.resolveDocumentPath();
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

    const currentDocument = this.getCurrentDocument();
    const folderNode = currentDocument.nodes?.[folderId];
    if (!folderNode || folderNode.type !== 'folder' || !folderNode.folder || !folderNode.folder.document) {
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

    const nextEntryNodeId = folderNode.folder?.document?.entryNodeId
      || Object.keys(folderNode.folder?.document?.nodes || {})[0]
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
    const resolved = this.resolveDocumentPath(nextPath);

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
    return cloneDocument(this.document);
  }

  _restoreDocument(snapshot) {
    this.document = normalizeDocument(snapshot);
    this.syncNavigationPathToDocument();
    this.emit('document:updated', this.document);
    this.emit('state:updated', this.state);
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

  getTransform() {
    return { ...this.session.viewport };
  }

  getDocumentSnapshot() {
    return this._cloneDocument();
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
