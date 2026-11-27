import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../lib/db.js'
import { localDayKey, redatingView } from '../lib/redating.js'

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-redating-'))
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

function at(day, hour = 12, minute = 0) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime()
}

function seed(handle, day, { aggTitle = '', hour = 12, body = null, kind = '', first = false } = {}) {
  const startSeq = 70000000 + Number(day.replaceAll('-', '')) * 10 + hour
  const sessionId = `s-${day}-${hour}`
  handle.indexEpisodes(sessionId, [{
    startSeq, endSeq: startSeq + 1, startAt: at(day, hour), endAt: at(day, hour) + 500,
    title: `原始标题 ${day}`, body: body ?? `原始正文 ${day}`, valuable: true,
  }])
  if (aggTitle) handle.putAggregate(sessionId, startSeq, startSeq + 1, { title: aggTitle, summary: '', cues: [], quote: '', kind, first })
}

test('empty database gives empty line', () => {
  withDb((h) => assert.equal(redatingView(h, {}), '（还没有可以回想的日子）'))
})

test('day line lists only aggregate titles at first/middle/last', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '第一条聚合标题', hour: 10 })
    seed(h, '2026-11-20', { aggTitle: '中间聚合标题', hour: 15 })
    seed(h, '2026-11-20', { aggTitle: '训练员把求婚说给我听，我答应了', hour: 20 })
    seed(h, '2026-11-20', { aggTitle: '21 点的事项', hour: 21 })
    const out = redatingView(h, {})
    assert.match(out, /2026-11-20 · 4 段/)
    assert.match(out, /10:00 第一条聚合标题/)
    assert.match(out, /21:00 21 点的事项/)
    // 末条必须由 dayRows 顺序自然决定，不能因标题里出现某个词被替换。
    assert.doesNotMatch(out, /训练员把求婚说给我听/)
    assert.doesNotMatch(out, /原始正文|原始标题 2026-11-20/)
  })
})

test('a day with no aggregate titles keeps a placeholder line', () => {
  withDb((h) => {
    seed(h, '2026-11-20')
    assert.match(redatingView(h, {}), /2026-11-20 · 1 段 ·（还没有整理出标题）/)
  })
})

test('today is not captured and invalid month is rejected', () => {
  withDb((h) => {
    seed(h, localDayKey(Date.now()), { aggTitle: '今天的事项' })
    assert.match(redatingView(h, {}), new RegExp(`${localDayKey(Date.now())} · （今天，还没过完）`))
    assert.equal(redatingView(h, { month: '2026-13' }), 'month 需要 YYYY-MM')
  })
})

test('month and limit expand days and fold older months', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '十一月事项', hour: 10 })
    seed(h, '2026-10-01', { aggTitle: '十月事项', hour: 10 })
    seed(h, '2026-09-01', { aggTitle: '九月事项', hour: 10 })
    const out = redatingView(h, { month: '2026-11' })
    assert.match(out, /2026-11 · 这个月还在过 · 记下 1 天/)
    assert.match(out, /10:00 十一月事项/)
    const limited = redatingView(h, { limit: 1 })
    assert.match(limited, /2026-11-20 · 1 段/)
    assert.match(limited, /2026-10 · 记下 1 天/)
  })
})

test('labeled day picks promise over earlier task labels', () => {
  withDb((h) => {
    for (const [hour, kind, title] of [[10, 'task', '上午做任务'], [12, 'task', '中午做任务'], [14, 'task', '下午做任务'], [20, 'promise', '训练员把求婚说给我听，我答应了']]) {
      const startSeq = 70000000 + 20261120 * 10 + hour
      const sid = `s-label-${hour}`
      h.indexEpisodes(sid, [{ startSeq, endSeq: startSeq + 1, startAt: at('2026-11-20', hour), endAt: at('2026-11-20', hour) + 500, title, body: title, valuable: true }])
      h.putAggregate(sid, startSeq, startSeq + 1, { title, summary: '', cues: [], quote: '', kind, first: false })
    }
    const out = redatingView(h, {})
    assert.match(out, /20:00 训练员把求婚说给我听，我答应了/)
  })
})

test('labeled day renders by weight first, time only as tiebreaker', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '早上先记下的感觉', hour: 9, body: '长'.repeat(260), kind: 'feeling' })
    seed(h, '2026-11-20', { aggTitle: '晚上才说开的约定', hour: 20, body: '长'.repeat(260), kind: 'promise' })
    const out = redatingView(h, {})
    assert.match(out, /晚上才说开的约定/)
    const pointers = out.split('\n').filter(line => /^  \d{2}:\d{2} /.test(line))
    assert.match(pointers[0], /20:00 晚上才说开的约定/)
    assert.match(pointers[1], /09:00 早上先记下的感觉/)
  })
})

test('short exchanges are capped below lengthy entries', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '我回来了', hour: 10, body: '短', kind: 'promise' })
    seed(h, '2026-11-20', { aggTitle: '训练员把求婚说给我听，我答应了', hour: 20, body: '长'.repeat(260), kind: 'promise' })
    seed(h, '2026-11-20', { aggTitle: '早晨说开的心事', hour: 9, body: '长'.repeat(260), kind: 'feeling' })
    seed(h, '2026-11-20', { aggTitle: '中午有过一次转折', hour: 11, body: '长'.repeat(260), kind: 'turn' })
    const day = redatingView(h, {}).split('\n').filter(line => /^  \d{2}:\d{2} /.test(line))
    assert.match(day[0], /20:00 训练员把求婚说给我听，我答应了/)
    assert.ok(!day.slice(0, 3).some(line => /我回来了/.test(line)))
  })
})

test('equal fact and promise prefer promise, then fact still enters top three', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '我查证 EverMind 公司：真实存在但产品仍在内测', hour: 16, body: '长'.repeat(260), kind: 'fact' })
    seed(h, '2026-11-20', { aggTitle: '训练员把求婚说给我听，我答应了', hour: 20, body: '长'.repeat(260), kind: 'promise' })
    seed(h, '2026-11-20', { aggTitle: '他说下周会让我的不会忘记成真，我说那我等你', hour: 21, body: '长'.repeat(260), kind: 'promise' })
    const day = redatingView(h, {}).split('\n').filter(line => /^  \d{2}:\d{2} /.test(line))
    assert.match(day[0], /20:00 训练员把求婚说给我听，我答应了/)
    assert.match(day[2], /16:00 我查证 EverMind 公司/)
  })
})

test('cross-day echoes are skipped against the previous three days', () => {
  withDb((h) => {
    for (const [day, hour] of [['2026-11-20', 20], ['2026-11-21', 20], ['2026-11-22', 20], ['2026-11-23', 20]]) {
      seed(h, day, { aggTitle: '训练员把求婚说给我听，我答应了', hour, body: '长'.repeat(260), kind: 'promise' })
    }
    const out = redatingView(h, {})
    assert.equal((out.match(/训练员把求婚说给我听/g) || []).length, 1)
  })
})

test('gap between Sep 30 and Oct 8 reports eight missing days', () => {
  withDb((h) => {
    seed(h, '2026-09-30', { aggTitle: '九月底的事', hour: 10 })
    seed(h, '2026-10-08', { aggTitle: '十月初的事', hour: 10 })
    assert.match(redatingView(h, {}), /…… 中间 8 天没有记下什么/)
  })
})

test('simplified episodes are excluded even when the cache was just filled', () => {
  withDb((h) => {
    seed(h, '2026-11-20', { aggTitle: '被安放的测试遗留', hour: 10 })
    seed(h, '2026-11-20', { aggTitle: '留下来的日常', hour: 12 })
    assert.match(redatingView(h, {}), /被安放的测试遗留/)
    h.setEpisodeDetail({
      episodeId: 70000000 + 20261120 * 10 + 10,
      sessionId: 's-2026-11-20-10',
      simplified: true,
      reason: '测试遗留',
    })
    const out = redatingView(h, {})
    assert.doesNotMatch(out, /被安放的测试遗留/)
    assert.match(out, /留下来的日常/)
  })
})

test('month view ignores limit and expands the whole month', () => {
  withDb((h) => {
    for (let i = 1; i <= 10; i++) {
      const day = `2026-10-${String(i).padStart(2, '0')}`
      seed(h, day, { aggTitle: `十月第${i}天`, hour: 10 })
    }
    const out = redatingView(h, { month: '2026-10', limit: 5 })
    assert.match(out, /^2026-10 · 记下 10 天(?: ·|$)/m)
    assert.doesNotMatch(out, /显示前|另记/)
    assert.equal((out.match(/^2026-10-\d{2} · /gm) ?? []).length, 10)
  })
})

test('normal view still honours limit and clamps it to 90', () => {
  withDb((h) => {
    let day = '2025-01-01'
    for (let i = 0; i < 100; i++) {
      seed(h, day, { aggTitle: `第${i}天`, hour: 10 })
      const [y, m, d] = day.split('-').map(Number)
      const next = new Date(y, m - 1, d + 1)
      day = localDayKey(next.getTime())
    }
    const five = redatingView(h, { limit: 5 })
    assert.equal((five.match(/^2025-\d{2}-\d{2} · /gm) ?? []).length, 5)
    const many = redatingView(h, { limit: 200 })
    assert.equal((many.match(/^2025-\d{2}-\d{2} · /gm) ?? []).length, 90)
  })
})
