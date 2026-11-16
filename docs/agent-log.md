# Agent log

Shared handoff log. Newest entry on top. One entry per work session: what changed, what was verified, what is left. Tool names are neutral on purpose — Hermes and OpenCode both write here.

## 2026-11-16 09:25 · hermes · ReSlip (Rust + Tauri) 延迟可行性

- 改: 新增 docs/reslip-tauri-latency.md（只新增文档，未改代码）
- 结论: 仅冲延迟换 Tauri 拿不到收益——Edge 157（= WebView2 内核）实测与 Electron 39 完全一致，复用媒体元素 32ms、预载元素 0ms，瓶颈在 Chromium 媒体管线不在 Electron。原生 Rust 输出实测每次 cpal 回调 446 帧/10.1ms，请求更小 buffer 被驱动忽略；叠加设备延迟现实下限 15–25ms，比已实现的池化预载（1–2ms）更慢
- 副产物: symphonia 解码 3s WAV 2ms / FLAC 1ms / MP3 6ms / 104MB WAV 209ms，可作为将来做波形峰值或格式支持的参考数据
- 验证: Edge CDP 探针（同页同文件对比 Electron）；cargo run --release 的 cpal 常驻流与几何探针；复现命令写在文档第五节
- 遗留: 探针项目在 %TEMP%\rust-audio-probe，未进仓库，需要时按文档重建
- 下一步: 若还要压"冷文件"那 60–95ms，文档第四节列了三条不动技术栈的路，其中 Web Audio（decodeAudioData + AudioBufferSourceNode）最值得评估

## 2026-11-16 09:00 · hermes · waveform playback latency

- 改: src/renderer/src/components/WaveformPreview.tsx（播放元素池 4 个 + 预载）、src/renderer/src/App.tsx（neighbourRows、play(path)、方向键读索引）、CHANGELOG.md、新增 AGENTS.md、src/renderer/src/components/WAVEFORM-PLAYBACK.md、scripts/check-playback.mjs
- 起因: 点击文件到出声有 50–100ms 延迟，实测其中 40–90ms 是 Chromium 为新 source 建媒体管线的固定开销（预热 HTTP 缓存无效，35ms）
- 验证: vitest 96 passed；typecheck node+web 干净；electron-vite build 通过；scripts/check-playback.mjs 11/11 通过；40 文件 330MB 库上顺序遍历中位 14ms、回看上一首 13ms、重播 1–2ms
- 遗留: 冷启动一个从未预载的文件仍需 60–95ms（无法在媒体元素路径上再压）；大文件（>24MB）故意不预载
- 下一步: ReSlip（Rust + Tauri 重写）的延迟可行性分析，用户已确认要在 Electron 版收尾后再做
