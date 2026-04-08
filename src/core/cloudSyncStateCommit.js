import { applyCloudSyncStatePatch } from './cloudSyncState.js';

export function commitCloudSyncStatePatch(target, patch = {}) {
  if (!target || !target.state) {
    return null;
  }

  const state = applyCloudSyncStatePatch(target.state, patch);

  if (typeof target.saveState === 'function') {
    target.saveState();
  }

  return state;
}
