/**
 * StateStore.js
 * Holds canonical document data and ephemeral session state.
 * The public `state` view is kept for compatibility while the internal
 * separation lets us move toward a command-driven architecture.
 */

import { cloneDocument, createDefaultDocument, normalizeDocument } from './core/documentSchema.js';
import { createDefaultSession } from './core/sessionSchema.js';

export class StateStore {
  constructor() {
    this.document = createDefaultDocument();
    this.session = createDefaultSession();
    this.listeners = {};
    this.history = [];
    this.historyIndex = -1;
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

    define('schemaVersion', () => this.document.schemaVersion);
    define('meta', () => this.document.meta);
    define('entryNodeId', () => this.document.entryNodeId, (value) => {
      this.document.entryNodeId = value;
    });
    define('nodes', () => this.document.nodes, (value) => {
      this.document.nodes = value;
    });
    define('edges', () => this.document.edges, (value) => {
      this.document.edges = value;
    });
    define('links', () => this.document.edges, (value) => {
      this.document.edges = value;
    });
    define('assets', () => this.document.assets, (value) => {
      this.document.assets = value;
    });
    define('extras', () => this.document.extras, (value) => {
      this.document.extras = value;
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

    return view;
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
    this.emit('document:updated', this.document);
    this.emit('state:updated', this.state);
  }

  saveHistory() {
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push(this._cloneDocument());

    if (this.history.length > 50) {
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

  replaceDocument(nextDocument, { saveToHistory = true } = {}) {
    this.document = normalizeDocument(nextDocument);
    this.emit('document:updated', this.document);
    this.emit('state:updated', this.state);
    if (saveToHistory) {
      this.saveHistory();
    }
  }
}

export const store = new StateStore();
