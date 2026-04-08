import { formatClockStamp, withLogHint } from './cloudSyncUtils.js';

function getProviderLabels(provider) {
  return provider === 'sheets'
    ? {
        label: 'Sync',
        ready: 'Google Sheet 同步已就緒',
        off: 'Google Sheet 同步未就緒',
        syncing: 'Google Sheet 同步中',
        syncedPrefix: '上次 Google Sheet 同步',
        dialogReady: '已就緒，會輪詢 Google Sheet 並同步本機修改。',
        dialogOff: '請填入 Google Sheet Web App URL / Project Key。',
        dialogBusy: '正在同步 Google Sheet 內容...',
      }
    : {
        label: 'Backup',
        ready: 'GitHub 備份已就緒',
        off: 'GitHub 備份未就緒',
        syncing: 'GitHub 備份同步中',
        syncedPrefix: '上次 GitHub 備份',
        dialogReady: '已就緒，等下一次 autosave 就會同步。',
        dialogOff: '請填入 GitHub Owner / Repository / Branch / Path / Token。',
        dialogBusy: '正在同步 GitHub 快照...',
      };
}

export function resolveCloudSyncBadgePresentation({
  provider = 'sheets',
  isConfigReady = false,
  syncInFlight = false,
  lastError = '',
  lastSyncedAt = null,
  message = '',
  detail = '',
} = {}) {
  const labels = getProviderLabels(provider);
  const result = {
    className: 'is-idle',
    text: `${labels.label}: ready`,
    title: withLogHint(detail || message || labels.ready),
  };

  if (!isConfigReady) {
    result.className = 'is-off';
    result.text = `${labels.label}: off`;
    result.title = withLogHint(labels.off);
    return result;
  }

  if (syncInFlight) {
    result.className = 'is-syncing';
    result.text = `${labels.label}: sync`;
    result.title = withLogHint(labels.syncing);
    return result;
  }

  if (lastError) {
    result.className = 'is-error';
    result.text = `${labels.label}: error`;
    result.title = withLogHint(lastError);
    return result;
  }

  if (lastSyncedAt) {
    const stamp = formatClockStamp(lastSyncedAt);
    result.text = `${labels.label}: ${stamp}`;
    result.title = withLogHint(detail || message || `${labels.syncedPrefix} ${stamp}`);
    return result;
  }

  result.title = withLogHint(detail || message || labels.ready);
  return result;
}

export function resolveCloudSyncDialogText({
  provider = 'sheets',
  isConfigReady = false,
  syncInFlight = false,
  lastError = '',
  lastSyncedAt = null,
  message = '',
  detail = '',
  isMessageError = false,
} = {}) {
  const labels = getProviderLabels(provider);
  let text = '尚未設定同步。';
  if (!isConfigReady) {
    text = labels.dialogOff;
  } else if (syncInFlight) {
    text = labels.dialogBusy;
  } else if (lastError) {
    text = `錯誤：${lastError}`;
  } else if (lastSyncedAt) {
    text = `${labels.syncedPrefix}：${formatClockStamp(lastSyncedAt)}`;
  } else {
    text = labels.dialogReady;
  }

  if (message && isMessageError) {
    text = detail ? `${message}：${detail}` : message;
  } else if (message && syncInFlight) {
    text = message;
  }

  return text;
}
