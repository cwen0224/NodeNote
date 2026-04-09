import { store } from './StateStore.js';
import { normalizeDocument } from './core/documentSchema.js';

const AUTOSAVE_STORAGE_KEY = 'nodenote.autosave.current.v1';
const AUTOSAVE_SCOPE_STORAGE_KEY = 'nodenote.autosave.scope.v1';
const AUTOSAVE_SCHEMA = 'nodenote.autosave';
const AUTOSAVE_VERSION = '1.0.0';
const AUTOSAVE_DEBOUNCE_MS = 450;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createWorkspaceSnapshot() {
  return {
    navigation: store.getNavigationSnapshot(),
    viewport: store.getTransform(),
  };
}

function restoreWorkspaceSnapshot(snapshot = {}) {
  const workspace = isPlainObject(snapshot.workspace) ? snapshot.workspace : null;
  const navigation = workspace?.navigation || snapshot.navigation || null;
  const viewport = workspace?.viewport || snapshot.viewport || null;

  if (navigation) {
    store.restoreNavigation(navigation);
  }

  if (isPlainObject(viewport)) {
    const x = Number.isFinite(viewport.x) ? viewport.x : 0;
    const y = Number.isFinite(viewport.y) ? viewport.y : 0;
    const scale = Number.isFinite(viewport.scale) ? viewport.scale : 1;
    store.setTransform(x, y, scale);
  }
}

class PersistenceManager {
  constructor() {
    this.saveTimer = null;
    this.revision = 0;
    this.restored = false;
    this.scopeKey = this.loadScopeKey();
    this.boundScheduleSave = this.scheduleSave.bind(this);
    this.boundFlushNow = this.flushNow.bind(this);
    this.boundBeforeUnload = this.flushNow.bind(this);
    this.boundVisibilityChange = this.handleVisibilityChange.bind(this);
    this.initialized = false;
  }

  init() {
    if (this.initialized) {
      return;
    }

    this.restoreAutosave();
    this.bindEvents();
    this.initialized = true;
  }

  bindEvents() {
    [
      'document:updated',
      'navigation:updated',
      'nodes:updated',
      'connections:updated',
      'node:moved',
      'node:contentUpdated',
      'transform:updated',
    ].forEach((eventName) => {
      store.on(eventName, this.boundScheduleSave);
    });

    window.addEventListener('beforeunload', this.boundBeforeUnload);
    document.addEventListener('visibilitychange', this.boundVisibilityChange);
  }

  handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      this.flushNow();
    }
  }

  getStoredSnapshot() {
    try {
      const raw = localStorage.getItem(this.getAutosaveStorageKey());
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed) || parsed.schema !== AUTOSAVE_SCHEMA) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  loadScopeKey() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_SCOPE_STORAGE_KEY);
      return typeof raw === 'string' && raw.trim() ? raw.trim() : 'global';
    } catch {
      return 'global';
    }
  }

  saveScopeKey(scopeKey) {
    const nextScope = typeof scopeKey === 'string' && scopeKey.trim() ? scopeKey.trim() : 'global';
    this.scopeKey = nextScope;
    try {
      localStorage.setItem(AUTOSAVE_SCOPE_STORAGE_KEY, nextScope);
    } catch {
      // Ignore quota issues.
    }
  }

  getAutosaveStorageKey(scopeKey = this.scopeKey) {
    const safeScope = typeof scopeKey === 'string' && scopeKey.trim() ? scopeKey.trim() : 'global';
    return `${AUTOSAVE_STORAGE_KEY}.${encodeURIComponent(safeScope)}`;
  }

  setScopeKey(scopeKey, { restore = false } = {}) {
    const nextScope = typeof scopeKey === 'string' && scopeKey.trim() ? scopeKey.trim() : 'global';
    if (nextScope === this.scopeKey) {
      if (restore) {
        return this.restoreAutosave();
      }
      return false;
    }

    this.saveScopeKey(nextScope);
    if (restore) {
      return this.restoreAutosave();
    }
    return true;
  }

  hasStoredSnapshot() {
    return Boolean(this.getStoredSnapshot());
  }

  wasRestored() {
    return this.restored;
  }

  restoreAutosave() {
    const snapshot = this.getStoredSnapshot();
    if (!snapshot || !isPlainObject(snapshot.document)) {
      return false;
    }

    const restoredDocument = normalizeDocument(snapshot.document);
    store.replaceDocument(restoredDocument, { resetHistory: true, saveToHistory: false });
    restoreWorkspaceSnapshot(snapshot);

    this.restored = true;
    return true;
  }

  createSnapshot() {
    const editedAt = new Date().toISOString();
    return {
      schema: AUTOSAVE_SCHEMA,
      version: AUTOSAVE_VERSION,
      revision: this.revision + 1,
      savedAt: editedAt,
      editedAt,
      document: store.getDocumentSnapshot(),
      workspace: createWorkspaceSnapshot(),
    };
  }

  scheduleSave() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.flushNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  flushNow() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    const snapshot = this.createSnapshot();
    this.revision = snapshot.revision;

    let saved = false;
    try {
      localStorage.setItem(this.getAutosaveStorageKey(), JSON.stringify(snapshot));
      saved = true;
    } catch (error) {
      console.warn('Autosave failed', error);
    }

    store.emit('autosave:updated', {
      ...snapshot,
      saved,
    });
  }
}

export const persistenceManager = new PersistenceManager();
