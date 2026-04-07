/**
 * ConnectionManager.js
 * Handles the interaction of drawing a line from one node to another.
 */
import { store } from './StateStore.js';
import { getPortSide } from './core/connectionData.js';
import { connectionNamingDialog } from './ConnectionNamingDialog.js';

class ConnectionManager {
  constructor() {
    this.isDrawing = false;
    this.sourceNodeId = null;
    this.sourcePortEl = null;
    this.tempPath = null;
    this.svgLayer = null;
    this.historyNames = new Set(['next', 'on_click', 'trigger', 'success', 'fail']);
  }

  init() {
    this.svgLayer = document.getElementById('svg-layer');
    this.setupEvents();
  }

  setupEvents() {
    // Start drawing from a port
    document.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('port')) {
        this.startDrawing(e);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDrawing) {
        this.updateDrawing(e);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDrawing) {
        this.finishDrawing(e);
      }
    });
  }

  startDrawing(e) {
    this.isDrawing = true;
    const portEl = e.target.closest('.port');
    if (!portEl) {
      this.isDrawing = false;
      return;
    }
    const nodeEl = portEl.closest('.node');
    this.sourceNodeId = nodeEl.dataset.id;
    this.sourcePortEl = portEl;
    store.setLastActiveNode(this.sourceNodeId);

    this.tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    this.tempPath.setAttribute("class", "connection-path temp-path");
    this.svgLayer.appendChild(this.tempPath);
    
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

    const targetNodeEl = e.target.closest('.node');
    const targetPortEl = e.target.closest('.port');
    if (targetNodeEl && targetNodeEl.dataset.id !== this.sourceNodeId) {
      store.setLastActiveNode(targetNodeEl.dataset.id);
      const targetPortSide = this.resolveTargetPortSide(targetNodeEl, targetPortEl, e.clientX, e.clientY);
      const sourcePortSide = getPortSide(this.sourcePortEl);
      this.showNamingPopup(
        this.sourceNodeId,
        targetNodeEl.dataset.id,
        e.clientX,
        e.clientY,
        sourcePortSide,
        targetPortSide
      );
    }
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

