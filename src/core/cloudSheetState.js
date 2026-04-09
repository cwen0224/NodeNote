import { createDefaultDocument, normalizeDocument } from './documentSchema.js';
import {
  applyCollaborativePatch,
  createCollaborativePatch,
  isCollaborativePatchEmpty,
} from './googleSheetCollab.js';
import { isPlainObject, sanitizeText as sanitizeString } from './cloudSyncUtils.js';

export function normalizeSheetResponse(response = {}, { fallbackRevision = 0 } = {}) {
  const remoteDocument = response?.document ? normalizeDocument(response.document) : null;
  const remoteRevision = Number.isFinite(response?.revision) ? response.revision : fallbackRevision;
  const updatedAt = sanitizeString(response?.updatedAt, '') || null;
  const spreadsheetId = sanitizeString(response?.spreadsheetId, '') || null;
  const spreadsheetUrl = sanitizeString(response?.spreadsheetUrl, '') || null;

  return {
    remoteDocument,
    remoteRevision,
    updatedAt,
    spreadsheetId,
    spreadsheetUrl,
  };
}

export function mergeSheetRemoteDocument({
  response = {},
  baselineDocument = createDefaultDocument(),
  currentDocument = createDefaultDocument(),
} = {}) {
  const normalized = normalizeSheetResponse(response);
  const safeBaseline = isPlainObject(baselineDocument) ? baselineDocument : createDefaultDocument();
  const safeCurrent = isPlainObject(currentDocument) ? currentDocument : createDefaultDocument();

  if (!normalized.remoteDocument) {
    return {
      ...normalized,
      localPatch: null,
      hasLocalChanges: false,
      mergedDocument: null,
    };
  }

  const localPatch = createCollaborativePatch(safeBaseline, safeCurrent);
  const hasLocalChanges = !isCollaborativePatchEmpty(localPatch);
  const mergedDocument = hasLocalChanges
    ? applyCollaborativePatch(normalized.remoteDocument, localPatch)
    : normalized.remoteDocument;

  return {
    ...normalized,
    localPatch,
    hasLocalChanges,
    mergedDocument,
  };
}
