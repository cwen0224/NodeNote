import { store } from './StateStore.js';
import { resolveNodeSize } from './core/nodeSizing.js';
import { getFolderTheme } from './core/folderTheme.js';

class MinimapCanvasController {
  constructor() {
    this.initialized = false;
    this.viewport = null;
    this.minimap = null;
    this.canvas = null;
    this.ctx = null;
    this.dragState = {
      active: false,
      pointerId: null,
    };
    this.minimapPadding = 12;
    this.minimapLayout = null;
    this.renderRaf = null;
    this.boundResize = null;
    this.boundTransform = null;
    this.boundState = null;
    this.boundNodes = null;
    this.boundNavigation = null;
    this.boundNodeMoved = null;
    this.boundNodeContent = null;
    this.boundNodeTitle = null;
  }

  init() {
    if (this.initialized) return;

    this.viewport = document.getElementById('viewport');
    this.minimap = document.getElementById('minimap');
    this.canvas = document.getElementById('minimap-canvas');
    this.ctx = this.canvas?.getContext?.('2d', { alpha: true });

    if (!this.viewport || !this.minimap || !this.canvas || !this.ctx) {
      return;
    }

    this.boundResize = () => {
      this.minimapLayout = null;
      this.render();
    };
    this.boundTransform = () => this.scheduleRender();
    this.boundState = () => this.scheduleRender();
    this.boundNodes = () => this.scheduleRender();
    this.boundNavigation = () => this.scheduleRender();
    this.boundNodeMoved = () => this.scheduleRender();
    this.boundNodeContent = () => this.scheduleRender();
    this.boundNodeTitle = () => this.scheduleRender();

    window.addEventListener('resize', this.boundResize);
    store.on('transform:updated', this.boundTransform);
    store.on('state:updated', this.boundState);
    store.on('nodes:updated', this.boundNodes);
    store.on('navigation:updated', this.boundNavigation);
    store.on('node:moved', this.boundNodeMoved);
    store.on('node:contentUpdated', this.boundNodeContent);
    store.on('node:titleUpdated', this.boundNodeTitle);

    this.setupEvents();
    this.render();
    this.initialized = true;
  }

  setupEvents() {
    const updateFromPointer = (event) => {
      this.moveViewportToPoint(event.clientX, event.clientY);
    };

    const startDrag = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!this.minimapLayout) {
        this.render();
      }

      this.dragState.active = true;
      this.dragState.pointerId = event.pointerId;
      this.minimap.classList.add('is-dragging');

      try {
        this.minimap.setPointerCapture?.(event.pointerId);
      } catch {
        // Ignore pointer capture failures.
      }

      event.preventDefault();
      event.stopPropagation();
      updateFromPointer(event);
    };

    const moveDrag = (event) => {
      if (!this.dragState.active) return;
      if (this.dragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateFromPointer(event);
    };

    const endDrag = (event) => {
      if (!this.dragState.active) return;
      if (this.dragState.pointerId !== null && event.pointerId !== this.dragState.pointerId) {
        return;
      }

      this.dragState.active = false;
      this.dragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
      if (this.minimap.hasPointerCapture?.(event.pointerId)) {
        this.minimap.releasePointerCapture(event.pointerId);
      }
    };

    this.minimap.addEventListener('pointerdown', startDrag);
    this.minimap.addEventListener('pointermove', moveDrag);
    this.minimap.addEventListener('pointerup', endDrag);
    this.minimap.addEventListener('pointercancel', endDrag);
    this.minimap.addEventListener('lostpointercapture', () => {
      this.dragState.active = false;
      this.dragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
    });

    this.minimap.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.dragState.active = false;
      this.dragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
      const focused = this.focusOnLastActiveNode();
      if (!focused) {
        this.focusFromPoint(event.clientX, event.clientY);
      }
    });

    this.minimap.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.zoomFromWheel(event.clientX, event.clientY, event.deltaY);
    }, { passive: false });

    window.addEventListener('pointermove', moveDrag, { passive: false });
    window.addEventListener('pointerup', endDrag, { passive: false });
    window.addEventListener('pointercancel', endDrag, { passive: false });
  }

  scheduleRender() {
    if (!this.minimap || this.renderRaf) return;

    this.renderRaf = window.requestAnimationFrame(() => {
      this.renderRaf = null;
      this.render();
    });
  }

  getNodeWorldSize(node) {
    const size = resolveNodeSize(node);
    return {
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
    };
  }

  getGraphBounds() {
    const nodes = Object.values(store.state.nodes || {});

    if (!nodes.length) {
      return {
        minX: -600,
        minY: -450,
        width: 1200,
        height: 900,
      };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const size = this.getNodeWorldSize(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + size.width);
      maxY = Math.max(maxY, node.y + size.height);
    }

    const padding = 160;
    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, (maxX - minX) + (padding * 2)),
      height: Math.max(1, (maxY - minY) + (padding * 2)),
    };
  }

  updateCanvasSize() {
    const rect = this.minimap.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return {
      width: rect.width,
      height: rect.height,
      dpr,
    };
  }

  computeLayout() {
    if (!this.minimap) return null;

    const rect = this.minimap.getBoundingClientRect();
    const bounds = this.getGraphBounds();
    const containerWidth = Math.max(1, rect.width);
    const containerHeight = Math.max(1, rect.height);
    const innerWidth = Math.max(1, containerWidth - this.minimapPadding * 2);
    const innerHeight = Math.max(1, containerHeight - this.minimapPadding * 2);
    const graphWidth = Math.max(1, bounds.width);
    const graphHeight = Math.max(1, bounds.height);
    const scale = Math.min(innerWidth / graphWidth, innerHeight / graphHeight);
    const offsetX = (containerWidth - graphWidth * scale) / 2;
    const offsetY = (containerHeight - graphHeight * scale) / 2;

    this.minimapLayout = {
      bounds,
      scale,
      offsetX,
      offsetY,
      containerWidth,
      containerHeight,
      graphWidth,
      graphHeight,
    };

    return this.minimapLayout;
  }

  render() {
    if (!this.minimap || !this.canvas || !this.ctx) return;

    const { width, height } = this.updateCanvasSize();
    const layout = this.computeLayout();
    if (!layout) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    this.drawNodes(ctx, layout);
    this.drawViewport(ctx, layout);
  }

  drawNodes(ctx, layout) {
    const nodes = Object.values(store.state.nodes || {});

    for (const node of nodes) {
      const size = this.getNodeWorldSize(node);
      const x = layout.offsetX + (node.x - layout.bounds.minX) * layout.scale;
      const y = layout.offsetY + (node.y - layout.bounds.minY) * layout.scale;
      const w = Math.max(4, size.width * layout.scale);
      const h = Math.max(4, size.height * layout.scale);
      const isEntry = node.id === store.state.entryNodeId;
      const isFolder = node.type === 'folder';
      const theme = isFolder ? getFolderTheme(node.depth ?? 0) : null;

      ctx.save();
      ctx.fillStyle = isEntry
        ? 'rgba(52, 211, 153, 0.92)'
        : (theme ? this.withAlpha(theme.accent, 0.75) : 'rgba(88, 166, 255, 0.72)');
      ctx.strokeStyle = isEntry
        ? 'rgba(52, 211, 153, 0.98)'
        : (theme ? this.withAlpha(theme.accent, 0.95) : 'rgba(88, 166, 255, 0.96)');
      ctx.lineWidth = 1.5;
      this.roundRect(ctx, x, y, w, h, Math.max(2, Math.min(5, Math.min(w, h) * 0.18)));
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  drawViewport(ctx, layout) {
    const { x, y, scale } = store.getTransform();
    const viewportRect = this.viewport?.getBoundingClientRect?.();
    const viewportWidth = viewportRect?.width ?? this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = viewportRect?.height ?? this.viewport?.clientHeight ?? window.innerHeight;

    const worldLeft = -x / scale;
    const worldTop = -y / scale;
    const worldRight = worldLeft + (viewportWidth / scale);
    const worldBottom = worldTop + (viewportHeight / scale);

    const left = layout.offsetX + (worldLeft - layout.bounds.minX) * layout.scale;
    const top = layout.offsetY + (worldTop - layout.bounds.minY) * layout.scale;
    const right = layout.offsetX + (worldRight - layout.bounds.minX) * layout.scale;
    const bottom = layout.offsetY + (worldBottom - layout.bounds.minY) * layout.scale;

    ctx.save();
    ctx.fillStyle = 'rgba(88, 166, 255, 0.10)';
    ctx.strokeStyle = 'rgba(88, 166, 255, 0.96)';
    ctx.lineWidth = 2;
    this.roundRect(ctx, left, top, Math.max(4, right - left), Math.max(4, bottom - top), 6);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  withAlpha(color, alpha) {
    if (typeof color !== 'string') return `rgba(88, 166, 255, ${alpha})`;
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const normalized = hex.length === 3
        ? hex.split('').map((c) => c + c).join('')
        : hex.padEnd(6, '0').slice(0, 6);
      const r = Number.parseInt(normalized.slice(0, 2), 16);
      const g = Number.parseInt(normalized.slice(2, 4), 16);
      const b = Number.parseInt(normalized.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color.replace(/rgba?\(([^)]+)\)/, (_, body) => {
      const parts = body.split(',').map((part) => part.trim());
      if (parts.length >= 3) {
        return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
      }
      return color;
    });
  }

  getPoint(clientX, clientY) {
    const layout = this.minimapLayout ?? this.computeLayout();
    if (!layout || !this.minimap) return null;

    const minimapRect = this.minimap.getBoundingClientRect();
    const localX = clientX - minimapRect.left;
    const localY = clientY - minimapRect.top;
    const clampedX = Math.min(minimapRect.width - this.minimapPadding, Math.max(this.minimapPadding, localX));
    const clampedY = Math.min(minimapRect.height - this.minimapPadding, Math.max(this.minimapPadding, localY));

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

  moveViewportToPoint(clientX, clientY) {
    const point = this.getPoint(clientX, clientY);
    if (!point) return;

    const { minimapRect, localX, localY, worldX, worldY } = point;
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;

    let nextScale = scale;
    if (this.dragState.active) {
      const edgeThreshold = Math.max(28, Math.min(72, Math.round(Math.min(minimapRect.width, minimapRect.height) * 0.18)));
      const distanceToEdge = Math.min(
        localX,
        localY,
        minimapRect.width - localX,
        minimapRect.height - localY,
      );
      const edgeIntensity = Math.max(0, Math.min(1, 1 - (distanceToEdge / edgeThreshold)));
      if (edgeIntensity > 0) {
        nextScale = Math.max(0.1, scale * (1 - (edgeIntensity * 0.015)));
      }
    }

    const nextX = (viewportWidth / 2) - (worldX * nextScale);
    const nextY = (viewportHeight / 2) - (worldY * nextScale);
    store.setTransform(nextX, nextY, nextScale);
  }

  focusFromPoint(clientX, clientY) {
    const point = this.getPoint(clientX, clientY);
    if (!point) return;

    const { worldX, worldY } = point;
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const nextX = (viewportWidth / 2) - (worldX * scale);
    const nextY = (viewportHeight / 2) - (worldY * scale);

    store.setTransform(nextX, nextY, scale);
  }

  focusOnLastActiveNode() {
    const activeNodeId = store.state.interaction?.lastActiveNodeId;
    if (!activeNodeId) return false;

    const node = store.state.nodes?.[activeNodeId];
    if (!node) return false;

    const center = this.getNodeCenterWorldPoint(node);
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const nextX = (viewportWidth / 2) - (center.x * scale);
    const nextY = (viewportHeight / 2) - (center.y * scale);

    store.setTransform(nextX, nextY, scale);
    return true;
  }

  zoomFromWheel(clientX, clientY, deltaY) {
    const point = this.getPoint(clientX, clientY);
    if (!point) return;

    const { worldX, worldY } = point;
    const { scale } = store.getTransform();
    const zoomSpeed = 0.001;
    const minScale = 0.1;
    const maxScale = 5;
    const zoomFactor = 1 - deltaY * zoomSpeed;
    const nextScale = Math.max(minScale, Math.min(maxScale, scale * zoomFactor));

    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const nextX = (viewportWidth / 2) - (worldX * nextScale);
    const nextY = (viewportHeight / 2) - (worldY * nextScale);

    store.setTransform(nextX, nextY, nextScale);
  }

  getNodeCenterWorldPoint(node) {
    const size = this.getNodeWorldSize(node);
    return {
      x: node.x + (size.width / 2),
      y: node.y + (size.height / 2),
    };
  }
}

export const minimapController = new MinimapCanvasController();
