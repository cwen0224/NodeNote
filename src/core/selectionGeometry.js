function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function normalizeRect(rect = {}) {
  const left = isFiniteNumber(rect.left) ? rect.left : 0;
  const top = isFiniteNumber(rect.top) ? rect.top : 0;
  const width = Math.max(0, isFiniteNumber(rect.width) ? rect.width : 0);
  const height = Math.max(0, isFiniteNumber(rect.height) ? rect.height : 0);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function normalizeNodeSize(node = {}, fallbackWidth = 260, fallbackHeight = 260) {
  const size = node && typeof node === 'object' && node.size && typeof node.size === 'object'
    ? node.size
    : null;
  const width = isFiniteNumber(size?.width) ? size.width : fallbackWidth;
  const height = isFiniteNumber(size?.height) ? size.height : fallbackHeight;
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

export function getNodeWorldRect(node = {}, measureNodeSize = normalizeNodeSize) {
  const x = isFiniteNumber(node?.x) ? node.x : 0;
  const y = isFiniteNumber(node?.y) ? node.y : 0;
  const size = typeof measureNodeSize === 'function'
    ? measureNodeSize(node)
    : normalizeNodeSize(node);
  const width = Math.max(1, isFiniteNumber(size?.width) ? size.width : 1);
  const height = Math.max(1, isFiniteNumber(size?.height) ? size.height : 1);

  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    centerX: x + (width / 2),
    centerY: y + (height / 2),
  };
}

export function computeNodesBounds(nodes = {}, nodeIds = [], measureNodeSize = normalizeNodeSize) {
  const collection = nodes && typeof nodes === 'object' ? nodes : {};
  const ids = Array.isArray(nodeIds) && nodeIds.length > 0
    ? nodeIds.filter((id) => collection[id])
    : Object.keys(collection);

  if (!ids.length) {
    return {
      minX: 0,
      minY: 0,
      width: 320,
      height: 320,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  ids.forEach((id) => {
    const node = collection[id];
    if (!node) {
      return;
    }

    const rect = getNodeWorldRect(node, measureNodeSize);
    minX = Math.min(minX, rect.left);
    minY = Math.min(minY, rect.top);
    maxX = Math.max(maxX, rect.right);
    maxY = Math.max(maxY, rect.bottom);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      minX: 0,
      minY: 0,
      width: 320,
      height: 320,
    };
  }

  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function computeMarqueeWorldRect({
  left = 0,
  top = 0,
  width = 0,
  height = 0,
  transform = { x: 0, y: 0, scale: 1 },
} = {}) {
  const normalized = normalizeRect({ left, top, width, height });
  const x = isFiniteNumber(transform?.x) ? transform.x : 0;
  const y = isFiniteNumber(transform?.y) ? transform.y : 0;
  const scale = Math.max(isFiniteNumber(transform?.scale) ? transform.scale : 1, 0.0001);

  const worldLeft = (normalized.left - x) / scale;
  const worldTop = (normalized.top - y) / scale;
  const worldRight = (normalized.right - x) / scale;
  const worldBottom = (normalized.bottom - y) / scale;

  return {
    minX: Math.min(worldLeft, worldRight),
    maxX: Math.max(worldLeft, worldRight),
    minY: Math.min(worldTop, worldBottom),
    maxY: Math.max(worldTop, worldBottom),
  };
}

export function hitTestNodesInWorldRect(nodes = {}, worldRect = {}, measureNodeSize = normalizeNodeSize) {
  const collection = nodes && typeof nodes === 'object' ? nodes : {};
  const rect = {
    minX: isFiniteNumber(worldRect?.minX) ? worldRect.minX : 0,
    minY: isFiniteNumber(worldRect?.minY) ? worldRect.minY : 0,
    maxX: isFiniteNumber(worldRect?.maxX) ? worldRect.maxX : 0,
    maxY: isFiniteNumber(worldRect?.maxY) ? worldRect.maxY : 0,
  };

  return Object.values(collection)
    .filter((node) => {
      if (!node || typeof node !== 'object') {
        return false;
      }

      const bounds = getNodeWorldRect(node, measureNodeSize);
      return !(bounds.right < rect.minX
        || bounds.left > rect.maxX
        || bounds.bottom < rect.minY
        || bounds.top > rect.maxY);
    })
    .map((node) => node.id)
    .filter((id) => typeof id === 'string' && id);
}
