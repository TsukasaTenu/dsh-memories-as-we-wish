// 索引 + 触发 + 注入 的胶水层（P0）
import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { scanSessionFile, extractMessageFromEvent, readSessionOrigin } from './parse.js'
import { tokenize } from './db.js'
import { parseCues, scoreResults, gate, asksAboutPast } from './cues.js'
import { buildEpisodes, makeTitle, isShortInteraction, enrichEpisode } from './episodes.js'
import { AGG_KINDS } from './labels.js'
import { buildInjection, buildEpisodeBlocks, dedupeByText } from './inject.js'

/** 在 sessionsRoot/<workspace>/<sessionId>/session.v4.jsonl.zstd 里找会话文件。 */
export function findSessionEntry(sessionsRoot, sessionId) {
  if (!sessionsRoot || !sessionId) return null
  if (!existsSync(sessionsRoot)) return null
  for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = join(sessionsRoot, entry.name, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(p)) return { sessionId, filePath: p, workspace: entry.name }
  }
  return null
}

export function findSessionFile(sessionsRoot, sessionId) {
  return findSessionEntry(sessionsRoot, sessionId)?.filePath ?? null
}

/** 扫描整个终端：所有 workspace 下的全部 session 文件。
 *  withOrigin=true 时只读每个 session 的首个事件判断子代理（不整份解压）。
 */
export function listSessionEntries(sessionsRoot, { withOrigin = false } = {}) {
  if (!sessionsRoot || !existsSync(sessionsRoot)) return []
  const out = []
  for (const ws of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const sess of readdirSync(join(sessionsRoot, ws.name), { withFileTypes: true })) {
      if (!sess.isDirectory()) continue
      const p = join(sessionsRoot, ws.name, sess.name, 'session.v4.jsonl.zstd')
      if (!existsSync(p)) continue
      const item = { sessionId: sess.name, filePath: p, workspace: ws.name }
      if (withOrigin) {
        const origin = readSessionOrigin(p)
        item.origin = origin?.origin ?? null
        item.parentSession = origin?.parentSession ?? null
        item.delegationDepth = origin?.delegationDepth ?? 0
        item.isSubagent = !!origin?.isSubagent
      }
      out.push(item)
    }
  }
  return out
}

/** 落库一批消息（seq 为主键；重复写会覆盖）。 */
export function insertMessages(dbHandle, sessionId, messages) {
  let n = 0
  for (const m of messages) {
    if (dbHandle.insert({ seq: m.seq, sessionId, role: m.role, time: m.time, text: m.text, kind: m.kind }) != null) n++
  }
  return n
}

/**
 * 增量索引一个会话文件：只写 seq > fromSeq 的消息。
 * @returns {{ added:number, lastSeq:number, total:number }}
 */
function readRange(filePath, offset, length) {
  const fd = openSync(filePath, 'r')
  try {
    const b = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const n = readSync(fd, b, done, length - done, offset + done)
      if (!n) break
      done += n
    }
    return b.subarray(0, done)
  } finally { closeSync(fd) }
}

export function indexSessionFile(dbHandle, { sessionId, filePath, fromSeq = 0, onebotHintPatterns, offset = 0 } = {}) {
  const size = statSync(filePath).size
  if (offset === size) {
    return { added: 0, lastSeq: fromSeq, nextOffset: size, scannedBytes: 0, totalBytes: size, fallback: false }
  }
  let base = 0
  let buf
  let truncated = offset > size
  let fallback = false
  if (offset > 0 && offset < size) {
    buf = readRange(filePath, offset, size - offset)
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0xfd2fb528) base = offset
    else { buf = readFileSync(filePath); fallback = true }
  } else {
    buf = readFileSync(filePath)
    fallback = truncated
  }
  const messages = []
  let turn = 0
  // 流式：解压一帧、解析一行、抽取一条消息；不保留 events/reasoning/整场文本。
  const scanned = scanSessionFile(buf, {
    baseOffset: base,
    onEvent: (e) => {
      if (e.type === 'turn/start' && typeof e.data?.turn === 'number') turn = e.data.turn
      const m = extractMessageFromEvent(e, { turn, onebotHintPatterns })
      if (m && m.seq > fromSeq) messages.push(m)
    },
  })
  insertMessages(dbHandle, sessionId, messages)
  const lastSeq = messages.length ? messages[messages.length - 1].seq : fromSeq
  return {
    added: messages.length,
    lastSeq,
    nextOffset: scanned.nextOffset,
    scannedBytes: buf.length,
    totalBytes: size,
    fallback,
  }
}

/**
 * 触发式检索：线索 → 检索 → 打分 → 门控 → 注入块。
 * @returns {{ triggered:boolean, reason?:string, cues?, score?, results?, block? }}
 */
// 线索/寒暄类 bigram：检索时不应作为匹配词（否则“记得我上次说”会稀释相关性）
const CUE_STOPWORDS = new Set([
  '上次', '次我', '我说', '说过', '你还', '还记', '记得', '记不', '不记', '吗？', '那件', '件事', '后来',
  '怎么', '么样', '我们', '我们', '的', '了', '吗', '呢', '吧', '啊', '那', '这', '个',
])
// 虚词/人称字：含这些字的 bigram 多半是"得我/的事/事吗"这类噪声，不作为检索词
const STOP_CHARS = new Set([
  '的', '了', '呢', '吗', '吧', '啊', '呀', '嘛', '我', '你', '他', '她', '它', '这', '那', '是', '不',
  '在', '有', '就', '都', '也', '还', '和', '与', '个', '么', '什', '怎', '样', '得', '着', '过', '地',
  '很', '说', '记', '件', '上', '次', '后', '来', '们',
])
export function contentTokens(text) {
  return tokenize(text).filter(t => {
    if (CUE_STOPWORDS.has(t)) return false
    if (/^[a-z0-9_]+$/.test(t)) return true            // 英文/数字词保留
    return ![...t].some(ch => STOP_CHARS.has(ch))      // 中文 bigram：含虚词字就丢
  })
}

// 事件相似度（判断"是不是同一件事"）：bigram Jaccard
const grams = (text) => new Set(tokenize(text))
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  let inter = 0
  for (const x of small) if (big.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

export function answerQuery(dbHandle, text, {
  rankOpts = null,
  entities = [], now = Date.now(), threshold = 0.55, maxChars = 320, limit = 10, minRelevance = 0.40,
} = {}) {
  const cues = parseCues(text, { entities })
  // 意图门控（规格 §3.1 + 回放教训）：
  //   ① 必须先"在问过去"（问句/记得/刚才…解释），纯陈述句（任务指令）不算；
  //   ② 过去线索 = 引语 OR 记忆动词 OR (时间词 AND 实体)；
  //      "问句 + 时间指代"（刚才/上次）也视为在问过去——这是回放里唯一 genuine 的形态之一。
  const asksPast = asksAboutPast(text)
  const pastCue = cues.quotes.length > 0 || cues.verbs.length > 0 || (cues.times.length > 0 && (cues.entities.length > 0 || asksPast))
  if (!asksPast) return { triggered: false, reason: 'not-asking-past', cues, asksPast }
  if (!pastCue) return { triggered: false, reason: 'no-past-cue', cues, asksPast }
  const tokens = contentTokens(text).slice(0, 24)
  // 检索单位 = episodes（规格 §1.1）：有 episodes 就走 episode 检索；messages 只做证据
  if (dbHandle.episodeCount() > 0) {
    return answerFromEpisodes(dbHandle, { text, cues, asksPast, tokens, now, threshold, maxChars, limit, minRelevance, rankOpts })
  }
  const candidates = dbHandle.search(tokens, 60)
  if (!candidates.length) return { triggered: false, reason: 'no-hits', cues, asksPast }
  const strength = 1   // 已过意图门控（§3.1），强度按 1 计
  const timeHit = cues.times.length > 0
  // 逐条打分（规格 §3.2 权重；实体/引语命中在本条上加权，避免被一般相关性盖过）
  const scored = candidates.map(c => {
    const own = new Set(tokenize(c.text))
    let cov = 0
    for (const t of tokens) if (own.has(t)) cov++
    let rel = tokens.length ? cov / tokens.length : 0
    // 引语是精确线索：引语自身命中率也算相关性（否则长 query 会把精确匹配稀释掉）
    if (cues.quotes.length) {
      const qTokens = [...new Set(cues.quotes.flatMap(q => tokenize(q)))]
      if (qTokens.length) {
        let hit = 0
        for (const qt of qTokens) if (own.has(qt)) hit++
        rel = Math.max(rel, hit / qTokens.length)
      }
    }
    const entity = cues.entities.some(e => c.text.includes(e)) ? 1 : 0
    const quote = cues.quotes.some(q => c.text.includes(q)) ? 1 : 0
    const scoreOne = 0.45 * rel + 0.20 * entity + 0.15 * timeHit + 0.10 * quote + 0.10 * strength
    return { ...c, rel, entity, quote, scoreOne }
  }).sort((a, b) => b.scoreOne - a.scoreOne || a.rank - b.rank)
  const hits0 = scored.slice(0, limit)
  // "刚才那段话"这类指代：相关材料是**最近**的消息，用近邻窗口优先；近邻可放宽相关性下限
  const recencyMode = asksPast && /刚才|刚刚|刚才那段|紧接着/.test(text)
  let hits = hits0
  let relFloor = minRelevance
  if (recencyMode) {
    const maxSeq = dbHandle.db.prepare('SELECT MAX(seq) AS m FROM messages').get()?.m ?? 0
    // 近邻候选直接查库（FTS 未必召回"最近那段话"），按查询 bigram 覆盖率打分
    const recentRows = dbHandle.db.prepare(
      "SELECT seq, role, time, text FROM messages WHERE seq >= ? AND (status IS NULL OR status != 'rejected') ORDER BY seq DESC LIMIT 40",
    ).all(maxSeq - 80)
    const scoreRow = (c) => {
      const own = new Set(tokenize(c.text))
      let hit = 0
      for (const t of tokens) if (own.has(t)) hit++
      const rel = tokens.length ? hit / tokens.length : 0
      return { ...c, rel, entity: 0, quote: 0, scoreOne: 0.45 * rel + 0.10 }
    }
    const recent = recentRows.map(scoreRow).sort((a, b) => b.rel - a.rel)
    if (recent.length) { hits = recent.slice(0, limit); relFloor = 0.10 }
  }
  // top1 相关性下限（规格 §3.2）：防"长 assistant 消息 bigram 多吸分"，一条消息长不代表相关
  if (!hits.length || hits[0].rel < relFloor) {
    return {
      triggered: false,
      reason: `low-relevance:${(hits[0]?.rel ?? 0).toFixed(2)}${recencyMode ? '(recent)' : ''}`,
      cues, results: hits.map(pick), asksPast,
    }
  }
  // 门控用"有材料 + 线索"的文档级分（P0 口径），排序用逐条分（§3.4）
  const entityAny = hits.some(h => h.entity)
  const quoteAny = hits.some(h => h.quote)
  const score = Number((0.45 + 0.20 * (entityAny ? 1 : 0) + 0.15 * (timeHit ? 1 : 0) + 0.10 * (quoteAny ? 1 : 0) + 0.10 * strength).toFixed(4))
  if (!gate(cues, score, threshold)) {
    return { triggered: false, reason: 'below-gate', cues, score, results: hits.map(pick) }
  }

  // 排序（§3.4）：只取 top1；第二条仅在 score2 ≥ 0.85×score1 且"不是同一件事"时给
  const first = hits[0]
  const second = hits.slice(1).find(h => {
    if (h.scoreOne < 0.85 * first.scoreOne) return false
    const sameTurn = Math.floor(h.seq / 10) === Math.floor(first.seq / 10)
    const sameThing = jaccard(grams(h.text), grams(first.text)) > 0.5
    return !sameTurn && !sameThing
  })
  const episodes = second ? [pick(first), pick(second)] : [pick(first)]

  // 引语源：真正包含这句引语的那条
  let quote = null
  for (const q of cues.quotes) {
    const src = hits.find(h => h.text.includes(q))
    if (src) { quote = { text: q, seq: src.seq, sourceText: src.text }; break }
  }
  if (cues.quotes.length && !quote) return { triggered: false, reason: 'quote-not-found', cues, score, results: hits.map(pick) }
  const block = buildInjection({ episodes, quote, now, maxItems: limit })
  const results = hits.map(pick)
  if (!block.verified) return { triggered: false, reason: `block-invalid:${block.reason}`, cues, score, results }
  return {
    triggered: true, cues, score, results, block,
    picked: episodes.length, firstSeq: first.seq,
    components: { rel: first.rel, entity: first.entity, quote: first.quote, timeHit, strength },
  }
}

const pick = (h) => ({ seq: h.seq, role: h.role, time: h.time, text: h.text, rel: h.rel })

/** episode 检索：命中 episode → 按 seq 范围回 messages 取原文做证据。 */
const TIME_WINDOW_DAYS = [
  [/刚才|刚刚|今天/, 1], [/昨天/, 2], [/前天/, 3], [/上周|上星期/, 10], [/上个月/, 40], [/去年/, 400],
]
function timeWindowDays(cues) {
  if (!cues.times.length) return null
  for (const [re, d] of TIME_WINDOW_DAYS) if (cues.times.some(t => re.test(t))) return d
  return 3650
}

/**
 * 排序（task-23）：分字段 FTS bm25 → 实体命中 +0.15、时间窗命中 +0.10（加法）；
 * recency 只做同分 tie-breaker，不做乘子。
 * @returns {{cues, tokens, rows}}
 */
export function rankEpisodes(dbHandle, text, { entities = [], now = Date.now(), limit = 40, legacy = false, k = 5, wFields = 3, wBody = 6, kind = null } = {}) {
  const cues = parseCues(text, { entities })
  const tokens = contentTokens(text).slice(0, 24)
  if (!tokens.length) return { cues, tokens, rows: [] }
  // 双路：路 1 = 分字段（title/summary/cues/entities/time），路 2 = 正文（body+quote）
  // RRF：score = Σ 1/(k + rank)，只用排名，不归一化分数。
  const p1 = legacy ? [] : dbHandle.searchEpisodes2(tokens, 50)
  const p2 = dbHandle.searchEpisodes(tokens, 50)
  const acc = new Map()
  const addPath = (list, weight, path) => {
    list.forEach((e, i) => {
      const cur = acc.get(e.id) ?? { e, rrf: 0, ranks: {} }
      cur.rrf += weight / (k + i + 1)
      cur.ranks[path] = i + 1
      cur.e = cur.e ?? e
      acc.set(e.id, cur)
    })
  }
  addPath(p1, wFields, 'fields')
  addPath(p2, wBody, 'body')
  if (legacy) { // 旧口径对照：只用正文路
    addPath([], 0, 'fields')
  }
  const tw = timeWindowDays(cues)
  const kindWanted = AGG_KINDS.includes(kind) ? kind : null
  let rows = [...acc.values()].map(({ e, rrf, ranks }) => {
    const hay = `${e.body ?? ''} ${e.summary ?? ''} ${e.quote ?? ''}`
    const own = new Set(tokenize(hay))
    let cov = 0
    for (const t of tokens) if (own.has(t)) cov++
    let rel = tokens.length ? cov / tokens.length : 0
    if (cues.quotes.length) {
      const qTokens = [...new Set(cues.quotes.flatMap(q => tokenize(q)))]
      if (qTokens.length) {
        let hit = 0
        for (const qt of qTokens) if (own.has(qt)) hit++
        rel = Math.max(rel, hit / qTokens.length)
      }
    }
    let score = rrf + 0.65 * rel
    const entHit = cues.entities.some(x => `${e.entities ?? ''} ${hay}`.includes(x))
    if (entHit) score += 0.15                             // 实体精确命中：加法
    const timeHit = tw != null && Number.isFinite(e.start_at) && Math.abs(now - e.start_at) <= tw * 86400000
    if (timeHit) score += 0.10                            // 时间窗命中：加法
    if (kindWanted && e.kind === kindWanted) score *= 1.12  // 用户指定类型：只对已召回候选重排
    const top1Path = ranks.fields != null && (ranks.body == null || ranks.fields <= ranks.body) ? 'fields' : 'body'
    return { ...e, hay, rel, entHit, timeHit, score, rrf, ranks, top1Path }
  }).sort((a, b) => b.score - a.score || b.start_seq - a.start_seq)  // recency 只做平局修正
  // tie-breaker（只在前两名相邻/近分时生效，不做乘子）：
  //  a) 问"之前/那时候" → 偏好更早的 episode；
  //  b) 解释型问句且两篇时间相邻 → 回答通常在**后**一篇。
  if (rows.length >= 2) {
    const [a, b] = rows
    const gap = Math.abs(a.score - b.score)
    const scale = Math.max(a.score, b.score, 0.0001)
    const close = gap <= 0.12 * scale
    const older = /之前|上次|上回|以前|当时|那时候|去年|那天/.test(text)
    if (close && older && b.start_seq < a.start_seq) { rows[0] = b; rows[1] = a }
    else {
      const explainAsk = /来着|干什么|是什么|怎么回事|为什么|解释|意思/.test(text)
      const adjacent = Math.abs(Number(a.end_seq) + 1 - Number(b.start_seq)) <= 12 || Math.abs(Number(b.end_seq) + 1 - Number(a.start_seq)) <= 12
      if (explainAsk && adjacent && b.start_seq > a.start_seq) { rows[0] = b; rows[1] = a }
    }
  }
  // 主动降权分区：不改 score 公式，只把 marked 放到未 marked 之后；
  // 若全部命中都 marked，则保持 score 顺序（不能返回空）。tail 也沿用这个顺序。
  const simplifiedIds = dbHandle.simplifiedStartSeqs?.(rows.map(r => r.start_seq)) ?? new Set()
  for (const r of rows) r.simplified = simplifiedIds.has(Number(r.start_seq))
  const unmarked = rows.filter(r => !r.simplified)
  const marked = rows.filter(r => r.simplified)
  if (unmarked.length && marked.length) rows = [...unmarked, ...marked]
  return { cues, tokens, rows: rows.slice(0, limit) }
}

function answerFromEpisodes(dbHandle, { text, cues, asksPast, tokens, now, threshold, maxChars, limit, minRelevance, rankOpts = null }) {
  const recencyMode = asksPast && /刚才|刚刚|刚才那段|紧接着/.test(text)
  let { rows } = rankEpisodes(dbHandle, text, { entities: cues.entities, now, limit: 60, ...(rankOpts ?? {}) })
  // recency 兜底：问“刚才…”但 FTS 无命中时，取最近的 episodes 按查询词覆盖率排
  if (!rows.length && recencyMode) {
    try {
      const rec = dbHandle.db.prepare("SELECT id, session_id, start_seq, end_seq, start_at, title, body, summary, quote FROM episodes_v2 WHERE status='active' ORDER BY start_seq DESC LIMIT 40").all()
      rows = rec.map(e => {
        const hay = `${e.body ?? ''} ${e.summary ?? ''}`.trim()
        const own = new Set(tokenize(hay))
        let cov = 0
        for (const t of tokens) if (own.has(t)) cov++
        const rel = tokens.length ? cov / tokens.length : 0
        return { ...e, hay, rel, entHit: false, timeHit: false, score: rel, top1Path: 'recency' }
      }).sort((a, b) => b.rel - a.rel || b.start_seq - a.start_seq)
    } catch { /* noop */ }
  }
  if (!rows.length) return { triggered: false, reason: 'no-hits', cues, asksPast, unit: 'episode' }
  // 候选池层面去重（>5 条时）：跨会话同文候选先合并，再从去重结果里取 3–5 条
  if (rows.length > 5) rows = dedupeByText(rows.map(r => ({ ...r, text: r.body })))
  const relFloor = recencyMode ? 0.10 : minRelevance
  const hits = rows.slice(0, Math.max(limit, 10))
  if (!hits.length || hits[0].rel < relFloor) {
    return { triggered: false, reason: `low-relevance:${(hits[0]?.rel ?? 0).toFixed(2)}${recencyMode ? '(recent)' : ''}`, cues, asksPast, unit: 'episode', results: hits.map(episodeOut) }
  }
  const score = Number((0.45 + 0.15 * (hits.some(h => h.entHit) ? 1 : 0) + 0.10 * (hits.some(h => h.timeHit) ? 1 : 0) + 0.10).toFixed(4))
  if (!gate(cues, score, threshold)) {
    return { triggered: false, reason: 'below-gate', cues, score, asksPast, unit: 'episode', results: hits.map(episodeOut) }
  }
  const first = hits[0]
  // 3–5 条：命中 episode + 时间相邻 ±2（同一会话内按 start_seq 排序）
  const all = dbHandle.db.prepare('SELECT id, start_seq, end_seq, start_at, title, body, summary, quote FROM episodes_v2 WHERE session_id = ? ORDER BY start_seq').all(first.session_id)
  const idx = all.findIndex(e => e.id === first.id)
  let pick = idx >= 0 ? all.slice(Math.max(0, idx - 2), Math.min(all.length, idx + 3)) : [first]
  const seen = new Set()
  pick = pick.filter(e => {
    const k = `${e.start_seq}-${e.end_seq}`
    if (seen.has(k)) return false
    seen.add(k); return true
  }).slice(0, 5)
  const evidence = pick.map(e => dbHandle.messagesInRange(e.start_seq, e.end_seq, 4)).flat().slice(0, 6)
  let quote = null
  if (cues.quotes.length) {
    for (const q of cues.quotes) {
      const src = evidence.find(m => String(m.text).includes(q))
      if (src) { quote = { text: q, seq: src.seq, sourceText: src.text }; break }
    }
    if (!quote) return { triggered: false, reason: 'quote-not-found', cues, score, unit: 'episode', results: hits.map(episodeOut) }
  } else if (first.quote) {
    const src = evidence.find(m => String(m.text).includes(first.quote))
    if (src) quote = { text: first.quote, seq: src.seq, sourceText: src.text }
  }
  // 展示（task-32/33）：一块 = 一个 episode；块头 时间戳 · #start_seq · 标题，块内 你：/我： 分行
  const blocks = pick.map(ep => ({
    seq: ep.start_seq,
    time: ep.start_at ?? now,
    title: ep.title ?? '',
    summary: ep.summary ?? '',
    body: ep.body ?? '',
    lines: dbHandle.messagesInRange(ep.start_seq, ep.end_seq, 4).slice(0, 2).map(m => ({ role: m.role, text: m.text })),
  }))
  const block = buildEpisodeBlocks({ blocks, quote, now, maxItems: limit })
  const results = hits.map(episodeOut)
  if (!block.verified) return { triggered: false, reason: `block-invalid:${block.reason}`, cues, score, unit: 'episode', results }
  return {
    triggered: true, cues, score, unit: 'episode', results, block,
    evidence, picked: blocks.length, firstEpisodeId: first.id,
    components: { rel: first.rel, ent: first.entHit, timeHit: first.timeHit, recencyMode, top1Path: first.top1Path },
  }
}

const episodeOut = (h) => ({
  id: h.id, start_seq: h.start_seq, end_seq: h.end_seq, start_at: h.start_at, end_at: h.end_at,
  title: h.title, body: h.body, quote: h.quote, rel: h.rel,
})

/** 从 messages 重建某会话的 episodes（检索单位），并写 FTS。 */
export function buildAndIndexEpisodes(dbHandle, sessionId, opts = {}) {
  const msgs = dbHandle.db.prepare("SELECT seq, role, time, text FROM messages WHERE session_id = ? AND (status IS NULL OR status != 'rejected') ORDER BY seq").all(sessionId)
  // 密度自适应：低密度（短互动占比高，如桌宠 700 条/天）按会话聚合；
  // 高密度（RP/长对话）用小 episode（2 条/篇）保住召回。
  const shortRatio = msgs.length ? msgs.filter(m => isShortInteraction(m.text)).length / msgs.length : 0
  const densityOpts = shortRatio > 0.6 ? { maxItems: 60, maxBodyChars: 200 } : { maxItems: 2, maxBodyChars: 600 }
  const eps = buildEpisodes(msgs, { ...densityOpts, ...opts }).map(ep => enrichEpisode(ep, { entities: opts.entities }))
  for (const ep of eps) {
    if (ep.valuable === false) continue
    const mt = makeTitle(ep.body)
    if (mt?.title) ep.title = mt.title
  }
  dbHandle.indexEpisodes(sessionId, eps)
  return eps
}

/** 评测用：把 turns.json 写成 messages（seq = turn*10 + 0/1）。 */
export function indexTurns(dbHandle, turns, sessionId = 'dreamjourney', { fromSeq = 0 } = {}) {
  let n = 0
  for (const t of turns) {
    const seqUser = t.turn * 10
    const seqAsst = t.turn * 10 + 1
    const userText = String((t.user ?? []).join('\n')).trim()
    const asstText = String((t.assistant ?? []).join('\n')).trim()
    if (userText && seqUser > fromSeq) { dbHandle.insert({ seq: seqUser, sessionId, role: 'user', time: t.startTime ?? 0, text: userText }); n++ }
    if (asstText && seqAsst > fromSeq) { dbHandle.insert({ seq: seqAsst, sessionId, role: 'assistant', time: t.endTime ?? t.startTime ?? 0, text: asstText }); n++ }
  }
  return n
}
