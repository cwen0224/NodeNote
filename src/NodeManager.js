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
  isDumiNodeId,
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
    this.touchTapState = {
      lastTapAt: 0,
      lastTapNodeId: null,
      timer: null,
    };
  }

  getNodeBounds(nodes = {}, nodeIds = []) {
    return computeNodesBounds(nodes, nodeIds, (node) => resolveNodeSize(node));
  }

  init() {
    this.viewport = document.getElementById('viewport');
    this.nodeLayer = document.getElementById('node-layer');
    this.setupEvents();
    store.on('document:updated', () => {
      this.pruneDanglingDumiNodes();
    });
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

      if (e.target.closest('.node-title-editable') && !nodeEl.classList.contains('is-dumi')) {
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

    window.addEventListener('mouseup', (e) => {
      this.finishNodeDrag(e, { allowMerge: true });
    });

    const endTouchDrag = (e) => {
      if (!isTouchLikePointer(e) || e.pointerId !== this.dragPointerId) {
        return;
      }

      e.preventDefault();
      this.finishNodeDrag(e, { allowMerge: e.type === 'pointerup' });
      this.dragPointerId = null;
    };

    window.addEventListener('pointerup', endTouchDrag);
    window.addEventListener('pointercancel', endTouchDrag);
  }

  handleTouchNodePointerDown(e) {
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

  finishNodeDrag(releaseEvent, { allowMerge = false } = {}) {
    if (!this.isDraggingNode) {
      return false;
    }

    const draggedNodeId = this.draggedNodeId;
    let merged = false;

    if (
      allowMerge
      && typeof draggedNodeId === 'string'
      && isDumiNodeId(draggedNodeId)
      && this.dragSelectionIds.length === 1
    ) {
      merged = this.tryMergeDraggedDumiOnRelease(releaseEvent, draggedNodeId);
    }

    const isTouchRelease = isTouchLikePointer(releaseEvent);
    if (isTouchRelease && !merged && typeof draggedNodeId === 'string' && this.dragStartPointer && Number.isFinite(releaseEvent?.clientX) && Number.isFinite(releaseEvent?.clientY)) {
      const { scale } = store.getTransform();
      const releasePoint = {
        x: releaseEvent.clientX / scale,
        y: releaseEvent.clientY / scale,
      };
      const movedDistance = Math.hypot(
        releasePoint.x - this.dragStartPointer.x,
        releasePoint.y - this.dragStartPointer.y,
      );
      if (movedDistance <= 16) {
        const now = performance.now();
        const isDoubleTap = this.touchTapState.lastTapNodeId === draggedNodeId && (now - this.touchTapState.lastTapAt) <= 360;
        if (this.touchTapState.timer) {
          window.clearTimeout(this.touchTapState.timer);
          this.touchTapState.timer = null;
        }
        if (isDoubleTap) {
          this.touchTapState.lastTapAt = 0;
          this.touchTapState.lastTapNodeId = null;
          this.activateTouchNodeEdit(draggedNodeId);
        } else {
          this.touchTapState.lastTapAt = now;
          this.touchTapState.lastTapNodeId = draggedNodeId;
          this.touchTapState.timer = window.setTimeout(() => {
            if (this.touchTapState.lastTapNodeId === draggedNodeId) {
              this.touchTapState.lastTapAt = 0;
              this.touchTapState.lastTapNodeId = null;
            }
            this.touchTapState.timer = null;
          }, 420);
        }
      } else {
        this.resetTouchTapState();
      }
    }

    this.isDraggingNode = false;
    this.dragSelectionIds.forEach((id) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"]`);
      if (nodeEl) nodeEl.classList.remove('dragging');
    });
    this.draggedNodeId = null;
    this.dragSelectionIds = [];
    this.dragStartPointer = null;
    this.dragStartPositions.clear();

    if (!merged) {
      store.saveHistory();
    }

    return merged;
  }

  activateTouchNodeEdit(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) {
      return false;
    }

    const nodeEl = document.querySelector(`.node[data-id="${nodeId}"]`);
    if (!nodeEl) {
      return false;
    }

    const contentEl = nodeEl.querySelector?.('.node-content');
    if (contentEl && !nodeEl.classList.contains('is-folder') && !nodeEl.classList.contains('is-dumi')) {
      contentEl.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
      return true;
    }

    const titleEl = nodeEl.querySelector?.('.node-id');
    if (titleEl) {
      titleEl.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
      return true;
    }

    return false;
  }

  resetTouchTapState() {
    if (this.touchTapState.timer) {
      window.clearTimeout(this.touchTapState.timer);
    }
    this.touchTapState.lastTapAt = 0;
    this.touchTapState.lastTapNodeId = null;
    this.touchTapState.timer = null;
  }

  getNodeElementAtPoint(clientX, clientY, excludedIds = []) {
    if (
      !Number.isFinite(clientX)
      || !Number.isFinite(clientY)
      || typeof document?.elementsFromPoint !== 'function'
    ) {
      return null;
    }

    const excludedSet = new Set(
      Array.isArray(excludedIds)
        ? excludedIds.filter((id) => typeof id === 'string' && id)
        : [],
    );

    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      if (!element || typeof element.closest !== 'function') {
        continue;
      }

      const nodeEl = element.closest('.node');
      if (!nodeEl) {
        continue;
      }

      const nodeId = nodeEl.dataset?.id;
      if (!nodeId || excludedSet.has(nodeId)) {
        continue;
      }

      if (nodeEl.classList.contains('is-folder') || nodeEl.classList.contains('is-dumi')) {
        continue;
      }

      return nodeEl;
    }

    return null;
  }

  tryMergeDraggedDumiOnRelease(releaseEvent, draggedNodeId) {
    if (!releaseEvent || typeof releaseEvent.clientX !== 'number' || typeof releaseEvent.clientY !== 'number') {
      return false;
    }

    const targetNodeEl = this.getNodeElementAtPoint(releaseEvent.clientX, releaseEvent.clientY, [draggedNodeId]);
    const targetNodeId = targetNodeEl?.dataset?.id;
    if (!targetNodeId || targetNodeId === draggedNodeId) {
      return false;
    }

    return this.mergeDumiIntoNode(draggedNodeId, targetNodeId);
  }

  mergeDumiIntoNode(sourceNodeId, targetNodeId) {
    const sourceNode = store.getEntityById?.(sourceNodeId);
    const targetNode = store.getEntityById?.(targetNodeId);
    if (
      !sourceNode
      || !targetNode
      || !isDumiNodeId(sourceNodeId)
      || isDumiNodeId(targetNodeId)
      || targetNode.type === 'folder'
      || sourceNodeId === targetNodeId
    ) {
      return false;
    }

    const sourceParams = isPlainObject(sourceNode.params) ? sourceNode.params : {};
    if (!isPlainObject(targetNode.params)) {
      targetNode.params = {};
    }

    const targetParams = targetNode.params;
    Object.entries(sourceParams).forEach(([key, linkValue]) => {
      const nextLink = isPlainObject(linkValue)
        ? deepClone(linkValue)
        : { targetId: linkValue };
      if (!nextLink || typeof nextLink !== 'object') {
        return;
      }

      const normalizedTargetId = typeof nextLink.targetId === 'string' && nextLink.targetId
        ? nextLink.targetId
        : (typeof linkValue === 'string' ? linkValue : null);
      if (!normalizedTargetId) {
        return;
      }

      nextLink.targetId = normalizedTargetId;
      const nextKey = createUniqueParamKey(targetParams, key);
      targetParams[nextKey] = nextLink;
    });

    const allEntities = {
      ...(store.document.nodes || {}),
      ...(store.document.folders || {}),
    };

    Object.values(allEntities).forEach((entity) => {
      if (!entity || entity.id === sourceNodeId || !isPlainObject(entity.params)) {
        return;
      }

      Object.entries(entity.params).forEach(([key, linkValue]) => {
        const targetId = isPlainObject(linkValue) ? linkValue.targetId : linkValue;
        if (targetId !== sourceNodeId) {
          return;
        }

        entity.params[key] = isPlainObject(linkValue)
          ? {
            ...deepClone(linkValue),
            targetId: targetNodeId,
          }
          : targetNodeId;
      });
    });

    const sourceFolderId = sourceNode.folderId || store.getRootFolderId?.() || store.document.rootFolderId || 'folder_root';
    const sourceFolder = store.document.folders?.[sourceFolderId];
    if (sourceFolder && Array.isArray(sourceFolder.children)) {
      sourceFolder.children = sourceFolder.children.filter((child) => !(child.kind === 'node' && child.id === sourceNodeId));
    }

    const targetFolderId = targetNode.folderId || store.getRootFolderId?.() || store.document.rootFolderId || 'folder_root';
    const targetFolder = store.document.folders?.[targetFolderId];
    if (sourceNodeId === sourceFolder?.entryNodeId) {
      sourceFolder.entryNodeId = targetNodeId;
    }
    if (targetFolder && sourceFolder && targetFolder.id === sourceFolder.id) {
      targetFolder.entryNodeId = targetFolder.entryNodeId || targetNodeId;
    }

    delete store.document.nodes[sourceNodeId];
    store.setSelectionNodeIds([targetNodeId]);
    store.setLastActiveNode(targetNodeId);
    store.emit('nodes:updated', store.getCurrentDocument().nodes);
    store.emit('connections:updated');
    store.saveHistory();
    return true;
  }

  hasNodeConnections(nodeId) {
    if (typeof nodeId !== 'string' || !nodeId) {
      return false;
    }

    const allEntities = {
      ...(store.document.nodes || {}),
      ...(store.document.folders || {}),
    };

    return Object.values(allEntities).some((entity) => {
      if (!isPlainObject(entity?.params)) {
        return false;
      }

      return Object.values(entity.params).some((linkValue) => {
        const targetId = isPlainObject(linkValue) ? linkValue.targetId : linkValue;
        return targetId === nodeId;
      });
    });
  }

  pruneDanglingDumiNodes({ skipId = null, saveHistory = true, emitChanges = true } = {}) {
    const currentDocument = typeof store.getCurrentDocument === 'function'
      ? store.getCurrentDocument()
      : null;
    if (!currentDocument?.nodes) {
      return [];
    }

    const removableIds = Object.values(currentDocument.nodes)
      .filter((node) => isDumiNodeId(node?.id) && node.id !== skipId)
      .filter((node) => !this.hasNodeConnections(node.id))
      .map((node) => node.id);

    if (!removableIds.length) {
      return [];
    }

    removableIds.forEach((nodeId) => {
      store.removeNodeFromFolder(nodeId);
    });

    if (emitChanges) {
      const nextSelection = (store.state.selection?.nodeIds || [])
        .filter((id) => !removableIds.includes(id));
      store.setSelectionNodeIds(nextSelection);

      const lastActive = store.state.interaction?.lastActiveNodeId;
      if (removableIds.includes(lastActive)) {
        const fallbackId = nextSelection[0]
          || Object.keys(store.getCurrentDocument().nodes || {})[0]
          || null;
        store.setLastActiveNode(fallbackId);
      }

      store.emit('nodes:updated', store.getCurrentDocument().nodes);
      store.emit('connections:updated');
      if (saveHistory) {
        store.saveHistory();
      }
    }

    return removableIds;
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

    const getLinkTargetId = (linkValue) => {
      if (isPlainObject(linkValue)) {
        return typeof linkValue.targetId === 'string' ? linkValue.targetId : null;
      }
      return typeof linkValue === 'string' ? linkValue : null;
    };

    const allEntities = () => ({
      ...(store.document.nodes || {}),
      ...(store.document.folders || {}),
    });

    const replaceEntityLinkTarget = (entity, fromId, toId) => {
      if (!isPlainObject(entity?.params)) {
        return false;
      }

      let changed = false;
      Object.entries(entity.params).forEach(([key, linkValue]) => {
        const targetId = getLinkTargetId(linkValue);
        if (targetId !== fromId) {
          return;
        }

        if (isPlainObject(linkValue)) {
          entity.params[key] = {
            ...deepClone(linkValue),
            targetId: toId,
          };
          if (entity.params[key].groupedTargetId === fromId) {
            entity.params[key].groupedTargetId = toId;
          }
          if (entity.params[key].originNodeId === fromId) {
            entity.params[key].originNodeId = toId;
          }
        } else {
          entity.params[key] = toId;
        }
        changed = true;
      });

      return changed;
    };

    const hasConnections = (nodeId) => Object.values(allEntities()).some((entity) => {
      if (!isPlainObject(entity?.params)) {
        return false;
      }

      return Object.values(entity.params).some((linkValue) => getLinkTargetId(linkValue) === nodeId);
    });

    const deletionIds = new Set();
    const deletionFolderIds = new Set();
    const replacementMap = new Map();

    uniqueIds.forEach((id) => {
      const entity = store.getEntityById?.(id) || currentDocument.nodes[id] || currentDocument.folders?.[id];
      if (!entity) {
        return;
      }

      if (entity.type === 'folder') {
        deletionFolderIds.add(id);
        return;
      }

      if (!isDumiNodeId(id) && hasConnections(id)) {
        const existingIds = new Set([
          ...Object.keys(store.document.nodes || {}),
          ...Object.keys(store.document.folders || {}),
          ...replacementMap.values(),
        ]);
        const nextId = createNodeId(existingIds, 'dumi');
        replacementMap.set(id, nextId);
        return;
      }

      deletionIds.add(id);
    });

    if (!deletionIds.size && !deletionFolderIds.size && !replacementMap.size) {
      return false;
    }

    replacementMap.forEach((nextId, oldId) => {
      const node = store.document.nodes?.[oldId];
      if (!node) {
        return;
      }

      const previousLabel = getNodeLabel(node) || oldId;
      const parentFolderId = node.folderId || store.getRootFolderId?.() || store.document.rootFolderId || 'folder_root';
      const parentFolder = store.document.folders?.[parentFolderId];

      node.id = nextId;
      node.title = previousLabel;
      node.content = '';
      const size = resolveNodeSize(node);
      node.size = {
        width: size.width,
        height: size.height,
      };

      store.document.nodes[nextId] = node;
      delete store.document.nodes[oldId];

      if (parentFolder && Array.isArray(parentFolder.children)) {
        parentFolder.children = parentFolder.children.map((child) => {
          if (child.kind === 'node' && child.id === oldId) {
            return { ...child, id: nextId };
          }
          return child;
        });
      }

      const folder = parentFolder;
      if (folder?.entryNodeId === oldId) {
        folder.entryNodeId = nextId;
      }
    });

    replacementMap.forEach((nextId, oldId) => {
      Object.values(allEntities()).forEach((entity) => {
        if (!entity || entity.id === nextId) {
          return;
        }
        replaceEntityLinkTarget(entity, oldId, nextId);
      });
    });

    deletionIds.forEach((id) => {
      store.removeNodeFromFolder(id);
    });

    deletionFolderIds.forEach((id) => {
      store.removeFolderRecursive(id);
    });

    const removedIds = new Set([...deletionIds, ...deletionFolderIds]);
    Object.values(allEntities()).forEach((entity) => {
      if (!isPlainObject(entity?.params)) {
        return;
      }

      let changed = false;
      Object.entries(entity.params).forEach(([key, linkValue]) => {
        const targetId = getLinkTargetId(linkValue);
        if (!removedIds.has(targetId)) {
          return;
        }

        delete entity.params[key];
        changed = true;
      });

      if (changed && Object.keys(entity.params).length === 0) {
        delete entity.params;
      }
    });

    const prunedDumiIds = this.pruneDanglingDumiNodes({ saveHistory: false, emitChanges: false });
    prunedDumiIds.forEach((id) => removedIds.add(id));

    const nextSelection = (store.state.selection?.nodeIds || [])
      .map((id) => replacementMap.get(id) || id)
      .filter((id) => !removedIds.has(id) && store.getEntityById?.(id));
    store.setSelectionNodeIds(nextSelection);

    const lastActive = store.state.interaction?.lastActiveNodeId;
    const mappedLastActive = replacementMap.get(lastActive) || lastActive;
    if (removedIds.has(mappedLastActive)) {
      const fallbackId = nextSelection[0]
        || Object.keys(store.getCurrentDocument().nodes || {})[0]
        || null;
      store.setLastActiveNode(fallbackId);
    } else if (mappedLastActive && store.getEntityById?.(mappedLastActive)) {
      store.setLastActiveNode(mappedLastActive);
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
      if (isDumiNodeId(entity.id)) {
        return false;
      }
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

