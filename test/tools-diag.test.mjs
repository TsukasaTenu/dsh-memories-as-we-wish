import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { openDb } from '../lib/db.js'

test('工具诊断 journal：注册前后、tools/change、pre-step、tools-call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-diag-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const registered = []
  const handlers = {}
  const tools = {
    get(name) { return registered.find(t => t.name === name) },
    register(tool) { registered.push(tool) },
    on() {},
  }
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools, on: tools.on.bind(tools) })
    },
    on(event, fn) { handlers[event] = fn },
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log'), debugTools: true })
  try {
    assert.equal(registered.length, 6, '六个工具都应注册')
    await registered[0].execute({ query: '一个不存在的诊断查询' })
    const preStep = handlers['agent/pre-step']
    assert.equal(typeof preStep, 'function', '应有 pre-step 处理器')
    await preStep(
      { agent: { session: { header: { id: 'diag-session' } } }, messages: [] },
      async () => ({ kind: 'enter', messages: [] }),
    )

    const db = openDb(join(root, 'dsh-memories-as-we-wish', 'index.sqlite'))
    try {
      const rows = db.db.prepare("SELECT kind, detail FROM journal WHERE kind IN ('tools-diag','tools-call','tools-register-failed') ORDER BY rowid").all()
      const diag = rows.filter(r => r.kind === 'tools-diag').map(r => JSON.parse(r.detail))
      const before = diag.find(x => x.phase === 'before')
      const after = diag.find(x => x.phase === 'after')
      assert.ok(before, '缺 tools-diag before')
      assert.equal(before.debugLog, true)
      assert.equal(before.hasGet, 'function')
      assert.equal(before.scopeHasRegister, 'function')
      assert.deepEqual(before.pre, { memory_recall: false, memory_remember: false, memory_relink: false, memory_repose: false, memory_redating: false, memory_remain: false })
      assert.ok(after, '缺 tools-diag after')
      assert.deepEqual(after.post, { memory_recall: true, memory_remember: true, memory_relink: true, memory_repose: true, memory_redating: true, memory_remain: true })

      const calls = rows.filter(r => r.kind === 'tools-call').map(r => JSON.parse(r.detail))
      assert.equal(calls.length, 1)
      assert.equal(calls[0].name, 'memory_recall')
      assert.equal(calls[0].ok, true)
      assert.equal(typeof calls[0].ms, 'number')
      assert.equal(typeof calls[0].argsSize, 'number')
      assert.ok(!rows.some(r => r.kind === 'tools-register-failed'))
    } finally { db.close() }
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('debugTools 默认关闭：不写任何工具探针 journal，但注册/自愈仍生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-debug-off-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const registered = []
  const handlers = {}
  const tools = {
    get(name) { return registered.find(t => t.name === name) },
    register(tool) { registered.push(tool) },
    on() {},
  }
  const ctx = {
    inject(deps, cb) { if (deps.includes('tools')) cb({ tools, on: tools.on.bind(tools) }) },
    on(event, fn) { handlers[event] = fn },
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log') })
  try {
    assert.equal(registered.length, 6, '注册行为保留')
    await registered[0].execute({ query: '一个不存在的诊断查询' })
    const preStep = handlers['agent/pre-step']
    const agent = { session: { header: { id: 'debug-off' } }, ctx: { tools } }
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    const db = openDb(join(root, 'dsh-memories-as-we-wish', 'index.sqlite'))
    try {
      const rows = db.db.prepare("SELECT kind FROM journal WHERE kind IN ('tools-diag','tools-schemas','tools-agent-register','tools-call','tools-selfheal','tools-register-failed')").all()
      assert.deepEqual(rows, [], `默认不应写探针：${JSON.stringify(rows)}`)
    } finally { db.close() }
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
