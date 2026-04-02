import { renderer } from './Renderer.js';
import { persistenceManager } from './PersistenceManager.js';
import { store } from './StateStore.js';
import { normalizeDocument } from './core/documentSchema.js';

const CONFIG_STORAGE_KEY = 'nodenote.cloudsync.config.v1';
const STATE_STORAGE_KEY = 'nodenote.cloudsync.state.v1';
const DEFAULT_SYNC_PATH = 'project-state.json';
const CLOUD_SYNC_VERSION = '1.0.0';
const AUTO_SYNC_DEBOUNCE_MS = 2800;

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
    this.syncInFlight = false;
    this.pendingSnapshot = null;
    this.skipNextAutosave = false;
    this.initialized = false;
    this.boundAutosave = this.handleAutosave.bind(this);
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
    if (this.config.restoreOnStartupWhenEmpty && !persistenceManager.wasRestored()) {
      queueMicrotask(() => {
        this.pullNow({ skipConfirm: true });
      });
    }
    this.initialized = true;
  }

  loadConfig() {
    const defaults = {
      provider: 'github',
      owner: 'cwen0224',
      repo: 'NodeNote',
      branch: 'master',
      path: DEFAULT_SYNC_PATH,
      token: '',
      autoSync: true,
      restoreOnStartupWhenEmpty: false,
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
            <p>本機 autosave 保留較多步數，雲端只存最新快照。</p>
          </div>
          <button type="button" class="cloud-sync-close" data-cloud-action="close" aria-label="關閉雲端同步">×</button>
        </div>
        <div class="cloud-sync-status" aria-live="polite">尚未設定雲端同步。</div>
        <div class="cloud-sync-form">
          <label class="cloud-sync-field">
            <span>Provider</span>
            <input type="text" data-cloud-field="provider" value="github" readonly />
          </label>
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
  }

  collectInputs() {
    return {
      provider: this.overlay?.querySelector('[data-cloud-field="provider"]') || null,
      owner: this.overlay?.querySelector('[data-cloud-field="owner"]') || null,
      repo: this.overlay?.querySelector('[data-cloud-field="repo"]') || null,
      branch: this.overlay?.querySelector('[data-cloud-field="branch"]') || null,
      path: this.overlay?.querySelector('[data-cloud-field="path"]') || null,
      token: this.overlay?.querySelector('[data-cloud-field="token"]') || null,
      autoSync: this.overlay?.querySelector('[data-cloud-field="autoSync"]') || null,
      restoreOnStartupWhenEmpty: this.overlay?.querySelector('[data-cloud-field="restoreOnStartupWhenEmpty"]') || null,
    };
  }

  applyStateToUI() {
    this.fillInputsFromConfig();
    this.updateStatusBadge();
    this.updateDialogStatus();
  }

  fillInputsFromConfig() {
    const config = this.config;
    if (!this.inputs) {
      return;
    }

    if (this.inputs.provider) {
      this.inputs.provider.value = config.provider || 'github';
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
    if (this.inputs.autoSync) {
      this.inputs.autoSync.checked = Boolean(config.autoSync);
    }
    if (this.inputs.restoreOnStartupWhenEmpty) {
      this.inputs.restoreOnStartupWhenEmpty.checked = Boolean(config.restoreOnStartupWhenEmpty);
    }
  }

  readConfigFromInputs() {
    return {
      provider: 'github',
      owner: sanitizeString(this.inputs.owner?.value),
      repo: sanitizeString(this.inputs.repo?.value),
      branch: sanitizeString(this.inputs.branch?.value, 'master'),
      path: sanitizeString(this.inputs.path?.value, DEFAULT_SYNC_PATH),
      token: sanitizeString(this.inputs.token?.value),
      autoSync: Boolean(this.inputs.autoSync?.checked),
      restoreOnStartupWhenEmpty: Boolean(this.inputs.restoreOnStartupWhenEmpty?.checked),
    };
  }

  isConfigReady() {
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

    this.statusBadge.classList.remove('is-idle', 'is-syncing', 'is-error', 'is-off');
    if (!this.isConfigReady()) {
      this.statusBadge.classList.add('is-off');
      this.statusBadge.textContent = 'Cloud: off';
      this.statusBadge.title = '點擊設定 GitHub 雲端同步';
      return;
    }

    if (this.syncInFlight) {
      this.statusBadge.classList.add('is-syncing');
      this.statusBadge.textContent = 'Cloud: sync';
      this.statusBadge.title = '雲端快照同步中';
      return;
    }

    if (this.state.lastError) {
      this.statusBadge.classList.add('is-error');
      this.statusBadge.textContent = 'Cloud: error';
      this.statusBadge.title = this.state.lastError;
      return;
    }

    this.statusBadge.classList.add('is-idle');
    if (this.state.lastSyncedAt) {
      const stamp = formatClockStamp(this.state.lastSyncedAt);
      this.statusBadge.textContent = `Cloud: ${stamp}`;
      this.statusBadge.title = detail || message || `上次雲端同步 ${stamp}`;
      return;
    }

    this.statusBadge.textContent = 'Cloud: ready';
    this.statusBadge.title = detail || message || '雲端同步已就緒';
  }

  updateDialogStatus(message = '', detail = '') {
    if (!this.statusText) {
      return;
    }

    let text = '尚未設定雲端同步。';
    if (!this.isConfigReady()) {
      text = '請填入 GitHub Owner / Repository / Branch / Path / Token。';
    } else if (this.syncInFlight) {
      text = '正在同步雲端快照...';
    } else if (this.state.lastError) {
      text = `錯誤：${this.state.lastError}`;
    } else if (this.state.lastSyncedAt) {
      text = `上次同步：${formatClockStamp(this.state.lastSyncedAt)}`;
    } else {
      text = '已就緒，等下一次 autosave 就會同步。';
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
    this.setStatus('idle', '雲端設定已儲存');

    if (syncImmediately && this.isConfigReady()) {
      this.syncNow({ force: true });
    }
  }

  createSnapshot() {
    return persistenceManager.createSnapshot();
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

    const fingerprint = buildFingerprint(snapshot);
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

    this.updateStatusBadge('Cloud sync queued');
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.flushSyncQueue();
    }, AUTO_SYNC_DEBOUNCE_MS);
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
      return 'GitHub Token 無效或沒有 Contents: write 權限';
    }

    if (error.status === 404) {
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
