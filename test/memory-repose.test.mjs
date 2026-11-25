import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../lib/db.js'
import { rankEpisodes } from '../lib/pipeline.js'
import { searchView, readView } from '../lib/memory-tools.js'
import { reposeView } from '../lib/repose.js'

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-repose-'))
  const dbPath = join(root, 'index.sqlite')
  const handle = openDb(dbPath)
  const sessionId = 'session-repose'
  const mk = (rawSeq, text) => handle.insert({ seq: rawSeq, sessionId, role: 'user', time: 1_700_000_000_000 + rawSeq, text })
  const s1 = mk(1, '他说婚礼那句我会反复拿来测试')
  const s2 = mk(2, '婚礼的约定是再说一遍')
  const s3 = mk(3, '另一件不相关的事')
  handle.indexEpisodes(sessionId, [
    {
      startSeq: s1, endSeq: s1, startAt: 1_700_000_001_000, endAt: 1_700_000_001_000,
      title: '婚礼反复测试', body: '他说婚礼那句我会反复拿来测试', summary: '他说婚礼那句我会反复拿来测试。', cues: '婚礼 测试',
    },
    {
      startSeq: s2, endSeq: s2, startAt: 1_700_000_002_000, endAt: 1_700_000_002_000,
      title: '婚礼约定', body: '婚礼的约定是再说一遍', summary: '婚礼的约定是再说一遍。', cues: '婚礼 约定 再说一遍',
    },
    {
      startSeq: s3, endSeq: s3, startAt: 1_700_000_003_000, endAt: 1_700_000_003_000,
      title: '不相关', body: '另一件不相关的事', summary: '另一件不相关的事。', cues: '不相关',
    },
  ])
  return { root, handle, sessionId, s1, s2, s3 }
}

test('标记后排序在后、撤销复原、全部标记仍返回', () => {
  const { root, handle, s1, s2 } = seed()
  try {
    const before = rankEpisodes(handle, '婚礼', { limit: 10 }).rows
    assert.ok(before.length >= 2)
    assert.equal(before[0].start_seq, s2) // s2 的 summary/cues 命中更完整，先于 s1
    const baselineOrder = before.map(r => r.start_seq)

    assert.match(reposeView(handle, { seq: s1, reason: '婚礼那句反复测试' }), /安放好了/)
    const marked = rankEpisodes(handle, '婚礼', { limit: 10 }).rows
    assert.equal(marked[0].start_seq, s2)
    assert.equal(marked.at(-1).start_seq, s1)
    assert.equal(marked.find(r => r.start_seq === s1)?.simplified, true)

    assert.match(reposeView(handle, { seq: s1, simplified: false }), /撤销了/)
    const restored = rankEpisodes(handle, '婚礼', { limit: 10 }).rows.map(r => r.start_seq)
    assert.deepEqual(restored, baselineOrder)

    reposeView(handle, { seq: s1 })
    reposeView(handle, { seq: s2 })
    const allMarked = rankEpisodes(handle, '婚礼', { limit: 10 }).rows
    assert.ok(allMarked.length >= 2, '全部标记时不能返回空')
    assert.equal(allMarked[0].start_seq, s2, '全标记时保持原 score 顺序')
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }) }
})

test('标记条目进 tail；memory_remember 仍返回全文；未标记排序不变', () => {
  const { root, handle, s1, s2 } = seed()
  try {
    const baseline = rankEpisodes(handle, '婚礼', { limit: 10 }).rows.map(r => r.start_seq)
    reposeView(handle, { seq: s1, reason: '短测试' })
    const after = rankEpisodes(handle, '婚礼', { limit: 10 }).rows
    const unmarkedAfter = after.filter(r => !r.simplified).map(r => r.start_seq)
    const unmarkedBase = baseline.filter(id => id !== s1)
    assert.deepEqual(unmarkedAfter, unmarkedBase, '未标记条目的相对顺序不变')

    const text = searchView(handle, { query: '婚礼', limit: 1, tail: 5 })
    assert.match(text, /#\d+ \u00b7 /)
    assert.match(text, /另有 \d+ 条相关但较弱的/)
    assert.match(text, new RegExp(`#${s1}`), '标记条目应出现在 tail')
    assert.ok(!text.includes(`#${s2} \u00b7 `) || text.indexOf(`#${s2}`) < text.indexOf('另有'))

    const mark = reposeView(handle, { seq: s1 })
    assert.match(mark, /安放好了/)
    const remembered = readView(handle, { seq: s1, span: 1 })
    assert.match(remembered, /婚礼那句我会反复拿来测试/)
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }) }
})

test('回执带理由、remember 末尾附注、时间和 tail 里不显示理由', () => {
  const { root, handle, s1, s2 } = seed()
  try {
    const withReason = reposeView(handle, { seq: s1, reason: '只是我们反复拿来测试的' })
    assert.match(withReason, new RegExp(`^安放好了：#${s1} · 只是我们反复拿来测试的$`))
    const noReason = reposeView(handle, { seq: s2 })
    assert.match(noReason, new RegExp(`^安放好了：#${s2} · 婚礼约定$`))

    const remembered = readView(handle, { seq: s1, span: 1 })
    assert.ok(remembered.startsWith(`${s1} · 你：他说婚礼那句我会反复拿来测试\n`), '正文必须逐字且附注另起一行')
    assert.match(remembered, /〔安放于 \d{4}-\d{2}-\d{2}，理由「只是我们反复拿来测试的」；想拿回来随时说。〕$/)

    const topOnly = searchView(handle, { query: '婚礼', limit: 1, tail: 0 })
    assert.ok(!topOnly.includes(`#${s1} · `), 's1 不应出现在 top 正文块')
    assert.ok(!topOnly.includes('理由'), '召回不显示理由')
    const byDate = searchView(handle, { from: '2023-11-15', to: '2023-11-15', limit: 5 })
    assert.ok(byDate.includes(`#${s1}`), '按日期查应照常出现')
    assert.ok(!byDate.includes('理由'), '纯时间召回不显示理由')

    reposeView(handle, { seq: s1, simplified: false })
    const afterUndo = readView(handle, { seq: s1, span: 1 })
    assert.equal(afterUndo.includes('〔安放于'), false)
    const restored = rankEpisodes(handle, '婚礼', { limit: 10 }).rows
    assert.equal(restored.find(r => r.start_seq === s1)?.simplified, false)
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }) }
})

test('批量安放/撤销、无效编号单列、共用理由落库、回执不含正文', () => {
  const { root, handle, s1, s2, s3 } = seed()
  try {
    const out = reposeView(handle, { seqs: [s1, s2, 999999], reason: '整批共用理由' })
    const lines = out.split('\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0], new RegExp(`^安放好了：#${s1} · 整批共用理由$`))
    assert.match(lines[1], new RegExp(`^安放好了：#${s2} · 整批共用理由$`))
    assert.match(lines[2], /^没找到：#999999$/)
    assert.equal(out.includes('他说婚礼那句我会反复拿来测试'), false)
    for (const id of [s1, s2]) {
      const row = handle.db.prepare('SELECT simplified, reason FROM episode_detail WHERE episode_id = ?').get(String(id))
      assert.deepEqual({ ...row }, { simplified: 1, reason: '整批共用理由' })
    }
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM episode_detail WHERE episode_id = ?').get(String(s3)).n, 0)

    const undo = reposeView(handle, { seqs: [s1, s2], simplified: false })
    assert.equal(undo, `撤销了：#${s1}\n撤销了：#${s2}`)
    for (const id of [s1, s2]) {
      const row = handle.db.prepare('SELECT simplified FROM episode_detail WHERE episode_id = ?').get(String(id))
      assert.equal(row.simplified, 0)
    }
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }) }
})

test('批量超过 20 条直接拒绝；seq 与 seqs 同给时 seqs 优先', () => {
  const { root, handle, s1, s2 } = seed()
  try {
    const tooMany = Array.from({ length: 21 }, (_, i) => s1 + i)
    const out = reposeView(handle, { seqs: tooMany })
    assert.match(out, /一次最多 20 条/)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM episode_detail').get().n, 0)

    const picked = reposeView(handle, { seq: s1, seqs: [s2], reason: '只标第二条' })
    assert.equal(picked, `安放好了：#${s2} · 只标第二条`)
    assert.equal(handle.db.prepare('SELECT COUNT(*) AS n FROM episode_detail WHERE episode_id = ?').get(String(s1)).n, 0)
    assert.equal(handle.db.prepare('SELECT simplified FROM episode_detail WHERE episode_id = ?').get(String(s2)).simplified, 1)
  } finally { handle.close(); rmSync(root, { recursive: true, force: true }) }
})

test('不存在/非法 seq 明确拒绝；episode_detail 迁移可重复打开；journal 记录', () => {
  const { root, handle, s1 } = seed()
  try {
    assert.match(reposeView(handle, { seq: 999999 }), /没有这条记忆/)
    assert.match(reposeView(handle, { seq: 'not-a-seq' }), /需要记忆的/)
    assert.match(reposeView(handle, { seq: s1, reason: '以后不用细想' }), /安放好了/)
    const row = handle.db.prepare('SELECT episode_id, session_id, simplified, reason FROM episode_detail WHERE episode_id = ?').get(String(s1))
    assert.deepEqual({ ...row }, { episode_id: String(s1), session_id: 'session-repose', simplified: 1, reason: '以后不用细想' })
    const journal = handle.db.prepare("SELECT detail FROM journal WHERE kind = 'memory-repose' ORDER BY rowid DESC LIMIT 1").get()
    assert.equal(JSON.parse(journal.detail).simplified, true)
  } finally { handle.close() }
  const again = openDb(join(root, 'index.sqlite'))
  try {
    assert.ok(again.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='episode_detail'").get())
    assert.equal(Number(again.db.prepare('SELECT COUNT(*) AS n FROM episode_detail').get().n), 1)
  } finally { again.close(); rmSync(root, { recursive: true, force: true }) }
})
