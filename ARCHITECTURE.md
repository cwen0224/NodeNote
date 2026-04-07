# NodeNote Architecture

## Principle

The canonical JSON document is the source of truth.

- `document` is persistent data: nodes, edges, assets, metadata, exportable graph content.
- `folder` should be a manifest layer, not a recursive document container. The graph stays flat; folders point to the content they own.
- `session` is ephemeral editor state: viewport, selection, hover, drag, edit focus, popups, tray UI, folder path.
- `commands` are the only way to mutate document data.
- `renderers` are projections of document + session, not owners of state.

## Layers

### 1. Canonical document

This is the JSON that gets imported, edited, copied, synced, and exported.

Recommended structure:

```jsonc
{
  "schemaVersion": "2.0.0",
  "meta": {
    "title": "Untitled",
    "description": "",
    "tags": [],
    "createdAt": null,
    "updatedAt": null
  },
  "rootFolderId": "folder_root",
  "folders": {},
  "nodes": {},
  "edges": {},
  "assets": [],
  "extras": {}
}
```

### 2. Folder manifest

Folders are a separate registry. A folder points to node and folder references; it does not own an embedded sub-document.

Recommended shape:

```jsonc
{
  "folders": {
    "folder_root": {
      "id": "folder_root",
      "parentFolderId": null,
      "name": "Root",
      "depth": 0,
      "colorIndex": 0,
      "children": [
        { "kind": "node", "id": "node_a" },
        { "kind": "folder", "id": "folder_1" }
      ],
      "boundaryLinks": []
    },
    "folder_1": {
      "id": "folder_1",
      "parentFolderId": "folder_root",
      "name": "Folder · Example",
      "depth": 1,
      "colorIndex": 1,
      "children": [
        { "kind": "node", "id": "node_b" }
      ],
      "boundaryLinks": []
    }
  }
}
```

### 3. Node and edge registries

Nodes and edges remain flat, global registries. A node belongs to a folder by reference, not by deep embedding.

The active folder determines which subset is visible and editable.

### 4. Session state

Ephemeral UI state that should not be saved into the canonical document.

Examples:

- viewport pan / zoom
- current selection
- current folder path / active folder id
- active editing node
- hovered node / edge / port
- temporary connection preview
- modal / tray open state

### 5. Command layer

All document mutations should eventually pass through commands.

Examples:

- `addNode`
- `deleteNode`
- `connectNodes`
- `renameConnection`
- `updateNodeContent`
- `attachAsset`
- `setEntryNode`

### 6. Projections

Renderers should consume state and render projections:

- node canvas
- connection canvas
- minimap
- toolbars
- overlays

### 7. Shared sub-whiteboard rule

The folder page is not a second app or a separate editor implementation.

- Entering a folder only swaps the active folder context.
- The same node creation, connection, clipboard, tray, search, undo, redo, and shortcut system must work inside and outside folders.
- The same shell renders root and sub-whiteboards.
- Only the active context changes: `currentFolderId`, theme depth, visible nodes, and visible edges.
- Folder colors are a view-layer projection of depth, not separate schema branches.
- The folder UI may visually cap at seven layers, but the data model stays flat.

### 8. Adapters

External integrations should stay outside the core document model.

- clipboard
- Git sync
- cloud sync / remote snapshot backup
- Google Sheet collaboration sync
- file import/export
- AI JSON generation / validation
- storage persistence

## Modularity goals

- Keep document schema stable and versioned.
- Keep session state disposable.
- Keep renderers stateless where possible.
- Keep node type behavior in a registry or plugin boundary.
- Avoid storing the same source of truth in multiple places.

## Near-term refactor plan

1. Keep the current editor working while splitting document/session storage.
2. Move mutations into command functions.
3. Make the folder manifest the canonical ownership layer and keep node/edge registries flat.
4. Convert node-specific UI into registry-driven templates.
5. Make clipboard/Git/AI integration consume the active folder context, not a nested editor.

## Migration rule

Any future schema change must be versioned and migrated, not patched ad hoc.

The current nested-folder implementation is a transition path. The target model is the flat registry + folder manifest structure above.
