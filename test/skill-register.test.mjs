import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseSkillMarkdown, readRememberingSkill, registerRememberingSkill } from '../index.js'

const SKILL_PATH = fileURLToPath(new URL('../skills/use-my-memory-abilities/SKILL.md', import.meta.url))

test('解析 use-my-memory-abilities 的 frontmatter，body 不含 frontmatter', () => {
  const raw = readFileSync(SKILL_PATH, 'utf8')
  const def = parseSkillMarkdown(raw)
  assert.equal(def.name, 'use-my-memory-abilities')
  assert.ok(def.description.includes('回想'))
  assert.ok(def.content.startsWith('# 回想'))
  assert.equal(def.content.includes('name: use-my-memory-abilities'), false)
  assert.equal(def.content.includes('description:'), false)
})

test('readRememberingSkill 读取包内文件并保留正文', () => {
  const def = readRememberingSkill()
  assert.equal(def.name, 'use-my-memory-abilities')
  assert.ok(def.path.endsWith('skills\\use-my-memory-abilities\\SKILL.md') || def.path.endsWith('skills/use-my-memory-abilities/SKILL.md'))
  assert.ok(def.content.includes('回忆不是查资料'))
})

test('registerRememberingSkill 用 ctx.skills.register 注册，不写磁盘', () => {
  const registered = []
  const journals = []
  const handle = { journal: (kind, detail) => journals.push([kind, detail]) }
  const ctx = {
    inject(deps, cb) {
      assert.deepEqual(deps, ['skills'])
      cb({ skills: { register: (skill) => { registered.push(skill); return () => {} } } })
    },
  }
  const def = registerRememberingSkill(ctx, handle)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'use-my-memory-abilities')
  assert.equal(registered[0].source, 'plugin:dsh-memories-as-we-wish')
  assert.equal(registered[0].content, def.content)
  assert.equal(journals.some(([kind, detail]) => kind === 'skill-registered' && detail.name === 'use-my-memory-abilities'), true)
})

test('skills.register 不可用时写失败 journal，不抛异常', () => {
  const journals = []
  const handle = { journal: (kind, detail) => journals.push([kind, detail]) }
  const ctx = { inject: (_deps, cb) => cb({ skills: {} }) }
  assert.doesNotThrow(() => registerRememberingSkill(ctx, handle))
  assert.equal(journals.some(([kind, detail]) => kind === 'skill-register-failed' && detail.name === 'use-my-memory-abilities'), true)
})
