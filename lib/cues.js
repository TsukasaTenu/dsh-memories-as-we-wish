// 触发线索：实体别名 / 时间词 / 引语 / 记忆动词 → 打分与门控
export const TIME_WORDS = [
  '去年冬天', '去年夏天', '去年春天', '去年秋天', '去年', '前年', '上回', '上次', '那天', '当时',
  '那时候', '小时候', '以前', '之前', '昨天', '前天', '前两天', '前阵子', '刚才', '国庆', '中秋',
  '生日', '周末', '那年', '那会儿', '几点', '早上', '晚上', '下午',
]
export const MEMORY_VERBS = [
  '记得', '还记得', '记不记得', '说过', '告诉过', '提过', '讲过', '答应', '承诺', '想起',
  '忘了', '忘记', '上次说', '以前说', '那天说', '你说的', '我说过', '来着',
]
const QUOTE_RE = [/「([^」]{1,120})」/g, /『([^』]{1,120})』/g, /“([^”]{1,120})”/g, /"([^"]{1,120})"/g, /'([^']{1,120})'/g]

export function tokenizeCues(text) {
  return text
}

/** 解析一句话里的过去线索。 */
export function parseCues(text, { entities = [] } = {}) {
  const s = String(text ?? '')
  const hits = { entities: [], times: [], verbs: [], quotes: [] }
  for (const e of entities) if (e && s.includes(e)) hits.entities.push(e)
  for (const w of TIME_WORDS) if (s.includes(w)) hits.times.push(w)
  for (const w of MEMORY_VERBS) if (s.includes(w)) hits.verbs.push(w)
  for (const re of QUOTE_RE) {
    for (const m of s.matchAll(re)) if (m[1]?.trim()) hits.quotes.push(m[1].trim())
  }
  const count = hits.entities.length + hits.times.length + hits.verbs.length + hits.quotes.length
  const strong = count > 0
  return { ...hits, count, strong }
}

/**
 * 打分（规格 §3.2）：0.45·相关 + 0.20·实体 + 0.15·时间 + 0.10·引语 + 0.10·强度
 * @param {object} cues  parseCues 结果
 * @param {Array} results 检索结果（按相关度排序）
 * @param {object} extras { now, hasTimeWindow }
 */
export function scoreResults(cues, results, { entityHit = false, timeHit = false, quoteHit = false } = {}) {
  const top = results[0]
  const rel = top ? 1 : 0
  const strength = Math.min(1, cues.count / 2)
  const score = 0.45 * rel
    + 0.20 * (entityHit ? 1 : 0)
    + 0.15 * (timeHit ? 1 : 0)
    + 0.10 * (quoteHit ? 1 : 0)
    + 0.10 * strength
  return { score: Number(score.toFixed(4)), rel, strength }
}

export function gate(cues, score, threshold = 0.55) {
  return cues.strong && score >= threshold
}

// 询问过去的意图（比关键词更接近"真的在问过去"）：
//   - 你还记得…吗 / 记得…什么
//   - 刚才/上次/之前/当时/那次 + 疑问/解释
export const ASK_PAST_RE = /(还记得|记不记得|记得[^。]{0,20}[吗？?]|来着|(上次|之前|刚才|刚刚|当时|那次|那时候|几点|周末|昨天|前天)[\s\S]{0,120}([？?]|吗|什么|怎么|哪里|多少|是否|解释|说说|讲一下))/
export function asksAboutPast(text) {
  const s = String(text ?? '')
  // 以指令开头的消息不是回忆请求（V015 类："先写规格。然后……"）
  if (/^(先写|先做|先备份|开工|开始做|写规格|排一份|写一份)/.test(s.trim())) return false
  if (!ASK_PAST_RE.test(s)) return false
  // 指令句里的时间词不算"在问过去"（"按清单执行/先备份/继续做"），除非同时带回忆/解释词
  const INSTRUCTION = /(按照|执行|排一份|任务清单|清单|帮我|先备份|接下来|添加一条|继续做)/
  if (INSTRUCTION.test(s) && !/(解释|知道|记得|回忆|想起)/.test(s)) return false
  return true
}
