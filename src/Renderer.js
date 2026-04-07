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
    this.connectionRouteCache = new Map();

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
    store.on('navigation:updated', (payload) => {
      if (payload?.action === 'enter') {
        window.requestAnimationFrame(() => {
          this.fitGraphToViewport();
        });
      }
    });
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
    this.applyCurrentDepthTheme();
    this.updateFolderNavigationUI();
    this.renderAllNodes();
    this.renderConnections();
    this.renderMinimap();
    this.updatePortReveal();
    this.syncSelectionState();
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

  setupMinimapEvents() {
    if (!this.minimap) return;

    const updateFromPointer = (event) => {
      this.dragViewportFromMinimapPoint(event.clientX, event.clientY);
    };

    this.minimap.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
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
    
    // Draw all active connections from nodes.params
    Object.values(store.state.nodes).forEach(sourceNode => {
      if (!sourceNode.params) return;
      
      Object.entries(sourceNode.params).forEach(([key, linkValue]) => {
        const targetId = typeof linkValue === 'string' ? linkValue : linkValue?.targetId;
        const sourcePortSide = typeof linkValue === 'string' ? 'right' : linkValue?.sourcePort || 'right';
        const targetPortSide = typeof linkValue === 'string' ? 'left' : linkValue?.targetPort || 'left';
        const targetNode = store.state.nodes[targetId];
        if (targetNode) {
          const sourceRect = this.getNodeWorldRect(sourceNode.id);
          const targetRect = this.getNodeWorldRect(targetNode.id);
          const sourcePoint = this.getPortWorldPoint(sourceNode.id, sourcePortSide) || this.getNodeCenterWorldPoint(sourceNode);
          const targetPoint = this.getPortWorldPoint(targetNode.id, targetPortSide) || this.getNodeCenterWorldPoint(targetNode);
          const sX = sourcePoint.x;
          const sY = sourcePoint.y;
          const tX = targetPoint.x;
          const tY = targetPoint.y;
          this.drawOrthogonalPath(sX, sY, tX, tY, key, sourceNode.id, targetNode.id, sourcePortSide, targetPortSide, sourceRect, targetRect);
        }
      });
    });
  }

  compressOrthogonalPoints(points = []) {
    const filtered = [];

    points.forEach((point) => {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        return;
      }

      const previous = filtered[filtered.length - 1];
      if (previous && previous.x === point.x && previous.y === point.y) {
        return;
      }

      filtered.push({ x: point.x, y: point.y });
    });

    if (filtered.length < 3) {
      return filtered;
    }

    const compacted = [filtered[0]];
    for (let index = 1; index < filtered.length - 1; index += 1) {
      const prev = compacted[compacted.length - 1];
      const current = filtered[index];
      const next = filtered[index + 1];
      const sameX = prev.x === current.x && current.x === next.x;
      const sameY = prev.y === current.y && current.y === next.y;
      if (sameX || sameY) {
        continue;
      }
      compacted.push(current);
    }

    compacted.push(filtered[filtered.length - 1]);
    return compacted;
  }

  buildRoundedOrthogonalPath(points = [], radius = 18) {
    const compacted = this.compressOrthogonalPoints(points);
    if (compacted.length < 2) {
      return '';
    }

    const parts = [`M ${compacted[0].x} ${compacted[0].y}`];

    for (let index = 1; index < compacted.length - 1; index += 1) {
      const prev = compacted[index - 1];
      const current = compacted[index];
      const next = compacted[index + 1];

      const dirIn = {
        x: Math.sign(current.x - prev.x),
        y: Math.sign(current.y - prev.y),
      };
      const dirOut = {
        x: Math.sign(next.x - current.x),
        y: Math.sign(next.y - current.y),
      };

      const isCorner = dirIn.x !== dirOut.x || dirIn.y !== dirOut.y;
      if (!isCorner) {
        parts.push(`L ${current.x} ${current.y}`);
        continue;
      }

      const lenIn = Math.hypot(current.x - prev.x, current.y - prev.y);
      const lenOut = Math.hypot(next.x - current.x, next.y - current.y);
      const cornerRadius = Math.max(6, Math.min(radius, lenIn / 2, lenOut / 2));
      const tangentIn = {
        x: current.x - (dirIn.x * cornerRadius),
        y: current.y - (dirIn.y * cornerRadius),
      };
      const tangentOut = {
        x: current.x + (dirOut.x * cornerRadius),
        y: current.y + (dirOut.y * cornerRadius),
      };
      const cross = (dirIn.x * dirOut.y) - (dirIn.y * dirOut.x);
      const sweepFlag = cross > 0 ? 1 : 0;

      parts.push(`L ${tangentIn.x} ${tangentIn.y}`);
      parts.push(`A ${cornerRadius} ${cornerRadius} 0 0 ${sweepFlag} ${tangentOut.x} ${tangentOut.y}`);
    }

    const last = compacted[compacted.length - 1];
    parts.push(`L ${last.x} ${last.y}`);
    return parts.join(' ');
  }

  drawOrthogonalPath(sX, sY, tX, tY, key, sourceId, targetId, sourcePortSide, targetPortSide, sourceRect = null, targetRect = null) {
    const labelText = String(key ?? '').trim();
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "connection-path");

    const getPortDirectionVector = (side) => {
      switch (side) {
        case 'top':
          return { x: 0, y: -1 };
        case 'bottom':
          return { x: 0, y: 1 };
        case 'left':
          return { x: -1, y: 0 };
        case 'right':
        default:
          return { x: 1, y: 0 };
      }
    };

    const sourceVector = getPortDirectionVector(sourcePortSide);
    const targetVector = getPortDirectionVector(targetPortSide);
    const distance = Math.max(1, Math.hypot(tX - sX, tY - sY));
    const exitDistance = Math.max(18, Math.min(56, distance * 0.09));
    const routePadding = Math.max(14, Math.min(24, Math.round(distance * 0.04)));
    const sourceIsHorizontal = sourceVector.x !== 0;
    const targetIsHorizontal = targetVector.x !== 0;
    const sourceBounds = sourceRect || { left: sX, right: sX, top: sY, bottom: sY };
    const targetBounds = targetRect || { left: tX, right: tX, top: tY, bottom: tY };
    const sourceExit = {
      x: sX + (sourceVector.x * exitDistance),
      y: sY + (sourceVector.y * exitDistance),
    };
    const targetEntry = {
      x: tX + (targetVector.x * exitDistance),
      y: tY + (targetVector.y * exitDistance),
    };

    const measureRoute = (points = []) => points.reduce((total, point, index) => {
      if (index === 0) {
        return 0;
      }
      const previous = points[index - 1];
      return total + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);

    const routeKey = `${sourceId}|${sourcePortSide}|${targetId}|${targetPortSide}|${labelText}`;
    const candidates = [];
    const isInsidePaddedRect = (point, rect) => point.x >= (rect.left - routePadding)
      && point.x <= (rect.right + routePadding)
      && point.y >= (rect.top - routePadding)
      && point.y <= (rect.bottom + routePadding);
    const makeRoutePoints = (innerPoints = []) => [
      { x: sX, y: sY },
      sourceExit,
      ...innerPoints,
      targetEntry,
      { x: tX, y: tY },
    ];
    const scoreRoute = (points) => {
      let score = measureRoute(points);
      for (let index = 1; index < points.length - 1; index += 1) {
        const point = points[index];
        if (isInsidePaddedRect(point, sourceBounds) || isInsidePaddedRect(point, targetBounds)) {
          score += 100000;
          break;
        }
      }
      return score;
    };
    const addCandidate = (name, innerPoints) => {
      const points = makeRoutePoints(innerPoints);
      candidates.push({
        name,
        points,
        score: scoreRoute(points),
      });
    };

    if (sourceIsHorizontal && targetIsHorizontal) {
      addCandidate('direct-source-y', [
        { x: sourceExit.x, y: targetEntry.y },
      ]);
      addCandidate('direct-target-y', [
        { x: targetEntry.x, y: sourceExit.y },
      ]);
      const aboveY = Math.min(sourceBounds.top, targetBounds.top) - routePadding;
      const belowY = Math.max(sourceBounds.bottom, targetBounds.bottom) + routePadding;
      addCandidate('above', [
        { x: sourceExit.x, y: aboveY },
        { x: targetEntry.x, y: aboveY },
      ]);
      addCandidate('below', [
        { x: sourceExit.x, y: belowY },
        { x: targetEntry.x, y: belowY },
      ]);
    } else if (!sourceIsHorizontal && !targetIsHorizontal) {
      addCandidate('direct-source-x', [
        { x: sourceExit.x, y: targetEntry.y },
      ]);
      addCandidate('direct-target-x', [
        { x: targetEntry.x, y: sourceExit.y },
      ]);
      const leftX = Math.min(sourceBounds.left, targetBounds.left) - routePadding;
      const rightX = Math.max(sourceBounds.right, targetBounds.right) + routePadding;
      addCandidate('left', [
        { x: leftX, y: sourceExit.y },
        { x: leftX, y: targetEntry.y },
      ]);
      addCandidate('right', [
        { x: rightX, y: sourceExit.y },
        { x: rightX, y: targetEntry.y },
      ]);
    } else if (sourceIsHorizontal && !targetIsHorizontal) {
      addCandidate('direct-a', [
        { x: sourceExit.x, y: targetEntry.y },
      ]);
      addCandidate('direct-b', [
        { x: targetEntry.x, y: sourceExit.y },
      ]);
      const routeX = sourceVector.x > 0
        ? Math.max(sourceBounds.right, targetBounds.right) + routePadding
        : Math.min(sourceBounds.left, targetBounds.left) - routePadding;
      addCandidate('detour-x', [
        { x: routeX, y: sourceExit.y },
        { x: routeX, y: targetEntry.y },
      ]);
    } else {
      addCandidate('direct-a', [
        { x: sourceExit.x, y: targetEntry.y },
      ]);
      addCandidate('direct-b', [
        { x: targetEntry.x, y: sourceExit.y },
      ]);
      const routeY = sourceVector.y > 0
        ? Math.max(sourceBounds.bottom, targetBounds.bottom) + routePadding
        : Math.min(sourceBounds.top, targetBounds.top) - routePadding;
      addCandidate('detour-y', [
        { x: sourceExit.x, y: routeY },
        { x: targetEntry.x, y: routeY },
      ]);
    }

    const routeCandidates = candidates
      .filter((candidate) => Array.isArray(candidate.points) && candidate.points.length >= 2)
      .sort((a, b) => a.score - b.score || a.points.length - b.points.length || a.name.localeCompare(b.name));
    const bestCandidate = routeCandidates[0] || {
      name: 'fallback',
      points: makeRoutePoints([]),
      score: Infinity,
    };
    const previousCandidate = this.connectionRouteCache.get(routeKey);
    const switchMargin = Math.max(8, Math.round(distance * 0.05));
    let selectedCandidate = bestCandidate;
    if (previousCandidate) {
      const cachedCandidate = routeCandidates.find((candidate) => candidate.name === previousCandidate.name);
      if (cachedCandidate && cachedCandidate.score <= bestCandidate.score + switchMargin) {
        selectedCandidate = cachedCandidate;
      }
    }
    this.connectionRouteCache.set(routeKey, {
      name: selectedCandidate.name,
      score: selectedCandidate.score,
    });

    const routePoints = selectedCandidate.points;
    const d = this.buildRoundedOrthogonalPath(routePoints, Math.max(10, Math.min(26, Math.round(distance * 0.06))));
    path.setAttribute("d", d);
    this.svgLayer.appendChild(path);

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

    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "connection-label-group");

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

  getContentBounds(padding = 160) {
    const nodes = Object.values(store.state.nodes);

    if (!nodes.length) {
      return {
        minX: -600,
        minY: -450,
        width: 1200,
        height: 900,
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

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return {
        minX: -600,
        minY: -450,
        width: 1200,
        height: 900,
      };
    }

    return {
      minX: minX - padding,
      minY: minY - padding,
      width: Math.max(1, (maxX - minX) + (padding * 2)),
      height: Math.max(1, (maxY - minY) + (padding * 2)),
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
      nodeEl.className = `minimap-node${node.type === 'folder' ? ' is-folder' : ''}`;
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
