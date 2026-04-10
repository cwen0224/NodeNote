import { getLocalImageAsset } from './localAssetStore.js';
import { collectClipboardGraph } from './graphClipboard.js';
import { resolveConnectionPortSides } from './connectionData.js';
import { resolveNodeSize } from './nodeSizing.js';
import { buildRoundedOrthogonalPath, selectOrthogonalRoute } from './connectionGeometry.js';
import { getNodeWorldRect } from './selectionGeometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeXml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizeTextLines(value = '', maxCharsPerLine = 20) {
  const safeValue = String(value || '').replace(/\r\n?/g, '\n');
  const maxChars = Math.max(8, Number.isFinite(maxCharsPerLine) ? Math.floor(maxCharsPerLine) : 20);
  const lines = [];

  safeValue.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push('');
      return;
    }

    for (let index = 0; index < trimmed.length; index += maxChars) {
      lines.push(trimmed.slice(index, index + maxChars));
    }
  });

  return lines.length ? lines : [''];
}

function utf8ToBase64(text = '') {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function svgTextToDataUri(svgText = '') {
  return `data:image/svg+xml;base64,${utf8ToBase64(svgText)}`;
}

async function resolveNodeImageHref(node = {}) {
  const assets = Array.isArray(node.assets) ? node.assets : [];
  const imageAsset = assets.find((asset) => asset && asset.type === 'image' && (asset.localAssetId || asset.id));
  if (!imageAsset) {
    return '';
  }

  const localAssetId = typeof imageAsset.localAssetId === 'string' && imageAsset.localAssetId.trim()
    ? imageAsset.localAssetId.trim()
    : (typeof imageAsset.id === 'string' ? imageAsset.id.trim() : '');
  if (!localAssetId) {
    return '';
  }

  const localAsset = await getLocalImageAsset(localAssetId);
  if (!localAsset) {
    return '';
  }

  const svgText = typeof localAsset.svgText === 'string' ? localAsset.svgText.trim() : '';
  if (svgText) {
    return svgTextToDataUri(svgText);
  }

  const dataUrl = typeof localAsset.dataUrl === 'string' ? localAsset.dataUrl.trim() : '';
  return dataUrl;
}

function buildNodeLabel(node = {}) {
  return String(node?.title || node?.content || node?.id || '').trim();
}

function buildNodeBodyLines(node = {}, maxCharsPerLine = 20) {
  if (typeof node?.content !== 'string' || !node.content.trim()) {
    return [];
  }

  return normalizeTextLines(node.content, maxCharsPerLine);
}

function buildNodeGroupSvg({
  node = {},
  x = 0,
  y = 0,
  width = 260,
  height = 260,
  titleHeight = 34,
  hasImage = false,
  imageHref = '',
} = {}) {
  const title = buildNodeLabel(node);
  const isImageNode = node?.type === 'image';
  const bodyTop = titleHeight;
  const bodyHeight = Math.max(1, height - bodyTop);
  const innerPadding = 16;
  const titleLines = normalizeTextLines(title, Math.max(10, Math.floor((width - 36) / 12)));
  const contentLines = hasImage ? [] : buildNodeBodyLines(node, Math.max(10, Math.floor((width - 36) / 12)));

  const fragments = [];
  fragments.push(`<g transform="translate(${x}, ${y})">`);
  fragments.push(`<rect x="0" y="0" width="${width}" height="${height}" rx="18" ry="18" fill="#1f2937" stroke="#60a5fa" stroke-width="2" />`);
  fragments.push(`<rect x="0" y="0" width="${width}" height="${titleHeight}" rx="18" ry="18" fill="#374151" opacity="0.92" />`);
  fragments.push(`<rect x="0" y="${bodyTop}" width="${width}" height="${bodyHeight}" rx="0" ry="0" fill="#111827" opacity="0.62" />`);

  if (isImageNode && imageHref) {
    const imageSize = Math.max(1, bodyHeight - innerPadding * 2);
    const imageWidth = Math.max(1, width - innerPadding * 2);
    fragments.push(`<image x="${innerPadding}" y="${bodyTop + innerPadding}" width="${imageWidth}" height="${imageSize}" href="${escapeXml(imageHref)}" preserveAspectRatio="xMidYMid meet" />`);
  } else if (contentLines.length) {
    const fontSize = Math.max(15, Math.min(22, Math.round(width / 18)));
    const lineHeight = Math.round(fontSize * 1.45);
    const textY = bodyTop + innerPadding + fontSize;
    contentLines.slice(0, 16).forEach((line, index) => {
      fragments.push(`<text x="${innerPadding}" y="${textY + (index * lineHeight)}" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="500">${escapeXml(line || ' ')}</text>`);
    });
  }

  const titleFontSize = Math.max(14, Math.min(20, Math.round(width / 18)));
  const titleY = Math.round((titleHeight / 2) + (titleFontSize / 2) - 2);
  titleLines.slice(0, 2).forEach((line, index) => {
    fragments.push(`<text x="16" y="${titleY + (index * Math.round(titleFontSize * 1.15))}" fill="#f9fafb" font-family="Arial, sans-serif" font-size="${titleFontSize}" font-weight="700">${escapeXml(line || ' ')}</text>`);
  });

  fragments.push('</g>');
  return fragments.join('');
}

function buildEdgePathSvg({
  sourceNode,
  targetNode,
  sourcePortSide = 'right',
  targetPortSide = 'left',
  padding = 48,
} = {}) {
  if (!sourceNode || !targetNode) {
    return '';
  }

  const sourceSize = resolveNodeSize(sourceNode);
  const targetSize = resolveNodeSize(targetNode);
  const sourceRect = getNodeWorldRect({
    x: (Number.isFinite(sourceNode.x) ? sourceNode.x : 0) + padding,
    y: (Number.isFinite(sourceNode.y) ? sourceNode.y : 0) + padding,
    size: sourceSize,
  }, resolveNodeSize);
  const targetRect = getNodeWorldRect({
    x: (Number.isFinite(targetNode.x) ? targetNode.x : 0) + padding,
    y: (Number.isFinite(targetNode.y) ? targetNode.y : 0) + padding,
    size: targetSize,
  }, resolveNodeSize);

  const sourcePort = resolveConnectionPortSides(sourceRect, targetRect, sourcePortSide, targetPortSide).sourcePortSide;
  const targetPort = resolveConnectionPortSides(sourceRect, targetRect, sourcePort, targetPortSide).targetPortSide;

  const getPortPoint = (rect, side) => {
    switch (side) {
      case 'top':
        return { x: rect.centerX, y: rect.top };
      case 'bottom':
        return { x: rect.centerX, y: rect.bottom };
      case 'left':
        return { x: rect.left, y: rect.centerY };
      case 'right':
      default:
        return { x: rect.right, y: rect.centerY };
    }
  };

  const sourcePoint = getPortPoint(sourceRect, sourcePort);
  const targetPoint = getPortPoint(targetRect, targetPort);
  const route = selectOrthogonalRoute({
    sX: sourcePoint.x,
    sY: sourcePoint.y,
    tX: targetPoint.x,
    tY: targetPoint.y,
    sourcePortSide: sourcePort,
    targetPortSide: targetPort,
    sourceBounds: sourceRect,
    targetBounds: targetRect,
  });
  const d = buildRoundedOrthogonalPath(route.routePoints, 18);
  return d ? `<path d="${escapeXml(d)}" fill="none" stroke="#60a5fa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#adobe-arrow)" />` : '';
}

async function buildSelectionSvg(fragment) {
  const nodeIds = Array.isArray(fragment?.nodeIds) ? fragment.nodeIds : [];
  const nodes = fragment?.nodes && typeof fragment.nodes === 'object' ? fragment.nodes : {};
  if (!nodeIds.length || !Object.keys(nodes).length) {
    return '';
  }

  const padding = 48;
  const width = Math.max(1, Math.ceil((fragment.bounds?.width || 0) + padding * 2));
  const height = Math.max(1, Math.ceil((fragment.bounds?.height || 0) + padding * 2));
  const selectedSet = new Set(nodeIds);

  const imageHrefMap = new Map();
  await Promise.all(nodeIds.map(async (nodeId) => {
    const node = nodes[nodeId];
    if (!node || node.type !== 'image') {
      return;
    }
    imageHrefMap.set(nodeId, await resolveNodeImageHref(node));
  }));

  const edges = [];
  nodeIds.forEach((sourceId) => {
    const node = nodes[sourceId];
    if (!node || !node.params || typeof node.params !== 'object') {
      return;
    }

    Object.values(node.params).forEach((linkValue) => {
      const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
      if (!targetId || !selectedSet.has(targetId) || !nodes[targetId]) {
        return;
      }

      edges.push({
        sourceId,
        targetId,
        sourcePortSide: typeof linkValue === 'object' && linkValue?.sourcePort ? linkValue.sourcePort : 'right',
        targetPortSide: typeof linkValue === 'object' && linkValue?.targetPort ? linkValue.targetPort : 'left',
      });
    });
  });

  const edgeMarkup = edges.map((edge) => buildEdgePathSvg({
    sourceNode: nodes[edge.sourceId],
    targetNode: nodes[edge.targetId],
    sourcePortSide: edge.sourcePortSide,
    targetPortSide: edge.targetPortSide,
    padding,
  })).filter(Boolean).join('');

  const nodeMarkup = nodeIds.map((nodeId) => {
    const node = nodes[nodeId];
    if (!node) {
      return '';
    }

    const width = Math.max(120, Math.round(resolveNodeSize(node).width));
    const height = Math.max(80, Math.round(resolveNodeSize(node).height));
    const hasImage = node.type === 'image' && Boolean(imageHrefMap.get(nodeId));
    return buildNodeGroupSvg({
      node,
      x: (Number.isFinite(node.x) ? node.x : 0) + padding,
      y: (Number.isFinite(node.y) ? node.y : 0) + padding,
      width,
      height,
      hasImage,
      imageHref: imageHrefMap.get(nodeId) || '',
    });
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  <defs>
    <marker id="adobe-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa"/>
    </marker>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="white" opacity="0"/>
  <g>
    ${edgeMarkup}
  </g>
  <g>
    ${nodeMarkup}
  </g>
</svg>`;
}

async function writeSvgToClipboard(svgText) {
  if (!svgText) {
    return false;
  }

  try {
    if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml' });
      const textBlob = new Blob([svgText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/svg+xml': svgBlob,
          'text/plain': textBlob,
        }),
      ]);
      return true;
    }
  } catch (error) {
    console.warn('Clipboard SVG write failed', error);
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(svgText);
      return true;
    }
  } catch (error) {
    console.warn('Clipboard text write failed', error);
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = svgText;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    return Boolean(success);
  } catch (error) {
    console.warn('Clipboard fallback copy failed', error);
    return false;
  }
}

export async function copySelectionToAdobeClipboard(documentSnapshot, rootNodeIds = []) {
  const fragment = collectClipboardGraph(documentSnapshot, rootNodeIds);
  if (!fragment) {
    return false;
  }

  const svgText = await buildSelectionSvg(fragment);
  if (!svgText) {
    return false;
  }

  return writeSvgToClipboard(svgText);
}
