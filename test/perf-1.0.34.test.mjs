import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../lib/db.js'
import { indexSessionFile } from '../lib/pipeline.js'

const user = (seq, text) => ({ type: 'user/message', seq, time: seq, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const frame = events => zlib.zstdCompressSync(Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n'))

const makeFile = (dir, events, frames = 2) => {
  const per = Math.ceil(events.length / frames)
  const parts = []
  for (let i = 0; i < events.length; i += per) parts.push(frame(events.slice(i, i + per)))
  const file = join(dir, 's.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(parts))
  return { file, parts }
}

test('增量读取字节数 < 全文件 20%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inc-'))
  try {
    const db = openDb(join(dir, 'index.sqlite'))
    const big = Array.from({ length: 500 }, (_, i) => user(i + 1, `old-${i}-${'x'.repeat(120)}`))
    const { file, parts } = makeFile(dir, [...big, user(501, 'new'), user(502, 'new2')], 20)
    const offset = parts.slice(0, -1).reduce((n, p) => n + p.length, 0)
    const r = indexSessionFile(db, { sessionId: 's', filePath: file, offset })
    assert.equal(r.fallback, false)
    assert.ok(r.scannedBytes < r.totalBytes * 0.2, `${r.scannedBytes}/${r.totalBytes}`)
    db.close()
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})

test('文件变短/偏移越界回退全量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trunc-'))
  try {
    const db = openDb(join(dir, 'index.sqlite'))
    const { file } = makeFile(dir, [user(1, 'a'), user(2, 'b')], 1)
    const r = indexSessionFile(db, { sessionId: 's', filePath: file, offset: 999999 })
    assert.equal(r.fallback, true)
    db.close()
  } finally { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
})

test('settle 是 fire-and-forget，并有 settling 守卫', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /void settleNow\(/)
  assert.match(src, /const settling = new Set\(\)/)
  assert.match(src, /settle-abandoned/)
  assert.doesNotMatch(src, /await settleNow\(/)
})
