/**
 * InputController.js
 * Captures user input directly and updates the state.
 */
import { store } from './StateStore.js';

class InputController {
  constructor() {
    this.isPanning = false;
    this.startX = 0;
    this.startY = 0;
    
    // Zoom configurations
    this.minScale = 0.1;
    this.maxScale = 5;
    this.zoomSpeed = 0.001;
    
    this.spacePressed = false;
  }

  init() {
    this.viewport = document.getElementById('viewport');
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

    // Panning logic (Right mouse button, Middle mouse button, or Left click on background)
    this.viewport.addEventListener('mousedown', e => {
      // Allow left click panning if clicking on background (viewport layer)
      const isBackgroundClick = e.target.id === 'viewport' || e.target.id === 'grid-bg' || e.target.id === 'svg-layer';
      const isLeftClickPan = e.button === 0 && (this.spacePressed || isBackgroundClick);
      
      if (e.button === 2 || e.button === 1 || isLeftClickPan) {
        this.isPanning = true;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.viewport.style.cursor = 'grabbing';
      }
    });

    window.addEventListener('mousemove', e => {
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
}

export const inputController = new InputController();
