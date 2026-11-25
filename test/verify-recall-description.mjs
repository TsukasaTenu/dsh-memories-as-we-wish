// 校验 memory_recall 工具描述与训练员给定原文完全一致（逐字，含换行）。
// 基准文件由训练员原样落盘：C:\Users\Admin\Desktop\T3\_recall-description-v2.txt
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const EXPECTED = readFileSync(join(here, '..', '..', '_recall-description-v2.txt'), 'utf8')
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
const block = source.match(/name: 'memory_recall',[\s\S]*?description: ("(?:\\.|[^"\\])*")/)
const actual = block ? JSON.parse(block[1]) : undefined
const equal = actual === EXPECTED

console.log(JSON.stringify({
  equal,
  actualLength: [...String(actual ?? '')].length,
  expectedLength: [...EXPECTED].length,
  match: block ? 'found' : 'not-found',
}, null, 2))

test('memory_recall description 与原文文件完全相等（逐字，含换行）', () => {
  assert.equal(actual, EXPECTED)
})
