import test from 'node:test'
import assert from 'node:assert/strict'
import { extractTurnReasoning, renderTurnTrace, formatReasoning, RELINK_MAX_CHARS } from '../lib/relink.js'

const turnStart = (seq, turn) => ({ type: 'turn/start', seq, data: { turn } })
const user = (seq, text = '问') => ({ type: 'user/message', seq, data: { content: [{ type: 'text', text }] } })
const assistant = (seq, blocks) => ({ type: 'assistant/message', seq, data: { message: { content: blocks } } })
const thinking = (seq, text) => assistant(seq, [{ type: 'reasoning', text }])
const tool = (name, args = {}) => ({ type: 'tool-call', name, arguments: JSON.stringify(args) })

test('有 reasoning 的轮：只取本 turn，按 seq 拼接，不跨轮', () => {
  const events = [
    turnStart(1, 1),
    user(2),
    thinking(3, '想法一'),
    assistant(4, [{ type: 'text', text: '回答' }]),
    thinking(5, '想法二'),
    turnStart(6, 2),
    thinking(7, '下一轮的想法'),
  ]
  const r = extractTurnReasoning(events, 2)
  assert.equal(r.status, 'ok')
  assert.equal(r.turn, 1)
  assert.equal(r.text, '想法一\n想法二')
})

test('无 reasoning 的轮：返回 empty', () => {
  const events = [turnStart(1, 1), user(2), assistant(3, [{ type: 'text', text: '回答' }])]
  assert.equal(extractTurnReasoning(events, 2).status, 'empty')
})

test('seq 不存在：返回 not-found', () => {
  assert.equal(extractTurnReasoning([turnStart(1, 1)], 99).status, 'not-found')
})

test('超长截断：保留前 15000 字并注明原文总长', () => {
  const long = '思'.repeat(16_000)
  assert.equal(formatReasoning(long).includes(`（原文 16000 字，已显示前 ${RELINK_MAX_CHARS} 字）`), true)
})

test('说话步自带思考：挂到本步，正文只给步骤头', () => {
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [
      { type: 'reasoning', text: '说话前的决定' },
      { type: 'text', text: '好了，清完了' },
    ]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.equal(r.status, 'ok')
  assert.equal(r.steps, 1)
  assert.equal(r.speaking, 1)
  assert.equal(r.attached, 1)
  assert.match(r.text, /\[第 1 步 · 说话\] 好了，清完了/)
  assert.match(r.text, /  └ 思考（来自第 1 步）：\n     说话前的决定/)
  assert.equal(r.text.includes('好了，清完了\n\n'), false)
})

test('思考隔了几步工具之后，仍挂给第一次出现的说话', () => {
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [
      { type: 'reasoning', text: '先查清楚，再回复' },
      tool('read', { path: '/a' }),
    ]),
    assistant(4, [tool('grep', { pattern: 'x' })]),
    assistant(5, [{ type: 'text', text: '查完了，结果是 A' }]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.equal(r.attached, 1)
  assert.match(r.text, /\[第 1 步 · 工具\] read/)
  assert.match(r.text, /\[第 2 步 · 工具\] grep/)
  assert.match(r.text, /\[第 3 步 · 说话\] 查完了，结果是 A/)
  assert.match(r.text, /  └ 思考（来自第 1 步）：\n     先查清楚，再回复/)
  assert.equal(r.text.includes('工具步骤'), false)
})

test('一段思考只挂一次；后面的说话没有新思考就写没有留下思考', () => {
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [{ type: 'reasoning', text: '只有这一段' }, tool('read', {})]),
    assistant(4, [{ type: 'text', text: '第一句' }]),
    assistant(5, [{ type: 'text', text: '第二句' }]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.equal(r.speaking, 2)
  assert.equal(r.attached, 1)
  assert.match(r.text, /\[第 2 步 · 说话\] 第一句\n  └ 思考（来自第 1 步）：\n     只有这一段/)
  assert.match(r.text, /\[第 3 步 · 说话\] 第二句\n  └ （这一步没有留下思考）/)
})

test('说话前面没有任何未用过的思考：明确写出来', () => {
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [{ type: 'text', text: '直接回答' }]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.equal(r.attached, 0)
  assert.equal(r.text, '这一轮共 1 步（0 次工具调用，1 次说话）\n\n[第 1 步 · 说话] 直接回答\n  └ （这一步没有留下思考）')
})

test('说话步自己的长思考按 15000 字截断并注明原文', () => {
  const long = '思'.repeat(16_000)
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [{ type: 'reasoning', text: long }, { type: 'text', text: '回答' }]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.equal(r.attached, 1)
  assert.equal(r.text.includes('思'.repeat(RELINK_MAX_CHARS)), true)
  assert.equal(r.text.includes('思'.repeat(RELINK_MAX_CHARS + 1)), false)
  assert.equal(r.text.includes(`（原文 16000 字，已显示前 ${RELINK_MAX_CHARS} 字）`), true)
})

test('工具参数超过 120 字截断；说话 text 只保留前 40 字', () => {
  const longArg = `x${'a'.repeat(200)}`
  const longText = '说'.repeat(60)
  const events = [
    turnStart(1, 1),
    user(2),
    assistant(3, [{ type: 'tool-call', name: 'read', arguments: longArg }]),
    assistant(4, [{ type: 'text', text: longText }]),
  ]
  const r = renderTurnTrace(events, 2)
  assert.match(r.text, /\[第 1 步 · 工具\] read x/)
  assert.equal(r.text.includes(longArg), false)
  assert.match(r.text, /\[第 2 步 · 说话\] 说{40}…/)
  assert.equal(r.text.includes(longText), false)
})
