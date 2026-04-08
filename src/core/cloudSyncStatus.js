export function resolveCloudSyncStateChange({
  kind = 'idle',
  message = '',
  detail = '',
  now = new Date().toISOString(),
} = {}) {
  const safeKind = typeof kind === 'string' && kind ? kind : 'idle';
  const patch = {
    status: safeKind,
  };

  if (safeKind === 'ok') {
    patch.lastSyncedAt = now;
  }

  if (safeKind === 'error') {
    patch.lastError = message || detail || '未知錯誤';
  } else {
    patch.lastError = null;
  }

  return patch;
}
