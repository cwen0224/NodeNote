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
import { registerPwa } from './pwa.js';

const sysDiag = document.getElementById('sys-diag');
const diagStatus = document.getElementById('diag-status');
const diagVersion = document.getElementById('diag-version');
const buildBadge = document.getElementById('build-badge');
const buildTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '';
const TRAY_DRAWER_STORAGE_KEY = 'nodenote.tray.drawer-open';
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

    updateDiag("Initializing Sync Manager...");
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
    const syncBtn = document.getElementById('btn-sync-now');
    const openProjectBtn = document.getElementById('btn-open-project');
    const aiPromptCopyBtn = document.getElementById('btn-ai-prompt-copy');
    const trayDrawer = document.getElementById('tray-drawer');
    const trayCloseBtn = document.getElementById('btn-tray-close');
    const folderGroupBtn = document.getElementById('btn-folder-group');
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    let trayHoverCloseTimer = 0;
    const clearTrayHoverCloseTimer = () => {
      if (trayHoverCloseTimer) {
        window.clearTimeout(trayHoverCloseTimer);
        trayHoverCloseTimer = 0;
      }
    };
    if(folderBackBtn) folderBackBtn.onclick = () => store.exitFolder();
    if (folderBackBtn) {
      folderBackBtn.textContent = '返回';
    }
    if (syncBtn) {
      syncBtn.textContent = '存檔';
      syncBtn.title = '存檔到雲端，第一次按下後會啟用自動存檔';
    }
    if (openProjectBtn) {
      openProjectBtn.textContent = '專案';
      openProjectBtn.title = '開啟專案選擇窗';
    }
    if (folderGroupBtn) {
      folderGroupBtn.textContent = '群組';
    }
    if (undoBtn) {
      undoBtn.textContent = '復原';
    }
    if (redoBtn) {
      redoBtn.textContent = '重做';
    }
    const setTrayDrawerOpen = (isOpen) => {
      if (!trayDrawer) {
        return;
      }
      clearTrayHoverCloseTimer();
      trayDrawer.classList.toggle('is-collapsed', !isOpen);
      if (trayCloseBtn) {
        trayCloseBtn.setAttribute('aria-expanded', String(isOpen));
      }
      window.localStorage.setItem(TRAY_DRAWER_STORAGE_KEY, isOpen ? '1' : '0');
    };
    if (trayDrawer) {
      const savedTrayState = window.localStorage.getItem(TRAY_DRAWER_STORAGE_KEY);
      setTrayDrawerOpen(savedTrayState !== '0');
      const hoverOpenThreshold = 24;
      const hoverCloseThreshold = 280;

      document.addEventListener('pointermove', (event) => {
        if (!trayDrawer) {
          return;
        }

        if (event.pointerType && event.pointerType !== 'mouse') {
          return;
        }

        const isCollapsed = trayDrawer.classList.contains('is-collapsed');
        const x = Number.isFinite(event.clientX) ? event.clientX : window.innerWidth;

        if (x <= hoverOpenThreshold) {
          setTrayDrawerOpen(true);
          return;
        }

        if (!isCollapsed && x > hoverCloseThreshold) {
          clearTrayHoverCloseTimer();
          trayHoverCloseTimer = window.setTimeout(() => {
            if (!trayDrawer.matches(':hover')) {
              setTrayDrawerOpen(false);
            }
          }, 180);
        }
      }, { passive: true });

      trayDrawer.addEventListener('pointerenter', () => {
        clearTrayHoverCloseTimer();
      });

      trayDrawer.addEventListener('pointerleave', () => {
        clearTrayHoverCloseTimer();
        trayHoverCloseTimer = window.setTimeout(() => {
          if (!trayDrawer.matches(':hover')) {
            setTrayDrawerOpen(false);
          }
        }, 180);
      });
    }
    if (trayCloseBtn) {
      trayCloseBtn.onclick = () => setTrayDrawerOpen(false);
    }
    if (aiPromptCopyBtn) {
      aiPromptCopyBtn.onclick = async (event) => {
        event.stopPropagation();
        const copied = await copyTextToClipboard(getNodeNotePrompt());
        if (copied) {
          const original = aiPromptCopyBtn?.textContent || '複製提詞';
          if (aiPromptCopyBtn) {
            aiPromptCopyBtn.textContent = '已複製';
            window.setTimeout(() => {
              aiPromptCopyBtn.textContent = original;
            }, 1200);
          }
        } else {
          window.alert('複製失敗，請檢查瀏覽器剪貼簿權限。');
        }
      };
    }
    if (syncBtn) {
      syncBtn.onclick = async () => {
        await cloudSyncManager.syncNow({ force: true, armAutoSync: true });
      };
    }
    if (openProjectBtn) {
      openProjectBtn.onclick = () => cloudSyncManager.openProject();
    }
    if(folderGroupBtn) folderGroupBtn.onclick = () => nodeManager.groupSelectionIntoFolder();
    if(undoBtn) undoBtn.onclick = () => store.undo();
    if(redoBtn) redoBtn.onclick = () => store.redo();

    updateDiag("READY");
    collapseDiag();
    registerPwa().catch((error) => {
      console.warn('PWA registration failed', error);
    });
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
