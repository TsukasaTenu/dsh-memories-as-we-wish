import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { openDb } from '../lib/db.js'

const names = list => list.map(n => ({ name: n }))

test('tools-schemas：全局有、agent 被 restrict 掉时如实记录两路 schema', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-schemas-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const handlers = new Map()
  const on = (event, fn) => {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
  }
  const globalRegistered = []
  const scopedRegistered = []
  const agentNames = ['working_directory', 'onebot_memory']
  const globalNames = ['working_directory', 'memory_recall', 'memory_remember', 'memory_relink', 'memory_repose', 'onebot_memory']
  const globalTools = {
    get(name) { return globalRegistered.find(t => t.name === name) },
    register(tool) { globalRegistered.push(tool) },
    schemas(scope) {
      return scope === undefined ? names(globalNames) : names(agentNames)
    },
    modeFor() { return 'native' },
    on,
  }
  const scopedTools = {
    get(name) { return scopedRegistered.find(t => t.name === name) },
    register(tool) { scopedRegistered.push(tool) },
  }
  const ctx = {
    inject(deps, cb) { if (deps.includes('tools')) cb({ tools: globalTools, on }) },
    on,
  }
  const agent = {
    id: 'agent-schemas',
    session: { header: { id: 'session-schemas' } },
    ctx: { tools: scopedTools },
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log'), debugTools: true })
  const journal = () => {
    const db = openDb(join(root, 'dsh-memories-as-we-wish', 'index.sqlite'))
    try { return db.db.prepare("SELECT detail FROM journal WHERE kind = 'tools-schemas' ORDER BY rowid").all().map(r => JSON.parse(r.detail)) } finally { db.close() }
  }
  const preStep = handlers.get('agent/pre-step')?.[0]
  try {
    assert.equal(typeof preStep, 'function')
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    let rows = journal()
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.equal(row.sessionId, 'session-schemas')
    assert.equal(row.agentId, 'agent-schemas')
    assert.equal(row.scopeKind, 'agent')
    assert.equal(row.agentCount, 2)
    assert.equal(row.globalCount, 6)
    assert.deepEqual(row.agentHasMem, [])
    assert.deepEqual(row.globalHasMem, ['memory_recall', 'memory_remember', 'memory_relink', 'memory_repose'])
    assert.deepEqual(row.shortNames, agentNames)
    assert.equal(row.presentation, 'native')

    // 同一状态不重复记录
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(journal().length, 1)

    // agent schema 变化时必须再记一条
    agentNames.push('memory_recall')
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    rows = journal()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[1].agentHasMem, ['memory_recall'])
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
