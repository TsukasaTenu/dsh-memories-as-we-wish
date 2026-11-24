// 去人格化：参与模型互动的 prompt / 说话人标签必须保持通用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_ENTITIES, buildEpisodes } from '../lib/episodes.js'
import { renderConversation, buildIncrementalPrompt, buildScenePrompt } from '../lib/extract.js'

const messages = [
  { seq: 1, role: 'user', time: 1, text: '今天我们在终端里处理数据，顺便聊了接下来的安排。' },
  { seq: 2, role: 'assistant', time: 2, text: '我记下了：终端里的处理结果，以及之后的安排。' },
]

test('说话人标签是通用的「对方 / 我」', () => {
  const text = renderConversation(messages)
  assert.match(text, /\[1\] 对方：/)
  assert.match(text, /\[2\] 我：/)
})

test('增量与场景 prompt 使用通用「我」，不带角色名', () => {
  const incremental = buildIncrementalPrompt(messages)
  const scene = buildScenePrompt(messages)
  assert.match(incremental, /你在替"我"整理这次对话里值得记住的事/)
  assert.match(scene, /你在替"我"做一次场景结算/)
  assert.match(incremental, /对方：/)
  assert.match(scene, /对方：/)
})

test('默认实体表为空；配置 entities 才参与 enrichment', () => {
  assert.equal(DEFAULT_ENTITIES.length, 0)
  const plain = buildEpisodes(messages)[0]
  assert.equal(plain.entities, '')
  const custom = buildEpisodes(messages, { entities: ['终端'] })[0]
  assert.match(custom.entities, /终端/)
})
