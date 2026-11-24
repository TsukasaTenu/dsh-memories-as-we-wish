import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, SEQ_BASE } from '../lib/db.js'

const OLD_BASE = 1_000_000

function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seq-base-'))
  return { dir, path: join(dir, 'index.sqlite') }
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* Windows WAL 句柄释放有延迟 */ }
}

function makeOldDb(path) {
  const h = openDb(path)
  // 模拟旧库：基数 100 万，两个会话 ordinal 1 / 2。
  h.setMeta('seq-base', String(OLD_BASE))
  h.setMeta('ordinal:s1', '1')
  h.setMeta('ordinal:s2', '2')
  h.setMeta('ordinal-next', '2')
  const ins = h.db.prepare('INSERT OR REPLACE INTO messages(seq, session_id, role, time, text, kind, status, raw_seq) VALUES (?,?,?,?,?,?,?,?)')
  ins.run(OLD_BASE + 10, 's1', 'user', 1, 'session one hello', null, 'active', 10)
  ins.run(OLD_BASE + 20, 's1', 'assistant', 2, 'session one answer', null, 'active', 20)
  ins.run(2 * OLD_BASE + 10, 's2', 'user', 3, 'session two hello', null, 'active', 10)
  h.db.prepare(`INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,quote,quote_seq,valuable,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active')`).run('s1', OLD_BASE + 10, OLD_BASE + 20, 1, 2, 't', 'body one', 'quote one', OLD_BASE + 20, 1)
  h.db.prepare(`INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,quote,quote_seq,valuable,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active')`).run('s2', 2 * OLD_BASE + 10, 2 * OLD_BASE + 10, 3, 3, 't2', 'body two', 'quote two', 2 * OLD_BASE + 10, 1)
  h.putAggregate('s1', OLD_BASE + 10, OLD_BASE + 20, { title: 'a', summary: 's', cues: ['c'], quote: 'q' })
  h.putAggregate('s2', 2 * OLD_BASE + 10, 2 * OLD_BASE + 10, { title: 'b', summary: 's', cues: [], quote: 'q' })
  h.close()
}

test('新库直接使用 1000 万基数', () => {
  const { dir, path } = tempPath()
  try {
    const h = openDb(path)
    assert.equal(h.getMeta('seq-base'), String(SEQ_BASE))
    const row = h.insert({ sessionId: 's1', seq: 123, role: 'user', time: 1, text: 'hello' })
    assert.equal(row, SEQ_BASE + 123)
    h.close()
  } finally { cleanup(dir) }
})

test('旧库迁移：行数/分布/各区段 max 差值正确，FTS 可用', () => {
  const { dir, path } = tempPath()
  try {
    makeOldDb(path)
    const h = openDb(path)
    assert.equal(h.getMeta('seq-base'), String(SEQ_BASE))
    assert.equal(h.count(), 3)
    const rows = h.db.prepare('SELECT session_id, seq, raw_seq FROM messages ORDER BY session_id, seq').all()
    assert.deepEqual(rows.map(r => [r.session_id, r.seq, r.raw_seq]), [
      ['s1', SEQ_BASE + 10, 10],
      ['s1', SEQ_BASE + 20, 20],
      ['s2', 2 * SEQ_BASE + 10, 10],
    ])
    const ep = h.db.prepare('SELECT session_id, start_seq, end_seq, quote_seq FROM episodes_v2 ORDER BY session_id').all()
    assert.deepEqual(ep.map(r => [r.session_id, r.start_seq, r.end_seq, r.quote_seq]), [
      ['s1', SEQ_BASE + 10, SEQ_BASE + 20, SEQ_BASE + 20],
      ['s2', 2 * SEQ_BASE + 10, 2 * SEQ_BASE + 10, 2 * SEQ_BASE + 10],
    ])
    const ag = h.db.prepare('SELECT session_id, start_seq, end_seq FROM episode_aggregates ORDER BY session_id').all()
    assert.deepEqual(ag.map(r => [r.session_id, r.start_seq, r.end_seq]), [
      ['s1', SEQ_BASE + 10, SEQ_BASE + 20],
      ['s2', 2 * SEQ_BASE + 10, 2 * SEQ_BASE + 10],
    ])
    assert.equal(h.search(['hello']).length, 2)
    const j = h.db.prepare("SELECT kind, detail FROM journal WHERE kind = 'seq-base-migrated'").all()
    assert.equal(j.length, 1)
    const detail = JSON.parse(j[0].detail)
    assert.equal(detail.oldBase, OLD_BASE)
    assert.equal(detail.newBase, SEQ_BASE)
    assert.equal(detail.sessions, 2)
    assert.equal(detail.messages, 3)
    h.close()
  } finally { cleanup(dir) }
})

test('迁移幂等：第二次打开不再迁移，journal 不新增', () => {
  const { dir, path } = tempPath()
  try {
    makeOldDb(path)
    const h1 = openDb(path)
    const first = h1.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'seq-base-migrated'").get().n
    h1.close()
    const h2 = openDb(path)
    const second = h2.db.prepare("SELECT COUNT(*) AS n FROM journal WHERE kind = 'seq-base-migrated'").get().n
    assert.equal(first, 1)
    assert.equal(second, 1)
    assert.equal(h2.count(), 3)
    h2.close()
  } finally { cleanup(dir) }
})

test('溢出保护：rawSeq >= SEQ_BASE 跳过并写 seq-overflow，不静默写入', () => {
  const { dir, path } = tempPath()
  try {
    const h = openDb(path)
    const row = h.insert({ sessionId: 's1', seq: SEQ_BASE, role: 'user', time: 1, text: 'overflow' })
    assert.equal(row, null)
    assert.equal(h.count(), 0)
    const j = h.db.prepare("SELECT detail FROM journal WHERE kind = 'seq-overflow'").all()
    assert.equal(j.length, 1)
    assert.equal(JSON.parse(j[0].detail).sessionId, 's1')
    assert.equal(JSON.parse(j[0].detail).rawSeq, SEQ_BASE)
    h.close()
  } finally { cleanup(dir) }
})
