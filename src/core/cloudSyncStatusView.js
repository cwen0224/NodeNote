import {
  resolveCloudSyncBadgePresentation,
  resolveCloudSyncDialogText,
} from './cloudSyncPresentation.js';

export function applyCloudSyncBadgeView(element, options = {}) {
  if (!element) {
    return null;
  }

  element.classList.remove('is-idle', 'is-syncing', 'is-error', 'is-off');
  const presentation = resolveCloudSyncBadgePresentation(options);
  element.classList.add(presentation.className);
  element.textContent = presentation.text;
  element.title = presentation.title;
  return presentation;
}

export function applyCloudSyncDialogView(element, options = {}) {
  if (!element) {
    return '';
  }

  const text = resolveCloudSyncDialogText(options);
  element.textContent = text;
  return text;
}
