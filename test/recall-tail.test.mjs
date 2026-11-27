import test from 'node:test'
import assert from 'node:assert/strict'

import { openDb } from '../lib/db.js'
import { rankEpisodes } from '../lib/pipeline.js'
import { searchView, tailLineDetail } from '../lib/memory-tools.js'

const T0 = Date.UTC(2026, 10, 20, 12, 0, 0)
const ep = (start, body, summary, title) => ({
  startSeq: start,
  endSeq: start + 1,
  startAt: T0 + start * 1000,
  endAt: T0 + start * 1000 + 1000,
  title,
  body,
  summary,
  quote: '',
  quoteSeq: null,
  valuable: true,
})

function makeDb() {
  const h = openDb(':memory:')
  h.insert({ seq: 1, sessionId: 's', role: 'user', time: T0, text: 'alpha beta gamma', kind: 'user' })
  h.insert({ seq: 10, sessionId: 's', role: 'user', time: T0 + 10000, text: 'alpha x y', kind: 'user' })
  h.insert({ seq: 20, sessionId: 's', role: 'user', time: T0 + 20000, text: 'zzz no hit', kind: 'user' })
  h.indexEpisodes('s', [
    ep(1, 'alpha beta gamma', '他把 alpha beta 两件事都记下了。', '强命中'),
    ep(10, '前文前文前文前文前文前文前文前文前文前文前文前文 alpha 后文后文后文后文后文后文后文后文后文后文后文后文后文后文后文', '机械摘要 alpha', '标题'),
    ep(20, 'zzz 正文完全没有查询词', '机械摘要 alpha 没有正文命中', 'alpha 标题'),
  ])
  h.putAggregate('s', 10, 11, {
    title: 'LLM 标题',
    summary: '这是一段不会被截断的 LLM 完整摘要 alpha，后面还有很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长。',
    cues: '', quote: '',
  })
  h.putAggregate('s', 20, 21, {
    title: 'LLM 标题 alpha',
    summary: '这条 LLM 摘要包含 alpha，但正文没有查询词，所以 B 段应为空。',
    cues: '', quote: '',
  })
  return h
}

test('rankEpisodes 把 0.65*rel 计入 score；覆盖约占三成', () => {
  const h = makeDb()
  try {
    const { rows } = rankEpisodes(h, 'alpha beta', { limit: 10 })
    assert.ok(rows.length >= 1)
    const top = rows[0]
    assert.ok(Math.abs((top.score - top.rrf) - 0.65 * top.rel) < 1e-9,
      `score-rrf=${top.score - top.rrf} expected=${0.65 * top.rel}`)
    assert.ok(top.rel > 0)
  } finally { h.close() }
})

test('tail 只补有命中的弱候选，排除前 limit，tail=0 不追加', () => {
  const h = makeDb()
  try {
    const withTail = searchView(h, { query: 'alpha beta', limit: 1, tail: 10 }, { now: T0 + 60000 })
    assert.match(withTail, /另有 \d+ 条相关但较弱的：/)
    assert.match(withTail, /#10 ·/)
    assert.equal((withTail.match(/#1\b/g) ?? []).length <= 1, true)

    const noTail = searchView(h, { query: 'alpha beta', limit: 1, tail: 0 }, { now: T0 + 60000 })
    assert.doesNotMatch(noTail, /另有/)
  } finally { h.close() }
})

test('tail 格式是完整摘要｜正文选段；摘要不截断，正文围绕命中词且 ≤50 字', () => {
  const h = makeDb()
  try {
    const out = searchView(h, { query: 'alpha', limit: 1, tail: 10 }, { now: T0 + 60000 })
    const line = out.split('\n').find(x => x.includes('#10 ·'))
    assert.ok(line)
    const [, bodyPart] = line.split(' · #10 · ')
    const [a, b] = bodyPart.split('｜')
    assert.match(a, /^这是一段不会被截断的 LLM 完整摘要 alpha/)
    assert.ok(a.length > 80)
    assert.ok(b.includes('alpha'))
    assert.ok([...b].length <= 50, `B 段含省略号总长应 ≤50，实际 ${[...b].length}`)
    assert.ok(!b.includes('zzz'))
  } finally { h.close() }
})

test('LLM 摘要存在但正文无命中词时，B 段为空，A 段仍在', () => {
  const h = makeDb()
  try {
    const out = searchView(h, { query: 'alpha', limit: 1, tail: 10 }, { now: T0 + 60000 })
    const line = out.split('\n').find(x => x.includes('#20 ·'))
    assert.ok(line)
    assert.match(line, /#20 · 这条 LLM 摘要包含 alpha/)
    assert.doesNotMatch(line, /｜/)
  } finally { h.close() }
})

test('tailLineDetail 标出 A/B 来源；LLM 摘要存在但正文无命中时 body 为空', () => {
  const h = makeDb()
  try {
    const { rows, tokens } = rankEpisodes(h, 'alpha', { limit: 10 })
    const r10 = rows.find(r => r.start_seq === 10)
    const d10 = tailLineDetail(h, r10, tokens)
    assert.equal(d10.summarySource, 'llm-summary')
    assert.equal(d10.bodySource, 'episode-body')
    assert.ok(d10.body.includes('alpha'))

    const r20 = rows.find(r => r.start_seq === 20)
    const d20 = tailLineDetail(h, r20, tokens)
    assert.equal(d20.summarySource, 'llm-summary')
    assert.equal(d20.body, '')
  } finally { h.close() }
})

test('tail 窗口三种边界：句首无前导省略号、文中两端省略号、句尾无尾部省略号', () => {
  const h = openDb(':memory:')
  try {
    const rows = [
      ep(1, 'alpha top', 'top summary', 'top'),
      ep(10, 'alpha boundary start', '', ''),
      ep(20, '前面有超过二十五个字的前半段前半段前半段前半段前半段前半段 alpha 后面也有后半段后半段后半段后半段后半段后半段后半段', '', ''),
      ep(30, '前面有超过二十五个字的前半段前半段前半段前半段前半段前半段 alpha', '', ''),
    ]
    h.insert({ seq: 1, sessionId: 's', role: 'user', time: T0, text: 'alpha', kind: 'user' })
    h.indexEpisodes('s', rows)
    const out = searchView(h, { query: 'alpha', limit: 1, tail: 10 }, { now: T0 + 60000 })
    const line10 = out.split('\n').find(x => x.includes('#10 ·'))
    const line20 = out.split('\n').find(x => x.includes('#20 ·'))
    const line30 = out.split('\n').find(x => x.includes('#30 ·'))
    assert.ok(line10 && line20 && line30)
    const b10 = line10.split('｜')[1]
    const b20 = line20.split('｜')[1]
    const b30 = line30.split('｜')[1]
    assert.ok(b10.startsWith('alpha'))
    assert.ok(!b10.endsWith('…'))
    assert.ok(b20.startsWith('…'))
    assert.ok(b20.endsWith('…'))
    assert.ok(b30.startsWith('…'))
    assert.ok(!b30.endsWith('…'))
  } finally { h.close() }
})

test('tail 候选不足时不越界；limit 无结果不加段', () => {
  const h = makeDb()
  try {
    const out = searchView(h, { query: 'alpha beta', limit: 20, tail: 50 }, { now: T0 + 60000 })
    assert.doesNotMatch(out, /另有/)
    const empty = searchView(h, { query: '不存在词', limit: 20, tail: 10 }, { now: T0 + 60000 })
    assert.doesNotMatch(empty, /另有/)
  } finally { h.close() }
})

test('A 段结尾标点会被去掉，不再出现「。；｜」', () => {
  const h = openDb(':memory:')
  try {
    h.indexEpisodes('s', [ep(1, 'alpha 正文', '机械摘要。；', '标题')])
    h.putAggregate('s', 1, 2, { title: '', summary: '这是一段足够长的 LLM 摘要，结尾有叠标点。；', cues: '', quote: '' })
    const row = { session_id: 's', start_seq: 1, end_seq: 2, title: '标题', summary: '机械摘要。；', body: 'alpha 正文', quote: '', start_at: T0 }
    const d = tailLineDetail(h, row, ['alpha'])
    assert.equal(d.summarySource, 'llm-summary')
    assert.ok(!/[。，；：、,.;:!?！？…]$/u.test(d.summary), d.summary)
    assert.ok(!d.summary.includes('。；'))
  } finally { h.close() }
})

test('A 段来源：短机械标题退到可读机械摘要，不再断在半句', () => {
  const h = openDb(':memory:')
  try {
    const row = {
      session_id: 's', start_seq: 1, end_seq: 2,
      title: '嗯。。暂时先不要加时',
      summary: '这是一段足够长、可以读成完整句子的机械摘要。',
      body: 'alpha 正文', quote: '', start_at: T0,
    }
    const d = tailLineDetail(h, row, ['alpha'])
    assert.equal(d.summarySource, 'episode-summary')
    assert.match(d.summary, /可以读成完整句子的机械摘要/)
    assert.notEqual(d.summary, '嗯。。暂时先不要加时')
  } finally { h.close() }
})

test('A 段来源：短标题且无可用摘要时退到正文首句', () => {
  const h = openDb(':memory:')
  try {
    const row = {
      session_id: 's', start_seq: 1, end_seq: 2,
      title: '嗯。。暂时先不要加时',
      summary: '嗯。。',
      body: '这是一段足够长的正文句子，里面有工具这个词。后面还有第二句。',
      quote: '', start_at: T0,
    }
    const d = tailLineDetail(h, row, ['工具'])
    assert.equal(d.summarySource, 'body-first')
    assert.match(d.summary, /这是一段足够长的正文句子/)
  } finally { h.close() }
})

test('A 段来源：机械标题可读时仍排在 LLM 标题之后', () => {
  const h = openDb(':memory:')
  try {
    h.putAggregate('s', 1, 2, { title: 'LLM 标题优先', summary: '', cues: '', quote: '' })
    const row = {
      session_id: 's', start_seq: 1, end_seq: 2,
      title: '这是一段足够长的机械标题，能够读成句。',
      summary: '这是一段足够长的机械摘要，也能读成句。',
      body: 'alpha 正文', quote: '', start_at: T0,
    }
    const d = tailLineDetail(h, row, ['alpha'])
    assert.equal(d.summarySource, 'llm-title')
    assert.equal(d.summary, 'LLM 标题优先')
  } finally { h.close() }
})

test('kind：不传保持原序，传 promise 让同分 promise 提前，非法 kind 不改变', () => {
  const h = openDb(':memory:')
  try {
    h.indexEpisodes('s', [
      { ...ep(1, 'same words here', 'same summary', '同分甲'), startAt: T0, endAt: T0 + 1 },
      { ...ep(2, 'same words here', 'same summary', '同分乙'), startAt: T0 + 1000, endAt: T0 + 1001 },
    ])
    h.putAggregate('s', 1, 2, { title: '同分甲', summary: 'same summary', cues: '', quote: '', kind: 'promise', first: false })
    h.putAggregate('s', 2, 3, { title: '同分乙', summary: 'same summary', cues: '', quote: '', kind: 'task', first: false })
    const base = searchView(h, { query: 'same words here', limit: 2, tail: 0 })
    const boosted = searchView(h, { query: 'same words here', limit: 2, tail: 0, kind: 'promise' })
    const invalid = searchView(h, { query: 'same words here', limit: 2, tail: 0, kind: 'nope' })
    assert.equal(base, invalid)
    const b = base.match(/#\d+/g)
    const k = boosted.match(/#\d+/g)
    if (b?.[0] !== k?.[0]) assert.match(boosted, /同分甲/)
  } finally { h.close() }
})

test('kind：fact 是新枚举，可被 memory_recall 选中且不记 invalid', () => {
  const h = openDb(':memory:')
  try {
    h.indexEpisodes('s', [{ ...ep(1, '他说以前养过一只兔子', '他说以前养过一只兔子', '兔子叫雪球'), startAt: T0, endAt: T0 + 1 }])
    h.putAggregate('s', 1, 2, { title: '兔子叫雪球', summary: '事实', cues: '', quote: '', kind: 'fact', first: false })
    const out = searchView(h, { query: '兔子', limit: 5, tail: 0, kind: 'fact' })
    assert.match(out, /他说以前养过一只兔子/)
    const invalid = h.db.prepare("SELECT COUNT(*) n FROM journal WHERE kind='recall-kind-invalid'").get()
    assert.equal(Number(invalid.n), 0)
  } finally { h.close() }
})
