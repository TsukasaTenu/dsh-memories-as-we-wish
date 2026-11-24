// 终端级记忆范围测试：
// 1) 一个 DSH_HOME（终端）下，所有 workspace 的会话进同一个库，可互相检索；
// 2) 两个 DSH_HOME 是两个终端，各建各的库，互不可见；
// 3) memory_recall 的检索 SQL 不带 workspace/session 过滤。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { openDb } from '../lib/db.js'
import { buildAndIndexEpisodes, findSessionEntry, indexSessionFile, listSessionEntries } from '../lib/pipeline.js'
import { readView, searchView } from '../lib/memory-tools.js'
import { apply, resolveDbPath, resolveHome } from '../index.js'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)

function writeSession(root, workspace, sessionId, text, time = T0) {
  const dir = join(root, workspace, sessionId)
  mkdirSync(dir, { recursive: true })
  const events = [
    { seq: 1, time, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `训练员说：${text}` }] } },
    { seq: 2, time: time + 1000, type: 'assistant/message', data: { message: { source: { kind: 'assistant' }, content: [{ type: 'text', text: `我记住了：${text}` }] } } },
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n'))))
  return file
}

function indexAll(db, sessionsRoot) {
  for (const entry of listSessionEntries(sessionsRoot)) {
    indexSessionFile(db, { sessionId: entry.sessionId, filePath: entry.filePath })
    buildAndIndexEpisodes(db, entry.sessionId)
  }
}

test('dbPath 默认到 DSH_HOME/dsh-memories-as-we-wish/index.sqlite；没有 DSH_HOME 时退回 ~/.dsh', () => {
  assert.equal(resolveDbPath({}, { DSH_HOME: 'C:\\terminal-a' }), join('C:\\terminal-a', 'dsh-memories-as-we-wish', 'index.sqlite'))
  assert.equal(resolveDbPath({ dbPath: 'C:\\explicit.sqlite' }, { DSH_HOME: 'C:\\terminal-a' }), 'C:\\explicit.sqlite')
  assert.equal(resolveDbPath({}, {}), join(homedir(), '.dsh', 'dsh-memories-as-we-wish', 'index.sqlite'))
  assert.equal(resolveHome({}), join(homedir(), '.dsh'))
  assert.equal(resolveHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
  assert.equal(resolveHome({ DSH_HOME: 'C:\\terminal-a' }), 'C:\\terminal-a')
  assert.equal(resolveDbPath({ dbPath: ':memory:' }, {}), ':memory:')
})

test('同一终端：所有 workspace 进同一个库，跨 workspace 可检索', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-terminal-'))
  const db = openDb(join(root, 'index.sqlite'))
  try {
    writeSession(join(root, 'sessions'), '--C-Users-Admin-Desktop-T3--', 'session-a', '雪球在 T3 客厅里散步，T3only')
    writeSession(join(root, 'sessions'), '--C-Users-Admin-Desktop-DreamJourney--', 'session-b', '梦之旅在 B 房间读书，Bonly')
    const entries = listSessionEntries(join(root, 'sessions'))
    assert.deepEqual(entries.map(e => e.workspace).sort(), [
      '--C-Users-Admin-Desktop-DreamJourney--',
      '--C-Users-Admin-Desktop-T3--',
    ].sort())
    assert.equal(findSessionEntry(join(root, 'sessions'), 'session-a').workspace, '--C-Users-Admin-Desktop-T3--')

    indexAll(db, join(root, 'sessions'))

    // 不传 workspace：在 B 会话的视角下也能看到 A 的记忆
    const recallA = searchView(db, { query: 'T3only' })
    assert.match(recallA, /T3only/)
    assert.match(recallA, /雪球/)
    const recallB = searchView(db, { query: 'Bonly' })
    assert.match(recallB, /Bonly/)
    assert.match(recallB, /梦之旅/)

    // memory_remember 也能按全库 seq 读到 A 的原文
    const remembered = readView(db, { seq: String(db.rowSeq('session-a', 1)) })
    assert.match(remembered, /T3only/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件启动 3 秒后自动把整个终端所有 workspace 索引进库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-apply-'))
  const oldHome = process.env.DSH_HOME
  const oldDebug = process.env.DSH_V2_DEBUG_LOG
  process.env.DSH_HOME = root
  process.env.DSH_V2_DEBUG_LOG = join(root, 'debug.log')
  writeSession(join(root, 'sessions'), '--C-Users-Admin-Desktop-T3--', 'session-a', '终端 A 的 T3only')
  writeSession(join(root, 'sessions'), '--C-Users-Admin-Desktop-DreamJourney--', 'session-b', '终端 B 的 Bonly')
  const tools = []
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: { register(tool) { tools.push(tool) } } })
    },
    on() {},
  }
  const dispose = apply(ctx, { debugLog: process.env.DSH_V2_DEBUG_LOG })
  try {
    const dbPath = join(root, 'dsh-memories-as-we-wish', 'index.sqlite')
    let db = null
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250))
      if (!existsSync(dbPath)) continue
      try {
        db = openDb(dbPath)
        const n = db.db.prepare('SELECT COUNT(*) n FROM messages').get().n
        if (n >= 2) break
        db.close()
        db = null
      } catch { /* 等 timer */ }
    }
    assert.ok(db, `database not ready at ${dbPath}`)
    try {
      const sessions = db.db.prepare('SELECT DISTINCT session_id FROM messages ORDER BY session_id').all().map(r => r.session_id)
      assert.deepEqual(sessions, ['session-a', 'session-b'])
      const eps = db.db.prepare("SELECT COUNT(*) n FROM episodes_v2 WHERE status='active'").get().n
      assert.ok(eps >= 2, `expected episodes for both workspaces, got ${eps}`)
      assert.equal(tools.length, 3)
      assert.deepEqual(tools.map(t => t.name).sort(), ['memory_recall', 'memory_relink', 'memory_remember'])
    } finally {
      db.close()
    }
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldDebug === undefined) delete process.env.DSH_V2_DEBUG_LOG; else process.env.DSH_V2_DEBUG_LOG = oldDebug
    rmSync(root, { recursive: true, force: true })
  }
})

test('不同 DSH_HOME：两个终端的库互不可见', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'dsh-mem-term-a-'))
  const rootB = mkdtempSync(join(tmpdir(), 'dsh-mem-term-b-'))
  mkdirSync(join(rootA, 'dsh-memories-as-we-wish'), { recursive: true })
  mkdirSync(join(rootB, 'dsh-memories-as-we-wish'), { recursive: true })
  const dbA = openDb(join(rootA, 'dsh-memories-as-we-wish', 'index.sqlite'))
  const dbB = openDb(join(rootB, 'dsh-memories-as-we-wish', 'index.sqlite'))
  try {
    writeSession(join(rootA, 'sessions'), '--terminal-a--', 'session-a', 'T3only 只在终端 A')
    writeSession(join(rootB, 'sessions'), '--terminal-b--', 'session-b', 'Bonly 只在终端 B')
    indexAll(dbA, join(rootA, 'sessions'))
    indexAll(dbB, join(rootB, 'sessions'))

    assert.match(searchView(dbA, { query: 'T3only' }), /T3only/)
    assert.doesNotMatch(searchView(dbA, { query: 'Bonly' }), /Bonly/)
    assert.match(searchView(dbB, { query: 'Bonly' }), /Bonly/)
    assert.doesNotMatch(searchView(dbB, { query: 'T3only' }), /T3only/)
  } finally {
    dbA.close()
    dbB.close()
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})
