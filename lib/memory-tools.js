// 主动工具的输出构造（index.js 与离线验证共用，便于直接测试）
import { rankEpisodes } from './pipeline.js'
import { buildEpisodeBlocks, dedupeByText } from './inject.js'

// 解析 YYYY-MM-DD：from 取当天 00:00:00.000，to 取当天 23:59:59.999（含）
export function parseDay(value, endOfDay) {
  const s = String(value ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  if (endOfDay) d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function toBlocks(handle, rows, now) {
  return rows.map(ep => ({
    seq: ep.start_seq,
    time: ep.start_at ?? now,
    title: ep.title ?? '',
    summary: ep.summary ?? '',
    body: ep.body ?? '',
    lines: handle.messagesInRange(ep.start_seq, ep.end_seq, 4).slice(0, 2).map(m => ({ role: m.role, text: m.text })),
  }))
}

/** memory_recall：query 与 from/to 是 AND；query 可为空（纯时间查，默认 10 条）。 */
export function searchView(handle, args, { entities = [], now = Date.now() } = {}) {
  const q = String(args?.query ?? '').trim()
  const fromTs = parseDay(args?.from, false)
  const toTs = parseDay(args?.to, true)
  if (!q && fromTs == null && toTs == null) return '（需要 query，或 from/to 时间范围）'
  const pureTime = !q
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || (pureTime ? 20 : 20)))
  let rows
  if (pureTime) {
    const lo = fromTs ?? 0
    const hi = toTs ?? Number.MAX_SAFE_INTEGER
    rows = handle.db.prepare("SELECT id, session_id, start_seq, end_seq, start_at, end_at, title, body, summary, quote FROM episodes_v2 WHERE status='active' AND start_at >= ? AND start_at <= ? ORDER BY start_at DESC LIMIT ?").all(lo, hi, limit * 4)
  } else {
    rows = rankEpisodes(handle, q, { entities, now, limit: limit * 4 }).rows
    if (fromTs != null || toTs != null) {
      const lo = fromTs ?? 0
      const hi = toTs ?? Number.MAX_SAFE_INTEGER
      rows = rows.filter(r => Number(r.start_at) >= lo && Number(r.start_at) <= hi)   // query AND 时间范围
    }
  }
  const pool = rows.length > limit ? dedupeByText(rows.map(r => ({ ...r, text: r.body }))) : rows
  const out = buildEpisodeBlocks({ blocks: toBlocks(handle, pool.slice(0, limit), now), now, maxItems: limit, showTitle: false }).text
  return out || '（没有找到那段时间的记忆）'
}

/** memory_remember：#seq → 原文若干条；定向读，不截断、不设总长上限（她已知道要读哪条）。 */
export function readView(handle, args) {
  const seq = Number(args?.seq)
  if (!Number.isFinite(seq)) return ''
  const span = Math.max(1, Math.min(10, Number(args?.span) || 1))
  const rows = handle.db.prepare('SELECT seq, role, time, text FROM messages WHERE seq >= ? ORDER BY seq LIMIT ?').all(seq, span)
  return rows.map(r => {
    const who = r.role === 'user' ? '你' : r.role === 'assistant' ? '我' : '记'
    return `${r.seq} · ${who}：${String(r.text ?? '').replace(/\s+/g, ' ')}`
  }).join('\n')
}
