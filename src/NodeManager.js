/**
 * NodeManager.js
 * Handles node lifecycle: creation, removal, dragging, and content updates.
 */
import { store } from './StateStore.js';

class NodeManager {
  constructor() {
    this.viewport = null;
    this.nodeLayer = null;
    this.isDraggingNode = false;
    this.draggedNodeId = null;
    this.dragOffset = { x: 0, y: 0 };
    this.contentTimeout = null;
  }

  init() {
    this.viewport = document.getElementById('viewport');
    this.nodeLayer = document.getElementById('node-layer');
    this.setupEvents();
  }

  setupEvents() {
    // 1. Double click to create node
    this.viewport.addEventListener('dblclick', (e) => {
      // Don't create if clicking on an existing node
      if (
        e.target !== this.viewport &&
        e.target.id !== 'grid-bg' &&
        e.target.id !== 'svg-layer' &&
        !e.target.closest?.('.connection-label-group')
      ) {
        return;
      }

      const { x, y, scale } = store.getTransform();
      // Convert screen coords to world coords
      const worldX = (e.clientX - x) / scale;
      const worldY = (e.clientY - y) / scale;

      this.createNode(worldX, worldY);
    });

    // 2. Node Dragging (Mouse Down on node)
    this.nodeLayer.addEventListener('mousedown', (e) => {
      const nodeEl = e.target.closest('.node');
      if (!nodeEl) return;
      if (e.target.closest('.port')) return;
      if (e.target.closest('.node-edit-btn')) return;
      if (e.target.closest('.node-delete-btn')) return;
      if (e.target.closest('.node-content') && nodeEl.classList.contains('is-editing')) return;

      // Handle dragging
      if (e.button === 0 && !e.shiftKey) {
        this.isDraggingNode = true;
        this.draggedNodeId = nodeEl.dataset.id;
        store.setLastActiveNode(this.draggedNodeId);
        
        const node = store.state.nodes[this.draggedNodeId];
        const { scale } = store.getTransform();
        
        this.dragOffset.x = e.clientX / scale - node.x;
        this.dragOffset.y = e.clientY / scale - node.y;
        
        nodeEl.classList.add('dragging');
        e.stopPropagation();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingNode && this.draggedNodeId) {
        const { scale } = store.getTransform();
        const newX = e.clientX / scale - this.dragOffset.x;
        const newY = e.clientY / scale - this.dragOffset.y;
        
        this.updateNodePosition(this.draggedNodeId, newX, newY);
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDraggingNode) {
        this.isDraggingNode = false;
        const nodeEl = document.querySelector(`.node[data-id="${this.draggedNodeId}"]`);
        if (nodeEl) nodeEl.classList.remove('dragging');
        this.draggedNodeId = null;
        store.saveHistory(); // Save state after move
      }
    });
  }

  createNode(x, y) {
    const id = 'node_' + Date.now();
    const node = {
      id,
      x,
      y,
      content: '',
      params: {}
    };
    
    store.state.nodes[id] = node;
    store.setLastActiveNode(id);
    store.emit('nodes:updated', store.state.nodes);
    store.saveHistory();
  }

  deleteNode(id) {
    if (!store.state.nodes[id]) {
      return;
    }

    delete store.state.nodes[id];

    if (store.state.interaction?.lastActiveNodeId === id) {
      store.setLastActiveNode(null);
    }

    Object.values(store.state.nodes).forEach((node) => {
      if (!node.params) {
        return;
      }
      let changed = false;
      Object.entries(node.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        if (targetId === id) {
          delete node.params[key];
          changed = true;
        }
      });
      if (changed && Object.keys(node.params).length === 0) {
        delete node.params;
      }
    });

    store.emit('nodes:updated', store.state.nodes);
    store.emit('connections:updated');
    store.saveHistory();
  }

  updateNodePosition(id, x, y) {
    if (store.state.nodes[id]) {
      store.state.nodes[id].x = x;
      store.state.nodes[id].y = y;
      store.setLastActiveNode(id);
      store.emit('node:moved', { id, x, y });
    }
  }

  updateNodeContent(id, content) {
    if (store.state.nodes[id]) {
      store.state.nodes[id].content = content;
      store.setLastActiveNode(id);
      store.emit('node:contentUpdated', { id, content });
      
      // Debounce history saving for content
      clearTimeout(this.contentTimeout);
      this.contentTimeout = setTimeout(() => {
        store.saveHistory();
      }, 1000);
    }
  }
}

export const nodeManager = new NodeManager();
