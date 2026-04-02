import './style.css';
import { renderer } from './Renderer.js';
import { inputController } from './InputController.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { trayManager } from './TrayManager.js';
import { shortcutManager } from './ShortcutManager.js';
import { persistenceManager } from './PersistenceManager.js';
import { cloudSyncManager } from './CloudSyncManager.js';
import { store } from './StateStore.js';
import { getNodeNotePrompt } from './core/aiPrompt.js';

const sysDiag = document.getElementById('sys-diag');
const diagStatus = document.getElementById('diag-status');
const diagVersion = document.getElementById('diag-version');
const buildBadge = document.getElementById('build-badge');
const buildTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '';
const PROMPT_MODE_STORAGE_KEY = 'nodenote.prompt-mode';
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

async function copyTextToClipboard(text) {
  if (!text) {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    return Boolean(success);
  } catch (error) {
    console.warn('Clipboard copy failed', error);
    return false;
  }
}

// Init when DOM is fully parsed
const initApp = () => {
  try {
    updateDiag("Restoring autosave...");
    persistenceManager.init();

    updateDiag("Initializing CloudSyncManager...");
    cloudSyncManager.init();

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
    const folderBackBtn = document.getElementById('btn-folder-back');
    const aiPromptCopyBtn = document.getElementById('btn-ai-prompt-copy');
    const promptTemplateSelect = document.getElementById('prompt-template-select');
    const folderGroupBtn = document.getElementById('btn-folder-group');
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (promptTemplateSelect) {
      const savedMode = window.localStorage.getItem(PROMPT_MODE_STORAGE_KEY);
      if (savedMode) {
        promptTemplateSelect.value = savedMode;
      }
      promptTemplateSelect.onchange = () => {
        window.localStorage.setItem(PROMPT_MODE_STORAGE_KEY, promptTemplateSelect.value);
      };
    }
    if(folderBackBtn) folderBackBtn.onclick = () => store.exitFolder();
    if(aiPromptCopyBtn) aiPromptCopyBtn.onclick = async () => {
      const mode = promptTemplateSelect?.value || 'note';
      const copied = await copyTextToClipboard(getNodeNotePrompt(mode));
      if (copied) {
        aiPromptCopyBtn.textContent = '已複製';
        window.setTimeout(() => {
          aiPromptCopyBtn.textContent = '提詞複製';
        }, 1200);
      } else {
        window.alert('複製失敗，請檢查瀏覽器剪貼簿權限。');
      }
    };
    if(folderGroupBtn) folderGroupBtn.onclick = () => nodeManager.groupSelectionIntoFolder();
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
