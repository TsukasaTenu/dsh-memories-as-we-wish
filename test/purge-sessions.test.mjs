import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../lib/db.js'

const ep = (start, body) => ({ startSeq: start, endSeq: start + 1, startAt: 1, endAt: 2, title: 't', body, quote: '', quoteSeq: null, valuable: true })

test('purgeSessions 只删子代理，保留根会话并重建 FTS', () => {
  const h = openDb(':memory:')
  try {
    h.insert({ seq: 1, sessionId: 'root', role: 'user', time: 1, text: '根会话的雪球', kind: 'user' })
    h.insert({ seq: 2, sessionId: 'sub', role: 'user', time: 1, text: '子代理的秘密雪球', kind: 'user' })
    h.indexEpisodes('root', [ep(1, '根会话的雪球')])
    h.indexEpisodes('sub', [ep(2, '子代理的秘密雪球')])
    h.setMeta('aggSkipped:sub:2:3', 'validation:title-length')
    h.setMeta('aggRetryAt:sub:2:3', '1')
    const journals = []
    const r = h.purgeSessions(['sub'], (kind, detail) => journals.push({ kind, detail }))
    assert.deepEqual(r, { sessions: 1, before: { messages: 2, episodes: 2, aggregates: 0 }, after: { messages: 1, episodes: 1, aggregates: 0 } })
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='sub'").get().n, 0)
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM episodes_v2 WHERE session_id='sub'").get().n, 0)
    assert.equal(h.getMeta('aggSkipped:sub:2:3'), undefined)
    assert.equal(h.getMeta('aggRetryAt:sub:2:3'), undefined)
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='root'").get().n, 1)
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM episodes_v2 WHERE session_id='root'").get().n, 1)
    // messages FTS 可用，且不再命中子代理文本
    assert.ok(h.search(['雪球'], 10).some(x => x.session_id === 'root'))
    assert.ok(!h.search(['秘密'], 10).some(x => x.session_id === 'sub'))
    assert.equal(journals.length, 1)
    assert.equal(journals[0].kind, 'subagent-purged')
    assert.equal(journals[0].detail.sessions, 1)
  } finally { h.close() }
})
