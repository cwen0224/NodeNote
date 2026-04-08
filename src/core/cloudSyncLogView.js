import {
  compactLogText,
  escapeHtml,
  formatLogStamp,
} from './cloudSyncUtils.js';

export function buildSyncLogSummaryText(logEntries = []) {
  if (!Array.isArray(logEntries) || !logEntries.length) {
    return '尚未記錄任何同步日誌。';
  }

  const count = logEntries.length;
  const latest = logEntries[0];
  return `${count} 筆，最新 ${formatLogStamp(latest?.at)} ${compactLogText(latest?.message, 48)}`;
}

export function buildSyncLogListHtml(logEntries = []) {
  if (!Array.isArray(logEntries) || !logEntries.length) {
    return '<div class="cloud-sync-log-empty">目前沒有本機同步日誌。</div>';
  }

  return logEntries
    .map((entry) => {
      const detail = entry.detail
        ? `<div class="cloud-sync-log-detail">${escapeHtml(entry.detail)}</div>`
        : '';
      const context = entry.context && Object.keys(entry.context).length > 0
        ? `<div class="cloud-sync-log-context">${escapeHtml(compactLogText(entry.context, 160))}</div>`
        : '';

      return `
        <article class="cloud-sync-log-item is-${escapeHtml(entry.level)}">
          <div class="cloud-sync-log-top">
            <span class="cloud-sync-log-time">${escapeHtml(formatLogStamp(entry.at))}</span>
            <span class="cloud-sync-log-level">${escapeHtml(entry.level.toUpperCase())}</span>
            <span class="cloud-sync-log-action">${escapeHtml(entry.action)}</span>
          </div>
          <div class="cloud-sync-log-message">${escapeHtml(entry.message)}</div>
          ${detail}
          ${context}
        </article>
      `;
    })
    .join('');
}
