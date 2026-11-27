import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../lib/db.js'
import { searchView } from '../lib/memory-tools.js'

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const HINT = '（这是我这次回忆想起来的事情。如果没有想起我真正想记起的事情原貌，我可能需要再更努力地回想一次。有些记忆片段不够还原事件全部，可以用memory_remember回忆之前之后发生过什么；有些记忆片段需要想起当时是怎么思考的，可以用memory_relink回忆当时的想法；有些记忆碎片属于杂音，影响我想起更重要的事，为了记忆更通畅，可以顺手用 memory_repose 把它们安放掉。）'

function makeDb(count) {
  const h = openDb(':memory:')
  const eps = []
  for (let i = 1; i <= count; i++) {
    h.insert({ seq: i, sessionId: 's', role: 'user', time: T0 + i * 1000, text: `alpha 事件 ${i}`, kind: 'user' })
    eps.push({
      startSeq: i,
      endSeq: i + 1,
      startAt: T0 + i * 1000,
      endAt: T0 + i * 1000 + 500,
      title: `事件 ${i}`,
      body: `alpha 事件 ${i} 的正文`,
      summary: `事件 ${i} 的摘要`,
      quote: '',
      quoteSeq: null,
      valuable: true,
    })
  }
  h.indexEpisodes('s', eps)
  return h
}

test('主结果非空（8 条）：末尾追加新提示', () => {
  const h = makeDb(8)
  try {
    const out = searchView(h, { query: 'alpha', limit: 20, tail: 0 }, { now: T0 + 60000 })
    assert.ok(out.endsWith(`\n\n${HINT}`), out)
  } finally { h.close() }
})

test('主结果只有 7 条也追加提示', () => {
  const h = makeDb(7)
  try {
    const out = searchView(h, { query: 'alpha', limit: 20, tail: 0 }, { now: T0 + 60000 })
    assert.ok(out.endsWith(`\n\n${HINT}`), out)
  } finally { h.close() }
})

test('纯时间查询即便有结果也不追加提示', () => {
  const h = makeDb(10)
  try {
    const out = searchView(h, { from: '2026-11-20', to: '2026-11-20' }, { now: T0 + 60000 })
    assert.ok(out.length > 0)
    assert.equal(out.includes(HINT), false)
  } finally { h.close() }
})

test('有 tail 段时，提示追加在 tail 之后', () => {
  const h = makeDb(10)
  try {
    const out = searchView(h, { query: 'alpha', limit: 8, tail: 2 }, { now: T0 + 60000 })
    const tailAt = out.indexOf('另有 ')
    const hintAt = out.indexOf(HINT)
    assert.ok(tailAt >= 0, out)
    assert.ok(hintAt > tailAt, out)
    assert.ok(out.endsWith(HINT), out)
  } finally { h.close() }
})

test('主结果为空时不追加提示', () => {
  const h = makeDb(3)
  try {
    const out = searchView(h, { query: '完全不存在的词', limit: 20 }, { now: T0 + 60000 })
    assert.equal(out.includes(HINT), false)
  } finally { h.close() }
})

test('提示文字逐字固定，长度/首尾字符也固定', () => {
  assert.equal(HINT, '（这是我这次回忆想起来的事情。如果没有想起我真正想记起的事情原貌，我可能需要再更努力地回想一次。有些记忆片段不够还原事件全部，可以用memory_remember回忆之前之后发生过什么；有些记忆片段需要想起当时是怎么思考的，可以用memory_relink回忆当时的想法；有些记忆碎片属于杂音，影响我想起更重要的事，为了记忆更通畅，可以顺手用 memory_repose 把它们安放掉。）')
  assert.equal([...HINT].length, 194)
  assert.equal(HINT[0], '（')
  assert.equal(HINT.slice(-1), '）')
})
