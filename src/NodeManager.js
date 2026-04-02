/**
 * NodeManager.js
 * Handles node lifecycle: creation, removal, dragging, and content updates.
 */
import { store } from './StateStore.js';
import { createDefaultDocument } from './core/documentSchema.js';
import { createNodeId, materializeClipboardPayload } from './core/graphClipboard.js';
import { resolveNodeSize } from './core/nodeSizing.js';
import { MAX_FOLDER_DEPTH } from './core/folderTheme.js';

class NodeManager {
  constructor() {
    this.viewport = null;
    this.nodeLayer = null;
    this.isDraggingNode = false;
    this.draggedNodeId = null;
    this.dragSelectionIds = [];
    this.dragStartPointer = null;
    this.dragStartPositions = new Map();
    this.dragOffset = { x: 0, y: 0 };
    this.contentTimeout = null;
  }

  cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  buildEdgesFromNodes(nodes = {}) {
    const edges = [];

    Object.entries(this.isPlainObject(nodes) ? nodes : {}).forEach(([sourceId, node]) => {
      if (!this.isPlainObject(node?.params)) {
        return;
      }

      Object.entries(node.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        if (!targetId || !nodes[targetId]) {
          return;
        }

        edges.push({
          id: `${sourceId}_${key}_${targetId}`,
          kind: 'flow',
          key,
          label: key,
          fromNodeId: sourceId,
          fromPortId: typeof linkValue === 'object' && linkValue ? (linkValue.sourcePort || 'right') : 'right',
          toNodeId: targetId,
          toPortId: typeof linkValue === 'object' && linkValue ? (linkValue.targetPort || 'left') : 'left',
        });
      });
    });

    return edges;
  }

  getNodeLabel(node) {
    if (!node || typeof node !== 'object') {
      return '';
    }

    return String(node.title || node.content || node.id || '').trim();
  }

  createUniqueParamKey(params = {}, baseKey = 'link') {
    const normalizedBase = String(baseKey || 'link').trim() || 'link';
    if (!Object.prototype.hasOwnProperty.call(params, normalizedBase)) {
      return normalizedBase;
    }

    let suffix = 2;
    let candidate = `${normalizedBase}_${suffix}`;
    while (Object.prototype.hasOwnProperty.call(params, candidate)) {
      suffix += 1;
      candidate = `${normalizedBase}_${suffix}`;
    }
    return candidate;
  }

  getNodeBounds(nodes = {}, nodeIds = []) {
    const ids = (Array.isArray(nodeIds) && nodeIds.length > 0)
      ? nodeIds.filter((id) => nodes[id])
      : Object.keys(nodes || {});

    if (!ids.length) {
      return {
        minX: 0,
        minY: 0,
        width: 320,
        height: 320,
      };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    ids.forEach((id) => {
      const node = nodes[id];
      if (!node) {
        return;
      }

      const size = resolveNodeSize(node);
      minX = Math.min(minX, Number(node.x) || 0);
      minY = Math.min(minY, Number(node.y) || 0);
      maxX = Math.max(maxX, (Number(node.x) || 0) + size.width);
      maxY = Math.max(maxY, (Number(node.y) || 0) + size.height);
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return {
        minX: 0,
        minY: 0,
        width: 320,
        height: 320,
      };
    }

    return {
      minX,
      minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
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
      if (e.target.closest('.node-folder-open-btn')) return;
      if (e.target.closest('.node-delete-btn')) return;
      if (e.target.closest('.node-content') && nodeEl.classList.contains('is-editing')) return;

      const contentEl = e.target.closest('.node-content');
      const contentIsScrollable = Boolean(contentEl)
        && (contentEl.scrollHeight > contentEl.clientHeight + 1 || contentEl.scrollWidth > contentEl.clientWidth + 1);
      if (contentEl && contentIsScrollable) {
        this.selectNodeForInteraction(nodeEl.dataset.id, e.ctrlKey || e.metaKey);
        store.setLastActiveNode(nodeEl.dataset.id);
        e.stopPropagation();
        return;
      }

      const nodeId = nodeEl.dataset.id;
      const currentSelectionIds = [...new Set(store.state.selection?.nodeIds || [])].filter((id) => store.state.nodes[id]);
      const isNodeSelected = currentSelectionIds.includes(nodeId);

      if (e.ctrlKey || e.metaKey) {
        this.selectNodeForInteraction(nodeId, true);
        store.setLastActiveNode(nodeId);
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Handle dragging
      if (e.button === 0) {
        this.isDraggingNode = true;
        const { scale } = store.getTransform();
        this.draggedNodeId = nodeId;
        this.dragSelectionIds = (isNodeSelected && currentSelectionIds.length > 1)
          ? currentSelectionIds
          : [nodeId];
        if (!isNodeSelected || currentSelectionIds.length <= 1) {
          this.selectNodeForInteraction(nodeId, false);
        }
        store.setLastActiveNode(this.draggedNodeId);

        this.dragStartPointer = {
          x: e.clientX / scale,
          y: e.clientY / scale,
        };
        this.dragStartPositions = new Map(this.dragSelectionIds.map((id) => {
          const node = store.state.nodes[id];
          return [id, { x: node.x, y: node.y }];
        }));

        this.dragSelectionIds.forEach((id) => {
          const dragNode = document.querySelector(`.node[data-id="${id}"]`);
          if (dragNode) {
            dragNode.classList.add('dragging');
          }
        });

        e.stopPropagation();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDraggingNode && this.draggedNodeId && this.dragStartPointer && this.dragStartPositions.size) {
        const { scale } = store.getTransform();
        const currentPointer = {
          x: e.clientX / scale,
          y: e.clientY / scale,
        };
        const dx = currentPointer.x - this.dragStartPointer.x;
        const dy = currentPointer.y - this.dragStartPointer.y;
        const moveOrder = [
          ...this.dragSelectionIds.filter((id) => id !== this.draggedNodeId),
          this.draggedNodeId,
        ];

        moveOrder.forEach((id) => {
          const startPosition = this.dragStartPositions.get(id);
          if (!startPosition) {
            return;
          }

          this.updateNodePosition(id, startPosition.x + dx, startPosition.y + dy);
        });
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isDraggingNode) {
        this.isDraggingNode = false;
        this.dragSelectionIds.forEach((id) => {
          const nodeEl = document.querySelector(`.node[data-id="${id}"]`);
          if (nodeEl) nodeEl.classList.remove('dragging');
        });
        this.draggedNodeId = null;
        this.dragSelectionIds = [];
        this.dragStartPointer = null;
        this.dragStartPositions.clear();
        store.saveHistory(); // Save state after move
      }
    });
  }

  createNode(x, y) {
    const id = createNodeId(new Set(Object.keys(store.state.nodes)));
    const size = resolveNodeSize({ content: '' });
    const node = {
      id,
      type: 'note',
      title: '',
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

  groupSelectionIntoFolder() {
    const currentDocument = typeof store.getCurrentDocument === 'function'
      ? store.getCurrentDocument()
      : store.document;
    if (!currentDocument || !currentDocument.nodes) {
      return false;
    }

    const selectedIds = [...new Set((Array.isArray(store.state.selection?.nodeIds) ? store.state.selection.nodeIds : []).filter((id) => currentDocument.nodes[id]))];
    const fallbackActive = store.state.interaction?.lastActiveNodeId;
    if (!selectedIds.length && fallbackActive && currentDocument.nodes[fallbackActive]) {
      selectedIds.push(fallbackActive);
    }

    if (!selectedIds.length) {
      return false;
    }

    const currentDepth = typeof store.getCurrentDepth === 'function' ? store.getCurrentDepth() : 0;
    if (currentDepth >= MAX_FOLDER_DEPTH) {
      window.alert(`最多只能建立 ${MAX_FOLDER_DEPTH} 層資料夾。`);
      return false;
    }

    const selectedSet = new Set(selectedIds);
    const selectionBounds = this.getNodeBounds(currentDocument.nodes, selectedIds);
    const margin = 56;
    const folderTitleSource = this.getNodeLabel(currentDocument.nodes[selectedIds[0]]);
    const folderTitle = folderTitleSource ? `Folder · ${folderTitleSource.slice(0, 24)}` : 'Folder';
    const summaryText = `${selectedIds.length} nodes`;
    const folderNodeId = createNodeId(new Set(Object.keys(currentDocument.nodes)), 'folder');

    const childDocument = createDefaultDocument();
    childDocument.meta.title = folderTitle;
    childDocument.assets = this.cloneValue(currentDocument.assets || []);
    childDocument.extras = this.cloneValue(currentDocument.extras || {});
    childDocument.entryNodeId = selectedSet.has(currentDocument.entryNodeId)
      ? currentDocument.entryNodeId
      : selectedIds[0];

    const childNodes = {};
    const folderParams = {};
    const boundaryLinks = {
      incoming: [],
      outgoing: [],
    };

    selectedIds.forEach((nodeId) => {
      const sourceNode = currentDocument.nodes[nodeId];
      if (!sourceNode) {
        return;
      }

      const cloned = this.cloneValue(sourceNode);
      cloned.x = (Number(sourceNode.x) || 0) - selectionBounds.minX + margin;
      cloned.y = (Number(sourceNode.y) || 0) - selectionBounds.minY + margin;
      cloned.params = {};

      if (this.isPlainObject(sourceNode.params)) {
        Object.entries(sourceNode.params).forEach(([key, linkValue]) => {
          const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
          if (!targetId) {
            return;
          }

          const sourcePort = typeof linkValue === 'object' && linkValue ? (linkValue.sourcePort || 'right') : 'right';
          const targetPort = typeof linkValue === 'object' && linkValue ? (linkValue.targetPort || 'left') : 'left';

          if (selectedSet.has(targetId)) {
            cloned.params[key] = typeof linkValue === 'string'
              ? {
                targetId,
                sourcePort,
                targetPort,
              }
              : this.cloneValue(linkValue);
            return;
          }

          const folderKey = this.createUniqueParamKey(folderParams, key);
          folderParams[folderKey] = {
            targetId,
            sourcePort,
            targetPort,
            originNodeId: nodeId,
            originKey: key,
          };
          boundaryLinks.outgoing.push({
            sourceNodeId: nodeId,
            key,
            targetId,
            sourcePort,
            targetPort,
          });
        });
      }

      childNodes[nodeId] = cloned;
    });

    Object.values(currentDocument.nodes).forEach((node) => {
      if (!node || selectedSet.has(node.id) || !this.isPlainObject(node.params)) {
        return;
      }

      Object.entries(node.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        if (!selectedSet.has(targetId)) {
          return;
        }

        const sourcePort = typeof linkValue === 'object' && linkValue ? (linkValue.sourcePort || 'right') : 'right';
        const targetPort = typeof linkValue === 'object' && linkValue ? (linkValue.targetPort || 'left') : 'left';
        node.params[key] = {
          ...(typeof linkValue === 'object' && linkValue ? this.cloneValue(linkValue) : {}),
          targetId: folderNodeId,
          sourcePort,
          targetPort,
          groupedTargetId: targetId,
        };
        boundaryLinks.incoming.push({
          sourceNodeId: node.id,
          key,
          targetId,
          sourcePort,
          targetPort,
        });
      });
    });

    selectedIds.forEach((nodeId) => {
      delete currentDocument.nodes[nodeId];
    });

    const childEdges = this.buildEdgesFromNodes(childNodes);
    childDocument.nodes = childNodes;
    childDocument.edges = childEdges;
    childDocument.entryNodeId = childDocument.entryNodeId && childNodes[childDocument.entryNodeId]
      ? childDocument.entryNodeId
      : Object.keys(childNodes)[0] || null;

    const folderNode = {
      id: folderNodeId,
      type: 'folder',
      title: folderTitle,
      x: selectionBounds.minX - margin,
      y: selectionBounds.minY - margin,
      content: `${summaryText} · ${childEdges.length + boundaryLinks.incoming.length + boundaryLinks.outgoing.length} links`,
      size: {
        width: 0,
        height: 0,
      },
      params: {},
      folder: {
        document: childDocument,
        summary: `${summaryText} · ${childEdges.length + boundaryLinks.incoming.length + boundaryLinks.outgoing.length} links`,
        depth: currentDepth + 1,
        colorIndex: currentDepth + 1,
        collapsed: false,
        boundaryLinks,
        sourceNodeIds: selectedIds,
      },
    };

    const folderSize = resolveNodeSize(folderNode);
    const side = Math.max(
      folderSize.width,
      folderSize.height,
      selectionBounds.width + margin * 2,
      selectionBounds.height + margin * 2,
    );
    folderNode.size = {
      width: side,
      height: side,
    };
    folderNode.x = (selectionBounds.minX + (selectionBounds.width / 2)) - (side / 2);
    folderNode.y = (selectionBounds.minY + (selectionBounds.height / 2)) - (side / 2);
    folderNode.params = folderParams;

    if (selectedSet.has(currentDocument.entryNodeId)) {
      currentDocument.entryNodeId = folderNodeId;
    }

    currentDocument.nodes[folderNodeId] = folderNode;
    currentDocument.edges = this.buildEdgesFromNodes(currentDocument.nodes);

    store.setSelectionNodeIds([folderNodeId]);
    store.setLastActiveNode(folderNodeId);
    store.emit('nodes:updated', currentDocument.nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
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
