function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function normalizePoint(point = {}) {
  return {
    x: isFiniteNumber(point.x) ? point.x : 0,
    y: isFiniteNumber(point.y) ? point.y : 0,
  };
}

function normalizeBounds(bounds = {}) {
  const minX = isFiniteNumber(bounds.minX) ? bounds.minX : 0;
  const minY = isFiniteNumber(bounds.minY) ? bounds.minY : 0;
  const width = Math.max(1, isFiniteNumber(bounds.width) ? bounds.width : 1);
  const height = Math.max(1, isFiniteNumber(bounds.height) ? bounds.height : 1);
  return {
    minX,
    minY,
    width,
    height,
    maxX: minX + width,
    maxY: minY + height,
  };
}

export function computeViewportWorldRect({
  x = 0,
  y = 0,
  scale = 1,
  viewportWidth = 1,
  viewportHeight = 1,
} = {}) {
  const effectiveScale = Math.max(scale, 0.0001);

  return {
    minX: -x / effectiveScale,
    minY: -y / effectiveScale,
    width: viewportWidth / effectiveScale,
    height: viewportHeight / effectiveScale,
  };
}

export function computeContentBounds({
  nodes = [],
  measureNodeSize = () => ({ width: 1, height: 1 }),
  padding = 160,
  fallbackMinX = -600,
  fallbackMinY = -450,
  fallbackWidth = 1200,
  fallbackHeight = 900,
} = {}) {
  if (!Array.isArray(nodes) || !nodes.length) {
    return {
      minX: fallbackMinX,
      minY: fallbackMinY,
      width: fallbackWidth,
      height: fallbackHeight,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  nodes.forEach((node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    const size = measureNodeSize(node) || {};
    const width = Math.max(1, isFiniteNumber(size.width) ? size.width : 1);
    const height = Math.max(1, isFiniteNumber(size.height) ? size.height : 1);
    const x = isFiniteNumber(node.x) ? node.x : 0;
    const y = isFiniteNumber(node.y) ? node.y : 0;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  });

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      minX: fallbackMinX,
      minY: fallbackMinY,
      width: fallbackWidth,
      height: fallbackHeight,
    };
  }

  return {
    minX: minX - padding,
    minY: minY - padding,
    width: Math.max(1, (maxX - minX) + (padding * 2)),
    height: Math.max(1, (maxY - minY) + (padding * 2)),
  };
}

export function computeGraphBounds({
  nodes = [],
  measureNodeSize = () => ({ width: 1, height: 1 }),
  viewportRect = null,
  padding = 160,
  viewportPadding = 160,
  fallbackWorldWidth = 1200,
  fallbackWorldHeight = 900,
} = {}) {
  const normalizedViewport = viewportRect ? normalizeBounds(viewportRect) : null;

  if (!Array.isArray(nodes) || !nodes.length) {
    if (!normalizedViewport) {
      return {
        minX: -fallbackWorldWidth * 0.25,
        minY: -fallbackWorldHeight * 0.25,
        width: fallbackWorldWidth,
        height: fallbackWorldHeight,
      };
    }

    const worldWidth = Math.max(fallbackWorldWidth, normalizedViewport.width * 1.5);
    const worldHeight = Math.max(fallbackWorldHeight, normalizedViewport.height * 1.5);
    return {
      minX: normalizedViewport.minX - (worldWidth * 0.25),
      minY: normalizedViewport.minY - (worldHeight * 0.25),
      width: worldWidth,
      height: worldHeight,
    };
  }

  const contentBounds = computeContentBounds({
    nodes,
    measureNodeSize,
    padding,
  });

  if (!normalizedViewport) {
    return contentBounds;
  }

  const combinedMinX = Math.min(contentBounds.minX, normalizedViewport.minX - viewportPadding);
  const combinedMinY = Math.min(contentBounds.minY, normalizedViewport.minY - viewportPadding);
  const combinedMaxX = Math.max(contentBounds.minX + contentBounds.width, normalizedViewport.minX + normalizedViewport.width + viewportPadding);
  const combinedMaxY = Math.max(contentBounds.minY + contentBounds.height, normalizedViewport.minY + normalizedViewport.height + viewportPadding);

  return {
    minX: combinedMinX,
    minY: combinedMinY,
    width: Math.max(1, combinedMaxX - combinedMinX),
    height: Math.max(1, combinedMaxY - combinedMinY),
  };
}

export function computeMinimapLayout({
  containerWidth = 1,
  containerHeight = 1,
  bounds = { minX: 0, minY: 0, width: 1, height: 1 },
  padding = 12,
} = {}) {
  const normalizedBounds = normalizeBounds(bounds);
  const safeContainerWidth = Math.max(1, containerWidth);
  const safeContainerHeight = Math.max(1, containerHeight);
  const innerWidth = Math.max(1, safeContainerWidth - padding * 2);
  const innerHeight = Math.max(1, safeContainerHeight - padding * 2);
  const graphWidth = Math.max(1, normalizedBounds.width);
  const graphHeight = Math.max(1, normalizedBounds.height);
  const scale = Math.min(innerWidth / graphWidth, innerHeight / graphHeight);
  const scaledWidth = graphWidth * scale;
  const scaledHeight = graphHeight * scale;
  const offsetX = (safeContainerWidth - scaledWidth) / 2;
  const offsetY = (safeContainerHeight - scaledHeight) / 2;

  return {
    bounds: normalizedBounds,
    scale,
    offsetX,
    offsetY,
    containerWidth: safeContainerWidth,
    containerHeight: safeContainerHeight,
    graphWidth,
    graphHeight,
    padding,
  };
}

export function projectWorldPointToMinimap(point = {}, layout = null) {
  if (!layout) {
    return null;
  }

  const normalizedPoint = normalizePoint(point);
  return {
    left: layout.offsetX + (normalizedPoint.x - layout.bounds.minX) * layout.scale,
    top: layout.offsetY + (normalizedPoint.y - layout.bounds.minY) * layout.scale,
  };
}

export function projectViewportRectToMinimap({
  viewportRect = null,
  transform = null,
  layout = null,
  minSize = 18,
} = {}) {
  if (!layout) {
    return null;
  }

  let normalizedViewport = viewportRect ? normalizeBounds(viewportRect) : null;
  if (!normalizedViewport && transform) {
    const {
      x = 0,
      y = 0,
      scale = 1,
      viewportWidth = 1,
      viewportHeight = 1,
    } = transform || {};
    normalizedViewport = computeViewportWorldRect({
      x,
      y,
      scale,
      viewportWidth,
      viewportHeight,
    });
  }

  if (!normalizedViewport) {
    return null;
  }

  const left = layout.offsetX + (normalizedViewport.minX - layout.bounds.minX) * layout.scale;
  const top = layout.offsetY + (normalizedViewport.minY - layout.bounds.minY) * layout.scale;
  const width = Math.max(minSize, normalizedViewport.width * layout.scale);
  const height = Math.max(minSize, normalizedViewport.height * layout.scale);

  return { left, top, width, height };
}

export function projectMinimapPointToWorld({
  clientX,
  clientY,
  minimapRect = null,
  layout = null,
  padding = 12,
} = {}) {
  if (!layout || !minimapRect) {
    return null;
  }

  const localX = clientX - minimapRect.left;
  const localY = clientY - minimapRect.top;
  const clampedX = Math.min(minimapRect.width - padding, Math.max(padding, localX));
  const clampedY = Math.min(minimapRect.height - padding, Math.max(padding, localY));

  return {
    layout,
    minimapRect,
    localX,
    localY,
    clampedX,
    clampedY,
    worldX: layout.bounds.minX + (clampedX - layout.offsetX) / layout.scale,
    worldY: layout.bounds.minY + (clampedY - layout.offsetY) / layout.scale,
  };
}
