# NodeNote Architecture

## Principle

The canonical JSON document is the source of truth.

- `document` is persistent data: nodes, edges, assets, metadata, exportable graph content.
- `folder` nodes may contain a nested document, so the graph can become a stack of subpages.
- `session` is ephemeral editor state: viewport, selection, hover, drag, edit focus, popups, tray UI, folder path.
- `commands` are the only way to mutate document data.
- `renderers` are projections of document + session, not owners of state.

## Layers

### 1. Canonical document

This is the JSON that gets imported, edited, copied, synced, and exported.

Recommended structure:

```jsonc
{
  "schemaVersion": "1.0.0",
  "meta": {
    "title": "Untitled",
    "description": "",
    "tags": [],
    "createdAt": null,
    "updatedAt": null
  },
  "entryNodeId": null,
  "nodes": {},
  "edges": [],
  "assets": [],
  "extras": {}
}
```

Folder node shape:

```jsonc
{
  "id": "folder_1",
  "type": "folder",
  "title": "Folder · Example",
  "content": "3 nodes · 4 links",
  "folder": {
    "depth": 1,
    "colorIndex": 1,
    "summary": "3 nodes · 4 links",
    "collapsed": false,
    "sourceNodeIds": ["node_a", "node_b"],
    "boundaryLinks": {
      "incoming": [],
      "outgoing": []
    },
    "document": {
      "schemaVersion": "1.0.0",
      "meta": {
        "title": "Folder · Example",
        "description": "",
        "tags": [],
        "createdAt": null,
        "updatedAt": null
      },
      "entryNodeId": "node_a",
      "nodes": {},
      "edges": [],
      "assets": [],
      "extras": {}
    }
  }
}
```

### 2. Session state

Ephemeral UI state that should not be saved into the canonical document.

Examples:

- viewport pan / zoom
- current selection
- current folder path
- active editing node
- hovered node / edge / port
- temporary connection preview
- modal / tray open state

### 3. Command layer

All document mutations should eventually pass through commands.

Examples:

- `addNode`
- `deleteNode`
- `connectNodes`
- `renameConnection`
- `updateNodeContent`
- `attachAsset`
- `setEntryNode`

### 4. Projections

Renderers should consume state and render projections:

- node canvas
- connection canvas
- minimap
- toolbars
- overlays

### 5. Adapters

External integrations should stay outside the core document model.

- clipboard
- Git sync
- cloud sync / remote snapshot backup
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
3. Make `edges` the canonical graph representation.
4. Convert node-specific UI into registry-driven templates.
5. Move clipboard/Git/AI integration behind adapters.

## Migration rule

Any future schema change must be versioned and migrated, not patched ad hoc.
