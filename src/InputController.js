/**
 * InputController.js
 * Captures user input directly and updates the state.
 */
import { store } from './StateStore.js';
import { nodeManager } from './NodeManager.js';
import {
  computeMarqueeWorldRect,
  hitTestNodesInWorldRect,
} from './core/selectionGeometry.js';

const isTouchLikePointer = (event) => event?.pointerType === 'touch' || event?.pointerType === 'pen';

class InputController {
  constructor() {
    this.isPanning = false;
    this.isSelecting = false;
    this.startX = 0;
    this.startY = 0;
    this.selectionStartX = 0;
    this.selectionStartY = 0;
    this.selectionCurrentX = 0;
    this.selectionCurrentY = 0;
    this.selectionAdditive = false;
    this.selectionBaselineIds = [];
    this.touchPointers = new Map();
    this.touchGesture = null;
    this.touchPan = null;
    this.touchPinch = null;
    
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

    this.viewport.addEventListener('pointerdown', e => {
      if (!isTouchLikePointer(e)) {
        return;
      }

      const isBackgroundTouch = e.target === this.viewport
        || e.target.id === 'grid-bg'
        || e.target.id === 'canvas'
        || e.target.id === 'svg-layer';
      if (!isBackgroundTouch) {
        return;
      }

      nodeManager.closeActiveEditingNode?.();
      nodeManager.resetTouchTapState?.();
      this.beginTouchGesture(e);
    });

    window.addEventListener('pointermove', e => {
      if (!isTouchLikePointer(e) || !this.touchPointers.has(e.pointerId)) {
        return;
      }

      this.updateTouchGesture(e);
    });

    const endTouchGesture = (e) => {
      if (!isTouchLikePointer(e) || !this.touchPointers.has(e.pointerId)) {
        return;
      }

      this.finishTouchGesture(e);
    };

    window.addEventListener('pointerup', endTouchGesture);
    window.addEventListener('pointercancel', endTouchGesture);

    // Panning logic (Right mouse button, Middle mouse button, or Left click on background)
    this.viewport.addEventListener('mousedown', e => {
      // Allow left click panning if clicking on background (viewport layer)
      const isBackgroundClick = e.target.id === 'viewport' || e.target.id === 'grid-bg' || e.target.id === 'svg-layer';
      const isLeftClickPan = e.button === 0 && (this.spacePressed || isBackgroundClick);
      const isSelectionMarquee = e.button === 0 && e.shiftKey && isBackgroundClick && !this.spacePressed;

      if (isSelectionMarquee) {
        this.beginSelectionMarquee(e);
        return;
      }

      if (isBackgroundClick && e.button === 0 && !this.spacePressed) {
        store.clearSelection();
        nodeManager.closeActiveEditingNode?.();
        nodeManager.resetTouchTapState?.();
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

  beginTouchGesture(event) {
    const { x, y, scale } = store.getTransform();
    event.preventDefault();
    event.stopPropagation();

    this.touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    this.viewport?.setPointerCapture?.(event.pointerId);

    if (this.touchPointers.size >= 2) {
      this.touchGesture = 'pinch';
      this.touchPinch = this.createTouchPinchState();
      this.touchPan = null;
      return;
    }

    store.clearSelection();
    this.touchGesture = 'pan';
    this.touchPan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
      originScale: scale,
    };
    this.touchPinch = null;
  }

  updateTouchGesture(event) {
    event.preventDefault();
    this.touchPointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (this.touchPointers.size >= 2) {
      if (!this.touchPinch || !this.touchGesture || this.touchGesture !== 'pinch') {
        this.touchGesture = 'pinch';
        this.touchPinch = this.createTouchPinchState();
      }

      const pinchState = this.touchPinch || this.createTouchPinchState();
      if (!pinchState) {
        return;
      }

      const currentPoints = this.getTouchPointPair(pinchState.pointerIds);
      if (!currentPoints) {
        return;
      }

      const currentDistance = Math.hypot(
        currentPoints.currentB.x - currentPoints.currentA.x,
        currentPoints.currentB.y - currentPoints.currentA.y,
      );
      if (!Number.isFinite(currentDistance) || currentDistance <= 0) {
        return;
      }

      const { x: originX, y: originY, scale: originScale } = pinchState.originTransform;
      const zoomFactor = currentDistance / pinchState.startDistance;
      let newScale = originScale * zoomFactor;
      newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

      const currentCenter = {
        x: (currentPoints.currentA.x + currentPoints.currentB.x) / 2,
        y: (currentPoints.currentA.y + currentPoints.currentB.y) / 2,
      };
      const newX = currentCenter.x - (pinchState.anchorWorld.x * newScale);
      const newY = currentCenter.y - (pinchState.anchorWorld.y * newScale);
      store.setTransform(newX, newY, newScale);
      return;
    }

    if (!this.touchPan || this.touchGesture !== 'pan') {
      return;
    }

    const activePoint = this.touchPointers.get(this.touchPan.pointerId) || [...this.touchPointers.values()][0];
    if (!activePoint) {
      return;
    }

    const dx = activePoint.x - this.touchPan.startX;
    const dy = activePoint.y - this.touchPan.startY;
    store.setTransform(
      this.touchPan.originX + dx,
      this.touchPan.originY + dy,
      this.touchPan.originScale,
    );
  }

  finishTouchGesture(event) {
    this.touchPointers.delete(event.pointerId);
    try {
      this.viewport?.releasePointerCapture?.(event.pointerId);
    } catch {
      // Ignore capture release failures.
    }

    event.preventDefault();

    if (this.touchPointers.size >= 2) {
      this.touchGesture = 'pinch';
      this.touchPinch = this.createTouchPinchState();
      this.touchPan = null;
      return;
    }

    if (this.touchPointers.size === 1) {
      const [pointerId, point] = [...this.touchPointers.entries()][0];
      const { x, y, scale } = store.getTransform();
      this.touchGesture = 'pan';
      this.touchPan = {
        pointerId,
        startX: point.x,
        startY: point.y,
        originX: x,
        originY: y,
        originScale: scale,
      };
      this.touchPinch = null;
      return;
    }

    this.touchGesture = null;
    this.touchPan = null;
    this.touchPinch = null;
  }

  createTouchPinchState() {
    const entries = [...this.touchPointers.entries()];
    if (entries.length < 2) {
      return null;
    }

    const [[firstId, firstPoint], [secondId, secondPoint]] = entries;
    const startDistance = Math.hypot(
      secondPoint.x - firstPoint.x,
      secondPoint.y - firstPoint.y,
    );
    if (!Number.isFinite(startDistance) || startDistance <= 0) {
      return null;
    }

    const originTransform = store.getTransform();
    const startCenter = {
      x: (firstPoint.x + secondPoint.x) / 2,
      y: (firstPoint.y + secondPoint.y) / 2,
    };

    return {
      pointerIds: [firstId, secondId],
      startDistance,
      startCenter,
      originTransform,
      anchorWorld: {
        x: (startCenter.x - originTransform.x) / originTransform.scale,
        y: (startCenter.y - originTransform.y) / originTransform.scale,
      },
    };
  }

  getTouchPointPair(pointerIds = []) {
    const [firstId, secondId] = pointerIds;
    const firstPoint = this.touchPointers.get(firstId);
    const secondPoint = this.touchPointers.get(secondId);
    if (!firstPoint || !secondPoint) {
      return null;
    }
    return {
      currentA: firstPoint,
      currentB: secondPoint,
    };
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

    const worldRect = computeMarqueeWorldRect({
      left,
      top,
      width,
      height,
      transform: store.getTransform(),
    });
    const hitNodeIds = hitTestNodesInWorldRect(store.state.nodes || {}, worldRect);

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
