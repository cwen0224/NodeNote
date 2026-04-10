const DB_NAME = 'nodenote-local-assets-v1';
const DB_VERSION = 1;
const STORE_NAME = 'assets';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSvgMarkupText(value = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return false;
  }

  return /^<svg[\s>]/i.test(text) || (text.includes('<svg') && text.includes('</svg>'));
}

function createAssetId(prefix = 'asset') {
  const randomPart = Math.random().toString(36).slice(2, 8);
  const timePart = Date.now().toString(36);
  return `${prefix}_${timePart}_${randomPart}`;
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open local asset database.'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

export async function saveLocalImageAsset({
  dataUrl = '',
  svgText = '',
  label = '',
  mimeType = '',
  width = 0,
  height = 0,
  source = 'clipboard',
} = {}) {
  const normalizedDataUrl = typeof dataUrl === 'string' ? dataUrl.trim() : '';
  const normalizedSvgText = typeof svgText === 'string' ? svgText.trim() : '';
  if (!normalizedDataUrl && !normalizedSvgText) {
    throw new Error('圖片資料不可為空。');
  }

  const record = {
    id: createAssetId('image'),
    type: 'image',
    dataUrl: normalizedDataUrl,
    svgText: normalizedSvgText,
    label: typeof label === 'string' ? label.trim() : '',
    mimeType: typeof mimeType === 'string' ? mimeType.trim() : '',
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    source,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const db = await openDatabase();
  if (!db) {
    return record;
  }

  await requestToPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
  return record;
}

export async function readBlobAsText(file) {
  if (!(file instanceof Blob)) {
    throw new Error('無法讀取文字資料。');
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('文字資料讀取失敗。'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsText(file);
  });
}

export async function getLocalImageAsset(assetId = '') {
  const id = typeof assetId === 'string' ? assetId.trim() : '';
  if (!id) {
    return null;
  }

  const db = await openDatabase();
  if (!db) {
    return null;
  }

  const result = await requestToPromise(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id));
  return isPlainObject(result) ? result : null;
}

export async function deleteLocalImageAsset(assetId = '') {
  const id = typeof assetId === 'string' ? assetId.trim() : '';
  if (!id) {
    return false;
  }

  const db = await openDatabase();
  if (!db) {
    return false;
  }

  await requestToPromise(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id));
  return true;
}

export async function readImageFileAsDataUrl(file) {
  if (!(file instanceof Blob)) {
    throw new Error('無法讀取圖片檔。');
  }

  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('圖片讀取失敗。'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}
