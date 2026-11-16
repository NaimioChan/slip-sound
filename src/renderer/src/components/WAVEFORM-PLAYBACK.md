# Playback in the waveform dock

How the dock starts sound, and the measurements that constrain how it may change.

## Why a pool of elements

Chromium builds a media pipeline per element per source. Pointing an existing element at a new file and calling `play()` costs **40–90 ms** before the first sample is heard; most of it is between the source assignment and `loadedmetadata`. Measured on this app, 40 files of 8 MB WAV on local disk:

| Path | click → audible |
| --- | --- |
| Fresh `<audio>`, source assigned on click | 60–100 ms |
| Shared element, `pause()` then new `src` then `play()` | 31–89 ms |
| Element already holding the file, `play()` only | 0–2 ms |
| `fetch` the bytes first, then pin the shared element at it | 35 ms (no help) |

The last row matters: warming the HTTP cache does not help, because the cost is the pipeline, not the read. Only an element that already has the file starts immediately.

So `WaveformPreview` keeps four hidden `<audio>` elements in `#waveform-audio-pool`:

- exactly one is *active* (`audioEl`) — it drives the UI, carries `#waveform-audio-element`, and is the only one whose events are listened to;
- the rest are idle and stay loaded with the rows next to the selection (`props.preloadRows`, forward-biased);
- a selection change hands playback to the idle element that already holds the new file, otherwise to any idle one;
- preloading runs 120 ms after a selection settles, so arrowing fast does not thrash the pool.

Result on the same library: 10–26 ms walking the list with clicks or arrow keys, 1–2 ms revisiting.

## Rules

1. **Never assign `src` to the element that is about to play if another element already holds that file.** Check `elPath` first.
2. **One element audible at a time.** The previously active element is paused when the pool switches, before the new one starts. Verify with `document.querySelectorAll('audio')` filtered on `paused`.
3. **`props.row` can be one render behind a click.** `App` changes the selection and calls `waveApi.play(path)` in the same handler, so `play` takes an explicit path and sets `playWhenReady` when the pool has not switched yet. Do not reintroduce a `play()` that infers the file from props.
4. **Cap what gets preloaded.** `PRELOAD_MAX_BYTES` (24 MB) keeps a pause on a large recording from pulling it into memory. Files above it play through a cold assignment like before.
5. **Keep the id on the active element.** `#waveform-audio-element` follows the active element; `scripts/generate-screenshots.cjs` and manual debugging look playback up by it.

## Measuring a change

Do not trust a dev-server or an unbuilt tree: build first (`npx electron-vite build`), then launch with `--remote-debugging-port` and drive it over CDP. A useful measurement timestamps the click, then polls `document.querySelectorAll('audio')` from `requestAnimationFrame` for the first element with `!paused && currentTime > 0`.

Two mistakes that produced wrong numbers here before:

- Seeking every element to 0 between measurements throws away buffered data and inflates the next result; pause only the element that is playing.
- Checking only the active element's `src` misses the case where the wrong file is playing, which is what happens if `play()` runs before the pool switched.

Functional checks worth running after touching this file: click a row (one element plays the clicked file), click another (the previous one stops), `Space` pauses and resumes the same file, clicking the waveform seeks and keeps playing, mute drops volume to 0, and idle elements are never playing.
