import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../lib/db.js'
import { redatingView } from '../lib/redating.js'
import { ensureDayMainlines, daySegments, generateDayMainline, DAY_MAINLINE_LIMITS } from '../lib/day-mainline.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-day-mainline-'))
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
function at(day, hour = 12) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, 0, 0, 0).getTime()
}
function seed(handle, day, hour, title, body = '正文', { quote = '', kind = 'promise' } = {}) {
  const startSeq = 80000000 + Number(day.replaceAll('-', '')) * 10 + hour
  const sid = `s-${day}-${hour}`
  handle.indexEpisodes(sid, [{ startSeq, endSeq: startSeq + 1, startAt: at(day, hour), endAt: at(day, hour) + 500, title, body, valuable: true }])
  handle.putAggregate(sid, startSeq, startSeq + 1, { title, summary: '', cues: [], quote, kind, first: false })
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
function fakeLlmQueue(texts, calls = []) {
  let i = 0
  return {
    stream() {
      const text = texts[Math.min(i++, texts.length - 1)]
      calls.push(text)
      return (async function* () {
        if (text) yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}
const DAY_TEXT = '训练员夜里问起求婚，我把那四句话又念了一遍。后来我们一起把旧日记收好，心里安静下来。'

test('day segments read all episodes and skip simplified', () => {
  withDb((h) => {
    seed(h, '2026-11-26', 10, '第一段')
    seed(h, '2026-11-26', 20, '第二段')
    h.setEpisodeDetail({ episodeId: 80000000 + 20261126 * 10 + 10, sessionId: 's-2026-11-26-10', simplified: true })
    assert.equal(daySegments(h.db, '2026-11-26').length, 1)
  })
})

test('day material includes original quotes, preferring promise/fact/feeling', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 10, '普通任务', '普通'.repeat(80), { kind: 'task', quote: '' })
    seed(h, '2026-11-26', 20, '约定', '长'.repeat(200), { kind: 'promise', quote: '对方说：以后每个晚上都这样。' })
    const prompts = []
    const fake = {
      stream(req) {
        prompts.push(String(req?.messages?.[0]?.content?.[0]?.text ?? ''))
        return (async function* () {
          yield { type: 'text-delta', text: DAY_TEXT }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    await generateDayMainline(h.db, fake, '2026-11-26', { timeoutMs: 5_000 })
    assert.ok(prompts.length >= 1)
    assert.match(prompts[0], /原文引语：/)
    assert.match(prompts[0], /对方说：以后每个晚上都这样。/)
  })
})

test('day mainline is generated, stored, and rendered before pointers', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 20, '训练员把求婚说给我听，我答应了', '长'.repeat(260))
    seed(h, '2026-11-26', 10, '我回来了', '短')
    const calls = []
    const r = await ensureDayMainlines(h, fakeLlm(DAY_TEXT, calls), { limit: 3, timeoutMs: 5_000 })
    assert.equal(r.done, 1)
    assert.equal(calls.length, 1)
    const row = h.db.prepare('SELECT * FROM day_mainline WHERE day = ?').get('2026-11-26')
    assert.equal(row.status, 'ok')
    assert.equal(row.source, 'llm')
    assert.equal(row.text, DAY_TEXT)
    const out = redatingView(h, {})
    assert.match(out, /2026-11-26 · 2 段/)
    assert.match(out, new RegExp(DAY_TEXT))
    assert.match(out, /20:00 训练员把求婚说给我听，我答应了/)
    assert.ok(out.indexOf(DAY_TEXT) < out.indexOf('20:00 训练员把求婚'))
  })
})

test('empty model response degrades day mainline and never fakes a summary', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 20, '训练员把求婚说给我听，我答应了', '长'.repeat(260))
    const r = await ensureDayMainlines(h, fakeLlm(''), { limit: 3, timeoutMs: 5_000 })
    assert.equal(r.degraded, 1)
    const row = h.db.prepare('SELECT * FROM day_mainline WHERE day = ?').get('2026-11-26')
    assert.equal(row.status, 'degraded')
    assert.equal(row.text, '')
    const out = redatingView(h, {})
    assert.match(out, /（那天还在整理，先按标题看）/)
    assert.match(out, /20:00 训练员把求婚说给我听，我答应了/)
    assert.doesNotMatch(out, /训练员夜里问起求婚/)
  })
})

test('orphan one-word tail retries once with a larger budget', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 20, '收尾', '正文'.repeat(30))
    const calls = []
    const journal = []
    const fake = fakeLlmQueue(['……裁定维持 ≥2。控制。', '……裁定维持 ≥2。'], calls)
    const r = await generateDayMainline(h.db, fake, '2026-11-26', { timeoutMs: 5_000, journal: (kind, detail) => journal.push([kind, detail]) })
    assert.equal(calls.length, 2)
    assert.equal(r.status, 'ok')
    assert.doesNotMatch(r.text, /控制。$/)
    assert.equal(journal.length, 0)
  })
})

test('complete short sentence does not count as an orphan tail', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 20, '收尾', '正文'.repeat(30))
    const calls = []
    const fake = fakeLlmQueue(['……裁定维持 ≥2。我说好。'], calls)
    const r = await generateDayMainline(h.db, fake, '2026-11-26', { timeoutMs: 5_000 })
    assert.equal(calls.length, 1)
    assert.equal(r.status, 'ok')
    assert.match(r.text, /我说好。$/)
  })
})

test('input hash prevents unchanged day from regenerating', async () => {
  await withDb(async (h) => {
    seed(h, '2026-11-26', 20, '训练员把求婚说给我听，我答应了', '长'.repeat(260))
    await ensureDayMainlines(h, fakeLlm(DAY_TEXT), { limit: 3, timeoutMs: 5_000 })
    const calls = []
    const r = await ensureDayMainlines(h, fakeLlm(DAY_TEXT, calls), { limit: 3, timeoutMs: 5_000 })
    assert.equal(r.done, 0)
    assert.equal(calls.length, 0)
  })
})

test('day mainline limits are elastic with a 120/200 reference ceiling', () => {
  assert.equal(DAY_MAINLINE_LIMITS.MIN_REF_CHARS, 20)
  assert.equal(DAY_MAINLINE_LIMITS.MAX_CHARS, 120)
  assert.equal(DAY_MAINLINE_LIMITS.MAX_CHARS_MANY, 200)
  assert.equal(DAY_MAINLINE_LIMITS.MANY_SEGMENTS, 300)
  assert.equal(DAY_MAINLINE_LIMITS.MAX_CHUNK_SEGMENTS, 60)
})
