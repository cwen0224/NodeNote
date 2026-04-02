import './style.css';
import { renderer } from './Renderer.js';
import { inputController } from './InputController.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { store } from './StateStore.js';

const diagStatus = document.getElementById('diag-status');
const diagVersion = document.getElementById('diag-version');
const buildTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '';
const updateDiag = (msg) => { if(diagStatus) diagStatus.innerText = "NodeNote: " + msg; };

// Set build timestamp
if(diagVersion) {
  const builtAt = buildTimestamp ? new Date(buildTimestamp) : null;
  diagVersion.innerText = builtAt && !Number.isNaN(builtAt.getTime())
    ? `Updated at ${builtAt.toLocaleString('zh-TW', { hour12: false })}`
    : 'Updated at build time';
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
    
    updateDiag("Wiring Toolbar...");
    // Wire Undo/Redo
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if(undoBtn) undoBtn.onclick = () => store.undo();
    if(redoBtn) redoBtn.onclick = () => store.redo();
    
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        store.undo();
      }
      if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        store.redo();
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
