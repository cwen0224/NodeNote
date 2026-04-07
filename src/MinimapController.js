import { store } from './StateStore.js';
import { resolveNodeSize } from './core/nodeSizing.js';

class MinimapController {
  constructor() {
    this.initialized = false;
    this.viewport = null;
    this.minimap = null;
    this.minimapContent = null;
    this.minimapViewport = null;
    this.minimapPadding = 12;
    this.minimapLayout = null;
    this.minimapDragState = {
      active: false,
      pointerId: null,
    };
    this.minimapRaf = null;
    this.syncRaf = null;
    this.lastViewportSignature = '';
    this.boundWindowResize = null;
    this.boundTransformUpdate = null;
    this.boundStateUpdate = null;
    this.boundNodesUpdate = null;
    this.boundNavigationUpdate = null;
    this.boundNodeMoved = null;
    this.boundNodeContentUpdated = null;
    this.boundNodeTitleUpdated = null;
  }

  init() {
    if (this.initialized) return;

    this.viewport = document.getElementById('viewport');
    this.minimap = document.getElementById('minimap');
    this.minimapContent = document.getElementById('minimap-content');
    this.minimapViewport = document.getElementById('minimap-viewport');

    if (!this.minimap || !this.minimapContent || !this.minimapViewport) {
      return;
    }

    this.boundWindowResize = () => {
      this.minimapLayout = null;
      this.render();
    };
    this.boundTransformUpdate = () => this.updateViewport();
    this.boundStateUpdate = () => this.scheduleRender();
    this.boundNodesUpdate = () => this.scheduleRender();
    this.boundNavigationUpdate = () => this.scheduleRender();
    this.boundNodeMoved = () => this.scheduleRender();
    this.boundNodeContentUpdated = () => this.scheduleRender();
    this.boundNodeTitleUpdated = () => this.scheduleRender();

    window.addEventListener('resize', this.boundWindowResize);
    store.on('transform:updated', this.boundTransformUpdate);
    store.on('state:updated', this.boundStateUpdate);
    store.on('nodes:updated', this.boundNodesUpdate);
    store.on('navigation:updated', this.boundNavigationUpdate);
    store.on('node:moved', this.boundNodeMoved);
    store.on('node:contentUpdated', this.boundNodeContentUpdated);
    store.on('node:titleUpdated', this.boundNodeTitleUpdated);

    this.setupEvents();
    this.render();
    this.startViewportSyncLoop();
    this.initialized = true;
  }

  setupEvents() {
    if (!this.minimap) return;

    const updateFromPointer = (event) => {
      this.dragViewportFromPoint(event.clientX, event.clientY);
    };

    const startDrag = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!this.minimapLayout) {
        this.render();
      }

      this.minimapDragState.active = true;
      this.minimapDragState.pointerId = event.pointerId;
      this.minimap.classList.add('is-dragging');

      try {
        this.minimap.setPointerCapture?.(event.pointerId);
      } catch {
        // Ignore pointer-capture failures on transient pointers.
      }

      event.preventDefault();
      event.stopPropagation();
      updateFromPointer(event);
    };

    const handleMove = (event) => {
      if (!this.minimapDragState.active) return;
      if (this.minimapDragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateFromPointer(event);
    };

    const endDrag = (event) => {
      if (!this.minimapDragState.active) return;
      if (this.minimapDragState.pointerId !== null && event.pointerId !== this.minimapDragState.pointerId) {
        return;
      }

      this.minimapDragState.active = false;
      this.minimapDragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
      if (this.minimap.hasPointerCapture?.(event.pointerId)) {
        this.minimap.releasePointerCapture(event.pointerId);
      }
    };

    this.minimap.addEventListener('pointerdown', startDrag);
    this.minimap.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.minimapDragState.active = false;
      this.minimapDragState.pointerId = null;
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

    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', endDrag, { passive: false });
    window.addEventListener('pointercancel', endDrag, { passive: false });

    this.minimap.addEventListener('lostpointercapture', () => {
      this.minimapDragState.active = false;
      this.minimapDragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
    });
  }

  scheduleRender() {
    if (!this.minimap || this.minimapRaf) return;

    this.minimapRaf = window.requestAnimationFrame(() => {
      this.minimapRaf = null;
      this.render();
    });
  }

  startViewportSyncLoop() {
    if (this.syncRaf) return;

    const tick = () => {
      if (!this.minimap) {
        this.syncRaf = null;
        return;
      }

      const signature = this.getViewportSignature();
      if (signature !== this.lastViewportSignature) {
        this.lastViewportSignature = signature;
        this.updateViewport();
      }

      this.syncRaf = window.requestAnimationFrame(tick);
    };

    this.syncRaf = window.requestAnimationFrame(tick);
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

    nodes.forEach((node) => {
      const size = this.getNodeWorldSize(node);
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + size.width);
      maxY = Math.max(maxY, node.y + size.height);
    });

    const padding = 160;
    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, (maxX - minX) + (padding * 2)),
      height: Math.max(1, (maxY - minY) + (padding * 2)),
    };
  }

  computeLayout() {
    if (!this.minimap) return null;

    const minimapRect = this.minimap.getBoundingClientRect();
    const bounds = this.getGraphBounds();
    const containerWidth = Math.max(1, minimapRect.width);
    const containerHeight = Math.max(1, minimapRect.height);
    const innerWidth = Math.max(1, containerWidth - this.minimapPadding * 2);
    const innerHeight = Math.max(1, containerHeight - this.minimapPadding * 2);
    const graphWidth = Math.max(1, bounds.width);
    const graphHeight = Math.max(1, bounds.height);
    const scale = Math.min(innerWidth / graphWidth, innerHeight / graphHeight);
    const scaledWidth = graphWidth * scale;
    const scaledHeight = graphHeight * scale;
    const offsetX = (containerWidth - scaledWidth) / 2;
    const offsetY = (containerHeight - scaledHeight) / 2;

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
    if (!this.minimap || !this.minimapContent || !this.minimapViewport) return;

    const layout = this.computeLayout();
    if (!layout) return;

    const nodes = Object.values(store.state.nodes || {});
    const fragment = document.createDocumentFragment();
    this.minimapContent.innerHTML = '';

    nodes.forEach((node) => {
      const size = this.getNodeWorldSize(node);
      const nodeEl = document.createElement('div');
      nodeEl.className = `minimap-node${node.type === 'folder' ? ' is-folder' : ''}`;
      if (node.id === store.state.entryNodeId) {
        nodeEl.classList.add('is-entry');
      }

      const left = layout.offsetX + (node.x - layout.bounds.minX) * layout.scale;
      const top = layout.offsetY + (node.y - layout.bounds.minY) * layout.scale;
      const width = Math.max(8, size.width * layout.scale);
      const height = Math.max(8, size.height * layout.scale);

      nodeEl.style.left = `${left}px`;
      nodeEl.style.top = `${top}px`;
      nodeEl.style.width = `${width}px`;
      nodeEl.style.height = `${height}px`;
      nodeEl.setAttribute('aria-hidden', 'true');
      fragment.appendChild(nodeEl);
    });

    this.minimapContent.appendChild(fragment);
    this.updateViewport(layout);
    this.lastViewportSignature = this.getViewportSignature();
  }

  updateViewport(layout = null) {
    if (!this.minimapViewport) return;

    const currentLayout = layout ?? this.minimapLayout ?? this.computeLayout();
    if (!currentLayout) return;

    const { x, y, scale } = store.getTransform();
    const viewportRect = this.viewport?.getBoundingClientRect?.();
    const viewportWidth = viewportRect?.width ?? this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = viewportRect?.height ?? this.viewport?.clientHeight ?? window.innerHeight;
    const worldLeft = -x / scale;
    const worldTop = -y / scale;
    const worldRight = worldLeft + (viewportWidth / scale);
    const worldBottom = worldTop + (viewportHeight / scale);

    const left = currentLayout.offsetX + (worldLeft - currentLayout.bounds.minX) * currentLayout.scale;
    const top = currentLayout.offsetY + (worldTop - currentLayout.bounds.minY) * currentLayout.scale;
    const right = currentLayout.offsetX + (worldRight - currentLayout.bounds.minX) * currentLayout.scale;
    const bottom = currentLayout.offsetY + (worldBottom - currentLayout.bounds.minY) * currentLayout.scale;
    const width = Math.max(4, right - left);
    const height = Math.max(4, bottom - top);

    this.minimapViewport.style.left = `${left}px`;
    this.minimapViewport.style.top = `${top}px`;
    this.minimapViewport.style.width = `${width}px`;
    this.minimapViewport.style.height = `${height}px`;
  }

  getViewportSignature() {
    const { x, y, scale } = store.getTransform();
    const viewportRect = this.viewport?.getBoundingClientRect?.();
    const viewportWidth = viewportRect?.width ?? this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = viewportRect?.height ?? this.viewport?.clientHeight ?? window.innerHeight;
    const layout = this.minimapLayout;
    const bounds = layout?.bounds;

    return [
      Math.round(x * 1000) / 1000,
      Math.round(y * 1000) / 1000,
      Math.round(scale * 1000) / 1000,
      Math.round(viewportWidth * 10) / 10,
      Math.round(viewportHeight * 10) / 10,
      Math.round(layout?.scale ? layout.scale * 100000 : 0),
      Math.round(bounds?.minX ?? 0),
      Math.round(bounds?.minY ?? 0),
      Math.round(bounds?.width ?? 0),
      Math.round(bounds?.height ?? 0),
    ].join('|');
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

  dragViewportFromPoint(clientX, clientY) {
    const point = this.getPoint(clientX, clientY);
    if (!point) return;

    const { minimapRect, localX, localY, worldX, worldY } = point;
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;

    let nextScale = scale;
    if (this.minimapDragState.active) {
      const edgeThreshold = Math.max(28, Math.min(72, Math.round(Math.min(minimapRect.width, minimapRect.height) * 0.18)));
      const distanceToEdge = Math.min(
        localX,
        localY,
        minimapRect.width - localX,
        minimapRect.height - localY,
      );
      const edgeIntensity = Math.max(0, Math.min(1, 1 - (distanceToEdge / edgeThreshold)));
      if (edgeIntensity > 0) {
        const zoomFactor = 1 - (edgeIntensity * 0.015);
        nextScale = Math.max(0.1, scale * zoomFactor);
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
    let nextScale = scale * zoomFactor;
    nextScale = Math.max(minScale, Math.min(maxScale, nextScale));

    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const nextX = (viewportWidth / 2) - (worldX * nextScale);
    const nextY = (viewportHeight / 2) - (worldY * nextScale);

    store.setTransform(nextX, nextY, nextScale);
  }

  getNodeWorldSize(node) {
    const size = resolveNodeSize(node);
    return {
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
    };
  }

  getNodeCenterWorldPoint(node) {
    const size = this.getNodeWorldSize(node);
    return {
      x: node.x + (size.width / 2),
      y: node.y + (size.height / 2),
    };
  }
}

export const minimapController = new MinimapController();
