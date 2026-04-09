const NODE_NOTE_DEFAULT_PROJECT_KEY = 'default';
const NODE_NOTE_DEFAULT_REVISION = 0;

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = String(params.action || 'state').toLowerCase();
    const projectKey = normalizeProjectKey_(params.projectKey);
    const callback = String(params.callback || '').trim();
    validateSecret_(params.secret);

    const respond = (payload, statusCode) => {
      if (callback) {
        return jsonpResponse_(payload, callback);
      }
      return jsonResponse_(payload, statusCode);
    };

    if (action === 'state') {
      return respond(buildProjectState_(projectKey));
    }

    if (action === 'ping') {
      return respond({
        ok: true,
        projectKey,
        updatedAt: new Date().toISOString(),
      });
    }

    if (action === 'projects') {
      return respond(buildProjectCatalog_());
    }

    return respond({
      ok: false,
      error: `Unknown action: ${action}`,
    }, 400);
  } catch (error) {
    const payload = errorResponse_(error);
    const callback = String((e && e.parameter && e.parameter.callback) || '').trim();
    return callback ? jsonpResponse_(payload, callback) : jsonResponse_(payload, 500);
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const body = parseBody_(e);
    const action = String(body.action || 'commit').toLowerCase();
    const projectKey = normalizeProjectKey_(body.projectKey);
    validateSecret_(body.secret);

    if (action !== 'commit') {
      return jsonResponse_({
        ok: false,
        error: `Unknown action: ${action}`,
      }, 400);
    }

    const patch = isPlainObject_(body.patch) ? body.patch : {};
    const nextState = applyPatch_(projectKey, patch);
    return jsonResponse_(nextState);
  } catch (error) {
    return jsonResponse_(errorResponse_(error), 500);
  } finally {
    lock.releaseLock();
  }
}

function selfTest() {
  const projectKey = `selftest_${Date.now().toString(36)}`;
  const state = applyPatch_(projectKey, {
    meta: {
      title: 'NodeNote self test',
      description: 'sheet verification',
      updatedAt: new Date().toISOString(),
    },
    extras: {
      testAt: new Date().toISOString(),
      source: 'clasp.run',
    },
  });

  return {
    ok: true,
    projectKey,
    spreadsheetId: state.spreadsheetId,
    spreadsheetUrl: state.spreadsheetUrl,
    revision: state.revision,
    updatedAt: state.updatedAt,
    dashboard: {
      nodeCount: Object.keys(state.document.nodes || {}).length,
      folderCount: Object.keys(state.document.folders || {}).length,
      assetCount: Array.isArray(state.document.assets) ? state.document.assets.length : 0,
    },
  };
}

function buildProjectState_(projectKey) {
  const spreadsheet = getSpreadsheet_();
  ensureSpreadsheetLayout_(spreadsheet);
  const stateSheet = getOrCreateSheet_(spreadsheet, 'state', ['projectKey', 'revision', 'updatedAt', 'rootFolderId', 'metaJson', 'assetsJson', 'extrasJson', 'projectName']);
  const nodesSheet = getOrCreateSheet_(spreadsheet, 'nodes', ['projectKey', 'id', 'payloadJson']);
  const foldersSheet = getOrCreateSheet_(spreadsheet, 'folders', ['projectKey', 'id', 'payloadJson']);
  const assetsSheet = getOrCreateSheet_(spreadsheet, 'assets', ['projectKey', 'id', 'payloadJson']);
  const dashboardSheet = getOrCreateSheet_(spreadsheet, 'dashboard', ['metric', 'value', 'updatedAt']);

  const stateRow = findRowByProjectKey_(stateSheet, projectKey);
  const stateRecord = stateRow ? rowToObject_(stateSheet, stateRow) : null;
  const nodes = readEntityMap_(nodesSheet, projectKey);
  const folders = readEntityMap_(foldersSheet, projectKey);
  const assets = readEntityList_(assetsSheet, projectKey);

  upsertDashboardSheet_(dashboardSheet, {
    projectKey,
    revision: Number.parseInt(stateRecord?.revision || `${NODE_NOTE_DEFAULT_REVISION}`, 10) || 0,
    updatedAt: stateRecord?.updatedAt || null,
    rootFolderId: stateRecord?.rootFolderId || 'folder_root',
    nodeCount: Object.keys(nodes).length,
    folderCount: Object.keys(folders).length,
    assetCount: assets.length,
  });

  return {
    ok: true,
    provider: 'google-sheets',
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    projectKey,
    revision: Number.parseInt(stateRecord?.revision || `${NODE_NOTE_DEFAULT_REVISION}`, 10) || 0,
    updatedAt: stateRecord?.updatedAt || null,
    projectName: stateRecord?.projectName || null,
    document: {
      schemaVersion: '2.0.0',
      meta: parseJson_(stateRecord?.metaJson, { title: 'Untitled', description: '', tags: [], createdAt: null, updatedAt: null }),
      rootFolderId: stateRecord?.rootFolderId || 'folder_root',
      folders,
      nodes,
      assets,
      extras: parseJson_(stateRecord?.extrasJson, {}),
    },
  };
}

function applyPatch_(projectKey, patch) {
  const spreadsheet = getSpreadsheet_();
  ensureSpreadsheetLayout_(spreadsheet);
  const stateSheet = getOrCreateSheet_(spreadsheet, 'state', ['projectKey', 'revision', 'updatedAt', 'rootFolderId', 'metaJson', 'assetsJson', 'extrasJson', 'projectName']);
  const nodesSheet = getOrCreateSheet_(spreadsheet, 'nodes', ['projectKey', 'id', 'payloadJson']);
  const foldersSheet = getOrCreateSheet_(spreadsheet, 'folders', ['projectKey', 'id', 'payloadJson']);
  const assetsSheet = getOrCreateSheet_(spreadsheet, 'assets', ['projectKey', 'id', 'payloadJson']);
  const dashboardSheet = getOrCreateSheet_(spreadsheet, 'dashboard', ['metric', 'value', 'updatedAt']);

  const currentStateRow = findRowByProjectKey_(stateSheet, projectKey);
  const currentState = currentStateRow ? rowToObject_(stateSheet, currentStateRow) : {};
  const nextRevision = (Number.parseInt(currentState.revision || `${NODE_NOTE_DEFAULT_REVISION}`, 10) || 0) + 1;
  const updatedAt = new Date().toISOString();

  upsertEntityPatch_(nodesSheet, projectKey, patch.nodes || {}, patch.deletedNodeIds || []);
  upsertEntityPatch_(foldersSheet, projectKey, patch.folders || {}, patch.deletedFolderIds || []);
  if (Array.isArray(patch.assets)) {
    replaceEntityTable_(assetsSheet, projectKey, patch.assets);
  }

  const nextMeta = isPlainObject_(patch.meta)
    ? patch.meta
    : parseJson_(currentState.metaJson, { title: 'Untitled', description: '', tags: [], createdAt: null, updatedAt: null });
  const nextAssets = Array.isArray(patch.assets)
    ? patch.assets
    : parseJson_(currentState.assetsJson, []);
  const nextExtras = isPlainObject_(patch.extras)
    ? patch.extras
    : parseJson_(currentState.extrasJson, {});
  const nextProjectName = typeof patch.projectName === 'string' && patch.projectName.trim()
    ? patch.projectName.trim()
    : (String(currentState.projectName || '').trim() || String(nextMeta?.title || '').trim() || 'Untitled');
  const nextRootFolderId = typeof patch.rootFolderId === 'string' && patch.rootFolderId.trim()
    ? patch.rootFolderId.trim()
    : (currentState.rootFolderId || 'folder_root');

  upsertStateRow_(stateSheet, projectKey, {
    projectKey,
    revision: nextRevision,
    updatedAt,
    rootFolderId: nextRootFolderId,
    metaJson: JSON.stringify(nextMeta || {}),
    assetsJson: JSON.stringify(nextAssets || []),
    extrasJson: JSON.stringify(nextExtras || {}),
    projectName: nextProjectName,
  });

  upsertDashboardSheet_(dashboardSheet, {
    projectKey,
    revision: nextRevision,
    updatedAt,
    rootFolderId: nextRootFolderId,
    nodeCount: countProjectRows_(nodesSheet, projectKey),
    folderCount: countProjectRows_(foldersSheet, projectKey),
    assetCount: Array.isArray(nextAssets) ? nextAssets.length : 0,
  });

  return buildProjectState_(projectKey);
}

function buildProjectCatalog_() {
  const spreadsheet = getSpreadsheet_();
  ensureSpreadsheetLayout_(spreadsheet);
  const stateSheet = getOrCreateSheet_(spreadsheet, 'state', ['projectKey', 'revision', 'updatedAt', 'rootFolderId', 'metaJson', 'assetsJson', 'extrasJson', 'projectName']);
  const nodesSheet = getOrCreateSheet_(spreadsheet, 'nodes', ['projectKey', 'id', 'payloadJson']);
  const foldersSheet = getOrCreateSheet_(spreadsheet, 'folders', ['projectKey', 'id', 'payloadJson']);
  const assetsSheet = getOrCreateSheet_(spreadsheet, 'assets', ['projectKey', 'id', 'payloadJson']);

  const rows = readAllRows_(stateSheet);
  const seen = new Set();
  const projects = [];

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const projectKey = normalizeProjectKey_(row[0]);
    if (!projectKey || seen.has(projectKey)) {
      continue;
    }

    seen.add(projectKey);
    const revision = Number.parseInt(row[1] || `${NODE_NOTE_DEFAULT_REVISION}`, 10) || 0;
    const updatedAt = String(row[2] || '').trim() || null;
    const rootFolderId = String(row[3] || '').trim() || 'folder_root';
    const meta = parseJson_(row[4], { title: 'Untitled' });
    const projectName = String(row[7] || '').trim() || '';
    const title = projectName || (typeof meta?.title === 'string' && meta.title.trim()
      ? meta.title.trim()
      : 'Untitled');

    projects.push({
      projectKey,
      title,
      projectName: title,
      revision,
      updatedAt,
      rootFolderId,
      nodeCount: countProjectRows_(nodesSheet, projectKey),
      folderCount: countProjectRows_(foldersSheet, projectKey),
      assetCount: countProjectRows_(assetsSheet, projectKey),
    });
  }

  projects.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || '') || 0;
    const rightTime = Date.parse(right.updatedAt || '') || 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    return String(left.projectKey || '').localeCompare(String(right.projectKey || ''));
  });

  return {
    ok: true,
    provider: 'google-sheets',
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    projects,
  };
}

function upsertEntityPatch_(sheet, projectKey, upserts, deletes) {
  const records = [];
  if (isPlainObject_(upserts)) {
    Object.entries(upserts).forEach(([id, payload]) => {
      if (typeof id !== 'string' || !id) {
        return;
      }
      records.push({ projectKey, id, payloadJson: JSON.stringify(payload || {}) });
    });
  }

  if (records.length) {
    upsertTableRows_(sheet, records);
  }

  if (Array.isArray(deletes) && deletes.length) {
    deleteTableRows_(sheet, projectKey, deletes);
  }
}

function replaceEntityTable_(sheet, projectKey, records) {
  const sheetRows = readAllRows_(sheet);
  const kept = [sheetRows[0]];
  for (let index = 1; index < sheetRows.length; index += 1) {
    const row = sheetRows[index];
    if (normalizeProjectKey_(row[0]) !== projectKey) {
      kept.push(row);
    }
  }

  const nextRows = records
    .filter((record) => isPlainObject_(record) && typeof record.id === 'string' && record.id.trim())
    .map((record) => [projectKey, String(record.id), JSON.stringify(record)]);

  writeAllRows_(sheet, kept.concat(nextRows));
}

function upsertStateRow_(sheet, projectKey, record) {
  const rows = readAllRows_(sheet);
  const header = rows[0] || ['projectKey', 'revision', 'updatedAt', 'rootFolderId', 'metaJson', 'assetsJson', 'extrasJson', 'projectName'];
  const nextRow = [
    projectKey,
    record.revision || 0,
    record.updatedAt || new Date().toISOString(),
    record.rootFolderId || 'folder_root',
    record.metaJson || '{}',
    record.assetsJson || '[]',
    record.extrasJson || '{}',
    record.projectName || 'Untitled',
  ];

  let replaced = false;
  for (let index = 1; index < rows.length; index += 1) {
    if (normalizeProjectKey_(rows[index][0]) === projectKey) {
      rows[index] = nextRow;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    rows.push(nextRow);
  }

  writeAllRows_(sheet, [header].concat(rows.slice(1)));
}

function readEntityMap_(sheet, projectKey) {
  const rows = readAllRows_(sheet);
  const map = {};
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (normalizeProjectKey_(row[0]) !== projectKey) {
      continue;
    }

    const id = String(row[1] || '').trim();
    if (!id) {
      continue;
    }

    map[id] = parseJson_(row[2], {});
  }
  return map;
}

function readEntityList_(sheet, projectKey) {
  const rows = readAllRows_(sheet);
  const list = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (normalizeProjectKey_(row[0]) !== projectKey) {
      continue;
    }

    const payload = parseJson_(row[2], null);
    if (payload) {
      list.push(payload);
    }
  }
  return list;
}

function readAllRows_(sheet) {
  const range = sheet.getDataRange();
  const values = range.getValues();
  return values.length ? values : [sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]];
}

function writeAllRows_(sheet, rows) {
  sheet.clearContents();
  if (!rows.length) {
    return;
  }

  const width = Math.max(...rows.map((row) => row.length));
  const padded = rows.map((row) => {
    const next = row.slice();
    while (next.length < width) {
      next.push('');
    }
    return next;
  });
  sheet.getRange(1, 1, padded.length, width).setValues(padded);
}

function upsertDashboardSheet_(sheet, stats) {
  const rows = [
    ['metric', 'value', 'updatedAt'],
    ['projectKey', stats.projectKey || NODE_NOTE_DEFAULT_PROJECT_KEY, stats.updatedAt || new Date().toISOString()],
    ['revision', String(stats.revision || 0), stats.updatedAt || new Date().toISOString()],
    ['rootFolderId', stats.rootFolderId || 'folder_root', stats.updatedAt || new Date().toISOString()],
    ['nodeCount', String(stats.nodeCount || 0), stats.updatedAt || new Date().toISOString()],
    ['folderCount', String(stats.folderCount || 0), stats.updatedAt || new Date().toISOString()],
    ['assetCount', String(stats.assetCount || 0), stats.updatedAt || new Date().toISOString()],
  ];
  writeAllRows_(sheet, rows);
}

function countProjectRows_(sheet, projectKey) {
  const rows = readAllRows_(sheet);
  let count = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (normalizeProjectKey_(rows[index][0]) === projectKey) {
      count += 1;
    }
  }
  return count;
}

function upsertTableRows_(sheet, records) {
  const rows = readAllRows_(sheet);
  const header = rows[0] || ['projectKey', 'id', 'payloadJson'];
  const rowIndexByKey = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    rowIndexByKey.set(`${normalizeProjectKey_(rows[index][0])}::${String(rows[index][1] || '')}`, index + 1);
  }

  records.forEach((record) => {
    const row = [record.projectKey, record.id, record.payloadJson];
    const key = `${normalizeProjectKey_(record.projectKey)}::${record.id}`;
    if (rowIndexByKey.has(key)) {
      const rowIndex = rowIndexByKey.get(key);
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
  });

  if (rows.length === 1 && header.length) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }
}

function deleteTableRows_(sheet, projectKey, ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return;
  }

  const rows = readAllRows_(sheet);
  const rowIndices = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (normalizeProjectKey_(row[0]) !== projectKey) {
      continue;
    }

    const id = String(row[1] || '').trim();
    if (ids.includes(id)) {
      rowIndices.push(index + 1);
    }
  }

  rowIndices.sort((a, b) => b - a).forEach((rowIndex) => {
    sheet.deleteRow(rowIndex);
  });
}

function findRowByProjectKey_(sheet, projectKey) {
  const rows = readAllRows_(sheet);
  for (let index = 1; index < rows.length; index += 1) {
    if (normalizeProjectKey_(rows[index][0]) === projectKey) {
      return index + 1;
    }
  }
  return 0;
}

function rowToObject_(sheet, rowIndex) {
  if (!sheet || !rowIndex || rowIndex < 1) {
    return {};
  }

  const lastColumn = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0] || [];
  const values = sheet.getRange(rowIndex, 1, 1, lastColumn).getValues()[0] || [];
  const record = {};

  headers.forEach((header, index) => {
    const key = String(header || '').trim();
    if (key) {
      record[key] = values[index];
    }
  });

  return record;
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  const currentHeaders = sheet.getLastRow() > 0
    ? sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0]
    : [];
  const nextHeaders = Array.isArray(headers) ? headers : [];
  const firstHeaderMatches = currentHeaders.length && String(currentHeaders[0] || '').trim() === String(nextHeaders[0] || '').trim();
  if (!currentHeaders.length || !firstHeaderMatches) {
    sheet.clearContents();
    sheet.getRange(1, 1, 1, nextHeaders.length).setValues([nextHeaders]);
  } else if (currentHeaders.length < nextHeaders.length) {
    sheet.getRange(1, 1, 1, nextHeaders.length).setValues([nextHeaders]);
  }

  return sheet;
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const spreadsheetId = String(props.getProperty('NODENOTE_SPREADSHEET_ID') || '').trim();
  if (spreadsheetId) {
    return SpreadsheetApp.openById(spreadsheetId);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    const created = SpreadsheetApp.create('NodeNote Collaboration Data');
    props.setProperty('NODENOTE_SPREADSHEET_ID', created.getId());
    return created;
  }

  props.setProperty('NODENOTE_SPREADSHEET_ID', active.getId());
  return active;
}

function ensureSpreadsheetLayout_(spreadsheet) {
  if (!spreadsheet) {
    return;
  }

  let dashboard = spreadsheet.getSheetByName('dashboard');
  if (!dashboard) {
    dashboard = spreadsheet.insertSheet('dashboard', 0);
  }

  try {
    spreadsheet.setActiveSheet(dashboard);
    spreadsheet.moveActiveSheet(1);
  } catch {
    // Best effort only.
  }

  const sheets = spreadsheet.getSheets();
  const defaultSheet = sheets.find((sheet) => sheet.getName() === 'Sheet1');
  if (defaultSheet && sheets.length > 1) {
    try {
      spreadsheet.deleteSheet(defaultSheet);
    } catch {
      // Ignore if the spreadsheet refuses deletion.
    }
  }
}

function normalizeProjectKey_(value) {
  const text = String(value || '').trim();
  return text || NODE_NOTE_DEFAULT_PROJECT_KEY;
}

function parseBody_(e) {
  const raw = String(e?.postData?.contents || '').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`無法解析請求：${error.message}`);
  }
}

function parseJson_(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isPlainObject_(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSecret_(providedSecret) {
  const expected = String(PropertiesService.getScriptProperties().getProperty('NODENOTE_SECRET') || '').trim();
  if (!expected) {
    return true;
  }

  const next = String(providedSecret || '').trim();
  if (next !== expected) {
    throw new Error('Secret 不符');
  }

  return true;
}

function errorResponse_(error) {
  return {
    ok: false,
    error: error && error.message ? error.message : String(error || 'Unknown error'),
  };
}

function jsonResponse_(payload, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function jsonpResponse_(payload, callback) {
  const safeCallback = String(callback || '').replace(/[^\w.$]/g, '');
  const output = ContentService.createTextOutput(`${safeCallback}(${JSON.stringify(payload)});`);
  output.setMimeType(ContentService.MimeType.JAVASCRIPT);
  return output;
}
