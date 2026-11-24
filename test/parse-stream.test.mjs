import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  scanSessionFile, decodeSessionFile, extractMessageFromEvent, extractMessages,
  isOnebotHintLine, readSessionOrigin,
} from '../lib/parse.js'

const makeBuf = (events, frames = 1) => {
  const per = Math.ceil(events.length / frames)
  const parts = []
  for (let i = 0; i < events.length; i += per) {
    const text = events.slice(i, i + per).map(e => JSON.stringify(e)).join('\n') + '\n'
    parts.push(zlib.zstdCompressSync(Buffer.from(text)))
  }
  return Buffer.concat(parts)
}
const user = (seq, text, kind = 'user') => ({
  type: 'user/message', seq, time: 1, data: { content: [{ type: 'text', text }], source: { kind } },
})

test('scanSessionFile 逐事件回调，不返回 events 数组', () => {
  const buf = makeBuf([user(1, 'hello'), { type: 'turn/start', seq: 2, data: { turn: 1 } }], 2)
  const seen = []
  const ret = scanSessionFile(buf, { onEvent: e => seen.push(e.type) })
  assert.deepEqual(seen, ['user/message', 'turn/start'])
  assert.equal(ret.events, undefined)
})

test('decodeSessionFile 仍供 memory_relink 回看整轮', () => {
  const buf = makeBuf([user(1, 'a'), user(2, 'b')])
  const { events } = decodeSessionFile(buf)
  assert.equal(events.length, 2)
})

test('onebot 提示行必须整行括号包裹且命中可配置短语', () => {
  assert.equal(isOnebotHintLine('（你只是唤醒，不用回复）'), true)
  assert.equal(isOnebotHintLine('（这条可以多说几句）'), true)
  assert.equal(isOnebotHintLine('（普通备注，不是提示）'), false)
  assert.equal(isOnebotHintLine('前缀（只是唤醒）后缀'), false)
  assert.equal(isOnebotHintLine('（自定义提示）', ['自定义提示']), true)
  const ev = user(7, '正文\n（只是唤醒，不用回复）', 'onebot')
  const m = extractMessageFromEvent(ev)
  assert.equal(m.text, '正文')
  const disabled = extractMessageFromEvent(ev, { onebotHintPatterns: [] })
  assert.equal(disabled.text.includes('只是唤醒'), true)
})

test('extractMessages 使用传入的 onebotHintPatterns', () => {
  const ev = user(8, '正文\n（自定义提示）', 'onebot')
  const m = extractMessages([ev], { onebotHintPatterns: ['自定义提示'] })[0]
  assert.equal(m.text, '正文')
})

test('readSessionOrigin 只读首个 session 事件即可判子代理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-origin-'))
  try {
    const p = join(dir, 's.zst')
    const session = { type: 'session', version: 4, id: 's1', origin: 'subagent', delegationDepth: 1, parentSession: 'root1' }
    writeFileSync(p, zlib.zstdCompressSync(Buffer.from(JSON.stringify(session) + '\n')))
    const r = readSessionOrigin(p)
    assert.equal(r.isSubagent, true)
    assert.equal(r.parentSession, 'root1')
    assert.equal(r.delegationDepth, 1)
    const root = { type: 'session', version: 4, id: 'root', delegationDepth: 0 }
    writeFileSync(p, zlib.zstdCompressSync(Buffer.from(JSON.stringify(root) + '\n')))
    assert.equal(readSessionOrigin(p).isSubagent, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('20MB+ 合成会话流式扫描后 heap 仍 < 200MB', () => {
  const events = []
  for (let i = 0; i < 3000; i++) events.push(user(i + 1, `${i}:${randomBytes(9000).toString('base64')}`))
  const buf = makeBuf(events, 40)
  assert.ok(buf.length > 20 * 1024 * 1024, `buffer ${buf.length}`)
  let n = 0
  let peakHeap = process.memoryUsage().heapUsed
  const ret = scanSessionFile(buf, { onEvent: (e) => {
    if (e.type === 'user/message') n++
    const h = process.memoryUsage().heapUsed
    if (h > peakHeap) peakHeap = h
  } })
  assert.equal(n, events.length)
  assert.equal(ret.events, undefined)
  assert.ok(peakHeap < 200 * 1024 * 1024, `peakHeap=${Math.round(peakHeap / 1048576)}MB`)
})
