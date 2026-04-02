import './style.css';
import { renderer } from './Renderer.js';
import { inputController } from './InputController.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { trayManager } from './TrayManager.js';
import { shortcutManager } from './ShortcutManager.js';
import { store } from './StateStore.js';

const sysDiag = document.getElementById('sys-diag');
const diagStatus = document.getElementById('diag-status');
const diagVersion = document.getElementById('diag-version');
const buildBadge = document.getElementById('build-badge');
const buildTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '';
const updateDiag = (msg) => {
  if (sysDiag) {
    sysDiag.classList.remove('is-hidden');
  }
  if (diagStatus) {
    diagStatus.innerText = "NodeNote: " + msg;
  }
};

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
if (buildBadge) {
  buildBadge.innerText = formatBuildStamp(buildTimestamp);
}

const collapseDiag = () => {
  if (sysDiag) {
    sysDiag.classList.add('is-hidden');
  }
};

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

    updateDiag("Initializing ShortcutManager...");
    shortcutManager.init();
    
    updateDiag("Wiring Toolbar...");
    // Wire Undo/Redo
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if(undoBtn) undoBtn.onclick = () => store.undo();
    if(redoBtn) redoBtn.onclick = () => store.redo();

    updateDiag("READY");
    collapseDiag();
    console.log("NodeNote initialized: All modules ready.");
  } catch (err) {
    if (sysDiag) {
      sysDiag.classList.remove('is-hidden');
    }
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
