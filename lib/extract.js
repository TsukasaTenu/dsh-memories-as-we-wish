// P1 抽取：增量（episodes）+ 场景（episodes + facts 8 类 + profile + entities）
import { insertEpisode, runGates, upsertFact, setProfile, upsertEntity, linkAlias, grounding } from './store.js'
import { isMetaTalk, isMetaEpisode, isAtomicFact, hasExplicitSource } from './filters.js'

export const FACT_CATEGORIES = ['identity', 'preference', 'interest', 'personality', 'relationship', 'experience', 'goal', 'guideline']

export function renderConversation(messages, maxChars = 12000) {
  let out = ''
  for (const m of messages) {
    const who = m.role === 'user' ? '对方' : '我'
    const line = `[${m.seq}] ${who}：${String(m.text).replace(/\s+/g, ' ').slice(0, 600)}\n`
    if (out.length + line.length > maxChars) break
    out += line
  }
  return out
}

const META_RULE = `**不要抽"在讨论系统本身"的内容**：关于记忆/检索/插件/提示词/上下文/
注入规则/抽取方案/facts 设计这类元对话，既不是 episode 也不是 fact，直接跳过。
（"他说记得我说的话"这种日常不算元对话，照常记。）`

const INCREMENTAL_RULES = `${META_RULE}

你在替"我"整理这次对话里值得记住的事。

输出 1–2 条 episode：
- title：一句话标题
- summary：第一人称，1–3 句，写清发生了什么（我听到/说了什么、当时怎么想）
- cues：这条记忆的检索线索（2–5 个短词：人、物、时间、动作）
- quote：原话（必须逐字来自对话原文，可以空）
- kind：这条记忆的类型，只能是 fact / promise / feeling / turn / care / daily / decision / task / meta 之一：
  - fact：只收关于对方、我、我们的关系与生活、且长期成立的信息（对方是谁、养过什么、家里/住哪/做什么/身体、偏好习惯、我在意的事、我们确定的身份关系）。游戏/动画作品的设定与考据、技术结论与报错原因、任务结果与进度、系统状态，一律不算 fact，归 task 或 meta；拿不准按低一档。
  - 约定 vs 决定：对象是「我们」还是「事情」——「以后每周留一天给我」是约定，「先做 B 再做 A」是决定。
  - 经历 vs 日常：一起经历过、有情绪重量的才是经历；只是寒暄、晚安、问一句答一句是日常。
  - 转折 vs 经历：有没有张力（争、误会、沉默、离开）；有就是转折，哪怕结局是好的。
  - 照顾 vs 日常：是不是在关心对方的状态（病、熬夜、吃饭、情绪低）；是就是照顾。
  - 元 vs 事务：讨论对象是「记忆/工具/我自己」还是「项目」。
  - 分量：只是问一句、答一句、没有展开 → daily 或 meta；真谈开了、有来回、有改变 → promise / feeling / turn。
  - 拿不准取低的那一个。
- first：true 仅表示真正的第一次（第一次被那样叫、第一次一起看星星），不标「第一次做某个技术活」。

只输出 JSON：
{"episodes":[{"title":"","summary":"","cues":[""],"quote":"","start_seq":1,"end_seq":2,"source_seqs":[1,2],"kind":"daily","first":false}]}`

const SCENE_RULES = `${META_RULE}

你在替"我"做一次场景结算。根据对话整理长期记忆。

输出：
1. episodes：0–3 条，规则同增量结算（第一人称 summary + 逐字 quote + 真实 seq）
2. facts：0–5 条，8 类之一：
   identity（身份）/ preference（偏好）/ interest（兴趣）/ personality（性格）/
   relationship（关系）/ experience（经历）/ goal（目标）/ guideline（约定/规矩）
   每条：subject（通常是"对方"）、category、attribute（如 calls_me / likes_food）、
   value（**单一断言，≤40 字，不许"X 和 Y"这种复合；只写确凿的一句话**）、
   quote（**必须填：对方明确说过它的那句原话，逐字，来自下面原文**）、
   cardinality（single 或 multi）、source_seq
   找不到原话支撑的，就不要输出这条 fact。
3. profile：0–3 条整体印象（不是事实，是判断）：{"key":"对方怎么想事情","value":"先怀疑再接受"}
4. entities：出现的人/物/作品：{"name":"","kind":"person|thing|work","aliases":[]}

只输出 JSON：
{"episodes":[...],"facts":[...],"profile":[...],"entities":[...]}`

function parseJsonLoose(text) {
  if (!text) return null
  const cleaned = String(text).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  try { return JSON.parse(cleaned) } catch { /* next */ }
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)) } catch { return null } } }
  }
  return null
}

const LLM_TIMEOUT_CODE = 'LLM_TIMEOUT'
export const DEFAULT_LLM_TIMEOUT_MS = 90_000

export async function callExtract(llm, { prompt, maxTokens = 4000, model, provider, timeoutMs = DEFAULT_LLM_TIMEOUT_MS } = {}) {
  let text = ''
  let failure
  let finishReason = null
  let usage = null
  let iterator
  let timer
  let timedOut = false
  const controller = new AbortController()
  // 单次调用总超时；不依赖 LLM stream 自己是否支持 signal，超时后主动放弃等待。
  const timeout = new Promise((_, reject) => {
    if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) return
    timer = setTimeout(() => {
      timedOut = true
      const error = new Error(`llm timeout after ${timeoutMs}ms`)
      error.code = LLM_TIMEOUT_CODE
      try { controller.abort(error) } catch { /* noop */ }
      reject(error)
    }, timeoutMs)
  })
  try {
    const stream = llm.stream({
      provider: provider ?? 'deepseek-account', model: model ?? 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens,
      signal: controller.signal,
    })
    iterator = stream[Symbol.asyncIterator]()
    while (true) {
      const step = timer ? await Promise.race([iterator.next(), timeout]) : await iterator.next()
      if (step.done) break
      const chunk = step.value
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'usage') usage = chunk.usage ?? chunk
      else if (chunk?.type === 'finish') {
        finishReason = chunk.reason?.kind ?? chunk.reason ?? null
        if (chunk.usage) usage = chunk.usage
        if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: timedOut ? `timeout:${timeoutMs}ms` : String(error?.message ?? error),
      text,
      timedOut,
      finishReason,
      usage,
    }
  } finally {
    if (timer) clearTimeout(timer)
    // 不 await：挂起的请求可能永远不会结束；释放引用即可，吞掉 return 的拒绝。
    try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* noop */ }
  }
  if (failure) return { ok: false, error: `${failure.code}: ${failure.message}`, text, timedOut: false, finishReason, usage }
  return { ok: true, text, timedOut: false, finishReason, usage }
}

/** 空响应重试一次（P6 教训：reasoning 会吃满预算）；超时不再重试，直接让上层隔离失败。 */
export async function callExtractWithRetry(llm, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const first = await callExtract(llm, { ...opts, timeoutMs })
  if (first.ok && first.text.trim()) return first
  if (first.timedOut) return first
  return callExtract(llm, {
    ...opts,
    timeoutMs,
    prompt: opts.prompt + '\n（直接输出 JSON，不要思考过程）',
    maxTokens: Math.max(opts.maxTokens ?? 4000, 6000),
  })
}

export function applyEpisode(db, ep, { sessionId, from, to, journal = () => {} }) {
  // 元对话过滤（episodes 也要）：讨论记忆/检索/插件/系统本身的，不进库
  if (isMetaEpisode(ep)) {
    journal('episode-rejected', { reasons: ['meta-talk'], title: ep.title, summary: String(ep.summary ?? '').slice(0, 80) })
    return { accepted: false, gates: { ok: false, reasons: ['meta-talk'] } }
  }
  const gates = runGates(db, {
    summary: ep.summary ?? ep.title ?? '',
    quote: ep.quote ?? '',
    source_seqs: ep.source_seqs ?? [ep.start_seq, ep.end_seq],
  }, [from, to])
  if (!gates.ok) { journal('episode-rejected', { reasons: gates.reasons, title: ep.title }); return { accepted: false, gates } }
  const id = insertEpisode(db, {
    sessionId,
    startSeq: Number(ep.start_seq ?? from),
    endSeq: Number(ep.end_seq ?? to),
    title: ep.title ?? '',
    summary: ep.summary ?? '',
    cues: Array.isArray(ep.cues) ? ep.cues.map(String) : [],
    quoteSeq: ep.quote ? Number(ep.start_seq ?? from) : null,
    quoteText: ep.quote ?? '',
    verified: { gates: gates.reasons, grounding: gates.grounding, at: Date.now() },
  })
  journal('episode-accepted', { id, title: ep.title, grounding: gates.grounding })
  return { accepted: true, id, gates }
}

/** 场景结算应用：episodes + facts（冲突四态）+ profile + entities。 */
export function applyScene(db, data, { sessionId, from, to, journal = () => {}, now = Date.now() }) {
  const out = { episodes: 0, episodesRejected: 0, facts: 0, factsRejected: 0, conflicts: 0, profile: 0, entities: 0 }
  for (const ep of data?.episodes ?? []) {
    const r = applyEpisode(db, ep, { sessionId, from, to, journal })
    if (r.accepted) out.episodes++
    else out.episodesRejected++
  }
  for (const f of data?.facts ?? []) {
    const category = FACT_CATEGORIES.includes(String(f?.category)) ? String(f.category) : 'experience'
    if (!/^[a-z_]{2,40}$/i.test(category) || !String(f?.value ?? '').trim()) continue
    const value = String(f.value).trim()
    const quote = String(f.quote ?? '').trim()
    const rows = db.prepare('SELECT text FROM messages WHERE seq BETWEEN ? AND ?').all(from, to)
    const windowText = rows.map(r => String(r.text)).join('\n')

    // ① 元对话：讨论记忆/检索/插件/系统本身的，拒收（看讨论对象，不关键词一刀切）
    if (isMetaTalk(value) || isMetaTalk(quote) || isMetaTalk(String(f.attribute ?? ''))) {
      journal('fact-rejected', { reasons: ['meta-talk'], fact: f }); out.factsRejected++; continue
    }
    // ② 原子性：单一断言、≤40 字、不许 X 和 Y 复合
    const atomic = isAtomicFact(value)
    if (!atomic.ok) { journal('fact-rejected', { reasons: [atomic.reason], fact: f }); out.factsRejected++; continue }
    // ③ 弱事实：必须指出明确说过它的那句原话（逐字 + 与 value 相关）
    const src = hasExplicitSource(value, quote, windowText, grounding)
    if (!src.ok) { journal('fact-rejected', { reasons: [src.reason], fact: f }); out.factsRejected++; continue }

    if (f.source_seq != null) {
      const gates = runGates(db, { summary: value, quote, source_seqs: [Number(f.source_seq)] }, [from, to])
      if (!gates.ok) { journal('fact-rejected', { reasons: gates.reasons, fact: f }); out.factsRejected++; continue }
    }
    const r = upsertFact(db, {
      subject: String(f.subject ?? '对方'), category,
      attribute: String(f.attribute ?? ''), value,
      cardinality: f.cardinality === 'multi' ? 'multi' : 'single',
      sourceSeq: f.source_seq ?? null,
      quoteText: quote,
    }, { now, journal })
    if (r.action === 'CONFLICT') out.conflicts++
    out.facts++
  }
  for (const p of data?.profile ?? []) {
    if (!p?.key || !p?.value) continue
    setProfile(db, String(p.key), String(p.value), now)
    out.profile++
  }
  for (const e of data?.entities ?? []) {
    if (!e?.name) continue
    const id = upsertEntity(db, String(e.name), String(e.kind ?? ''))
    if (id) { for (const a of e.aliases ?? []) if (a) linkAlias(db, String(a), id); out.entities++ }
  }
  journal('scene-applied', out)
  return out
}

export function buildIncrementalPrompt(messages) {
  return `${INCREMENTAL_RULES}

对话片段（[seq] 角色：内容）：
${renderConversation(messages)}`
}

export function buildScenePrompt(messages, { profile = [] } = {}) {
  return `${SCENE_RULES}

当前画像（可更新）：
${profile.map(p => `- ${p.key}：${p.value}`).join('\n') || '（暂无）'}

对话片段（[seq] 角色：内容）：
${renderConversation(messages, 14000)}`
}

export { parseJsonLoose }
