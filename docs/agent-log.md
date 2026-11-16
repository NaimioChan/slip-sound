# Agent log

Shared handoff log. Newest entry on top. One entry per work session: what changed, what was verified, what is left. Tool names are neutral on purpose — Hermes and OpenCode both write here.

## 2026-11-16 09:00 · hermes · waveform playback latency

- 改: src/renderer/src/components/WaveformPreview.tsx（播放元素池 4 个 + 预载）、src/renderer/src/App.tsx（neighbourRows、play(path)、方向键读索引）、CHANGELOG.md、新增 AGENTS.md、src/renderer/src/components/WAVEFORM-PLAYBACK.md、scripts/check-playback.mjs
- 起因: 点击文件到出声有 50–100ms 延迟，实测其中 40–90ms 是 Chromium 为新 source 建媒体管线的固定开销（预热 HTTP 缓存无效，35ms）
- 验证: vitest 96 passed；typecheck node+web 干净；electron-vite build 通过；scripts/check-playback.mjs 11/11 通过；40 文件 330MB 库上顺序遍历中位 14ms、回看上一首 13ms、重播 1–2ms
- 遗留: 冷启动一个从未预载的文件仍需 60–95ms（无法在媒体元素路径上再压）；大文件（>24MB）故意不预载
- 下一步: ReSlip（Rust + Tauri 重写）的延迟可行性分析，用户已确认要在 Electron 版收尾后再做
