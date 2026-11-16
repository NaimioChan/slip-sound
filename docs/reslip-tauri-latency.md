# Rust + Tauri 重写的播放延迟分析

结论先行：**仅为了降低点击到出声的延迟，Rust + Tauri 换栈拿不到收益。** 延迟不在 Electron 里，在 webview 的媒体管线里；Tauri 在 Windows 上用的是同一套 Chromium（WebView2），同一条管线。要真正压下去，必须绕开 webview 自己输出音频，那是"加一个 Rust 音频引擎"的工作量，与"换成 Tauri"不是同一件事。

以下是本机实测，2026-11，Windows 11，Edge/WebView2 157.0.4341，Electron 39.8.10（Chromium 同代）。

## 一、实测数据

### 1. webview 内 `<audio>` 的延迟与内核无关

同一份页面、同一批文件、同一台机器：

| 环境 | 复用元素 `pause()`+`src`+`play()` | 预载好的另一个元素 `play()` |
| --- | --- | --- |
| Electron 39（Chromium） | 中位 39ms（22–54） | 中位 0ms（0–1） |
| Edge 157（= WebView2 内核） | 中位 32ms（24–41） | 中位 0ms（0–1） |

两组数字在噪声范围内一致。**换 Tauri 的 webview 层不会改变这 30–40ms**，因为触发点相同：给媒体元素换 source 后，Chromium 要重建 demuxer/decoder，再等 `loadedmetadata`/`canplay` 才出声。

这一点值得单独强调，因为它是整个问题的核心：Slip Sound 现在 50–100ms 的原始延迟里，40–90ms 就在这一段；而这段在 Tauri 里一模一样。仓库里已经落地的池化预载（见 `src/renderer/src/components/WAVEFORM-PLAYBACK.md`）把这段压到 0–2ms 的方法，在 Tauri 里同样有效，也正因如此，它不需要换栈。

### 2. 原生解码比 webview 快一到两个数量级

`symphonia` 0.5（纯 Rust，无 C 依赖）整文件解码，release 构建：

| 文件 | 大小 | 时长 | 解码耗时 |
| --- | --- | --- | --- |
| WAV 48k 立体声 | 576KB | 3s | **2ms** |
| FLAC 48k 立体声 | 48KB | 3s | **1ms** |
| MP3 320k | 122KB | 3s | **6ms** |
| OGG Vorbis | 69KB | 20s | 29ms |
| WAV 44.1k | 5.3MB | 30s | 17ms |
| WAV 96k 24bit | 104MB | 3min | 209ms |

对照：同一个 3 秒 WAV，webview 的 `<audio>` 光"换 source 到出声"就要 32ms，其中不是解码，是管线搭建。原生路径连解码带搬运 2ms。

（`hound` 做同样的 WAV 解码要 4ms/580ms，慢在逐样本泛型迭代；不需要它，`symphonia` 覆盖全部格式。）

### 3. 原生输出的真实下限：WASAPI 共享模式约 10ms

常驻 cpal 输出流，测"发布新片段 → 音频回调第一次取到它"的间隔，20 次：

```
swap -> first render: median 8.76 ms, min 0.06, max 10.41
all: [0.06, 0.07, 0.07, 0.07, 0.08, 0.08, 1.13, 8.33, 8.63, 8.71,
      8.76, 8.89, 9.18, 9.31, 9.66, 9.81, 10.13, 10.31, 10.31, 10.41]
```

双峰分布，含义很清楚：如果片段恰好在回调刚取完缓冲后发布，要等到下一次回调（约 0–0.1ms 是撞上回调边缘的情况；8–10.4ms 是等一个完整周期）；平均等待约 5ms，最坏 10.4ms。

回调几何由设备驱动决定，请求更小的 buffer **无效**（两轮独立测量，`Fixed(64)` 那轮出现一个 882 帧的抖动块，均值被拉到 11.0ms，其余各轮稳定在 446 帧）：

```
request=None  -> 100 callbacks/s, 446 frames/callback (10.12 ms of audio)
request=512   ->  94-100 callbacks/s, 446-470 frames/callback (10.1-10.7 ms)
request=256   -> 100 callbacks/s, 446 frames/callback (10.12 ms)
request=128   ->  99-100 callbacks/s, 446 frames/callback (10.12 ms)
request=64    -> 92-99 callbacks/s, 446-485 frames/callback (10.1-11.0 ms)
request=32    -> 100 callbacks/s, 446 frames/callback (10.12 ms)
```

这台机器的输出设备是 `扬声器 (FxSound Audio Enhancer)`，共享模式周期 10.1ms，`Fixed(32)` 被驱动忽略。换独占模式（WASAPI exclusive）能到 3ms 左右，但会独占设备——用户开着 DAW 时软件就没声音了，对采样管理器是硬伤。

叠加设备自身输出延迟（`IAudioClock` 报的值，通常 10–30ms 视驱动而定，本机 FxSound 虚拟设备拿不到准确值），**原生常驻流路径的现实下限约 15–25ms**。

## 二、三条路径的延迟对比

| 路径 | click → 出声 | 前提 | 代价 |
| --- | --- | --- | --- |
| 现在的 Electron 单元素 | 50–100ms | 无 | 已消除 |
| **池化预载（已实现）** | **1–2ms**（邻行）/ 10–26ms（连按方向键） | 只有邻近几行 | 内存里多几份解码/缓冲的文件 |
| Tauri + webview `<audio>` | 32–40ms（无池化） | 无 | 换栈，但延迟不降 |
| Tauri + webview + 池化 | 同左 | 同左 | 换栈纯粹白换 |
| **Tauri + Rust 原生输出** | **约 15–25ms** | 常驻音频流 + 自己解码 | 最复杂；独占模式会抢设备 |

关键对照是第三、四行：**Tauri 的 webview 路径比现在已经实现的池化方案还慢。** 第五行才可能追上，但它比池化方案还慢 10ms 以上，因为它被 WASAPI 的 10ms 周期卡住，而 webview 的预载元素根本不用等周期——音频已经在浏览器内部解码成 PCM，`play()` 直接进混音器。

## 三、如果还是要换 Tauri，值得做和不该做的

换栈的理由应该另找（体积、内存、启动速度、Rust 后端能力），不该是延迟。若确实要换，以下边界成立：

**不该做**

- 以为换 Tauri 能解决延迟。已验证否定，同内核同管线。
- 用 webview `<audio>` 播放 + 指望比 Electron 快。同代码同结果。
- 用 WASAPI 独占模式换 3ms。会在 DAW 开着时静音，违背采样管理器的使用场景。

**值得做**

- 保留池化预载的思路，只是换成 Web Audio（`decodeAudioData` + `AudioBufferSourceNode`）。同一台机器上实测，已解码的 buffer 从 `source.start()` 到 `AudioContext` 时钟越过起始时刻约 3–16ms（12 次中位 9ms），比 `<audio>` 复用元素快，且能省掉池子和 `src` 管理；代价是要自己管解码缓存和内存上限。注意这个口径是"启动已解码 buffer"，不含解码本身（短文件解码约 15ms，见第一节）。
- 解码放 Rust 侧（`symphonia`），通过 Tauri IPC 把 PCM 交给前端。省掉 webview 自己的解码，但 IPC 一次搬几百 KB 的 PCM 本身要几毫秒，收益被吃掉大半。只在"要支持 webview 不支持的格式"时才值得。
- 频谱/波形峰值计算搬 Rust，这块是纯 CPU，收益明确且与延迟无关。
- 索引层（现在 `node:sqlite`）换 `rusqlite` 或 `sled`，收益在查询和启动，不在播放。

## 四、如果目标真是"再快一点"，在现有架构内的选项

按性价比排序，前两条不需要换栈：

1. **按需扩大预载范围**：现在池子 4 个元素、覆盖邻行。滚动到某处停下后，把视野内前若干行都预热（上限设个内存预算），能把"跳转"那 58–89ms 也吃掉大半。
2. **换 Web Audio 播放**：`decodeAudioData` + `AudioBufferSourceNode`，实测 3–16ms，且不再受媒体元素换源开销影响；内存里按 LRU 缓存 N 秒的解码数据。这是唯一能在 webview 内进一步压低"冷文件"延迟的路。
3. 预载门槛从 24MB 放宽，或对超大文件只预载头部若干秒（需要切片传输，`sound-file://` 已支持 Range）。
4. 键盘预留：方向键按住连续移动时，提前把移动方向再往前两行预热。

第 2 条是真正值得评估的下一个优化点，且与 Rust/Tauri 无关。

## 五、复现方法

```bash
# webview 侧：Edge 与 Electron 各跑一遍同一个 probe 页面
msedge.exe --remote-debugging-port=9334 --autoplay-policy=no-user-gesture-required \
  --user-data-dir=%TEMP%\edge-probe http://127.0.0.1:8901/probe.html
node scripts/check-playback.mjs <libraryFolder>   # 仓库内，Electron 侧的池化回归 + 延迟

# 原生侧：常驻 cpal 流 + symphonia 解码探针
cd <临时目录>/rust-audio-probe && cargo run --release
cargo run --release --bin geometry     # 回调几何
cargo run --release --bin decode_probe -- <音频文件>
```

探针项目是一次性的，没有进仓库；需要复测时按上面命令重建即可（`cpal 0.15`、`symphonia 0.5`、`hound 3.5`）。
