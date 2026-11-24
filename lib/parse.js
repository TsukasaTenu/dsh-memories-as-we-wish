// 会话文件解析：多帧 zstd → 事件 → 可索引消息
// 索引路径使用 scanSessionFile 流式消费，不把整场事件数组留在内存里；
// decodeSessionFile 仅供 memory_relink 这类需要回看整轮的事件消费者使用。
import zlib from 'node:zlib'
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

const MAGIC = 0xfd2fb528

/** 默认 onebot 提示短语；可由 cfg.onebotHintPatterns 覆盖。 */
export const DEFAULT_ONEBOT_HINT_PATTERNS = [
  '只是唤醒',
  '直接写在最后一段文字里',
  '大概写到',
  '总字数一定不要超过',
  '这条可以多说几句',
  '对方有一会儿没说话了',
  '现在主动接刚刚的话题',
  '对方刚只@了你',
  '一般每句话回一两条就够了',
  '别为了凑字数硬写',
  '不要在回复里汇报字数',
]

/** 解压多帧 zstd，逐帧解析；同一帧内按行流式喂给 onEvent。 */
export function scanSessionFile(buf, { onEvent, onHeader } = {}) {
  const frames = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === MAGIC) frames.push(i)
  let header = null
  let carry = ''
  const feed = (line) => {
    if (!line.trim()) return
    let e
    try { e = JSON.parse(line) } catch { return }
    if (!header && e.type === 'session/header') {
      header = e.data ?? e
      onHeader?.(header)
      return
    }
    onEvent?.(e)
  }
  for (let k = 0; k < frames.length; k++) {
    const s = frames[k], end = k + 1 < frames.length ? frames[k + 1] : buf.length
    let text
    try { text = zlib.zstdDecompressSync(buf.subarray(s, end)).toString('utf8') } catch { continue }
    const chunk = carry + text
    const lines = chunk.split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) feed(line)
  }
  if (carry) feed(carry)
  return { header }
}

/** 兼容 memory_relink：保留事件数组，但只应被显式回看路径使用。 */
export function decodeSessionFile(buf) {
  const events = []
  const { header } = scanSessionFile(buf, { onEvent: (e) => events.push(e) })
  return { header, events }
}

export const textOf = (blocks) => (blocks ?? []).filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n')

/** 允许进索引的 kind：真实用户消息 + 她的回复（其 source 不是系统/插件）。 */
export const INDEX_ALLOWED_USER_KINDS = new Set(['user', 'onebot']) // AYABE-ONEBOT-ALLOW: QQ 渠道的用户消息也进索引
export const INDEX_BLOCKED_ASSISTANT_KINDS = new Set(['plugin:dsh-memory', 'system-prompt'])

export function isIndexable(ev) {
  if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') return false
  const src = ev?.data?.source ?? ev?.data?.message?.source
  const kind = src?.kind
  if (ev.type === 'user/message') return INDEX_ALLOWED_USER_KINDS.has(kind)   // runtime-context/agent-message/... 全拒
  return !INDEX_BLOCKED_ASSISTANT_KINDS.has(kind)
}

function normalizeHintPatterns(patterns) {
  if (!Array.isArray(patterns)) return DEFAULT_ONEBOT_HINT_PATTERNS
  return patterns.filter(p => typeof p === 'string' && p.length > 0)
}

/**
 * 一行提示行必须整行被括号包住，且命中任一提示短语；返回 true 表示应剥离。
 * 例：`（你只是唤醒，不用回复）`、`(这条可以多说几句)`。
 */
export function isOnebotHintLine(line, patterns = DEFAULT_ONEBOT_HINT_PATTERNS) {
  const t = String(line ?? '').trim()
  if (!t) return false
  const enclosed = (t.startsWith('（') || t.startsWith('(')) && (t.endsWith('）') || t.endsWith(')'))
  if (!enclosed) return false
  return normalizeHintPatterns(patterns).some(p => t.includes(p))
}

/** 单事件 → 可索引消息；不保留完整事件对象（reasoning 在这之后即释放）。 */
export function extractMessageFromEvent(e, { turn = 0, onebotHintPatterns = DEFAULT_ONEBOT_HINT_PATTERNS } = {}) {
  if (!isIndexable(e)) return null
  const blocks = e.type === 'user/message' ? e.data?.content : e.data?.message?.content
  const kind = e.data?.source?.kind ?? e.data?.message?.source?.kind ?? ''
  let text = textOf(blocks).trim()
  if (!text) return null
  if (text.includes('<system-reminder')) {
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  }
  if (text.length < 2) return null
  // onebot 渠道会把提示行追加进同一条用户消息；只剥整行括号包裹且命中提示短语的行。
  if (kind === 'onebot') {
    text = text.split('\n').filter((line) => !isOnebotHintLine(line, onebotHintPatterns)).join('\n').trim()
    if (text.length < 2) return null  // 全是提示行时，消息本身是空的，不索引
  }
  if (text.startsWith('[终端消息') || text.includes('命令结果·') || text.startsWith('[命令结果')) return null  // 环境块不是她的记忆
  return { seq: e.seq, role: e.type === 'user/message' ? 'user' : 'assistant', time: e.time, text, turn, kind }
}

/** 事件 → 可索引消息 [{ seq, role, time, text, turn, kind }]（测试/兼容用）。 */
export function extractMessages(events, { onebotHintPatterns = DEFAULT_ONEBOT_HINT_PATTERNS } = {}) {
  let turn = 0
  const out = []
  for (const e of events) {
    if (e.type === 'turn/start' && typeof e.data?.turn === 'number') turn = e.data.turn
    const m = extractMessageFromEvent(e, { turn, onebotHintPatterns })
    if (m) out.push(m)
  }
  return out
}

/**
 * 只读会话头：取第一个 `session` / `session/header` 事件，判断是否子代理。
 * 只读文件开头的少量字节，不整份解压；失败返回 null（调用方按根会话处理）。
 */
export function readSessionOrigin(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    const size = Number(fstatSync(fd).size ?? 0)
    // 只读开头几 MB，找到第一个完整 zstd 帧即可；session 事件属于首帧。
    let buf = null
    for (const cap of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
      const len = Math.min(size, cap)
      const b = Buffer.alloc(len)
      const n = readSync(fd, b, 0, len, 0)
      if (!n) return null
      buf = b.subarray(0, n)
      const first = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      if (first < 0) continue
      // 找第二个帧边界；找不到说明首帧还没读全，继续扩大读取。
      let second = -1
      for (let i = first + 4; i + 4 <= buf.length; i++) {
        if (buf.readUInt32LE(i) === MAGIC) { second = i; break }
      }
      const end = second >= 0 ? second : (buf.length >= size ? buf.length : -1)
      if (end < 0) continue
      let text
      try { text = zlib.zstdDecompressSync(buf.subarray(first, end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (e?.type === 'session' || e?.type === 'session/header') {
          const d = e.data ?? e
          const parent = d.parentSession ?? d.parent?.id ?? d.parent?.sessionId ?? null
          const depth = Number(d.delegationDepth ?? 0)
          const origin = String(d.origin ?? '')
          return {
            origin, parentSession: parent, delegationDepth: depth,
            isSubagent: origin === 'subagent' || !!parent || depth > 0,
          }
        }
      }
    }
  } catch { /* ignore */ } finally {
    try { if (fd != null) closeSync(fd) } catch { /* ignore */ }
  }
  return null
}
