import { renderer } from './Renderer.js';
import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import { trayManager } from './TrayManager.js';
import { cloudSyncManager } from './CloudSyncManager.js';
import { createDefaultDocument } from './core/documentSchema.js';
import {
  createDocumentFileName,
  downloadText,
  buildExportMappingWarning,
  normalizeImportedDocument,
  parseJsonText,
  serializeDocument,
} from './core/documentIO.js';
import { collectClipboardGraph } from './core/graphClipboard.js';

class ShortcutManager {
  constructor() {
    this.fileInput = null;
    this.boundKeydown = this.handleKeydown.bind(this);
    this.boundFileChange = this.handleFileChange.bind(this);
  }

  init() {
    if (!this.fileInput) {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.accept = 'application/json,.json';
      this.fileInput.style.position = 'fixed';
      this.fileInput.style.left = '-9999px';
      this.fileInput.style.top = '0';
      this.fileInput.tabIndex = -1;
      document.body.appendChild(this.fileInput);
      this.fileInput.addEventListener('change', this.boundFileChange);
    }

    window.addEventListener('keydown', this.boundKeydown);
  }

  isEditableTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(target.closest('input, textarea, [contenteditable="true"]'));
  }

  isMetaShortcut(event) {
    return event.ctrlKey || event.metaKey;
  }

  isZoomInShortcut(event) {
    return this.isMetaShortcut(event) && (
      event.key === '+' ||
      event.key === '=' ||
      event.code === 'Equal' ||
      event.code === 'NumpadAdd'
    );
  }

  isZoomOutShortcut(event) {
    return this.isMetaShortcut(event) && (
      event.key === '-' ||
      event.key === '_' ||
      event.code === 'Minus' ||
      event.code === 'NumpadSubtract'
    );
  }

  isZoomActualShortcut(event) {
    return this.isMetaShortcut(event) && event.key === '1';
  }

  isZoomFitShortcut(event) {
    return this.isMetaShortcut(event) && event.key === '0';
  }

  isSaveShortcut(event) {
    return this.isMetaShortcut(event) && event.key.toLowerCase() === 's' && !event.shiftKey;
  }

  isSaveAsShortcut(event) {
    return this.isMetaShortcut(event) && event.key.toLowerCase() === 's' && event.shiftKey;
  }

  handleKeydown(event) {
    if (cloudSyncManager.isWorkspaceLoadingLocked?.()) {
      event.preventDefault();
      return;
    }

    const key = event.key.toLowerCase();
    const isEditable = this.isEditableTarget(event.target);

    if (key === 'escape') {
      this.handleEscape();
      event.preventDefault();
      return;
    }

    if (this.isSaveShortcut(event)) {
      event.preventDefault();
      this.saveDocument();
      return;
    }

    if (this.isSaveAsShortcut(event)) {
      event.preventDefault();
      this.saveDocumentAs();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'n') {
      event.preventDefault();
      this.newDocument();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'o') {
      event.preventDefault();
      this.openDocument();
      return;
    }

    if (this.isZoomInShortcut(event)) {
      event.preventDefault();
      renderer.zoomViewportIn();
      return;
    }

    if (this.isZoomOutShortcut(event)) {
      event.preventDefault();
      renderer.zoomViewportOut();
      return;
    }

    if (this.isZoomFitShortcut(event)) {
      event.preventDefault();
      renderer.fitGraphToViewport();
      return;
    }

    if (this.isZoomActualShortcut(event)) {
      event.preventDefault();
      renderer.resetViewportToActualSize();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'f' && !isEditable) {
      event.preventDefault();
      this.findNode();
      return;
    }

    if (isEditable) {
      return;
    }

    if (this.isMetaShortcut(event) && key === 'g' && event.shiftKey) {
      event.preventDefault();
      nodeManager.ungroupSelectionFromFolder();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'g') {
      event.preventDefault();
      nodeManager.groupSelectionIntoFolder();
      return;
    }

    if ((this.isMetaShortcut(event) && event.code === 'BracketLeft') || (event.altKey && key === 'arrowleft')) {
      event.preventDefault();
      store.exitFolder();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      store.undo();
      return;
    }

    if ((this.isMetaShortcut(event) && key === 'y') || (this.isMetaShortcut(event) && key === 'z' && event.shiftKey)) {
      event.preventDefault();
      store.redo();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'a') {
      event.preventDefault();
      this.selectAllNodes();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'd') {
      event.preventDefault();
      this.duplicateSelection();
      return;
    }

    if (this.isMetaShortcut(event) && key === 'c') {
      if (trayManager.getSelectionRootNodeIds().length > 0) {
        event.preventDefault();
        trayManager.copySelectionToTray();
      }
      return;
    }

    if (this.isMetaShortcut(event) && key === 'x') {
      if (trayManager.getSelectionRootNodeIds().length > 0) {
        event.preventDefault();
        trayManager.copySelectionToTray({ cut: true });
      }
      return;
    }

    if (this.isMetaShortcut(event) && key === 'v') {
      event.preventDefault();
      trayManager.pasteFromClipboard();
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && trayManager.deleteSelection()) {
      event.preventDefault();
    }
  }

  handleEscape() {
    const popup = document.getElementById('naming-popup');
    if (popup) {
      popup.remove();
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
    }

    store.clearSelection();
  }

  selectAllNodes() {
    const nodeIds = Object.keys(store.state.nodes || {});
    store.setSelectionNodeIds(nodeIds);
  }

  duplicateSelection() {
    const rootNodeIds = trayManager.getSelectionRootNodeIds();
    if (!rootNodeIds.length) {
      return false;
    }

    const fragment = collectClipboardGraph(store.getCurrentDocumentSnapshot(), rootNodeIds);
    if (!fragment) {
      return false;
    }

    const anchorPoint = nodeManager.getPasteAnchorWorldPoint();
    const offsetAnchor = {
      x: anchorPoint.x + 56,
      y: anchorPoint.y + 56,
    };

    const materialized = nodeManager.insertFragment(fragment, offsetAnchor);
    return Boolean(materialized);
  }

  saveDocument() {
    const documentSnapshot = store.getDocumentSnapshot();
    const mappingWarning = buildExportMappingWarning(documentSnapshot);
    if (mappingWarning && !window.confirm(`${mappingWarning.message}\n\n要先檢查 / 映射這些 key 再匯出嗎？`)) {
      return;
    }

    const filename = createDocumentFileName(documentSnapshot);
    downloadText(serializeDocument(documentSnapshot), filename);
  }

  saveDocumentAs() {
    const documentSnapshot = store.getDocumentSnapshot();
    const mappingWarning = buildExportMappingWarning(documentSnapshot);
    if (mappingWarning && !window.confirm(`${mappingWarning.message}\n\n要先檢查 / 映射這些 key 再另存嗎？`)) {
      return;
    }

    const defaultName = createDocumentFileName(documentSnapshot).replace(/\.json$/i, '');
    const requested = window.prompt('輸入檔名', defaultName);
    if (requested === null) {
      return;
    }

    const trimmed = requested.trim();
    const filename = `${trimmed || defaultName}.json`;
    downloadText(serializeDocument(documentSnapshot), filename);
  }

  newDocument() {
    if (!window.confirm('建立新的空白筆記？目前內容會被清除。')) {
      return;
    }

    store.replaceDocument(createDefaultDocument(), { resetHistory: true, saveToHistory: false });
    store.setTransform(0, 0, 1);
    renderer.renderAll();
  }

  async openDocument() {
    if (!window.confirm('開啟 JSON 檔案？目前內容會被清除。')) {
      return;
    }

    this.fileInput?.click();
  }

  async handleFileChange() {
    const file = this.fileInput?.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = parseJsonText(text);
      const documentSnapshot = normalizeImportedDocument(parsed);
      if (!documentSnapshot) {
        window.alert('無法讀取這個檔案，請確認它是 NodeNote JSON。');
        return;
      }

      store.replaceDocument(documentSnapshot, { resetHistory: true, saveToHistory: false });
      store.setTransform(0, 0, 1);
      renderer.fitGraphToViewport();
      renderer.renderAll();
    } catch (error) {
      console.error('Failed to open document', error);
      window.alert(`開啟失敗：${error?.message || error}`);
    } finally {
      if (this.fileInput) {
        this.fileInput.value = '';
      }
    }
  }

  findNode() {
    const query = window.prompt('搜尋節點 id / 內容');
    if (!query) {
      return;
    }

    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return;
    }

    const nodes = Object.values(store.state.nodes || {});
    const found = nodes.find((node) => {
      const id = String(node.id || '').toLowerCase();
      const content = String(node.content || '').toLowerCase();
      const title = String(node.title || '').toLowerCase();
      return id.includes(normalized) || content.includes(normalized) || title.includes(normalized);
    });

    if (!found) {
      window.alert(`找不到符合「${query}」的節點。`);
      return;
    }

    store.setSelectionNodeIds([found.id]);
    store.setLastActiveNode(found.id);
    renderer.focusViewportOnLastActiveNode();
  }
}

export const shortcutManager = new ShortcutManager();
