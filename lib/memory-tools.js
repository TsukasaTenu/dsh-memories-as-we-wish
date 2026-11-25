// 主动工具的输出构造（index.js 与离线验证共用，便于直接测试）
import { rankEpisodes, contentTokens } from './pipeline.js'
import { buildEpisodeBlocks, dedupeByText, fmtTime } from './inject.js'

// 解析 YYYY-MM-DD：from 取当天 00:00:00.000，to 取当天 23:59:59.999（含）
export function parseDay(value, endOfDay) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  if (endOfDay) d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function toBlocks(handle, rows, now) {
  return rows.map(ep => ({
    seq: ep.start_seq,
    time: ep.start_at ?? now,
    title: ep.title ?? '',
    summary: ep.summary ?? '',
    body: ep.body ?? '',
    lines: handle.messagesInRange(ep.start_seq, ep.end_seq, 4).slice(0, 2).map(m => ({ role: m.role, text: m.text })),
  }))
}

// 尾部弱候选：A 段完整摘要 + B 段正文命中窗口（总长 ≤50）。
const TAIL_HALF = 25
const TAIL_MAX = 50

function cleanTailText(value) {
  return String(value ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function findHit(text, tokens) {
  const lower = text.toLowerCase()
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0) return { token, index }
  }
  return null
}

function windowAroundHit(text, hit) {
  const chars = [...text]
  const tokenChars = [...hit.token]
  // 先取左右各 25 字；总长仍超 50 时从较长的一侧砍，保证 ≤50。
  let left = chars.slice(Math.max(0, hit.index - TAIL_HALF), hit.index)
  let right = chars.slice(hit.index + hit.token.length, hit.index + hit.token.length + TAIL_HALF)
  let start = hit.index - left.length
  let end = hit.index + hit.token.length + right.length
  // 总长要含截断省略号；两端都截时正文最多 48 字。
  while (left.length + tokenChars.length + right.length + (start > 0 ? 1 : 0) + (end < chars.length ? 1 : 0) > TAIL_MAX) {
    if (left.length >= right.length) left = left.slice(1)
    else right = right.slice(0, -1)
    start = hit.index - left.length
    end = hit.index + hit.token.length + right.length
  }
  const body = [...left, ...tokenChars, ...right].join('')
  return `${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`
}

const TRAILING_PUNCT = /[。，；：、,.;:!?！？…\s]+$/u

function stripTailPunctuation(text) {
  return String(text ?? '').replace(TRAILING_PUNCT, '').trim()
}

function readableSentence(value) {
  const cleaned = cleanTailText(value)
  if (!cleaned) return false
  // 句末的逗号/分号/冒号不算“可读成句”；先去掉它们，再看是否以句末标点收尾。
  const normalized = cleaned.replace(/[，；：、,.;:\s]+$/u, '')
  return [...normalized].length >= 20 && /[。！？…!?]$/u.test(normalized)
}

function firstSentence(value) {
  const cleaned = cleanTailText(value)
  if (!cleaned) return ''
  const parts = cleaned.split(/(?<=[。！？!?…])\s*/u).map(x => x.trim()).filter(Boolean)
  return parts.find(x => [...x].length >= 10) || parts[0] || ''
}

function fullSummary(handle, ep) {
  const aggregate = (() => {
    try { return handle.getAggregate?.(ep.session_id, ep.start_seq, ep.end_seq) } catch { return null }
  })()
  const take = (value, source) => {
    const summary = stripTailPunctuation(cleanTailText(value))
    return summary ? { summary, source } : null
  }
  // A 段来源顺序：LLM 摘要 → 机械摘要（可读成句）→ LLM 标题 →
  // 机械标题（可读成句）→ 正文首句 → 最后才保留原机械标题。
  const llmSummary = take(aggregate?.summary, 'llm-summary')
  if (llmSummary) return llmSummary
  if (readableSentence(ep?.summary)) {
    const episodeSummary = take(ep.summary, 'episode-summary')
    if (episodeSummary) return episodeSummary
  }
  const llmTitle = take(aggregate?.title, 'llm-title')
  if (llmTitle) return llmTitle
  if (readableSentence(ep?.title)) {
    const episodeTitle = take(ep.title, 'episode-title')
    if (episodeTitle) return episodeTitle
  }
  const bodyFirst = take(firstSentence(cleanTailText(ep?.body) || cleanTailText(ep?.quote)), 'body-first')
  if (bodyFirst) return bodyFirst
  const originalTitle = take(ep?.title, 'episode-title')
  if (originalTitle) return originalTitle
  return { summary: '', source: '' }
}

function bodyWindow(ep, tokens) {
  for (const [source, value] of [['episode-body', ep?.body], ['episode-quote', ep?.quote]]) {
    const text = cleanTailText(value)
    if (!text) continue
    const hit = findHit(text, tokens)
    if (hit) return { body: windowAroundHit(text, hit), source, token: hit.token }
  }
  return { body: '', source: '', token: '' }
}

function tailLine(handle, ep, tokens) {
  const detail = tailLineDetail(handle, ep, tokens)
  return detail.body ? `${detail.summary}｜${detail.body}` : detail.summary
}

/** 仅供验证/报告：返回 A 段完整摘要、B 段正文窗口及来源，不改变工具返回。 */
export function tailLineDetail(handle, ep, tokens) {
  const summary = fullSummary(handle, ep)
  const body = bodyWindow(ep, tokens)
  return { summary: summary.summary, summarySource: summary.source, body: body.body, bodySource: body.source, token: body.token }
}

function tailSection(handle, rows, excludedIds, tail, now, tokens) {
  if (!tokens?.length) return ''
  const candidates = rows.filter(ep => !excludedIds.has(ep.id) && Number(ep.rel) > 0)
  const lines = []
  for (const ep of candidates) {
    if (lines.length >= tail) break
    const summary = tailLine(handle, ep, tokens)
    if (!summary) continue // 找不到命中词/摘要为空：整条不输出
    lines.push(`${fmtTime(ep.start_at ?? now)} · #${ep.start_seq} · ${summary}`)
  }
  if (!lines.length) return ''
  return `另有 ${lines.length} 条相关但较弱的：\n${lines.join('\n')}`
}

/** memory_recall：query 与 from/to 是 AND；query 可为空（纯时间查，默认 10 条）。 */
export function searchView(handle, args, { entities = [], now = Date.now() } = {}) {
  const q = String(args?.query ?? '').trim()
  const fromTs = parseDay(args?.from, false)
  const toTs = parseDay(args?.to, true)
  if (!q && fromTs == null && toTs == null) return '（需要 query，或 from/to 时间范围）'
  const pureTime = !q
  const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20))
  const tail = args?.tail == null ? 10 : Math.max(0, Math.min(50, Math.trunc(Number(args.tail) || 0)))
  let rows
  let queryTokens = []
  if (pureTime) {
    const lo = fromTs ?? 0
    const hi = toTs ?? Number.MAX_SAFE_INTEGER
    rows = handle.db.prepare("SELECT id, session_id, start_seq, end_seq, start_at, end_at, title, body, summary, quote FROM episodes_v2 WHERE status='active' AND start_at >= ? AND start_at <= ? ORDER BY start_at DESC LIMIT ?").all(lo, hi, limit * 4)
  } else {
    const rankLimit = Math.min(250, Math.max(limit * 4, limit + tail + 20))
    const ranked = rankEpisodes(handle, q, { entities, now, limit: rankLimit })
    rows = ranked.rows
    queryTokens = ranked.tokens?.length ? ranked.tokens : contentTokens(q).slice(0, 24)
    if (fromTs != null || toTs != null) {
      const lo = fromTs ?? 0
      const hi = toTs ?? Number.MAX_SAFE_INTEGER
      rows = rows.filter(r => Number(r.start_at) >= lo && Number(r.start_at) <= hi)   // query AND 时间范围
    }
  }
  const pool = rows.length > limit ? dedupeByText(rows.map(r => ({ ...r, text: r.body }))) : rows
  const top = pool.slice(0, limit)
  const out = buildEpisodeBlocks({ blocks: toBlocks(handle, top, now), now, maxItems: limit, showTitle: false }).text
  if (!out) return '（没有找到那段时间的记忆）'
  if (!pureTime && tail > 0) {
    const extra = tailSection(handle, rows, new Set(top.map(r => r.id)), tail, now, queryTokens)
    if (extra) return `${out}\n\n${extra}`
  }
  return out
}

/** memory_remember：#seq → 原文若干条；定向读，不截断、不设总长上限（她已知道要读哪条）。 */
export function readView(handle, args) {
  const seq = Number(args?.seq)
  if (!Number.isFinite(seq)) return ''
  const span = Math.max(1, Math.min(10, Number(args?.span) || 1))
  const rows = handle.db.prepare('SELECT seq, role, time, text FROM messages WHERE seq >= ? ORDER BY seq LIMIT ?').all(seq, span)
  return rows.map(r => {
    const who = r.role === 'user' ? '你' : r.role === 'assistant' ? '我' : '记'
    return `${r.seq} · ${who}：${String(r.text ?? '').replace(/\s+/g, ' ')}`
  }).join('\n')
}
