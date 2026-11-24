import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { apply } from '../index.js'
import { openDb } from '../lib/db.js'

const OLD = Date.UTC(2026, 10, 24, 0, 0, 0)
const AGENT = { session: { header: { id: 'session-idle' } } }

function writeSession(root) {
  const dir = join(root, 'sessions', '--ws--', 'session-idle')
  mkdirSync(dir, { recursive: true })
  const events = [
    { seq: 10, time: OLD, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '很久以前的旧消息' }] } },
    { seq: 11, time: OLD + 1000, type: 'assistant/message', data: { message: { source: { kind: 'assistant' }, content: [{ type: 'text', text: '很久以前的旧回复' }] } } },
  ]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n'))))
  return dir
}

test('turn-stopping 且上一轮超过 24h：不再触发 idle24h 聚合', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-no-idle-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  writeSession(root)
  const handlers = new Map()
  const tools = []
  const llm = { stream: () => (async function* () { yield { type: 'text-delta', text: '{"episodes":[]}' } })() }
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: { register(t) { tools.push(t) } } })
      if (deps.includes('llm')) cb({ llm })
    },
    on(event, cb) { handlers.set(event, cb) },
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log') })
  const dbPath = join(root, 'dsh-memories-as-we-wish', 'index.sqlite')
  try {
    const seed = openDb(dbPath)
    seed.insert({ seq: 100, sessionId: 'session-idle', role: 'user', time: Date.now() - 25 * 3600 * 1000, text: '昨天说的话', kind: 'user', status: 'active' })
    seed.close()

    const handler = handlers.get('agent/turn-stopping')
    assert.ok(handler)
    await handler({ agent: AGENT, turn: 1 })
    await new Promise(r => setTimeout(r, 400))

    const check = openDb(dbPath)
    try {
      const rows = check.db.prepare("SELECT kind, detail FROM journal").all()
      assert.equal(rows.some(r => r.kind === 'aggregate-trigger' && JSON.parse(r.detail).turn === 'idle24h'), false)
    } finally { check.close() }
    assert.equal(tools.length, 3)
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
