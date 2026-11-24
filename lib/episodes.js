// episodes：低密度聚合 + 标题（展示层）校验
//
// 规格 §1.1：检索单位 = episode（body + quote），messages 只做证据。
// 低密度（700 条/天）：时间切分（30min 软 / 3h 硬），短互动并到时段里；每天约 20–40 个 episode。

export const SHORT_FILLERS = [
  '好耶', '继续', '再来一把', '嗯', '嗯嗯', '好', '好的', '哈哈', '哈哈哈', '666', '可以', '行',
  '收到', '谢谢', '好呀', '牛的', '厉害', '不错', '笑死', '对', '对对', '是的', '冲', '上号',
]

const SHORT_MAX_CHARS = 20
const SOFT_GAP_MS = 30 * 60 * 1000
const HARD_GAP_MS = 3 * 60 * 60 * 1000
const MAX_BODY_CHARS = 200

const cjkLen = (s) => [...String(s ?? '')].length

// ---------- 检索键字段（task-23：FTS 索引 title + summary + cues + entities + time，正文只做 payload）----------
// 默认不内置任何实体词；由配置 cfg.entities 提供（例如 DSH/MoBu/MotionBuilder/FBX 等技术词）。
export const DEFAULT_ENTITIES = []
export const KNOWN_ENTITIES = DEFAULT_ENTITIES
const TIME_WORDS = ['今天', '昨天', '前天', '上周', '上个月', '去年', '之前', '刚才', '早上', '晚上', '下午', '周末', '中秋', '国庆', '生日']
const STOPCH = /[的了是我你他她它这那在有就都也太很个把被让给对从到与和及]/

export function enrichEpisode(ep, { entities = DEFAULT_ENTITIES } = {}) {
  const body = String(ep.body ?? '')
  const firstTwo = body.split(/(?<=[。；;！!？?])/).map(s => s.trim()).filter(Boolean).slice(0, 2).join('')
  const summary = (firstTwo || body).slice(0, 160)
  const ents = new Set()
  for (const e of entities) if (e && body.includes(e)) ents.add(e)
  for (const m of body.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) ents.add(m[0])
  const cues = new Set()
  for (const e of ents) cues.add(e)
  for (const w of TIME_WORDS) if (body.includes(w)) cues.add(w)
  const freq = new Map()
  for (let i = 0; i + 2 <= body.length; i++) {
    const g = body.slice(i, i + 2)
    if (!/[\u4e00-\u9fa5]{2}/.test(g)) continue
    if (STOPCH.test(g[0]) || STOPCH.test(g[1])) continue
    freq.set(g, (freq.get(g) ?? 0) + 1)
  }
  for (const [g] of [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) cues.add(g)
  const timeTokens = ep.startAt ? new Date(Number(ep.startAt)).toISOString().slice(0, 10).replace(/-/g, ' ') : ''
  return { ...ep, summary, entities: [...ents].join(' '), cues: [...cues].join(' '), timeTokens }
}

export function isShortInteraction(text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (cjkLen(t) < SHORT_MAX_CHARS) return true
  if (SHORT_FILLERS.includes(t)) return true
  if (/^[好嗯哈6笑对是冲上收谢牛厉不]{1,6}[！!。~～]*$/.test(t)) return true
  return false
}

/** 有价值的文本：非短互动，且包含具体信息（动作/知识/偏好/约定）。 */
export function isValuable(text) {
  return !isShortInteraction(text) && cjkLen(String(text)) >= SHORT_MAX_CHARS
}

/**
 * 把 messages 聚合成 episodes。
 * @param {Array<{seq,role,time,text}>} messages
 * @param {{softGapMs?:number, hardGapMs?:number, maxBodyChars?:number, entities?:string[]}} opts
 */
export function buildEpisodes(messages, opts = {}) {
  const softGap = opts.softGapMs ?? SOFT_GAP_MS
  const hardGap = opts.hardGapMs ?? HARD_GAP_MS
  const maxBody = opts.maxBodyChars ?? MAX_BODY_CHARS
  const entities = Array.isArray(opts.entities) ? opts.entities : DEFAULT_ENTITIES
  const sorted = [...messages].filter(m => String(m.text ?? '').trim()).sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.seq - b.seq)
  const episodes = []
  let bucket = null
  const flush = () => {
    if (!bucket) return
    const valuable = bucket.items.filter(it => isValuable(it.text))
    if (!valuable.length) {
      // 纯短互动时段：合成一个"时段"episode。内部话术绝不进记忆——
      // 只放中性内容（"那几句寒暄" + 真实短句），不写条数/“没有需要记住的信息”。
      const startAt = bucket.items[0].time, endAt = bucket.items[bucket.items.length - 1].time
      const first = bucket.items[0].seq, last = bucket.items[bucket.items.length - 1].seq
      const snippets = []
      for (const it of bucket.items) {
        const t = String(it.text).replace(/\s+/g, ' ').trim()
        if (!t || snippets.includes(t)) continue
        snippets.push(t)
        if (cjkLen(snippets.join('／')) >= 40) break
      }
      episodes.push(enrichEpisode({
        startSeq: first, endSeq: last, startAt, endAt,
        body: `那几句寒暄：${snippets.join('／').slice(0, 40)}`,
        quote: '', quoteSeq: null, valuable: false,
      }, { entities }))
    } else {
      // 正文：把有价值的内容拼起来（去重、截断）
      const bodies = []
      let used = 0
      for (const it of valuable) {
        const t = String(it.text).replace(/\s+/g, ' ').trim()
        if (bodies.some(b => b.includes(t))) continue
        if (used + cjkLen(t) > maxBody) {
          // 单条就很长：截断放进去，别让 body 空掉（空 body 会检索不到）
          if (!bodies.length) { bodies.push(t.slice(0, maxBody)); used = maxBody }
          break
        }
        bodies.push(t); used += cjkLen(t)
      }
      const first = bucket.items[0].seq, last = bucket.items[bucket.items.length - 1].seq
      const startAt = bucket.items[0].time, endAt = bucket.items[bucket.items.length - 1].time
      const quoteItem = [...valuable].sort((a, b) => cjkLen(b.text) - cjkLen(a.text))[0]
      episodes.push(enrichEpisode({
        startSeq: first, endSeq: last, startAt, endAt,
        body: bodies.join('；').slice(0, maxBody),
        quote: String(quoteItem.text).replace(/\s+/g, ' ').trim().slice(0, 120),
        quoteSeq: quoteItem.seq, valuable: true,
      }, { entities }))
    }
    bucket = null
  }
  const maxItems = opts.maxItems ?? 6
  for (const m of sorted) {
    if (!bucket) { bucket = { items: [m] }; continue }
    const gap = (m.time ?? 0) - (bucket.items[bucket.items.length - 1].time ?? 0)
    const hasValuable = bucket.items.some(it => isValuable(it.text))
    const tooMany = bucket.items.length >= maxItems && bucket.items.some(it => isValuable(it.text))
    if (gap >= hardGap || tooMany || (gap >= softGap && (hasValuable || bucket.items.length >= 3))) flush()
    if (!bucket) bucket = { items: [m] }
    else bucket.items.push(m)
  }
  flush()
  return episodes
}

// ---------- 标题（展示层，不参与检索）----------
const JUDGMENT_WORDS = ['习惯', '总是', '从来不', '一定', '从来都', '永远', '每次都']

const grams = (s) => {
  const t = String(s ?? '')
  const out = new Set()
  for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/**
 * 标题校验（规格 §1.2）：
 *  1. 标题关键词能在正文找到（bigram 覆盖率 ≥ 0.5）
 *  2. 不含正文没有的判断词
 *  3. 长度 10–30 字
 */
export function validateTitle(title, body, { minChars = 10, maxChars = 30 } = {}) {
  const t = String(title ?? '').trim()
  const b = String(body ?? '')
  const reasons = []
  const len = cjkLen(t)
  if (len < minChars || len > maxChars) reasons.push(`length:${len}`)
  const tg = grams(t)
  let hit = 0
  for (const g of tg) if (b.includes(g)) hit++
  const coverage = tg.size ? hit / tg.size : 0
  if (coverage < 0.65) reasons.push(`keywords-not-in-body:${coverage.toFixed(2)}`)
  for (const w of JUDGMENT_WORDS) if (t.includes(w) && !b.includes(w)) { reasons.push(`judgment:${w}`); break }
  return { ok: reasons.length === 0, reasons, coverage: Number(coverage.toFixed(2)) }
}

/** 生成候选标题（展示用），校验不过返回 null。 */
export function makeTitle(body, { minChars = 10, maxChars = 30 } = {}) {
  const b = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (!b) return null
  const first = b.split(/[。；;！!？?]/).map(s => s.trim()).filter(Boolean)[0] ?? b
  let title = [...first].slice(0, maxChars).join('').replace(/[，,、：:]+$/, '')
  if (cjkLen(title) < minChars) title = [...b].slice(0, Math.min(maxChars, minChars)).join('')
  const v = validateTitle(title, b, { minChars, maxChars })
  return v.ok ? { title, validation: v } : { title: null, validation: v }
}
