export const NODE_MIN_SIDE = 260;
export const NODE_MAX_SIDE = 640;
export const NODE_FOLDER_MIN_SIDE = 320;
export const NODE_FOLDER_MAX_SIDE = 760;
export const NODE_HEADER_HEIGHT = 42;
export const NODE_CONTENT_HORIZONTAL_PADDING = 56;
export const NODE_CONTENT_VERTICAL_PADDING = 24;
export const NODE_AVG_CHAR_WIDTH = 7;
export const NODE_LINE_HEIGHT = 24;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSide(value, fallback = NODE_MIN_SIDE) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampSide(value, minSide = NODE_MIN_SIDE, maxSide = NODE_MAX_SIDE) {
  return Math.max(minSide, Math.min(maxSide, value));
}

function getNodeContent(node = {}) {
  if (!isPlainObject(node)) {
    return '';
  }

  return typeof node.content === 'string' ? node.content : '';
}

function getFolderNodeText(node = {}) {
  if (!isPlainObject(node)) {
    return '';
  }

  const title = typeof node.title === 'string' ? node.title : '';
  const content = typeof node.content === 'string' ? node.content : '';
  const summary = typeof node.summary === 'string'
    ? node.summary
    : (typeof node.folder?.summary === 'string' ? node.folder.summary : '');
  const parts = [title];
  if (content) {
    parts.push(content);
  }
  if (summary && summary !== content) {
    parts.push(summary);
  }
  return parts.filter(Boolean).join('\n');
}

function getExplicitSize(node = {}) {
  if (!isPlainObject(node)) {
    return null;
  }

  if (isPlainObject(node.size)) {
    const width = normalizeSide(node.size.width, 0);
    const height = normalizeSide(node.size.height, 0);
    if (width > 0 || height > 0) {
      return {
        width: width > 0 ? width : height,
        height: height > 0 ? height : width,
      };
    }
  }

  const width = normalizeSide(node.width, 0);
  const height = normalizeSide(node.height, 0);
  if (width > 0 || height > 0) {
    return {
      width: width > 0 ? width : height,
      height: height > 0 ? height : width,
    };
  }

  return null;
}

export function estimateNodeSquareSize(content = '', {
  minSide = NODE_MIN_SIDE,
  maxSide = NODE_MAX_SIDE,
} = {}) {
  const text = typeof content === 'string' ? content : '';
  const lines = text.length ? text.split(/\r?\n/) : [''];
  const lineCount = Math.max(1, lines.length);
  const longestLine = lines.reduce((max, line) => Math.max(max, line.length), 0);

  const widthNeed = Math.ceil((longestLine * NODE_AVG_CHAR_WIDTH) + NODE_CONTENT_HORIZONTAL_PADDING);
  const heightNeed = Math.ceil(NODE_HEADER_HEIGHT + NODE_CONTENT_VERTICAL_PADDING + (lineCount * NODE_LINE_HEIGHT));
  const desiredSide = Math.max(minSide, widthNeed, heightNeed);
  const side = clampSide(desiredSide, minSide, maxSide);

  return {
    width: side,
    height: side,
    side,
    desiredSide,
    scrollable: desiredSide > maxSide,
    lineCount,
    longestLine,
  };
}

export function resolveNodeSize(node = {}, options = {}) {
  const isFolder = isPlainObject(node) && node.type === 'folder';
  const content = isFolder ? getFolderNodeText(node) : getNodeContent(node);
  const minSide = options.minSide ?? (isFolder ? NODE_FOLDER_MIN_SIDE : NODE_MIN_SIDE);
  const maxSide = options.maxSide ?? (isFolder ? NODE_FOLDER_MAX_SIDE : NODE_MAX_SIDE);
  if (content.length > 0) {
    return estimateNodeSquareSize(content, {
      ...options,
      minSide,
      maxSide,
    });
  }

  const explicitSize = getExplicitSize(node);
  if (explicitSize) {
    const side = clampSide(Math.max(explicitSize.width, explicitSize.height), minSide, maxSide);
    return {
      width: side,
      height: side,
      side,
      desiredSide: side,
      scrollable: false,
    };
  }

  return estimateNodeSquareSize('', {
    ...options,
    minSide,
    maxSide,
  });
}
