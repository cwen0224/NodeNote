import { store } from './StateStore.js';
import { normalizeDocument } from './core/documentSchema.js';

const AUTOSAVE_STORAGE_KEY = 'nodenote.autosave.current.v1';
const AUTOSAVE_SCHEMA = 'nodenote.autosave';
const AUTOSAVE_VERSION = '1.0.0';
const AUTOSAVE_DEBOUNCE_MS = 450;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class PersistenceManager {
  constructor() {
    this.saveTimer = null;
    this.revision = 0;
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
      const raw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
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

  restoreAutosave() {
    const snapshot = this.getStoredSnapshot();
    if (!snapshot || !isPlainObject(snapshot.document)) {
      return false;
    }

    const restoredDocument = normalizeDocument(snapshot.document);
    store.replaceDocument(restoredDocument, { resetHistory: true, saveToHistory: false });

    if (isPlainObject(snapshot.viewport)) {
      const x = Number.isFinite(snapshot.viewport.x) ? snapshot.viewport.x : 0;
      const y = Number.isFinite(snapshot.viewport.y) ? snapshot.viewport.y : 0;
      const scale = Number.isFinite(snapshot.viewport.scale) ? snapshot.viewport.scale : 1;
      store.setTransform(x, y, scale);
    }

    return true;
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

    const snapshot = {
      schema: AUTOSAVE_SCHEMA,
      version: AUTOSAVE_VERSION,
      revision: ++this.revision,
      savedAt: new Date().toISOString(),
      document: store.getDocumentSnapshot(),
      viewport: store.getTransform(),
    };

    try {
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('Autosave failed', error);
    }
  }
}

export const persistenceManager = new PersistenceManager();
