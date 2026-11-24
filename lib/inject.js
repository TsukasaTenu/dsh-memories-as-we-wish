// 注入/工具返回：纯材料，不带框架（规格 §3.3 / §3.5）
export const MAX_CHARS = 320
export const MAX_ITEMS_TRIGGER = 5

// 时间戳：完整格式 YYYY-MM-DD HH:MM:SS（task-32 格式；不再用“今天/昨天/上个月”）
const pad2 = (n) => String(n).padStart(2, '0')
export const fmtTime = (ms) => {
  const d = new Date(Number(ms) || Date.now())
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
// 兼容旧引用：relTime 现在返回完整时间戳
export const relTime = (ms) => fmtTime(ms)

// ---------- 展示去重：跨会话同一句话只留一条 ----------
const PUNCT = /[\s，。！？、；：""''「」『』（）\[\]【】《》…—\-·.,!?;:'"()\[\]{}]/g
const normText = (s) => String(s ?? '').replace(PUNCT, '')
const bigrams = (s) => {
  const out = new Set()
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2))
  return out
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}
/** 按文本去重：完全相同（去空白/标点）保留第一条；bigram Jaccard ≥0.9 视为同一条。 */
export function dedupeByText(items) {
  const out = []
  const seen = []
  for (const it of items) {
    const t = normText(it?.text)
    if (!t) continue
    const g = bigrams(t)
    if (seen.some(s => s.t === t || jaccard(g, s.g) >= 0.9)) continue
    seen.push({ t, g })
    out.push(it)
  }
  return out
}
const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n).join('') + '…'
}

/** 引语逐字复核：引号内必须是对应原文的精确子串。 */
export function verifyQuote(quote, sourceText) {
  if (!quote) return true
  return String(sourceText ?? '').includes(quote)
}

/** 展示选择：候选池 > 上限时先去重再截断；池子 ≤ 上限时不去重、直接给。 */
export function selectDisplay(items, maxItems) {
  const cap = Math.max(1, maxItems)
  const pool = items.length > cap ? dedupeByText(items) : items
  return pool.slice(0, cap)
}

/**
 * 纯材料行：`{时间} · {发生了什么}`；触发式最多 maxItems 条，**原文不截断**。
 * @param {object} opts { episodes:[{seq,time,role,text}], quote, now, maxItems }
 */
export function buildInjection({ episodes = [], quote = null, now = Date.now(), maxItems = 2 } = {}) {
  let quoteText = ''
  if (quote?.text) {
    if (!verifyQuote(quote.text, quote.sourceText)) return { text: '', chars: 0, verified: false, reason: 'quote-mismatch' }
    quoteText = ` 原话：「${String(quote.text).replace(/\s+/g, ' ')}」`
  }
  const makeLine = (ep) => {
    const who = ep.role === 'user' ? '你说过' : ep.role === 'assistant' ? '我说过' : '摘要'
    return `${relTime(ep.time, now)} · ${who}：${String(ep.text ?? '').replace(/\s+/g, ' ')}`
  }
  const picked = selectDisplay(episodes, maxItems)
  const lines = picked.map(makeLine)
  if (quoteText && lines.length) lines[0] += quoteText
  const text = lines.join('\n')
  return { text, chars: [...text].length, verified: true, reason: 'ok' }
}

// 标题截断：≤40 字，按标点收尾（不在句子中间硬切）
const TITLE_MAX = 40
const TITLE_END = /[。！？；!?;]/
const TITLE_ANY = /[。！？；，、,.;!?;]/
function cutAtPunct(s, max = TITLE_MAX) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (!str) return ''
  const chars = [...str]
  if (chars.length <= max) return str
  const win = chars.slice(0, max)
  // 先在 40 字内找“句末标点”收尾
  for (let i = win.length - 1; i >= 0; i--) if (TITLE_END.test(win[i])) return win.slice(0, i + 1).join('').trim()
  // 退而求其次：在 40 字内找任意标点收尾
  for (let i = win.length - 1; i >= 0; i--) if (TITLE_ANY.test(win[i])) return win.slice(0, i).join('').trim() || win.slice(0, i + 1).join('')
  // 真的没有标点：只能截断并加省略号
  return chars.slice(0, max - 1).join('') + '…'
}
function firstSentence(s, max = TITLE_MAX) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (!str) return ''
  const m = str.match(/^(.{0,40}?[。！？；!?;])/)
  if (m) return m[1]
  return cutAtPunct(str, max)
}
/** 块头标题：优先 summary 首句；其次 episode.title；最后 body 首句。≤40 字、按标点收。 */
export function episodeTitle(ep) {
  const sum = String(ep?.summary ?? '').trim()
  if (sum) return firstSentence(sum)
  const t = String(ep?.title ?? '').trim()
  if (t) return cutAtPunct(t)
  const b = String(ep?.body ?? '').trim()
  if (b) return firstSentence(b)
  return '一件事'
}

/**
 * episode 块展示（task-32/33）：一块 = 一个 episode。
 * 块头：{YYYY-MM-DD HH:MM:SS} · #{start_seq} · {标题}（#seq 可直接喂 memory_remember）。
 * 块内按 role 逐行 `  你：` / `  我：`；**原文不截断**，只按 maxItems 控条数。
 */
export function buildEpisodeBlocks({ blocks = [], quote = null, now = Date.now(), maxItems = 5, showTitle = true } = {}) {
  const picked = (blocks ?? []).slice(0, Math.max(1, maxItems))
  const render = (b) => {
    const seq = Number.isFinite(Number(b.seq)) ? ` · #${Number(b.seq)}` : ''
    const head = `${fmtTime(b.time ?? now)}${seq}${showTitle ? ' · ' + episodeTitle(b) : ''}`
    const lines = (b.lines ?? []).slice(0, 2).map(l => {
      const who = l.role === 'user' ? '你' : l.role === 'assistant' ? '我' : '记'
      return `  ${who}：${String(l.text ?? '').replace(/\s+/g, ' ')}`
    })
    if (!lines.length) lines.push(`  记：${String(b.summary ?? b.body ?? '').replace(/\s+/g, ' ')}`)
    return [head, ...lines].join('\n')
  }
  const parts = picked.map(b => render(b))
  if (quote?.text) {
    if (!verifyQuote(quote.text, quote.sourceText)) return { text: '', chars: 0, verified: false, reason: 'quote-mismatch' }
    parts[0] += `\n  原话：「${String(quote.text).replace(/\s+/g, ' ')}」`
  }
  const text = parts.join('\n\n')
  return { text, chars: [...text].length, verified: true, reason: 'ok' }
}

/** 工具返回也是 episode 块（与注入同一格式）。 */
export function renderMaterial(results, { now = Date.now(), limit = 5 } = {}) {
  const blocks = selectDisplay(results, limit).map(r => ({
    time: r.start_at ?? r.time ?? now,
    title: r.title ?? episodeTitle(r),
    lines: (r.lines ?? []).slice(0, 2),
    summary: r.summary,
    body: r.body,
  }))
  return buildEpisodeBlocks({ blocks, now, maxItems: limit }).text
}
