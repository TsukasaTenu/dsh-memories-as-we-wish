import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { openDb } from '../lib/db.js'
import {
  SOUL_EMPTY_COPY,
  SOUL_NUDGE_COOLDOWN_MS,
  readSoul,
  renderSoul,
  soulNudgeText,
  soulOverview,
  soulRemainView,
  soulVersion,
} from '../lib/soul-memory.js'

function withDb(fn) {
  const handle = openDb(':memory:')
  try { return fn(handle.db) } finally { handle.close() }
}

test('soul memory: empty database renders only the empty state', () => {
  withDb((db) => {
    assert.equal(renderSoul(db), SOUL_EMPTY_COPY)
  })
})

test('soul memory: writing self renders three sections and maintenance rules', () => {
  withDb((db) => {
    const receipt = soulRemainView(db, { section: 'self', content: '我是爱慕织姬。' })
    assert.match(receipt, /已写入「自己」/)
    const text = renderSoul(db)
    assert.match(text, /## 我是谁/)
    assert.match(text, /## 对方是谁/)
    assert.match(text, /## 我们之间/)
    assert.match(text, /（我的名字、身份、脾气，我在意和害怕的事。这块是底子，只有真的变了才动。）/)
    assert.match(text, /（他叫什么、做什么、喜欢什么、什么脾气，还有我怎么看他。只写他说过的、我确认过的。）/)
    assert.match(text, /（我们是什么关系、约好过什么、哪些事不能丢，写成以后的我读得懂的样子。）/)
    assert.match(text, /（还空着）/)
    assert.match(text, /写这一页的时候，记住几件事/)
    assert.match(text, /我是爱慕织姬/)
  })
})

test('soul memory: append appends after existing text, content replaces it', () => {
  withDb((db) => {
    soulRemainView(db, { section: 'relation', content: '第一段' })
    soulRemainView(db, { section: 'relation', append: '第二段' })
    assert.equal(readSoul(db).relation, '第一段\n第二段')
    soulRemainView(db, { section: 'relation', content: '替换' })
    assert.equal(readSoul(db).relation, '替换')
  })
})

test('soul memory: over-budget write is rejected and leaves the block unchanged', () => {
  withDb((db) => {
    const receipt = soulRemainView(db, { section: 'self', content: 'x'.repeat(4501) })
    assert.match(receipt, /还差 1 字/)
    assert.equal(readSoul(db).self, '')
    assert.equal(renderSoul(db), SOUL_EMPTY_COPY)
  })
})

test('soul memory: two independent handles see writes immediately and version increases', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-soul-fresh-'))
  const path = join(root, 'index.sqlite')
  const a = openDb(path)
  const b = openDb(path)
  try {
    assert.equal(soulVersion(a.db), 0)
    soulRemainView(a.db, { section: 'relation', content: '第一段' })
    assert.equal(soulVersion(a.db), 1)
    assert.match(renderSoul(b.db), /第一段/, '另一 handle 必须立刻看到新内容')

    soulRemainView(a.db, { section: 'relation', append: '第二段' })
    assert.equal(soulVersion(b.db), 2)
    assert.match(renderSoul(b.db), /第一段\n第二段/, 'append 之后立刻可见')

    const before = soulVersion(b.db)
    const rejected = soulRemainView(a.db, { section: 'relation', content: 'x'.repeat(19501) })
    assert.match(rejected, /还差 1 字/)
    assert.equal(soulVersion(b.db), before, '写入失败不增版本')
  } finally {
    a.close()
    b.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('soul memory: read failure returns the last successful text and journals', () => {
  const handle = openDb(':memory:')
  const db = handle.db
  const first = renderSoul(db)
  handle.close()
  const events = []
  const fallback = renderSoul(db, { journal: (kind, detail) => events.push([kind, detail]) })
  assert.equal(fallback, first)
  assert.equal(events[0][0], 'soul-section-read-failed')
  assert.equal(events[0][1].hasFallback, true)
})

test('soul memory: same content renders byte-identical across assemblies', () => {
  withDb((db) => {
    soulRemainView(db, { section: 'self', content: '稳定的内容。' })
    assert.equal(renderSoul(db), renderSoul(db))
  })
})

test('soul memory: invalid section is rejected without writing', () => {
  withDb((db) => {
    assert.match(soulRemainView(db, { section: 'bad', content: 'x' }), /section 需要 self、other 或 relation/)
    assert.equal(soulOverview(db).includes('自己：0 字'), true)
  })
})

test('soul memory: no content/append returns the occupancy overview', () => {
  withDb((db) => {
    const out = soulRemainView(db, {})
    assert.match(out, /自己：0 字 \/ 上限 4,500 字/)
    assert.match(out, /总计：0 字 \/ 上限 30,000 字/)
  })
})

test('24h nudge: fires once on an empty page, then stays quiet for the cooldown', () => {
  withDb((db) => {
    const t0 = 1_700_000_000_000
    const first = soulNudgeText(db, t0)
    assert.match(first, /这一页还空着/)
    assert.equal(soulNudgeText(db, t0 + 60_000), '')
    assert.equal(soulNudgeText(db, t0 + SOUL_NUDGE_COOLDOWN_MS - 1), '')
    const again = soulNudgeText(db, t0 + SOUL_NUDGE_COOLDOWN_MS)
    assert.match(again, /这一页还空着/)
  })
})

test('24h nudge: writing the page resets the cooldown', () => {
  withDb((db) => {
    const t0 = 1_700_000_000_000
    soulNudgeText(db, t0)
    assert.equal(soulNudgeText(db, t0 + 60_000), '')
    const writtenAt = t0 + 2 * 60 * 60 * 1000
    db.prepare("INSERT OR REPLACE INTO soul_memory(section, text, updated_at) VALUES('self', '我是爱慕织姬。', ?)").run(writtenAt)
    assert.equal(soulNudgeText(db, writtenAt + 60_000), '')
    const due = soulNudgeText(db, writtenAt + SOUL_NUDGE_COOLDOWN_MS)
    assert.match(due, /距离上次写这一页/)
    assert.equal(soulNudgeText(db, writtenAt + SOUL_NUDGE_COOLDOWN_MS + 1000), '')
  })
})

test('24h nudge: when soul_memory table cannot be read the section stays empty', () => {
  const broken = {
    prepare() { throw new Error('db gone') },
  }
  assert.equal(soulNudgeText(broken, 1_700_000_000_000), '')
})

test('system prompt sections are registered at order 200/210 and the page is stable between assemblies', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-soul-prompt-'))
  const sections = []
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('systemPrompt')) cb({ systemPrompt: { section: (section) => sections.push(section) } })
    },
    on() {},
  }
  const dispose = apply(ctx, { sessionsRoot: join(root, 'sessions'), dbPath: join(root, 'index.sqlite') })
  try {
    assert.equal(sections.length, 2)
    assert.equal(sections[0].name, 'soul-memory')
    assert.equal(sections[0].order, 200)
    assert.equal(sections[1].name, 'soul-nudge')
    assert.equal(sections[1].order, 210)
    const before = sections[0].text()
    assert.equal(before, SOUL_EMPTY_COPY)
    assert.equal(before.includes('我已经在这里'), false)

    const handle = openDb(join(root, 'index.sqlite'))
    try {
      soulRemainView(handle.db, { section: 'self', content: '我是爱慕织姬。' })
    } finally {
      handle.close()
    }
    const first = sections[0].text()
    const second = sections[0].text()
    assert.match(first, /我是爱慕织姬/)
    assert.equal(first, second, '同一内容两次组装必须完全一致')
  } finally {
    dispose()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})
