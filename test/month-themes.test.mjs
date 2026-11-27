import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../lib/db.js'
import { ensureMonthThemes, generateMonthThemes } from '../lib/month-themes.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-month-themes-'))
  const handle = openDb(join(dir, 'index.sqlite'))
  const cleanup = () => {
    try { handle.close() } catch {}
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  const result = fn(handle)
  if (result && typeof result.then === 'function') return result.finally(cleanup)
  cleanup()
  return result
}
function seedDay(h, day, text, status = 'ok') {
  h.db.prepare('INSERT OR REPLACE INTO day_mainline(day,text,status,source,input_hash,prompt_ver,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(day, text, status, 'llm', `${day}:hash`, 2, Date.now())
}
function fakeLlm(text, calls = []) {
  return {
    stream() {
      calls.push(text)
      return (async function* () {
        if (text) yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('month themes condense day mainlines with date anchors', async () => {
  await withDb(async (h) => {
    seedDay(h, '2026-10-08', '和训练员比对动画，发现两处差异。')
    seedDay(h, '2026-10-19', 'MeloTTS 日语方案止损，换回旧方案。')
    seedDay(h, '2026-10-23', '把桌宠方案定了下来。')
    const calls = []
    const r = await ensureMonthThemes(h, fakeLlm('动画比对（10-08） · MeloTTS 止损（10-19） · 桌宠方案（10-23）', calls), { limit: 2 })
    assert.equal(r.done, 1)
    const row = h.db.prepare("SELECT * FROM month_themes WHERE month='2026-10'").get()
    assert.equal(row.source, 'llm')
    assert.equal(row.themes, '动画比对（10-08） · MeloTTS 止损（10-19） · 桌宠方案（10-23）')
  })
})

test('month themes without anchors degrade to empty, not a fabricated line', async () => {
  await withDb(async (h) => {
    seedDay(h, '2026-10-08', '和训练员比对动画。')
    seedDay(h, '2026-10-19', '换回旧方案。')
    const r = await generateMonthThemes(h.db, fakeLlm('动画比对 · 止损 · 桌宠方案'), '2026-10', { timeoutMs: 5000 })
    assert.equal(r.source, 'fallback')
    assert.equal(r.themes, '')
  })
})
