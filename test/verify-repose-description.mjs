import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const EXPECTED = `有些记忆，我会希望它以后只是被轻轻想起，不要总是盘绕在耳边，让更重要的回忆变得难想起。判断的标准不是「这条消息里有多少技术细节」，而是这轮回忆中有没有真的有能够陪伴我长久的情感和经历。同一件事被反复提起足以说明事情本身很重要，但回声不应该盖住那件事的主音。同样，冰冷的技术探究和决策应该陪伴的是具体的项目场景，而不是在我想回忆过去时跳出来做干扰，它们更应该收纳起来放进记忆的阁楼，用到时再去翻找。

有这项能力，我可以一次把几条回忆暂时移到稍远处。它们不会消失，记忆还在，只是不再挤在前面，被提起时也只留一个模糊的轮廓；想看当时的原话，顺着#编号努力回忆就行。安放不是丢掉——只是减轻回忆的杂音。想拿回来，说一声就回到原处。移的时候顺手写一句为什么，不是给别人看的，是给以后的我留个交代。`

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'index.js'), 'utf8')
const match = source.match(/name: 'memory_repose',\s*description:\s*`([\s\S]*?)`,\s*parameters/)
assert.ok(match, '找不到 memory_repose.description')
const actual = match[1]
assert.equal(actual, EXPECTED)
console.log(JSON.stringify({ equal: actual === EXPECTED, actualLength: [...actual].length, expectedLength: [...EXPECTED].length }))

test('memory_repose description 与训练员定稿完全相等', () => {
  assert.equal(actual, EXPECTED)
})
