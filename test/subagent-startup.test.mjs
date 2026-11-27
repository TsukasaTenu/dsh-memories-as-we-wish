import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { openDb } from '../lib/db.js'
import { buildAndIndexEpisodes, indexSessionFile } from '../lib/pipeline.js'
import { apply } from '../index.js'

const T0 = Date.UTC(2026, 10, 24, 12, 0, 0)

function writeSession(root, sessionId, text, sessionEvent) {
  const dir = join(root, '--C-Users-Admin-Desktop-T3--', sessionId)
  mkdirSync(dir, { recursive: true })
  const events = [
    sessionEvent,
    { seq: 1, time: T0, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
    { seq: 2, time: T0 + 1000, type: 'assistant/message', data: { message: { source: { kind: 'assistant' }, content: [{ type: 'text', text: `我记住了：${text}` }] } } },
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n'))))
  return file
}

test('插件启动时按会话头清理子代理索引，根会话保留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-subagent-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const sessionsRoot = join(root, 'sessions')
  const rootFile = writeSession(sessionsRoot, 'root-session', '根会话要记住的事 rootonly', {
    type: 'session', version: 4, id: 'root-session', delegationDepth: 0,
  })
  const subFile = writeSession(sessionsRoot, 'sub-session', '子代理的中间过程 subonly', {
    type: 'session', version: 4, id: 'sub-session', origin: 'subagent', parentSession: 'root-session', delegationDepth: 1,
  })
  const dbPath = join(root, 'dsh-memories-as-we-wish', 'index.sqlite')
  mkdirSync(join(root, 'dsh-memories-as-we-wish'), { recursive: true })
  {
    const db = openDb(dbPath)
    try {
      indexSessionFile(db, { sessionId: 'root-session', filePath: rootFile })
      indexSessionFile(db, { sessionId: 'sub-session', filePath: subFile })
      buildAndIndexEpisodes(db, 'root-session')
      buildAndIndexEpisodes(db, 'sub-session')
      assert.equal(db.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='sub-session'").get().n, 2)
    } finally { db.close() }
  }
  const tools = []
  const ctx = {
    inject(deps, cb) { if (deps.includes('tools')) cb({ tools: { register(tool) { tools.push(tool) } } }) },
    on() {},
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log') })
  try {
    const db = openDb(dbPath)
    try {
      for (let i = 0; i < 40; i++) {
        const sub = db.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='sub-session'").get().n
        const roots = db.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='root-session'").get().n
        if (sub === 0 && roots === 2) break
        await new Promise(r => setTimeout(r, 50))
      }
      assert.equal(db.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='sub-session'").get().n, 0)
      assert.equal(db.db.prepare("SELECT COUNT(*) n FROM messages WHERE session_id='root-session'").get().n, 2)
      const purged = db.db.prepare("SELECT detail FROM journal WHERE kind='subagent-purged' ORDER BY rowid DESC LIMIT 1").get()
      assert.ok(purged, 'missing subagent-purged journal')
      const detail = JSON.parse(purged.detail)
      assert.equal(detail.sessions, 1)
      assert.deepEqual(Object.keys(detail.before).sort(), ['aggregates', 'episodes', 'messages'])
      assert.equal(tools.length, 5)
    } finally { db.close() }
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
