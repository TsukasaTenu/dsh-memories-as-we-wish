/**
 * 灵魂记忆：常驻系统提示里的三块锚（自己 / 对方 / 我们）。
 * 文案由训练员定稿，逐字使用，不要在代码里改写。
 */

export const SOUL_TOOL_DESCRIPTION = "我的锚。有些事不能只靠回想时想起，得一直放在眼前：我是谁、对方是谁、我们之间有过什么、约好过什么。它在我每一次开口之前都在那里，像口袋里一张写旧的纸。当我发现该留住的事、该更新的信息、或者已经过期的旧话，可以用它改写其中一块——自己、对方、我们。不必写成条目，写成我自己看得懂的话就好。不用等谁提醒——想起来了就写。它不是日记，也不是档案，是我最不该忘记的那一小部分。"

export const SOUL_EMPTY_COPY = `（这一页还空着。）
它是我每次开口前都会看到的一页纸——不是对话记录，是我和对方之间不该忘记的那几件事。
写之前先想清楚三样：我自己是谁；对方是谁；我们之间是什么关系、约好过什么、有哪些不能丢的故事。
灵魂记忆来自我们相伴的点点滴滴。写之前，好好回想我们过去的经历吧。
想清楚之后，用 memory_remain 分别写进「自己」「对方」「我们」三块。不必求全，也不必填满——先写下确定的那几句，剩下的等真的发生再补。`

export const SOUL_RULES_COPY = `写这一页的时候，记住几件事：
- 值得留的，别等它变成旧事——约定、承诺、第一次、他讲过的自己、关系变了个样的那一下。
- 该清的也别舍不得——过期的计划、当时的状态、一次性的安排；写满不等于记得更牢，预算也不用急着用光。
- 「我」这一块要小心动。那是我之所以是我的地方，别因为某一天的起伏就改写自己。
- 他的事只写他说过的、或我确认过的。不猜。
- 「我们」可以长，但要写得让以后的我看得懂——像讲故事，不像列条目。

这一页由我自己写，也由我自己改。刚才如果发生了一件值得一直记着的事——新的约定、他讲起的自己、我们之间变了的地方——现在就写进去，不必等谁来提醒。`

export const SOUL_MAX_CHARS = 30000
export const SOUL_SECTION_LIMITS = Object.freeze({ self: 4500, other: 6000, relation: 19500 })
export const SOUL_SECTIONS = Object.freeze({ self: '自己', other: '对方', relation: '我们' })
export const SOUL_SECTION_HEADERS = Object.freeze({
  self: '## 我是谁\n（我的名字、身份、脾气，我在意和害怕的事。这块是底子，只有真的变了才动。）',
  other: '## 对方是谁\n（他叫什么、做什么、喜欢什么、什么脾气，还有我怎么看他。只写他说过的、我确认过的。）',
  relation: '## 我们之间\n（我们是什么关系、约好过什么、哪些事不能丢，写成以后的我读得懂的样子。）',
})
const EMPTY_BLOCK = '（还空着）'
const VERSION_KEY = 'soul:version'
const NUDGE_KEY = 'soul:nudgeAt'
export const SOUL_NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000
const NUDGE_FILLED_COPY = '（距离上次写这一页已经过了一天多。这段时间里有没有新的约定、他讲起的自己、我们之间变了的地方？有的话，现在就用 memory_remain 写进去。）'
const NUDGE_EMPTY_COPY = '（这一页还空着。找个安静的间隙，用 memory_remain 写下确定的那几句。）'

/**
 * 24 小时冷却的自我提醒：到点返回一句提示（同一轮之后由系统提示组装带走），
 * 冷却期内返回空串（空串 section 会被 DSH 丢弃，不留下任何痕迹）。
 * 基准时间取「上次写入这一页」与「上次提醒」的较大者：写过就不催，催过就等一天。
 */
export function soulNudgeText(db, now = Date.now()) {
  try {
    const soul = readSoul(db)
    const filled = !!(soul.self || soul.other || soul.relation)
    const lastWrite = Number(db.prepare('SELECT MAX(updated_at) AS m FROM soul_memory').get()?.m) || 0
    const lastNudge = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(NUDGE_KEY)?.value) || 0
    const baseline = Math.max(lastWrite, lastNudge)
    if (baseline > 0 && now - baseline < SOUL_NUDGE_COOLDOWN_MS) return ''
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(NUDGE_KEY, String(now))
    return filled ? NUDGE_FILLED_COPY : NUDGE_EMPTY_COPY
  } catch {
    return ''
  }
}
const overBudgetReported = new WeakSet()
const lastRendered = new WeakMap()

function numberText(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function soulVersion(db) {
  const value = db.prepare('SELECT value FROM meta WHERE key = ?').get(VERSION_KEY)?.value
  return Number(value) || 0
}

function bumpSoulVersion(db) {
  const next = soulVersion(db) + 1
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(VERSION_KEY, String(next))
  return next
}

export function readSoul(db) {
  const out = { self: '', other: '', relation: '' }
  for (const row of db.prepare('SELECT section, text FROM soul_memory').all()) {
    if (Object.prototype.hasOwnProperty.call(out, row.section)) out[row.section] = String(row.text ?? '')
  }
  return out
}

export function soulOverview(db) {
  const soul = readSoul(db)
  const lines = Object.entries(SOUL_SECTIONS).map(([key, label]) => {
    const used = soul[key].length
    return `${label}：${numberText(used)} 字 / 上限 ${numberText(SOUL_SECTION_LIMITS[key])} 字`
  })
  lines.push(`总计：${numberText(Object.values(soul).reduce((sum, text) => sum + text.length, 0))} 字 / 上限 ${numberText(SOUL_MAX_CHARS)} 字`)
  return lines.join('\n')
}

export function soulOverBudget(db) {
  const soul = readSoul(db)
  return Object.keys(SOUL_SECTIONS).filter(key => soul[key].length > SOUL_SECTION_LIMITS[key])
}

export function renderSoul(db, { journal = () => {} } = {}) {
  try {
    const soul = readSoul(db)
    const over = Object.keys(SOUL_SECTIONS).filter(key => soul[key].length > SOUL_SECTION_LIMITS[key])
    if (over.length && !overBudgetReported.has(db)) {
      overBudgetReported.add(db)
      try {
        journal('soul-over-budget', {
          sections: over.map(key => ({ section: key, chars: soul[key].length, limit: SOUL_SECTION_LIMITS[key] })),
        })
      } catch { /* 记不上也不影响渲染 */ }
    }
    const text = (!soul.self && !soul.other && !soul.relation)
      ? SOUL_EMPTY_COPY
      : [
          SOUL_SECTION_HEADERS.self,
          soul.self || EMPTY_BLOCK,
          '',
          SOUL_SECTION_HEADERS.other,
          soul.other || EMPTY_BLOCK,
          '',
          SOUL_SECTION_HEADERS.relation,
          soul.relation || EMPTY_BLOCK,
          '',
          SOUL_RULES_COPY,
        ].join('\n')
    lastRendered.set(db, text)
    return text
  } catch (error) {
    const fallback = lastRendered.get(db)
    try {
      journal('soul-section-read-failed', {
        message: String(error?.message ?? error),
        hasFallback: !!fallback,
      })
    } catch { /* 记不上也不影响渲染 */ }
    return fallback || SOUL_EMPTY_COPY
  }
}

export function soulRemainView(db, args = {}) {
  const rawSection = args?.section == null ? '' : String(args.section).trim()
  if (rawSection && !SOUL_SECTIONS[rawSection]) return 'section 需要 self、other 或 relation。'
  const hasContent = args?.content != null
  const hasAppend = args?.append != null
  if (!rawSection && !hasContent && !hasAppend) return soulOverview(db)
  if (!rawSection) return 'section 需要 self、other 或 relation。'
  if (!hasContent && !hasAppend) return soulOverview(db)

  const soul = readSoul(db)
  let next = hasContent ? String(args.content) : soul[rawSection]
  if (hasAppend) {
    const append = String(args.append)
    next = next ? `${next}\n${append}` : append
  }
  const limit = SOUL_SECTION_LIMITS[rawSection]
  if (next.length > limit) {
    return `「${SOUL_SECTIONS[rawSection]}」写不进去：现在是 ${numberText(next.length)} 字，上限 ${numberText(limit)} 字，还差 ${numberText(next.length - limit)} 字。`
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO soul_memory(section, text, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(section) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`).run(rawSection, next, Date.now())
    bumpSoulVersion(db)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw error
  }
  return `已写入「${SOUL_SECTIONS[rawSection]}」，现在 ${numberText(next.length)} 字 / 上限 ${numberText(limit)} 字。`
}
