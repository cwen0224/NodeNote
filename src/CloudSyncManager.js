import { renderer } from './Renderer.js';
import { persistenceManager } from './PersistenceManager.js';
import { store } from './StateStore.js';
import { createDefaultDocument, normalizeDocument } from './core/documentSchema.js';
import {
  applyCollaborativePatch,
  createCollaborativePatch,
  isCollaborativePatchEmpty,
} from './core/googleSheetCollab.js';

const CONFIG_STORAGE_KEY = 'nodenote.cloudsync.config.v1';
const STATE_STORAGE_KEY = 'nodenote.cloudsync.state.v1';
const DEFAULT_SYNC_PATH = 'project-state.json';
const CLOUD_SYNC_VERSION = '1.0.0';
const AUTO_SYNC_DEBOUNCE_MS = 2800;
const SHEET_AUTO_SYNC_DEBOUNCE_MS = 1200;
const DEFAULT_SHEET_POLL_MS = 2000;
const SHEET_CLIENT_STORAGE_KEY = 'nodenote.sheet.client-id.v1';
const DEFAULT_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwez1B0c5LClHi4kYXqWyuEtCtDstFz0QRkSfBkQib7LSJG4-KzOeVrose73hANvueP/exec';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeViewport(viewport) {
  if (!isPlainObject(viewport)) {
    return null;
  }

  const x = Number.isFinite(viewport.x) ? viewport.x : 0;
  const y = Number.isFinite(viewport.y) ? viewport.y : 0;
  const scale = Number.isFinite(viewport.scale) ? viewport.scale : 1;

  return { x, y, scale };
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeUtf8Base64(base64) {
  const binary = atob(String(base64 ?? '').replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function formatClockStamp(isoString) {
  const value = isoString ? new Date(isoString) : null;
  if (!value || Number.isNaN(value.getTime())) {
    return '--:--';
  }

  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function buildDocumentFingerprint(document) {
  return JSON.stringify(document ?? null);
}

function isDeepEqual(a, b) {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    for (let index = 0; index < a.length; index += 1) {
      if (!isDeepEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }

  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
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
    if (!isDeepEqual(a[key], b[key])) {
      return false;
    }
  }

  return true;
}

function createClientId() {
  return `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readOrCreateClientId() {
  try {
    const stored = localStorage.getItem(SHEET_CLIENT_STORAGE_KEY);
    if (stored) {
      return stored;
    }
    const next = createClientId();
    localStorage.setItem(SHEET_CLIENT_STORAGE_KEY, next);
    return next;
  } catch {
    return createClientId();
  }
}

function buildFingerprint(snapshot) {
  return JSON.stringify({
    document: snapshot?.document ?? null,
    navigation: snapshot?.navigation ?? null,
    viewport: snapshot?.viewport ?? null,
  });
}

function normalizeCloudSnapshot(payload) {
  if (!isPlainObject(payload)) {
    return null;
  }

  if (isPlainObject(payload.document)) {
    return {
      schema: typeof payload.schema === 'string' ? payload.schema : 'nodenote.autosave',
      version: typeof payload.version === 'string' ? payload.version : CLOUD_SYNC_VERSION,
      revision: Number.isFinite(payload.revision) ? payload.revision : 0,
      savedAt: typeof payload.savedAt === 'string' ? payload.savedAt : null,
      document: normalizeDocument(payload.document),
      navigation: isPlainObject(payload.navigation) ? payload.navigation : null,
      viewport: normalizeViewport(payload.viewport),
    };
  }

  if (
    typeof payload.schemaVersion === 'string' ||
    isPlainObject(payload.meta) ||
    Object.prototype.hasOwnProperty.call(payload, 'entryNodeId') ||
    Array.isArray(payload.edges)
  ) {
    return {
      schema: 'nodenote.autosave',
      version: CLOUD_SYNC_VERSION,
      revision: 0,
      savedAt: null,
      document: normalizeDocument(payload),
      navigation: null,
      viewport: null,
    };
  }

  return null;
}

class CloudSyncManager {
  constructor() {
    this.config = this.loadConfig();
    this.state = this.loadState();
    this.toolbarButton = null;
    this.statusBadge = null;
    this.overlay = null;
    this.panel = null;
    this.statusText = null;
    this.inputs = {};
    this.syncTimer = null;
    this.pollTimer = null;
    this.syncInFlight = false;
    this.pendingSnapshot = null;
    this.skipNextAutosave = false;
    this.initialized = false;
    this.boundAutosave = this.handleAutosave.bind(this);
    this.sheetClientId = readOrCreateClientId();
    this.sheetBaselineDocument = null;
    this.sheetLastRevision = 0;
    this.sheetLastFingerprint = null;
  }

  init() {
    if (this.initialized) {
      return;
    }

    this.toolbarButton = document.getElementById('btn-cloud-sync');
    this.statusBadge = document.getElementById('cloud-status-badge');
    this.buildDialog();
    this.bindEvents();
    this.applyStateToUI();
    this.refreshTransportMode();
    if (this.config.restoreOnStartupWhenEmpty && this.isConfigReady() && !persistenceManager.wasRestored()) {
      queueMicrotask(() => {
        this.pullNow({ skipConfirm: true });
      });
    }
    this.initialized = true;
  }

  loadConfig() {
    const defaults = {
      provider: 'sheets',
      owner: 'cwen0224',
      repo: 'NodeNote',
      branch: 'master',
      path: DEFAULT_SYNC_PATH,
      token: '',
      autoSync: true,
      restoreOnStartupWhenEmpty: false,
      sheetWebAppUrl: DEFAULT_SHEET_WEB_APP_URL,
      sheetProjectKey: 'default',
      sheetClientName: 'NodeNote',
      sheetSecret: '',
      sheetPollIntervalMs: DEFAULT_SHEET_POLL_MS,
    };

    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (!raw) {
        return { ...defaults };
      }

      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...(isPlainObject(parsed) ? parsed : {}),
      };
    } catch {
      return { ...defaults };
    }
  }

  saveConfig(config = this.config) {
    this.config = {
      ...this.config,
      ...(isPlainObject(config) ? config : {}),
    };

    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    } catch (error) {
      console.warn('Cloud config save failed', error);
    }
  }

  loadState() {
    const defaults = {
      lastSyncedAt: null,
      lastError: null,
      lastRemoteSha: null,
      lastFingerprint: null,
      lastRemoteRevision: 0,
      syncCount: 0,
    };

    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (!raw) {
        return { ...defaults };
      }

      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...(isPlainObject(parsed) ? parsed : {}),
      };
    } catch {
      return { ...defaults };
    }
  }

  saveState() {
    try {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(this.state));
    } catch (error) {
      console.warn('Cloud state save failed', error);
    }
  }

  bindEvents() {
    store.on('autosave:updated', (snapshot) => this.handleAutosave(snapshot));
    this.toolbarButton?.addEventListener('click', () => this.openDialog());
    this.statusBadge?.addEventListener('click', () => this.openDialog());
    this.inputs.provider?.addEventListener('change', () => {
      this.updateProviderPanels();
      this.updateStatusBadge();
      this.updateDialogStatus();
    });

    this.overlay?.addEventListener('click', (event) => {
      if (event.target === this.overlay) {
        this.closeDialog();
      }
    });

    this.panel?.addEventListener('click', (event) => {
      const actionButton = event.target.closest?.('[data-cloud-action]');
      if (!actionButton) {
        return;
      }

      const action = actionButton.dataset.cloudAction;
      if (action === 'save') {
        this.saveConfigFromDialog();
      } else if (action === 'push') {
        this.saveConfigFromDialog({ syncImmediately: true });
      } else if (action === 'pull') {
        this.pullNow();
      } else if (action === 'close') {
        this.closeDialog();
      }
    });
  }

  buildDialog() {
    if (document.getElementById('cloud-sync-modal')) {
      this.overlay = document.getElementById('cloud-sync-modal');
      this.panel = this.overlay?.querySelector?.('.cloud-sync-panel') || null;
      this.statusText = this.overlay?.querySelector?.('.cloud-sync-status') || null;
      this.inputs = this.collectInputs();
      return;
    }

    this.overlay = document.createElement('div');
    this.overlay.id = 'cloud-sync-modal';
    this.overlay.className = 'cloud-sync-overlay';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div class="cloud-sync-panel glass-panel">
        <div class="cloud-sync-header">
          <div>
            <h2>Cloud Sync</h2>
            <p>GitHub 用最新快照備份，Google Sheet 用近即時共編。</p>
          </div>
          <button type="button" class="cloud-sync-close" data-cloud-action="close" aria-label="關閉雲端同步">×</button>
        </div>
        <div class="cloud-sync-status" aria-live="polite">尚未設定雲端同步。</div>
        <div class="cloud-sync-form">
          <label class="cloud-sync-field">
            <span>Provider</span>
            <select data-cloud-field="provider">
              <option value="github">GitHub 備份</option>
              <option value="sheets">Google Sheet 共編</option>
            </select>
          </label>
          <section class="cloud-sync-provider-group" data-provider-panel="github">
            <div class="cloud-sync-grid">
              <label class="cloud-sync-field">
                <span>Owner</span>
                <input type="text" data-cloud-field="owner" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>Repository</span>
                <input type="text" data-cloud-field="repo" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>Branch</span>
                <input type="text" data-cloud-field="branch" autocomplete="off" />
              </label>
              <label class="cloud-sync-field cloud-sync-field--wide">
                <span>Path</span>
                <input type="text" data-cloud-field="path" autocomplete="off" />
              </label>
              <label class="cloud-sync-field cloud-sync-field--wide">
                <span>GitHub Token</span>
                <input type="password" data-cloud-field="token" autocomplete="off" />
                <small>Token 會存進瀏覽器本機，只建議使用 Contents: write 的 fine-grained PAT。</small>
              </label>
            </div>
          </section>
          <section class="cloud-sync-provider-group" data-provider-panel="sheets">
            <div class="cloud-sync-note">
              Google Sheet 模式會透過 Apps Script Web App 讀寫試算表，並以輪詢方式近即時同步。
            </div>
            <div class="cloud-sync-grid">
              <label class="cloud-sync-field cloud-sync-field--wide">
                <span>Web App URL</span>
                <input type="text" data-cloud-field="sheetWebAppUrl" autocomplete="off" placeholder="https://script.google.com/macros/s/..." />
              </label>
              <label class="cloud-sync-field">
                <span>Project Key</span>
                <input type="text" data-cloud-field="sheetProjectKey" autocomplete="off" placeholder="default" />
              </label>
              <label class="cloud-sync-field">
                <span>Client Name</span>
                <input type="text" data-cloud-field="sheetClientName" autocomplete="off" placeholder="Alice" />
              </label>
              <label class="cloud-sync-field">
                <span>Secret</span>
                <input type="password" data-cloud-field="sheetSecret" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>Poll Interval (ms)</span>
                <input type="number" min="1000" step="250" data-cloud-field="sheetPollIntervalMs" autocomplete="off" />
              </label>
            </div>
          </section>
          <label class="cloud-sync-toggle">
            <input type="checkbox" data-cloud-field="autoSync" />
            <span>自動同步最新快照</span>
          </label>
          <label class="cloud-sync-toggle">
            <input type="checkbox" data-cloud-field="restoreOnStartupWhenEmpty" />
            <span>啟動時若本機沒有草稿，允許從雲端還原</span>
          </label>
        </div>
        <div class="cloud-sync-actions">
          <button type="button" data-cloud-action="save">保存設定</button>
          <button type="button" data-cloud-action="push">立即同步</button>
          <button type="button" data-cloud-action="pull">從雲端拉回</button>
          <button type="button" data-cloud-action="close">關閉</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
    this.panel = this.overlay.querySelector('.cloud-sync-panel');
    this.statusText = this.overlay.querySelector('.cloud-sync-status');
    this.inputs = this.collectInputs();
    this.updateProviderPanels();
  }

  collectInputs() {
    return {
      provider: this.overlay?.querySelector('[data-cloud-field="provider"]') || null,
      owner: this.overlay?.querySelector('[data-cloud-field="owner"]') || null,
      repo: this.overlay?.querySelector('[data-cloud-field="repo"]') || null,
      branch: this.overlay?.querySelector('[data-cloud-field="branch"]') || null,
      path: this.overlay?.querySelector('[data-cloud-field="path"]') || null,
      token: this.overlay?.querySelector('[data-cloud-field="token"]') || null,
      sheetWebAppUrl: this.overlay?.querySelector('[data-cloud-field="sheetWebAppUrl"]') || null,
      sheetProjectKey: this.overlay?.querySelector('[data-cloud-field="sheetProjectKey"]') || null,
      sheetClientName: this.overlay?.querySelector('[data-cloud-field="sheetClientName"]') || null,
      sheetSecret: this.overlay?.querySelector('[data-cloud-field="sheetSecret"]') || null,
      sheetPollIntervalMs: this.overlay?.querySelector('[data-cloud-field="sheetPollIntervalMs"]') || null,
      autoSync: this.overlay?.querySelector('[data-cloud-field="autoSync"]') || null,
      restoreOnStartupWhenEmpty: this.overlay?.querySelector('[data-cloud-field="restoreOnStartupWhenEmpty"]') || null,
    };
  }

  applyStateToUI() {
    this.fillInputsFromConfig();
    this.updateProviderPanels();
    this.updateStatusBadge();
    this.updateDialogStatus();
  }

  fillInputsFromConfig() {
    const config = this.config;
    if (!this.inputs) {
      return;
    }

    if (this.inputs.provider) {
      this.inputs.provider.value = config.provider || 'sheets';
    }
    if (this.inputs.owner) {
      this.inputs.owner.value = config.owner || '';
    }
    if (this.inputs.repo) {
      this.inputs.repo.value = config.repo || '';
    }
    if (this.inputs.branch) {
      this.inputs.branch.value = config.branch || 'master';
    }
    if (this.inputs.path) {
      this.inputs.path.value = config.path || DEFAULT_SYNC_PATH;
    }
    if (this.inputs.token) {
      this.inputs.token.value = config.token || '';
    }
    if (this.inputs.sheetWebAppUrl) {
      this.inputs.sheetWebAppUrl.value = config.sheetWebAppUrl || '';
    }
    if (this.inputs.sheetProjectKey) {
      this.inputs.sheetProjectKey.value = config.sheetProjectKey || 'default';
    }
    if (this.inputs.sheetClientName) {
      this.inputs.sheetClientName.value = config.sheetClientName || '';
    }
    if (this.inputs.sheetSecret) {
      this.inputs.sheetSecret.value = config.sheetSecret || '';
    }
    if (this.inputs.sheetPollIntervalMs) {
      this.inputs.sheetPollIntervalMs.value = String(Number.isFinite(config.sheetPollIntervalMs) ? config.sheetPollIntervalMs : DEFAULT_SHEET_POLL_MS);
    }
    if (this.inputs.autoSync) {
      this.inputs.autoSync.checked = Boolean(config.autoSync);
    }
    if (this.inputs.restoreOnStartupWhenEmpty) {
      this.inputs.restoreOnStartupWhenEmpty.checked = Boolean(config.restoreOnStartupWhenEmpty);
    }
  }

  updateProviderPanels() {
    if (!this.overlay) {
      return;
    }

    const provider = this.inputs.provider?.value || this.config.provider || 'sheets';
    this.overlay.querySelectorAll?.('[data-provider-panel]').forEach((panel) => {
      const isActive = panel.dataset.providerPanel === provider;
      panel.hidden = !isActive;
    });
  }

  readConfigFromInputs() {
    return {
      provider: this.inputs.provider?.value || this.config.provider || 'sheets',
      owner: sanitizeString(this.inputs.owner?.value),
      repo: sanitizeString(this.inputs.repo?.value),
      branch: sanitizeString(this.inputs.branch?.value, 'master'),
      path: sanitizeString(this.inputs.path?.value, DEFAULT_SYNC_PATH),
      token: sanitizeString(this.inputs.token?.value),
      autoSync: Boolean(this.inputs.autoSync?.checked),
      restoreOnStartupWhenEmpty: Boolean(this.inputs.restoreOnStartupWhenEmpty?.checked),
      sheetWebAppUrl: sanitizeString(this.inputs.sheetWebAppUrl?.value),
      sheetProjectKey: sanitizeString(this.inputs.sheetProjectKey?.value, 'default'),
      sheetClientName: sanitizeString(this.inputs.sheetClientName?.value),
      sheetSecret: sanitizeString(this.inputs.sheetSecret?.value),
      sheetPollIntervalMs: Number.isFinite(Number(this.inputs.sheetPollIntervalMs?.value))
        ? Math.max(1000, Number(this.inputs.sheetPollIntervalMs?.value))
        : DEFAULT_SHEET_POLL_MS,
    };
  }

  isConfigReady() {
    if (this.config.provider === 'sheets') {
      return Boolean(this.config.sheetWebAppUrl && this.config.sheetProjectKey);
    }

    return Boolean(
      this.config.provider === 'github' &&
      this.config.owner &&
      this.config.repo &&
      this.config.branch &&
      this.config.path &&
      this.config.token
    );
  }

  getEndpointUrl() {
    const owner = encodeURIComponent(this.config.owner);
    const repo = encodeURIComponent(this.config.repo);
    const encodedPath = this.config.path
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`;
  }

  getHeaders() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  setStatus(kind, message, detail = '') {
    this.state.status = kind;
    this.state.lastError = kind === 'error' ? message : null;
    if (kind !== 'error' && detail) {
      this.state.lastError = null;
    }

    if (kind === 'ok') {
      this.state.lastSyncedAt = new Date().toISOString();
    }

    this.saveState();
    this.updateStatusBadge(message, detail);
    this.updateDialogStatus(message, detail);
  }

  updateStatusBadge(message = '', detail = '') {
    if (!this.statusBadge) {
      return;
    }

    const label = this.getProviderLabel();
    this.statusBadge.classList.remove('is-idle', 'is-syncing', 'is-error', 'is-off');
    if (!this.isConfigReady()) {
      this.statusBadge.classList.add('is-off');
      this.statusBadge.textContent = `${label}: off`;
      this.statusBadge.title = this.config.provider === 'sheets'
        ? '點擊設定 Google Sheet 共編'
        : '點擊設定 GitHub 雲端同步';
      return;
    }

    if (this.syncInFlight) {
      this.statusBadge.classList.add('is-syncing');
      this.statusBadge.textContent = `${label}: sync`;
      this.statusBadge.title = this.config.provider === 'sheets'
        ? 'Google Sheet 共編同步中'
        : '雲端快照同步中';
      return;
    }

    if (this.state.lastError) {
      this.statusBadge.classList.add('is-error');
      this.statusBadge.textContent = `${label}: error`;
      this.statusBadge.title = this.state.lastError;
      return;
    }

    this.statusBadge.classList.add('is-idle');
    if (this.state.lastSyncedAt) {
      const stamp = formatClockStamp(this.state.lastSyncedAt);
      this.statusBadge.textContent = `${label}: ${stamp}`;
      this.statusBadge.title = detail || message || (this.config.provider === 'sheets'
        ? `上次 Google Sheet 同步 ${stamp}`
        : `上次雲端同步 ${stamp}`);
      return;
    }

    this.statusBadge.textContent = `${label}: ready`;
    this.statusBadge.title = detail || message || (this.config.provider === 'sheets'
      ? 'Google Sheet 共編已就緒'
      : '雲端同步已就緒');
  }

  updateDialogStatus(message = '', detail = '') {
    if (!this.statusText) {
      return;
    }

    let text = '尚未設定雲端同步。';
    if (!this.isConfigReady()) {
      text = this.config.provider === 'sheets'
        ? '請填入 Google Sheet Web App URL / Project Key。'
        : '請填入 GitHub Owner / Repository / Branch / Path / Token。';
    } else if (this.syncInFlight) {
      text = this.config.provider === 'sheets'
        ? '正在同步 Google Sheet 共編內容...'
        : '正在同步雲端快照...';
    } else if (this.state.lastError) {
      text = `錯誤：${this.state.lastError}`;
    } else if (this.state.lastSyncedAt) {
      text = this.config.provider === 'sheets'
        ? `上次 Google Sheet 同步：${formatClockStamp(this.state.lastSyncedAt)}`
        : `上次同步：${formatClockStamp(this.state.lastSyncedAt)}`;
    } else {
      text = this.config.provider === 'sheets'
        ? '已就緒，會輪詢 Google Sheet 並同步本機修改。'
        : '已就緒，等下一次 autosave 就會同步。';
    }

    if (message && kindLabel(message) === 'error') {
      text = detail ? `${message}：${detail}` : message;
    } else if (message && this.syncInFlight) {
      text = message;
    }

    this.statusText.textContent = text;
  }

  openDialog() {
    this.fillInputsFromConfig();
    this.updateProviderPanels();
    this.updateStatusBadge();
    this.updateDialogStatus();
    if (this.overlay) {
      this.overlay.hidden = false;
    }
  }

  closeDialog() {
    if (this.overlay) {
      this.overlay.hidden = true;
    }
  }

  saveConfigFromDialog({ syncImmediately = false } = {}) {
    const nextConfig = this.readConfigFromInputs();
    this.saveConfig(nextConfig);
    this.fillInputsFromConfig();
    this.updateProviderPanels();
    this.refreshTransportMode();
    this.setStatus('idle', '雲端設定已儲存');

    if (syncImmediately && this.isConfigReady()) {
      this.syncNow({ force: true });
    }
  }

  refreshTransportMode() {
    if (this.config.provider === 'sheets' && this.isConfigReady()) {
      this.startSheetPolling();
      return;
    }

    this.stopSheetPolling();
  }

  startSheetPolling() {
    this.stopSheetPolling();

    if (this.config.provider !== 'sheets' || !this.isConfigReady()) {
      return;
    }

    const interval = this.getSheetPollIntervalMs();
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }

    this.pollTimer = window.setInterval(() => {
      if (document.hidden || this.syncInFlight) {
        return;
      }
      this.pollSheetNow().catch((error) => {
        console.warn('Google Sheet poll failed', error);
      });
    }, interval);

    queueMicrotask(() => {
      if (this.config.provider === 'sheets' && this.isConfigReady()) {
        this.pollSheetNow().catch((error) => {
          console.warn('Google Sheet initial poll failed', error);
        });
      }
    });
  }

  stopSheetPolling() {
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getSheetPollIntervalMs() {
    const raw = Number(this.config.sheetPollIntervalMs);
    return Number.isFinite(raw) ? Math.max(1000, Math.floor(raw)) : DEFAULT_SHEET_POLL_MS;
  }

  getSheetClientName() {
    const explicit = sanitizeString(this.config.sheetClientName);
    if (explicit) {
      return explicit;
    }

    return `NodeNote-${this.sheetClientId.slice(-4)}`;
  }

  getProviderLabel() {
    return this.config.provider === 'sheets' ? 'Sheet' : 'Cloud';
  }

  getProviderTitleLabel() {
    return this.config.provider === 'sheets' ? 'Google Sheet' : 'Cloud';
  }

  getSheetRequestUrl(action = 'state', extraParams = {}) {
    const base = sanitizeString(this.config.sheetWebAppUrl);
    if (!base) {
      return '';
    }

    let url;
    try {
      url = new URL(base);
    } catch {
      return base;
    }

    url.searchParams.set('action', action);
    url.searchParams.set('projectKey', sanitizeString(this.config.sheetProjectKey, 'default'));
    url.searchParams.set('clientId', this.sheetClientId);
    const secret = sanitizeString(this.config.sheetSecret);
    if (secret) {
      url.searchParams.set('secret', secret);
    }
    Object.entries(extraParams || {}).forEach(([key, value]) => {
      if (typeof value !== 'undefined' && value !== null && String(value).length > 0) {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  createSheetPayloadFromSnapshot(snapshot = null) {
    const document = snapshot?.document ? snapshot.document : store.getDocumentSnapshot();
    const baseline = this.sheetBaselineDocument || createDefaultDocument();
    const patch = createCollaborativePatch(baseline, document);
    return {
      action: 'commit',
      schema: 'nodenote.sheet.cocollab',
      version: CLOUD_SYNC_VERSION,
      projectKey: sanitizeString(this.config.sheetProjectKey, 'default'),
      clientId: this.sheetClientId,
      clientName: this.getSheetClientName(),
      secret: sanitizeString(this.config.sheetSecret),
      baseRevision: this.sheetLastRevision || 0,
      savedAt: new Date().toISOString(),
      patch,
    };
  }

  async pushSheetSnapshot(snapshot = null, { force = false } = {}) {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      return false;
    }

    const currentDocument = snapshot?.document ? snapshot.document : store.getDocumentSnapshot();
    const baselineDocument = this.sheetBaselineDocument || createDefaultDocument();
    const patch = createCollaborativePatch(baselineDocument, currentDocument);
    if (isCollaborativePatchEmpty(patch)) {
      const fingerprint = buildDocumentFingerprint(currentDocument);
      this.state.lastFingerprint = fingerprint;
      this.state.lastError = null;
      this.saveState();
      this.updateStatusBadge('Sheet content unchanged');
      this.updateDialogStatus('Google Sheet 內容沒有變化。');
      return true;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Sheet sync...');
    this.updateDialogStatus('正在同步 Google Sheet 共編內容...');

    try {
      const payload = {
        action: 'commit',
        schema: 'nodenote.sheet.cocollab',
        version: CLOUD_SYNC_VERSION,
        projectKey: sanitizeString(this.config.sheetProjectKey, 'default'),
        clientId: this.sheetClientId,
        clientName: this.getSheetClientName(),
        secret: sanitizeString(this.config.sheetSecret),
        baseRevision: this.sheetLastRevision || 0,
        savedAt: snapshot?.savedAt || new Date().toISOString(),
        patch,
      };

      const response = await this.requestJson(this.getSheetRequestUrl('commit'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const nextDocument = response?.document ? normalizeDocument(response.document) : currentDocument;
      const nextRevision = Number.isFinite(response?.revision) ? response.revision : (this.sheetLastRevision + 1);
      const mergedFingerprint = buildDocumentFingerprint(nextDocument);

      this.sheetBaselineDocument = clone(nextDocument);
      this.sheetLastRevision = nextRevision;
      this.state.lastRemoteRevision = nextRevision;
      this.state.lastFingerprint = mergedFingerprint;
      this.state.lastSyncedAt = response?.updatedAt || new Date().toISOString();
      this.state.syncCount = (this.state.syncCount || 0) + 1;
      this.state.lastError = null;
      this.saveState();

      const previousPath = store.getCurrentDocumentPath();
      if (response?.document && !isDeepEqual(currentDocument, nextDocument)) {
        this.skipNextAutosave = true;
        store.replaceDocument(nextDocument, { resetHistory: true, saveToHistory: false });
        if (previousPath.length) {
          store.restoreNavigation({ path: previousPath, viewportStack: [] });
        }
        renderer.renderAll();
      }

      this.setStatus('ok', 'Google Sheet 同步完成', `Revision ${nextRevision}`);
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.state.lastError = message;
      this.saveState();
      this.setStatus('error', message);
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
      if (this.pendingSnapshot) {
        this.queueSync(this.pendingSnapshot);
      }
    }
  }

  async pollSheetNow() {
    if (!this.isConfigReady()) {
      return false;
    }

    this.updateStatusBadge('Sheet polling...');

    try {
      const response = await this.requestJson(this.getSheetRequestUrl('state', {
        revision: this.sheetLastRevision || 0,
      }), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response?.document) {
        return false;
      }

      const remoteRevision = Number.isFinite(response.revision) ? response.revision : 0;
      if (remoteRevision <= (this.sheetLastRevision || 0)) {
        this.updateStatusBadge();
        this.updateDialogStatus();
        return true;
      }

      const remoteDocument = normalizeDocument(response.document);
      const currentDocument = store.getDocumentSnapshot();
      const baselineDocument = this.sheetBaselineDocument || createDefaultDocument();
      const localPatch = createCollaborativePatch(baselineDocument, currentDocument);
      const mergedDocument = isCollaborativePatchEmpty(localPatch)
        ? remoteDocument
        : applyCollaborativePatch(remoteDocument, localPatch);

      this.sheetLastRevision = remoteRevision;
      this.state.lastRemoteRevision = remoteRevision;
      this.state.lastSyncedAt = response?.updatedAt || new Date().toISOString();
      this.state.lastError = null;
      this.saveState();

      const previousPath = store.getCurrentDocumentPath();
      if (!isDeepEqual(currentDocument, mergedDocument)) {
        this.skipNextAutosave = true;
        store.replaceDocument(mergedDocument, { resetHistory: true, saveToHistory: false });
        if (previousPath.length) {
          store.restoreNavigation({ path: previousPath, viewportStack: [] });
        }
        renderer.renderAll();
      }

      this.sheetBaselineDocument = clone(remoteDocument);
      this.state.lastFingerprint = buildDocumentFingerprint(mergedDocument);
      this.setStatus('ok', 'Google Sheet 已同步', `Revision ${remoteRevision}`);

      if (!isCollaborativePatchEmpty(localPatch) && this.config.autoSync) {
        this.queueSync({
          schema: 'nodenote.sheet.cocollab',
          version: CLOUD_SYNC_VERSION,
          savedAt: new Date().toISOString(),
          document: mergedDocument,
        });
      }

      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.state.lastError = message;
      this.saveState();
      this.setStatus('error', message);
      return false;
    }
  }

  async pullSheetNow({ skipConfirm = false } = {}) {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      return false;
    }

    if (!skipConfirm && !window.confirm('Google Sheet 會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Sheet pulling...');
    this.updateDialogStatus('正在從 Google Sheet 拉回內容...');

    try {
      const response = await this.requestJson(this.getSheetRequestUrl('state'), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response?.document) {
        this.setStatus('error', 'Google Sheet 沒有找到內容，請先完成一次同步');
        return false;
      }

      const remoteDocument = normalizeDocument(response.document);
      const currentDocument = store.getDocumentSnapshot();
      const baselineDocument = this.sheetBaselineDocument || createDefaultDocument();
      const localPatch = createCollaborativePatch(baselineDocument, currentDocument);
      const mergedDocument = isCollaborativePatchEmpty(localPatch)
        ? remoteDocument
        : applyCollaborativePatch(remoteDocument, localPatch);

      const previousPath = store.getCurrentDocumentPath();
      this.skipNextAutosave = true;
      store.replaceDocument(mergedDocument, { resetHistory: true, saveToHistory: false });
      if (previousPath.length) {
        store.restoreNavigation({ path: previousPath, viewportStack: [] });
      }
      renderer.renderAll();

      this.sheetBaselineDocument = clone(remoteDocument);
      this.sheetLastRevision = Number.isFinite(response.revision) ? response.revision : this.sheetLastRevision;
      this.state.lastRemoteRevision = this.sheetLastRevision;
      this.state.lastFingerprint = buildDocumentFingerprint(mergedDocument);
      this.state.lastSyncedAt = response?.updatedAt || new Date().toISOString();
      this.state.lastError = null;
      this.saveState();
      this.setStatus('ok', 'Google Sheet 拉回完成', `Revision ${this.sheetLastRevision || 0}`);
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.state.lastError = message;
      this.saveState();
      this.setStatus('error', message);
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
    }
  }

  createSnapshot() {
    if (this.config.provider === 'sheets') {
      return this.createSheetSnapshot();
    }
    return persistenceManager.createSnapshot();
  }

  createSheetSnapshot() {
    return {
      schema: 'nodenote.sheet.collab',
      version: CLOUD_SYNC_VERSION,
      savedAt: new Date().toISOString(),
      baseRevision: this.sheetLastRevision || 0,
      clientId: this.sheetClientId,
      clientName: sanitizeString(this.config.sheetClientName, 'NodeNote'),
      projectKey: sanitizeString(this.config.sheetProjectKey, 'default'),
      document: store.getDocumentSnapshot(),
    };
  }

  handleAutosave(snapshot) {
    if (!snapshot || this.skipNextAutosave) {
      this.skipNextAutosave = false;
      return;
    }

    if (!this.config.autoSync || !this.isConfigReady()) {
      this.updateStatusBadge();
      return;
    }

    const fingerprint = this.config.provider === 'sheets'
      ? buildDocumentFingerprint(snapshot.document)
      : buildFingerprint(snapshot);
    if (fingerprint && fingerprint === this.state.lastFingerprint) {
      this.updateStatusBadge();
      return;
    }

    this.queueSync(snapshot);
  }

  queueSync(snapshot) {
    this.pendingSnapshot = snapshot ? clone(snapshot) : this.createSnapshot();

    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
    }

    this.updateStatusBadge(this.config.provider === 'sheets' ? 'Sheet sync queued' : 'Cloud sync queued');
    const debounceMs = this.config.provider === 'sheets'
      ? SHEET_AUTO_SYNC_DEBOUNCE_MS
      : AUTO_SYNC_DEBOUNCE_MS;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.flushSyncQueue();
    }, debounceMs);
  }

  async flushSyncQueue() {
    if (this.syncInFlight) {
      return;
    }

    const snapshot = this.pendingSnapshot || this.createSnapshot();
    this.pendingSnapshot = null;
    await this.pushSnapshot(snapshot);
  }

  async syncNow({ force = false } = {}) {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    const snapshot = this.pendingSnapshot || this.createSnapshot();
    this.pendingSnapshot = null;
    await this.pushSnapshot(snapshot, { force });
  }

  async pushSnapshot(snapshot, { force = false } = {}) {
    if (this.config.provider === 'sheets') {
      return this.pushSheetSnapshot(snapshot, { force });
    }

    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成雲端設定');
      return false;
    }

    const fingerprint = buildFingerprint(snapshot);
    if (!force && fingerprint && fingerprint === this.state.lastFingerprint) {
      this.setStatus('idle', '雲端內容沒有變化');
      return true;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Cloud sync...');
    this.updateDialogStatus('正在同步雲端快照...');

    try {
      const remote = await this.getRemoteFile({ allowMissing: true });
      const payload = JSON.stringify(snapshot, null, 2);
      const body = {
        message: `NodeNote autosave ${formatClockStamp(snapshot.savedAt || new Date().toISOString())}`,
        content: encodeUtf8Base64(payload),
        branch: this.config.branch,
      };

      if (remote?.sha) {
        body.sha = remote.sha;
      }

      const response = await this.requestJson(this.getEndpointUrl(), {
        method: 'PUT',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
      });

      this.state.lastFingerprint = fingerprint;
      this.state.lastRemoteSha = response?.content?.sha || remote?.sha || null;
      this.state.lastSyncedAt = snapshot.savedAt || new Date().toISOString();
      this.state.syncCount = (this.state.syncCount || 0) + 1;
      this.state.lastError = null;
      this.saveState();
      this.setStatus('ok', '雲端同步完成', `上次同步 ${formatClockStamp(this.state.lastSyncedAt)}`);
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.state.lastError = message;
      this.saveState();
      this.setStatus('error', message);
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
      if (this.pendingSnapshot) {
        this.queueSync(this.pendingSnapshot);
      }
    }
  }

  async pullNow({ skipConfirm = false } = {}) {
    if (this.config.provider === 'sheets') {
      return this.pullSheetNow({ skipConfirm });
    }

    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成雲端設定');
      return false;
    }

    if (!skipConfirm && !window.confirm('雲端快照會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Cloud pulling...');
    this.updateDialogStatus('正在從雲端拉回快照...');

    try {
      const remote = await this.getRemoteFile({ allowMissing: true });
      if (!remote) {
        this.setStatus('error', '雲端沒有找到快照檔，請先按一次立即同步');
        return false;
      }

      const snapshot = this.normalizeSnapshotFromText(remote.text);
      if (!snapshot) {
        throw new Error('雲端檔案不是有效的 NodeNote 快照');
      }

      this.skipNextAutosave = true;
      store.replaceDocument(snapshot.document, { resetHistory: true, saveToHistory: false });

      if (snapshot.navigation) {
        store.restoreNavigation(snapshot.navigation);
      }

      if (snapshot.viewport) {
        store.setTransform(snapshot.viewport.x, snapshot.viewport.y, snapshot.viewport.scale);
      } else {
        renderer.fitGraphToViewport();
      }

      renderer.renderAll();

      const fingerprint = buildFingerprint(snapshot);
      this.state.lastFingerprint = fingerprint;
      this.state.lastRemoteSha = remote.sha || null;
      this.state.lastSyncedAt = snapshot.savedAt || new Date().toISOString();
      this.state.lastError = null;
      this.saveState();
      this.setStatus('ok', '雲端拉回完成', `上次同步 ${formatClockStamp(this.state.lastSyncedAt)}`);
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.state.lastError = message;
      this.saveState();
      this.setStatus('error', message);
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
    }
  }

  normalizeSnapshotFromText(text) {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }

    try {
      return normalizeCloudSnapshot(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async getRemoteFile({ allowMissing = false } = {}) {
    let response = null;

    try {
      response = await this.requestJson(this.getEndpointUrl(), {
        method: 'GET',
        headers: this.getHeaders(),
      });
    } catch (error) {
      if (allowMissing && error?.status === 404) {
        return null;
      }
      throw error;
    }

    if (!response) {
      return null;
    }

    if (response.truncated) {
      throw new Error('雲端檔案太大，GitHub API 回傳 truncated');
    }

    if (typeof response.content !== 'string' || response.encoding !== 'base64') {
      throw new Error('GitHub 回傳的內容格式不正確');
    }

    return {
      sha: typeof response.sha === 'string' ? response.sha : null,
      text: decodeUtf8Base64(response.content),
    };
  }

  async requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let parsed = null;

    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const message = parsed?.message || response.statusText || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.response = parsed;
      throw error;
    }

    if (parsed && parsed.ok === false) {
      const message = parsed.error || parsed.message || 'Request failed';
      const error = new Error(message);
      error.status = response.status || 500;
      error.response = parsed;
      throw error;
    }

    return parsed;
  }

  getErrorMessage(error) {
    if (!error) {
      return '未知錯誤';
    }

    if (typeof error === 'string') {
      return error;
    }

    if (error.status === 401 || error.status === 403) {
      if (this.config.provider === 'sheets') {
        return 'Google Sheet Web App 權限不足或 Secret 錯誤';
      }
      return 'GitHub Token 無效或沒有 Contents: write 權限';
    }

    if (error.status === 404) {
      if (this.config.provider === 'sheets') {
        return '找不到指定的 Google Sheet Web App URL';
      }
      return '找不到指定的 Repo / Branch / Path';
    }

    return error.message || '同步失敗';
  }
}

function kindLabel(message) {
  const value = String(message || '').toLowerCase();
  if (value.includes('error') || value.includes('fail') || value.includes('錯誤')) {
    return 'error';
  }
  return 'info';
}

export const cloudSyncManager = new CloudSyncManager();
