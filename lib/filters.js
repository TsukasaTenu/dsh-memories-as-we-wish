// facts / episodes 质量过滤：元对话 + 原子性 + 弱事实
//
// 判据来源：规格 §7（跳过元对话）+ task-17（原子性 / 弱事实）。

// 系统本身的名词（区别于"他记得我说的话"这种正常对话）
const SYSTEM_NOUNS = [
  '记忆注入', '记忆系统', '记忆插件', '记忆块', '记忆库', '记忆检索', '检索结果', '检索规则',
  '触发式注入', '注入规则', '注入块', '注入', '提示词', '上下文窗口', '上下文管理', '上下文长度',
  'episodes', 'facts', 'profile', '装配器', '装配', '文献馆', '防编', '四道闸', 'fold', '压缩策略',
  '召回池', '弱线索', '去重', '冷却', '候选', '抽取',
]
const SYSTEM_ACTION = /(规则|机制|方案|设计|实现|策略|架构|阈值|打分|门控|抽取|装配|注入|检索|过滤|差集|窗口|候选|召回|token)/

// 测试/元对话用语（出现在原文里，配合系统名词判断）
const TEST_PHRASES = ['测试一下', '这个功能', '我们测试', '试一下这个', '这样设计', '应该这样']

/** 是否在讨论系统本身（元对话）。关键：对象是系统，而不是"他记得"这种日常。 */
export function isMetaTalk(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  // 主语/对象是系统本身（强名词命中即拒收；"记忆"单独出现不算）
  if (SYSTEM_NOUNS.some(n => s.includes(n) && n !== '候选')) return true
  // "记忆/检索/插件/上下文" + 系统动作词（如"记忆怎么注入"）
  if (/记忆|检索|插件|上下文|prompt/i.test(s) && SYSTEM_ACTION.test(s) && /怎么|如何|要不要|应该|需要|规则|机制/.test(s)) return true
  // 测试用语 + 系统/功能词
  if (TEST_PHRASES.some(p => s.includes(p)) && /功能|记忆|检索|系统|插件/.test(s)) return true
  return false
}

// 复合连接词：出现即视为"X 和 Y"式复合断言（原子性不满足）
const COMPOUND = /[和与]|以及|还有|、/
const CLAUSE = /[，,；;]/

/**
 * 事实原子性：单一断言，≤40 字，不含"和/与/以及/还有/、"式复合，也不含逗号分句。
 * @returns {{ok:boolean, reason?:string}}
 */
export function isAtomicFact(value) {
  const v = String(value ?? '').trim()
  if (!v) return { ok: false, reason: 'empty-value' }
  if ([...v].length > 40) return { ok: false, reason: `too-long:${[...v].length}` }
  if (COMPOUND.test(v)) return { ok: false, reason: 'compound-connector' }
  if (CLAUSE.test(v)) return { ok: false, reason: 'multiple-clauses' }
  return { ok: true }
}

/**
 * 弱事实拒收：必须能指出明确说过它的那句原话（quote 必须在窗口原文里逐字出现，
 * 且原话与 value 相关：value 是 quote 子串，或 value 的 bigram 覆盖率 ≥0.6）。
 * @param {string} value
 * @param {string} quote 该事实对应的原话（模型给的）
 * @param {string} windowText 结算窗口原文
 * @param {(value:string, source:string)=>number} grounding
 */
export function hasExplicitSource(value, quote, windowText, grounding) {
  const q = String(quote ?? '').trim()
  const v = String(value ?? '').trim()
  if (!q) return { ok: false, reason: 'no-quote' }
  if (!String(windowText ?? '').includes(q)) return { ok: false, reason: 'quote-not-verbatim' }
  const related = q.includes(v) || grounding(v, q) >= 0.4
  if (!related) return { ok: false, reason: `quote-not-about-value:${grounding(v, q).toFixed(2)}` }
  return { ok: true }
}

/** episodes 的元对话过滤（summary/title 任一命中即拒）。 */
export function isMetaEpisode(ep) {
  const text = `${ep?.title ?? ''}\n${ep?.summary ?? ''}`
  return isMetaTalk(text)
}
