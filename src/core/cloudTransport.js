import { normalizeCloudSnapshot } from './cloudSyncUtils.js';

function buildJsonpCallbackName() {
  return `__nodenoteSheetJsonp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeSnapshotFromText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  try {
    return normalizeCloudSnapshot(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function requestJson(url, options = {}) {
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

  if (parsed && parsed.ok === false) {
    const message = parsed.error || parsed.message || 'Request failed';
    const error = new Error(message);
    error.status = response.status || 500;
    error.response = parsed;
    throw error;
  }

  return parsed;
}

export function requestJsonp(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const callbackName = buildJsonpCallbackName();
    let timeoutId = null;
    const script = document.createElement('script');

    const cleanup = () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (script?.parentNode) {
        script.parentNode.removeChild(script);
      }
      try {
        delete window[callbackName];
      } catch {
        window[callbackName] = undefined;
      }
    };

    window[callbackName] = (payload) => {
      cleanup();
      if (payload && payload.ok === false) {
        reject(new Error(payload.error || 'Google Sheet JSONP 請求失敗'));
        return;
      }
      resolve(payload);
    };

    script.async = true;
    script.src = url;
    script.onerror = () => {
      cleanup();
      reject(new Error('Google Sheet JSONP 請求失敗'));
    };

    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('Google Sheet JSONP 請求逾時'));
    }, timeoutMs);

    document.head.appendChild(script);
  });
}

export async function postNoCors(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    mode: 'no-cors',
    credentials: 'omit',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify(payload),
  });

  return Boolean(response);
}
