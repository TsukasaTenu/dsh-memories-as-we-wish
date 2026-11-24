// memory_relink：只读会话原文，取某一轮 assistant 的 reasoning 块。
// reasoning 不进 messages / FTS / DB；按 sid 做短期解压缓存，最多 2 个会话。
import { readFileSync, statSync } from 'node:fs'
import { decodeSessionFile } from './parse.js'

const CACHE_LIMIT = 2
const CACHE = new Map()
export const RELINK_MAX_CHARS = 15_000

/** 测试/排查用：清空缓存。 */
export function clearRelinkCache() {
  CACHE.clear()
}

/**
 * 解压并缓存一个会话文件。缓存按 sessionId 命中；文件 mtime/size 变了就重解。
 * @returns {{events:any[]}|null}
 */
export function loadSessionEvents(filePath, sessionId) {
  if (!filePath || !sessionId) return null
  let st
  try { st = statSync(filePath) } catch { return null }
  const hit = CACHE.get(sessionId)
  if (hit && hit.filePath === filePath && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // LRU：命中后移到队尾
    CACHE.delete(sessionId)
    CACHE.set(sessionId, hit)
    return hit
  }
  let events
  try {
    const buf = readFileSync(filePath)
    events = decodeSessionFile(buf).events
  } catch {
    return null
  }
  const entry = { filePath, mtimeMs: st.mtimeMs, size: st.size, events }
  CACHE.delete(sessionId)
  CACHE.set(sessionId, entry)
  while (CACHE.size > CACHE_LIMIT) CACHE.delete(CACHE.keys().next().value)
  return entry
}

function reasoningText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(b => b?.type === 'reasoning' || b?.type === 'thinking')
    .map(b => b?.text ?? b?.thinking ?? b?.reasoning ?? '')
    .filter(t => typeof t === 'string' && t.length > 0)
    .join('\n')
}

const RELINK_MAX_TEXT = 40
const RELINK_MAX_TOOL_ARGS = 120

function contentBlocks(e) {
  return e?.data?.message?.content ?? e?.data?.content ?? []
}

function textOf(blocks) {
  return blocks
    .filter(b => b?.type === 'text')
    .map(b => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

function toolCallsOf(blocks) {
  return blocks
    .filter(b => b?.type === 'tool-call')
    .map(b => ({ name: b?.name ?? '工具', arguments: b?.arguments ?? b?.input ?? '' }))
}

function previewOneLine(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function argPreview(arg) {
  const s = typeof arg === 'string' ? arg : JSON.stringify(arg ?? '')
  return previewOneLine(s, RELINK_MAX_TOOL_ARGS)
}

function turnOfEvent(events, index) {
  let current = null
  for (let i = 0; i <= index; i++) {
    const e = events[i]
    if (e?.type === 'turn/start' && Number.isFinite(Number(e?.data?.turn))) {
      current = Number(e.data.turn)
    }
  }
  const explicit = Number(events[index]?.data?.turn)
  return Number.isFinite(explicit) ? explicit : current
}

/**
 * 从 events 中取 target 原始 seq 所在 turn 的全部 reasoning。
 * 不跨 turn；按事件/块原始顺序拼接。
 * @returns {{status:'ok'|'empty'|'not-found', text?:string, turn?:number}}
 */
export function extractTurnReasoning(events, rawSeq) {
  const targetSeq = Number(rawSeq)
  if (!Array.isArray(events) || !Number.isFinite(targetSeq)) return { status: 'not-found' }
  const targetIndex = events.findIndex(e => Number(e?.seq) === targetSeq)
  if (targetIndex < 0) return { status: 'not-found' }
  const turn = turnOfEvent(events, targetIndex)
  if (!Number.isFinite(turn)) return { status: 'not-found' }

  let current = null
  const parts = []
  for (const e of events) {
    if (e?.type === 'turn/start' && Number.isFinite(Number(e?.data?.turn))) {
      current = Number(e.data.turn)
    }
    if (current !== turn) continue
    if (e?.type !== 'assistant/message') continue
    const blocks = e.data?.message?.content ?? e.data?.content ?? []
    const text = reasoningText(blocks)
    if (text) parts.push(text)
  }
  return { status: parts.length ? 'ok' : 'empty', text: parts.join('\n'), turn }
}

/**
 * 1.0.9 返回策略：按 turn 内步骤顺序重排。
 * 说话步骤挂上“它之前最近的一段还没用过的 reasoning”，中间隔着工具步也可以；
 * 一段 reasoning 只挂一次；工具步本身只留步骤头。
 */
export function renderTurnTrace(events, rawSeq) {
  const targetSeq = Number(rawSeq)
  if (!Array.isArray(events) || !Number.isFinite(targetSeq)) return { status: 'not-found' }
  const targetIndex = events.findIndex(e => Number(e?.seq) === targetSeq)
  if (targetIndex < 0) return { status: 'not-found' }
  const turn = turnOfEvent(events, targetIndex)
  if (!Number.isFinite(turn)) return { status: 'not-found' }

  const steps = []
  let current = null
  for (const e of events) {
    if (e?.type === 'turn/start' && Number.isFinite(Number(e?.data?.turn))) {
      current = Number(e.data.turn)
    }
    if (current !== turn || e?.type !== 'assistant/message') continue
    const blocks = contentBlocks(e)
    steps.push({
      text: textOf(blocks),
      reasoning: reasoningText(blocks),
      tools: toolCallsOf(blocks),
    })
  }
  if (!steps.length) return { status: 'empty', text: '', turn, steps: 0, toolCalls: 0, speaking: 0, attached: 0, unused: 0 }

  let toolCalls = 0
  let speaking = 0
  let attached = 0
  let reasonings = 0
  const pending = []
  const lines = []
  steps.forEach((step, i) => {
    const n = i + 1
    const hasText = step.text.trim().length > 0
    if (hasText) speaking++
    toolCalls += step.tools.length
    if (step.reasoning) {
      reasonings++
      pending.push({ step: n, text: step.reasoning })
    }

    let header
    if (hasText) {
      header = `[第 ${n} 步 · 说话] ${previewOneLine(step.text, RELINK_MAX_TEXT)}`
      if (step.tools.length) header += `（并调用 ${step.tools.map(t => t.name).join('、')}）`
    } else if (step.tools.length) {
      header = `[第 ${n} 步 · 工具] ${step.tools.map(t => `${t.name} ${argPreview(t.arguments)}`.trim()).join('；')}`
    } else {
      header = `[第 ${n} 步]`
    }

    if (hasText) {
      // 给第一次出现在这段思考之后的说话；取最近的一段未用过的思考。
      if (pending.length) {
        const thought = pending.pop()
        attached++
        header += `\n  └ 思考（来自第 ${thought.step} 步）：\n     ${formatReasoning(thought.text)}`
      } else {
        header += '\n  └ （这一步没有留下思考）'
      }
    }
    lines.push(header)
  })

  const overview = `这一轮共 ${steps.length} 步（${toolCalls} 次工具调用，${speaking} 次说话）`
  return {
    status: 'ok',
    text: `${overview}\n\n${lines.join('\n\n')}`,
    turn,
    steps: steps.length,
    toolCalls,
    speaking,
    attached,
    unused: reasonings - attached,
  }
}

/** 截断超长思考；返回的字符串带原文总字数说明。 */
export function formatReasoning(text, maxChars = RELINK_MAX_CHARS) {
  const s = String(text ?? '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n\n（原文 ${s.length} 字，已显示前 ${maxChars} 字）`
}

/** memory_relink 实现：messages 行 → turn → 该 turn 的 reasoning。 */
export function relinkView(handle, args, { sessionsRoot = '', findSessionEntry = null } = {}) {
  const seq = Number(args?.seq)
  if (!Number.isFinite(seq)) return '找不到这条记忆的思考'
  let row
  try {
    row = handle?.db?.prepare('SELECT seq, session_id, raw_seq FROM messages WHERE seq = ?').get(seq)
  } catch {
    return '找不到这条记忆的思考'
  }
  if (!row) return '找不到这条记忆的思考'
  const entry = typeof findSessionEntry === 'function'
    ? findSessionEntry(sessionsRoot, row.session_id)
    : null
  if (!entry?.filePath) return '找不到这条记忆的思考'
  const rawSeq = row.raw_seq != null
    ? Number(row.raw_seq)
    : Number(row.seq) - (typeof handle?.baseOf === 'function' ? Number(handle.baseOf(row.session_id)) : 0)
  if (!Number.isFinite(rawSeq)) return '找不到这条记忆的思考'
  const loaded = loadSessionEvents(entry.filePath, row.session_id)
  if (!loaded) return '找不到这条记忆的思考'
  try {
    const r = renderTurnTrace(loaded.events, rawSeq)
    if (r.status === 'not-found') return '找不到这条记忆的思考'
    if (r.status === 'empty') return '这一轮没有留下思考'
    return r.text
  } catch {
    return '找不到这条记忆的思考'
  }
}
