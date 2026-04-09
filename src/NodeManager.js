/**
 * NodeManager.js
 * Handles node lifecycle: creation, removal, dragging, and content updates.
 */
import { store } from './StateStore.js';
import { createDefaultFolder } from './core/documentSchema.js';
import { createNodeId, materializeClipboardPayload } from './core/graphClipboard.js';
import { resolveNodeSize } from './core/nodeSizing.js';
import { MAX_FOLDER_DEPTH } from './core/folderTheme.js';
import { computeNodesBounds } from './core/selectionGeometry.js';
import {
  createUniqueParamKey,
  deepClone,
  getNodeLabel,
  isPlainObject,
} from './core/connectionData.js';

const isTouchLikePointer = (event) => event?.pointerType === 'touch' || event?.pointerType === 'pen';

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
    this.dragPointerId = null;
    this.contentTimeout = null;
  }

  getNodeBounds(nodes = {}, nodeIds = []) {
    return computeNodesBounds(nodes, nodeIds, (node) => resolveNodeSize(node));
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
      if (e.target.closest('.orphan-connection-node')) return;
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

      if (e.target.closest('.node-title-editable')) {
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

    this.nodeLayer.addEventListener('pointerdown', (e) => {
      if (!isTouchLikePointer(e)) {
        return;
      }

      this.handleTouchNodePointerDown(e);
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

    window.addEventListener('pointermove', (e) => {
      if (!isTouchLikePointer(e) || !this.isDraggingNode || e.pointerId !== this.dragPointerId) {
        return;
      }

      if (!this.dragStartPointer || !this.dragStartPositions.size) {
        return;
      }

      e.preventDefault();
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
    }, { passive: false });

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

    const endTouchDrag = (e) => {
      if (!isTouchLikePointer(e) || e.pointerId !== this.dragPointerId) {
        return;
      }

      e.preventDefault();

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

      this.dragPointerId = null;
    };

    window.addEventListener('pointerup', endTouchDrag);
    window.addEventListener('pointercancel', endTouchDrag);
  }

  handleTouchNodePointerDown(e) {
    const nodeEl = e.target.closest('.node');
    if (!nodeEl) return;
    if (e.target.closest('.orphan-connection-node')) return;
    if (e.target.closest('.port')) return;
    if (e.target.closest('.node-edit-btn')) return;
    if (e.target.closest('.node-folder-open-btn')) return;
    if (e.target.closest('.node-delete-btn')) return;
    if (e.target.closest('.node-content') && nodeEl.classList.contains('is-editing')) return;

    const contentEl = e.target.closest('.node-content');
    const contentIsScrollable = Boolean(contentEl)
      && (contentEl.scrollHeight > contentEl.clientHeight + 1 || contentEl.scrollWidth > contentEl.clientWidth + 1);
    if (contentEl && contentIsScrollable) {
      this.selectNodeForInteraction(nodeEl.dataset.id, false);
      store.setLastActiveNode(nodeEl.dataset.id);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const nodeId = nodeEl.dataset.id;
    const currentSelectionIds = [...new Set(store.state.selection?.nodeIds || [])].filter((id) => store.state.nodes[id]);
    const isNodeSelected = currentSelectionIds.includes(nodeId);

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
    this.dragPointerId = e.pointerId;

    this.dragSelectionIds.forEach((id) => {
      const dragNode = document.querySelector(`.node[data-id="${id}"]`);
      if (dragNode) {
        dragNode.classList.add('dragging');
      }
    });

    try {
      nodeEl.setPointerCapture?.(e.pointerId);
    } catch {
      // Ignore capture failures on unsupported elements.
    }

    e.preventDefault();
    e.stopPropagation();
  }

  createNode(x, y) {
    const existingIds = new Set([
      ...Object.keys(store.document.nodes || {}),
      ...Object.keys(store.document.folders || {}),
    ]);
    const id = createNodeId(existingIds);
    const folderId = typeof store.getCurrentFolderId === 'function'
      ? store.getCurrentFolderId()
      : (store.document.rootFolderId || 'folder_root');
    const size = resolveNodeSize({ content: '' });
    const node = {
      id,
      type: 'note',
      folderId,
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
    
    store.addNodeToFolder(node, folderId);
    store.setSelectionNodeIds([id]);
    store.setLastActiveNode(id);
    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.saveHistory();
  }

  groupSelectionIntoFolder() {
    const currentDocument = typeof store.getCurrentDocument === 'function'
      ? store.getCurrentDocument()
      : null;
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
    const folderTitleSource = getNodeLabel(currentDocument.nodes[selectedIds[0]]);
    const folderTitle = folderTitleSource ? `Folder · ${folderTitleSource.slice(0, 24)}` : 'Folder';
    const summaryText = `${selectedIds.length} nodes`;
    const existingIds = new Set([
      ...Object.keys(store.document.nodes || {}),
      ...Object.keys(store.document.folders || {}),
    ]);
    const folderNodeId = createNodeId(existingIds, 'folder');
    const folderParams = {};
    const boundaryLinks = {
      incoming: [],
      outgoing: [],
    };

    const currentFolderId = typeof store.getCurrentFolderId === 'function'
      ? store.getCurrentFolderId()
      : (store.document.rootFolderId || 'folder_root');
    const currentFolder = store.getFolderRecord?.(currentFolderId) || store.document.folders?.[currentFolderId];
    const folderNode = createDefaultFolder({
      id: folderNodeId,
      parentFolderId: currentFolderId,
      name: folderTitle,
      depth: currentDepth + 1,
      colorIndex: currentDepth + 1,
    });
    folderNode.title = folderTitle;
    folderNode.content = `${summaryText}`;
    folderNode.summary = `${summaryText} · 0 links`;
    folderNode.x = selectionBounds.minX - margin;
    folderNode.y = selectionBounds.minY - margin;
    folderNode.params = {};
    folderNode.boundaryLinks = boundaryLinks;
    folderNode.sourceNodeIds = selectedIds;
    folderNode.entryNodeId = selectedIds[0] || null;
    folderNode.children = [];

    store.addFolderToFolder(folderNode, currentFolderId);

    selectedIds.forEach((nodeId) => {
      const sourceNode = currentDocument.nodes[nodeId];
      if (!sourceNode) {
        return;
      }

      if (isPlainObject(sourceNode.params)) {
        Object.entries(sourceNode.params).forEach(([key, linkValue]) => {
          const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
          if (!targetId) {
            return;
          }

          const sourcePort = typeof linkValue === 'object' && linkValue ? (linkValue.sourcePort || 'right') : 'right';
          const targetPort = typeof linkValue === 'object' && linkValue ? (linkValue.targetPort || 'left') : 'left';

          if (selectedSet.has(targetId)) {
            folderNode.children.push(sourceNode.type === 'folder'
              ? { kind: 'folder', id: nodeId }
              : { kind: 'node', id: nodeId });
            return;
          }

          const folderKey = createUniqueParamKey(folderParams, key);
          folderParams[folderKey] = {
            targetId,
            sourcePort,
            targetPort,
            originNodeId: nodeId,
            originKey: key,
          };
          delete sourceNode.params[key];
          boundaryLinks.outgoing.push({
            sourceNodeId: nodeId,
            key,
            targetId,
            sourcePort,
            targetPort,
          });
        });
      }

      if (sourceNode.type === 'folder') {
        store.moveFolderToFolder(nodeId, folderNodeId);
      } else {
        store.moveNodeToFolder(nodeId, folderNodeId);
      }
    });

    Object.values(currentDocument.nodes).forEach((node) => {
      if (!node || selectedSet.has(node.id) || !isPlainObject(node.params)) {
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
          ...(typeof linkValue === 'object' && linkValue ? deepClone(linkValue) : {}),
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

    folderNode.summary = `${summaryText} · ${boundaryLinks.incoming.length + boundaryLinks.outgoing.length} links`;
    folderNode.content = folderNode.summary;
    folderNode.params = folderParams;
    folderNode.boundaryLinks = boundaryLinks;
    folderNode.size = resolveNodeSize(folderNode);
    const side = Math.max(
      folderNode.size.width,
      folderNode.size.height,
      selectionBounds.width + margin * 2,
      selectionBounds.height + margin * 2,
    );
    folderNode.size = {
      width: side,
      height: side,
    };
    folderNode.x = (selectionBounds.minX + (selectionBounds.width / 2)) - (side / 2);
    folderNode.y = (selectionBounds.minY + (selectionBounds.height / 2)) - (side / 2);

    if (currentFolder && selectedSet.has(currentFolder.entryNodeId)) {
      currentFolder.entryNodeId = folderNodeId;
    }

    store.setSelectionNodeIds([folderNodeId]);
    store.setLastActiveNode(folderNodeId);
    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  ungroupSelectionFromFolder() {
    const currentDocument = typeof store.getCurrentDocument === 'function'
      ? store.getCurrentDocument()
      : null;
    if (!currentDocument || !currentDocument.nodes) {
      return false;
    }

    const selectedIds = [...new Set((Array.isArray(store.state.selection?.nodeIds) ? store.state.selection.nodeIds : [])
      .filter((id) => currentDocument.nodes[id] && currentDocument.nodes[id].type === 'folder'))];
    const fallbackActive = store.state.interaction?.lastActiveNodeId;
    if (!selectedIds.length && fallbackActive && currentDocument.nodes[fallbackActive]?.type === 'folder') {
      selectedIds.push(fallbackActive);
    }

    if (!selectedIds.length) {
      return false;
    }

    const rootFolderId = typeof store.getRootFolderId === 'function'
      ? store.getRootFolderId()
      : (store.document.rootFolderId || 'folder_root');
    const allEntities = () => ({
      ...(store.document.nodes || {}),
      ...(store.document.folders || {}),
    });

    const restoreIncomingLinks = (folderId) => {
      Object.values(allEntities()).forEach((entity) => {
        if (!isPlainObject(entity?.params)) {
          return;
        }

        Object.entries(entity.params).forEach(([key, linkValue]) => {
          if (!isPlainObject(linkValue)) {
            return;
          }

          if (linkValue.targetId !== folderId || !linkValue.groupedTargetId) {
            return;
          }

          entity.params[key] = {
            ...deepClone(linkValue),
            targetId: linkValue.groupedTargetId,
          };
          delete entity.params[key].groupedTargetId;
        });
      });
    };

    const restoreOutgoingLinks = (folder) => {
      if (!isPlainObject(folder?.params)) {
        return;
      }

      Object.entries(folder.params).forEach(([key, linkValue]) => {
        if (!isPlainObject(linkValue)) {
          return;
        }

        const sourceNodeId = linkValue.originNodeId;
        if (!sourceNodeId) {
          return;
        }

        const originKey = typeof linkValue.originKey === 'string' && linkValue.originKey.trim()
          ? linkValue.originKey.trim()
          : key;
        const sourceNode = store.document.nodes?.[sourceNodeId] || store.document.folders?.[sourceNodeId];
        if (!sourceNode) {
          return;
        }

        if (!isPlainObject(sourceNode.params)) {
          sourceNode.params = {};
        }

        const restoredLink = deepClone(linkValue);
        delete restoredLink.originNodeId;
        delete restoredLink.originKey;
        sourceNode.params[originKey] = restoredLink;
      });
    };

    let changed = false;

    selectedIds.forEach((folderId) => {
      const folder = store.document.folders?.[folderId];
      if (!folder || folderId === rootFolderId) {
        return;
      }

      const parentFolderId = folder.parentFolderId || rootFolderId;
      const parentFolder = store.document.folders?.[parentFolderId] || store.document.folders?.[rootFolderId];

      restoreIncomingLinks(folderId);
      restoreOutgoingLinks(folder);

      const children = Array.isArray(folder.children) ? [...folder.children] : [];
      children.forEach((child) => {
        if (child.kind === 'folder') {
          store.moveFolderToFolder(child.id, parentFolderId);
        } else if (child.kind === 'node') {
          store.moveNodeToFolder(child.id, parentFolderId);
        }
      });

      if (parentFolder && Array.isArray(parentFolder.children)) {
        parentFolder.children = parentFolder.children.filter((child) => !(child.kind === 'folder' && child.id === folderId));
      }

      if (parentFolder?.entryNodeId === folderId) {
        const replacement = children.find((child) => child.kind === 'node')?.id
          || children.find((child) => child.kind === 'folder')?.id
          || null;
        parentFolder.entryNodeId = replacement;
      }

      delete store.document.folders[folderId];
      changed = true;
    });

    if (!changed) {
      return false;
    }

    const remainingSelection = (store.state.selection?.nodeIds || [])
      .filter((id) => !selectedIds.includes(id));
    store.setSelectionNodeIds(remainingSelection);
    store.setLastActiveNode(remainingSelection[0] || store.getCurrentDocument().entryNodeId || null);
    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  deleteNode(id) {
    return this.deleteNodes([id]);
  }

  deleteNodes(ids = []) {
    const currentDocument = typeof store.getCurrentDocument === 'function'
      ? store.getCurrentDocument()
      : null;
    const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && currentDocument?.nodes?.[id]))];
    if (!uniqueIds.length) {
      return false;
    }

    const deletedEntities = new Map();
    uniqueIds.forEach((id) => {
      const entity = store.getEntityById?.(id) || currentDocument.nodes[id] || currentDocument.folders?.[id];
      if (entity) {
        deletedEntities.set(id, deepClone(entity));
      }
    });

    uniqueIds.forEach((id) => {
      const entity = store.getEntityById?.(id) || currentDocument.nodes[id];
      if (entity?.type === 'folder') {
        store.removeFolderRecursive(id);
      } else {
        store.removeNodeFromFolder(id);
      }
    });

    const allEntities = {
      ...(store.document.nodes || {}),
      ...(store.document.folders || {}),
    };

    Object.values(allEntities).forEach((node) => {
      if (!node.params) {
        return;
      }

      let changed = false;
      Object.entries(node.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        if (uniqueIds.includes(targetId)) {
          if (node && !uniqueIds.includes(node.id)) {
            const deletedTarget = deletedEntities.get(targetId);
            const deletedSize = resolveNodeSize(deletedTarget);
            const orphanedTargetCenter = {
              x: (deletedTarget?.x || 0) + (deletedSize.width / 2),
              y: (deletedTarget?.y || 0) + (deletedSize.height / 2),
            };
            node.params[key] = {
              ...(isPlainObject(linkValue) ? linkValue : {}),
              targetId: null,
              orphanedTargetId: targetId,
              orphanedTargetCenter,
              orphanedTargetLabel: getNodeLabel(deletedTarget),
            };
            changed = true;
            return;
          }
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
      const fallbackId = nextSelection[0]
        || Object.keys(store.getCurrentDocument().nodes || {})[0]
        || null;
      store.setLastActiveNode(fallbackId);
    }

    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  updateNodePosition(id, x, y) {
    const entity = store.getEntityById?.(id);
    if (entity) {
      entity.x = x;
      entity.y = y;
      store.setLastActiveNode(id);
      store.emit('node:moved', { id, x, y });
    }
  }

  updateNodeTitle(id, title) {
    const entity = store.getEntityById?.(id);
    if (!entity) {
      return false;
    }

    const nextTitle = String(title ?? '').trim();
    entity.title = nextTitle;
    if (entity.type === 'folder') {
      entity.name = nextTitle;
    }

    store.setLastActiveNode(id);
    store.emit('node:titleUpdated', { id, title: nextTitle });
    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.saveHistory();
    return true;
  }

  updateNodeContent(id, content) {
    const entity = store.getEntityById?.(id);
    if (entity) {
      entity.content = content;
      if (entity.type === 'folder') {
        entity.summary = content;
      }
      const size = resolveNodeSize(entity);
      entity.size = {
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
    const existingIds = new Set([
      ...Object.keys(store.document.nodes || {}),
      ...Object.keys(store.document.folders || {}),
    ]);
    const materialized = materializeClipboardPayload(fragment, {
      anchorWorldPoint: anchorWorldPoint || this.getPasteAnchorWorldPoint(),
      existingNodeIds: existingIds,
    });

    if (!materialized || !Object.keys(materialized.nodes).length) {
      return null;
    }

    const currentFolderId = typeof store.getCurrentFolderId === 'function'
      ? store.getCurrentFolderId()
      : (store.document.rootFolderId || 'folder_root');

    const folderEntries = [];
    const nodeEntries = [];

    Object.entries(materialized.nodes).forEach(([nodeId, node]) => {
      if (node?.type === 'folder') {
        folderEntries.push([nodeId, node]);
        return;
      }

      nodeEntries.push([nodeId, node]);
    });

    const pendingFolders = folderEntries.slice();
    const insertedFolderIds = new Set();

    while (pendingFolders.length) {
      let progress = false;

      for (let index = pendingFolders.length - 1; index >= 0; index -= 1) {
        const [nodeId, node] = pendingFolders[index];
        const parentFolderId = typeof node.parentFolderId === 'string' && node.parentFolderId
          ? node.parentFolderId
          : currentFolderId;
        if (parentFolderId !== currentFolderId
          && !insertedFolderIds.has(parentFolderId)
          && !store.document.folders?.[parentFolderId]) {
          continue;
        }

        const folderRecord = createDefaultFolder({
          id: nodeId,
          parentFolderId,
          name: node.title || node.content || nodeId,
          depth: (store.getFolderRecord?.(parentFolderId)?.depth ?? store.getCurrentDepth()) + 1,
          colorIndex: (store.getFolderRecord?.(parentFolderId)?.depth ?? store.getCurrentDepth()) + 1,
        });
        folderRecord.title = node.title || node.content || nodeId;
        folderRecord.content = node.content || '';
        folderRecord.summary = node.content || '';
        folderRecord.x = node.x;
        folderRecord.y = node.y;
        folderRecord.size = node.size || folderRecord.size;
        folderRecord.params = deepClone(node.params || {});
        folderRecord.children = Array.isArray(node.children) ? deepClone(node.children) : [];
        folderRecord.entryNodeId = node.entryNodeId || folderRecord.entryNodeId;
        folderRecord.boundaryLinks = deepClone(node.boundaryLinks || []);
        folderRecord.sourceNodeIds = deepClone(node.sourceNodeIds || []);
        store.addFolderToFolder(folderRecord, parentFolderId);
        insertedFolderIds.add(nodeId);
        pendingFolders.splice(index, 1);
        progress = true;
      }
 
      if (!progress) {
        break;
      }
    }

    pendingFolders.forEach(([nodeId, node]) => {
      const parentFolderId = typeof node.parentFolderId === 'string' && node.parentFolderId
        ? node.parentFolderId
        : currentFolderId;
      const folderRecord = createDefaultFolder({
        id: nodeId,
        parentFolderId: store.document.folders?.[parentFolderId] ? parentFolderId : currentFolderId,
        name: node.title || node.content || nodeId,
        depth: (store.getFolderRecord?.(parentFolderId)?.depth ?? store.getCurrentDepth()) + 1,
        colorIndex: (store.getFolderRecord?.(parentFolderId)?.depth ?? store.getCurrentDepth()) + 1,
      });
      folderRecord.title = node.title || node.content || nodeId;
      folderRecord.content = node.content || '';
      folderRecord.summary = node.content || '';
      folderRecord.x = node.x;
      folderRecord.y = node.y;
      folderRecord.size = node.size || folderRecord.size;
      folderRecord.params = deepClone(node.params || {});
      folderRecord.children = Array.isArray(node.children) ? deepClone(node.children) : [];
      folderRecord.entryNodeId = node.entryNodeId || folderRecord.entryNodeId;
      folderRecord.boundaryLinks = deepClone(node.boundaryLinks || []);
      folderRecord.sourceNodeIds = deepClone(node.sourceNodeIds || []);
      store.addFolderToFolder(folderRecord, folderRecord.parentFolderId);
      insertedFolderIds.add(nodeId);
    });

    nodeEntries.forEach(([nodeId, node]) => {
      const nextNode = {
        ...node,
        folderId: typeof node.folderId === 'string' && node.folderId ? node.folderId : currentFolderId,
      };
      if (!store.document.folders?.[nextNode.folderId]) {
        nextNode.folderId = currentFolderId;
      }
      store.addNodeToFolder(nextNode, nextNode.folderId);
    });

    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.emit('connections:updated');
    store.setSelectionNodeIds(materialized.rootNodeIds.length ? materialized.rootNodeIds : materialized.nodeIds);
    store.setLastActiveNode(materialized.rootNodeIds[0] || materialized.nodeIds[0] || null);
    store.saveHistory();
    return materialized;
  }
}

export const nodeManager = new NodeManager();

