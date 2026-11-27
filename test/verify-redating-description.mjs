import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = readFileSync(`${here}../index.js`, 'utf8')
const EXPECTED = '我的记忆标尺。当我想知道过去都发生过什么、哪些日子值得翻回去看的时候，用它。它会告诉我我们在哪些日子留下过记忆：最近的日子一天一段，下面还列着那天几个片段；更早的按月折成几句。它不是回忆本身，是地图——先看有哪些日子，再用 memory_recall 去那些日子里找。'

test('memory_redating description 与训练员定稿完全相等', () => {
  const match = source.match(/name: 'memory_redating',\s*description:\s*'((?:\\.|[^'\\])*)'/)
  assert.ok(match, '找不到 memory_redating.description')
  const actual = JSON.parse(`"${match[1]}"`)
  assert.equal(actual, EXPECTED)
  assert.equal([...actual].length, [...EXPECTED].length)
})
