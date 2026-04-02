# NodeNote

NodeNote is a node-based JSON notebook for structured notes, media-linked content, and visual-novel-ready graph data.

## Core idea

- The canonical document JSON is the source of truth.
- UI/session state stays outside the document.
- Nodes, edges, assets, and metadata are the persistent layer.
- Clipboard, Git, and AI integrations are adapters, not core state.

## Run

```bash
npm install
npm run dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).

