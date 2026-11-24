// 常驻回填：待整理段选择、内存阈值、校验失败带原因重试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openDb } from '../lib/db.js'
import { aggRetryKey, buildAndIndexEpisodesLLM, parseAggRetry } from '../lib/aggregate.js'
import { backfillFailureNeedsPause, backfillMemoryExceeded, backfillShouldRun, countPendingSegments, countPendingSegmentsIn, findIdleSessionIds, finishBackfillSession, migrateAggRetries, pickOldestPendingSegment, releaseBackfillMemory } from '../index.js'

const text = (n) => '这是一段用于测试的真实对话内容，包含一些细节和后续安排，用来保证分组足够长。'.repeat(n)
const rowsFor = (n = 2) => Array.from({ length: n }, (_, i) => ({
  seq: i + 1, raw_seq: i + 1, role: i % 2 ? 'assistant' : 'user', time: 1_700_000_000_000 + i, text: text(2),
}))

const validEp = {
  title: '一次普通的记录',
  summary: '我记得那天我们一起走了很远的路，风很轻，我一直在想以后还会不会再来。',
  cues: ['路', '风', '以后', '那天', '记录'],
  quote: '',
}

const makeDb = (rows = rowsFor(2)) => {
  const writes = []
  const journal = []
  const meta = new Map()
  const db = {
    db: { prepare: () => ({ all: () => rows }) },
    getAggregate: () => null,
    putAggregate: (...args) => writes.push(args),
    indexEpisodes: () => {},
    journal: (kind, detail) => journal.push({ kind, detail }),
    getMeta: (key) => meta.get(key),
    setMeta: (key, value) => meta.set(key, value),
    deleteMeta: (key) => meta.delete(key),
  }
  return { db, writes, journal, meta }
}

const llmFrom = (responses) => {
  let i = 0
  return {
    get calls () { return i },
    stream () {
      const body = JSON.stringify({ episodes: [responses[Math.min(i, responses.length - 1)]] })
      i++
      return (async function* () { yield { type: 'text-delta', text: body } })()
    },
  }
}

test('校验失败会带原因重试，第二次合法时落合法结果并记 aggregate-retry', async () => {
  const { db, writes, journal } = makeDb()
  const bad = { ...validEp, title: '很'.repeat(68) }
  const llm = llmFrom([bad, validEp])
  const out = await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true })
  assert.equal(llm.calls, 2)
  assert.ok(journal.some(e => e.kind === 'aggregate-retry' && e.detail.reasons.includes('title-length')))
  assert.equal(writes.length, 1)
  assert.equal(writes[0][3].title, validEp.title)
  assert.equal(out[0].title, validEp.title)
})

test('两次都不合法走机械 fallback，并写冷却重试而不是永久 skip', async () => {
  const { db, writes, journal, meta } = makeDb()
  const now = Date.now()
  const bad = { ...validEp, title: '很'.repeat(68) }
  const llm = llmFrom([bad, bad, bad])
  const out = await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true, now })
  assert.equal(llm.calls, 3)
  const cooldown = journal.find(e => e.kind === 'aggregate-cooldown')
  assert.ok(cooldown)
  assert.equal(cooldown.detail.reason, 'validation:title-length')
  assert.equal(meta.get('aggSkipped:s:1:2'), undefined)
  const retry = parseAggRetry(meta.get(aggRetryKey('s', 1, 2)))
  assert.equal(retry.attempts, 1)
  assert.ok(retry.nextAt >= now + 10 * 60 * 1000)
  assert.equal(writes.length, 0)
  assert.notEqual(out[0].title, validEp.title)
})

test('连续返回不可解析 JSON 会重试，最终写冷却而不是永久 skip', async () => {
  const { db, writes, journal, meta } = makeDb()
  const now = Date.now()
  let calls = 0
  const llm = {
    stream () {
      calls++
      return (async function* () { yield { type: 'text-delta', text: 'not json' } })()
    },
  }
  await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true, now })
  assert.equal(calls, 3)
  assert.ok(journal.some(e => e.kind === 'aggregate-retry' && e.detail.reasons.includes('json-parse')))
  assert.ok(journal.some(e => e.kind === 'aggregate-cooldown' && e.detail.reason === 'json-parse'))
  assert.equal(meta.get('aggSkipped:s:1:2'), undefined)
  const retry = parseAggRetry(meta.get(aggRetryKey('s', 1, 2)))
  assert.equal(retry.attempts, 1)
  assert.ok(retry.nextAt >= now + 10 * 60 * 1000)
  assert.equal(writes.length, 0)
})

test('合法 JSON 但 episodes 为空：不重试，记 no-episodes 并走 fallback', async () => {
  const { db, writes, journal, meta } = makeDb()
  let calls = 0
  const llm = {
    stream () {
      calls++
      return (async function* () { yield { type: 'text-delta', text: '{"episodes":[]}' } })()
    },
  }
  await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true })
  assert.equal(calls, 1)
  const noEp = journal.find(e => e.kind === 'aggregate-no-episodes')
  assert.ok(noEp)
  assert.equal(meta.get('aggSkipped:s:1:2'), 'no-episodes')
  assert.equal(writes.length, 0)
})

test('超时写冷却重试后再抛出，不永久 skip', async () => {
  const { db, meta } = makeDb()
  const now = Date.now()
  const llm = {
    stream () {
      return (async function* () { await new Promise(() => {}) })()
    },
  }
  await assert.rejects(
    () => buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true, callTimeoutMs: 20, now }),
    /llm-timeout/,
  )
  assert.equal(meta.get('aggSkipped:s:1:2'), undefined)
  const retry = parseAggRetry(meta.get(aggRetryKey('s', 1, 2)))
  assert.equal(retry.attempts, 1)
  assert.equal(retry.lastReason, 'timeout')
  assert.ok(retry.nextAt >= now + 10 * 60 * 1000)
})

test('已 aggSkipped 的段（旧值 1）不再调用模型，保留机械 fallback', async () => {
  const { db, writes, journal } = makeDb()
  db.setMeta('aggSkipped:s:1:2', '1')
  let calls = 0
  const llm = {
    stream () {
      calls++
      return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ episodes: [validEp] }) } })()
    },
  }
  const out = await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true })
  assert.equal(calls, 0)
  assert.equal(writes.length, 0)
  assert.equal(journal.length, 0)
  assert.ok(out.length >= 1)
})

test('maxSegments 会限制单批 LLM 段数，后续段走 fallback 且可续跑', async () => {
  const rows = rowsFor(6)
  const { db } = makeDb(rows)
  const llm = llmFrom([validEp])
  const out = await buildAndIndexEpisodesLLM(db, 's', { llm, maxSegments: 1, includeTail: true })
  assert.equal(out.attemptedSegments, 1)
  assert.ok(out.batchExhausted)
  assert.ok(out.length >= 1)
})

test('待整理段：选最旧、排除已聚合和已判定失败段', () => {
  const h = openDb(':memory:')
  try {
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,title,body,valuable) VALUES ('a',1,2,100,'a','body',1)").run()
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,title,body,valuable) VALUES ('b',3,4,50,'b','body',1)").run()
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,title,body,valuable) VALUES ('c',5,6,75,'c','body',0)").run()
    assert.equal(countPendingSegments(h.db), 2)
    assert.equal(pickOldestPendingSegment(h.db, { stableSegments: 0, minAgeMs: 0 }).session_id, 'b')
    h.db.prepare("INSERT INTO episode_aggregates(session_id,start_seq,end_seq,title,summary,cues,quote,updated_at) VALUES ('b',3,4,'b','s','c','q',1)").run()
    assert.equal(pickOldestPendingSegment(h.db, { stableSegments: 0, minAgeMs: 0 }).session_id, 'a')
    h.setMeta('aggSkipped:a:1:2', '1')
    assert.equal(countPendingSegments(h.db), 0)
  } finally { h.db.close() }
})

test('冷却中的段计入 pending，但未到期不被选中，到期后才可选', () => {
  const h = openDb(':memory:')
  const now = 1_800_000_000_000
  try {
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,title,body,valuable) VALUES ('a',1,2,100,'a','body',1)").run()
    h.setMeta(aggRetryKey('a', 1, 2), JSON.stringify({ attempts: 1, nextAt: now + 10 * 60 * 1000, lastReason: 'llm-error' }))
    assert.equal(countPendingSegments(h.db), 1)
    assert.equal(pickOldestPendingSegment(h.db, { now, stableSegments: 0, minAgeMs: 0 }), null)
    assert.equal(pickOldestPendingSegment(h.db, { now: now + 10 * 60 * 1000 + 1, stableSegments: 0, minAgeMs: 0 }).session_id, 'a')
  } finally { h.db.close() }
})

test('历史脏数据迁移：非 no-episodes 的 skip 变冷却重试，no-episodes 保留', () => {
  const h = openDb(':memory:')
  const now = 1_800_000_000_000
  try {
    h.setMeta('aggSkipped:a:1:2', 'llm-error')
    h.setMeta('aggSkipped:b:3:4', 'no-episodes')
    h.setMeta('aggSkipped:c:5:6', 'json-parse')
    const out = migrateAggRetries(h, { now })
    assert.equal(out.count, 2)
    assert.equal(h.getMeta('aggSkipped:a:1:2'), undefined)
    assert.equal(h.getMeta('aggSkipped:c:5:6'), undefined)
    assert.equal(h.getMeta('aggSkipped:b:3:4'), 'no-episodes')
    assert.deepEqual(parseAggRetry(h.getMeta(aggRetryKey('a', 1, 2))), { attempts: 1, nextAt: now, lastReason: 'llm-error' })
    assert.equal(parseAggRetry(h.getMeta(aggRetryKey('c', 5, 6))).lastReason, 'json-parse')
  } finally { h.db.close() }
})

test('节流回填只补历史：最近 2 段、10 分钟内不碰，老的段可调用', () => {
  const h = openDb(':memory:')
  const now = 1_800_000_000_000
  const add = (startSeq, endSeq, startAt, endAt) => h.db.prepare(
    "INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('s',?,?,?,?,'t','body',1)",
  ).run(startSeq, endSeq, startAt, endAt)
  try {
    add(1, 2, 100, now - 30 * 60_000)
    add(3, 4, 200, now - 20 * 60_000)
    add(5, 6, 300, now - 60_000)
    const picked = pickOldestPendingSegment(h.db, { now, minAgeMs: 10 * 60_000, stableSegments: 2 })
    assert.equal(picked?.start_seq, 1)

    const onlyRecent = openDb(':memory:')
    try {
      onlyRecent.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('r',1,2,100,?,'t','body',1)").run(now - 60_000)
      assert.equal(pickOldestPendingSegment(onlyRecent.db, { now, minAgeMs: 10 * 60_000, stableSegments: 2 }), null)
    } finally { onlyRecent.db.close() }

    const withinTen = openDb(':memory:')
    try {
      withinTen.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('w',1,2,100,?,'t','body',1)").run(now - 5 * 60_000)
      withinTen.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('w',3,4,200,?,'t','body',1)").run(now - 8 * 60_000)
      assert.equal(pickOldestPendingSegment(withinTen.db, { now, minAgeMs: 10 * 60_000, stableSegments: 2 }), null)
    } finally { withinTen.db.close() }
  } finally { h.db.close() }
})

test('节流回填开关：pending<60 不启动，>=60 才启动', () => {
  assert.equal(backfillShouldRun(59, 60), false)
  assert.equal(backfillShouldRun(60, 60), true)
  assert.equal(backfillShouldRun(61, 60), true)
  assert.equal(backfillShouldRun(52, 60), false)
})

test('节流器调用固定 includeTail:false，收尾留给 20 轮触发', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const start = src.indexOf('const seg = pickOldestPendingSegment')
  const end = src.indexOf('const calls = Number', start)
  assert.ok(start >= 0 && end > start)
  assert.match(src.slice(start, end), /includeTail:\s*false/)
})

test('回填内存阈值：heap 或 rss 超限即暂停', () => {
  assert.equal(backfillMemoryExceeded({ heapUsed: 1.3 * 1024 ** 3, rss: 0 }), true)
  assert.equal(backfillMemoryExceeded({ heapUsed: 0, rss: 2.5 * 1024 ** 3 }), true)
  assert.equal(backfillMemoryExceeded({ heapUsed: 100, rss: 200 }), false)
})

test('连续失败达到阈值才暂停', () => {
  assert.equal(backfillFailureNeedsPause(0), false)
  assert.equal(backfillFailureNeedsPause(2), false)
  assert.equal(backfillFailureNeedsPause(3), true)
  assert.equal(backfillFailureNeedsPause(5, 3), true)
})

test('idle 会话放行：全局不足 60，但 24h 没聊的会话有欠账时优先回填', () => {
  const h = openDb(':memory:')
  const now = 1_800_000_000_000
  try {
    h.insert({ seq: 1, sessionId: 'idle', role: 'user', time: now - 25 * 3600_000, text: 'idle 旧消息' })
    h.insert({ seq: 2, sessionId: 'active', role: 'user', time: now - 3600_000, text: 'active 新消息' })
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('idle',1,2,100,?,'idle','body',1)").run(now - 25 * 3600_000)
    h.db.prepare("INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,valuable) VALUES ('active',1,2,200,?,'active','body',1)").run(now - 2 * 3600_000)

    const idleIds = findIdleSessionIds(h.db, { now, idleMs: 24 * 3600_000 })
    assert.deepEqual(idleIds, ['idle'])
    assert.equal(countPendingSegmentsIn(h.db, 'idle'), 1)
    assert.equal(countPendingSegmentsIn(h.db, 'active'), 1)
    assert.equal(backfillShouldRun(1, 60, idleIds), true)
    assert.equal(pickOldestPendingSegment(h.db, { now, minAgeMs: 0, stableSegments: 0, idleSessionIds: idleIds }).session_id, 'idle')
  } finally { h.db.close() }
})

test('没有 idle 会话时全局不足 60 不启动；全局 >=60 照常启动', () => {
  const active = { now: 1_800_000_000_000 }
  const h = openDb(':memory:')
  try {
    h.insert({ seq: 1, sessionId: 'active', role: 'user', time: active.now - 3600_000, text: '刚刚说过话' })
    assert.deepEqual(findIdleSessionIds(h.db, { now: active.now }), [])
    assert.equal(backfillShouldRun(10, 60, []), false)
    assert.equal(backfillShouldRun(70, 60, []), true)
  } finally { h.db.close() }
})

test('内存阈值压到 600MB heap / 900MB rss（1GB 总上限）', () => {
  const MB = 1024 ** 2
  assert.equal(backfillMemoryExceeded({ heapUsed: 600 * MB, rss: 900 * MB }), false)
  assert.equal(backfillMemoryExceeded({ heapUsed: 601 * MB, rss: 0 }), true)
  assert.equal(backfillMemoryExceeded({ heapUsed: 0, rss: 901 * MB }), true)
})

test('回填会话结束：pending=0 时先 shrink_memory，再记 session-done；无 global.gc 不抛', async () => {
  const calls = []
  const journal = []
  const MB = 1024 ** 2
  let memCall = 0
  const memoryUsage = () => ({ rss: (memCall++ === 0 ? 900 : 700) * MB, heapUsed: (memCall === 1 ? 500 : 350) * MB })
  const db = { exec: (sql) => calls.push(sql) }
  const result = await finishBackfillSession({
    db,
    sessionId: 's',
    memBefore: { rss: 900 * MB, heapUsed: 500 * MB },
    journal: (kind, detail) => journal.push({ kind, detail }),
    log: () => {},
    countPending: () => 0,
    release: (opts) => releaseBackfillMemory({ ...opts, gc: undefined, setImmediateFn: (r) => r(), memoryUsage }),
  })
  assert.deepEqual(calls, ['PRAGMA shrink_memory'])
  assert.equal(result.pending, 0)
  assert.equal(result.rssBeforeMB, 900)
  assert.equal(result.rssAfterMB, 700)
  const done = journal.find(e => e.kind === 'backfill-session-done')
  assert.ok(done)
  assert.equal(done.detail.sessionId, 's')
  assert.equal(done.detail.rssBeforeMB, 900)
  assert.equal(done.detail.rssAfterMB, 700)
  assert.ok(journal.some(e => e.kind === 'backfill-memory-release'))
})

test('回填会话未归零也释放内存，但不记 session-done', async () => {
  const journal = []
  await finishBackfillSession({
    db: { exec: () => {} },
    sessionId: 's',
    journal: (kind, detail) => journal.push({ kind, detail }),
    countPending: () => 3,
    release: async () => ({ rssBeforeMB: 800, rssAfterMB: 700, heapBeforeMB: 400, heapAfterMB: 300 }),
  })
  assert.ok(journal.some(e => e.kind === 'backfill-memory-release'))
  assert.equal(journal.some(e => e.kind === 'backfill-session-done'), false)
})
