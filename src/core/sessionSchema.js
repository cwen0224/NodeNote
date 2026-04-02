export function createDefaultSession() {
  return {
    viewport: {
      x: 0,
      y: 0,
      scale: 1,
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
    },
    ui: {
      trayOpen: false,
      minimapOpen: true,
      dialog: null,
    },
  };
}

