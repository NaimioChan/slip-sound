# AGENTS.md

Slip Sound: a local audio sample manager and waveform audition tool. Electron + SolidJS renderer, Node main process, bun/npm for installs. This file is the entry point: stack, commands, rules, and where the details live.

## Stack

- Electron 39 (main + preload + renderer, built by electron-vite)
- SolidJS 1.9 renderer, Tailwind 4, lucide-solid icons
- `node:sqlite` (`DatabaseSync`) for the per-library index — no native modules
- ffmpeg (bundled via `ffmpeg-static`) for peaks, exports, and processing
- vitest for tests, eslint + prettier for style

## Commands

```
npm install                 # deps; electron/ffmpeg binaries download from a mirror
npm run dev                 # electron-vite dev server
npm run build               # typecheck (node + web) then electron-vite build
npm run typecheck           # tsc for both projects
npm run test                # vitest run
npm run lint                # eslint --cache .
npm run format              # prettier --write .
```

A full check is `npm run build && npm run test`. The build's typecheck is the gate that matters; `npm run lint` currently reports ~2000 prettier warnings on the existing CRLF sources, so judge lint by error count, not warning count.

Verifying UI or audio behaviour needs the built app (`npm run build`, then run `node_modules/electron/dist/electron.exe .`) because the renderer talks to the real main process. Drive it over CDP with `--remote-debugging-port`; don't rely on dev-server timing when measuring performance.

## Rules

- The renderer never decodes whole files. Waveform peaks come from the main process (`src/main/peaks.ts`), which streams ffmpeg output and caches per file. Playback of the file itself is left to the media element.
- Playback latency is a product feature. The waveform keeps a pool of hidden `<audio>` elements: one plays, the others stay loaded with the rows next to the selection. Never point the playing element at a new file when a loaded one already has it — that costs 40–90 ms of media pipeline setup. See `src/renderer/src/components/WAVEFORM-PLAYBACK.md`.
- The main process owns all disk and ffmpeg access. IPC is typed in `src/preload/index.ts` and mirrored in `src/preload/index.d.ts`; add the two together.
- Sounds are addressed by absolute path. Anything that mutates library state goes through `editLibrary()` in `App.tsx` so it lands in undo/redo.
- Tests for pure logic live next to the module (`*.test.ts`). Viewer/audio behaviour has no automated suite in-repo; verify those by driving the built app.

## Where things live

| Area | Path |
| --- | --- |
| Main process entry, IPC handlers, `sound-file://` protocol | `src/main/index.ts` |
| SQLite schema, search, folder tree, states | `src/main/db.ts` |
| Indexing a folder | `src/main/indexer.ts` |
| Waveform peaks (ffmpeg stream + disk cache) | `src/main/peaks.ts` |
| Exports, loudness, ffmpeg bindings | `src/main/export.ts` |
| Effect renders and drag-out staging | `src/main/renders.ts` |
| MCP server | `src/main/mcp/` |
| App shell, selection, search wiring | `src/renderer/src/App.tsx` |
| Waveform dock and playback | `src/renderer/src/components/WaveformPreview.tsx` |
| Playback and latency constraints | `src/renderer/src/components/WAVEFORM-PLAYBACK.md` |
| Tools (Slicer, Effects, Seamless Loop, Export) | `src/renderer/src/components/*Modal.tsx` |
| Shared contracts (processing, folders) | `src/shared/` |
