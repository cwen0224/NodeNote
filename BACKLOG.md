# Backlog

## Parked

- Cloud sync / GitHub Contents API backup
  - Status: deferred
  - Keep the current GitHub backup implementation in the repo, but do not extend it for now.
  - The new Google Sheet co-edit adapter is the active cloud-sync path.

## Architecture Debt

- Separate canonical graph data from node metadata
  - Status: todo
  - Make `edges` the single source of truth for graph structure.
  - Keep `params` for node-local data only, not for connection rebuilding.

- Extract layout and routing from schema/rendering
  - Status: todo
  - Move auto-layout rules out of `documentSchema.js`.
  - Move edge routing decisions out of `Renderer.js`.
  - Keep schema normalization focused on data integrity only.

- Split renderer responsibilities
  - Status: todo
  - Keep `Renderer.js` focused on DOM/SVG rendering and subscriptions.
  - Move minimap geometry, port visibility heuristics, and layout projection into dedicated helpers.

- Split node mutation from interaction handling
  - Status: todo
  - Move selection, drag, grouping, paste insertion, and history-aware mutations into command handlers.
  - Keep `NodeManager.js` closer to document mutation utilities, not gesture orchestration.

- Decouple connection CRUD from popup UI
  - Status: todo
  - Keep connection naming history and CRUD operations separate from the naming popup.
  - Make it possible to reuse the same connection model in side panels or batch editors.

- Reduce direct store mutation in input handling
  - Status: todo
  - Move pointer gestures and keyboard shortcuts toward a command dispatch layer.
  - Avoid having `InputController.js` directly own both gesture state and document state changes.

- Retire compatibility view after migration
  - Status: todo
  - Keep `state` compatibility only until old call sites are migrated.
  - Remove the compatibility layer once the new context-driven architecture is stable.
