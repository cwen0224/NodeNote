import { store } from './StateStore.js';
import { collectClipboardGraph } from './core/graphClipboard.js';
import { copySelectionToAdobeClipboard } from './core/adobeClipboard.js';

const isEditableElement = (element) => (
  element instanceof Element && Boolean(element.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]'))
);

class ContextMenuManager {
  constructor() {
    this.menuEl = null;
    this.copyAdobeBtn = null;
    this.anchorNodeId = null;
    this.lastTriggerTarget = null;
    this.boundClose = this.close.bind(this);
    this.boundHandleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
    this.boundHandleKeyDown = this.handleKeyDown.bind(this);
    this.boundHandleScroll = this.close.bind(this);
  }

  init() {
    this.menuEl = document.getElementById('context-menu');
    this.copyAdobeBtn = document.getElementById('btn-copy-to-adobe');

    if (this.copyAdobeBtn) {
      this.copyAdobeBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.copyToAdobe();
      });
    }

    document.addEventListener('pointerdown', this.boundHandleDocumentPointerDown, true);
    window.addEventListener('keydown', this.boundHandleKeyDown, true);
    window.addEventListener('scroll', this.boundHandleScroll, true);
    window.addEventListener('blur', this.boundClose);
  }

  destroy() {
    document.removeEventListener('pointerdown', this.boundHandleDocumentPointerDown, true);
    window.removeEventListener('keydown', this.boundHandleKeyDown, true);
    window.removeEventListener('scroll', this.boundHandleScroll, true);
    window.removeEventListener('blur', this.boundClose);
  }

  handleDocumentPointerDown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest?.('#context-menu')) {
      return;
    }
    this.close();
  }

  handleKeyDown(event) {
    if (event.key === 'Escape') {
      this.close();
    }
  }

  getSelectionRootNodeIds(anchorNodeId = null) {
    const selectionIds = Array.isArray(store.state.selection?.nodeIds)
      ? [...new Set(store.state.selection.nodeIds.filter((id) => typeof id === 'string' && store.state.nodes[id]))]
      : [];

    if (anchorNodeId && store.state.nodes[anchorNodeId]) {
      if (selectionIds.includes(anchorNodeId) && selectionIds.length > 0) {
        return selectionIds;
      }
      return [anchorNodeId];
    }

    if (selectionIds.length > 0) {
      return selectionIds;
    }

    const activeNodeId = store.state.interaction?.lastActiveNodeId;
    if (activeNodeId && store.state.nodes[activeNodeId]) {
      return [activeNodeId];
    }

    return [];
  }

  resolveMenuTarget(event) {
    const target = event.target instanceof Element ? event.target : null;
    const nodeEl = target?.closest?.('.node');
    const nodeId = nodeEl?.dataset?.id || null;
    const rootNodeIds = this.getSelectionRootNodeIds(nodeId);

    if (!rootNodeIds.length) {
      return null;
    }

    return {
      nodeId,
      rootNodeIds,
    };
  }

  show(event) {
    if (!this.menuEl) {
      return false;
    }

    const menuTarget = this.resolveMenuTarget(event);
    if (!menuTarget) {
      return false;
    }

    this.anchorNodeId = menuTarget.nodeId;
    this.lastTriggerTarget = event.target instanceof Element ? event.target : null;
    this.menuEl.hidden = false;
    this.menuEl.classList.add('is-open');
    this.copyAdobeBtn?.removeAttribute('disabled');
    this.menuEl.dataset.nodeId = menuTarget.nodeId || '';
    this.menuEl.dataset.rootNodeIds = JSON.stringify(menuTarget.rootNodeIds);

    const menuWidth = 220;
    const menuHeight = 72;
    const x = Number.isFinite(event.clientX) ? event.clientX : 24;
    const y = Number.isFinite(event.clientY) ? event.clientY : 24;
    const left = Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12));
    const top = Math.max(12, Math.min(y, window.innerHeight - menuHeight - 12));

    this.menuEl.style.left = `${left}px`;
    this.menuEl.style.top = `${top}px`;
    return true;
  }

  close() {
    if (!this.menuEl) {
      return;
    }

    this.menuEl.classList.remove('is-open');
    this.menuEl.hidden = true;
    this.menuEl.dataset.nodeId = '';
    this.menuEl.dataset.rootNodeIds = '';
    this.anchorNodeId = null;
    this.lastTriggerTarget = null;
  }

  async copyToAdobe() {
    const rootNodeIds = this.getSelectionRootNodeIds(this.anchorNodeId);
    if (!rootNodeIds.length) {
      this.close();
      return false;
    }

    const copied = await copySelectionToAdobeClipboard(store.getCurrentDocumentSnapshot(), rootNodeIds);
    if (copied) {
      this.close();
      return true;
    }

    this.close();
    return false;
  }

  handleContextMenu(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (isEditableElement(target)) {
      return false;
    }

    const nodeMatch = target?.closest?.('.node');
    const isWorkspaceTarget = Boolean(target?.closest?.('#viewport, #canvas, #grid-bg, #svg-layer, #node-layer'));
    if (!nodeMatch && !isWorkspaceTarget) {
      return false;
    }

    return this.show(event);
  }
}

export const contextMenuManager = new ContextMenuManager();
