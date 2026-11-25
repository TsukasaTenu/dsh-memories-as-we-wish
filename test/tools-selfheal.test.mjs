import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { openDb } from '../lib/db.js'

test('工具注册：agent scope 无条件注册、重复容忍、resume/pre-step/change 都生效', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-selfheal-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const globalRegistered = []
  const scopedRegistered = []
  const handlers = new Map()
  const on = (event, fn) => {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(fn)
  }
  const scopedRegister = (tool) => {
    if (scopedRegistered.some(t => t.name === tool.name)) throw new Error(`already registered in this scope: ${tool.name}`)
    scopedRegistered.push(tool)
  }
  const globalTools = {
    get(name) { return globalRegistered.find(t => t.name === name) },
    register(tool) { globalRegistered.push(tool) },
    on,
  }
  const scopedTools = {
    get(name, agent) { return scopedRegistered.find(t => t.name === name) },
    register: scopedRegister,
    on,
  }
  const ctx = {
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: globalTools, on })
    },
    on,
  }
  const agent = {
    session: { header: { id: 'qfish-like' } },
    ctx: { tools: scopedTools },
  }
  const dispose = apply(ctx, { debugLog: join(root, 'debug.log'), debugTools: true })
  const rows = (kind) => {
    const db = openDb(join(root, 'dsh-memories-as-we-wish', 'index.sqlite'))
    try { return db.db.prepare('SELECT kind, detail FROM journal WHERE kind = ? ORDER BY rowid').all(kind).map(r => JSON.parse(r.detail)) } finally { db.close() }
  }
  const preStep = handlers.get('agent/pre-step')?.[0]
  const created = handlers.get('agent/created')?.[0]
  try {
    assert.equal(globalRegistered.length, 3, '全局初始注册三个')
    assert.equal(scopedRegistered.length, 0, 'agent 尚未创建')
    assert.equal(typeof preStep, 'function')
    assert.equal(typeof created, 'function')

    created({ agent, source: 'startup' })
    assert.deepEqual(scopedRegistered.map(t => t.name).sort(), ['memory_recall', 'memory_relink', 'memory_remember'])
    let regs = rows('tools-agent-register')
    assert.equal(regs.filter(x => x.ok && !x.already).length, 3)
    assert.ok(regs.every(x => x.sessionId === 'qfish-like' && x.reason === 'agent-created:startup'))

    // 第二次注册：同名重复应被当作成功，不重复插入
    created({ agent, source: 'resume' })
    assert.equal(scopedRegistered.length, 3)
    regs = rows('tools-agent-register')
    assert.equal(regs.filter(x => x.ok && x.already).length, 3)
    assert.equal(regs.at(-1).reason, 'agent-created:resume')

    // 模拟 scope 被清空，pre-step 应恢复
    scopedRegistered.length = 0
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(scopedRegistered.length, 3, 'pre-step 应恢复 agent scope 工具')
    assert.ok(rows('tools-agent-register').some(x => x.reason === 'pre-step' && x.ok && !x.already))

    // 模拟全局工具被移除
    const globalHealsBefore = rows('tools-selfheal').filter(x => x.scope === 'global').length
    globalRegistered.length = 0
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(globalRegistered.length, 3, 'pre-step 应恢复全局工具')
    assert.equal(rows('tools-selfheal').filter(x => x.scope === 'global').length, globalHealsBefore + 3)

    // tools/change：两层都移除后应恢复
    scopedRegistered.length = 0
    globalRegistered.length = 0
    const change = handlers.get('tools/change')?.[0]
    assert.equal(typeof change, 'function')
    change()
    assert.equal(globalRegistered.length, 3)
    assert.equal(scopedRegistered.length, 3)

    // 幂等：工具都在时只记录 already=true，不产生工具自愈错误
    const selfhealBefore = rows('tools-selfheal').length
    await preStep({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    const j = rows('tools-selfheal')
    assert.equal(j.length, selfhealBefore, '工具齐全时不应有新 tools-selfheal')
    assert.ok(j.every(x => x.error === undefined))
    const regs2 = rows('tools-agent-register')
    const counts = regs2.filter(x => x.sessionId === 'qfish-like').map(x => x.count)
    assert.ok(Math.max(...counts) >= 12, '每个会话的注册次数应累计')
  } finally {
    dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    rmSync(root, { recursive: true, force: true })
  }
})
