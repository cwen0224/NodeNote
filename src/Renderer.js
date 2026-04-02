/**
 * Renderer.js
 * Listens to state changes and updates the DOM, Canvas grid, and SVG layer.
 * 100% decoupled from user input handling.
 */
import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';

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
    this.minimapViewport = document.getElementById('minimap-viewport');
    this.minimapMap = document.getElementById('minimap');
    this.pointerState = {
      current: null,
      previous: null,
    };
    this.portRevealRaf = null;
    
    // Listen for transform updates (pan, zoom)
    store.on('transform:updated', ({ x, y, scale }) => {
      this.updateTransform(x, y, scale);
    });

    // Listen for state and node updates
    store.on('state:updated', () => this.renderAll());
    store.on('nodes:updated', () => this.renderAll());
    store.on('connections:updated', () => this.renderConnections());
    
    store.on('node:moved', ({ id, x, y }) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"]`);
      if (nodeEl) {
        nodeEl.style.left = `${x}px`;
        nodeEl.style.top = `${y}px`;
      }
      this.renderConnections(); // Redraw lines when node moves
    });

    store.on('node:contentUpdated', ({ id, content }) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"] .node-content`);
      if (nodeEl && nodeEl.innerText !== content) {
        nodeEl.innerText = content;
      }
    });

    this.viewport?.addEventListener('pointermove', (e) => {
      const now = performance.now();
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
    this.updatePortReveal();
  }

  renderAllNodes() {
    if (!this.nodeLayer) return;
    this.nodeLayer.innerHTML = '';
    
    Object.values(store.state.nodes).forEach(node => {
      const nodeEl = this.createNodeElement(node);
      this.nodeLayer.appendChild(nodeEl);
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
          <span class="node-id">${node.id}</span>
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
    content.addEventListener('input', (e) => {
      nodeManager.updateNodeContent(node.id, e.target.innerText);
    });

    content.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      focusContent();
    });
    content.addEventListener('focus', () => {
      div.classList.add('is-editing');
    });
    content.addEventListener('blur', () => {
      div.classList.remove('is-editing');
      content.contentEditable = 'false';
    });

    const focusContent = () => {
      div.classList.add('is-editing');
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
    this.updateMinimap(x, y, scale);
  }

  updateMinimap(x, y, scale) {
    if (!this.minimapViewport || !this.minimapMap) return;
    
    // Get viewport dimensions
    const vW = window.innerWidth;
    const vH = window.innerHeight;
    
    // Minimap assumes arbitrary layout bounds (e.g. -5000 to +5000), 
    // for phase 1 we map the visible window to a ratio of the minimap box.
    // The ratio could strictly be e.g. 1/20th of the world size
    const miniW = 200;
    const miniH = 150;
    
    // Very simple minimap logic for now: 
    // The viewport rectangle size indicates zoom level
    const boxW = (vW / scale) * (miniW / 5000); 
    const boxH = (vH / scale) * (miniH / 5000);
    
    // Position depends on -x / scale
    const boxX = (-x / scale) * (miniW / 5000) + (miniW/2);
    const boxY = (-y / scale) * (miniH / 5000) + (miniH/2);
    
    this.minimapViewport.style.width = `${boxW}px`;
    this.minimapViewport.style.height = `${boxH}px`;
    this.minimapViewport.style.transform = `translate(${boxX}px, ${boxY}px)`;
  }
}

export const renderer = new Renderer();
