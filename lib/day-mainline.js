import { callExtractWithRetry } from './extract.js'

const DAY_PROMPT_VERSION = 6
const MAX_CHUNK_SEGMENTS = 60
const MIN_REF_CHARS = 20
const MAX_CHARS = 120
const MAX_CHARS_MANY = 200
const MANY_SEGMENTS = 300

function pad(n) { return String(n).padStart(2, '0') }
function hhmm(ms) {
  const d = new Date(Number(ms))
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export function localDayKey(ms) {
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function clip(value, n) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= n ? text : text.slice(0, n)
}
function dayStart(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

/** 当天全部 episode（跳过 episode_detail.simplified=1），不截断条数。 */
export function daySegments(db, day) {
  const start = dayStart(day)
  const end = start + 24 * 3600 * 1000
  return db.prepare(`
    SELECT e.session_id, e.start_seq, e.end_seq, e.start_at, e.title, e.summary, e.body,
      a.title AS agg_title, a.summary AS agg_summary, a.quote AS agg_quote, a.kind AS kind, a.updated_at AS agg_updated_at
    FROM episodes_v2 e
    LEFT JOIN episode_aggregates a
      ON a.session_id = e.session_id AND a.start_seq = e.start_seq AND a.end_seq = e.end_seq
    WHERE e.start_at >= ? AND e.start_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM episode_detail d
        WHERE d.session_id = e.session_id
          AND d.episode_id = CAST(e.start_seq AS TEXT)
          AND d.simplified = 1
      )
    ORDER BY e.start_at ASC, e.start_seq ASC
  `).all(start, end)
}

export function dayInputHash(day, rows) {
  const parts = (rows || []).map(r => [
    r.start_seq,
    r.agg_updated_at ?? '',
    r.agg_title ?? '',
    r.agg_summary ?? '',
    r.agg_quote ?? '',
    r.kind ?? '',
  ].join(':'))
  return `${day}|${parts.join('|')}`
}

export function materialLine(row) {
  const title = String(row.agg_title ?? row.title ?? '').trim()
  const summary = String(row.agg_summary ?? row.summary ?? '').trim()
  const fallback = clip(row.body, 30)
  const head = title || summary || fallback
  const tail = summary && summary !== head ? ` · ${clip(summary, 120)}` : ''
  return `${hhmm(row.start_at)} · ${clip(head, 80)}${tail} · ${row.kind ?? 'daily'}`
}

/** 引语优先取 fact/promise/feeling 的 quote，其次最长的 quote/body 节选。 */
export function quoteLine(row) {
  const q = String(row.agg_quote ?? '').trim()
  const body = String(row.body ?? '').replace(/\s+/g, ' ').trim()
  const text = q || clip(body, 120)
  if (!text) return ''
  return `${hhmm(row.start_at)} · ${row.kind ?? 'daily'} · ${clip(text, 120)}`
}

function pickQuotes(rows, max = 5) {
  const priority = (r) => ['fact', 'promise', 'feeling'].includes(r.kind) ? 2 : 1
  return [...rows]
    .filter(r => quoteLine(r))
    .sort((a, b) => (priority(b) - priority(a)) || (String(b.body ?? '').length - String(a.body ?? '').length) || (a.start_at - b.start_at))
    .slice(0, max)
    .map(quoteLine)
}

function cleanMainline(text) {
  return String(text ?? '')
    .replace(/^```[\s\S]*?\n/, '').replace(/```$/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastSentence(text) {
  const t = String(text ?? '').trim()
  const m = t.match(/([^。！？!?]*)[。！？!?]$/)
  return m ? m[1].trim() : ''
}

/** 结尾只剩 1–3 字的孤立短句（如「控制。」）；完整短句「我说好。」不算。 */
function orphanTail(text) {
  const segment = lastSentence(text)
  if (!segment || segment.length > 3) return false
  if (segment.length === 3 && /^[我你他她它咱您]/.test(segment)) return false
  return true
}

function maxCharsFor(rows) {
  return (rows?.length ?? 0) >= MANY_SEGMENTS ? MAX_CHARS_MANY : MAX_CHARS
}

function validMainline(text, maxChars) {
  const t = String(text ?? '')
  // 参考区间不是死线：允许一点超出，但不超过 240 字；特别长的模型输出会先被要求压缩一次。
  const hardLimit = Math.min(MAX_CHARS_MANY + 40, Math.max(maxChars, MAX_CHARS_MANY))
  return t.length > 0 && t.length <= hardLimit
}

function dayRules(maxChars) {
  return `你在为「某一天」写一段第一人称日记式主线，只输出正文，不要标题、不要 JSON、不要解释。
要求：
1. 不设死板字数下限：那天只聊了一句，就一句写完，不要为凑字数铺陈；参考区间 ${MIN_REF_CHARS}–${maxChars} 个汉字，段落特别多时可到 ${MAX_CHARS_MANY} 字。
2. 读完要能知道那天大概发生了什么；先写最占心的那件事，再写其他；反复出现的日常也照写，不要因为和前几天像就略过。
3. 不要按时间顺序罗列。第一句必须落在最占心、最有分量的事上；工作流水账、技术细节和重复日常即使篇幅长，也放到后面。
4. 选「最占心」时优先带情绪、关系变化、承诺或离别的段落，不要被任务流程和技术结论占满开头。
5. 原文引语里如果有一句直接表达情绪、关系或请求的话，正文必须把它写进去，不能只写发生了什么。
6. 第一人称只能写「我」自己的话；转述对方的话必须写明「你说/他说」并保留引号。不要把对方原句改写成我的内心独白；宁可略写，也不要串口吻。
7. 「原文引语」是必读材料：正文至少覆盖其中两处，尤其晚到的道歉、请求或约定，不要只按时间线挑前面的事。
8. 不要总结语，不要写「值得一提」「总之」「这一天」这类空话，不要分点，不要写日期。
9. 材料是当天的记忆段和原文引语；可以概括，但不得写出材料里没有的情节，细节必须在材料中找得到。`
}

async function callText(llm, prompt, { timeoutMs, maxTokens = 1200, day = '', journal = () => {} } = {}) {
  let r = await callExtractWithRetry(llm, { prompt, maxTokens, timeoutMs })
  // 长材料会先消耗 reasoning tokens；即使正文非空，finish=max-tokens 也代表正文被截断。
  if (r?.ok && r.finishReason === 'max-tokens') {
    r = await callExtractWithRetry(llm, {
      prompt: `${prompt}\n\n上一次输出因预算在句中截断。请直接输出完整正文，不要长篇思考；保留最占心的事和原文引语里的关键细节。`,
      maxTokens: 8000,
      timeoutMs
    })
  }
  if (!r?.ok || !r.text) {
    const error = new Error(r?.error || 'empty')
    error.empty = !r?.text
    throw error
  }
  let text = cleanMainline(r.text)
  if (orphanTail(text)) {
    const first = text
    const retry = await callExtractWithRetry(llm, {
      prompt: `${prompt}\n\n上一次正文最后只剩一个孤立短句（如「控制。」）。请重新输出完整正文，确保最后一句是完整句子，重复最占心的事和原文引语。`,
      maxTokens: 8000,
      timeoutMs
    })
    if (retry?.ok && retry.text) {
      const next = cleanMainline(retry.text)
      if (!orphanTail(next)) {
        text = next
      } else {
        journal('day-mainline-tail-warn', { day, tail: lastSentence(first), chars: first.length, retried: true })
      }
    } else {
      journal('day-mainline-tail-warn', { day, tail: lastSentence(first), chars: first.length, retried: true, retryError: retry?.error || 'empty' })
    }
  }
  return text
}

async function segmentOverview(llm, rows, opts) {
  const lines = [...rows.map(materialLine), '', '原文引语：', ...pickQuotes(rows, 5)]
  const prompt = `${dayRules(MAX_CHARS)}\n\n请先把下面这一天第 ${opts.index}/${opts.total} 段材料压成一句不超过 40 字的时段概览，保留原文引语里的关键细节；只输出这句话：\n${lines.join('\n')}`
  const text = await callText(llm, prompt, { ...opts, maxTokens: 600 })
  return clip(text, 80)
}

/** 生成某天日主线；失败返回 degraded，不拼材料冒充。 */
export async function generateDayMainline(db, llm, day, { timeoutMs = 90_000, journal = () => {} } = {}) {
  const rows = daySegments(db, day)
  const hash = dayInputHash(day, rows)
  if (!rows.length) return { day, text: '', status: 'degraded', source: 'fallback', hash }
  const maxChars = maxCharsFor(rows)
  try {
    let input
    const allQuotes = pickQuotes(rows, 5)
    if (rows.length <= MAX_CHUNK_SEGMENTS) {
      input = [...rows.map(materialLine), '', '原文引语：', ...allQuotes].join('\n')
    } else {
      const briefs = []
      const total = Math.ceil(rows.length / MAX_CHUNK_SEGMENTS)
      for (let i = 0; i < rows.length; i += MAX_CHUNK_SEGMENTS) {
        const part = rows.slice(i, i + MAX_CHUNK_SEGMENTS)
        briefs.push(await segmentOverview(llm, part, { timeoutMs, index: briefs.length + 1, total, day, journal }))
      }
      input = [...briefs.map((b, i) => `${i + 1}. ${b}`), '', '原文引语：', ...allQuotes].join('\n')
    }
    const prompt = `${dayRules(maxChars)}\n\n日期：${day}\n材料：\n${input}\n\n只输出日记正文（参考 ${MIN_REF_CHARS}–${maxChars} 字，不必凑满）。`
    let text = await callText(llm, prompt, { timeoutMs, maxTokens: maxChars >= MAX_CHARS_MANY ? 1800 : 1200, day, journal })
    if (!validMainline(text, maxChars) && text.length > maxChars) {
      const target = Math.max(MIN_REF_CHARS, Math.min(maxChars, 150))
      const shorter = `${prompt}\n\n注意：上一次写了 ${text.length} 字，太长了。请严格压缩到 ${target} 字以内，保留最占心的事和原文引语里的关键细节，不要分段。`
      text = await callText(llm, shorter, { timeoutMs, maxTokens: 1000, day, journal })
    }
    if (!validMainline(text, maxChars)) throw new Error(`bad-length:${text.length}`)
    return { day, text, status: 'ok', source: 'llm', hash }
  } catch (error) {
    return { day, text: '', status: 'degraded', source: 'fallback', hash, error: String(error?.message ?? error) }
  }
}

function putDayMainline(db, result) {
  db.prepare(`INSERT INTO day_mainline(day, text, status, source, input_hash, prompt_ver, updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET
      text=excluded.text, status=excluded.status, source=excluded.source,
      input_hash=excluded.input_hash, prompt_ver=excluded.prompt_ver, updated_at=excluded.updated_at`)
    .run(result.day, result.text || '', result.status, result.source, result.hash, DAY_PROMPT_VERSION, Date.now())
}

/** 最旧的、缺失或 hash 变化的天；最多 limit 天。今天不动。 */
export function pendingDayMainlines(db, { limit = 3, now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT e.session_id, e.start_seq, e.end_seq, e.start_at, e.title, e.summary, e.body,
      a.title AS agg_title, a.summary AS agg_summary, a.quote AS agg_quote, a.kind AS kind, a.updated_at AS agg_updated_at
    FROM episodes_v2 e
    LEFT JOIN episode_aggregates a
      ON a.session_id = e.session_id AND a.start_seq = e.start_seq AND a.end_seq = e.end_seq
    WHERE NOT EXISTS (
      SELECT 1 FROM episode_detail d
      WHERE d.session_id = e.session_id
        AND d.episode_id = CAST(e.start_seq AS TEXT)
        AND d.simplified = 1
    )
    ORDER BY e.start_at ASC, e.start_seq ASC
  `).all()
  const byDay = new Map()
  for (const row of rows) {
    const day = localDayKey(row.start_at)
    if (!day || day === localDayKey(now)) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(row)
  }
  const existing = new Map(db.prepare('SELECT day, status, input_hash FROM day_mainline').all().map(r => [r.day, r]))
  const out = []
  for (const day of [...byDay.keys()].sort()) {
    const hash = dayInputHash(day, byDay.get(day))
    const old = existing.get(day)
    if (old && old.status === 'ok' && old.input_hash === hash) continue
    out.push({ day, hash })
    if (out.length >= Math.max(1, Number(limit) || 3)) break
  }
  return out
}

/** 后台入口：每次最多 3 天，最旧优先；不抛异常，写 journal。 */
export async function ensureDayMainlines(dbHandle, llm, { limit = 3, timeoutMs = 90_000, journal = () => {}, log = () => {} } = {}) {
  if (!dbHandle?.db || !llm) return { done: 0, degraded: 0 }
  const todo = pendingDayMainlines(dbHandle.db, { limit })
  let done = 0, degraded = 0
  for (const item of todo) {
    const r = await generateDayMainline(dbHandle.db, llm, item.day, { timeoutMs, journal })
    putDayMainline(dbHandle.db, r)
    if (r.status === 'ok') done++
    else degraded++
    journal('day-mainline-done', { day: r.day, chars: (r.text || '').length, status: r.status, source: r.source, error: r.error ?? null })
    log(`day-mainline ${r.day} status=${r.status} chars=${(r.text || '').length}${r.error ? ` error=${r.error}` : ''}`)
  }
  return { done, degraded, total: todo.length }
}

export const DAY_MAINLINE_PROMPT_VERSION = DAY_PROMPT_VERSION
export const DAY_MAINLINE_LIMITS = { MIN_REF_CHARS, MAX_CHARS, MAX_CHARS_MANY, MANY_SEGMENTS, MAX_CHUNK_SEGMENTS }
