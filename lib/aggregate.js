// LLM 聚合 episode：消息段 → LLM 抽取 title/summary/cues/quote → episodes_v2
// 确定性 buildEpisodes 作为降级（LLM 失败/未就绪/门禁不过）；聚合结果按消息段缓存，避免重复调用。
import { buildEpisodes, makeTitle, isShortInteraction } from './episodes.js'
import { buildIncrementalPrompt, callExtractWithRetry, parseJsonLoose } from './extract.js'
import { isAggKind } from './labels.js'

/** 标签属于软信息：非法/缺失一律落 daily，并记 journal（不阻断聚合）。 */
export function normalizeAggLabel (rawKind, rawFirst, { sessionId, startSeq, endSeq, journal = () => {} } = {}) {
  const kind = String(rawKind ?? '').trim().toLowerCase()
  const first = rawFirst === true || rawFirst === 1 || rawFirst === '1' ? 1 : 0
  if (!isAggKind(kind)) {
    journal('agg-label-invalid', { sessionId, startSeq, endSeq, kind: rawKind ?? null, fallback: 'daily' })
    return { kind: 'daily', first }
  }
  return { kind, first }
}

const firstSentence = (s, max = 40) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (!str) return ''
  const m = str.match(/^(.{0,max}?[。！？；!?;])/)
  if (m) return m[1]
  return [...str].slice(0, max).join('')
}

/** 校验最多重试 2 次（1 次原调 + 2 次带原因重试）。 */
export const VALIDATION_RETRIES = 2

/** 冷却重试退避：10min → 30min → 2h，之后 2h 封顶。 */
export const AGG_RETRY_BACKOFF_MS = [10 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]
export const AGG_RETRY_MAX_MS = 2 * 60 * 60 * 1000

export function aggRetryKey (sessionId, startSeq, endSeq) {
  return `aggRetryAt:${sessionId}:${startSeq}:${endSeq}`
}

export function parseAggRetry (value) {
  try {
    const v = JSON.parse(String(value ?? ''))
    if (!v || typeof v !== 'object') return null
    return { attempts: Number(v.attempts) || 0, nextAt: Number(v.nextAt) || 0, lastReason: String(v.lastReason ?? '') }
  } catch { return null }
}

export function retryDelayForAttempt (attempts) {
  const n = Math.max(1, Number(attempts) || 1)
  return AGG_RETRY_BACKOFF_MS[Math.min(n - 1, AGG_RETRY_BACKOFF_MS.length - 1)] ?? AGG_RETRY_MAX_MS
}

/** 进入冷却：不写 aggSkipped，写 aggRetryAt（attempts 累加）。 */
export function scheduleAggRetry (dbHandle, { sessionId, startSeq, endSeq, reason, now = Date.now(), journal = () => {} }) {
  const key = aggRetryKey(sessionId, startSeq, endSeq)
  let prev = null
  try { prev = parseAggRetry(dbHandle.getMeta?.(key)) } catch { prev = null }
  const attempts = Math.max(1, Number(prev?.attempts) || 0) + (prev ? 1 : 0)
  const nextAt = Number(now) + retryDelayForAttempt(attempts)
  const lastReason = String(reason || 'unknown')
  try { dbHandle.setMeta?.(key, JSON.stringify({ attempts, nextAt, lastReason })) } catch { /* noop */ }
  try { journal('aggregate-cooldown', { sessionId, startSeq, endSeq, attempts, nextAt, reason: lastReason }) } catch { /* noop */ }
  return { attempts, nextAt, lastReason }
}

/** 冷却未到期时跳过；到期或没有记录则可尝试。 */
export function aggRetryPending (dbHandle, key, now = Date.now()) {
  let value
  try { value = dbHandle.getMeta?.(key) } catch { return false }
  if (value === undefined) return false
  const r = parseAggRetry(value)
  return Boolean(r && Number(r.nextAt) > Number(now))
}

export function clearAggRetry (dbHandle, key) {
  try { dbHandle.deleteMeta?.(key) } catch { /* noop */ }
}

const reasonHint = (reason, v) => {
  if (reason === 'title-length') return `上一版 title 有 ${[...v.title].length} 字，要求 10–30 字`
  if (reason === 'summary-length') return `上一版 summary 有 ${[...v.summary].length} 字，要求 60–200 字`
  if (reason === 'summary-not-first-person') return '上一版 summary 没有出现「我」，要求第一人称，必须出现「我」'
  if (reason === 'cues-count') return `上一版 cues 只有 ${v.cues.length} 个，要求 5–10 个`
  return reason
}

/** 带失败原因的重试 prompt：原 prompt + 上一版输出 + 具体修正要求。 */
export function buildRetryPrompt (basePrompt, previous, v) {
  const hints = (v?.reasons || []).map(reason => `- ${reasonHint(reason, v)}`).join('\n')
  const prev = JSON.stringify({
    title: previous?.title,
    summary: previous?.summary,
    cues: previous?.cues,
    quote: previous?.quote,
  }).slice(0, 2000)
  return `${basePrompt}\n\n【上一次输出（未通过校验）】\n${prev}\n\n【必须修正】\n${hints}\n请重新输出完整 JSON；不要解释，只输出 JSON。`
}

/** 防编门禁：标题/第一人称摘要/线索数量/quote 逐字 */
export function validateAgg(ep, groupText) {
  const title = String(ep?.title ?? '').trim()
  const summary = String(ep?.summary ?? '').trim()
  const cues = (Array.isArray(ep?.cues) ? ep.cues : []).map(String).map(s => s.trim()).filter(Boolean)
  let quote = String(ep?.quote ?? '').trim()
  const reasons = []
  if ([...title].length < 4 || [...title].length > 60) reasons.push('title-length')
  if ([...summary].length < 10 || [...summary].length > 400) reasons.push('summary-length')
  if (!/我/.test(summary)) reasons.push('summary-not-first-person')
  if (cues.length < 2 || cues.length > 12) reasons.push('cues-count')
  // quote 不逐字 → 丢掉引语，但不否决整条聚合
  if (quote && !String(groupText ?? '').includes(quote)) quote = ''
  return { ok: reasons.length === 0, reasons, title, summary, cues, quote }
}

/**
 * 用 LLM 聚合一个会话的 episodes，并写入 episodes_v2（重建该会话）。
 * 不再按调用次数截断；用 maxSegments 限单批，常驻节流器按 tick 续跑。
 * @param {{llm?:any, now?:number, includeTail?:boolean, maxEndSeq?:number, callTimeoutMs?:number, maxSegments?:number, beforeLlmCall?:Function, entities?:string[]}} opts
 */
export async function buildAndIndexEpisodesLLM(dbHandle, sessionId, { llm = null, now = Date.now(), includeTail = false, maxEndSeq = Infinity, callTimeoutMs = 90_000, maxSegments = Infinity, beforeLlmCall = null, entities = [] } = {}) {
  const rows = dbHandle.db.prepare("SELECT seq, raw_seq, role, time, text FROM messages WHERE session_id = ? AND (status IS NULL OR status != 'rejected') ORDER BY seq").all(sessionId)
  if (!rows.length) { dbHandle.indexEpisodes(sessionId, []); return [] }
  // 与 buildAndIndexEpisodes 相同的密度分组：保证机械/LLM 共用同一套 range
  const shortRatio = rows.length ? rows.filter(m => isShortInteraction(m.text)).length / rows.length : 0
  const densityOpts = shortRatio > 0.6 ? { maxItems: 60, maxBodyChars: 200 } : { maxItems: 2, maxBodyChars: 600 }
  const groups = buildEpisodes(rows.map(r => ({ seq: r.seq, role: r.role, time: r.time, text: r.text })), { ...densityOpts, entities })
  const maxBatch = Number.isFinite(Number(maxSegments)) ? Math.max(0, Number(maxSegments)) : Infinity
  let batchExhausted = false
  let attemptedSegments = 0
  let llmCalls = 0
  const journal = (kind, detail) => {
    try { dbHandle.journal?.(kind, detail) } catch { /* noop */ }
  }
  const out = []
  const lastSeq = rows[rows.length - 1].seq
  for (const g of groups) {
    const groupRows = rows.filter(r => r.seq >= g.startSeq && r.seq <= g.endSeq)
    const groupText = groupRows.map(r => String(r.text)).join('\n')
    // 当前还在生长的尾段（含最后一条消息）：pre-step 时先不调用模型，避免每轮重复；
    // 回合结束后的补扫（includeTail=true）可以聚合，因为这时文件已落盘、该段已定型。
    const isOpen = g.endSeq === lastSeq && !includeTail
    // 水位模式：只聚合到 cutoffSeq（稳定段）；cutoff 之后的段保持机械字段，等下次水位
    const beyondStable = g.endSeq > maxEndSeq
    const isShort = g.valuable === false   // 短互动合成段：不用 LLM，但保留以匹配机械版 range
    let fields = null
    const retryKey = aggRetryKey(sessionId, g.startSeq, g.endSeq)
    // 1) 缓存（同一段只调用一次；cutoff 之后的段不用缓存/LLM）
    if (!isShort && !beyondStable) {
      try {
        const cached = dbHandle.getAggregate(sessionId, g.startSeq, g.endSeq)
        if (cached) {
          fields = { title: cached.title, summary: cached.summary, cues: String(cached.cues ?? '').split(/\s+/).filter(Boolean), quote: cached.quote, kind: cached.kind ?? null, first: cached.first ? 1 : 0, source: 'cache' }
          clearAggRetry(dbHandle, retryKey)
        }
      } catch { /* noop */ }
    }
    // 2) LLM 抽取：校验不过带原因重试，上限 2 次；maxSegments 控制单批
    // 已被判定无法聚合的段（空输出/连续校验失败）不再反复调用模型；
    // 保留机械 fallback，等人工或后续数据修复再清 skip。
    let skipped = false
    if (!fields && !isShort && !beyondStable) {
      try {
        skipped = dbHandle.getMeta?.(`aggSkipped:${sessionId}:${g.startSeq}:${g.endSeq}`) !== undefined ||
          aggRetryPending(dbHandle, retryKey, now)
      } catch { skipped = false }
    }
    if (!fields && !skipped && llm && !batchExhausted && !isOpen && !isShort && !beyondStable) {
      let allowed = attemptedSegments < maxBatch
      if (!allowed) batchExhausted = true
      if (allowed && beforeLlmCall) {
        try { allowed = await beforeLlmCall() } catch { allowed = true }
        if (!allowed) batchExhausted = true
      }
      if (allowed) {
        attemptedSegments++
        try {
          const msgs = groupRows.map(r => ({ seq: r.raw_seq ?? r.seq, role: r.role, time: r.time, text: r.text }))
          const basePrompt = buildIncrementalPrompt(msgs) + '\n\n【聚合要求（最高优先）】title：10–30 字，一句话说清“那件事”；summary：60–200 字，第一人称（要出现“我”），写清谁说了什么、我当时怎么想；cues：5–10 个检索词（人/物/地点/活动）；quote：逐字原话；kind/first 必须按上面的标签规则填写。只输出 JSON。'
          let prompt = basePrompt
          let retries = 0
          while (true) {
            llmCalls++
            const r = await callExtractWithRetry(llm, { prompt, maxTokens: 3000, timeoutMs: callTimeoutMs })
            if (r?.timedOut) {
              scheduleAggRetry(dbHandle, { sessionId, startSeq: g.startSeq, endSeq: g.endSeq, reason: 'timeout', now, journal })
              const error = new Error(`llm-timeout:${callTimeoutMs}ms`)
              error.timedOut = true
              throw error
            }
            if (!r?.ok) {
              if (retries >= VALIDATION_RETRIES) {
                scheduleAggRetry(dbHandle, { sessionId, startSeq: g.startSeq, endSeq: g.endSeq, reason: 'llm-error', now, journal })
                break
              }
              retries++
              journal('aggregate-retry', {
                sessionId, startSeq: g.startSeq, endSeq: g.endSeq,
                attempt: retries, reasons: ['llm-error'],
                previous: { error: String(r?.error ?? 'unknown') },
              })
              prompt = `${basePrompt}\n\n【上一次没有返回可用结果】${String(r?.error ?? 'unknown')}\n请只输出 JSON。`
              continue
            }
            const data = parseJsonLoose(r.text)
            const episodes = Array.isArray(data?.episodes) ? data.episodes : null
            // 合法 JSON 但明确返回空 episodes：模型认为该段没有值得记的事。
            // 这不是“解析失败”，不应重试 2 次浪费调用；保留机械字段并记 reason。
            if (episodes && episodes.length === 0) {
              const skipKey = `aggSkipped:${sessionId}:${g.startSeq}:${g.endSeq}`
              try { dbHandle.setMeta?.(skipKey, 'no-episodes') } catch { /* noop */ }
              clearAggRetry(dbHandle, retryKey)
              journal('aggregate-no-episodes', {
                sessionId, startSeq: g.startSeq, endSeq: g.endSeq,
                attempts: retries + 1,
                output: { textLen: String(r.text ?? '').length },
              })
              break
            }
            const e0 = episodes?.[0]
            if (!e0) {
              if (retries >= VALIDATION_RETRIES) {
                scheduleAggRetry(dbHandle, { sessionId, startSeq: g.startSeq, endSeq: g.endSeq, reason: 'json-parse', now, journal })
                break
              }
              retries++
              journal('aggregate-retry', {
                sessionId, startSeq: g.startSeq, endSeq: g.endSeq,
                attempt: retries, reasons: ['json-parse'],
                previous: { textLen: String(r.text ?? '').length },
              })
              prompt = `${basePrompt}\n\n【上一次没有返回可解析 JSON】请只输出 JSON，不要解释。`
              continue
            }
            const v = validateAgg(e0, groupText)
            if (v.ok) {
              const labels = normalizeAggLabel(e0.kind, e0.first, {
                sessionId, startSeq: g.startSeq, endSeq: g.endSeq, journal,
              })
              fields = { title: v.title, summary: v.summary, cues: v.cues, quote: v.quote, ...labels, source: 'llm' }
              clearAggRetry(dbHandle, retryKey)
              break
            }
            if (retries >= VALIDATION_RETRIES) {
              scheduleAggRetry(dbHandle, {
                sessionId, startSeq: g.startSeq, endSeq: g.endSeq,
                reason: `validation:${v.reasons.join(',')}`, now, journal,
              })
              break
            }
            retries++
            journal('aggregate-retry', {
              sessionId, startSeq: g.startSeq, endSeq: g.endSeq,
              attempt: retries, reasons: v.reasons,
              previous: { title: v.title, summary: v.summary, cues: v.cues },
            })
            prompt = buildRetryPrompt(basePrompt, e0, v)
          }
        } catch (error) {
          // 超时不能降级成 fallback：否则初建队列会在这个会话上无限拖，必须让上层标 failed 后跳过。
          if (error?.timedOut) throw error
          /* 其它失败降级 */
        }
        if (fields) { try { dbHandle.putAggregate(sessionId, g.startSeq, g.endSeq, fields) } catch { /* noop */ } }
      }
    }
    // 3) 确定性路径降级
    if (!fields) {
      const mt = makeTitle(g.body)
      fields = {
        title: g.title || mt?.title || firstSentence(g.summary || g.body),
        summary: g.summary || firstSentence(g.body),
        cues: String(g.cues ?? '').split(/\s+/).filter(Boolean),
        quote: g.quote || '',
        kind: 'daily',
        first: 0,
        source: 'fallback',
      }
    }
    out.push({
      ...g,
      title: fields.title,
      summary: fields.summary,
      cues: fields.cues.join(' '),
      quote: fields.quote || '',
      kind: fields.kind ?? null,
      first: fields.first ? 1 : 0,
    })
  }
  dbHandle.indexEpisodes(sessionId, out)
  out.batchExhausted = batchExhausted
  out.attemptedSegments = attemptedSegments
  out.llmCalls = llmCalls
  return out
}
