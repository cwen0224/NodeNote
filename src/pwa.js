const SW_URL = `${import.meta.env.BASE_URL}sw.js`;
const BUILD_META_NAME = 'nodenote-build';
const UPDATE_BANNER_ID = 'nodenote-update-banner';
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

function normalizeBuildStamp(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readCurrentBuildStamp() {
  const meta = document.querySelector(`meta[name="${BUILD_META_NAME}"]`);
  const metaStamp = normalizeBuildStamp(meta?.getAttribute('content'));
  const globalStamp = normalizeBuildStamp(typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : '');
  return metaStamp || globalStamp;
}

function formatBuildStamp(buildStamp) {
  const builtAt = buildStamp ? new Date(buildStamp) : null;
  if (!builtAt || Number.isNaN(builtAt.getTime())) {
    return 'v--:--';
  }

  const hours = String(builtAt.getHours()).padStart(2, '0');
  const minutes = String(builtAt.getMinutes()).padStart(2, '0');
  return `v${hours}:${minutes}`;
}

function parseRemoteBuildStamp(htmlText) {
  if (!htmlText) {
    return '';
  }

  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const meta = doc.querySelector(`meta[name="${BUILD_META_NAME}"]`);
  return normalizeBuildStamp(meta?.getAttribute('content'));
}

async function fetchRemoteBuildStamp(baseUrl) {
  const indexUrl = new URL('index.html', baseUrl).href;
  const response = await fetch(`${indexUrl}?v=${Date.now()}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`版本檢查失敗 (${response.status})`);
  }

  return parseRemoteBuildStamp(await response.text());
}

function ensureUpdateBanner() {
  let banner = document.getElementById(UPDATE_BANNER_ID);
  if (banner) {
    return banner;
  }

  banner = document.createElement('div');
  banner.id = UPDATE_BANNER_ID;
  banner.className = 'pwa-update-banner is-hidden';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.innerHTML = `
    <div class="pwa-update-banner__text">
      <div class="pwa-update-banner__title">NodeNote 有新版本</div>
      <div class="pwa-update-banner__body">重新載入後會套用最新更新。</div>
    </div>
    <div class="pwa-update-banner__actions">
      <button type="button" class="pwa-update-banner__button" data-action="reload">重新載入</button>
      <button type="button" class="pwa-update-banner__button pwa-update-banner__button--ghost" data-action="dismiss">稍後</button>
    </div>
  `;
  document.body.appendChild(banner);
  return banner;
}

function showUpdateBanner({ currentStamp, remoteStamp, source, onReload }) {
  const banner = ensureUpdateBanner();
  const title = banner.querySelector('.pwa-update-banner__title');
  const body = banner.querySelector('.pwa-update-banner__body');
  const reloadButton = banner.querySelector('[data-action="reload"]');
  const dismissButton = banner.querySelector('[data-action="dismiss"]');

  if (title) {
    title.textContent = source === 'service-worker'
      ? 'NodeNote 背景更新已就緒'
      : `NodeNote 有新版本 ${formatBuildStamp(remoteStamp)}`;
  }
  if (body) {
    if (source === 'service-worker') {
      body.textContent = '背景更新已完成，重新載入即可套用最新內容。';
    } else if (currentStamp && remoteStamp) {
      body.textContent = `目前是 ${formatBuildStamp(currentStamp)}，最新版本是 ${formatBuildStamp(remoteStamp)}。`;
    } else {
      body.textContent = '偵測到可用更新，重新載入即可套用。';
    }
  }

  if (reloadButton) {
    reloadButton.onclick = () => {
      onReload?.();
    };
  }

  if (dismissButton) {
    dismissButton.onclick = () => {
      banner.classList.add('is-hidden');
    };
  }

  banner.classList.remove('is-hidden');
}

async function checkForRemoteUpdate({ baseUrl, currentStamp, onUpdateAvailable, onCheckError }) {
  try {
    const remoteStamp = await fetchRemoteBuildStamp(baseUrl);
    if (!remoteStamp) {
      return null;
    }

    if (currentStamp && remoteStamp !== currentStamp) {
      onUpdateAvailable?.({
        currentStamp,
        remoteStamp,
        currentLabel: formatBuildStamp(currentStamp),
        remoteLabel: formatBuildStamp(remoteStamp),
      });
      return { currentStamp, remoteStamp };
    }

    return { currentStamp, remoteStamp };
  } catch (error) {
    onCheckError?.(error);
    return null;
  }
}

function bindServiceWorkerUpdates(registration, onUpdateAvailable) {
  if (!registration) {
    return;
  }

  const notifyWaitingWorker = () => {
    if (!navigator.serviceWorker.controller) {
      return;
    }

    onUpdateAvailable?.({
      source: 'service-worker',
    });
  };

  if (registration.waiting) {
    notifyWaitingWorker();
  }

  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;
    if (!installingWorker) {
      return;
    }

    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
        notifyWaitingWorker();
      }
    });
  });
}

function bindUpdateChecks({ baseUrl, onUpdateAvailable, onCheckError }) {
  const check = () => {
    if (document.hidden) {
      return;
    }
    checkForRemoteUpdate({
      baseUrl,
      currentStamp: readCurrentBuildStamp(),
      onUpdateAvailable,
      onCheckError,
    });
  };

  document.addEventListener('visibilitychange', check);
  window.addEventListener('focus', check);
  window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  check();
}

export function getBuildStamp() {
  return readCurrentBuildStamp();
}

export async function registerPwa({
  onUpdateAvailable,
  onCheckError,
} = {}) {
  if (!import.meta.env.PROD) {
    return null;
  }

  if (!('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const presentUpdatePrompt = onUpdateAvailable || ((details) => {
      showUpdateBanner({
        ...details,
        onReload: () => {
          window.location.reload();
        },
      });
    });

    const registration = await navigator.serviceWorker.register(SW_URL, {
      scope: import.meta.env.BASE_URL,
    });
    console.log('NodeNote PWA registered', registration.scope);

    bindServiceWorkerUpdates(registration, presentUpdatePrompt);
    bindUpdateChecks({
      baseUrl: import.meta.env.BASE_URL,
      onUpdateAvailable: presentUpdatePrompt,
      onCheckError,
    });

    registration.update().catch(() => {});
    return registration;
  } catch (error) {
    console.warn('NodeNote PWA registration failed', error);
    return null;
  }
}

export function showPwaUpdateBanner(options) {
  showUpdateBanner(options);
}
