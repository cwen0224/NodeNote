import './style.css';
import { renderer } from './Renderer.js';
import { inputController } from './InputController.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { trayManager } from './TrayManager.js';
import { store } from './StateStore.js';

const diagStatus = document.getElementById('diag-status');
const diagVersion = document.getElementById('diag-version');
const buildTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '';
const updateDiag = (msg) => { if(diagStatus) diagStatus.innerText = "NodeNote: " + msg; };

const formatBuildStamp = (isoString) => {
  const builtAt = isoString ? new Date(isoString) : null;
  if (!builtAt || Number.isNaN(builtAt.getTime())) {
    return 'v--:--';
  }

  const hours = String(builtAt.getHours()).padStart(2, '0');
  const minutes = String(builtAt.getMinutes()).padStart(2, '0');
  return `v${hours}:${minutes}`;
};

// Set build timestamp
if(diagVersion) {
  diagVersion.innerText = formatBuildStamp(buildTimestamp);
}

// Init when DOM is fully parsed
const initApp = () => {
  try {
    updateDiag("Initializing Renderer...");
    renderer.init();
    
    updateDiag("Initializing InputController...");
    inputController.init();
    
    updateDiag("Initializing NodeManager...");
    nodeManager.init();
    
    updateDiag("Initializing ConnectionManager...");
    connectionManager.init();

    updateDiag("Initializing TrayManager...");
    trayManager.init();
    
    updateDiag("Wiring Toolbar...");
    // Wire Undo/Redo
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if(undoBtn) undoBtn.onclick = () => store.undo();
    if(redoBtn) redoBtn.onclick = () => store.redo();

    const isTextEditingTarget = (target) => {
      if (!(target instanceof Element)) {
        return false;
      }

      return Boolean(target.closest('input, textarea, [contenteditable="true"]'));
    };
    
    window.addEventListener('keydown', (e) => {
      if (isTextEditingTarget(e.target)) {
        return;
      }

      const key = e.key.toLowerCase();
      const isMetaShortcut = e.ctrlKey || e.metaKey;

      if (isMetaShortcut && key === 'z') {
        e.preventDefault();
        store.undo();
        return;
      }

      if (isMetaShortcut && key === 'y') {
        e.preventDefault();
        store.redo();
        return;
      }

      if (isMetaShortcut && key === 'c') {
        if (trayManager.getSelectionRootNodeIds().length > 0) {
          e.preventDefault();
          trayManager.copySelectionToTray();
        }
        return;
      }

      if (isMetaShortcut && key === 'x') {
        if (trayManager.getSelectionRootNodeIds().length > 0) {
          e.preventDefault();
          trayManager.copySelectionToTray({ cut: true });
        }
        return;
      }

      if (isMetaShortcut && key === 'v') {
        e.preventDefault();
        trayManager.pasteFromClipboard();
        return;
      }

      if (e.key === 'Delete') {
        if (trayManager.deleteSelection()) {
          e.preventDefault();
        }
      }
    });

    updateDiag("READY: (Double-click to add node)");
    console.log("NodeNote initialized: All modules ready.");
  } catch (err) {
    updateDiag("INIT FAILED!");
    console.error("Init failed:", err);
    
    const errDiv = document.getElementById('diag-errors');
    if(errDiv) errDiv.innerHTML += `\n[INIT ERROR] ${err.message}\nStack: ${err.stack}`;
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

if (import.meta.env.DEV) {
  window.__NODENOTE_STORE__ = store;
}
