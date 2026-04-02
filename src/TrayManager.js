import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import {
  collectClipboardGraph,
  fragmentToClipboardText,
  normalizeClipboardPayload,
  parseClipboardText,
} from './core/graphClipboard.js';

const STORAGE_KEY = 'nodenote.tray.v1';
const MAX_SLOTS = 15;

class TrayManager {
  constructor() {
    this.traySlotsEl = null;
    this.slots = [];
    this.ready = false;
  }

  init() {
    this.traySlotsEl = document.getElementById('tray-slots');
    this.loadSlots();
    this.render();
    this.setupEvents();
    this.ready = true;
  }

  setupEvents() {
    this.traySlotsEl?.addEventListener('click', (event) => {
      const deleteButton = event.target.closest?.('.tray-slot-delete-zone');
      if (deleteButton) {
        const slotIndex = Number(deleteButton.dataset.index);
        if (Number.isInteger(slotIndex)) {
          event.preventDefault();
          event.stopPropagation();
          this.deleteSlot(slotIndex);
        }
        return;
      }

      const slotButton = event.target.closest?.('.tray-slot');
      if (!slotButton) {
        return;
      }

      const slotIndex = Number(slotButton.dataset.index);
      if (!Number.isInteger(slotIndex)) {
        return;
      }

      this.activateSlot(slotIndex);
    });

    this.traySlotsEl?.addEventListener('keydown', (event) => {
      const deleteButton = event.target.closest?.('.tray-slot-delete-zone');
      if (!deleteButton) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        const slotIndex = Number(deleteButton.dataset.index);
        if (Number.isInteger(slotIndex)) {
          event.preventDefault();
          this.deleteSlot(slotIndex);
        }
      }
    });
  }

  getSelectionRootNodeIds() {
    const selectionIds = Array.isArray(store.state.selection?.nodeIds)
      ? store.state.selection.nodeIds.filter(Boolean)
      : [];

    if (selectionIds.length > 0) {
      return selectionIds.filter((id) => Boolean(store.state.nodes[id]));
    }

    const activeNodeId = store.state.interaction?.lastActiveNodeId;
    if (activeNodeId && store.state.nodes[activeNodeId]) {
      return [activeNodeId];
    }

    return [];
  }

  buildSlotLabel(fragment) {
    const rootNodeId = fragment.rootNodeIds?.[0];
    const rootNode = rootNodeId ? fragment.nodes?.[rootNodeId] : null;
    const rawLabel = String(rootNode?.content || rootNode?.title || rootNodeId || 'Graph').trim();
    const compactLabel = rawLabel.replace(/\s+/g, ' ');
    return compactLabel ? compactLabel.slice(0, 18) : 'Graph';
  }

  buildSlotSummary(fragment) {
    const nodeCount = fragment.nodeCount ?? fragment.nodeIds?.length ?? Object.keys(fragment.nodes || {}).length;
    const edgeCount = fragment.edgeCount ?? 0;
    return `${nodeCount} nodes, ${edgeCount} links`;
  }

  loadSlots() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.slots = [];
        return;
      }

      const parsed = JSON.parse(raw);
      const loadedSlots = Array.isArray(parsed?.slots) ? parsed.slots : Array.isArray(parsed) ? parsed : [];
      this.slots = loadedSlots
        .filter((slot) => slot && typeof slot === 'object' && typeof slot.json === 'string')
        .slice(0, MAX_SLOTS)
        .map((slot, index) => ({
          id: typeof slot.id === 'string' ? slot.id : `slot_${index}`,
          label: typeof slot.label === 'string' ? slot.label : `Data ${index + 1}`,
          summary: typeof slot.summary === 'string' ? slot.summary : '',
          json: slot.json,
          createdAt: typeof slot.createdAt === 'string' ? slot.createdAt : null,
        }));
    } catch {
      this.slots = [];
    }
  }

  saveSlots() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schema: 'nodenote.tray',
        version: '1.0.0',
        slots: this.slots,
      }));
    } catch {
      // Ignore storage failures; tray still works for the current session.
    }
  }

  render() {
    if (!this.traySlotsEl) {
      return;
    }

    const fragment = document.createDocumentFragment();

    for (let index = 0; index < MAX_SLOTS; index += 1) {
      const slot = this.slots[index] || null;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tray-slot glass-panel';
      button.dataset.index = String(index);
      button.title = slot
        ? `Slot ${index + 1}: ${slot.label}\n${slot.summary}`
        : `Slot ${index + 1}: empty`;

      if (!slot) {
        button.classList.add('is-empty');
        button.innerHTML = `
          <span class="tray-slot-main">
            <span class="tray-slot-index">Data ${index + 1}</span>
            <span class="tray-slot-label">Empty</span>
            <span class="tray-slot-meta">Click to copy</span>
          </span>
          <span class="tray-slot-delete-zone is-disabled" aria-hidden="true"></span>
        `;
      } else {
        button.innerHTML = `
          <span class="tray-slot-main">
            <span class="tray-slot-index">Data ${index + 1}</span>
            <span class="tray-slot-label">${this.escapeHtml(slot.label)}</span>
            <span class="tray-slot-meta">${this.escapeHtml(slot.summary)}</span>
          </span>
          <span class="tray-slot-delete-zone" data-index="${index}" role="button" tabindex="0" aria-label="刪除托盤項目" title="刪除托盤項目">
            <span class="tray-slot-delete-mark">×</span>
          </span>
        `;
      }

      fragment.appendChild(button);
    }

    this.traySlotsEl.innerHTML = '';
    this.traySlotsEl.appendChild(fragment);
  }

  escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  pushFragment(fragment) {
    const json = fragmentToClipboardText(fragment);
    const existingIndex = this.slots.findIndex((slot) => slot.json === json);
    if (existingIndex >= 0) {
      this.slots.splice(existingIndex, 1);
    }

    this.slots.unshift({
      id: `slot_${Date.now()}`,
      label: this.buildSlotLabel(fragment),
      summary: this.buildSlotSummary(fragment),
      json,
      createdAt: new Date().toISOString(),
    });

    this.slots = this.slots.slice(0, MAX_SLOTS);
    this.saveSlots();
    this.render();
  }

  deleteSlot(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.slots.length) {
      return false;
    }

    this.slots.splice(index, 1);
    this.saveSlots();
    this.render();
    return true;
  }

  async writeTextToClipboard(text) {
    if (!text) {
      return false;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fallback below.
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }

  async readTextFromClipboard() {
    try {
      if (navigator.clipboard?.readText) {
        return await navigator.clipboard.readText();
      }
    } catch {
      return '';
    }
    return '';
  }

  async copySelectionToTray({ cut = false } = {}) {
    const rootNodeIds = this.getSelectionRootNodeIds();
    if (!rootNodeIds.length) {
      return false;
    }

    const fragment = collectClipboardGraph(store.getCurrentDocumentSnapshot(), rootNodeIds);
    if (!fragment) {
      return false;
    }

    this.pushFragment(fragment);
    await this.writeTextToClipboard(fragmentToClipboardText(fragment));

    if (cut) {
      nodeManager.deleteNodes(fragment.nodeIds);
    }

    return true;
  }

  async activateSlot(index) {
    const slot = this.slots[index];
    if (!slot?.json) {
      return false;
    }

    const written = await this.writeTextToClipboard(slot.json);
    if (written) {
      return true;
    }

    return false;
  }

  deleteSelection() {
    const rootNodeIds = this.getSelectionRootNodeIds();
    if (!rootNodeIds.length) {
      return false;
    }

    const fragment = collectClipboardGraph(store.getCurrentDocumentSnapshot(), rootNodeIds);
    if (!fragment) {
      return false;
    }

    return nodeManager.deleteNodes(fragment.nodeIds);
  }

  async pasteFromClipboard() {
    const text = await this.readTextFromClipboard();
    const parsed = parseClipboardText(text);
    const payload = normalizeClipboardPayload(parsed);
    if (!payload) {
      return false;
    }

    return Boolean(nodeManager.insertFragment(payload));
  }
}

export const trayManager = new TrayManager();
