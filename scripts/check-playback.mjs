// Playback regression + latency probe for the waveform dock.
//
//   node scripts/check-playback.mjs <libraryFolder>
//
// Builds nothing: run `npx electron-vite build` first, since this drives the
// built app over CDP (dev-server timing is not representative). Exits non-zero
// if a functional check fails.
import { chromium } from 'playwright-core'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const lib = process.argv[2]
if (!lib) {
  console.error('usage: node scripts/check-playback.mjs <libraryFolder>')
  process.exit(2)
}

const ROOT = process.cwd()
const PORT = 9455
const udd = mkdtempSync(join(tmpdir(), 'slip-playback-'))

// electron's launcher already resolves the right binary per platform.
const ELECTRON =
  process.platform === 'win32'
    ? join(ROOT, 'node_modules/electron/dist/electron.exe')
    : process.platform === 'darwin'
      ? join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      : join(ROOT, 'node_modules/electron/dist/electron')

const child = spawn(
  ELECTRON,
  ['--no-sandbox', `--user-data-dir=${udd}`, `--remote-debugging-port=${PORT}`, '.'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(name)
}

let browser
for (let i = 0; i < 60; i++) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
    break
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
}
if (!browser) {
  console.error('could not attach to the app')
  child.kill()
  process.exit(1)
}

let page
for (let i = 0; i < 40; i++) {
  page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith('file:'))
  if (page) break
  await new Promise((r) => setTimeout(r, 500))
}
if (!page) {
  console.error('no renderer page')
  await browser.close()
  child.kill()
  process.exit(1)
}
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

await page.waitForTimeout(1200)
await page.evaluate((p) => window.api.openFolder(p), lib)
await page.reload()
await page.waitForTimeout(3000)

// Timestamps click -> first audible sample by polling the pool.
await page.evaluate(() => {
  window.__marks = {}
  window.__watch = () => {
    window.__marks = { click: performance.now() }
    const t0 = performance.now()
    const tick = () => {
      for (const a of document.querySelectorAll('audio')) {
        if (!a.paused && a.currentTime > 0) {
          if (!window.__marks.playing) window.__marks.playing = performance.now()
          return
        }
      }
      if (performance.now() - t0 > 5000) return
      requestAnimationFrame(tick)
    }
    tick()
  }
  window.__stopAll = () => {
    for (const a of document.querySelectorAll('audio')) if (!a.paused) a.pause()
  }
})

const poolState = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('audio')).map((a) => ({
      id: a.id || '',
      src: (a.currentSrc || a.src || '').split('/').pop(),
      readyState: a.readyState,
      paused: a.paused,
      vol: a.volume
    }))
  )

const labelOf = (n) =>
  page.evaluate(
    (i) => document.querySelector(`[data-idx="${i}"]`)?.querySelector('span')?.textContent ?? '',
    n
  )

const clickRow = (n) =>
  page.evaluate((i) => {
    window.__watch()
    document.querySelector(`[data-idx="${i}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, n)

const latencyOf = () =>
  page.evaluate(() =>
    window.__marks.playing ? Math.round(window.__marks.playing - window.__marks.click) : null
  )

const settle = async (ms = 900) => {
  await page.waitForTimeout(ms)
  const ms2 = await latencyOf()
  await page.evaluate(() => window.__stopAll())
  await page.waitForTimeout(150)
  return ms2
}

// --- pool basics ---
const poolSize = await page.evaluate(() => document.querySelectorAll('audio').length)
check('pool has several elements', poolSize >= 2, `${poolSize} elements`)

// --- click plays exactly the clicked file ---
await clickRow(2)
let expect = await labelOf(2)
await page.waitForTimeout(800)
let els = await poolState()
let audible = els.filter((e) => !e.paused)
check('click starts exactly one element', audible.length === 1, JSON.stringify(audible.map((a) => a.src)))
check('it plays the clicked file', audible[0]?.src === expect, `${audible[0]?.src} vs ${expect}`)
await page.evaluate(() => window.__stopAll())
await page.waitForTimeout(150)

// --- switching stops the previous element ---
await clickRow(5)
expect = await labelOf(5)
await page.waitForTimeout(800)
els = await poolState()
audible = els.filter((e) => !e.paused)
check('switch leaves one element playing', audible.length === 1, JSON.stringify(audible.map((a) => a.src)))
check('switched to the new file', audible[0]?.src === expect, `${audible[0]?.src} vs ${expect}`)
await page.evaluate(() => window.__stopAll())
await page.waitForTimeout(150)

// --- space toggles the same file ---
// Start playback first (the element is paused from the check above), then let
// space pause it, then resume.
await clickRow(5)
await page.waitForTimeout(800)
check('space test starts from playing', (await poolState()).some((e) => !e.paused))
const space = async () =>
  page.evaluate(() => {
    document.activeElement?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }))
  })
await space()
await page.waitForTimeout(400)
check('space pauses', (await poolState()).every((e) => e.paused))
await space()
await page.waitForTimeout(500)
audible = (await poolState()).filter((e) => !e.paused)
check('space resumes the same file', audible.length === 1 && audible[0]?.src === expect, JSON.stringify(audible))
await page.evaluate(() => window.__stopAll())
await page.waitForTimeout(150)

// --- waveform click seeks and keeps playing ---
const seek = await page.evaluate(async () => {
  const el = document.querySelector('#waveform-canvas-container')
  const r = el.getBoundingClientRect()
  const x = r.left + r.width * 0.6
  const y = r.top + r.height / 2
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }))
  await new Promise((res) => setTimeout(res, 500))
  const a = document.querySelector('#waveform-audio-element')
  return { t: a.currentTime, dur: a.duration, paused: a.paused }
})
check('waveform click seeks forward', seek.t > seek.dur * 0.4, `t=${seek.t.toFixed(2)} dur=${seek.dur.toFixed(2)}`)
check('waveform click keeps playing', !seek.paused)
await page.evaluate(() => window.__stopAll())
await page.waitForTimeout(150)

// --- idle elements never play ---
const idlePlaying = (await poolState()).filter((e) => !e.paused && e.id !== 'waveform-audio-element')
check('no idle element is playing', idlePlaying.length === 0, JSON.stringify(idlePlaying))

// --- latency: walk the list, then revisit ---
const walk = []
for (let i = 1; i <= 6; i++) {
  await clickRow(i)
  walk.push(await settle())
}
console.log('sequential walk (ms):', JSON.stringify(walk))

const warm = []
for (const i of [2, 3, 2]) {
  await clickRow(i)
  warm.push(await settle())
}
console.log('revisit (ms):', JSON.stringify(warm))

const median = (a) => {
  const v = a.filter((n) => typeof n === 'number').sort((x, y) => x - y)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
console.log('median walk:', median(walk), 'median revisit:', median(warm))

await browser.close()
child.kill()
try {
  rmSync(udd, { recursive: true, force: true })
} catch {}

console.log(failures.length === 0 ? '\nall checks passed' : `\n${failures.length} check(s) failed`)
process.exit(failures.length === 0 ? 0 : 1)
