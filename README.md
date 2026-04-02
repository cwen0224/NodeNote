# NodeNote

NodeNote is a node-based JSON notebook for structured notes, media-linked content, and visual-novel-ready graph data.

## Core idea

- The canonical document JSON is the source of truth.
- UI/session state stays outside the document.
- Folders are manifest-driven sub-whiteboards: entering a folder only changes the active context, not the editor shell.
- Nodes, edges, assets, and metadata are kept in flat registries.
- Folder depth is a view-layer concept used for navigation and color themes, with up to seven visible layers.
- Local autosave keeps the current working draft in the browser, with a longer undo history.
- Cloud sync is a secondary snapshot layer for GitHub Contents API backups.
- Clipboard, Git, and AI integrations are adapters, not core state.

## Run

```bash
npm install
npm run dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).
