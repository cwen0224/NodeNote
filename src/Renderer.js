/**
 * Renderer.js
 * Listens to state changes and updates the DOM, Canvas grid, and SVG layer.
 * 100% decoupled from user input handling.
 */
import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import { connectionManager } from './ConnectionManager.js';
import { resolveNodeSize } from './core/nodeSizing.js';
import { MAX_FOLDER_DEPTH, getFolderTheme, folderThemeToCssVars } from './core/folderTheme.js';
import {
  computeContentBounds,
  computeGraphBounds,
  computeMinimapLayout,
  computeViewportWorldRect,
  projectMinimapPointToWorld,
  projectViewportRectToMinimap,
  projectWorldPointToMinimap,
} from './core/minimapGeometry.js';
import {
  buildRoundedOrthogonalPath as buildRoundedOrthogonalPathFromPoints,
  selectOrthogonalRoute,
} from './core/connectionGeometry.js';
import { resolveConnectionPortSides } from './core/connectionData.js';

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
    this.visibilityCheckRaf = null;
    this.pendingVisibilityCheck = false;
    this.connectionRouteCache = new Map();
    this.pendingOrphanConnections = [];
    this.orphanBlockDragCleanup = null;

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
    store.on('document:updated', () => this.scheduleVisibilityCheck());
    store.on('navigation:updated', (payload) => {
      if (payload?.action === 'enter') {
        window.requestAnimationFrame(() => {
          this.fitGraphToViewport();
        });
        return;
      }

      if (payload?.action === 'restore' || payload?.action === 'reset' || payload?.action === 'normalize') {
        this.scheduleVisibilityCheck();
      }
    });
    store.on('nodes:updated', () => {
      this.scheduleVisibilityCheck();
      this.renderAll();
    });
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

    store.on('node:titleUpdated', ({ id, title }) => {
      const nodeEl = document.querySelector(`.node[data-id="${id}"] .node-id`);
      if (nodeEl) {
        const fallback = store.state.nodes?.[id]?.content || id;
        const nextLabel = String(title || '').trim() || String(fallback || id || '');
        nodeEl.textContent = nextLabel;
        nodeEl.setAttribute('title', nextLabel);
      }
    });

    this.viewport?.addEventListener('pointermove', (e) => {
      const now = performance.now();
      store.setLastPointer(e.clientX, e.clientY);
      this.pointerState = {
        previous: this.pointerState.current,
        current: { x: e.clientX, y: e.clientY, at: now },
      };
      if (e.pointerType !== 'touch') {
        this.schedulePortRevealUpdate();
      }
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
    this.applyCurrentDepthTheme();
    this.updateFolderNavigationUI();
    this.renderAllNodes();
    this.renderConnections();
    this.renderMinimap();
    this.updatePortReveal();
    this.syncSelectionState();
    this.scheduleVisibilityCheck();
  }

  escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  getNodeLabel(node) {
    if (typeof nodeManager?.getNodeLabel === 'function') {
      return nodeManager.getNodeLabel(node);
    }

    if (!node || typeof node !== 'object') {
      return '';
    }

    return String(node.title || node.content || node.id || '').trim();
  }

  applyCurrentDepthTheme() {
    const depth = store.getCurrentDepth?.() ?? (store.state.navigation?.path?.length ?? 0);
    const theme = getFolderTheme(depth);
    const cssVars = folderThemeToCssVars(theme);
    const root = document.documentElement;
    Object.entries(cssVars).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });
    root.dataset.folderDepth = String(depth);
  }

  updateFolderNavigationUI() {
    const backButton = document.getElementById('btn-folder-back');
    const groupButton = document.getElementById('btn-folder-group');
    const breadcrumb = document.getElementById('folder-breadcrumb');
    const path = store.getCurrentDocumentPath?.() || [];
    const currentDepth = path.length;

    if (backButton) {
      backButton.disabled = currentDepth === 0;
      backButton.title = currentDepth === 0 ? '已在最外層' : '返回上一層資料夾';
    }

    if (groupButton) {
      groupButton.disabled = currentDepth >= MAX_FOLDER_DEPTH;
      groupButton.title = currentDepth >= MAX_FOLDER_DEPTH ? '已達最深層，無法再建立資料夾' : '將目前選取節點群組成資料夾';
    }

    if (!breadcrumb) {
      return;
    }

    const crumbItems = ['Root'];

    path.forEach((folderId) => {
      const folderNode = store.document?.folders?.[folderId];
      const label = folderNode?.name || folderNode?.title || folderNode?.summary || folderId || 'Folder';
      crumbItems.push(label);
    });

    breadcrumb.innerHTML = crumbItems
      .map((label, index) => {
        const isRoot = index === 0;
        const isCurrent = index === crumbItems.length - 1;
        const className = [
          'folder-crumb',
          isRoot ? 'folder-crumb-root' : '',
          isCurrent ? 'is-current' : '',
        ].filter(Boolean).join(' ');
        return `<button type="button" class="${className}" data-depth="${index}" title="${this.escapeHtml(label)}">${this.escapeHtml(label)}</button>`;
      })
      .join('<span class="folder-crumb-sep">/</span>');

    breadcrumb.querySelectorAll('.folder-crumb').forEach((button) => {
      button.addEventListener('click', () => {
        const depth = Number(button.dataset.depth);
        if (!Number.isInteger(depth)) {
          return;
        }

        if (depth <= 0) {
          store.goToRoot();
          return;
        }

        store.goToDepth(depth);
      });
    });

    window.requestAnimationFrame(() => {
      const currentCrumb = breadcrumb.querySelector('.folder-crumb.is-current');
      if (currentCrumb) {
        currentCrumb.scrollIntoView({ block: 'nearest', inline: 'end', behavior: 'auto' });
        return;
      }
      breadcrumb.scrollLeft = breadcrumb.scrollWidth;
    });
  }

  scheduleMinimapRender() {
    if (!this.minimap || this.minimapRaf) return;

    this.minimapRaf = window.requestAnimationFrame(() => {
      this.minimapRaf = null;
      this.renderMinimap();
    });
  }

  scheduleVisibilityCheck() {
    if (this.visibilityCheckRaf) {
      return;
    }

    this.pendingVisibilityCheck = true;
    this.visibilityCheckRaf = window.requestAnimationFrame(() => {
      this.visibilityCheckRaf = null;
      if (!this.pendingVisibilityCheck) {
        return;
      }

      this.pendingVisibilityCheck = false;
      if (!this.shouldAutoFitGraph()) {
        return;
      }

      this.fitGraphToViewport();
    });
  }

  shouldAutoFitGraph() {
    if (!this.viewport) {
      return false;
    }

    const nodeEls = Array.from(document.querySelectorAll('.node'));
    if (!nodeEls.length) {
      return true;
    }

    const viewportRect = this.viewport.getBoundingClientRect();
    const minReadableSize = 56;
    let visibleCount = 0;
    let readableCount = 0;

    nodeEls.forEach((nodeEl) => {
      const rect = nodeEl.getBoundingClientRect();
      const intersects = !(rect.right < viewportRect.left
        || rect.left > viewportRect.right
        || rect.bottom < viewportRect.top
        || rect.top > viewportRect.bottom);
      if (!intersects) {
        return;
      }

      visibleCount += 1;
      if (Math.max(rect.width, rect.height) >= minReadableSize) {
        readableCount += 1;
      }
    });

    if (!visibleCount) {
      return true;
    }

    if (!readableCount) {
      return true;
    }

    return false;
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
    const isFolderNode = node.type === 'folder';
    const nodeLabel = this.getNodeLabel(node) || node.id;
    const folderTheme = isFolderNode ? getFolderTheme(node.depth ?? (store.getCurrentDepth?.() ?? 0)) : null;

    div.className = `node glass-panel${isFolderNode ? ' is-folder' : ''}`;
    div.dataset.id = node.id;
    div.dataset.type = node.type || 'note';
    if (isFolderNode && folderTheme) {
      div.dataset.folderDepth = String(node.depth ?? 0);
      const cssVars = folderThemeToCssVars(folderTheme);
      Object.entries(cssVars).forEach(([key, value]) => {
        div.style.setProperty(key, value);
      });
      div.style.setProperty('--folder-accent', folderTheme.accent);
    }
    div.style.left = `${node.x}px`;
    div.style.top = `${node.y}px`;
    if (isFolderNode) {
      div.innerHTML = `
        <div class="node-header">
          <span class="node-id" title="${this.escapeHtml(nodeLabel)}">${this.escapeHtml(nodeLabel)}</span>
          <div class="node-header-actions">
            <button class="node-rename-btn" type="button" aria-label="編輯名稱">Aa</button>
            <button class="node-folder-open-btn" type="button" aria-label="開啟資料夾">↗</button>
          </div>
        </div>
        <div class="node-content node-folder-content" contenteditable="false" spellcheck="false"></div>
        <button class="node-delete-btn" type="button" aria-label="刪除節點">×</button>
        <div class="port top"></div>
        <div class="port bottom"></div>
        <div class="port left"></div>
        <div class="port right"></div>
      `;
    } else {
      div.innerHTML = `
        <div class="node-header">
          <span class="node-id" title="${this.escapeHtml(nodeLabel)}">${this.escapeHtml(nodeLabel)}</span>
          <div class="node-header-actions">
            <button class="node-rename-btn" type="button" aria-label="編輯名稱">Aa</button>
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
    }

    // Internal Events (preventing panning/zooming while interacting with a node)
    const content = div.querySelector('.node-content');
    const titleEl = div.querySelector('.node-id');
    if (content) {
      content.textContent = node.content ?? '';
    }
    this.applyNodeSizing(div, node);

    const renameTitle = () => {
      const currentTitle = String(node.title || '').trim() || node.id;
      const nextTitle = window.prompt(
        isFolderNode ? '輸入資料夾名稱' : '輸入節點名稱',
        currentTitle
      );
      if (nextTitle === null) {
        return;
      }

      nodeManager.updateNodeTitle(node.id, nextTitle);
    };

    const focusContent = () => {
      if (!content || isFolderNode) {
        return;
      }

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

    if (content && !isFolderNode) {
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
    }

    if (titleEl) {
      titleEl.classList.add('node-title-editable');
      titleEl.addEventListener('mousedown', (e) => e.stopPropagation());
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        renameTitle();
      });
    }

    const renameBtn = div.querySelector('.node-rename-btn');
    renameBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    renameBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      renameTitle();
    });

    const editBtn = div.querySelector('.node-edit-btn');
    editBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    editBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      focusContent();
    });

    const openBtn = div.querySelector('.node-folder-open-btn');
    openBtn?.addEventListener('mousedown', (e) => e.stopPropagation());
    openBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      store.enterFolder(node.id);
    });

    if (isFolderNode) {
      div.addEventListener('dblclick', (e) => {
        if (e.target.closest('.node-delete-btn') || e.target.closest('.node-folder-open-btn') || e.target.closest('.port')) {
          return;
        }
        e.stopPropagation();
        store.enterFolder(node.id);
      });
    }

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
    this.pendingOrphanConnections = [];
    
    // Draw all active connections from nodes.params
    Object.values(store.state.nodes).forEach(sourceNode => {
      if (!sourceNode.params) return;
      
      Object.entries(sourceNode.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        const sourcePortSide = typeof linkValue === 'string' ? 'right' : linkValue?.sourcePort || 'right';
        const targetPortSide = typeof linkValue === 'string' ? 'left' : linkValue?.targetPort || 'left';
        const targetNode = store.state.nodes[targetId];
        const sourceRect = this.getNodeWorldRect(sourceNode.id);
        const targetRect = targetNode ? this.getNodeWorldRect(targetNode.id) : null;
        const resolvedSides = resolveConnectionPortSides(sourceRect, targetRect, sourcePortSide, targetPortSide);
        const effectiveSourceSide = resolvedSides.sourcePortSide;
        const effectiveTargetSide = resolvedSides.targetPortSide;
        const sourcePoint = this.getPortWorldPoint(sourceNode.id, effectiveSourceSide) || this.getNodeCenterWorldPoint(sourceNode);
        const targetPoint = targetNode
          ? (this.getPortWorldPoint(targetNode.id, effectiveTargetSide) || this.getNodeCenterWorldPoint(targetNode))
          : (linkValue && typeof linkValue === 'object' && linkValue.orphanedTargetCenter && typeof linkValue.orphanedTargetCenter === 'object'
            ? {
              x: Number(linkValue.orphanedTargetCenter.x) || sourcePoint.x,
              y: Number(linkValue.orphanedTargetCenter.y) || sourcePoint.y,
            }
            : {
              x: sourcePoint.x + 160,
              y: sourcePoint.y,
            });
        const sX = sourcePoint.x;
        const sY = sourcePoint.y;
        const tX = targetPoint.x;
        const tY = targetPoint.y;
        this.drawOrthogonalPath(
          sX,
          sY,
          tX,
          tY,
          key,
          sourceNode.id,
          targetNode ? targetNode.id : null,
          effectiveSourceSide,
          effectiveTargetSide,
          sourceRect,
          targetRect
        );
      });
    });

    this.renderOrphanConnectionNodes();
  }

  buildRoundedOrthogonalPath(points = [], radius = 18) {
    return buildRoundedOrthogonalPathFromPoints(points, radius);
  }

  drawOrthogonalPath(sX, sY, tX, tY, key, sourceId, targetId, sourcePortSide, targetPortSide, sourceRect = null, targetRect = null) {
    const labelText = String(key ?? '').trim();
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "connection-path");
    const routeKey = `${sourceId}|${sourcePortSide}|${targetId}|${targetPortSide}|${labelText}`;
    const route = selectOrthogonalRoute({
      sX,
      sY,
      tX,
      tY,
      sourcePortSide,
      targetPortSide,
      sourceBounds: sourceRect,
      targetBounds: targetRect,
      previousCandidate: this.connectionRouteCache.get(routeKey),
    });
    this.connectionRouteCache.set(routeKey, route.selectedCandidate);

    const d = buildRoundedOrthogonalPathFromPoints(route.routePoints, Math.max(10, Math.min(26, Math.round(route.distance * 0.06))));
    path.setAttribute("d", d);
    this.svgLayer.appendChild(path);

    this.appendConnectionDirectionTrail(path, route);

    let labelPoint = {
      x: (sX + tX) / 2,
      y: (sY + tY) / 2,
    };
    try {
      const totalLength = path.getTotalLength?.();
      if (Number.isFinite(totalLength) && totalLength > 0 && typeof path.getPointAtLength === 'function') {
        const midPoint = path.getPointAtLength(totalLength / 2);
        if (midPoint && Number.isFinite(midPoint.x) && Number.isFinite(midPoint.y)) {
          labelPoint = {
            x: midPoint.x,
            y: midPoint.y,
          };
        }
      }
    } catch {
      // If SVG measurement fails, fall back to the geometric midpoint.
    }

    if (!targetId) {
      this.pendingOrphanConnections.push({
        sourceId,
        key,
        labelText,
        x: tX,
        y: tY,
        sourcePortSide: sourcePortSide || 'right',
        targetPortSide: targetPortSide || 'left',
        sourceRect,
        targetRect,
      });
      return;
    }

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "connection-label-group");
    group.dataset.sourceId = sourceId || '';
    group.dataset.connectionKey = key || '';

    const midX = labelPoint.x;
    const midY = labelPoint.y;
    const labelWidth = Math.max(58, Math.min(192, labelText.length * 12 + 34));
    const labelHeight = 29;
    const labelLeft = midX - labelWidth / 2;
    const labelTop = midY - labelHeight / 2;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(labelLeft));
    rect.setAttribute("y", String(labelTop));
    rect.setAttribute("width", String(labelWidth));
    rect.setAttribute("height", String(labelHeight));
    rect.setAttribute("rx", "16");
    rect.setAttribute("ry", "16");
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
      deleteCircle.setAttribute("r", isHovered ? "11" : "8");
      deleteText.setAttribute("font-size", isHovered ? "13" : "11");
    };

    const hitCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hitCircle.setAttribute("cx", "0");
    hitCircle.setAttribute("cy", "0");
    hitCircle.setAttribute("r", "17");
    hitCircle.setAttribute("class", "connection-delete-btn-hit");

    const deleteCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    deleteCircle.setAttribute("cx", "0");
    deleteCircle.setAttribute("cy", "0");
    deleteCircle.setAttribute("r", "8");
    deleteCircle.setAttribute("class", "connection-delete-btn-box");

    const deleteText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    deleteText.setAttribute("x", "0");
    deleteText.setAttribute("y", "0.75");
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

  renderOrphanConnectionNodes() {
    if (!this.nodeLayer) return;

    this.nodeLayer.querySelectorAll('.orphan-connection-node').forEach((el) => el.remove());
    if (!this.pendingOrphanConnections.length) {
      return;
    }

    this.pendingOrphanConnections.forEach((entry) => {
      const nodeEl = document.createElement('div');
      const width = Math.max(140, Math.min(240, entry.labelText.length * 10 + 74));
      const height = 66;
      nodeEl.className = 'orphan-connection-node is-orphaned';
      nodeEl.dataset.orphanSourceId = entry.sourceId || '';
      nodeEl.dataset.orphanConnectionKey = entry.key || '';
      nodeEl.dataset.orphanSourcePortSide = entry.sourcePortSide || 'right';
      nodeEl.dataset.orphanTargetPortSide = entry.targetPortSide || 'left';
      nodeEl.style.width = `${width}px`;
      nodeEl.style.height = `${height}px`;
      nodeEl.style.left = `${Math.round(entry.x - width / 2)}px`;
      nodeEl.style.top = `${Math.round(entry.y - height / 2)}px`;
      nodeEl.innerHTML = `
        <input class="orphan-connection-input" type="text" value="${this.escapeHtml(entry.labelText)}" aria-label="連線名稱" spellcheck="false" />
        <div class="port right connection-orphan-port"></div>
      `;

      const portEl = nodeEl.querySelector('.connection-orphan-port');
      const inputEl = nodeEl.querySelector('.orphan-connection-input');
      if (inputEl) {
        inputEl.addEventListener('focus', () => {
          window.requestAnimationFrame(() => inputEl.select?.());
        });
        inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            inputEl.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            inputEl.value = entry.labelText;
            inputEl.blur();
          }
        });
        inputEl.addEventListener('blur', () => {
          const nextKey = String(inputEl.value || '').trim();
          if (!nextKey || nextKey === entry.labelText) {
            inputEl.value = entry.labelText;
            return;
          }
          connectionManager.renameConnectionKey(entry.sourceId, entry.key, nextKey);
        });
      }

      this.nodeLayer.appendChild(nodeEl);
    });
  }

  appendConnectionDirectionTrail(path, route) {
    if (!this.svgLayer || !path || typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function') {
      return;
    }

    let totalLength = 0;
    try {
      totalLength = path.getTotalLength();
    } catch {
      return;
    }

    if (!Number.isFinite(totalLength) || totalLength < 90) {
      return;
    }

    const trail = document.createElementNS("http://www.w3.org/2000/svg", "g");
    trail.setAttribute("class", "connection-flow-trail");

    const minSpacing = Math.max(28, Math.min(48, Math.round((route?.distance || totalLength) * 0.12)));
    const startOffset = Math.min(24, Math.max(12, Math.round(minSpacing * 0.45)));
    const endOffset = Math.min(24, Math.max(12, Math.round(minSpacing * 0.45)));
    const sampleDelta = Math.max(6, Math.min(14, Math.round(minSpacing * 0.25)));

    for (let offset = startOffset; offset < totalLength - endOffset; offset += minSpacing) {
      let currentPoint = null;
      let nextPoint = null;
      try {
        currentPoint = path.getPointAtLength(offset);
        nextPoint = path.getPointAtLength(Math.min(totalLength, offset + sampleDelta));
      } catch {
        continue;
      }

      if (!currentPoint || !nextPoint) {
        continue;
      }

      const dx = nextPoint.x - currentPoint.x;
      const dy = nextPoint.y - currentPoint.y;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);

      const arrow = document.createElementNS("http://www.w3.org/2000/svg", "text");
      arrow.setAttribute("class", "connection-flow-arrow");
      arrow.setAttribute("x", String(currentPoint.x));
      arrow.setAttribute("y", String(currentPoint.y + 0.5));
      arrow.setAttribute("text-anchor", "middle");
      arrow.setAttribute("dominant-baseline", "middle");
      arrow.setAttribute("transform", `rotate(${angle} ${currentPoint.x} ${currentPoint.y})`);
      arrow.textContent = '>';
      trail.appendChild(arrow);
    }

    if (trail.childNodes.length > 0) {
      this.svgLayer.appendChild(trail);
    }
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

  getNodeWorldRect(nodeId) {
    const nodeEl = document.querySelector(`.node[data-id="${nodeId}"]`);
    if (!nodeEl) {
      return null;
    }

    const rect = nodeEl.getBoundingClientRect();
    const { x, y, scale } = store.getTransform();
    return {
      left: (rect.left - x) / scale,
      top: (rect.top - y) / scale,
      right: (rect.right - x) / scale,
      bottom: (rect.bottom - y) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
      centerX: ((rect.left + rect.width / 2) - x) / scale,
      centerY: ((rect.top + rect.height / 2) - y) / scale,
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
    return computeGraphBounds({
      nodes: Object.values(store.state.nodes),
      measureNodeSize: (node) => this.getNodeWorldSize(node),
      viewportRect: this.getViewportWorldRect(),
      padding: 160,
      viewportPadding: 160,
    });
  }

  getContentBounds(padding = 160) {
    return computeContentBounds({
      nodes: Object.values(store.state.nodes),
      measureNodeSize: (node) => this.getNodeWorldSize(node),
      padding,
    });
  }

  getViewportWorldRect() {
    const { x, y, scale } = store.getTransform();
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;

    return computeViewportWorldRect({
      x,
      y,
      scale,
      viewportWidth,
      viewportHeight,
    });
  }

  computeMinimapLayout() {
    if (!this.minimap) return null;

    const minimapRect = this.minimap.getBoundingClientRect();
    const layout = computeMinimapLayout({
      containerWidth: minimapRect.width,
      containerHeight: minimapRect.height,
      bounds: this.getGraphBounds(),
      padding: this.minimapPadding,
    });

    this.minimapLayout = layout;

    return layout;
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
      nodeEl.className = `minimap-node${node.type === 'folder' ? ' is-folder' : ''}`;
      if (node.id === store.state.entryNodeId) {
        nodeEl.classList.add('is-entry');
      }

      const projected = projectWorldPointToMinimap({ x: node.x, y: node.y }, layout);
      const left = projected?.left ?? 0;
      const top = projected?.top ?? 0;
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
    const viewportRect = computeViewportWorldRect({
      x,
      y,
      scale,
      viewportWidth,
      viewportHeight,
    });
    const projected = projectViewportRectToMinimap({
      viewportRect,
      layout: currentLayout,
      minSize: 18,
    });

    if (!projected) {
      return;
    }

    this.minimapViewport.style.left = `${projected.left}px`;
    this.minimapViewport.style.top = `${projected.top}px`;
    this.minimapViewport.style.width = `${projected.width}px`;
    this.minimapViewport.style.height = `${projected.height}px`;
  }

  getMinimapWorldPoint(clientX, clientY) {
    const layout = this.minimapLayout ?? this.computeMinimapLayout();
    if (!layout || !this.minimap) return null;

    const minimapRect = this.minimap.getBoundingClientRect();
    return projectMinimapPointToWorld({
      clientX,
      clientY,
      minimapRect,
      layout,
      padding: this.minimapPadding,
    });
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

  getViewportZoomAnchorPoint(clientX = null, clientY = null) {
    const pointer = store.state.interaction?.lastPointer;
    const fallbackX = this.viewport?.clientWidth ? this.viewport.clientWidth / 2 : window.innerWidth / 2;
    const fallbackY = this.viewport?.clientHeight ? this.viewport.clientHeight / 2 : window.innerHeight / 2;

    return {
      clientX: Number.isFinite(clientX) ? clientX : (Number.isFinite(pointer?.x) ? pointer.x : fallbackX),
      clientY: Number.isFinite(clientY) ? clientY : (Number.isFinite(pointer?.y) ? pointer.y : fallbackY),
    };
  }

  zoomViewportToScale(nextScale, clientX = null, clientY = null) {
    const { x, y, scale } = store.getTransform();
    const { clientX: anchorX, clientY: anchorY } = this.getViewportZoomAnchorPoint(clientX, clientY);
    const clampedScale = Math.max(0.1, Math.min(5, nextScale));
    const worldX = (anchorX - x) / scale;
    const worldY = (anchorY - y) / scale;
    const nextX = anchorX - (worldX * clampedScale);
    const nextY = anchorY - (worldY * clampedScale);

    store.setTransform(nextX, nextY, clampedScale);
  }

  zoomViewportByFactor(factor, clientX = null, clientY = null) {
    const { scale } = store.getTransform();
    this.zoomViewportToScale(scale * factor, clientX, clientY);
  }

  zoomViewportIn(clientX = null, clientY = null) {
    this.zoomViewportByFactor(1.15, clientX, clientY);
  }

  zoomViewportOut(clientX = null, clientY = null) {
    this.zoomViewportByFactor(1 / 1.15, clientX, clientY);
  }

  resetViewportToActualSize() {
    this.zoomViewportToScale(1);
  }

  fitGraphToViewport() {
    const bounds = this.getContentBounds(160);
    const viewportWidth = this.viewport?.clientWidth ?? window.innerWidth;
    const viewportHeight = this.viewport?.clientHeight ?? window.innerHeight;
    const minScale = 0.1;
    const maxScale = 5;
    const scale = Math.max(
      minScale,
      Math.min(
        maxScale,
        Math.min(
          viewportWidth / Math.max(1, bounds.width),
          viewportHeight / Math.max(1, bounds.height),
        ) * 0.92,
      ),
    );

    const centerX = bounds.minX + (bounds.width / 2);
    const centerY = bounds.minY + (bounds.height / 2);
    const nextX = (viewportWidth / 2) - (centerX * scale);
    const nextY = (viewportHeight / 2) - (centerY * scale);

    store.setTransform(nextX, nextY, scale);
    return { x: nextX, y: nextY, scale };
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
