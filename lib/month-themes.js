import { callExtractWithRetry } from './extract.js'

const PROMPT_VER = 3
const MAX_THEMES = 4
const MAX_THEME_CHARS = 8
const MAX_LINE_CHARS = 70
const ANCHOR_RE = /^(.+)[（(](\d{2}-\d{2})[）)]$/

function clean(text) {
  return String(text ?? '').replace(/^```[\s\S]*?\n/, '').replace(/```$/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ').trim()
}
function unwrapThemes(text) {
  let value = clean(text)
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value)
      value = typeof obj?.themes === 'string' ? obj.themes : ''
    } catch { value = '' }
  }
  return value
}
function partsOf(text) {
  return unwrapThemes(text).split(/\s*[·|]\s*/).map(s => s.trim()).filter(Boolean)
}
function normalizeAnchor(part) {
  const m = String(part || '').trim().match(ANCHOR_RE)
  return m ? `${m[1].trim()}（${m[2]}）` : String(part || '').trim()
}
function themeWidth(text) {
  // 中文按 1 字计；连续的英文/数字词按 1 个单位计（例如 MeloTTS 算一个词）。
  return String(text || '').replace(/[A-Za-z0-9_]+/g, 'x').length
}
export function validThemes(text) {
  const parts = partsOf(text)
  if (parts.length < 2 || parts.length > MAX_THEMES) return false
  if (parts.some(s => {
    const m = s.match(ANCHOR_RE)
    return !m || themeWidth(m[1]) > MAX_THEME_CHARS
  })) return false
  // 总行宽由 monthLine 按 70 字预算渲染时再裁；这里只校验主题和日期锚，避免模型多写一个字就整段丢弃。
  return true
}
function normalize(text) {
  const parts = partsOf(text).slice(0, MAX_THEMES).map(normalizeAnchor)
  return parts.join(' · ')
}
function monthHash(month, days) {
  return `${month}|${days.map(d => `${d.day}:${d.updated_at ?? ''}:${d.text ?? ''}`).join('|')}`
}
export function monthDays(db, month) {
  return db.prepare('SELECT day, text, status, updated_at FROM day_mainline WHERE day LIKE ? ORDER BY day').all(`${month}-%`)
}
export function monthInputHash(month, days) {
  return monthHash(month, days)
}

export async function generateMonthThemes(db, llm, month, { timeoutMs = 90_000 } = {}) {
  const days = monthDays(db, month).filter(d => d.status === 'ok' && String(d.text || '').trim())
  if (!days.length) return { month, themes: '', hash: monthHash(month, monthDays(db, month)) }
  const material = days.map(d => `${d.day}：${d.text}`).join('\n')
  const prompt = `从下面这个月的日主线里归纳 2–4 个主题，用于月份折叠行。规则：
- 每个主题不超过 8 个汉字，具体、有信息量，不要「日常」「生活」「工作」这类空词；
- 每个主题后面必须统一挂它对应的日期锚，格式「主题（MM-DD）」；日期锚必须来自该月日主线的日期；
- 用「 · 」连接，整行（含日期锚）不超过 70 字；
- 优先写 2–3 个；4 个会超过 70 字时就删到 3 个，不要硬凑；
- 主题必须能在该月日主线里找到依据，找不到依据就不要写；
- 只输出主题串本身，不要解释、不要编号、不要引号。
月份：${month}
${material}`
  try {
    const r = await callExtractWithRetry(llm, { prompt, maxTokens: 600, timeoutMs })
    if (!r?.ok || !r.text) throw new Error(r?.error || 'empty')
    let themes = normalize(r.text)
    if (!validThemes(themes)) {
      const retry = `${prompt}\n\n上一次输出是：${themes}\n它超过 70 字或主题数/日期锚不合格。请只输出 2–3 个主题，整行含日期锚严格不超过 70 字。`
      const r2 = await callExtractWithRetry(llm, { prompt: retry, maxTokens: 500, timeoutMs })
      if (!r2?.ok || !r2.text) throw new Error(r2?.error || 'empty-retry')
      themes = normalize(r2.text)
    }
    if (!validThemes(themes)) throw new Error(`bad-themes:${themes}`)
    return { month, themes, hash: monthHash(month, monthDays(db, month)), source: 'llm' }
  } catch (error) {
    return { month, themes: '', hash: monthHash(month, monthDays(db, month)), source: 'fallback', error: String(error?.message ?? error) }
  }
}

export function pendingMonthThemes(db, { limit = 1 } = {}) {
  const months = db.prepare('SELECT name FROM (SELECT DISTINCT substr(day,1,7) AS name FROM day_mainline) ORDER BY name').all().map(r => r.name)
  const existing = new Map(db.prepare('SELECT month, themes, source, input_hash FROM month_themes').all().map(r => [r.month, r]))
  const out = []
  for (const month of months) {
    const days = monthDays(db, month)
    if (!days.some(d => d.status === 'ok' && String(d.text || '').trim())) continue
    const hash = monthHash(month, days)
    const old = existing.get(month)
    if (old && old.input_hash === hash && String(old.themes || '').trim()) continue
    out.push({ month, hash })
    if (out.length >= Math.max(1, Number(limit) || 1)) break
  }
  return out
}

export async function ensureMonthThemes(dbHandle, llm, { limit = 1, timeoutMs = 90_000, journal = () => {}, log = () => {} } = {}) {
  if (!dbHandle?.db || !llm) return { done: 0 }
  let done = 0
  for (const item of pendingMonthThemes(dbHandle.db, { limit })) {
    const r = await generateMonthThemes(dbHandle.db, llm, item.month, { timeoutMs })
    dbHandle.db.prepare(`INSERT INTO month_themes(month, themes, source, input_hash, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(month) DO UPDATE SET themes=excluded.themes, source=excluded.source,
        input_hash=excluded.input_hash, updated_at=excluded.updated_at`)
      .run(r.month, r.themes || '', r.source || 'fallback', r.hash, Date.now())
    if (r.themes) done++
    journal('month-themes-done', { month: r.month, themes: r.themes, source: r.source || 'fallback', error: r.error ?? null })
    log(`month-themes ${r.month} source=${r.source || 'fallback'} themes=${r.themes}${r.error ? ` error=${r.error}` : ''}`)
  }
  return { done }
}

export const MONTH_THEMES_PROMPT_VERSION = PROMPT_VER
