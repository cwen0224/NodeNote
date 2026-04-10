export function createDefaultSession() {
  return {
    viewport: {
      x: 0,
      y: 0,
      scale: 1,
    },
    navigation: {
      path: [],
      viewportStack: [],
    },
    selection: {
      nodeIds: [],
      edgeIds: [],
    },
    editing: {
      nodeId: null,
      connectionId: null,
    },
    hover: {
      nodeId: null,
      edgeId: null,
      port: null,
    },
    interaction: {
      draggingNodeId: null,
      drawingEdgeFrom: null,
      lastActiveNodeId: null,
      lastActiveNodeAt: null,
      lastPointer: {
        x: null,
        y: null,
        type: null,
      },
    },
    ui: {
      trayOpen: false,
      minimapOpen: true,
      dialog: null,
    },
  };
}
