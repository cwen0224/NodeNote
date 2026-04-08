import { renderer } from './Renderer.js';
import { persistenceManager } from './PersistenceManager.js';
import { store } from './StateStore.js';
import { createDefaultDocument } from './core/documentSchema.js';
import {
  applyCollaborativePatch,
  createCollaborativePatch,
  isCollaborativePatchEmpty,
} from './core/googleSheetCollab.js';
import {
  commitGitHubSnapshot,
  fetchGitHubSnapshot,
} from './core/cloudGitHubTransport.js';
import {
  normalizeSnapshotFromText,
  postNoCors,
  requestJsonp,
} from './core/cloudTransport.js';
import {
  buildSheetCommitPayload,
  buildSheetRequestUrl,
  DEFAULT_SHEET_POLL_MS,
  resolveSheetClientName,
  resolveSheetPollIntervalMs,
} from './core/cloudSheetTransport.js';
import {
  mergeSheetRemoteDocument,
  normalizeSheetResponse,
} from './core/cloudSheetState.js';
import { commitCloudSyncStatePatch } from './core/cloudSyncStateCommit.js';
import {
  buildSyncLogText,
  createSyncLogEntry,
  normalizeSyncLogEntry,
} from './core/cloudSyncLog.js';
import {
  buildSyncLogListHtml,
  buildSyncLogSummaryText,
} from './core/cloudSyncLogView.js';
import {
  resolveCloudSyncFreshness,
} from './core/cloudSyncFreshness.js';
import {
  resolveCloudSyncErrorMessage,
} from './core/cloudSyncError.js';
import {
  resolveCloudSyncStateChange,
} from './core/cloudSyncStatus.js';
import {
  applyCloudSyncBadgeView,
  applyCloudSyncDialogView,
} from './core/cloudSyncStatusView.js';
import {
  buildCloudSyncSuccessPatch,
} from './core/cloudSyncOutcome.js';
import {
  finishCloudSyncError,
  finishCloudSyncIdle,
  finishCloudSyncSuccess,
} from './core/cloudSyncWorkflow.js';
import {
  buildDocumentFingerprint,
  buildFingerprint,
  cloneValue as clone,
  escapeHtml,
  formatClockStamp,
  isPlainObject,
  isDeepEqual,
  normalizeWorkspaceSnapshot,
  readOrCreateClientId,
  sanitizeText as sanitizeString,
} from './core/cloudSyncUtils.js';

const CONFIG_STORAGE_KEY = 'nodenote.cloudsync.config.v1';
const STATE_STORAGE_KEY = 'nodenote.cloudsync.state.v1';
const DEFAULT_SYNC_PATH = 'project-state.json';
const CLOUD_SYNC_VERSION = '1.0.0';
const AUTO_SYNC_DEBOUNCE_MS = 2800;
const SHEET_AUTO_SYNC_DEBOUNCE_MS = 1200;
const SHEET_CLIENT_STORAGE_KEY = 'nodenote.sheet.client-id.v1';
const DEFAULT_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwoztDsaKOldxW3HxJ_DTnaem58yCqKeQk-6kbqXj-E9LZ9dGuGhZUOF_JZY6HNejQC/exec';
const LEGACY_SHEET_WEB_APP_URLS = new Set([
  'https://script.google.com/macros/s/AKfycbya8qJjNRDSSk7nZuGx0-ACZTt6fIHisw7uaZ-zmGpf3JgB17HVhH7bDUHGIg3eEOyz/exec',
  'https://script.google.com/macros/s/AKfycbwez1B0c5LClHi4kYXqWyuEtCtDstFz0QRkSfBkQib7LSJG4-KzOeVrose73hANvueP/exec',
]);
const SYNC_LOG_STORAGE_KEY = 'nodenote.cloudsync.logs.v1';
const MAX_SYNC_LOG_ENTRIES = 80;

class CloudSyncManager {
  constructor() {
    this.config = this.loadConfig();
    this.state = this.loadState();
    this.logEntries = this.loadLogs();
    this.toolbarButton = null;
    this.statusBadge = null;
    this.overlay = null;
    this.panel = null;
    this.statusText = null;
    this.logSummary = null;
    this.logList = null;
    this.inputs = {};
    this.syncTimer = null;
    this.pollTimer = null;
    this.syncInFlight = false;
    this.sheetPollInFlight = false;
    this.pendingSnapshot = null;
    this.skipNextAutosave = false;
    this.initialized = false;
    this.boundAutosave = this.handleAutosave.bind(this);
    this.sheetClientId = readOrCreateClientId();
    this.sheetBaselineDocument = null;
    this.sheetLastRevision = 0;
    this.sheetLastFingerprint = null;
    this.boundVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  init() {
    if (this.initialized) {
      return;
    }

    this.toolbarButton = document.getElementById('btn-sync-now');
    this.statusBadge = document.getElementById('sync-status-badge');
    this.buildDialog();
    this.bindEvents();
    this.applyStateToUI();
    this.refreshTransportMode();
    this.appendSyncLog('info', 'init', '同步管理器啟動', '本機同步日誌已就緒');
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
      const next = {
        ...defaults,
        ...(isPlainObject(parsed) ? parsed : {}),
      };
      if (next.provider === 'sheets') {
        const currentUrl = sanitizeString(next.sheetWebAppUrl);
        if (!currentUrl || LEGACY_SHEET_WEB_APP_URLS.has(currentUrl)) {
          next.sheetWebAppUrl = DEFAULT_SHEET_WEB_APP_URL;
        }
        if (!sanitizeString(next.sheetClientName)) {
          next.sheetClientName = defaults.sheetClientName;
        }
        if (!Number.isFinite(next.sheetPollIntervalMs) || next.sheetPollIntervalMs < DEFAULT_SHEET_POLL_MS) {
          next.sheetPollIntervalMs = DEFAULT_SHEET_POLL_MS;
        }
      }
      return next;
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
    document.addEventListener('visibilitychange', this.boundVisibilityChange);
    this.inputs.provider?.addEventListener('change', () => {
      this.updateProviderPanels();
      this.updateStatusBadge();
      this.updateDialogStatus();
    });

    this.statusBadge?.addEventListener('click', () => {
      this.openDialog();
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
      } else if (action === 'copy-logs') {
        this.copySyncLogsToClipboard();
      } else if (action === 'clear-logs') {
        this.clearSyncLogs();
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
      <section class="cloud-sync-log-panel">
        <div class="cloud-sync-log-header">
          <div>
            <h3>本機同步日誌</h3>
            <p>只存在這台裝置的瀏覽器本機，可用來追蹤同步、驗證與錯誤。</p>
          </div>
          <div class="cloud-sync-log-actions">
            <button type="button" data-cloud-action="copy-logs">複製日誌</button>
            <button type="button" data-cloud-action="clear-logs">清空</button>
          </div>
        </div>
        <div class="cloud-sync-log-summary" data-cloud-log-summary>尚未記錄任何同步日誌。</div>
        <div class="cloud-sync-log-list" data-cloud-log-list></div>
      </section>
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
    this.logSummary = this.overlay.querySelector('[data-cloud-log-summary]');
    this.logList = this.overlay.querySelector('[data-cloud-log-list]');
    this.inputs = this.collectInputs();
    this.updateProviderPanels();
    this.renderSyncLogs();
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
    this.renderSyncLogs();
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
    commitCloudSyncStatePatch(this, resolveCloudSyncStateChange({ kind, message, detail }));
    this.refreshStatusViews(message, detail);
  }

  refreshStatusViews(message = '', detail = '') {
    this.updateStatusBadge(message, detail);
    this.updateDialogStatus(message, detail);
  }

  loadLogs() {
    try {
      const raw = localStorage.getItem(SYNC_LOG_STORAGE_KEY);
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((entry) => normalizeSyncLogEntry(entry))
        .filter(Boolean)
        .slice(0, MAX_SYNC_LOG_ENTRIES);
    } catch {
      return [];
    }
  }

  saveLogs() {
    try {
      localStorage.setItem(SYNC_LOG_STORAGE_KEY, JSON.stringify(this.logEntries.slice(0, MAX_SYNC_LOG_ENTRIES)));
    } catch {
      // Ignore quota / storage availability issues.
    }
  }

  appendSyncLog(level, action, message, detail = '', context = {}) {
    const entry = createSyncLogEntry({
      level,
      action,
      message,
      detail,
      context,
    });

    if (!entry) {
      return null;
    }

    this.logEntries = [entry, ...this.logEntries].slice(0, MAX_SYNC_LOG_ENTRIES);
    this.saveLogs();
    this.renderSyncLogs();
    return entry;
  }

  renderSyncLogs() {
    if (this.logSummary) {
      this.logSummary.textContent = buildSyncLogSummaryText(this.logEntries);
    }

    if (!this.logList) {
      return;
    }

    this.logList.innerHTML = buildSyncLogListHtml(this.logEntries);
  }

  buildSyncLogText() {
    return buildSyncLogText(this.logEntries);
  }

  async copySyncLogsToClipboard() {
    const text = this.buildSyncLogText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      this.setStatus('idle', '本機同步日誌已複製');
      this.appendSyncLog('info', 'log', '複製本機同步日誌');
      return true;
    } catch (error) {
      this.setStatus('error', '複製日誌失敗');
      this.appendSyncLog('error', 'log', '複製本機同步日誌失敗', this.getErrorMessage(error));
      return false;
    }
  }

  clearSyncLogs() {
    this.logEntries = [];
    this.saveLogs();
    this.renderSyncLogs();
    this.setStatus('idle', '本機同步日誌已清空');
  }

  updateStatusBadge(message = '', detail = '') {
    applyCloudSyncBadgeView(this.statusBadge, {
      provider: this.config.provider,
      isConfigReady: this.isConfigReady(),
      syncInFlight: this.syncInFlight,
      lastError: this.state.lastError,
      lastSyncedAt: this.state.lastSyncedAt,
      message,
      detail,
    });
  }

  updateDialogStatus(message = '', detail = '') {
    applyCloudSyncDialogView(this.statusText, {
      provider: this.config.provider,
      isConfigReady: this.isConfigReady(),
      syncInFlight: this.syncInFlight,
      lastError: this.state.lastError,
      lastSyncedAt: this.state.lastSyncedAt,
      message,
      detail,
      isMessageError: kindLabel(message) === 'error',
    });
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
    this.setStatus('idle', '同步設定已儲存');

    if (syncImmediately && this.isConfigReady()) {
      return this.syncNow({ force: true });
    }

    return true;
  }

  refreshTransportMode() {
    if (this.config.provider === 'sheets' && this.isConfigReady() && !document.hidden) {
      this.startSheetPolling();
      return;
    }

    this.stopSheetPolling();
  }

  handleVisibilityChange() {
    if (document.hidden) {
      this.stopSheetPolling();
      return;
    }

    this.refreshTransportMode();
  }

  startSheetPolling() {
    this.stopSheetPolling();

    if (this.config.provider !== 'sheets' || !this.isConfigReady()) {
      return;
    }

    const interval = resolveSheetPollIntervalMs(this.config, DEFAULT_SHEET_POLL_MS);
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }

    this.pollTimer = window.setInterval(() => {
      if (document.hidden || this.syncInFlight || this.sheetPollInFlight) {
        return;
      }
      this.pollSheetNow().catch((error) => {
        console.warn('Google Sheet poll failed', error);
      });
    }, interval);

    queueMicrotask(() => {
      if (this.config.provider === 'sheets' && this.isConfigReady() && !this.sheetPollInFlight) {
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

  getProviderLabel() {
    return this.config.provider === 'sheets' ? 'Sync' : 'Backup';
  }

  getProviderTitleLabel() {
    return this.config.provider === 'sheets' ? 'Google Sheet' : 'GitHub';
  }

  async pushSheetSnapshot(snapshot = null, { force = false } = {}) {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      this.appendSyncLog('error', 'sheet', 'Google Sheet 同步失敗', '請先完成 Google Sheet 設定');
      return false;
    }

    const currentDocument = snapshot?.document ? snapshot.document : store.getDocumentSnapshot();
    const baselineDocument = this.sheetBaselineDocument || createDefaultDocument();
    const patch = createCollaborativePatch(baselineDocument, currentDocument);
    if (isCollaborativePatchEmpty(patch)) {
      const fingerprint = buildDocumentFingerprint(currentDocument);
      commitCloudSyncStatePatch(this, buildCloudSyncSuccessPatch({
        fingerprint,
        clearLastError: true,
      }));
      this.updateStatusBadge('Sheet content unchanged');
      this.updateDialogStatus('Google Sheet 內容沒有變化。');
      this.appendSyncLog('info', 'sheet', 'Google Sheet 內容沒有變化', `revision=${this.sheetLastRevision || 0}`);
      return true;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Sheet sync...');
    this.updateDialogStatus('正在同步 Google Sheet 共編內容...');
    this.appendSyncLog('info', 'sheet', '開始同步 Google Sheet 共編內容', `revision=${this.sheetLastRevision || 0}`);

    try {
      const payload = buildSheetCommitPayload({
        patch,
        projectKey: this.config.sheetProjectKey,
        clientId: this.sheetClientId,
        clientName: resolveSheetClientName(this.config, `NodeNote-${this.sheetClientId.slice(-4)}`),
        secret: this.config.sheetSecret,
        baseRevision: this.sheetLastRevision || 0,
        savedAt: snapshot?.savedAt || new Date().toISOString(),
        version: CLOUD_SYNC_VERSION,
      });

      const requestUrl = buildSheetRequestUrl({
        baseUrl: this.config.sheetWebAppUrl,
        action: 'commit',
        projectKey: this.config.sheetProjectKey,
        clientId: this.sheetClientId,
        secret: this.config.sheetSecret,
      });

      await postNoCors(requestUrl, payload);

      this.sheetBaselineDocument = clone(currentDocument);
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint: buildDocumentFingerprint(currentDocument),
          syncedAt: snapshot?.savedAt || new Date().toISOString(),
          syncCountDelta: 1,
        },
        statusMessage: 'Google Sheet 同步已送出',
        statusDetail: '等待背景輪詢確認',
        logScope: 'sheet',
        logTitle: 'Google Sheet 同步已送出',
        logDetail: `revision=${this.sheetLastRevision || 0}`,
        logKind: 'info',
        logContext: {
          savedAt: this.state.lastSyncedAt,
        },
      });
      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'sheet',
        logTitle: 'Google Sheet 同步失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
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

  async verifySheetUpload() {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      this.appendSyncLog('error', 'sheet-verify', 'Google Sheet 驗證失敗', '請先完成 Google Sheet 設定');
      return false;
    }

    this.updateStatusBadge('Sheet verifying...');
    this.updateDialogStatus('正在驗證 Google Sheet 是否真的寫入...');
    this.appendSyncLog('info', 'sheet-verify', '開始驗證 Google Sheet 寫入');

    try {
      const response = await requestJsonp(buildSheetRequestUrl({
        baseUrl: this.config.sheetWebAppUrl,
        action: 'state',
        projectKey: this.config.sheetProjectKey,
        clientId: this.sheetClientId,
        secret: this.config.sheetSecret,
        extraParams: {
          revision: this.sheetLastRevision || 0,
        },
      }));

      const { remoteDocument, remoteRevision, updatedAt } = normalizeSheetResponse(response, {
        fallbackRevision: this.sheetLastRevision || 0,
      });

      if (!remoteDocument) {
        throw new Error('驗證失敗：讀回不到 Google Sheet 內容');
      }

      const localDocument = store.getDocumentSnapshot();
      if (!isDeepEqual(remoteDocument, localDocument)) {
        throw new Error('驗證失敗：Sheet 讀回內容與本機不同步');
      }

      this.sheetBaselineDocument = clone(remoteDocument);
      this.sheetLastRevision = remoteRevision;
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint: buildDocumentFingerprint(remoteDocument),
          syncedAt: updatedAt || new Date().toISOString(),
          remoteRevision: this.sheetLastRevision,
        },
        statusMessage: 'Google Sheet 驗證成功',
        statusDetail: `Revision ${this.sheetLastRevision || 0}`,
        logScope: 'sheet-verify',
        logTitle: 'Google Sheet 驗證成功',
        logDetail: `revision=${this.sheetLastRevision || 0}`,
        logContext: {
          savedAt: this.state.lastSyncedAt,
        },
      });
      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'sheet-verify',
        logTitle: 'Google Sheet 驗證失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
      return false;
    }
  }

  async pollSheetNow() {
    if (!this.isConfigReady()) {
      return false;
    }

    if (this.sheetPollInFlight) {
      return false;
    }

    this.sheetPollInFlight = true;
    this.updateStatusBadge('Sheet polling...');

    try {
      const response = await requestJsonp(buildSheetRequestUrl({
        baseUrl: this.config.sheetWebAppUrl,
        action: 'state',
        projectKey: this.config.sheetProjectKey,
        clientId: this.sheetClientId,
        secret: this.config.sheetSecret,
        extraParams: {
          revision: this.sheetLastRevision || 0,
        },
      }));

      const { remoteDocument, remoteRevision, updatedAt, localPatch, mergedDocument, hasLocalChanges } =
        mergeSheetRemoteDocument({
          response,
          baselineDocument: this.sheetBaselineDocument || createDefaultDocument(),
          currentDocument: store.getDocumentSnapshot(),
        });

      if (!remoteDocument) {
        return false;
      }

      if (remoteRevision <= (this.sheetLastRevision || 0)) {
        this.updateStatusBadge();
        this.updateDialogStatus();
        return true;
      }

      const localSavedAt = persistenceManager.getStoredSnapshot()?.savedAt || this.state.lastSyncedAt || null;
      const freshness = resolveCloudSyncFreshness({
        localSavedAt,
        remoteSavedAt: updatedAt,
      });

      if (!freshness.shouldApplyRemote) {
        this.sheetLastRevision = remoteRevision;
        this.sheetBaselineDocument = clone(remoteDocument);
        finishCloudSyncIdle(this, {
          patch: {
            remoteRevision,
            syncedAt: updatedAt || new Date().toISOString(),
          },
          statusMessage: '本機內容較新，保留本機版本',
          statusDetail: localSavedAt
            ? `本機 ${localSavedAt} / 雲端 ${updatedAt || 'unknown'}`
            : `雲端 ${updatedAt || 'unknown'}`,
          logScope: 'sheet-poll',
          logTitle: 'Google Sheet 輪詢保留本機版本',
          logDetail: `local=${localSavedAt || 'unknown'} remote=${updatedAt || 'unknown'}`,
          logContext: {
            revision: remoteRevision,
            winner: freshness.winner,
          },
        });
        return true;
      }

      this.sheetLastRevision = remoteRevision;
      commitCloudSyncStatePatch(
        this,
        buildCloudSyncSuccessPatch({
          remoteRevision,
          syncedAt: updatedAt || new Date().toISOString(),
        })
      );

      const currentDocument = store.getDocumentSnapshot();
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
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint: buildDocumentFingerprint(mergedDocument),
        },
        statusMessage: 'Google Sheet 已同步',
        statusDetail: `Revision ${remoteRevision}`,
        logScope: 'sheet-poll',
        logTitle: 'Google Sheet 輪詢同步成功',
        logDetail: `revision=${remoteRevision}`,
        logContext: {
          savedAt: this.state.lastSyncedAt,
        },
      });

      if (hasLocalChanges && this.config.autoSync) {
        this.queueSync({
          schema: 'nodenote.sheet.cocollab',
          version: CLOUD_SYNC_VERSION,
          savedAt: new Date().toISOString(),
          document: mergedDocument,
        });
      }

      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'sheet-poll',
        logTitle: 'Google Sheet 輪詢失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
      return false;
    } finally {
      this.sheetPollInFlight = false;
    }
  }

  async pullSheetNow({ skipConfirm = false } = {}) {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      this.appendSyncLog('error', 'sheet-pull', 'Google Sheet 拉回失敗', '請先完成 Google Sheet 設定');
      return false;
    }

    if (!skipConfirm && !window.confirm('Google Sheet 會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Sheet pulling...');
    this.updateDialogStatus('正在從 Google Sheet 拉回內容...');
    this.appendSyncLog('info', 'sheet-pull', '開始從 Google Sheet 拉回內容');

    try {
      const response = await requestJsonp(buildSheetRequestUrl({
        baseUrl: this.config.sheetWebAppUrl,
        action: 'state',
        projectKey: this.config.sheetProjectKey,
        clientId: this.sheetClientId,
        secret: this.config.sheetSecret,
      }));

      const { remoteDocument, remoteRevision, updatedAt, mergedDocument } = mergeSheetRemoteDocument({
        response,
        baselineDocument: this.sheetBaselineDocument || createDefaultDocument(),
        currentDocument: store.getDocumentSnapshot(),
      });

      if (!remoteDocument) {
        this.setStatus('error', 'Google Sheet 沒有找到內容，請先完成一次同步');
        this.appendSyncLog('error', 'sheet-pull', 'Google Sheet 拉回失敗', 'Google Sheet 沒有找到內容，請先完成一次同步');
        return false;
      }

      const localSavedAt = persistenceManager.getStoredSnapshot()?.savedAt || this.state.lastSyncedAt || null;
      const freshness = resolveCloudSyncFreshness({
        localSavedAt,
        remoteSavedAt: updatedAt,
      });

      if (!freshness.shouldApplyRemote) {
        this.sheetBaselineDocument = clone(remoteDocument);
        this.sheetLastRevision = remoteRevision;
        finishCloudSyncIdle(this, {
          patch: {
            remoteRevision: this.sheetLastRevision,
          },
          statusMessage: '本機內容較新，保留本機版本',
          statusDetail: localSavedAt
            ? `本機 ${localSavedAt} / 雲端 ${updatedAt || 'unknown'}`
            : `雲端 ${updatedAt || 'unknown'}`,
          logScope: 'sheet-pull',
          logTitle: 'Google Sheet 拉回保留本機版本',
          logDetail: `local=${localSavedAt || 'unknown'} remote=${updatedAt || 'unknown'}`,
          logContext: {
            revision: remoteRevision,
            winner: freshness.winner,
          },
        });
        return true;
      }

      const previousPath = store.getCurrentDocumentPath();
      this.skipNextAutosave = true;
      store.replaceDocument(mergedDocument, { resetHistory: true, saveToHistory: false });
      if (previousPath.length) {
        store.restoreNavigation({ path: previousPath, viewportStack: [] });
      }
      renderer.renderAll();

      this.sheetBaselineDocument = clone(remoteDocument);
      this.sheetLastRevision = remoteRevision;
      finishCloudSyncSuccess(this, {
        patch: {
          remoteRevision: this.sheetLastRevision,
          fingerprint: buildDocumentFingerprint(mergedDocument),
          syncedAt: updatedAt || new Date().toISOString(),
        },
        statusMessage: 'Google Sheet 拉回完成',
        statusDetail: `Revision ${this.sheetLastRevision || 0}`,
        logScope: 'sheet-pull',
        logTitle: 'Google Sheet 拉回完成',
        logDetail: `revision=${this.sheetLastRevision || 0}`,
        logContext: {
          savedAt: this.state.lastSyncedAt,
        },
      });
      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'sheet-pull',
        logTitle: 'Google Sheet 拉回失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
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
    return this.pushSnapshot(snapshot, { force });
  }

  async syncAndVerifyNow({ force = true } = {}) {
    if (this.config.provider !== 'sheets') {
      this.config = {
        ...this.config,
        provider: 'sheets',
        sheetWebAppUrl: sanitizeString(this.config.sheetWebAppUrl) || DEFAULT_SHEET_WEB_APP_URL,
        sheetProjectKey: sanitizeString(this.config.sheetProjectKey, 'default'),
        sheetClientName: sanitizeString(this.config.sheetClientName, 'NodeNote'),
      };
      this.saveConfig();
      this.applyStateToUI();
      this.refreshTransportMode();
    }

    this.appendSyncLog('info', 'sheet', '手動同步並驗證已觸發');
    const synced = await this.syncNow({ force });
    if (!synced) {
      return false;
    }

    return this.verifySheetUpload();
  }

  async pushSnapshot(snapshot, { force = false } = {}) {
    if (this.config.provider === 'sheets') {
      return this.pushSheetSnapshot(snapshot, { force });
    }

    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成雲端設定');
      this.appendSyncLog('error', 'github', 'GitHub 同步失敗', '請先完成雲端設定');
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
    this.appendSyncLog('info', 'github', '開始同步 GitHub 快照', `path=${this.config.path}`);

    try {
      const remote = await fetchGitHubSnapshot({
        owner: this.config.owner,
        repo: this.config.repo,
        path: this.config.path,
        token: this.config.token,
        allowMissing: true,
      });

      const response = await commitGitHubSnapshot({
        owner: this.config.owner,
        repo: this.config.repo,
        path: this.config.path,
        token: this.config.token,
        branch: this.config.branch,
        snapshot,
        remoteSha: remote?.sha || null,
      });

      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint,
          remoteSha: response?.content?.sha || remote?.sha || null,
          syncedAt: snapshot.savedAt || new Date().toISOString(),
          syncCountDelta: 1,
        },
        statusMessage: '雲端同步完成',
        statusDetail: `上次同步 ${formatClockStamp(this.state.lastSyncedAt)}`,
        logScope: 'github',
        logTitle: 'GitHub 同步完成',
        logDetail: `path=${this.config.path}`,
        logContext: {
          sha: this.state.lastRemoteSha || null,
        },
      });
      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'github',
        logTitle: 'GitHub 同步失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
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
      this.appendSyncLog('error', 'github-pull', 'GitHub 拉回失敗', '請先完成雲端設定');
      return false;
    }

    if (!skipConfirm && !window.confirm('雲端快照會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Cloud pulling...');
    this.updateDialogStatus('正在從雲端拉回快照...');
    this.appendSyncLog('info', 'github-pull', '開始從 GitHub 拉回快照', `path=${this.config.path}`);

    try {
      const remote = await fetchGitHubSnapshot({
        owner: this.config.owner,
        repo: this.config.repo,
        path: this.config.path,
        token: this.config.token,
        allowMissing: true,
      });
      if (!remote) {
        this.setStatus('error', '雲端沒有找到快照檔，請先按一次立即同步');
        this.appendSyncLog('error', 'github-pull', 'GitHub 拉回失敗', '雲端沒有找到快照檔，請先按一次立即同步');
        return false;
      }

      const snapshot = normalizeSnapshotFromText(remote.text);
      if (!snapshot) {
        throw new Error('雲端檔案不是有效的 NodeNote 快照');
      }

      const localSavedAt = persistenceManager.getStoredSnapshot()?.savedAt || this.state.lastSyncedAt || null;
      const freshness = resolveCloudSyncFreshness({
        localSavedAt,
        remoteSavedAt: snapshot.savedAt,
      });

      if (!freshness.shouldApplyRemote) {
        this.setStatus(
          'idle',
          '本機內容較新，保留本機版本',
          localSavedAt
            ? `本機 ${localSavedAt} / 雲端 ${snapshot.savedAt || 'unknown'}`
            : `雲端 ${snapshot.savedAt || 'unknown'}`
        );
        this.appendSyncLog(
          'info',
          'github-pull',
          'GitHub 拉回保留本機版本',
          `local=${localSavedAt || 'unknown'} remote=${snapshot.savedAt || 'unknown'}`,
          {
            winner: freshness.winner,
          }
        );
        return true;
      }

      this.skipNextAutosave = true;
      store.replaceDocument(snapshot.document, { resetHistory: true, saveToHistory: false });

      const workspace = isPlainObject(snapshot.workspace)
        ? snapshot.workspace
        : { navigation: snapshot.navigation, viewport: snapshot.viewport };

      if (workspace.navigation) {
        store.restoreNavigation(workspace.navigation);
      }

      if (workspace.viewport) {
        store.setTransform(workspace.viewport.x, workspace.viewport.y, workspace.viewport.scale);
      } else {
        renderer.fitGraphToViewport();
      }

      renderer.renderAll();

      const fingerprint = buildFingerprint(snapshot);
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint,
          remoteSha: remote.sha || null,
          syncedAt: snapshot.savedAt || new Date().toISOString(),
        },
        statusMessage: '雲端拉回完成',
        statusDetail: `上次同步 ${formatClockStamp(this.state.lastSyncedAt)}`,
        logScope: 'github-pull',
        logTitle: 'GitHub 拉回完成',
        logDetail: `path=${this.config.path}`,
        logContext: {
          sha: this.state.lastRemoteSha || null,
        },
      });
      return true;
    } catch (error) {
      finishCloudSyncError(this, {
        error: this.getErrorMessage(error),
        logScope: 'github-pull',
        logTitle: 'GitHub 拉回失敗',
        logDetail: this.getErrorMessage(error),
        logContext: {
          status: error?.status || null,
        },
      });
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
    }
  }

  getErrorMessage(error) {
    return resolveCloudSyncErrorMessage(error, this.config.provider);
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
