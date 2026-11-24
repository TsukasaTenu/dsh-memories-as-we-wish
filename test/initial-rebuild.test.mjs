// 初建队列的断点/失败隔离/LLM 超时测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { callExtract, callExtractWithRetry } from '../lib/extract.js'
import { buildAndIndexEpisodesLLM } from '../lib/aggregate.js'
import {
  backfillInitialRebuildDone, createSerialGate, initialRebuildPending,
  runInitialRebuildQueue, scanInBatches, waitForDisk,
} from '../index.js'

const hangingLlm = {
  calls: 0,
  async *stream() {
    this.calls++
    await new Promise(() => {}) // 永不返回
  },
}

test('callExtract 超时会放弃等待并标记 timedOut', async () => {
  const started = Date.now()
  const r = await callExtract(hangingLlm, { prompt: 'test', timeoutMs: 60 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.match(r.error, /timeout/)
  assert.ok(Date.now() - started < 2000)
})

test('callExtractWithRetry 超时后不再第二次调用模型', async () => {
  const llm = {
    calls: 0,
    async *stream() {
      this.calls++
      await new Promise(() => {})
    },
  }
  const r = await callExtractWithRetry(llm, { prompt: 'test', timeoutMs: 60 })
  assert.equal(r.timedOut, true)
  assert.equal(llm.calls, 1)
})

test('聚合层超时向上抛出，不能吞成机械 fallback', async () => {
  const rows = [
    { seq: 1, raw_seq: 1, role: 'user', time: 1, text: '训练员：今天我们去很远的地方走了一圈，路上说了很多关于以后的话，我想把这一天记住。' },
    { seq: 2, raw_seq: 2, role: 'assistant', time: 2, text: '我：嗯，这一天我会记住的。风很轻，路很长，我们约好以后还要再走一次。' },
  ]
  const db = {
    db: { prepare: () => ({ all: () => rows }) },
    getAggregate: () => null,
    putAggregate: () => {},
    indexEpisodes: () => {},
  }
  const llm = {
    stream() {
      return (async function* () { await new Promise(() => {}) })()
    },
  }
  await assert.rejects(
    buildAndIndexEpisodesLLM(db, 's', { llm, maxCalls: 1, includeTail: true, callTimeoutMs: 30 }),
    /llm-timeout/,
  )
})

test('初建队列：已 done / failed / llmAggDone 的会话不重跑', () => {
  const meta = new Map([
    ['initialRebuildDone:a', '1'],
    ['initialRebuildFailed:b', '1'],
    ['llmAggDone:d', '1'],
  ])
  const pending = initialRebuildPending(['a', 'b', 'c', 'd', 'c'], (key) => meta.get(key) ?? '')
  assert.deepEqual(pending, ['c'])
})

test('旧库只有 llmAggDone 时：pending 为空，并补写 initialRebuildDone 归一', () => {
  const meta = new Map([['llmAggDone:legacy', '1']])
  const all = ['legacy']
  const pending = initialRebuildPending(all, (key) => meta.get(key) ?? '')
  assert.deepEqual(pending, [])
  const n = backfillInitialRebuildDone(all, (key) => meta.get(key) ?? '', (key, value) => meta.set(key, value))
  assert.equal(n, 1)
  assert.equal(meta.get('initialRebuildDone:legacy'), '1')
  assert.deepEqual(initialRebuildPending(all, (key) => meta.get(key) ?? ''), [])
})

test('初建队列：单会话失败标 failed 后继续下一个，且断点可续跑', async () => {
  const calls = []
  const meta = new Map()
  const events = []
  const params = {
    pending: ['a', 'b', 'c'],
    aggregate: async (sid) => {
      calls.push(sid)
      if (sid === 'b') throw new Error('boom')
      return { segments: 1, episodes: 1 }
    },
    setMeta: (key, value) => meta.set(key, value),
    journal: (kind, detail) => events.push({ kind, detail }),
    log: () => {},
    delayMs: 0,
  }
  const r = await runInitialRebuildQueue(params)
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.equal(r.done, 2)
  assert.equal(r.failed, 1)
  assert.equal(meta.get('initialRebuildDone:a'), '1')
  assert.equal(meta.get('initialRebuildFailed:b'), '1')
  assert.equal(meta.get('initialRebuildDone:c'), '1')
  assert.ok(events.some(e => e.kind === 'initial-rebuild-session-failed' && e.detail.sessionId === 'b'))

  // 再次启动：只跑未完成（b 已 failed，a/c 已 done），队列为空。
  const again = initialRebuildPending(['a', 'b', 'c'], (key) => meta.get(key) ?? '')
  assert.deepEqual(again, [])
})

test('护栏：低磁盘暂停并 journal，恢复后继续', async () => {
  const events = []
  const free = [10 * 1024 ** 3, 10 * 1024 ** 3, 40 * 1024 ** 3]
  const r = await waitForDisk({
    label: 'scan',
    path: 'C:/',
    minFreeBytes: 30 * 1024 ** 3,
    pauseMs: 1,
    journal: (kind, detail) => events.push({ kind, detail }),
    getFreeBytes: () => (free.length > 1 ? free.shift() : free[0]),
    sleep: async () => {},
  })
  assert.equal(r.paused, true)
  assert.deepEqual(events.map(e => e.kind), ['rebuild-paused-lowdisk', 'rebuild-resumed-lowdisk'])
})

test('护栏：全终端扫描分批，批边界让出事件循环', async () => {
  const order = []
  const before = []
  const after = []
  let yields = 0
  await scanInBatches([1, 2, 3, 4, 5, 6, 7], (n) => order.push(n), {
    batchSize: 3,
    beforeBatch: (i) => before.push(i),
    afterBatch: (done) => after.push(done),
    yieldFn: async () => { yields++ },
  })
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(before, [0, 3, 6])
  assert.deepEqual(after, [3, 6, 7])
  assert.equal(yields, 3)
})

test('护栏：全局聚合串行，同一时刻只有一个任务', async () => {
  const runSerial = createSerialGate()
  let active = 0
  let maxActive = 0
  const task = (n) => runSerial(async () => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    return n
  })
  const results = await Promise.all([task(1), task(2), task(3)])
  assert.deepEqual(results, [1, 2, 3])
  assert.equal(maxActive, 1)
})
