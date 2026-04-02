import { NODE_MAX_SIDE, NODE_MIN_SIDE, resolveNodeSize } from './nodeSizing.js';

export const GRAPH_FRAGMENT_SCHEMA = 'nodenote.graph.fragment';
export const GRAPH_DOCUMENT_SCHEMA = 'nodenote.graph.document';
export const GRAPH_CLIPBOARD_VERSION = '1.0.0';

const DEFAULT_NODE_SIDE = NODE_MIN_SIDE;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function getNodePosition(node) {
  if (!isPlainObject(node)) {
    return { x: 0, y: 0 };
  }

  if (Number.isFinite(node.x) || Number.isFinite(node.y)) {
    return {
      x: normalizeNumber(node.x, 0),
      y: normalizeNumber(node.y, 0),
    };
  }

  if (isPlainObject(node.position)) {
    return {
      x: normalizeNumber(node.position.x, 0),
      y: normalizeNumber(node.position.y, 0),
    };
  }

  return { x: 0, y: 0 };
}

function getNodeSize(node) {
  return resolveNodeSize(node, {
    minSide: DEFAULT_NODE_SIDE,
    maxSide: NODE_MAX_SIDE,
  });
}

export function createNodeId(existingIds = new Set(), prefix = 'node') {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  let candidate = '';

  do {
    const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    candidate = `${prefix}_${suffix}`;
  } while (used.has(candidate));

  used.add(candidate);
  return candidate;
}

export function normalizeNodeMap(inputNodes = {}) {
  const normalized = {};

  const entries = Array.isArray(inputNodes)
    ? inputNodes.map((node) => [node?.id, node])
    : Object.entries(isPlainObject(inputNodes) ? inputNodes : {});

  entries.forEach(([key, rawNode]) => {
    if (!rawNode || typeof rawNode !== 'object') {
      return;
    }

    const nodeId = String(rawNode.id ?? key ?? createNodeId());
    const position = getNodePosition(rawNode);
    const node = clone(rawNode);

    node.id = nodeId;
    node.x = position.x;
    node.y = position.y;
    if (!isPlainObject(node.params)) {
      node.params = {};
    }
    const size = resolveNodeSize(node, {
      minSide: DEFAULT_NODE_SIDE,
      maxSide: NODE_MAX_SIDE,
    });
    node.size = {
      width: size.width,
      height: size.height,
    };

    normalized[nodeId] = node;
  });

  return normalized;
}

export function normalizeBounds(bounds, nodes = {}, nodeIds = []) {
  if (isPlainObject(bounds)) {
    const minX = normalizeNumber(bounds.minX ?? bounds.x, 0);
    const minY = normalizeNumber(bounds.minY ?? bounds.y, 0);
    const width = Math.max(1, normalizeNumber(bounds.width, DEFAULT_NODE_SIDE));
    const height = Math.max(1, normalizeNumber(bounds.height, DEFAULT_NODE_SIDE));
    return { minX, minY, width, height };
  }

  return computeBounds(nodes, nodeIds);
}

export function computeBounds(nodes = {}, nodeIds = []) {
  const ids = (Array.isArray(nodeIds) && nodeIds.length > 0)
    ? nodeIds
    : Object.keys(nodes || {});

  if (!ids.length) {
    return {
      minX: 0,
      minY: 0,
      width: DEFAULT_NODE_SIDE,
      height: DEFAULT_NODE_SIDE,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  ids.forEach((id) => {
    const node = nodes[id];
    if (!node) {
      return;
    }

    const position = getNodePosition(node);
    const size = getNodeSize(node);
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + size.width);
    maxY = Math.max(maxY, position.y + size.height);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      minX: 0,
      minY: 0,
      width: DEFAULT_NODE_SIDE,
      height: DEFAULT_NODE_SIDE,
    };
  }

  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function getOutgoingTargetIds(node) {
  if (!isPlainObject(node?.params)) {
    return [];
  }

  return Object.values(node.params)
    .map((linkValue) => {
      if (typeof linkValue === 'string') {
        return linkValue;
      }
      if (isPlainObject(linkValue) && typeof linkValue.targetId === 'string') {
        return linkValue.targetId;
      }
      return null;
    })
    .filter(Boolean);
}

function remapParams(params, idMap) {
  if (!isPlainObject(params)) {
    return {};
  }

  const nextParams = {};
  Object.entries(params).forEach(([key, linkValue]) => {
    if (typeof linkValue === 'string') {
      nextParams[key] = idMap.get(linkValue) || linkValue;
      return;
    }

    if (isPlainObject(linkValue)) {
      const targetId = typeof linkValue.targetId === 'string'
        ? (idMap.get(linkValue.targetId) || linkValue.targetId)
        : linkValue.targetId;
      nextParams[key] = {
        ...clone(linkValue),
        targetId,
      };
      return;
    }

    nextParams[key] = linkValue;
  });

  return nextParams;
}

function rebuildParamsFromEdges(nodes, edges = []) {
  if (!Array.isArray(edges) || !edges.length) {
    return nodes;
  }

  edges.forEach((edge) => {
    if (!isPlainObject(edge)) {
      return;
    }

    const sourceId = typeof edge.fromNodeId === 'string' ? edge.fromNodeId : edge.sourceNodeId;
    const targetId = typeof edge.toNodeId === 'string' ? edge.toNodeId : edge.targetNodeId;
    const key = typeof edge.key === 'string' ? edge.key : edge.label;
    if (!sourceId || !targetId || !key || !nodes[sourceId]) {
      return;
    }

    if (!isPlainObject(nodes[sourceId].params)) {
      nodes[sourceId].params = {};
    }

    nodes[sourceId].params[key] = {
      targetId,
      sourcePort: typeof edge.fromPortId === 'string' ? edge.fromPortId : (edge.sourcePort || 'right'),
      targetPort: typeof edge.toPortId === 'string' ? edge.toPortId : (edge.targetPort || 'left'),
    };
  });

  return nodes;
}

export function collectClipboardGraph(documentSnapshot, rootNodeIds = []) {
  const nodes = normalizeNodeMap(documentSnapshot?.nodes);
  const initialRoots = [...new Set((Array.isArray(rootNodeIds) ? rootNodeIds : []).filter((id) => typeof id === 'string' && nodes[id]))];

  if (!initialRoots.length) {
    return null;
  }

  const visited = new Set();
  const orderedIds = [];
  const queue = [...initialRoots];

  while (queue.length) {
    const nodeId = queue.shift();
    if (visited.has(nodeId) || !nodes[nodeId]) {
      continue;
    }

    visited.add(nodeId);
    orderedIds.push(nodeId);

    getOutgoingTargetIds(nodes[nodeId]).forEach((targetId) => {
      if (!visited.has(targetId) && nodes[targetId]) {
        queue.push(targetId);
      }
    });
  }

  if (!orderedIds.length) {
    return null;
  }

  const bounds = computeBounds(nodes, orderedIds);
  const fragmentNodes = {};

  orderedIds.forEach((nodeId) => {
    const node = clone(nodes[nodeId]);
    const position = getNodePosition(node);

    node.x = position.x - bounds.minX;
    node.y = position.y - bounds.minY;
    delete node.position;
    node.params = remapParams(node.params, new Map());
    fragmentNodes[nodeId] = node;
  });

  const edgeCount = orderedIds.reduce((count, nodeId) => {
    const node = nodes[nodeId];
    if (!isPlainObject(node?.params)) {
      return count;
    }

    return count + Object.values(node.params).reduce((linkCount, linkValue) => {
      const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
      return linkCount + (visited.has(targetId) ? 1 : 0);
    }, 0);
  }, 0);

  return {
    schema: GRAPH_FRAGMENT_SCHEMA,
    version: GRAPH_CLIPBOARD_VERSION,
    kind: 'fragment',
    createdAt: new Date().toISOString(),
    bounds,
    rootNodeIds: initialRoots,
    nodeIds: orderedIds,
    nodeCount: orderedIds.length,
    edgeCount,
    nodes: fragmentNodes,
  };
}

export function fragmentToClipboardText(fragment) {
  return JSON.stringify(fragment, null, 2);
}

export function parseClipboardText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isGraphLikePayload(payload) {
  return isPlainObject(payload) && (
    payload.schema === GRAPH_FRAGMENT_SCHEMA ||
    payload.schema === GRAPH_DOCUMENT_SCHEMA ||
    isPlainObject(payload.nodes)
  );
}

export function normalizeClipboardPayload(payload) {
  if (!isGraphLikePayload(payload)) {
    return null;
  }

  const sourceNodes = normalizeNodeMap(payload.nodes);
  const edges = Array.isArray(payload.edges) ? payload.edges : [];
  const nodes = rebuildParamsFromEdges(sourceNodes, edges);
  const nodeIds = Array.isArray(payload.nodeIds) && payload.nodeIds.length
    ? payload.nodeIds.filter((id) => typeof id === 'string' && nodes[id])
    : Object.keys(nodes);

  const bounds = normalizeBounds(payload.bounds, nodes, nodeIds);
  const rootNodeIds = Array.isArray(payload.rootNodeIds) && payload.rootNodeIds.length
    ? payload.rootNodeIds.filter((id) => typeof id === 'string' && nodes[id])
    : (payload.entryNodeId && nodes[payload.entryNodeId]
      ? [payload.entryNodeId]
      : (payload.schema === GRAPH_DOCUMENT_SCHEMA ? Object.keys(nodes) : nodeIds.slice(0, 1)));

  const normalizedNodes = {};
  nodeIds.forEach((nodeId) => {
    const node = clone(nodes[nodeId]);
    const position = getNodePosition(node);
    if (payload.schema === GRAPH_DOCUMENT_SCHEMA) {
      node.x = position.x - bounds.minX;
      node.y = position.y - bounds.minY;
    } else {
      node.x = position.x;
      node.y = position.y;
    }
    delete node.position;
    normalizedNodes[nodeId] = node;
  });

  return {
    schema: payload.schema || GRAPH_FRAGMENT_SCHEMA,
    version: typeof payload.version === 'string' ? payload.version : GRAPH_CLIPBOARD_VERSION,
    kind: payload.schema === GRAPH_DOCUMENT_SCHEMA ? 'document' : 'fragment',
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : null,
    bounds,
    rootNodeIds,
    nodeIds,
    nodeCount: nodeIds.length,
    edgeCount: Array.isArray(payload.edges) ? payload.edges.length : 0,
    nodes: normalizedNodes,
  };
}

export function materializeClipboardPayload(payload, {
  anchorWorldPoint = null,
  existingNodeIds = new Set(),
} = {}) {
  const normalized = normalizeClipboardPayload(payload);
  if (!normalized) {
    return null;
  }

  const existingIds = existingNodeIds instanceof Set ? new Set(existingNodeIds) : new Set(existingNodeIds || []);
  const bounds = normalized.bounds || computeBounds(normalized.nodes, normalized.nodeIds);
  const anchorX = normalizeNumber(anchorWorldPoint?.x, bounds.minX + (bounds.width / 2));
  const anchorY = normalizeNumber(anchorWorldPoint?.y, bounds.minY + (bounds.height / 2));
  const offsetX = anchorX - (bounds.minX + bounds.width / 2);
  const offsetY = anchorY - (bounds.minY + bounds.height / 2);

  const idMap = new Map();
  normalized.nodeIds.forEach((oldId) => {
    const newId = createNodeId(existingIds, oldId);
    idMap.set(oldId, newId);
    existingIds.add(newId);
  });

  const nodes = {};
  normalized.nodeIds.forEach((oldId) => {
    const source = normalized.nodes[oldId];
    if (!source) {
      return;
    }

    const node = clone(source);
    node.id = idMap.get(oldId) || oldId;
    const position = getNodePosition(node);
    node.x = position.x + bounds.minX + offsetX;
    node.y = position.y + bounds.minY + offsetY;
    node.params = remapParams(node.params, idMap);
    delete node.position;

    nodes[node.id] = node;
  });

  const rootNodeIds = normalized.rootNodeIds
    .map((nodeId) => idMap.get(nodeId) || nodeId)
    .filter((nodeId) => typeof nodeId === 'string' && nodes[nodeId]);

  return {
    ...normalized,
    nodeIds: Object.keys(nodes),
    rootNodeIds,
    nodes,
    idMap,
    offset: {
      x: offsetX,
      y: offsetY,
    },
  };
}
