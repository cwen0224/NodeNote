/**
 * ConnectionManager.js
 * Handles the interaction of drawing a line from one node to another.
 */
import { store } from './StateStore.js';
import { getPortSide, resolveConnectionPortSides } from './core/connectionData.js';
import { connectionNamingDialog } from './ConnectionNamingDialog.js';

const isTouchLikePointer = (event) => event?.pointerType === 'touch' || event?.pointerType === 'pen';

class ConnectionManager {
  constructor() {
    this.isDrawing = false;
    this.sourceNodeId = null;
    this.sourcePortEl = null;
    this.reconnectSource = null;
    this.tempPath = null;
    this.svgLayer = null;
    this.historyNames = new Set(['next', 'on_click', 'trigger', 'success', 'fail']);
    this.drawPointerId = null;
    this.orphanDragState = null;
  }

  init() {
    this.svgLayer = document.getElementById('svg-layer');
    this.setupEvents();
  }

  setupEvents() {
    const getPortElement = (event) => event?.target?.closest?.('.port') || null;

    // Start drawing from a port
    document.addEventListener('mousedown', (e) => {
      if (getPortElement(e)) {
        this.startDrawing(e);
      }
    });

    document.addEventListener('pointerdown', (e) => {
      if (!isTouchLikePointer(e) || !getPortElement(e)) {
        return;
      }

      this.startDrawing(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDrawing) {
        this.updateDrawing(e);
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!isTouchLikePointer(e) || !this.isDrawing || e.pointerId !== this.drawPointerId) {
        return;
      }

      e.preventDefault();
      this.updateDrawing(e);
    }, { passive: false });

    window.addEventListener('mouseup', (e) => {
      if (this.isDrawing) {
        this.finishDrawing(e);
      }
    });

    const endTouchDrawing = (e) => {
      if (!isTouchLikePointer(e) || e.pointerId !== this.drawPointerId) {
        return;
      }

      e.preventDefault();
      this.finishDrawing(e);
      this.drawPointerId = null;
    };

    const cancelTouchDrawing = (e) => {
      if (!isTouchLikePointer(e) || e.pointerId !== this.drawPointerId) {
        return;
      }

      e.preventDefault();
      this.cancelDrawing();
      this.drawPointerId = null;
    };

    window.addEventListener('pointerup', endTouchDrawing);
    window.addEventListener('pointercancel', cancelTouchDrawing);
  }

  startDrawing(e) {
    const portEl = e.target.closest?.('.port');
    if (!portEl) {
      this.isDrawing = false;
      return;
    }
    this.beginDrawingFromPort(portEl, e);
  }

  beginDrawingFromPort(portEl, e) {
    this.isDrawing = true;
    const labelGroup = portEl.closest?.('.connection-label-group');
    const orphanNodeEl = portEl.closest?.('.orphan-connection-node');
    const reconnectSourceId = labelGroup?.dataset?.sourceId || orphanNodeEl?.dataset?.orphanSourceId || '';
    const reconnectKey = labelGroup?.dataset?.connectionKey || orphanNodeEl?.dataset?.orphanConnectionKey || '';
    const isReconnectPort = Boolean(
      reconnectSourceId &&
      reconnectKey &&
      (portEl.classList.contains('connection-reconnect-port') || portEl.classList.contains('connection-orphan-port'))
    );
    const nodeEl = portEl.closest('.node');
    this.sourceNodeId = isReconnectPort ? reconnectSourceId : nodeEl?.dataset?.id;
    this.sourcePortEl = portEl;
    this.reconnectSource = isReconnectPort ? (() => {
      const currentValue = store.state.nodes?.[reconnectSourceId]?.params?.[reconnectKey];
      return {
        sourceId: reconnectSourceId,
        key: reconnectKey,
        sourcePortSide: typeof currentValue === 'string'
          ? 'right'
          : (currentValue?.sourcePort || orphanNodeEl?.dataset?.orphanSourcePortSide || 'right'),
      };
    })() : null;
    store.setLastActiveNode(this.sourceNodeId);
    if (isTouchLikePointer(e)) {
      this.drawPointerId = e.pointerId;
    }

    this.tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.tempPath.setAttribute("class", "connection-path temp-path");
    this.svgLayer.appendChild(this.tempPath);
    
    if (isTouchLikePointer(e)) {
      e.preventDefault();
    }
    e.stopPropagation();
  }

  updateDrawing(e) {
    const { x, y, scale } = store.getTransform();
    
    const sourcePoint = this.getPortWorldPoint(this.sourcePortEl);
    if (!sourcePoint) {
      return;
    }

    // Target point in world coords
    const tX = (e.clientX - x) / scale;
    const tY = (e.clientY - y) / scale;

    const dx = Math.abs(tX - sourcePoint.x) * 0.5;
    this.tempPath.setAttribute(
      "d",
      `M ${sourcePoint.x} ${sourcePoint.y} C ${sourcePoint.x + dx} ${sourcePoint.y}, ${tX - dx} ${tY}, ${tX} ${tY}`
    );
  }

  finishDrawing(e) {
    this.isDrawing = false;
    if (this.tempPath) {
      this.tempPath.remove();
      this.tempPath = null;
    }

    const dropTarget = document.elementFromPoint(e.clientX, e.clientY) || e.target;
    const targetNodeEl = dropTarget?.closest?.('.node');
    const targetPortEl = dropTarget?.closest?.('.port');
    if (targetNodeEl && targetNodeEl.dataset.id !== this.sourceNodeId) {
      store.setLastActiveNode(targetNodeEl.dataset.id);
      const targetPortSide = this.resolveTargetPortSide(targetNodeEl, targetPortEl, e.clientX, e.clientY);
      const sourcePortSide = this.reconnectSource?.sourcePortSide || getPortSide(this.sourcePortEl);
      const resolvedSides = resolveConnectionPortSides(
        this.sourcePortEl?.closest?.('.node')?.getBoundingClientRect?.(),
        targetNodeEl?.getBoundingClientRect?.(),
        sourcePortSide,
        targetPortSide
      );
      if (this.reconnectSource) {
        this.reconnectConnectionByKey(
          this.reconnectSource.sourceId,
          this.reconnectSource.key,
          targetNodeEl.dataset.id,
          resolvedSides.sourcePortSide,
          resolvedSides.targetPortSide
        );
      } else {
        this.showNamingPopup(
          this.sourceNodeId,
          targetNodeEl.dataset.id,
          e.clientX,
          e.clientY,
          resolvedSides.sourcePortSide,
          resolvedSides.targetPortSide
        );
      }
    }
    this.drawPointerId = null;
    this.sourceNodeId = null;
    this.sourcePortEl = null;
    this.reconnectSource = null;
  }

  updateOrphanConnectionCenter(sourceId, key, x, y) {
    const node = store.state.nodes?.[sourceId];
    if (!node || !node.params || !Object.prototype.hasOwnProperty.call(node.params, key)) {
      return false;
    }

    const currentValue = node.params[key];
    node.params[key] = {
      ...(typeof currentValue === 'object' && currentValue ? currentValue : {}),
      targetId: null,
      orphanedTargetCenter: {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
      },
      orphanedTargetLabel: currentValue?.orphanedTargetLabel || currentValue?.label || '',
    };
    delete node.params[key].orphanedTargetId;
    return true;
  }

  beginOrphanBlockDrag({ sourceId, key, nodeEl, inputEl, event }) {
    if (!sourceId || !key || !nodeEl) {
      return false;
    }
    if (event?.target?.closest?.('.orphan-connection-input')) {
      return false;
    }
    if (event?.target?.closest?.('.connection-orphan-port')) {
      return false;
    }

    const startX = Number.parseFloat(nodeEl.style.left || '0') || 0;
    const startY = Number.parseFloat(nodeEl.style.top || '0') || 0;
    const startClientX = Number.isFinite(event?.clientX) ? event.clientX : 0;
    const startClientY = Number.isFinite(event?.clientY) ? event.clientY : 0;
    const pointerId = isTouchLikePointer(event) ? event.pointerId : null;

    this.orphanDragState = {
      sourceId,
      key,
      nodeEl,
      inputEl,
      startX,
      startY,
      startClientX,
      startClientY,
      pointerId,
      width: Number.parseFloat(nodeEl.style.width || '0') || nodeEl.getBoundingClientRect?.().width || 140,
      height: Number.parseFloat(nodeEl.style.height || '0') || nodeEl.getBoundingClientRect?.().height || 66,
    };

    nodeEl.classList.add('is-dragging');
    try {
      nodeEl.setPointerCapture?.(pointerId);
    } catch {
      // Ignore capture failures.
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  }

  updateOrphanBlockDrag(event) {
    const drag = this.orphanDragState;
    if (!drag) {
      return;
    }
    if (drag.pointerId !== null && event?.pointerId !== drag.pointerId) {
      return;
    }

    const dx = (Number.isFinite(event?.clientX) ? event.clientX : drag.startClientX) - drag.startClientX;
    const dy = (Number.isFinite(event?.clientY) ? event.clientY : drag.startClientY) - drag.startClientY;
    const nextLeft = drag.startX + dx;
    const nextTop = drag.startY + dy;
    drag.nodeEl.style.left = `${Math.round(nextLeft)}px`;
    drag.nodeEl.style.top = `${Math.round(nextTop)}px`;
    this.updateOrphanConnectionCenter(
      drag.sourceId,
      drag.key,
      nextLeft + (drag.width / 2),
      nextTop + (drag.height / 2)
    );
  }

  finishOrphanBlockDrag(event) {
    const drag = this.orphanDragState;
    if (!drag) {
      return;
    }
    if (drag.pointerId !== null && event?.pointerId !== drag.pointerId) {
      return;
    }

    drag.nodeEl.classList.remove('is-dragging');
    store.emit('connections:updated');
    store.saveHistory();
    this.orphanDragState = null;
  }

  cancelDrawing() {
    this.isDrawing = false;
    if (this.tempPath) {
      this.tempPath.remove();
      this.tempPath = null;
    }
    this.drawPointerId = null;
    this.sourceNodeId = null;
    this.sourcePortEl = null;
    this.reconnectSource = null;
  }

  showNamingPopup(sourceId, targetId, x, y, sourcePortSide, targetPortSide, options = {}) {
    const initialKey = String(options.initialKey ?? '').trim();
    const mode = options.mode || 'create';
    connectionNamingDialog.open({
      x,
      y,
      initialKey,
      historyNames: Array.from(this.historyNames),
      onConfirm: (name) => {
        if (mode === 'rename' && initialKey) {
          this.renameConnectionKey(sourceId, initialKey, name);
        } else {
          this.addConnection(sourceId, targetId, name, sourcePortSide, targetPortSide);
        }
        this.historyNames.add(name);
      },
    });
  }

  addConnection(sourceId, targetId, key, sourcePortSide, targetPortSide) {
    const node = store.state.nodes[sourceId];
    if (node) {
      if (!node.params) node.params = {};
      node.params[key] = {
        targetId,
        sourcePort: sourcePortSide || 'right',
        targetPort: targetPortSide || 'left',
      };
      store.emit('connections:updated');
      store.saveHistory();
    }
  }

  reconnectConnectionByKey(sourceId, key, targetId, sourcePortSide, targetPortSide) {
    const node = store.state.nodes[sourceId];
    if (!node || !node.params || !Object.prototype.hasOwnProperty.call(node.params, key)) {
      return false;
    }

    const currentValue = node.params[key];
    node.params[key] = {
      ...(typeof currentValue === 'object' && currentValue ? currentValue : {}),
      targetId,
      sourcePort: sourcePortSide || currentValue?.sourcePort || 'right',
      targetPort: targetPortSide || currentValue?.targetPort || 'left',
    };
    delete node.params[key].orphanedTargetId;
    delete node.params[key].orphanedTargetCenter;
    delete node.params[key].orphanedTargetLabel;

    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  renameConnectionKey(sourceId, oldKey, newKey) {
    const node = store.state.nodes[sourceId];
    if (!node || !node.params || !Object.prototype.hasOwnProperty.call(node.params, oldKey)) {
      return false;
    }
    const linkValue = node.params[oldKey];
    delete node.params[oldKey];
    node.params[newKey] = linkValue;
    if (Object.keys(node.params).length === 0) {
      delete node.params;
    }
    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  deleteConnectionByKey(sourceId, key) {
    const node = store.state.nodes[sourceId];
    if (!node || !node.params || !Object.prototype.hasOwnProperty.call(node.params, key)) {
      return false;
    }

    delete node.params[key];
    if (Object.keys(node.params).length === 0) {
      delete node.params;
    }

    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  getPortWorldPoint(portEl) {
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

  resolveTargetPortSide(targetNodeEl, targetPortEl, clientX, clientY) {
    if (targetPortEl) {
      return getPortSide(targetPortEl) || 'left';
    }
    const rect = targetNodeEl.getBoundingClientRect();
    const distances = [
      { side: 'top', value: Math.abs(clientY - rect.top) },
      { side: 'right', value: Math.abs(clientX - rect.right) },
      { side: 'bottom', value: Math.abs(clientY - rect.bottom) },
      { side: 'left', value: Math.abs(clientX - rect.left) },
    ];
    distances.sort((a, b) => a.value - b.value);
    return distances[0]?.side || 'left';
  }
}

export const connectionManager = new ConnectionManager();

