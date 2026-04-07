/**
 * InputController.js
 * Captures user input directly and updates the state.
 */
import { store } from './StateStore.js';

class InputController {
  constructor() {
    this.isPanning = false;
    this.isSelecting = false;
    this.touchPointers = new Map();
    this.touchGesture = null;
    this.startX = 0;
    this.startY = 0;
    this.selectionStartX = 0;
    this.selectionStartY = 0;
    this.selectionCurrentX = 0;
    this.selectionCurrentY = 0;
    this.selectionAdditive = false;
    this.selectionBaselineIds = [];
    
    // Zoom configurations
    this.minScale = 0.1;
    this.maxScale = 5;
    this.zoomSpeed = 0.001;
    
    this.spacePressed = false;
  }

  init() {
    this.viewport = document.getElementById('viewport');
    this.selectionMarquee = document.getElementById('selection-marquee');
    this.setupEvents();
  }

  isBackgroundSurface(target) {
    return Boolean(target) && (
      target.id === 'viewport'
      || target.id === 'grid-bg'
      || target.id === 'svg-layer'
      || target.id === 'canvas'
    );
  }

  screenToWorld(clientX, clientY, transform = store.getTransform()) {
    const scale = Number.isFinite(transform?.scale) && transform.scale !== 0 ? transform.scale : 1;
    return {
      x: (clientX - (Number.isFinite(transform?.x) ? transform.x : 0)) / scale,
      y: (clientY - (Number.isFinite(transform?.y) ? transform.y : 0)) / scale,
    };
  }

  distanceBetweenPoints(a, b) {
    return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
  }

  midpointBetweenPoints(a, b) {
    return {
      x: ((a?.x || 0) + (b?.x || 0)) / 2,
      y: ((a?.y || 0) + (b?.y || 0)) / 2,
    };
  }

  startTouchPan(pointerId, clientX, clientY) {
    this.touchGesture = {
      type: 'pan',
      pointerId,
      startX: clientX,
      startY: clientY,
      transform: store.getTransform(),
    };
  }

  startTouchPinch() {
    if (this.touchPointers.size < 2) {
      return;
    }

    const pointerEntries = [...this.touchPointers.entries()];
    const [firstId, firstPoint] = pointerEntries[0];
    const [secondId, secondPoint] = pointerEntries[1];
    const distance = this.distanceBetweenPoints(firstPoint, secondPoint);
    if (distance < 1) {
      return;
    }

    const transform = store.getTransform();
    const midpoint = this.midpointBetweenPoints(firstPoint, secondPoint);
    this.touchGesture = {
      type: 'pinch',
      pointerIds: [firstId, secondId],
      startDistance: distance,
      startMidpoint: midpoint,
      transform,
      worldPoint: this.screenToWorld(midpoint.x, midpoint.y, transform),
    };
  }

  updateTouchPan(pointerId, clientX, clientY) {
    if (!this.touchGesture || this.touchGesture.type !== 'pan' || this.touchGesture.pointerId !== pointerId) {
      return;
    }

    const dx = clientX - this.touchGesture.startX;
    const dy = clientY - this.touchGesture.startY;
    const { x, y, scale } = this.touchGesture.transform;
    store.setTransform(x + dx, y + dy, scale);
  }

  updateTouchPinch() {
    if (!this.touchGesture || this.touchGesture.type !== 'pinch') {
      return;
    }

    const [firstId, secondId] = this.touchGesture.pointerIds;
    const firstPoint = this.touchPointers.get(firstId);
    const secondPoint = this.touchPointers.get(secondId);
    if (!firstPoint || !secondPoint) {
      return;
    }

    const currentDistance = this.distanceBetweenPoints(firstPoint, secondPoint);
    if (currentDistance < 1) {
      return;
    }

    const midpoint = this.midpointBetweenPoints(firstPoint, secondPoint);
    const startScale = Number.isFinite(this.touchGesture.transform?.scale) ? this.touchGesture.transform.scale : 1;
    let newScale = startScale * (currentDistance / this.touchGesture.startDistance);
    newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

    const newX = midpoint.x - (this.touchGesture.worldPoint.x * newScale);
    const newY = midpoint.y - (this.touchGesture.worldPoint.y * newScale);
    store.setTransform(newX, newY, newScale);
  }

  updateTouchGestureFromPointers() {
    if (this.touchPointers.size >= 2) {
      this.startTouchPinch();
      return;
    }

    if (this.touchPointers.size === 1) {
      const [pointerId, point] = this.touchPointers.entries().next().value;
      this.startTouchPan(pointerId, point.x, point.y);
      return;
    }

    this.touchGesture = null;
  }

  registerTouchPointer(event) {
    this.touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    store.setLastPointer(event.clientX, event.clientY);
  }

  handleTouchPointerDown(event) {
    if (event.pointerType === 'mouse' || !this.isBackgroundSurface(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    this.registerTouchPointer(event);

    if (this.touchPointers.size === 1) {
      store.clearSelection();
      this.startTouchPan(event.pointerId, event.clientX, event.clientY);
      return;
    }

    this.startTouchPinch();
  }

  handleTouchPointerMove(event) {
    if (event.pointerType === 'mouse' || !this.touchPointers.has(event.pointerId)) {
      return;
    }

    this.touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    store.setLastPointer(event.clientX, event.clientY);
    event.preventDefault();

    if (this.touchGesture?.type === 'pan') {
      this.updateTouchPan(event.pointerId, event.clientX, event.clientY);
      return;
    }

    if (this.touchGesture?.type === 'pinch') {
      this.updateTouchPinch();
    }
  }

  handleTouchPointerEnd(event) {
    if (event.pointerType === 'mouse') {
      return;
    }

    if (!this.touchPointers.has(event.pointerId)) {
      return;
    }

    event.preventDefault();
    this.touchPointers.delete(event.pointerId);

    if (this.touchGesture?.type === 'pan' && this.touchGesture.pointerId === event.pointerId) {
      this.touchGesture = null;
    }

    if (this.touchGesture?.type === 'pinch' && this.touchGesture.pointerIds.includes(event.pointerId)) {
      this.touchGesture = null;
    }

    this.updateTouchGestureFromPointers();
  }

  setupEvents() {
    // Track spacebar globally
    window.addEventListener('keydown', e => {
      if (e.code === 'Space') this.spacePressed = true;
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') this.spacePressed = false;
    });
    // Prevent default context menu on right click and handle panning
    window.addEventListener('contextmenu', e => {
      e.preventDefault();
    });

    this.viewport.addEventListener('pointerdown', (e) => this.handleTouchPointerDown(e));
    window.addEventListener('pointermove', (e) => this.handleTouchPointerMove(e), { passive: false });
    window.addEventListener('pointerup', (e) => this.handleTouchPointerEnd(e), { passive: false });
    window.addEventListener('pointercancel', (e) => this.handleTouchPointerEnd(e), { passive: false });

    // Panning logic (Right mouse button, Middle mouse button, or Left click on background)
    this.viewport.addEventListener('mousedown', e => {
      // Allow left click panning if clicking on background (viewport layer)
      const isBackgroundClick = this.isBackgroundSurface(e.target);
      const isLeftClickPan = e.button === 0 && (this.spacePressed || isBackgroundClick);
      const isSelectionMarquee = e.button === 0 && e.shiftKey && isBackgroundClick && !this.spacePressed;

      if (isSelectionMarquee) {
        this.beginSelectionMarquee(e);
        return;
      }

      if (isBackgroundClick && e.button === 0 && !this.spacePressed) {
        store.clearSelection();
      }
      
      if (e.button === 2 || e.button === 1 || isLeftClickPan) {
        this.isPanning = true;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.viewport.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', e => {
      if (this.isSelecting) {
        this.updateSelectionMarquee(e.clientX, e.clientY);
      }

      if (this.isPanning) {
        const dx = e.clientX - this.startX;
        const dy = e.clientY - this.startY;
        
        const { x, y, scale } = store.getTransform();
        store.setTransform(x + dx, y + dy, scale);
        
        this.startX = e.clientX;
        this.startY = e.clientY;
      }
    });

    window.addEventListener('mouseup', e => {
      if (this.isSelecting) {
        this.endSelectionMarquee();
      }

      if (this.isPanning) {
        this.isPanning = false;
        this.viewport.style.cursor = 'default';
      }
    });

    // Wheel Zoom functionality (center on cursor)
    this.viewport.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); // Sometimes the browser zoom kicks in
      }

      const { x, y, scale } = store.getTransform();
      const zoomFactor = 1 - e.deltaY * this.zoomSpeed;
      let newScale = scale * zoomFactor;

      newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));
      
      const mouseX = e.clientX;
      const mouseY = e.clientY;

      // Calculate shift due to zoom, targeting the mouse exact position
      const newX = mouseX - (mouseX - x) * (newScale / scale);
      const newY = mouseY - (mouseY - y) * (newScale / scale);

      store.setTransform(newX, newY, newScale);
    }, { passive: false });
  }

  beginSelectionMarquee(event) {
    this.isSelecting = true;
    this.selectionAdditive = true;
    this.selectionStartX = event.clientX;
    this.selectionStartY = event.clientY;
    this.selectionCurrentX = event.clientX;
    this.selectionCurrentY = event.clientY;
    this.selectionBaselineIds = [...new Set(store.state.selection?.nodeIds || [])].filter((id) => store.state.nodes[id]);

    if (this.selectionMarquee) {
      this.selectionMarquee.hidden = false;
      this.selectionMarquee.classList.add('is-active');
      this.selectionMarquee.style.left = `${event.clientX}px`;
      this.selectionMarquee.style.top = `${event.clientY}px`;
      this.selectionMarquee.style.width = '0px';
      this.selectionMarquee.style.height = '0px';
    }

    this.viewport.classList.add('is-selecting');
    event.preventDefault();
    event.stopPropagation();
  }

  updateSelectionMarquee(clientX, clientY) {
    this.selectionCurrentX = clientX;
    this.selectionCurrentY = clientY;

    const left = Math.min(this.selectionStartX, clientX);
    const top = Math.min(this.selectionStartY, clientY);
    const width = Math.abs(clientX - this.selectionStartX);
    const height = Math.abs(clientY - this.selectionStartY);

    if (this.selectionMarquee) {
      this.selectionMarquee.style.left = `${left}px`;
      this.selectionMarquee.style.top = `${top}px`;
      this.selectionMarquee.style.width = `${width}px`;
      this.selectionMarquee.style.height = `${height}px`;
    }

    this.updateSelectionFromMarquee(left, top, width, height);
  }

  updateSelectionFromMarquee(left, top, width, height) {
    if (!width && !height) {
      return;
    }

    const { x, y, scale } = store.getTransform();
    const worldLeft = (left - x) / scale;
    const worldTop = (top - y) / scale;
    const worldRight = ((left + width) - x) / scale;
    const worldBottom = ((top + height) - y) / scale;
    const minX = Math.min(worldLeft, worldRight);
    const maxX = Math.max(worldLeft, worldRight);
    const minY = Math.min(worldTop, worldBottom);
    const maxY = Math.max(worldTop, worldBottom);

    const hitNodeIds = Object.values(store.state.nodes || {})
      .filter((node) => {
        const nodeSize = node.size || { width: 260, height: 260 };
        const nodeLeft = Number(node.x) || 0;
        const nodeTop = Number(node.y) || 0;
        const nodeRight = nodeLeft + (Number(nodeSize.width) || 0);
        const nodeBottom = nodeTop + (Number(nodeSize.height) || 0);
        return !(nodeRight < minX || nodeLeft > maxX || nodeBottom < minY || nodeTop > maxY);
      })
      .map((node) => node.id);

    const nextSelectionIds = [...new Set([
      ...(this.selectionAdditive ? this.selectionBaselineIds : []),
      ...hitNodeIds,
    ])];

    store.setSelectionNodeIds(nextSelectionIds);
  }

  endSelectionMarquee() {
    this.isSelecting = false;
    this.selectionAdditive = false;
    this.selectionBaselineIds = [];

    if (this.selectionMarquee) {
      this.selectionMarquee.classList.remove('is-active');
      this.selectionMarquee.hidden = true;
    }

    this.viewport.classList.remove('is-selecting');
    this.viewport.style.cursor = 'default';
  }
}

export const inputController = new InputController();
