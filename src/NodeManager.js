/**
 * NodeManager.js
 * Handles node lifecycle: creation, removal, dragging, and content updates.
 */
import { store } from './StateStore.js';
import { createNodeId, materializeClipboardPayload } from './core/graphClipboard.js';
import { resolveNodeSize } from './core/nodeSizing.js';

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

      const contentEl = e.target.closest('.node-content');
      const contentIsScrollable = Boolean(contentEl)
        && (contentEl.scrollHeight > contentEl.clientHeight + 1 || contentEl.scrollWidth > contentEl.clientWidth + 1);
      if (contentEl && contentIsScrollable) {
        this.selectNodeForInteraction(nodeEl.dataset.id, e.shiftKey);
        store.setLastActiveNode(nodeEl.dataset.id);
        e.stopPropagation();
        return;
      }

      // Handle dragging
      if (e.button === 0 && !e.shiftKey) {
        this.isDraggingNode = true;
        this.draggedNodeId = nodeEl.dataset.id;
        this.selectNodeForInteraction(nodeEl.dataset.id, e.shiftKey);
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
    const id = createNodeId(new Set(Object.keys(store.state.nodes)));
    const size = resolveNodeSize({ content: '' });
    const node = {
      id,
      x,
      y,
      content: '',
      size: {
        width: size.width,
        height: size.height,
      },
      params: {}
    };
    
    store.state.nodes[id] = node;
    store.setSelectionNodeIds([id]);
    store.setLastActiveNode(id);
    store.emit('nodes:updated', store.state.nodes);
    store.saveHistory();
  }

  deleteNode(id) {
    return this.deleteNodes([id]);
  }

  deleteNodes(ids = []) {
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && store.state.nodes[id]))];
    if (!uniqueIds.length) {
      return false;
    }

    uniqueIds.forEach((id) => {
      delete store.state.nodes[id];
    });

    Object.values(store.state.nodes).forEach((node) => {
      if (!node.params) {
        return;
      }

      let changed = false;
      Object.entries(node.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        if (uniqueIds.includes(targetId)) {
          delete node.params[key];
          changed = true;
        }
      });

      if (changed && Object.keys(node.params).length === 0) {
        delete node.params;
      }
    });

    const nextSelection = (store.state.selection?.nodeIds || []).filter((id) => !uniqueIds.includes(id));
    store.setSelectionNodeIds(nextSelection);

    if (uniqueIds.includes(store.state.interaction?.lastActiveNodeId)) {
      store.setLastActiveNode(nextSelection[0] || Object.keys(store.state.nodes)[0] || null);
    }

    store.emit('nodes:updated', store.state.nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
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
      const size = resolveNodeSize({ content });
      store.state.nodes[id].size = {
        width: size.width,
        height: size.height,
      };
      store.setLastActiveNode(id);
      store.emit('node:contentUpdated', { id, content });
      
      // Debounce history saving for content
      clearTimeout(this.contentTimeout);
      this.contentTimeout = setTimeout(() => {
        store.saveHistory();
      }, 1000);
    }
  }

  selectNodeForInteraction(nodeId, additive = false) {
    if (!nodeId) {
      return;
    }

    if (additive) {
      const current = new Set(store.state.selection?.nodeIds || []);
      if (current.has(nodeId)) {
        current.delete(nodeId);
      } else {
        current.add(nodeId);
      }
      store.setSelectionNodeIds([...current]);
      return;
    }

    store.setSelectionNodeIds([nodeId]);
  }

  getPasteAnchorWorldPoint() {
    const pointer = store.state.interaction?.lastPointer;
    const { x, y, scale } = store.getTransform();
    const viewportRect = this.viewport?.getBoundingClientRect?.();
    const clientX = Number.isFinite(pointer?.x) ? pointer.x : (viewportRect ? viewportRect.left + viewportRect.width / 2 : window.innerWidth / 2);
    const clientY = Number.isFinite(pointer?.y) ? pointer.y : (viewportRect ? viewportRect.top + viewportRect.height / 2 : window.innerHeight / 2);

    return {
      x: (clientX - x) / scale,
      y: (clientY - y) / scale,
    };
  }

  insertFragment(fragment, anchorWorldPoint = null) {
    const existingIds = new Set(Object.keys(store.state.nodes));
    const materialized = materializeClipboardPayload(fragment, {
      anchorWorldPoint: anchorWorldPoint || this.getPasteAnchorWorldPoint(),
      existingNodeIds: existingIds,
    });

    if (!materialized || !Object.keys(materialized.nodes).length) {
      return null;
    }

    Object.entries(materialized.nodes).forEach(([nodeId, node]) => {
      store.state.nodes[nodeId] = node;
    });

    store.emit('nodes:updated', store.state.nodes);
    store.emit('connections:updated');
    store.setSelectionNodeIds(materialized.rootNodeIds.length ? materialized.rootNodeIds : materialized.nodeIds);
    store.setLastActiveNode(materialized.rootNodeIds[0] || materialized.nodeIds[0] || null);
    store.saveHistory();
    return materialized;
  }
}

export const nodeManager = new NodeManager();
