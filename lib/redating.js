import { labelWeight } from './labels.js'

const DEFAULT_LIMIT = 30
const MAX_LIMIT = 90
const MAX_MONTHS = 12
const redatingCache = new Map()

export function localDayKey(ms) {
  const d = new Date(Number(ms))
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dayNumber(day) {
  const [y, m, d] = String(day).split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000)
}

function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(dayNumber(String(value)))
}

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number)
  if (!y || m < 1 || m > 12) return null
  const last = new Date(y, m, 0).getDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` }
}

function titleWindow(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text.length <= 40) return text
  const cut = text.slice(0, 40)
  const match = [...cut.matchAll(/[。！？!?；;，,、]/g)].pop()
  if (match && match.index >= 10) return cut.slice(0, match.index).trim()
  return cut.trim()
}

/** 短促往来：消息数 ≤2 且正文 <200 字。这类片段即使标签是 promise，也不该挤掉真正展开的事。 */
const SHORT_EXCHANGE_MAX_MESSAGES = 2
const SHORT_EXCHANGE_MAX_BODY = 200
const SHORT_EXCHANGE_WEIGHT_CAP = 0.60

function effectiveWeight(row) {
  const weight = labelWeight(row.kind)
  const short = Number(row.msg_count ?? 0) <= SHORT_EXCHANGE_MAX_MESSAGES &&
    Number(row.body_len ?? 0) < SHORT_EXCHANGE_MAX_BODY
  return short ? Math.min(weight, SHORT_EXCHANGE_WEIGHT_CAP) : weight
}

function bigramSet(value) {
  const text = String(value ?? '').replace(/\s+/g, '').trim()
  const set = new Set()
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
  return set
}

function similarTitle(a, b) {
  const left = bigramSet(titleWindow(a))
  const right = bigramSet(titleWindow(b))
  if (!left.size || !right.size) return false
  let inter = 0
  for (const gram of left) if (right.has(gram)) inter++
  return inter / (left.size + right.size - inter) >= 0.45
}

function kindTieRank(kind) {
  if (kind === 'promise') return 0
  if (kind === 'fact') return 1
  return 2
}

function titleOrder(dayRows) {
  const list = dayRows || []
  return [...list].sort((a, b) => {
    const weightDiff = effectiveWeight(b) - effectiveWeight(a)
    if (weightDiff !== 0) return weightDiff
    // fact 与 promise 同为 1.00；验收要求求婚/承诺先于普通事实，同档时 promise 优先。
    const kindDiff = kindTieRank(a.kind) - kindTieRank(b.kind)
    if (kindDiff !== 0) return kindDiff
    return a.start_at - b.start_at || a.start_seq - b.start_seq
  })
}

export function redatingView(handle, args = {}) {
  const db = handle?.db
  if (!db) return '（还没有可以回想的日子）'
  let from = args?.from ? String(args.from).trim() : ''
  let to = args?.to ? String(args.to).trim() : ''
  const monthArg = args?.month ? String(args.month).trim() : ''
  if (from && !validDay(from)) return 'from 需要 YYYY-MM-DD'
  if (to && !validDay(to)) return 'to 需要 YYYY-MM-DD'
  if (monthArg) {
    const mb = monthBounds(monthArg)
    if (!mb) return 'month 需要 YYYY-MM'
    from = from && from > mb.start ? from : mb.start
    to = to && to < mb.end ? to : mb.end
  }
  const hasLimit = args?.limit != null && String(args.limit).trim() !== '' && Number.isFinite(Number(args.limit))
  // 月份档整月展开；传了 limit 也不报错、不生效。
  const limit = monthArg ? MAX_LIMIT : (hasLimit ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(args.limit)))) : DEFAULT_LIMIT)

  const stamp = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(start_seq), 0) AS m,
    (SELECT COUNT(*) FROM episode_detail WHERE simplified = 1) AS s,
    (SELECT COUNT(*) FROM day_mainline) AS dm,
    (SELECT COALESCE(MAX(updated_at), 0) FROM day_mainline) AS dmu,
    (SELECT COUNT(*) FROM month_themes) AS mt,
    (SELECT COALESCE(MAX(updated_at), 0) FROM month_themes) AS mtu FROM episodes_v2`).get()
  const cached = redatingCache.get(db)
  let dayRows
  if (cached && cached.n === Number(stamp.n) && cached.m === Number(stamp.m) && cached.s === Number(stamp.s) &&
    cached.dm === Number(stamp.dm) && cached.dmu === Number(stamp.dmu) &&
    cached.mt === Number(stamp.mt) && cached.mtu === Number(stamp.mtu) && Date.now() - cached.at < 2000) {
    dayRows = cached.dayRows
  } else {
    const rows = db.prepare(`
      SELECT e.session_id, e.start_seq, e.start_at, e.body, length(e.body) AS body_len,
        (SELECT COUNT(*) FROM messages m
          WHERE m.session_id = e.session_id AND m.seq BETWEEN e.start_seq AND e.end_seq) AS msg_count,
        a.title AS agg_title, a.kind AS kind
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
    dayRows = new Map()
    for (const row of rows) {
      const day = localDayKey(row.start_at)
      if (!day) continue
      if (!dayRows.has(day)) dayRows.set(day, [])
      dayRows.get(day).push(row)
    }
    redatingCache.set(db, {
      n: Number(stamp.n), m: Number(stamp.m), s: Number(stamp.s),
      dm: Number(stamp.dm), dmu: Number(stamp.dmu), mt: Number(stamp.mt), mtu: Number(stamp.mtu),
      at: Date.now(), dayRows,
    })
  }

  const dayMainlines = new Map(db.prepare('SELECT day, text, status, source FROM day_mainline').all().map(row => [row.day, row]))
  const monthThemes = new Map(db.prepare('SELECT month, themes FROM month_themes').all().map(row => [row.month, row.themes]))

  const allDays = [...dayRows.keys()].sort()
  let days = allDays
  if (from) days = days.filter(day => day >= from)
  if (to) days = days.filter(day => day <= to)
  if (!days.length) return '（还没有可以回想的日子）'

  function hhmm(ms) {
    const d = new Date(Number(ms))
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // 选择必须按时间正序做：这样「前 3 天」是真正的更早日期，11-20 的求婚会先被选中，
  // 之后 11-23/24/25/26 的回声才会被跳过；渲染时再按新到旧输出。
  const selections = new Map()
  const recentPicks = []
  function buildSelection(day) {
    const list = dayRows.get(day) || []
    if (day === localDayKey(Date.now())) return { labeled: false, picks: [] }
    const titled = list.filter(row => row.agg_title && String(row.agg_title).trim())
    if (!titled.length) return { labeled: false, picks: [] }
    const previous = recentPicks.filter(item => {
      const gap = dayNumber(day) - dayNumber(item.day)
      return gap >= 1 && gap <= 3
    })
    const seen = previous.map(item => item.title)
    const picks = []
    const labeled = titled.some(row => labelWeight(row.kind) > 0)
    if (labeled) {
      for (const row of titleOrder(titled)) {
        if (picks.length >= 3) break
        const title = titleWindow(row.agg_title)
        if (seen.some(previousTitle => similarTitle(title, previousTitle))) continue
        picks.push({ start_at: row.start_at, start_seq: row.start_seq, title })
        seen.push(title)
      }
    } else {
      const indexes = titled.length <= 2 ? [0, titled.length - 1] : [0, Math.floor((titled.length - 1) / 2), titled.length - 1]
      for (const index of indexes) {
        const row = titled[index]
        if (picks.some(p => p.start_seq === row.start_seq)) continue
        const title = titleWindow(row.agg_title)
        if (seen.some(previousTitle => similarTitle(title, previousTitle))) continue
        picks.push({ start_at: row.start_at, start_seq: row.start_seq, title })
        seen.push(title)
      }
    }
    for (const pick of picks) recentPicks.push({ day, title: pick.title })
    return { labeled, picks }
  }
  for (const day of days) {
    selections.set(day, buildSelection(day))
    recentPicks.splice(0, Math.max(0, recentPicks.length - 12))
  }

  function monthLine(month, count, truncated = 0) {
    const themes = String(monthThemes.get(month) ?? '').trim()
    const suffix = truncated ? ` · 另记 ${truncated} 天` : ''
    const head = `${month} · ${month === localDayKey(Date.now()).slice(0, 7) ? '这个月还在过 · ' : ''}记下 ${count} 天${suffix}`
    // 整行（含主题锚）不超过 70 字；放不下就少放主题，不截断主题内部。
    let themeText = ''
    if (themes) {
      for (const part of themes.split(' · ')) {
        const next = `${head} · ${themeText ? `${themeText} · ` : ''}${part}`
        if (next.length > 70) break
        themeText = themeText ? `${themeText} · ${part}` : part
      }
    }
    return `${head}${themeText ? ` · ${themeText}` : ''}`
  }

  function dayLine(day) {
    const list = dayRows.get(day) || []
    if (day === localDayKey(Date.now())) return `${day} · （今天，还没过完）`
    const main = dayMainlines.get(day)
    const selection = selections.get(day)
    const picks = selection?.picks ?? []
    const pointerLines = picks.map(row => `  ${hhmm(row.start_at)} ${row.title}`)
    if (main?.status === 'ok' && String(main.text || '').trim()) {
      return [`${day} · ${list.length} 段`, `  ${String(main.text).trim()}`, ...pointerLines].join('\n')
    }
    const titled = list.filter(row => row.agg_title && String(row.agg_title).trim())
    if (!titled.length) return `${day} · ${list.length} 段 ·（还没有整理出标题）`
    return [`${day} · ${list.length} 段`, '  （那天还在整理，先按标题看）', ...pointerLines].join('\n')
  }

  if (monthArg) {
    const picked = [...days].reverse()
    const header = monthLine(monthArg, days.length)
    return [header, ...picked.map(dayLine)].join('\n')
  }

  const today = localDayKey(Date.now())
  const currentMonth = today.slice(0, 7)
  const lines = [`截至 ${today}，我们留下过记忆的日子共 ${allDays.length} 天，最早 ${allDays[0]}，最近 ${allDays[allDays.length - 1]}。`]
  const recentDays = days.slice(-limit).reverse()
  const olderDays = days.slice(0, Math.max(0, days.length - limit))
  const monthMap = new Map()
  for (const day of olderDays) {
    const month = day.slice(0, 7)
    if (month === currentMonth) continue // 当前月只在底部出一行摘要，避免同月两条计数不一致
    if (!monthMap.has(month)) monthMap.set(month, [])
    monthMap.get(month).push(day)
  }
  // 最近 days 先展开；当前月还有没展开的日子时，紧接在最近几天后面给一行摘要。
  // 全月都已展开（例如 limit=30）就不再重复出这一行。
  for (let i = 0; i < recentDays.length; i++) {
    if (i > 0) {
      const gap = dayNumber(recentDays[i - 1]) - dayNumber(recentDays[i])
      if (gap >= 8) lines.push(`…… 中间 ${gap} 天没有记下什么`)
    }
    lines.push(dayLine(recentDays[i]))
  }
  const currentCount = allDays.filter(day => day.startsWith(`${currentMonth}-`)).length
  const currentShown = recentDays.filter(day => day.startsWith(`${currentMonth}-`)).length
  if (currentCount > currentShown) lines.push(monthLine(currentMonth, currentCount, currentCount - currentShown))

  // 更早的完整月份折叠；只在这些月之间按真实断档插入空隙。
  const oldEntries = []
  for (const [month, list] of [...monthMap.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, MAX_MONTHS)) {
    oldEntries.push({ kind: 'month', month, count: list.length, earliestDay: list[0], latestDay: list[list.length - 1] })
  }
  for (let i = 0; i < oldEntries.length; i++) {
    if (i > 0) {
      const gap = dayNumber(oldEntries[i - 1].earliestDay) - dayNumber(oldEntries[i].latestDay)
      if (gap >= 8) lines.push(`…… 中间 ${gap} 天没有记下什么`)
    }
    const entry = oldEntries[i]
    lines.push(monthLine(entry.month, entry.count))
  }
  return lines.join('\n')
}
