/**
 * Renderer.js
 * Listens to state changes and updates the DOM, Canvas grid, and SVG layer.
 * 100% decoupled from user input handling.
 */
import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { resolveNodeSize } from './core/nodeSizing.js';

class Renderer {
  constructor() {
    // Empty constructor, use init()
  }

  init() {
    this.viewport = document.getElementById('viewport');
    this.canvas = document.getElementById('canvas');
    this.gridBg = document.getElementById('grid-bg');
    this.nodeLayer = document.getElementById('node-layer');
    this.svgLayer = document.getElementById('svg-layer');
    this.minimap = document.getElementById('minimap');
    this.minimapContent = document.getElementById('minimap-content');
    this.minimapViewport = document.getElementById('minimap-viewport');
    this.minimapPadding = 12;
    this.minimapLayout = null;
    this.minimapDragState = {
      active: false,
      pointerId: null,
    };
    this.pointerState = {
      current: null,
      previous: null,
    };
    this.portRevealRaf = null;
    this.minimapRaf = null;

    this.setupMinimapEvents();

    window.addEventListener('resize', () => {
      this.minimapLayout = null;
      this.renderMinimap();
    });
    
    // Listen for transform updates (pan, zoom)
    store.on('transform:updated', ({ x, y, scale }) => {
      this.updateTransform(x, y, scale);
    });

    // Listen for state and node updates
    store.on('state:updated', () => this.renderAll());
    store.on('nodes:updated', () => this.renderAll());
    store.on('connections:updated', () => this.renderConnections());
    store.on('selection:updated', () => this.syncSelectionState());
    
    store.on('node:moved', ({ id, x, y }) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"]`);
      if (nodeEl) {
        nodeEl.style.left = `${x}px`;
        nodeEl.style.top = `${y}px`;
      }
      this.renderConnections(); // Redraw lines when node moves
      this.renderMinimap();
    });

    store.on('node:contentUpdated', ({ id, content }) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"] .node-content`);
      if (nodeEl && nodeEl.innerText !== content) {
        nodeEl.innerText = content;
      }
      const nodeWrapper = document.querySelector(`.node[data-id="${id}"]`);
      if (nodeWrapper) {
        this.applyNodeSizing(nodeWrapper, store.state.nodes[id]);
      }
      this.renderConnections();
      this.renderMinimap();
    });

    this.viewport?.addEventListener('pointermove', (e) => {
      const now = performance.now();
      store.setLastPointer(e.clientX, e.clientY);
      this.pointerState = {
        previous: this.pointerState.current,
        current: { x: e.clientX, y: e.clientY, at: now },
      };
      this.schedulePortRevealUpdate();
    });

    this.viewport?.addEventListener('pointerleave', () => {
      this.pointerState = {
        current: null,
        previous: null,
      };
      this.clearPortReveal();
    });
    
    // Trigger initial render
    const t = store.getTransform();
    this.updateTransform(t.x, t.y, t.scale);
    this.renderAll();
  }

  renderAll() {
    this.renderAllNodes();
    this.renderConnections();
    this.renderMinimap();
    this.updatePortReveal();
    this.syncSelectionState();
  }

  scheduleMinimapRender() {
    if (!this.minimap || this.minimapRaf) return;

    this.minimapRaf = window.requestAnimationFrame(() => {
      this.minimapRaf = null;
      this.renderMinimap();
    });
  }

  setupMinimapEvents() {
    if (!this.minimap) return;

    const updateFromPointer = (event) => {
      this.dragViewportFromMinimapPoint(event.clientX, event.clientY);
    };

    this.minimap.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (!this.minimapLayout) {
        this.renderMinimap();
      }

      this.minimapDragState.active = true;
      this.minimapDragState.pointerId = event.pointerId;
      this.minimap.classList.add('is-dragging');
      this.minimap.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      updateFromPointer(event);
    });

    this.minimap.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.minimapDragState.active = false;
      this.minimapDragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
      const focused = this.focusViewportOnLastActiveNode();
      if (!focused) {
        this.focusViewportFromMinimapPoint(event.clientX, event.clientY);
      }
    });

    this.minimap.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.zoomViewportFromMinimapWheel(event.clientX, event.clientY, event.deltaY);
    }, { passive: false });

    this.minimap.addEventListener('pointermove', (event) => {
      if (!this.minimapDragState.active) return;
      if (this.minimapDragState.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateFromPointer(event);
    });

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

    this.minimap.addEventListener('pointerup', endDrag);
    this.minimap.addEventListener('pointercancel', endDrag);
    this.minimap.addEventListener('lostpointercapture', () => {
      this.minimapDragState.active = false;
      this.minimapDragState.pointerId = null;
      this.minimap.classList.remove('is-dragging');
    });
  }

  renderAllNodes() {
    if (!this.nodeLayer) return;
    this.nodeLayer.innerHTML = '';
    
    Object.values(store.state.nodes).forEach(node => {
      const nodeEl = this.createNodeElement(node);
      this.nodeLayer.appendChild(nodeEl);
    });

    this.syncSelectionState();
  }

  syncSelectionState() {
    if (!this.nodeLayer) return;

    const selectedIds = new Set(store.state.selection?.nodeIds || []);
    document.querySelectorAll('.node').forEach((nodeEl) => {
      nodeEl.classList.toggle('is-selected', selectedIds.has(nodeEl.dataset.id));
    });
  }

  schedulePortRevealUpdate() {
    if (this.portRevealRaf) return;
    this.portRevealRaf = window.requestAnimationFrame(() => {
      this.portRevealRaf = null;
      this.updatePortReveal();
    });
  }

  clearPortReveal() {
    document.querySelectorAll('.node').forEach((nodeEl) => {
      nodeEl.classList.remove('ports-visible', 'port-reveal-top', 'port-reveal-right', 'port-reveal-bottom', 'port-reveal-left');
    });
  }

  updatePortReveal() {
    if (!this.nodeLayer) return;

    if (!this.pointerState.current) {
      this.clearPortReveal();
      return;
    }

    const pointerX = this.pointerState.current.x;
    const pointerY = this.pointerState.current.y;
    const previous = this.pointerState.previous;
    const dt = previous ? Math.max(1, this.pointerState.current.at - previous.at) : 16;
    const travel = previous ? Math.hypot(pointerX - previous.x, pointerY - previous.y) : 0;
    const speed = travel / dt;
    const revealMargin = speed > 1.8 ? 24 : speed > 1.1 ? 48 : speed > 0.7 ? 72 : 96;
    const cornerMargin = Math.min(44, Math.max(28, Math.round(revealMargin * 0.6)));

    document.querySelectorAll('.node').forEach((nodeEl) => {
      const rect = nodeEl.getBoundingClientRect();
      const isEditing = nodeEl.classList.contains('is-editing');
      nodeEl.classList.remove('ports-visible', 'port-reveal-top', 'port-reveal-right', 'port-reveal-bottom', 'port-reveal-left');

      if (isEditing) {
        nodeEl.classList.add('ports-visible');
        return;
      }

      const distances = {
        top: Math.abs(pointerY - rect.top),
        right: Math.abs(pointerX - rect.right),
        bottom: Math.abs(pointerY - rect.bottom),
        left: Math.abs(pointerX - rect.left),
      };
      const edgeEntries = Object.entries(distances).sort((a, b) => a[1] - b[1]);
      const closestSide = edgeEntries[0]?.[0];
      const closestDistance = edgeEntries[0]?.[1] ?? Number.POSITIVE_INFINITY;

      const nearTop = distances.top <= revealMargin;
      const nearRight = distances.right <= revealMargin;
      const nearBottom = distances.bottom <= revealMargin;
      const nearLeft = distances.left <= revealMargin;
      const nearTopLeftCorner = nearTop && nearLeft && Math.min(distances.top, distances.left) <= cornerMargin;
      const nearTopRightCorner = nearTop && nearRight && Math.min(distances.top, distances.right) <= cornerMargin;
      const nearBottomLeftCorner = nearBottom && nearLeft && Math.min(distances.bottom, distances.left) <= cornerMargin;
      const nearBottomRightCorner = nearBottom && nearRight && Math.min(distances.bottom, distances.right) <= cornerMargin;

      if (nearTopLeftCorner) {
        nodeEl.classList.add('ports-visible', 'port-reveal-top', 'port-reveal-left');
        return;
      }
      if (nearTopRightCorner) {
        nodeEl.classList.add('ports-visible', 'port-reveal-top', 'port-reveal-right');
        return;
      }
      if (nearBottomLeftCorner) {
        nodeEl.classList.add('ports-visible', 'port-reveal-bottom', 'port-reveal-left');
        return;
      }
      if (nearBottomRightCorner) {
        nodeEl.classList.add('ports-visible', 'port-reveal-bottom', 'port-reveal-right');
        return;
      }

      if (closestSide && closestDistance <= revealMargin) {
        nodeEl.classList.add('ports-visible', `port-reveal-${closestSide}`);
      }
    });
  }

  createNodeElement(node) {
    const div = document.createElement('div');
    div.className = 'node glass-panel';
    div.dataset.id = node.id;
    div.style.left = `${node.x}px`;
    div.style.top = `${node.y}px`;
    div.innerHTML = `
      <div class="node-header">
        <span class="node-id" title="${node.id}">${node.id}</span>
        <div class="node-header-actions">
          <button class="node-edit-btn" type="button" aria-label="編輯節點">✎</button>
        </div>
      </div>
      <div class="node-content" contenteditable="false" spellcheck="false"></div>
      <button class="node-delete-btn" type="button" aria-label="刪除節點">×</button>
      <div class="port top"></div>
      <div class="port bottom"></div>
      <div class="port left"></div>
      <div class="port right"></div>
    `;

    // Internal Events (preventing panning/zooming while interacting with a node)
    const content = div.querySelector('.node-content');
    content.textContent = node.content ?? '';
    this.applyNodeSizing(div, node);
    content.addEventListener('wheel', (e) => {
      const canScrollY = content.scrollHeight > content.clientHeight + 1;
      if (!canScrollY) {
        return;
      }

      const scrollingDown = e.deltaY > 0;
      const scrollingUp = e.deltaY < 0;
      const atTop = content.scrollTop <= 0;
      const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 1;

      if ((scrollingDown && !atBottom) || (scrollingUp && !atTop)) {
        e.stopPropagation();
      }
    });
    content.addEventListener('input', (e) => {
      nodeManager.updateNodeContent(node.id, e.target.innerText);
    });

    content.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      focusContent();
    });
    content.addEventListener('focus', () => {
      div.classList.add('is-editing');
      store.setLastActiveNode(node.id);
    });
    content.addEventListener('blur', () => {
      div.classList.remove('is-editing');
      content.contentEditable = 'false';
    });

    const focusContent = () => {
      div.classList.add('is-editing');
      store.setLastActiveNode(node.id);
      content.contentEditable = 'true';
      content.focus({ preventScroll: true });

      const range = document.createRange();
      range.selectNodeContents(content);

      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    const editBtn = div.querySelector('.node-edit-btn');
    editBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    editBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      focusContent();
    });

    const deleteBtn = div.querySelector('.node-delete-btn');
    deleteBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    deleteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      nodeManager.deleteNode(node.id);
    });

    return div;
  }

  applyNodeSizing(nodeEl, node) {
    if (!nodeEl || !node) {
      return;
    }

    const size = resolveNodeSize(node);
    nodeEl.style.width = `${size.width}px`;
    nodeEl.style.height = `${size.height}px`;
    nodeEl.classList.toggle('is-scrollable', Boolean(size.scrollable));
  }

  renderConnections() {
    if (!this.svgLayer) return;
    this.svgLayer.innerHTML = '';
    
    // Draw all active connections from nodes.params
    Object.values(store.state.nodes).forEach(sourceNode => {
      if (!sourceNode.params) return;
      
      Object.entries(sourceNode.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        const sourcePortSide = typeof linkValue === 'string' ? 'right' : linkValue?.sourcePort || 'right';
        const targetPortSide = typeof linkValue === 'string' ? 'left' : linkValue?.targetPort || 'left';
        const targetNode = store.state.nodes[targetId];
        if (targetNode) {
          const sourcePoint = this.getPortWorldPoint(sourceNode.id, sourcePortSide) || this.getNodeCenterWorldPoint(sourceNode);
          const targetPoint = this.getPortWorldPoint(targetNode.id, targetPortSide) || this.getNodeCenterWorldPoint(targetNode);
          const sX = sourcePoint.x;
          const sY = sourcePoint.y;
          const tX = targetPoint.x;
          const tY = targetPoint.y;
          this.drawBezier(sX, sY, tX, tY, key, sourceNode.id, targetNode.id, sourcePortSide, targetPortSide);
        }
      });
    });
  }

  drawBezier(sX, sY, tX, tY, key, sourceId, targetId, sourcePortSide, targetPortSide) {
    const labelText = String(key ?? '').trim();
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "connection-path");
    
    const dx = Math.abs(tX - sX) * 0.5;
    const cp1x = sX + dx;
    const cp2x = tX - dx;

    path.setAttribute("d", `M ${sX} ${sY} C ${cp1x} ${sY}, ${cp2x} ${tY}, ${tX} ${tY}`);
    this.svgLayer.appendChild(path);

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "connection-label-group");

    const midX = (sX + tX) / 2;
    const midY = (sY + tY) / 2;
    const labelWidth = Math.max(48, Math.min(160, labelText.length * 10 + 28));
    const labelHeight = 24;
    const labelLeft = midX - labelWidth / 2;
    const labelTop = midY - labelHeight / 2;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(labelLeft));
    rect.setAttribute("y", String(labelTop));
    rect.setAttribute("width", String(labelWidth));
    rect.setAttribute("height", String(labelHeight));
    rect.setAttribute("rx", "8");
    rect.setAttribute("ry", "8");
    rect.setAttribute("class", "connection-label-box");

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(midX));
    text.setAttribute("y", String(midY + 0.5));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("class", "connection-label");
    text.textContent = labelText;

      const deleteBtn = document.createElementNS("http://www.w3.org/2000/svg", "g");
      deleteBtn.setAttribute("class", "connection-delete-btn");
    deleteBtn.setAttribute("role", "button");
    deleteBtn.setAttribute("tabindex", "0");
    deleteBtn.setAttribute("aria-label", `刪除連線 ${labelText}`);
    deleteBtn.setAttribute("transform", `translate(${labelLeft + labelWidth}, ${labelTop})`);

      const setDeleteHover = (isHovered) => {
        deleteBtn.classList.toggle("is-hovered", isHovered);
        deleteCircle.setAttribute("r", isHovered ? "9" : "7");
        deleteText.setAttribute("font-size", isHovered ? "11" : "10");
      };

      const hitCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hitCircle.setAttribute("cx", "0");
      hitCircle.setAttribute("cy", "0");
      hitCircle.setAttribute("r", "14");
      hitCircle.setAttribute("class", "connection-delete-btn-hit");

      const deleteCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      deleteCircle.setAttribute("cx", "0");
      deleteCircle.setAttribute("cy", "0");
      deleteCircle.setAttribute("r", "7");
      deleteCircle.setAttribute("class", "connection-delete-btn-box");

    const deleteText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    deleteText.setAttribute("x", "0");
    deleteText.setAttribute("y", "0.5");
    deleteText.setAttribute("text-anchor", "middle");
      deleteText.setAttribute("dominant-baseline", "middle");
      deleteText.setAttribute("class", "connection-delete-btn-text");
      deleteText.textContent = "×";

      deleteBtn.append(hitCircle, deleteCircle, deleteText);
      group.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        connectionManager.showNamingPopup(
          sourceId,
          targetId,
          event.clientX,
          event.clientY,
          sourcePortSide,
          targetPortSide,
          { mode: 'rename', initialKey: labelText }
        );
      });
      deleteBtn.addEventListener('pointerenter', () => setDeleteHover(true));
      deleteBtn.addEventListener('pointerleave', () => setDeleteHover(false));
      deleteBtn.addEventListener('focus', () => setDeleteHover(true));
      deleteBtn.addEventListener('blur', () => setDeleteHover(false));
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        connectionManager.deleteConnectionByKey(sourceId, key);
      });
      deleteBtn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          connectionManager.deleteConnectionByKey(sourceId, key);
        }
      });

    rect.setAttribute("pointer-events", "none");
    text.setAttribute("pointer-events", "none");
    group.append(rect, text, deleteBtn);
    this.svgLayer.appendChild(group);
  }

  getNodeCenterWorldPoint(node) {
    const nodeEl = document.querySelector(`.node[data-id="${node.id}"]`);
    if (!nodeEl) {
      return { x: node.x + 125, y: node.y + 75 };
    }
    const rect = nodeEl.getBoundingClientRect();
    const { x, y, scale } = store.getTransform();
    return {
      x: (rect.left + rect.width / 2 - x) / scale,
      y: (rect.top + rect.height / 2 - y) / scale,
    };
  }

  getPortWorldPoint(nodeId, side) {
    const portEl = document.querySelector(`.node[data-id="${nodeId}"] .port.${side}`);
    if (!portEl) {
      return null;
    }
    const rect = portEl.getBoundingClientRect();
    const { x, y, scale } = store.getTransform();
    return {
      x: (rect.left + rect.width / 2 - x) / scale,
      y: (rect.top + rect.height / 2 - y) / scale,
    };
  }

  updateTransform(x, y, scale) {
    // 1. Update the canvas scale and translate
    this.canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    
    // 2. Update the background grid position and size to create infinite feel
    // Background size naturally scales. We just offset the position to match the pan modulo cell size.
    // Base cell size is 20px
    const scaledCell = 20 * scale;
    // We adjust background position to shift along with x,y dragging. 
    this.gridBg.style.backgroundPosition = `${x}px ${y}px`;
    this.gridBg.style.backgroundSize = `${scaledCell}px ${scaledCell}px`;
    
    // 3. Update Minimap relative position
    this.minimapLayout = null;
    this.updateMinimapViewport();
    this.scheduleMinimapRender();
  }

  getNodeWorldSize(node) {
    const size = resolveNodeSize(node);
    return {
      width: Math.max(1, size.width),
      height: Math.max(1, size.height),
    };
  }

  getGraphBounds() {
    const nodes = Object.values(store.state.nodes);
    const viewportRect = this.getViewportWorldRect();

    if (!nodes.length) {
      const worldWidth = Math.max(1200, viewportRect.width * 1.5);
      const worldHeight = Math.max(900, viewportRect.height * 1.5);
      return {
        minX: viewportRect.minX - worldWidth * 0.25,
        minY: viewportRect.minY - worldHeight * 0.25,
        width: worldWidth,
        height: worldHeight,
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
    const viewportPadding = 160;
    const combinedMinX = Math.min(minX - padding, viewportRect.minX - viewportPadding);
    const combinedMinY = Math.min(minY - padding, viewportRect.minY - viewportPadding);
    const combinedMaxX = Math.max(maxX + padding, viewportRect.minX + viewportRect.width + viewportPadding);
    const combinedMaxY = Math.max(maxY + padding, viewportRect.minY + viewportRect.height + viewportPadding);

    return {
      minX: combinedMinX,
      minY: combinedMinY,
      width: combinedMaxX - combinedMinX,
      height: combinedMaxY - combinedMinY,
    };
  }

  getViewportWorldRect() {
    const { x, y, scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const effectiveScale = Math.max(scale, 0.0001);

    return {
      minX: -x / effectiveScale,
      minY: -y / effectiveScale,
      width: viewportWidth / effectiveScale,
      height: viewportHeight / effectiveScale,
    };
  }

  computeMinimapLayout() {
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

  renderMinimap() {
    if (!this.minimap || !this.minimapContent || !this.minimapViewport) return;

    const layout = this.computeMinimapLayout();
    if (!layout) return;

    const nodes = Object.values(store.state.nodes);
    this.minimapContent.innerHTML = '';

    nodes.forEach((node) => {
      const size = this.getNodeWorldSize(node);
      const nodeEl = document.createElement('div');
      nodeEl.className = 'minimap-node';
      if (node.id === store.state.entryNodeId) {
        nodeEl.classList.add('is-entry');
      }

      const left = layout.offsetX + (node.x - layout.bounds.minX) * layout.scale;
      const top = layout.offsetY + (node.y - layout.bounds.minY) * layout.scale;
      const width = Math.max(4, size.width * layout.scale);
      const height = Math.max(4, size.height * layout.scale);

      nodeEl.style.left = `${left}px`;
      nodeEl.style.top = `${top}px`;
      nodeEl.style.width = `${width}px`;
      nodeEl.style.height = `${height}px`;

      this.minimapContent.appendChild(nodeEl);
    });

    this.updateMinimapViewport(layout);
  }

  updateMinimapViewport(layout = null) {
    if (!this.minimapViewport) return;

    const currentLayout = layout ?? this.minimapLayout ?? this.computeMinimapLayout();
    if (!currentLayout) return;

    const { x, y, scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const worldLeft = -x / scale;
    const worldTop = -y / scale;

    const left = currentLayout.offsetX + (worldLeft - currentLayout.bounds.minX) * currentLayout.scale;
    const top = currentLayout.offsetY + (worldTop - currentLayout.bounds.minY) * currentLayout.scale;
    const width = Math.max(18, (viewportWidth / scale) * currentLayout.scale);
    const height = Math.max(18, (viewportHeight / scale) * currentLayout.scale);

    this.minimapViewport.style.left = `${left}px`;
    this.minimapViewport.style.top = `${top}px`;
    this.minimapViewport.style.width = `${width}px`;
    this.minimapViewport.style.height = `${height}px`;
  }

  getMinimapWorldPoint(clientX, clientY) {
    const layout = this.minimapLayout ?? this.computeMinimapLayout();
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

  dragViewportFromMinimapPoint(clientX, clientY) {
    const point = this.getMinimapWorldPoint(clientX, clientY);
    if (!point) return;

    const { minimapRect, localX, localY, worldX, worldY } = point;
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;

    let nextScale = scale;
    if (this.minimapDragState.active) {
      // Dragging near the edge intentionally zooms out to widen the reachable range.
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

  focusViewportFromMinimapPoint(clientX, clientY) {
    const point = this.getMinimapWorldPoint(clientX, clientY);
    if (!point) return;

    const { worldX, worldY } = point;
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;

    const nextX = (viewportWidth / 2) - (worldX * scale);
    const nextY = (viewportHeight / 2) - (worldY * scale);

    store.setTransform(nextX, nextY, scale);
  }

  focusViewportOnLastActiveNode() {
    const activeNodeId = store.state.interaction?.lastActiveNodeId;
    if (!activeNodeId) {
      return false;
    }

    const node = store.state.nodes[activeNodeId];
    if (!node) {
      return false;
    }

    const center = this.getNodeCenterWorldPoint(node);
    const { scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const nextX = (viewportWidth / 2) - (center.x * scale);
    const nextY = (viewportHeight / 2) - (center.y * scale);

    store.setTransform(nextX, nextY, scale);
    return true;
  }

  zoomViewportFromMinimapWheel(clientX, clientY, deltaY) {
    const point = this.getMinimapWorldPoint(clientX, clientY);
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
}

export const renderer = new Renderer();
