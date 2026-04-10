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
  deleteGitHubSnapshot,
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
  resolveSheetProjectKey,
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
const SHEET_PROJECT_KEY_HISTORY_STORAGE_KEY = 'nodenote.sheet.project-key-history.v1';
const DEFAULT_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbwoztDsaKOldxW3HxJ_DTnaem58yCqKeQk-6kbqXj-E9LZ9dGuGhZUOF_JZY6HNejQC/exec';
const LEGACY_SHEET_WEB_APP_URLS = new Set([
  'https://script.google.com/macros/s/AKfycbwUmkFmlaghJWUrQVNR78ygvz0PzzYeBu_rqP3ZwAs/exec',
  'https://script.google.com/macros/s/AKfycbwoztDsaKOldxW3HxJ_DTnaem58yCqKeQk-6kbqXj-E9LZ9dGuGhZUOF_JZY6HNejQC/exec',
  'https://script.google.com/macros/s/AKfycbya8qJjNRDSSk7nZuGx0-ACZTt6fIHisw7uaZ-zmGpf3JgB17HVhH7bDUHGIg3eEOyz/exec',
  'https://script.google.com/macros/s/AKfycbwez1B0c5LClHi4kYXqWyuEtCtDstFz0QRkSfBkQib7LSJG4-KzOeVrose73hANvueP/exec',
]);
const SYNC_LOG_STORAGE_KEY = 'nodenote.cloudsync.logs.v1';
const MAX_SYNC_LOG_ENTRIES = 80;

function isEffectivelyEmptyDocument(document) {
  if (!isPlainObject(document)) {
    return true;
  }

  const nodes = isPlainObject(document.nodes) ? Object.keys(document.nodes) : [];
  const folders = isPlainObject(document.folders) ? Object.keys(document.folders) : [];
  const edges = Array.isArray(document.edges) ? document.edges : [];
  const assets = Array.isArray(document.assets) ? document.assets : [];
  const meta = isPlainObject(document.meta) ? document.meta : {};
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  const rootFolderId = typeof document.rootFolderId === 'string' && document.rootFolderId
    ? document.rootFolderId
    : 'folder_root';

  return (
    nodes.length === 0 &&
    edges.length === 0 &&
    assets.length === 0 &&
    folders.length === 1 &&
    folders[0] === rootFolderId &&
    (!title || title === 'Untitled')
  );
}

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
    this.workspaceLoadingOverlay = null;
    this.workspaceLoadingMessage = null;
    this.inputs = {};
    this.syncTimer = null;
    this.pollTimer = null;
    this.syncInFlight = false;
    this.sheetPollInFlight = false;
    this.pendingSnapshot = null;
    this.skipNextAutosave = false;
    this.sheetHydrationState = 'ready';
    this.cloudProjectDeleted = false;
    this.initialized = false;
    this.boundAutosave = this.handleAutosave.bind(this);
    this.sheetClientId = readOrCreateClientId();
    this.sheetBaselineDocument = null;
    this.sheetLastRevision = 0;
    this.sheetLastFingerprint = null;
    this.sheetProjectKeyHistory = this.loadSheetProjectKeyHistory();
    this.projectOverlay = null;
    this.projectPanel = null;
    this.projectRemoteProjectList = null;
    this.projectProjectNameInput = null;
    this.projectSelectedProjectKey = '';
    this.projectHint = null;
    this.sheetProjectCatalog = [];
    this.sheetProjectCatalogLoading = false;
    this.sheetProjectCatalogRequestId = 0;
    this.workspaceInteractionLocked = false;
    this.boundVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  init() {
    if (this.initialized) {
      return;
    }

    persistenceManager.setScopeKey(this.getWorkspaceScopeKey(this.config));
    this.toolbarButton = document.getElementById('btn-sync-now');
    this.statusBadge = document.getElementById('sync-status-badge');
    this.buildDialog();
    this.buildProjectDialog();
    this.buildWorkspaceLockOverlay();
    this.bindEvents();
    this.applyStateToUI();
    this.refreshTransportMode();
    this.appendSyncLog('info', 'init', '同步管理器啟動', '本機同步日誌已就緒');
    const storedSnapshot = persistenceManager.getStoredSnapshot();
    const shouldAutoRestore = this.isConfigReady()
      && !persistenceManager.wasRestored()
      && (
        this.config.restoreOnStartupWhenEmpty
        || !storedSnapshot
        || isEffectivelyEmptyDocument(storedSnapshot.document)
      );

    if (shouldAutoRestore) {
      this.sheetHydrationState = 'pending';
      queueMicrotask(() => {
        this.pullNow({
          skipConfirm: true,
          silentOnMissing: true,
          preferRemote: true,
          hydrateViewport: true,
        });
      });
    } else if (this.config.provider === 'sheets' && this.isConfigReady()) {
      this.sheetHydrationState = 'ready';
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
      autoSync: false,
      restoreOnStartupWhenEmpty: false,
      sheetWebAppUrl: DEFAULT_SHEET_WEB_APP_URL,
      sheetProjectKey: '',
      sheetProjectName: '',
      sheetClientName: 'NodeNote',
      sheetSecret: '',
      sheetPollIntervalMs: DEFAULT_SHEET_POLL_MS,
    };

    try {
      const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (!raw) {
        const next = { ...defaults };
        if (next.provider === 'sheets') {
          next.sheetProjectKey = resolveSheetProjectKey(next, store.getDocumentSnapshot?.()?.meta?.title || 'project');
        }
        return next;
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
        if (!sanitizeString(next.sheetProjectName)) {
          next.sheetProjectName = '';
        }
        if (!sanitizeString(next.sheetProjectKey)) {
          next.sheetProjectKey = resolveSheetProjectKey(next, store.getDocumentSnapshot?.()?.meta?.title || 'project');
        }
        if (!Number.isFinite(next.sheetPollIntervalMs) || next.sheetPollIntervalMs < DEFAULT_SHEET_POLL_MS) {
          next.sheetPollIntervalMs = DEFAULT_SHEET_POLL_MS;
        }
      }
      return next;
    } catch {
      const next = { ...defaults };
      if (next.provider === 'sheets') {
        next.sheetProjectKey = resolveSheetProjectKey(next, store.getDocumentSnapshot?.()?.meta?.title || 'project');
      }
      return next;
    }
  }

  saveConfig(config = this.config) {
    this.config = {
      ...this.config,
      ...(isPlainObject(config) ? config : {}),
    };

    if (this.config.provider === 'sheets' && !sanitizeString(this.config.sheetProjectKey)) {
      this.config.sheetProjectKey = resolveSheetProjectKey(
        this.config,
        store.getDocumentSnapshot?.()?.meta?.title || 'project'
      );
    }

    persistenceManager.setScopeKey(this.getWorkspaceScopeKey(this.config));

    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config));
    } catch (error) {
      console.warn('Cloud config save failed', error);
    }
  }

  loadState() {
    const defaults = {
      lastSyncedAt: null,
      lastEditedAt: null,
      lastError: null,
      lastRemoteSha: null,
      spreadsheetUrl: null,
      spreadsheetId: null,
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
      } else if (action === 'copy-diagnostic') {
        this.copyDiagnosticReportToClipboard();
      } else if (action === 'download-diagnostic') {
        this.downloadDiagnosticReport();
      } else if (action === 'copy-logs') {
        this.copySyncLogsToClipboard();
      } else if (action === 'clear-logs') {
        this.clearSyncLogs();
      } else if (action === 'close') {
        this.closeDialog();
      }
    });
  }

  loadSheetProjectKeyHistory() {
    try {
      const raw = localStorage.getItem(SHEET_PROJECT_KEY_HISTORY_STORAGE_KEY);
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((value) => sanitizeString(value))
        .filter(Boolean)
        .slice(0, 12);
    } catch {
      return [];
    }
  }

  saveSheetProjectKeyHistory() {
    try {
      localStorage.setItem(SHEET_PROJECT_KEY_HISTORY_STORAGE_KEY, JSON.stringify(this.sheetProjectKeyHistory.slice(0, 12)));
    } catch {
      // Ignore storage quota issues.
    }
  }

  rememberSheetProjectKey(projectKey) {
    const nextKey = sanitizeString(projectKey);
    if (!nextKey) {
      return;
    }

    this.sheetProjectKeyHistory = [
      nextKey,
      ...this.sheetProjectKeyHistory.filter((item) => item !== nextKey),
    ].slice(0, 12);
    this.saveSheetProjectKeyHistory();
    this.renderProjectKeyHistory();
  }

  getWorkspaceScopeKey(config = this.config) {
    const provider = sanitizeString(config?.provider, 'sheets');
    if (provider === 'sheets') {
      return `sheets:${resolveSheetProjectKey(config, store.getDocumentSnapshot?.()?.meta?.title || 'project')}`;
    }

    if (provider === 'github') {
      const owner = sanitizeString(config?.owner);
      const repo = sanitizeString(config?.repo);
      const branch = sanitizeString(config?.branch, 'master');
      const path = sanitizeString(config?.path, DEFAULT_SYNC_PATH);
      return `github:${owner}/${repo}/${branch}/${path}`;
    }

    return 'global';
  }

  resetSheetSyncContext() {
    this.sheetHydrationState = 'pending';
    this.cloudProjectDeleted = false;
    this.sheetBaselineDocument = null;
    this.sheetLastRevision = 0;
    this.sheetLastFingerprint = null;
    this.pendingSnapshot = null;
    this.skipNextAutosave = false;
    commitCloudSyncStatePatch(this, {
      lastRemoteRevision: 0,
      lastFingerprint: null,
      spreadsheetId: null,
      spreadsheetUrl: null,
      lastError: null,
    });
  }

  getGitHubProjectUrl() {
    const owner = sanitizeString(this.config.owner);
    const repo = sanitizeString(this.config.repo);
    const branch = sanitizeString(this.config.branch, 'master');
    const path = sanitizeString(this.config.path, DEFAULT_SYNC_PATH);

    if (!owner || !repo) {
      return '';
    }

    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    if (!encodedPath) {
      return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    }

    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(branch)}/${encodedPath}`;
  }

  getProjectUrl() {
    if (this.config.provider === 'sheets') {
      return sanitizeString(this.state.spreadsheetUrl || '');
    }

    if (this.config.provider === 'github') {
      return this.getGitHubProjectUrl();
    }

    return '';
  }

  openProject() {
    if (!this.projectOverlay) {
      this.buildProjectDialog();
    }

    this.fillProjectDialogFromConfig();
    this.updateProjectDialogStatus();
    this.renderSheetProjectCatalog();
    void this.loadSheetProjectCatalog({ force: true });

    if (this.projectOverlay) {
      this.projectOverlay.hidden = false;
    }

    this.projectProjectNameInput?.focus?.();
    this.projectProjectNameInput?.select?.();
    this.appendSyncLog('info', 'project', '開啟專案視窗');
    return true;
  }

  buildProjectDialog() {
    if (document.getElementById('cloud-project-modal')) {
      this.projectOverlay = document.getElementById('cloud-project-modal');
      this.projectPanel = this.projectOverlay?.querySelector?.('.cloud-project-panel') || null;
      this.projectProjectNameInput = this.projectOverlay?.querySelector?.('[data-project-field="sheetProjectName"]') || null;
      this.projectRemoteProjectList = this.projectOverlay?.querySelector?.('[data-project-remote-list]') || null;
      this.projectCatalogStatus = this.projectOverlay?.querySelector?.('[data-project-catalog-status]') || null;
      this.projectHint = this.projectOverlay?.querySelector?.('.cloud-project-status') || null;
      this.renderSheetProjectCatalog();
      return;
    }

    this.projectOverlay = document.createElement('div');
    this.projectOverlay.id = 'cloud-project-modal';
    this.projectOverlay.className = 'cloud-project-overlay';
    this.projectOverlay.hidden = true;
    this.projectOverlay.innerHTML = `
      <div class="cloud-project-panel glass-panel">
        <div class="cloud-project-header">
          <div>
            <h2>專案</h2>
            <p>輸入專案名稱，系統會自動生成專案鍵。</p>
          </div>
          <button type="button" class="cloud-project-close" data-project-action="close" aria-label="關閉專案視窗">×</button>
        </div>
        <div class="cloud-project-status" aria-live="polite">尚未選擇專案名稱。</div>
        <div class="cloud-project-catalog">
          <div class="cloud-project-catalog-header">
            <span>雲端專案</span>
            <button type="button" class="cloud-project-catalog-refresh" data-project-action="refresh-list">重新整理</button>
          </div>
          <div class="cloud-project-catalog-status" data-project-catalog-status>尚未載入雲端專案清單。</div>
          <div class="cloud-project-catalog-list" data-project-remote-list></div>
        </div>
        <div class="cloud-project-form">
          <label class="cloud-project-field cloud-project-field--wide">
            <span>專案名稱</span>
            <input type="text" data-project-field="sheetProjectName" autocomplete="off" placeholder="未命名專案" />
            <small>會顯示在雲端專案清單；可以留空，系統會使用目前文件標題自動生成專案鍵。</small>
          </label>
        </div>
        <div class="cloud-project-actions">
          <button type="button" data-project-action="open">開啟選取專案</button>
          <button type="button" data-project-action="create">建立新專案</button>
          <button type="button" class="cloud-project-danger" data-project-action="delete">刪除雲端資料</button>
          <button type="button" data-project-action="close">關閉</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.projectOverlay);
    this.projectPanel = this.projectOverlay.querySelector('.cloud-project-panel');
    this.projectProjectNameInput = this.projectOverlay.querySelector('[data-project-field="sheetProjectName"]');
    this.projectRemoteProjectList = this.projectOverlay.querySelector('[data-project-remote-list]');
    this.projectCatalogStatus = this.projectOverlay.querySelector('[data-project-catalog-status]');
    this.projectHint = this.projectOverlay.querySelector('.cloud-project-status');
    this.projectOverlay.addEventListener('click', (event) => {
      if (event.target === this.projectOverlay) {
        this.closeProjectDialog();
      }
    });
    this.projectPanel?.addEventListener('click', (event) => {
      const actionButton = event.target.closest?.('[data-project-action]');
      if (!actionButton) {
        return;
      }

      const action = actionButton.dataset.projectAction;
      if (action === 'open') {
        this.applyProjectSelection();
      } else if (action === 'create') {
        this.createProjectSelection();
      } else if (action === 'delete') {
        this.deleteCloudProjectSelection();
      } else if (action === 'refresh-list') {
        void this.loadSheetProjectCatalog({ force: true });
      } else if (action === 'close') {
        this.closeProjectDialog();
      } else if (action === 'select-project') {
        const projectKey = sanitizeString(actionButton.dataset.projectKey, 'default');
        if (projectKey) {
          const selectedProject = this.sheetProjectCatalog.find((project) => project.projectKey === projectKey) || null;
          this.projectSelectedProjectKey = projectKey;
          if (this.projectProjectNameInput && selectedProject) {
            this.projectProjectNameInput.value = selectedProject.projectName || selectedProject.title || '';
          }
          this.config = {
            ...this.config,
            sheetProjectKey: projectKey,
          };
          this.updateProjectDialogStatus();
          this.renderSheetProjectCatalog();
        }
      }
    });
    this.projectProjectNameInput?.addEventListener('input', () => {
      this.updateProjectDialogStatus();
    });
    this.projectProjectNameInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.createProjectSelection();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeProjectDialog();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.projectOverlay && !this.projectOverlay.hidden) {
        this.closeProjectDialog();
      }
    });
    this.renderSheetProjectCatalog();
  }

  buildWorkspaceLockOverlay() {
    if (document.getElementById('workspace-loading-overlay')) {
      this.workspaceLoadingOverlay = document.getElementById('workspace-loading-overlay');
      this.workspaceLoadingMessage = this.workspaceLoadingOverlay?.querySelector?.('[data-workspace-loading-message]') || null;
      return;
    }

    this.workspaceLoadingOverlay = document.createElement('div');
    this.workspaceLoadingOverlay.id = 'workspace-loading-overlay';
    this.workspaceLoadingOverlay.className = 'workspace-loading-overlay';
    this.workspaceLoadingOverlay.hidden = true;
    this.workspaceLoadingOverlay.innerHTML = `
      <div class="workspace-loading-panel glass-panel" role="status" aria-live="polite" aria-busy="true">
        <div class="workspace-loading-spinner" aria-hidden="true"></div>
        <div class="workspace-loading-copy">
          <strong class="workspace-loading-title">正在讀取專案</strong>
          <div class="workspace-loading-message" data-workspace-loading-message>請稍候，白板讀取完成前已鎖定。</div>
        </div>
      </div>
    `;
    document.body.appendChild(this.workspaceLoadingOverlay);
    this.workspaceLoadingMessage = this.workspaceLoadingOverlay.querySelector('[data-workspace-loading-message]');
  }

  setWorkspaceLoadingOverlay(isLocked, message = '') {
    this.workspaceInteractionLocked = Boolean(isLocked);
    if (this.workspaceLoadingOverlay) {
      this.workspaceLoadingOverlay.hidden = !isLocked;
    }
    if (this.workspaceLoadingMessage) {
      this.workspaceLoadingMessage.textContent = message || '請稍候，白板讀取完成前已鎖定。';
    }
    document.body.classList.toggle('is-workspace-locked', Boolean(isLocked));
  }

  isWorkspaceLoadingLocked() {
    return Boolean(this.workspaceInteractionLocked);
  }

  closeProjectDialog() {
    if (this.projectOverlay) {
      this.projectOverlay.hidden = true;
    }
  }

  fillProjectDialogFromConfig() {
    if (this.projectProjectNameInput) {
      const fallbackTitle = store.getDocumentSnapshot?.()?.meta?.title || '';
      this.projectProjectNameInput.value = sanitizeString(this.config.sheetProjectName, '') || sanitizeString(fallbackTitle, '');
    }
    this.projectSelectedProjectKey = sanitizeString(this.config.sheetProjectKey, '') || resolveSheetProjectKey(
      this.config,
      store.getDocumentSnapshot?.()?.meta?.title || 'project'
    );
  }

  updateProjectDialogStatus() {
    if (!this.projectHint) {
      return;
    }

    if (this.sheetHydrationState === 'deleted') {
      this.projectHint.textContent = '目前雲端資料已刪除，請建立新專案或切換到其他專案。';
      return;
    }

    const projectName = sanitizeString(this.projectProjectNameInput?.value || this.config.sheetProjectName || store.getDocumentSnapshot?.()?.meta?.title || '', '');
    const projectKey = sanitizeString(
      this.projectSelectedProjectKey || this.config.sheetProjectKey || resolveSheetProjectKey({ sheetProjectName: projectName }, projectName || 'project'),
      'default'
    );
    if (this.config.provider === 'sheets') {
      this.projectHint.textContent = `目前使用 Google Sheet 共編，專案名稱：${projectName || '未命名專案'}，專案鍵會自動生成：${projectKey}`;
      return;
    }

    this.projectHint.textContent = `目前不是 Google Sheet 共編模式，但仍可先保存專案名稱：${projectName || '未命名專案'}，專案鍵會自動生成：${projectKey}`;
  }

  normalizeSheetProjectCatalog(response) {
    if (!isPlainObject(response)) {
      return [];
    }

    const projects = Array.isArray(response.projects) ? response.projects : [];
    return projects
      .map((project) => {
        if (!isPlainObject(project)) {
          return null;
        }

        const projectKey = sanitizeString(project.projectKey, '');
        if (!projectKey) {
          return null;
        }

        return {
          projectKey,
          title: sanitizeString(project.title, projectKey) || projectKey,
          projectName: sanitizeString(project.projectName, '') || sanitizeString(project.title, projectKey) || projectKey,
          revision: Number.parseInt(project.revision || '0', 10) || 0,
          updatedAt: sanitizeString(project.updatedAt) || null,
          rootFolderId: sanitizeString(project.rootFolderId, 'folder_root') || 'folder_root',
          nodeCount: Number.parseInt(project.nodeCount || '0', 10) || 0,
          folderCount: Number.parseInt(project.folderCount || '0', 10) || 0,
          assetCount: Number.parseInt(project.assetCount || '0', 10) || 0,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftTime = Date.parse(left.updatedAt || '') || 0;
        const rightTime = Date.parse(right.updatedAt || '') || 0;
        if (rightTime !== leftTime) {
          return rightTime - leftTime;
        }
        return left.projectKey.localeCompare(right.projectKey);
      });
  }

  renderSheetProjectCatalog() {
    if (!this.projectRemoteProjectList) {
      return;
    }

    const currentProjectKey = sanitizeString(
      this.projectSelectedProjectKey || this.config.sheetProjectKey || resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
      'default'
    );
    const projects = Array.isArray(this.sheetProjectCatalog) ? this.sheetProjectCatalog : [];
    const hasCurrentProject = projects.some((project) => project.projectKey === currentProjectKey);
    const effectiveProjectKey = hasCurrentProject
      ? currentProjectKey
      : sanitizeString(projects[0]?.projectKey, '');
    if (!hasCurrentProject && effectiveProjectKey) {
      this.projectSelectedProjectKey = effectiveProjectKey;
    }

    if (this.projectCatalogStatus) {
      if (this.sheetProjectCatalogLoading) {
        this.projectCatalogStatus.textContent = '正在載入雲端專案清單...';
      } else if (projects.length) {
        this.projectCatalogStatus.textContent = `已載入 ${projects.length} 個雲端專案。點一下可選取專案。`;
      } else {
        this.projectCatalogStatus.textContent = '找不到雲端專案清單，仍可建立新專案。';
      }
    }

    if (!projects.length) {
      this.projectRemoteProjectList.innerHTML = `
        <div class="cloud-project-catalog-empty">
          ${this.sheetProjectCatalogLoading ? '載入中...' : '目前沒有可選的雲端專案。'}
        </div>
      `;
      return;
    }

    this.projectRemoteProjectList.innerHTML = projects.map((project) => {
      const selected = project.projectKey === (effectiveProjectKey || currentProjectKey) ? ' is-active' : '';
      const updatedAt = project.updatedAt ? formatClockStamp(project.updatedAt) : '未記錄';
      const projectName = project.projectName || project.title || project.projectKey;
      return `
        <button type="button" class="cloud-project-catalog-item${selected}" data-project-action="select-project" data-project-key="${escapeHtml(project.projectKey)}">
          <strong>${escapeHtml(projectName)}</strong>
          <span>${escapeHtml(project.projectKey)}</span>
          <small>revision ${escapeHtml(String(project.revision || 0))} · ${escapeHtml(updatedAt)}</small>
      </button>
      `;
    }).join('');

    if (!this.projectSelectedProjectKey && projects[0]) {
      this.projectSelectedProjectKey = projects[0].projectKey;
    }
  }

  async loadSheetProjectCatalog({ force = false } = {}) {
    if (this.sheetProjectCatalogLoading && !force) {
      return this.sheetProjectCatalog;
    }

    if (this.config.provider !== 'sheets' || !this.isConfigReady()) {
      this.sheetProjectCatalog = [];
      this.sheetProjectCatalogLoading = false;
      this.renderSheetProjectCatalog();
      return [];
    }

    const requestId = ++this.sheetProjectCatalogRequestId;
    this.sheetProjectCatalogLoading = true;
    this.renderSheetProjectCatalog();

    try {
      const response = await requestJsonp(buildSheetRequestUrl({
        baseUrl: this.config.sheetWebAppUrl,
        action: 'projects',
        projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
        clientId: this.sheetClientId,
        secret: this.config.sheetSecret,
      }));
      if (requestId !== this.sheetProjectCatalogRequestId) {
        return this.sheetProjectCatalog;
      }

      this.sheetProjectCatalog = this.normalizeSheetProjectCatalog(response);
      this.renderSheetProjectCatalog();
      return this.sheetProjectCatalog;
    } catch (error) {
      if (requestId === this.sheetProjectCatalogRequestId) {
        this.sheetProjectCatalog = [];
        this.renderSheetProjectCatalog();
      }
      this.appendSyncLog('error', 'project', '載入雲端專案清單失敗', error?.message || '未知錯誤');
      return [];
    } finally {
      if (requestId === this.sheetProjectCatalogRequestId) {
        this.sheetProjectCatalogLoading = false;
        this.renderSheetProjectCatalog();
      }
    }
  }

  renderProjectKeyHistory() {
    // Legacy no-op: project keys are generated automatically now.
  }

  async applyProjectSelection() {
    const nextProjectName = sanitizeString(this.projectProjectNameInput?.value || this.config.sheetProjectName || store.getDocumentSnapshot?.()?.meta?.title || '', '');
    const candidateProjectKey = sanitizeString(
      this.projectSelectedProjectKey || this.config.sheetProjectKey || this.sheetProjectCatalog?.[0]?.projectKey || '',
      ''
    );
    const nextProjectKey = candidateProjectKey;
    if (!nextProjectKey) {
      this.setStatus('error', '請先從雲端清單選取專案');
      this.appendSyncLog('error', 'project', '開啟專案失敗', '請先從雲端清單選取專案');
      return false;
    }

    this.rememberSheetProjectKey(nextProjectKey);
    this.config = {
      ...this.config,
      provider: 'sheets',
      sheetWebAppUrl: sanitizeString(this.config.sheetWebAppUrl) || DEFAULT_SHEET_WEB_APP_URL,
      sheetProjectKey: nextProjectKey,
      sheetProjectName: nextProjectName,
      sheetClientName: sanitizeString(this.config.sheetClientName, 'NodeNote'),
    };
    this.resetSheetSyncContext();
    this.saveConfig();
    persistenceManager.setScopeKey(this.getWorkspaceScopeKey(this.config));
    this.fillProjectDialogFromConfig();
    this.updateProjectDialogStatus();
    this.updateProviderPanels();
    this.refreshTransportMode();
    this.closeProjectDialog();
    this.setStatus('idle', `已切換專案：${nextProjectName || nextProjectKey}`);
    this.appendSyncLog('info', 'project', '切換專案', `projectKey=${nextProjectKey}`);
    const result = await this.pullNow({
      skipConfirm: true,
      silentOnMissing: true,
      preferRemote: true,
      hydrateViewport: true,
      lockWorkspace: true,
    });
    void this.loadSheetProjectCatalog({ force: true });
    return result;
  }

  async createProjectSelection() {
    const fallbackProjectName = sanitizeString(store.getDocumentSnapshot?.()?.meta?.title || '未命名專案', '') || '未命名專案';
    const nextProjectName = sanitizeString(this.projectProjectNameInput?.value || this.config.sheetProjectName || fallbackProjectName, '') || fallbackProjectName;
    const nextProjectKey = resolveSheetProjectKey({ sheetProjectName: nextProjectName }, nextProjectName || 'project');

    this.rememberSheetProjectKey(nextProjectKey);
    this.projectSelectedProjectKey = nextProjectKey;
    this.config = {
      ...this.config,
      provider: 'sheets',
      sheetWebAppUrl: sanitizeString(this.config.sheetWebAppUrl) || DEFAULT_SHEET_WEB_APP_URL,
      sheetProjectKey: nextProjectKey,
      sheetProjectName: nextProjectName,
      sheetClientName: sanitizeString(this.config.sheetClientName, 'NodeNote'),
    };
    this.resetSheetSyncContext();
    this.sheetHydrationState = 'ready';
    this.saveConfig();
    this.fillProjectDialogFromConfig();
    this.updateProjectDialogStatus();
    this.updateProviderPanels();
    this.refreshTransportMode();
    this.closeProjectDialog();
    this.setStatus('idle', `已建立新專案：${nextProjectName || nextProjectKey}`);
    this.appendSyncLog('info', 'project', '建立新專案', `projectKey=${nextProjectKey}`);
    const result = await this.syncNow({ force: true });
    void this.loadSheetProjectCatalog({ force: true });
    return result;
  }

  async deleteCloudProjectSelection() {
    const projectKey = sanitizeString(
      this.projectSelectedProjectKey || this.config.sheetProjectKey || this.sheetProjectCatalog?.[0]?.projectKey || '',
      'default'
    );
    const projectName = sanitizeString(
      this.projectProjectNameInput?.value || this.config.sheetProjectName || store.getDocumentSnapshot?.()?.meta?.title || projectKey,
      ''
    );

    if (!projectKey) {
      this.setStatus('error', '請先從清單選取專案');
      this.appendSyncLog('error', 'project', '刪除雲端資料失敗', '請先從清單選取專案');
      return false;
    }

    const confirmedKey = window.prompt(`確定刪除雲端資料，請輸入專案鍵：${projectKey}`, projectKey);
    if (sanitizeString(confirmedKey, '') !== projectKey) {
      this.appendSyncLog('info', 'project', '刪除雲端資料已取消', `projectKey=${projectKey}`);
      return false;
    }

    this.syncInFlight = true;
    this.updateStatusBadge('Deleting cloud project...');
    this.updateDialogStatus('正在刪除雲端資料...');
    this.appendSyncLog('info', 'project', '刪除雲端資料', `projectKey=${projectKey}`);

    try {
      if (this.config.provider === 'github') {
        await deleteGitHubSnapshot({
          owner: this.config.owner,
          repo: this.config.repo,
          path: this.config.path,
          token: this.config.token,
          branch: this.config.branch,
        });
      } else {
        const response = await requestJsonp(buildSheetRequestUrl({
          baseUrl: this.config.sheetWebAppUrl,
          action: 'delete-project',
          projectKey,
          clientId: this.sheetClientId,
          secret: this.config.sheetSecret,
        }));

        if (response?.ok === false) {
          throw new Error(response.error || '刪除雲端資料失敗');
        }
      }

      this.resetSheetSyncContext();
      this.sheetHydrationState = 'deleted';
      this.cloudProjectDeleted = true;
      this.sheetBaselineDocument = null;
      this.sheetLastRevision = 0;
      this.sheetLastFingerprint = null;
      this.saveConfig({
        ...this.config,
        sheetProjectName: '',
      });
      this.fillProjectDialogFromConfig();
      this.updateProjectDialogStatus();
      this.updateProviderPanels();
      this.refreshTransportMode();
      this.setStatus('idle', `已刪除雲端資料：${projectName || projectKey}`);
      this.appendSyncLog('info', 'project', '刪除雲端資料完成', `projectKey=${projectKey}`);
      void this.loadSheetProjectCatalog({ force: true });
      return true;
    } catch (error) {
      this.setStatus('error', '刪除雲端資料失敗');
      this.appendSyncLog('error', 'project', '刪除雲端資料失敗', this.getErrorMessage(error));
      return false;
    } finally {
      this.syncInFlight = false;
      this.updateStatusBadge();
      this.updateDialogStatus();
    }
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
            <h2>雲端同步</h2>
            <p>GitHub 用最新快照備份，Google Sheet 用近即時共編。</p>
          </div>
          <button type="button" class="cloud-sync-close" data-cloud-action="close" aria-label="關閉雲端同步">×</button>
        </div>
        <div class="cloud-sync-status" aria-live="polite">尚未設定雲端同步。</div>
        <div class="cloud-sync-form">
          <label class="cloud-sync-field">
            <span>同步來源</span>
            <select data-cloud-field="provider">
              <option value="github">GitHub 備份</option>
              <option value="sheets">Google Sheet 共編</option>
            </select>
          </label>
          <section class="cloud-sync-provider-group" data-provider-panel="github">
            <div class="cloud-sync-grid">
              <label class="cloud-sync-field">
                <span>擁有者</span>
                <input type="text" data-cloud-field="owner" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>儲存庫</span>
                <input type="text" data-cloud-field="repo" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>分支</span>
                <input type="text" data-cloud-field="branch" autocomplete="off" />
              </label>
              <label class="cloud-sync-field cloud-sync-field--wide">
                <span>路徑</span>
                <input type="text" data-cloud-field="path" autocomplete="off" />
              </label>
              <label class="cloud-sync-field cloud-sync-field--wide">
                <span>GitHub 權杖</span>
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
                <span>Web App 網址</span>
                <input type="text" data-cloud-field="sheetWebAppUrl" autocomplete="off" placeholder="https://script.google.com/macros/s/..." />
              </label>
              <label class="cloud-sync-field">
                <span>裝置名稱</span>
                <input type="text" data-cloud-field="sheetClientName" autocomplete="off" placeholder="Alice" />
              </label>
              <label class="cloud-sync-field">
                <span>密鑰</span>
                <input type="password" data-cloud-field="sheetSecret" autocomplete="off" />
              </label>
              <label class="cloud-sync-field">
                <span>輪詢間隔（毫秒）</span>
                <input type="number" min="1000" step="250" data-cloud-field="sheetPollIntervalMs" autocomplete="off" />
              </label>
            </div>
          </section>
          <label class="cloud-sync-toggle">
            <input type="checkbox" data-cloud-field="autoSync" />
            <span>自動存檔最新快照</span>
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
            <button type="button" data-cloud-action="copy-diagnostic">複製診斷</button>
            <button type="button" data-cloud-action="download-diagnostic">下載診斷檔</button>
            <button type="button" data-cloud-action="copy-logs">複製日誌</button>
            <button type="button" data-cloud-action="clear-logs">清空日誌</button>
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
      sheetClientName: sanitizeString(this.inputs.sheetClientName?.value),
      sheetSecret: sanitizeString(this.inputs.sheetSecret?.value),
      sheetPollIntervalMs: Number.isFinite(Number(this.inputs.sheetPollIntervalMs?.value))
        ? Math.max(1000, Number(this.inputs.sheetPollIntervalMs?.value))
        : DEFAULT_SHEET_POLL_MS,
    };
  }

  isConfigReady() {
    if (this.config.provider === 'sheets') {
      return Boolean(this.config.sheetWebAppUrl && resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'));
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

  buildDiagnosticReport() {
    const buildVersion = sanitizeString(
      document.getElementById('diag-version')?.textContent
      || document.getElementById('build-badge')?.textContent
      || ''
    );
    const projectCatalog = Array.isArray(this.sheetProjectCatalog)
      ? this.sheetProjectCatalog.map((project) => ({
        projectKey: project?.projectKey || '',
        projectName: project?.projectName || '',
        title: project?.title || '',
        revision: project?.revision || 0,
        updatedAt: project?.updatedAt || '',
        nodeCount: project?.nodeCount || 0,
        folderCount: project?.folderCount || 0,
        assetCount: project?.assetCount || 0,
      }))
      : [];

    const recentLogs = this.logEntries.slice(-25).map((entry) => ({
      timestamp: entry?.timestamp || '',
      level: entry?.level || '',
      scope: entry?.scope || '',
      title: entry?.title || '',
      message: entry?.message || '',
      detail: entry?.detail || '',
      context: entry?.context || null,
    }));

    return JSON.stringify({
      generatedAt: new Date().toISOString(),
      buildVersion,
      href: typeof window !== 'undefined' ? window.location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      config: {
        provider: this.config.provider || '',
        sheetWebAppUrl: this.config.sheetWebAppUrl || '',
        sheetProjectKey: this.config.sheetProjectKey || '',
        sheetProjectName: this.config.sheetProjectName || '',
        sheetClientName: this.config.sheetClientName || '',
        autoSync: Boolean(this.config.autoSync),
        restoreOnStartupWhenEmpty: Boolean(this.config.restoreOnStartupWhenEmpty),
        sheetHydrationState: this.sheetHydrationState,
        cloudProjectDeleted: Boolean(this.cloudProjectDeleted),
      },
      state: {
        status: this.state?.status || '',
        lastError: this.state?.lastError || '',
        lastSyncedAt: this.state?.lastSyncedAt || '',
        lastRemoteRevision: this.state?.lastRemoteRevision || 0,
        lastRemoteSha: this.state?.lastRemoteSha || '',
      },
      project: {
        selectedProjectKey: this.projectSelectedProjectKey || '',
        selectedProjectName: sanitizeString(this.projectProjectNameInput?.value || this.config.sheetProjectName || ''),
        catalogLoading: Boolean(this.sheetProjectCatalogLoading),
        catalogSize: projectCatalog.length,
        catalog: projectCatalog,
      },
      logs: recentLogs,
    }, null, 2);
  }

  downloadTextFile(filename, text, mimeType = 'application/json;charset=utf-8') {
    const safeName = sanitizeString(filename, 'diagnostic.json') || 'diagnostic.json';
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  downloadDiagnosticReport() {
    const text = this.buildDiagnosticReport();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const projectPart = sanitizeString(this.projectSelectedProjectKey || this.config.sheetProjectKey || 'project', 'project') || 'project';
    this.downloadTextFile(`nodenote-diagnostic-${projectPart}-${stamp}.json`, text);
    this.setStatus('idle', '診斷檔已下載');
    this.appendSyncLog('info', 'log', '下載診斷檔');
  }

  async copyDiagnosticReportToClipboard() {
    const text = this.buildDiagnosticReport();
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
      this.setStatus('idle', '診斷資料已複製');
      this.appendSyncLog('info', 'log', '複製診斷資料');
      return true;
    } catch (error) {
      this.setStatus('error', '複製診斷失敗');
      this.appendSyncLog('error', 'log', '複製診斷資料失敗', this.getErrorMessage(error));
      return false;
    }
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
    if (this.config.provider === 'sheets' && this.isConfigReady() && !this.cloudProjectDeleted && this.sheetHydrationState !== 'deleted' && !document.hidden) {
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

    if (this.config.provider !== 'sheets' || !this.isConfigReady() || this.sheetHydrationState === 'deleted' || this.cloudProjectDeleted) {
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
    return this.config.provider === 'sheets' ? '存檔' : '備份';
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

    if (this.sheetHydrationState === 'deleted' || this.cloudProjectDeleted) {
      this.setStatus('idle', '雲端資料已刪除');
      this.appendSyncLog('info', 'sheet', '略過同步', '雲端資料已刪除，請先建立或開啟專案');
      return false;
    }

    if (this.sheetHydrationState === 'pending') {
      this.setStatus('idle', '等待 Google Sheet 初始內容');
      this.appendSyncLog('info', 'sheet', '暫停同步', '等待 Google Sheet 初始內容完成');
      return false;
    }

    const currentDocument = snapshot?.document ? snapshot.document : store.getDocumentSnapshot();
    if (isEffectivelyEmptyDocument(currentDocument)) {
      this.setStatus('idle', '空白內容暫不同步');
      this.appendSyncLog('info', 'sheet', '略過空白同步', '空白內容不會覆蓋 Google Sheet');
      return false;
    }

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
        projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
        projectName: sanitizeString(this.config.sheetProjectName || store.getDocumentSnapshot()?.meta?.title || this.config.sheetProjectKey, ''),
        clientId: this.sheetClientId,
        clientName: resolveSheetClientName(this.config, `NodeNote-${this.sheetClientId.slice(-4)}`),
        secret: this.config.sheetSecret,
        baseRevision: this.sheetLastRevision || 0,
        savedAt: snapshot?.savedAt || new Date().toISOString(),
        editedAt: snapshot?.editedAt || snapshot?.savedAt || new Date().toISOString(),
        version: CLOUD_SYNC_VERSION,
      });

        const requestUrl = buildSheetRequestUrl({
          baseUrl: this.config.sheetWebAppUrl,
          action: 'commit',
          projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
          clientId: this.sheetClientId,
          secret: this.config.sheetSecret,
        });

      await postNoCors(requestUrl, payload);

      this.sheetBaselineDocument = clone(currentDocument);
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint: buildDocumentFingerprint(currentDocument),
          syncedAt: snapshot?.editedAt || snapshot?.savedAt || new Date().toISOString(),
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
          projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
          clientId: this.sheetClientId,
          secret: this.config.sheetSecret,
          extraParams: {
          revision: this.sheetLastRevision || 0,
        },
      }));

      const { remoteDocument, remoteRevision, updatedAt, editedAt, spreadsheetId, spreadsheetUrl } = normalizeSheetResponse(response, {
        fallbackRevision: this.sheetLastRevision || 0,
      });

      commitCloudSyncStatePatch(this, buildCloudSyncSuccessPatch({
        spreadsheetId,
        spreadsheetUrl,
      }));

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
          syncedAt: editedAt || updatedAt || new Date().toISOString(),
          remoteRevision: this.sheetLastRevision,
          spreadsheetId,
          spreadsheetUrl,
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

    if (this.cloudProjectDeleted || this.sheetHydrationState === 'deleted') {
      return false;
    }

    if (this.sheetPollInFlight) {
      return false;
    }

    if (this.sheetHydrationState === 'pending') {
      return false;
    }

    this.sheetPollInFlight = true;
    this.updateStatusBadge('Sheet polling...');

    try {
        const response = await requestJsonp(buildSheetRequestUrl({
          baseUrl: this.config.sheetWebAppUrl,
          action: 'state',
          projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
          clientId: this.sheetClientId,
          secret: this.config.sheetSecret,
          extraParams: {
          revision: this.sheetLastRevision || 0,
        },
      }));

      const { remoteDocument, remoteRevision, updatedAt, editedAt, spreadsheetId, spreadsheetUrl, localPatch, mergedDocument, hasLocalChanges } =
        mergeSheetRemoteDocument({
          response,
          baselineDocument: this.sheetBaselineDocument || createDefaultDocument(),
          currentDocument: store.getDocumentSnapshot(),
        });

      commitCloudSyncStatePatch(this, buildCloudSyncSuccessPatch({
        spreadsheetId,
        spreadsheetUrl,
      }));

      if (!remoteDocument) {
        return false;
      }

      if (remoteRevision <= (this.sheetLastRevision || 0)) {
        this.updateStatusBadge();
        this.updateDialogStatus();
        return true;
      }

      const localSnapshot = persistenceManager.getStoredSnapshot();
      const localEditedAt = localSnapshot?.editedAt || localSnapshot?.savedAt || this.state.lastSyncedAt || null;
      const freshness = resolveCloudSyncFreshness({
        localEditedAt,
        remoteEditedAt: editedAt || updatedAt,
      });

      if (!freshness.shouldApplyRemote) {
        this.sheetLastRevision = remoteRevision;
        this.sheetBaselineDocument = clone(remoteDocument);
        finishCloudSyncIdle(this, {
          patch: {
            remoteRevision,
            syncedAt: editedAt || updatedAt || new Date().toISOString(),
            spreadsheetId,
            spreadsheetUrl,
          },
          statusMessage: '本機內容較新，保留本機版本',
          statusDetail: localEditedAt
            ? `本機 ${localEditedAt} / 雲端 ${editedAt || updatedAt || 'unknown'}`
            : `雲端 ${editedAt || updatedAt || 'unknown'}`,
          logScope: 'sheet-poll',
          logTitle: 'Google Sheet 輪詢保留本機版本',
          logDetail: `local=${localEditedAt || 'unknown'} remote=${editedAt || updatedAt || 'unknown'}`,
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
          spreadsheetId,
          spreadsheetUrl,
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
          spreadsheetId,
          spreadsheetUrl,
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

  async pullSheetNow({ skipConfirm = false, silentOnMissing = false, preferRemote = false, hydrateViewport = false, lockWorkspace = true } = {}) {
    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成 Google Sheet 設定');
      this.appendSyncLog('error', 'sheet-pull', 'Google Sheet 拉回失敗', '請先完成 Google Sheet 設定');
      return false;
    }

    if (this.sheetHydrationState === 'deleted' || this.cloudProjectDeleted) {
      this.setStatus('idle', '雲端資料已刪除');
      this.appendSyncLog('info', 'sheet-pull', '略過拉回', '雲端資料已刪除，請先建立或開啟專案');
      return false;
    }

    if (!skipConfirm && !window.confirm('Google Sheet 會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    if (lockWorkspace) {
      this.setWorkspaceLoadingOverlay(true, '正在讀取 Google Sheet 專案...');
    }
    this.syncInFlight = true;
    this.updateStatusBadge('Sheet pulling...');
    this.updateDialogStatus('正在從 Google Sheet 拉回內容...');
    this.appendSyncLog('info', 'sheet-pull', '開始從 Google Sheet 拉回內容');

    try {
        const response = await requestJsonp(buildSheetRequestUrl({
          baseUrl: this.config.sheetWebAppUrl,
          action: 'state',
          projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
          clientId: this.sheetClientId,
          secret: this.config.sheetSecret,
        }));

      const { remoteDocument, remoteRevision, updatedAt, editedAt, spreadsheetId, spreadsheetUrl, mergedDocument } = mergeSheetRemoteDocument({
        response,
        baselineDocument: this.sheetBaselineDocument || createDefaultDocument(),
        currentDocument: store.getDocumentSnapshot(),
        preferRemote,
      });

      commitCloudSyncStatePatch(this, buildCloudSyncSuccessPatch({
        spreadsheetId,
        spreadsheetUrl,
      }));

      if (!remoteDocument) {
        this.sheetHydrationState = 'missing';
        if (silentOnMissing) {
          this.setStatus('idle', 'Google Sheet 尚未有內容');
          this.appendSyncLog('info', 'sheet-pull', 'Google Sheet 尚無內容', '保留目前工作區');
          this.sheetHydrationState = 'ready';
          return false;
        }

        this.setStatus('error', 'Google Sheet 沒有找到內容，請先完成一次同步');
        this.appendSyncLog('error', 'sheet-pull', 'Google Sheet 拉回失敗', 'Google Sheet 沒有找到內容，請先完成一次同步');
        this.sheetHydrationState = 'ready';
        return false;
      }

      const localSnapshot = persistenceManager.getStoredSnapshot();
      const localEditedAt = localSnapshot?.editedAt || localSnapshot?.savedAt || this.state.lastSyncedAt || null;
      const freshness = preferRemote
        ? { shouldApplyRemote: true, winner: 'remote' }
        : resolveCloudSyncFreshness({
            localEditedAt,
            remoteEditedAt: editedAt || updatedAt,
          });

      if (!freshness.shouldApplyRemote) {
        this.sheetBaselineDocument = clone(remoteDocument);
        this.sheetLastRevision = remoteRevision;
        finishCloudSyncIdle(this, {
          patch: {
            remoteRevision: this.sheetLastRevision,
            spreadsheetId,
            spreadsheetUrl,
          },
          statusMessage: '本機內容較新，保留本機版本',
          statusDetail: localEditedAt
            ? `本機 ${localEditedAt} / 雲端 ${editedAt || updatedAt || 'unknown'}`
            : `雲端 ${editedAt || updatedAt || 'unknown'}`,
          logScope: 'sheet-pull',
          logTitle: 'Google Sheet 拉回保留本機版本',
          logDetail: `local=${localEditedAt || 'unknown'} remote=${editedAt || updatedAt || 'unknown'}`,
          logContext: {
            revision: remoteRevision,
            winner: freshness.winner,
          },
        });
        this.sheetHydrationState = 'ready';
        return true;
      }

      const previousPath = store.getCurrentDocumentPath();
      this.skipNextAutosave = true;
      store.replaceDocument(mergedDocument, { resetHistory: true, saveToHistory: false });
      if (previousPath.length) {
        store.restoreNavigation({ path: previousPath, viewportStack: [] });
      }
      if (hydrateViewport || preferRemote) {
        renderer.fitGraphToViewport();
      }
      renderer.renderAll();

      this.sheetBaselineDocument = clone(remoteDocument);
      this.sheetLastRevision = remoteRevision;
      finishCloudSyncSuccess(this, {
        patch: {
          remoteRevision: this.sheetLastRevision,
          fingerprint: buildDocumentFingerprint(mergedDocument),
          syncedAt: editedAt || updatedAt || new Date().toISOString(),
          spreadsheetId,
          spreadsheetUrl,
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
      if (lockWorkspace) {
        this.setWorkspaceLoadingOverlay(false);
      }
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
      projectKey: resolveSheetProjectKey(this.config, store.getDocumentSnapshot?.()?.meta?.title || 'project'),
      document: store.getDocumentSnapshot(),
    };
  }

  handleAutosave(snapshot) {
    if (!snapshot || this.skipNextAutosave) {
      this.skipNextAutosave = false;
      return;
    }

    if (this.workspaceInteractionLocked) {
      return;
    }

    if (!this.config.autoSync || !this.isConfigReady()) {
      this.updateStatusBadge();
      return;
    }

    if (this.config.provider === 'sheets') {
      if (this.sheetHydrationState === 'pending') {
        this.updateStatusBadge('Sheet hydrate...');
        this.updateDialogStatus('正在等待 Google Sheet 初始內容...');
        return;
      }

      if (isEffectivelyEmptyDocument(snapshot.document)) {
        this.updateStatusBadge('Sheet idle');
        return;
      }
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

  armAutoSyncForThisDevice() {
    if (this.config.autoSync) {
      return false;
    }

    this.saveConfig({
      autoSync: true,
    });
    this.updateStatusBadge();
    this.updateDialogStatus();
    this.appendSyncLog('info', 'cloud', '已啟用自動存檔', '這台裝置之後會自動送出雲端快照');
    return true;
  }

  async syncNow({ force = false, armAutoSync = false } = {}) {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }

    if (armAutoSync) {
      this.armAutoSyncForThisDevice();
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
    const synced = await this.syncNow({ force, armAutoSync: true });
    if (!synced) {
      return false;
    }

    return this.verifySheetUpload();
  }

  async pushSnapshot(snapshot, { force = false } = {}) {
    if (this.cloudProjectDeleted) {
      this.setStatus('idle', '雲端資料已刪除');
      this.appendSyncLog('info', 'cloud', '略過同步', '雲端資料已刪除，請先建立或開啟專案');
      return false;
    }

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

  async pullNow({ skipConfirm = false, silentOnMissing = false, preferRemote = false, hydrateViewport = false, lockWorkspace = true } = {}) {
    if (this.cloudProjectDeleted) {
      this.setStatus('idle', '雲端資料已刪除');
      this.appendSyncLog('info', 'cloud-pull', '略過拉回', '雲端資料已刪除，請先建立或開啟專案');
      return false;
    }

    if (this.config.provider === 'sheets') {
      return this.pullSheetNow({ skipConfirm, silentOnMissing, preferRemote, hydrateViewport, lockWorkspace });
    }

    if (!this.isConfigReady()) {
      this.setStatus('error', '請先完成雲端設定');
      this.appendSyncLog('error', 'github-pull', 'GitHub 拉回失敗', '請先完成雲端設定');
      return false;
    }

    if (!skipConfirm && !window.confirm('雲端快照會覆蓋目前工作區，確定要拉回嗎？')) {
      return false;
    }

    if (lockWorkspace) {
      this.setWorkspaceLoadingOverlay(true, '正在讀取雲端快照...');
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

      const localSnapshot = persistenceManager.getStoredSnapshot();
      const localEditedAt = localSnapshot?.editedAt || localSnapshot?.savedAt || this.state.lastSyncedAt || null;
      const bootstrapHydration = this.sheetHydrationState === 'pending';
      const freshness = resolveCloudSyncFreshness({
        localEditedAt,
        remoteEditedAt: snapshot.editedAt || snapshot.savedAt,
      });

      if (!bootstrapHydration && !freshness.shouldApplyRemote) {
        this.setStatus(
          'idle',
          '本機內容較新，保留本機版本',
          localEditedAt
            ? `本機 ${localEditedAt} / 雲端 ${snapshot.editedAt || snapshot.savedAt || 'unknown'}`
            : `雲端 ${snapshot.editedAt || snapshot.savedAt || 'unknown'}`
        );
        this.appendSyncLog(
          'info',
          'github-pull',
          'GitHub 拉回保留本機版本',
          `local=${localEditedAt || 'unknown'} remote=${snapshot.editedAt || snapshot.savedAt || 'unknown'}`,
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

      if (hydrateViewport || preferRemote) {
        renderer.fitGraphToViewport();
      }

      renderer.renderAll();
      this.sheetHydrationState = 'ready';

      const fingerprint = buildFingerprint(snapshot);
      finishCloudSyncSuccess(this, {
        patch: {
          fingerprint,
          remoteSha: remote.sha || null,
          syncedAt: snapshot.editedAt || snapshot.savedAt || new Date().toISOString(),
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
      if (lockWorkspace) {
        this.setWorkspaceLoadingOverlay(false);
      }
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
