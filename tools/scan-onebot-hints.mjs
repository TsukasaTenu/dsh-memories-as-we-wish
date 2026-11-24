// 只读 dry-run：扫描真实 sessions，统计 onebot 消息里“整行括号包裹”的提示行
// 命中/未命中默认短语的情况。不写库、不改配置、不启动 DSH。
//
// 用法：node tools/scan-onebot-hints.mjs [--root <DSH_HOME>/sessions] [--out out.json]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { scanSessionFile, textOf, DEFAULT_ONEBOT_HINT_PATTERNS } from '../lib/parse.js'
import { listSessionEntries } from '../lib/pipeline.js'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const root = arg('--root', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions'))
const outPath = arg('--out', '')
const enclosed = (t) => (t.startsWith('（') || t.startsWith('(')) && (t.endsWith('）') || t.endsWith(')'))
const hitPhrase = (line) => DEFAULT_ONEBOT_HINT_PATTERNS.some(p => line.includes(p))

const entries = listSessionEntries(root)
const result = {
  root, sessions: entries.length, onebotMessages: 0,
  bracketLines: 0, hits: 0, misses: 0, samples: [],
}
for (const entry of entries) {
  let buf
  try { buf = readFileSync(entry.filePath) } catch { continue }
  scanSessionFile(buf, {
    onEvent: (e) => {
      if (e?.type !== 'user/message') return
      const kind = e.data?.source?.kind ?? e.data?.message?.source?.kind ?? ''
      if (kind !== 'onebot') return
      result.onebotMessages++
      const text = textOf(e.data?.content ?? e.data?.message?.content)
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!enclosed(t)) continue
        result.bracketLines++
        const hit = hitPhrase(t)
        if (hit) result.hits++
        else {
          result.misses++
          if (result.samples.length < 20) result.samples.push({ sessionId: entry.sessionId, seq: e.seq, line: t.slice(0, 300) })
        }
      }
    },
  })
}
const json = JSON.stringify(result, null, 2)
if (outPath) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outPath, json)
}
console.log(json)
