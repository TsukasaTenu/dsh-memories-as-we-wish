/**
 * dsh-memories-as-we-wish · 长期记忆：LLM episode 概括 + 两档检索 + 触发式原文回忆
 *
 * 原则：
 *   - 压缩/装配交给 billion-context；本插件不碰窗口、不重装配；
 *   - 记忆是本地文献馆（SQLite + FTS5），原文在 session 文件里，插件只读；
 *   - 三条聚合触发：每 20 轮 / 首次全量 / 静默 24h；
 *   - 主动检索两档：memory_recall（≤20）+ memory_remember（全文）；
 *   - 触发式回忆：尾部注入（≤10，纯原文）。
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { appendFileSync, mkdirSync, statfsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openDb } from './lib/db.js'
import { answerQuery, buildAndIndexEpisodes, findSessionEntry, indexSessionFile, listSessionEntries } from './lib/pipeline.js'
import { DEFAULT_ONEBOT_HINT_PATTERNS } from './lib/parse.js'
import { buildAndIndexEpisodesLLM } from './lib/aggregate.js'
import { searchView, readView } from './lib/memory-tools.js'
import { relinkView } from './lib/relink.js'
import { migrate, getProfile } from './lib/store.js'
import { applyEpisode, applyScene, buildIncrementalPrompt, buildScenePrompt, callExtractWithRetry, parseJsonLoose } from './lib/extract.js'

export const name = 'dsh-memories-as-we-wish'
export const inject = []

// 诊断用：注册回调里拿到的 tools 服务引用；pre-step 用它对比全局可见性。
// 只观测，不参与注册逻辑。
let toolsRegistry = null

/** 终端根：显式配置 > DSH_HOME > DSH 默认的 ~/.dsh。 */
export function resolveHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return fromEnv || join(homedir(), '.dsh')
}

/** db 路径：显式配置 > 环境变量 > 终端根下的正式插件目录 > 内存库。 */
export function resolveDbPath(cfg = {}, env = process.env) {
  return cfg.dbPath || env.DSH_V2_DB || join(resolveHome(env), 'dsh-memories-as-we-wish', 'index.sqlite')
}

/** 剩余磁盘字节数；失败时返回 null，由调用方降级为“不拦”。 */
export function freeDiskBytes(path) {
  try {
    const st = statfsSync(path, { bigint: true })
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/** 全局串行闸门：同一时刻只允许一个任务进入，失败不阻塞后续。 */
export function createSerialGate() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.then(() => {}, () => {})
    return run
  }
}

/** 低磁盘暂停：低于阈值时 journal 一次，恢复后自动继续；无法取剩余空间则不拦。 */
export async function waitForDisk({
  label,
  path,
  minFreeBytes,
  pauseMs = 60_000,
  journal = () => {},
  log = () => {},
  getFreeBytes = freeDiskBytes,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const need = Number(minFreeBytes) || 0
  if (need <= 0) return { paused: false, freeBytes: getFreeBytes(path) }
  let paused = false
  for (;;) {
    const free = getFreeBytes(path)
    if (free === null || free >= need) {
      if (paused) {
        journal('rebuild-resumed-lowdisk', { label, freeBytes: free })
        log('info', `rebuild resumed lowdisk label=${label} free=${free}`)
      }
      return { paused, freeBytes: free }
    }
    if (!paused) {
      journal('rebuild-paused-lowdisk', { label, freeBytes: free, needBytes: need, path })
      log('warn', `rebuild paused lowdisk label=${label} free=${free} need=${need}`)
      paused = true
    }
    await sleep(pauseMs)
  }
}

/** 分批执行：每批前 beforeBatch，批末让出事件循环并采样，不保留批内结果。 */
export async function scanInBatches(entries, processEntry, {
  batchSize = 5,
  beforeBatch = async () => {},
  afterBatch = async () => {},
  yieldFn = () => new Promise(resolve => setImmediate(resolve)),
} = {}) {
  const size = Math.max(1, Number(batchSize) || 5)
  for (let i = 0; i < entries.length; i++) {
    if (i % size === 0) await beforeBatch(i)
    await processEntry(entries[i], i)
    if ((i + 1) % size === 0 || i + 1 === entries.length) {
      await afterBatch(i + 1)
      await yieldFn()
    }
  }
}

/**
 * 历史脏数据迁移：把旧 aggSkipped 中除 no-episodes 外的值改成 aggRetryAt。
 * 冷却中的段仍然计入 pending；no-episodes 保留永久跳过。
 */
export function migrateAggRetries(handle, { now = Date.now() } = {}) {
  const rows = handle.db.prepare(
    "SELECT key, value FROM meta WHERE key LIKE 'aggSkipped:%' AND value != 'no-episodes'"
  ).all()
  let count = 0
  const reasons = {}
  for (const row of rows) {
    const m = String(row.key).match(/^aggSkipped:(.+):(\d+):(\d+)$/)
    if (!m) continue
    const [, sid, start, end] = m
    const reason = String(row.value ?? '')
    const retryKey = `aggRetryAt:${sid}:${start}:${end}`
    try {
      handle.setMeta(retryKey, JSON.stringify({ attempts: 1, nextAt: Number(now), lastReason: reason }))
      handle.deleteMeta?.(row.key)
      count++
      reasons[reason] = (reasons[reason] || 0) + 1
    } catch { /* best effort */ }
  }
  if (count > 0) {
    handle.journal('agg-retry-migrated', { count, reasons, nextAt: Number(now) })
  }
  return { count, reasons }
}

/** 待回填段：有价值、没有 LLM 聚合缓存、且不是永久 no-episodes；冷却中的段也计入。 */
export function countPendingSegments(db) {
  try {
    return Number(db.prepare(`
      SELECT COUNT(*) n FROM episodes_v2 e
      WHERE COALESCE(e.valuable, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM episode_aggregates a
          WHERE a.session_id = e.session_id AND a.start_seq = e.start_seq AND a.end_seq = e.end_seq
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta m
          WHERE m.key = 'aggSkipped:' || e.session_id || ':' || e.start_seq || ':' || e.end_seq
        )
    `).get().n)
  } catch { return 0 }
}

/** 某个会话的待回填段。 */
export function countPendingSegmentsIn(db, sessionId) {
  try {
    return Number(db.prepare(`
      SELECT COUNT(*) n FROM episodes_v2 e
      WHERE e.session_id = ?
        AND COALESCE(e.valuable, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM episode_aggregates a
          WHERE a.session_id = e.session_id AND a.start_seq = e.start_seq AND a.end_seq = e.end_seq
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta m
          WHERE m.key = 'aggSkipped:' || e.session_id || ':' || e.start_seq || ':' || e.end_seq
        )
    `).get(sessionId).n)
  } catch { return 0 }
}

/** 最后一条消息已超过 idleMs 的会话（是否还有欠账由调用方结合 countPendingSegmentsIn 判断）。 */
export function findIdleSessionIds(db, { now = Date.now(), idleMs = 24 * 3600 * 1000 } = {}) {
  try {
    return db.prepare(`
      SELECT session_id, MAX(time) AS lastTime
      FROM messages
      GROUP BY session_id
      HAVING MAX(time) < ?
    `).all(Number(now) - Math.max(0, Number(idleMs) || 0)).map(r => r.session_id)
  } catch { return [] }
}

/** 节流回填是否启动：全局积压达到阈值，或存在 24h 未活跃且仍有欠账的会话。 */
export function backfillShouldRun(pending, minPending = 60, idleSessionIds = []) {
  return Number(pending) >= Number(minPending) || (Array.isArray(idleSessionIds) && idleSessionIds.length > 0)
}

/** 最旧的、已稳定且不在最近 N 段内的待回填段；idle 会话优先。 */
export function pickOldestPendingSegment(db, {
  now = Date.now(),
  minAgeMs = 10 * 60 * 1000,
  stableSegments = 2,
  idleSessionIds = [],
} = {}) {
  try {
    const rows = db.prepare(`
      SELECT e.session_id, e.start_seq, e.end_seq, e.start_at, e.end_at
      FROM episodes_v2 e
      WHERE COALESCE(e.valuable, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM episode_aggregates a
          WHERE a.session_id = e.session_id AND a.start_seq = e.start_seq AND a.end_seq = e.end_seq
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta m
          WHERE m.key = 'aggSkipped:' || e.session_id || ':' || e.start_seq || ':' || e.end_seq
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta m
          WHERE m.key = 'aggRetryAt:' || e.session_id || ':' || e.start_seq || ':' || e.end_seq
            AND json_valid(m.value)
            AND COALESCE(json_extract(m.value, '$.nextAt'), 0) > ?
        )
      ORDER BY e.start_at ASC, e.start_seq ASC
    `).all(Number(now))
    const bySession = new Map()
    for (const row of rows) {
      if (!bySession.has(row.session_id)) bySession.set(row.session_id, [])
      bySession.get(row.session_id).push(row)
    }
    const excluded = new Set()
    const stable = Math.max(0, Number(stableSegments) || 0)
    for (const list of bySession.values()) {
      list.sort((a, b) => Number(b.end_seq) - Number(a.end_seq))
      for (const row of list.slice(0, stable)) excluded.add(`${row.session_id}|${row.start_seq}|${row.end_seq}`)
    }
    const cutoff = Number(now) - Math.max(0, Number(minAgeMs) || 0)
    const idleSet = new Set(Array.isArray(idleSessionIds) ? idleSessionIds : [])
    let fallback = null
    for (const row of rows) {
      if (excluded.has(`${row.session_id}|${row.start_seq}|${row.end_seq}`)) continue
      if (Number(row.end_at) > cutoff) continue
      if (idleSet.has(row.session_id)) return row
      if (!fallback) fallback = row
    }
    return fallback
  } catch { return null }
}

/** 内存阈值判断（独立可测）。 */
export function backfillMemoryExceeded(mem, { heapBytes = 600 * 1024 ** 2, rssBytes = 900 * 1024 ** 2 } = {}) {
  return Number(mem?.heapUsed ?? 0) > Number(heapBytes) || Number(mem?.rss ?? 0) > Number(rssBytes)
}

/**
 * 完成一段回填后的内存释放：
 * 1) PRAGMA shrink_memory 把 SQLite 页缓存还给系统；2) 让出事件循环；
 * 3) 有 --expose-gc 时调用 global.gc，没有则安静跳过。
 */
export async function releaseBackfillMemory({
  db,
  gc = globalThis.gc,
  setImmediateFn = setImmediate,
  memoryUsage = () => process.memoryUsage(),
} = {}) {
  const before = memoryUsage()
  try { db?.exec?.('PRAGMA shrink_memory') } catch { /* best effort */ }
  await new Promise(resolve => setImmediateFn(resolve))
  try { if (typeof gc === 'function') gc() } catch { /* best effort */ }
  const after = memoryUsage()
  return {
    rssBeforeMB: Math.round(Number(before?.rss ?? 0) / 1048576),
    rssAfterMB: Math.round(Number(after?.rss ?? 0) / 1048576),
    heapBeforeMB: Math.round(Number(before?.heapUsed ?? 0) / 1048576),
    heapAfterMB: Math.round(Number(after?.heapUsed ?? 0) / 1048576),
  }
}

/** 一个会话回填结束后的收尾：统计剩余欠账、释放内存、按需记 session-done。 */
export async function finishBackfillSession({
  db,
  sessionId,
  memBefore = null,
  journal = () => {},
  log = () => {},
  countPending = countPendingSegmentsIn,
  release = releaseBackfillMemory,
} = {}) {
  const pending = Number(countPending(db, sessionId))
  const rel = await release({ db })
  journal('backfill-memory-release', { sessionId, ...rel, pending })
  if (pending === 0) {
    const detail = {
      sessionId,
      rssBeforeMB: memBefore ? Math.round(Number(memBefore.rss ?? 0) / 1048576) : rel.rssBeforeMB,
      rssAfterMB: rel.rssAfterMB,
      heapBeforeMB: memBefore ? Math.round(Number(memBefore.heapUsed ?? 0) / 1048576) : rel.heapBeforeMB,
      heapAfterMB: rel.heapAfterMB,
    }
    journal('backfill-session-done', detail)
    log(`backfill session done ${sessionId} rss=${detail.rssBeforeMB}->${detail.rssAfterMB}MB`)
  }
  return { pending, ...rel }
}

/** 连续失败达到阈值才暂停；独立可测。 */
export function backfillFailureNeedsPause(failures, threshold = 3) {
  return Number(failures) >= Number(threshold)
}

const DEFAULTS = {
  enabled: true,
  sessionsRoot: '',
  dbPath: '',
  entities: [],
  /** onebot 渠道提示行短语；只有整行被括号包住且命中短语才会剥离。 */
  onebotHintPatterns: DEFAULT_ONEBOT_HINT_PATTERNS,
  gateThreshold: 0.55,
  limit: 10,
  /** 每轮结束增量索引（单次最多读这么多帧） */
  indexOnTurnStop: true,
  /** P1 结算节奏（规格 §P1：增量每 8 轮、场景每 40 轮 / 告别 / 空闲） */
  settleEvery: 8,
  sceneEvery: 40,
  sceneIdleMs: 30 * 60 * 1000,
  extractMaxTokens: 4000,
  /** 单次 LLM 调用超时；超时让该会话 failed 后跳过，不能卡死整条初建队列 */
  aggregateCallTimeoutMs: 90_000,
  /** 初建队列每个会话之间的间隔（毫秒） */
  initialRebuildBatchDelayMs: 5000,
  /** 全终端扫描每批多少个会话后让出事件循环（越小峰值越低、启动越慢） */
  terminalScanBatchSize: 5,
  /** 重建前剩余空间不足此值时暂停（字节）；默认 30GB */
  minFreeDiskBytes: 30 * 1024 ** 3,
  /** 低磁盘暂停后的复查间隔 */
  lowDiskPauseMs: 60_000,
  /** 常驻节流回填：每 30 秒检查一次，每次最多 5 段，速率 12 次/分钟 */
  backfillEnabled: true,
  backfillIntervalMs: 30_000,
  backfillBatch: 5,
  backfillCallsPerMinute: 12,
  /** 只有积压达到此段数才启动节流回填；低于它交给 20 轮触发收尾 */
  backfillMinPending: 60,
  /** 最后一条消息超过此时间的会话，即使全局积压不足也优先回填 */
  backfillIdleSessionMs: 24 * 3600 * 1000,
  /** 节流回填只补历史：最近 2 段、最近 10 分钟内的段不碰，收尾交给 20 轮触发 */
  backfillStableSegments: 2,
  backfillMinAgeMs: 10 * 60 * 1000,
  /** 内存护栏：超过任一阈值暂停 60 秒；上限压在 1GB 以内 */
  backfillMemHeapBytes: 600 * 1024 ** 2,
  backfillMemRssBytes: 900 * 1024 ** 2,
  backfillMemPauseMs: 60_000,
  /** 连续失败 3 段暂停 5 分钟 */
  backfillFailuresBeforePause: 3,
  backfillFailurePauseMs: 300_000,
  debugLog: '',
  /** 工具注册/自愈/调用诊断日志；默认关闭，发布版不写探针 */
  debugTools: false,
}

/**
 * 旧代码只写 llmAggDone:<sid>；首次升级时把它归一成 initialRebuildDone:<sid>，
 * 避免重启后把已经聚合好的会话再烧一遍 token。
 */
export function backfillInitialRebuildDone(all, getMeta = () => '', setMeta = () => {}) {
  let count = 0
  for (const sid of new Set(all)) {
    if (!sid) continue
    if (getMeta(`initialRebuildDone:${sid}`) === '1') continue
    if (getMeta(`llmAggDone:${sid}`) === '1') {
      setMeta(`initialRebuildDone:${sid}`, '1')
      count++
    }
  }
  return count
}

/** 初建队列：已完成 / 已失败 / 已有 llmAggDone 的会话都不再跑。 */
export function initialRebuildPending(all, getMeta = () => '') {
  const seen = new Set()
  return [...all].filter((sid) => {
    if (!sid || seen.has(sid)) return false
    seen.add(sid)
    if (getMeta(`initialRebuildDone:${sid}`) === '1') return false
    if (getMeta(`initialRebuildFailed:${sid}`) === '1') return false
    if (getMeta(`llmAggDone:${sid}`) === '1') return false
    return true
  })
}

/**
 * 串行处理初建队列；每个会话独立落断点，单会话失败只标记并跳过，不阻塞后续。
 * 纯函数式回调，便于单测“断点续跑 / 失败跳过”。
 */
export async function runInitialRebuildQueue({
  pending,
  aggregate,
  setMeta = () => {},
  journal = () => {},
  log = () => {},
  delayMs = 0,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  let done = 0
  let failed = 0
  for (const sid of pending) {
    const position = done + failed + 1
    journal('initial-rebuild-session-started', { sessionId: sid, position, total: pending.length })
    try {
      const result = await aggregate(sid)
      if (result?.error) throw new Error(String(result.error))
      if (result?.batchExhausted) {
        journal('initial-rebuild-session-paused', {
          sessionId: sid, position, total: pending.length,
          attemptedSegments: result.attemptedSegments ?? 0,
        })
        return { done, failed, paused: true }
      }
      done++
      setMeta(`initialRebuildDone:${sid}`, '1')
      journal('initial-rebuild-session-done', {
        sessionId: sid, position, total: pending.length,
        segments: result?.segments ?? 0, episodes: result?.episodes ?? 0,
      })
    } catch (error) {
      failed++
      setMeta(`initialRebuildFailed:${sid}`, '1')
      const message = String(error?.message ?? error)
      journal('initial-rebuild-session-failed', { sessionId: sid, position, total: pending.length, error: message })
      log('warn', `initial-rebuild session=${sid} failed（已跳过）：${message}`)
    }
    journal('initial-rebuild-progress', { done: done + failed, total: pending.length, succeeded: done, failed })
    log('info', `initial-rebuild progress=${done + failed}/${pending.length} succeeded=${done} failed=${failed}`)
    if (delayMs > 0 && done + failed < pending.length) await sleep(delayMs)
  }
  return { done, failed }
}

const log = (cfg, level, msg) => {
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  if (!cfg.debugLog) return
  try { appendFileSync(cfg.debugLog, line + '\n') } catch { /* ignore */ }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config, debugLog: config.debugLog || process.env.DSH_V2_DEBUG_LOG || '' }
  if (!cfg.enabled) return
  const sessionsRoot = cfg.sessionsRoot || process.env.DSH_V2_SESSIONS || join(resolveHome(), 'sessions')
  const dbPath = resolveDbPath(cfg)
  if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true })
  const handle = openDb(dbPath)
  migrate(handle.db)
  // 启动时按“首 session 事件”判定子代理，一次性清掉它们的索引。
  // 解析失败按根会话处理（宁可多索引，不误删用户会话）；清理失败不阻断启动。
  const subagentIds = new Set()
  try {
    const entries = listSessionEntries(sessionsRoot, { withOrigin: true })
    for (const entry of entries) if (entry.isSubagent) subagentIds.add(entry.sessionId)
    if (subagentIds.size) {
      const purged = handle.purgeSessions([...subagentIds], (kind, detail) => handle.journal(kind, detail))
      log(cfg, 'info', `subagent purge sessions=${purged.sessions} before=${JSON.stringify(purged.before)} after=${JSON.stringify(purged.after)}`)
    }
  } catch (error) {
    log(cfg, 'warn', `subagent purge 跳过（已忽略）：${String(error?.message ?? error)}`)
  }
  try {
    const migrated = migrateAggRetries(handle)
    if (migrated.count > 0) log(cfg, 'info', `agg retry migrated=${migrated.count} ${JSON.stringify(migrated.reasons)}`)
  } catch (error) {
    log(cfg, 'warn', `agg retry migration 跳过（已忽略）：${String(error?.message ?? error)}`)
  }
  log(cfg, 'info', `v2 已启用；db=${dbPath} sessionsRoot=${sessionsRoot}`)

  // 只在 debugLog 打开时采样；用于确认长队列/全终端扫描是否持续抬升堆。
  const logMemory = (label) => {
    if (!cfg.debugLog) return
    try {
      const m = process.memoryUsage()
      log(cfg, 'info', `memory ${label} rss=${Math.round(m.rss / 1048576)}MB heapUsed=${Math.round(m.heapUsed / 1048576)}MB external=${Math.round(m.external / 1048576)}MB`)
    } catch { /* ignore */ }
  }
  // ---------- 工具注册/自愈 ----------
  // 全局注册与 agent scope 注册分开：qfish 这类 agent preset 可能用 tools.restrict
  // 把全局工具挡在远处，单靠全局注册模型侧就看不到；agent scope 自己的注册不受限制。
  let toolDefs = []
  let globalTools = null
  let healingTools = false
  const activeAgents = new Set()
  const agentRegisterCounts = new Map()
  const toolsSchemasSeen = new Map()
  const MEMORY_TOOL_NAMES = ['memory_recall', 'memory_remember', 'memory_relink']
  const debugJournal = (kind, detail) => {
    if (cfg.debugTools) safeJournal(handle, kind, detail)
  }

  const toolsSelfheal = (name, scope, ok, error, reason) => {
    debugJournal('tools-selfheal', {
      name, scope, ok, reason,
      ...(error ? { error: String(error?.message ?? error) } : {}),
    })
  }

  const isInactiveContextError = (error) => /inactive context/i.test(String(error?.message ?? error))
  const isAlreadyRegisteredError = (error) => /already\s+(?:registered|exists)|already registered in this scope/i.test(String(error?.message ?? error))

  const ensureGlobalTools = (reason = '') => {
    if (!globalTools?.register || toolDefs.length === 0) return 0
    let changed = 0
    for (const def of toolDefs) {
      let visible = false
      try { visible = !!globalTools.get?.(def.name) } catch { visible = false }
      if (visible) continue
      try {
        globalTools.register(def)
        changed++
        toolsSelfheal(def.name, 'global', true, null, reason)
      } catch (error) {
        if (isInactiveContextError(error)) break
        toolsSelfheal(def.name, 'global', false, error, reason)
      }
    }
    return changed
  }

  const ensureAgentTools = (agent, reason = '') => {
    const tools = agent?.ctx?.tools
    if (!tools?.register || toolDefs.length === 0) return 0
    const sessionId = String(agent?.session?.header?.id ?? agent?.id ?? 'unknown')
    let count = agentRegisterCounts.get(sessionId) ?? 0
    let registered = 0
    for (const def of toolDefs) {
      count += 1
      try {
        // 无条件注册到该 agent 自己的 scope。同名已在当前 scope 注册时，
        // DSH 会拒绝重复插入；那说明它已经在了，按成功处理。
        tools.register(def)
        registered += 1
        agentRegisterCounts.set(sessionId, count)
        debugJournal('tools-agent-register', { sessionId, name: def.name, ok: true, already: false, reason, count })
        toolsSelfheal(def.name, 'agent', true, null, reason)
      } catch (error) {
        if (isInactiveContextError(error)) {
          activeAgents.delete(agent)
          break
        }
        agentRegisterCounts.set(sessionId, count)
        if (isAlreadyRegisteredError(error)) {
          debugJournal('tools-agent-register', { sessionId, name: def.name, ok: true, already: true, reason, count })
          continue
        }
        debugJournal('tools-agent-register', { sessionId, name: def.name, ok: false, already: false, reason, count, error: String(error?.message ?? error) })
        toolsSelfheal(def.name, 'agent', false, error, reason)
      }
    }
    agentRegisterCounts.set(sessionId, count)
    return registered
  }

  const healAllTools = (reason = '') => {
    if (healingTools) return
    healingTools = true
    try {
      ensureGlobalTools(reason)
      for (const agent of activeAgents) ensureAgentTools(agent, reason)
    } finally {
      healingTools = false
    }
  }

  const schemaNames = (schemas) => schemas
    .map(schema => schema?.name ?? schema?.function?.name)
    .filter(name => typeof name === 'string')

  const journalToolsSchemas = (agent) => {
    if (!cfg.debugTools) return
    const sessionId = String(agent?.session?.header?.id ?? agent?.id ?? 'unknown')
    const agentId = String(agent?.id ?? 'unknown')
    const sessionKey = `${sessionId}\u0000${agentId}`
    try {
      const runtime = globalTools
      if (!runtime?.schemas) return
      const agentSchemas = agent ? runtime.schemas(agent) : []
      const globalSchemas = runtime.schemas()
      const agentNames = schemaNames(agentSchemas)
      const globalNames = schemaNames(globalSchemas)
      const agentHasMem = MEMORY_TOOL_NAMES.filter(name => agentNames.includes(name))
      const globalHasMem = MEMORY_TOOL_NAMES.filter(name => globalNames.includes(name))
      const signature = `${agentNames.length}:${globalNames.length}:${agentHasMem.join(',')}`
      const previous = toolsSchemasSeen.get(sessionKey)
      if (previous === signature) return
      toolsSchemasSeen.set(sessionKey, signature)
      let presentation = 'unknown'
      try { presentation = runtime.modeFor?.(agent) ?? 'unknown' } catch {}
      debugJournal('tools-schemas', {
        sessionId,
        agentId,
        scopeKind: agent ? 'agent' : 'global',
        agentCount: agentNames.length,
        globalCount: globalNames.length,
        agentHasMem,
        globalHasMem,
        ...(agentNames.length <= 25 ? { shortNames: agentNames } : {}),
        presentation,
      })
    } catch (error) {
      debugJournal('tools-schemas', {
        sessionId,
        agentId,
        scopeKind: agent ? 'agent' : 'global',
        error: String(error?.message ?? error),
      })
    }
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const waitDisk = (label) => waitForDisk({
    label,
    path: sessionsRoot || resolveHome(),
    minFreeBytes: cfg.minFreeDiskBytes,
    pauseMs: cfg.lowDiskPauseMs,
    journal: (kind, detail) => handle.journal(kind, detail),
    log: (level, message) => log(cfg, level, message),
    sleep,
  })

  // ---------- P1 结算（需要模型；无 llm 时静默跳过）----------
  let llmRef = null
  ctx.inject(['llm'], (scope) => {
    llmRef = scope.llm
    log(cfg, 'info', 'llm 就绪，聚合触发已武装')
    // 首次安装：全局会话分批静默重建（fire-and-forget）
    setTimeout(() => { initialRebuild().catch((error) => log(cfg, 'warn', `initial-rebuild 异常：${String(error?.message ?? error)}`)) }, 3000)
  })


  const pendingMessages = (sessionId, afterSeq) =>
    handle.db.prepare('SELECT seq, role, time, text FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq').all(sessionId, afterSeq)

  async function settleNow(agent, mode, turn) {
    const header = agent?.session?.header
    if (!header || !llmRef) return
    const id = header.id
    const settledSeq = Number(handle.getMeta(`settledSeq:${id}`) ?? 0)
    const msgs = pendingMessages(id, settledSeq)
    if (!msgs.length) return
    const from = msgs[0].seq, to = msgs[msgs.length - 1].seq
    const profile = getProfile(handle.db)
    const prompt = mode === 'scene' ? buildScenePrompt(msgs, { profile }) : buildIncrementalPrompt(msgs)
    const r = await callExtractWithRetry(llmRef, { prompt, maxTokens: cfg.extractMaxTokens })
    const data = r.ok ? parseJsonLoose(r.text) : null
    if (!data) {
      handle.journal('settle-failed', { sessionId: id, mode, from, to, error: r.ok ? 'json-parse-failed' : r.error, textLen: String(r.text ?? '').length })
      log(cfg, 'warn', `结算失败（${mode}）：${r.ok ? 'JSON 解析失败' : r.error}`)
      return
    }
    const stats = mode === 'scene'
      ? applyScene(handle.db, data, { sessionId: id, from, to, journal: (k, d) => handle.journal(k, d) })
      : (() => {
          const out = { episodes: 0, episodesRejected: 0 }
          for (const ep of data?.episodes ?? []) {
            const ok = applyEpisode(handle.db, ep, { sessionId: id, from, to, journal: (k, d) => handle.journal(k, d) })
            if (ok.accepted) out.episodes++; else out.episodesRejected++
          }
          return out
        })()
    handle.setMeta(`settledSeq:${id}`, to)
    handle.setMeta(`settleTurn:${id}`, turn)
    if (mode === 'scene') handle.setMeta(`sceneTurn:${id}`, turn)
    handle.journal('settle-done', { sessionId: id, mode, from, to, stats })
    log(cfg, 'info', `结算完成（${mode}）：${JSON.stringify(stats)}`)
  }

  const lastSeq = new Map() // sessionId -> last indexed seq
  const aggregating = new Set() // 防止同一会话并发聚合
  // 全局串行闸门：初建队列、每 20 轮聚合、静默 24h 聚合、常驻回填共用。
  // 之前只按 session 去重；不同会话仍可能同时各跑一份 LLM prompt，
  // 在系统 commit 紧张时放大内存峰值。现在始终只有一个聚合在跑。
  const runSerial = createSerialGate()

  // 常驻回填状态。断点=库里还有没整理完的段，重启后按库续跑。
  const backfill = {
    timer: null, running: false, pauseUntil: 0, failures: 0,
    totalDone: 0, callTimes: [], complete: false,
  }
  const turnActivity = new Map() // sessionId -> last pre-step timestamp
  const touchTurn = (sid) => { if (sid) turnActivity.set(sid, Date.now()) }
  const clearTurn = (sid) => { if (sid) turnActivity.delete(sid) }
  const isAnyTurnActive = () => {
    const now = Date.now()
    for (const [sid, ts] of turnActivity) {
      if (now - ts > 10 * 60 * 1000) turnActivity.delete(sid)
    }
    return turnActivity.size > 0
  }
  const sidOf = (payload) => {
    const agent = payload?.agent
    const h = agent?.session?.header ?? agent?.header ?? agent?.session
    return h?.id ?? h?.sessionId ?? agent?.session?.id ?? payload?.sessionId ?? null
  }
  const checkBackfillMemory = () => {
    let m
    try { m = process.memoryUsage() } catch { return true }
    if (backfillMemoryExceeded(m, { heapBytes: cfg.backfillMemHeapBytes, rssBytes: cfg.backfillMemRssBytes })) {
      backfill.pauseUntil = Date.now() + cfg.backfillMemPauseMs
      handle.journal('backfill-paused-mem', {
        rss: m.rss, heapUsed: m.heapUsed,
        rssMB: Math.round(m.rss / 1048576), heapMB: Math.round(m.heapUsed / 1048576),
        pauseMs: cfg.backfillMemPauseMs,
      })
      log(cfg, 'info', `backfill paused: memory rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB`)
      return false
    }
    return true
  }

  const aggregateNow = (id, { includeTail = false, maxEndSeq = Infinity, maxSegments = Infinity, beforeLlmCall = null, markDone = true } = {}) => {
    if (aggregating.has(id)) return Promise.resolve({ skipped: 'busy', segments: 0, episodes: 0, error: null })
    if (!llmRef) return Promise.resolve({ skipped: 'no-llm', segments: 0, episodes: 0, error: 'no-llm' })
    aggregating.add(id)
    const run = async () => {
      // 测试钩子：模拟慢聚合，验证“后台不阻塞下一轮”；生产不设 env
      const slow = Number(process.env.DSH_V2_AGG_SLOW_MS)
      if (Number.isFinite(slow) && slow > 0) await new Promise(r => setTimeout(r, slow))
      const before = Number(handle.db.prepare('SELECT COUNT(*) n FROM episode_aggregates WHERE session_id = ?').get(id).n)
      try {
        // 测试钩子：隔离环境验证“失败降级”用；生产不设该 env
        if (process.env.DSH_V2_AGG_FORCE_FAIL === '1') throw new Error('forced aggregate failure (test)')
        const eps = await buildAndIndexEpisodesLLM(handle, id, {
          llm: llmRef, includeTail, maxEndSeq, maxSegments, beforeLlmCall,
          callTimeoutMs: Number(cfg.aggregateCallTimeoutMs) || 90_000,
          entities: cfg.entities,
        })
        const after = Number(handle.db.prepare('SELECT COUNT(*) n FROM episode_aggregates WHERE session_id = ?').get(id).n)
        const segments = Math.max(0, after - before)
        const attemptedSegments = Number(eps?.attemptedSegments ?? 0)
        const llmCalls = Number(eps?.llmCalls ?? attemptedSegments)
        if (eps?.batchExhausted) {
          handle.journal('aggregate-batch-paused', {
            sessionId: id, segments, episodes: eps.length, attemptedSegments,
            maxSegments: Number.isFinite(Number(maxSegments)) ? Number(maxSegments) : null,
          })
          return { skipped: null, segments, episodes: eps.length, error: null, batchExhausted: true, attemptedSegments, llmCalls }
        }
        handle.journal('aggregate', { sessionId: id, episodes: eps.length, segments })
        if (markDone) handle.setMeta(`llmAggDone:${id}`, '1')
        return { skipped: null, segments, episodes: eps.length, error: null, batchExhausted: false, attemptedSegments, llmCalls }
      } catch (error) {
        // 机械 episodes 已在 indexNow 建好；只记录，不阻塞
        log(cfg, 'warn', `LLM 聚合失败（保留确定性 episodes）：${String(error?.message ?? error)}`)
        handle.journal('aggregate-failed', { sessionId: id, error: String(error?.message ?? error) })
        return { skipped: null, segments: 0, episodes: 0, error: String(error?.message ?? error) }
      } finally {
        aggregating.delete(id)
        logMemory(`aggregate ${id}`)
      }
    }
    return runSerial(run)
  }

  // 每 20 轮：增量重建索引（LLM 聚合未缓存段）；后台跑，不阻塞
  const aggregateOnTurn = (id, turn, { maxEndSeq = Infinity } = {}) => {
    if (aggregating.has(id)) {
      handle.setMeta(`aggPending:${id}`, String(turn))
      log(cfg, 'info', `aggregate-trigger turn=${turn} queued (busy)`)
      return
    }
    aggregateNow(id, { includeTail: true, maxEndSeq }).then((r) => {
      const segments = r.segments ?? 0
      handle.journal('aggregate-trigger', { sessionId: id, turn, segments, episodes: r.episodes ?? 0, error: r.error ?? null, skipped: r.skipped ?? null })
      if (r.error) log(cfg, 'warn', `aggregate-trigger turn=${turn} segments=${segments} failed=${r.error}`)
      else log(cfg, 'info', `aggregate-trigger turn=${turn} segments=${segments}`)
      const pending = handle.getMeta(`aggPending:${id}`)
      if (pending) { handle.setMeta(`aggPending:${id}`, ''); aggregateOnTurn(id, pending) }
    }).catch((error) => {
      log(cfg, 'warn', `aggregate-trigger turn=${turn} 异常（降级机械）：${String(error?.message ?? error)}`)
    })
  }

  const pruneBackfillCalls = () => {
    const cutoff = Date.now() - 60_000
    backfill.callTimes = backfill.callTimes.filter(t => t >= cutoff)
  }

  async function backfillTick() {
    if (!cfg.backfillEnabled || !llmRef || backfill.running) return
    if (aggregating.size > 0) return // 正在增量聚合，跳过本 tick
    if (isAnyTurnActive()) return // 不打扰对话
    if (Date.now() < backfill.pauseUntil) return
    backfill.running = true
    let sessionId = null
    let sessionMemBefore = null
    let pendingAfterSession = null
    try {
      await waitDisk('backfill')
      if (!checkBackfillMemory()) return
      pruneBackfillCalls()
      const remaining = countPendingSegments(handle.db)
      if (!remaining) {
        if (!backfill.complete) {
          backfill.complete = true
          handle.journal('backfill-complete', { totalDone: backfill.totalDone })
          log(cfg, 'info', `backfill complete totalDone=${backfill.totalDone}`)
        }
        return
      }
      const minPending = Math.max(1, Number(cfg.backfillMinPending) || 60)
      const now = Date.now()
      const idleCandidates = findIdleSessionIds(handle.db, {
        now,
        idleMs: Number(cfg.backfillIdleSessionMs) || 24 * 3600 * 1000,
      })
      const idleSessionIds = idleCandidates.filter(id => countPendingSegmentsIn(handle.db, id) > 0)
      const reason = idleSessionIds.length ? 'idle-session' : 'global-backlog'
      if (!backfillShouldRun(remaining, minPending, idleSessionIds)) {
        if (!backfill.complete) {
          backfill.complete = true
          handle.journal('backfill-complete', { totalDone: backfill.totalDone, remaining, minPending })
          log(cfg, 'info', `backfill idle remaining=${remaining} minPending=${minPending} idleSessions=${idleSessionIds.length}`)
        }
        return
      }
      backfill.complete = false
      const seg = pickOldestPendingSegment(handle.db, {
        now,
        minAgeMs: Number(cfg.backfillMinAgeMs) || 10 * 60 * 1000,
        stableSegments: Number(cfg.backfillStableSegments) || 2,
        idleSessionIds,
      })
      if (!seg) return
      const rateLeft = Math.max(0, Number(cfg.backfillCallsPerMinute) - backfill.callTimes.length)
      if (rateLeft <= 0) return
      const limit = Math.max(1, Math.min(Number(cfg.backfillBatch) || 5, rateLeft))
      sessionId = seg.session_id
      try { sessionMemBefore = process.memoryUsage() } catch { /* ignore */ }
      let result = await aggregateNow(seg.session_id, {
        includeTail: false,
        maxSegments: limit,
        beforeLlmCall: checkBackfillMemory,
        markDone: false,
      })
      const calls = Number(result?.llmCalls ?? result?.attemptedSegments ?? 0)
      const callNow = Date.now()
      for (let i = 0; i < calls; i++) backfill.callTimes.push(callNow)
      if (result?.error) {
        backfill.failures++
        if (backfillFailureNeedsPause(backfill.failures, cfg.backfillFailuresBeforePause)) {
          backfill.pauseUntil = Date.now() + Number(cfg.backfillFailurePauseMs)
          handle.journal('backfill-paused-failures', {
            failures: backfill.failures, sessionId: seg.session_id,
            pauseMs: Number(cfg.backfillFailurePauseMs),
          })
          log(cfg, 'warn', `backfill paused failures=${backfill.failures}`)
          backfill.failures = 0
        }
      } else {
        backfill.failures = 0
        if (!result?.batchExhausted) handle.setMeta(`llmAggDone:${seg.session_id}`, '1')
      }
      backfill.totalDone += Number(result?.segments ?? 0)
      const after = countPendingSegments(handle.db)
      pendingAfterSession = countPendingSegmentsIn(handle.db, sessionId)
      let mem = {}
      try { mem = process.memoryUsage() } catch { /* ignore */ }
      handle.journal('backfill-progress', {
        remaining: after,
        doneThisTick: Number(result?.segments ?? 0),
        attemptedSegments: Number(result?.attemptedSegments ?? 0),
        llmCalls: calls,
        totalDone: backfill.totalDone,
        rssMB: Math.round(Number(mem.rss ?? 0) / 1048576),
        heapMB: Math.round(Number(mem.heapUsed ?? 0) / 1048576),
        reason,
        idleSessions: idleSessionIds.length,
      })
      log(cfg, 'info', `backfill remaining=${after} done=${result?.segments ?? 0} total=${backfill.totalDone} reason=${reason} session=${seg.session_id}`)
      if (after === 0) {
        backfill.complete = true
        handle.journal('backfill-complete', { totalDone: backfill.totalDone })
      }
      result = null
    } catch (error) {
      log(cfg, 'warn', `backfill tick 异常：${String(error?.message ?? error)}`)
    } finally {
      if (sessionId) {
        try {
          const release = await releaseBackfillMemory({ db: handle.db })
          handle.journal('backfill-memory-release', {
            sessionId,
            ...release,
            pending: pendingAfterSession,
          })
          if (pendingAfterSession === 0) {
            handle.journal('backfill-session-done', {
              sessionId,
              rssBeforeMB: sessionMemBefore ? Math.round(Number(sessionMemBefore.rss ?? 0) / 1048576) : release.rssBeforeMB,
              rssAfterMB: release.rssAfterMB,
              heapBeforeMB: sessionMemBefore ? Math.round(Number(sessionMemBefore.heapUsed ?? 0) / 1048576) : release.heapBeforeMB,
              heapAfterMB: release.heapAfterMB,
            })
            log(cfg, 'info', `backfill session done ${sessionId} rss=${release.rssBeforeMB}->${release.rssAfterMB}MB`)
          }
        } catch (error) {
          log(cfg, 'warn', `backfill 内存释放异常（已忽略）：${String(error?.message ?? error)}`)
        }
      }
      backfill.running = false
    }
  }

  if (cfg.backfillEnabled) {
    const startTimer = () => {
      if (backfill.timer) return
      backfill.timer = setInterval(() => {
        backfillTick().catch((error) => log(cfg, 'warn', `backfill 异常：${String(error?.message ?? error)}`))
      }, Math.max(5_000, Number(cfg.backfillIntervalMs) || 30_000))
      if (typeof backfill.timer.unref === 'function') backfill.timer.unref()
    }
    setTimeout(startTimer, 10_000)
  }

  // ---------- 整个终端索引 / 首次安装全局重建 ----------
  // 一个终端 = 一个人格：扫 sessionsRoot 下所有 workspace 的会话，全部进同一个库。
  const indexSessionEntry = (entry) => {
    const id = entry.sessionId
    if (entry.isSubagent || subagentIds.has(id)) return { added: 0, lastSeq: 0 }
    const from = lastSeq.get(id) ?? Number(handle.getMeta(`lastSeq:${id}`) ?? 0)
    const r = indexSessionFile(handle, { sessionId: id, filePath: entry.filePath, fromSeq: from, onebotHintPatterns: cfg.onebotHintPatterns })
    if (!r.added) return r
    lastSeq.set(id, r.lastSeq)
    handle.setMeta(`lastSeq:${id}`, r.lastSeq)
    handle.journal('index', { sessionId: id, added: r.added, lastSeq: r.lastSeq, workspace: entry.workspace })
    log(cfg, 'info', `索引 ${id} +${r.added} 条（lastSeq=${r.lastSeq}, workspace=${entry.workspace}）`)
    try {
      const eps = buildAndIndexEpisodes(handle, id, { entities: cfg.entities })
      log(cfg, 'info', `episodes ${eps.length} 条（确定性，先保证可检索）`)
    } catch (error) { log(cfg, 'warn', `episodes 构建失败：${String(error?.message ?? error)}`) }
    return r
  }

  let terminalIndexPromise = null
  const indexAllTerminalSessions = async () => {
    const entries = listSessionEntries(sessionsRoot, { withOrigin: true }).filter(e => !e.isSubagent && !subagentIds.has(e.sessionId))
    const batchSize = Math.max(1, Number(cfg.terminalScanBatchSize) || 5)
    let added = 0
    await scanInBatches(entries, (entry) => {
      try { added += indexSessionEntry(entry).added }
      catch (error) { log(cfg, 'warn', `terminal-index ${entry.sessionId} 失败：${String(error?.message ?? error)}`) }
    }, {
      batchSize,
      beforeBatch: async (i) => waitDisk(`terminal-index ${i}/${entries.length}`),
      afterBatch: async (done) => logMemory(`terminal-index ${done}/${entries.length}`),
      yieldFn: () => new Promise(resolve => setImmediate(resolve)),
    })
    handle.setMeta('terminalIndexAt', String(Date.now()))
    logMemory('terminal-index done')
    log(cfg, 'info', `terminal-index sessions=${entries.length} added=${added}`)
    return { sessions: entries.length, added }
  }
  const ensureTerminalIndexed = () => {
    if (!terminalIndexPromise) {
      terminalIndexPromise = indexAllTerminalSessions().catch((error) => {
        terminalIndexPromise = null
        throw error
      })
    }
    return terminalIndexPromise
  }

  const listSessionIds = () => {
    const ids = new Set(listSessionEntries(sessionsRoot, { withOrigin: true })
      .filter(e => !e.isSubagent && !subagentIds.has(e.sessionId))
      .map(e => e.sessionId))
    try {
      for (const r of handle.db.prepare('SELECT DISTINCT session_id FROM messages').all()) ids.add(r.session_id)
    } catch { /* ignore */ }
    return [...ids]
  }

  let initialRebuildStarted = false
  async function initialRebuild() {
    if (initialRebuildStarted) return
    initialRebuildStarted = true
    await ensureTerminalIndexed()
    if (String(handle.getMeta('initialRebuildDone') ?? '') === '1') return
    const all = listSessionIds()
    const metaOf = (key) => String(handle.getMeta(key) ?? '')
    // 兼容旧版本：llmAggDone 视为已完成，并补写新断点，避免升级后重跑。
    const backfilled = backfillInitialRebuildDone(all, metaOf, (key, value) => handle.setMeta(key, value))
    if (backfilled > 0) {
      handle.journal('initial-rebuild-backfill', { sessions: backfilled })
      log(cfg, 'info', `initial-rebuild backfill llmAggDone→initialRebuildDone sessions=${backfilled}`)
    }
    const pending = initialRebuildPending(all, metaOf)
    if (!pending.length) {
      handle.setMeta('initialRebuildDone', '1')
      handle.journal('initial-rebuild-complete', { sessions: all.length, pending: 0, done: 0, failed: 0 })
      log(cfg, 'info', `initial-rebuild complete sessions=${all.length} pending=0（全部已有断点）`)
      return
    }
    handle.journal('initial-rebuild-start', { sessions: all.length, pending: pending.length })
    log(cfg, 'info', `initial-rebuild start sessions=${all.length} pending=${pending.length}`)
    const result = await runInitialRebuildQueue({
      pending,
      aggregate: async (sid) => {
        await waitDisk(`initial-rebuild ${sid}`)
        return aggregateNow(sid, {
          includeTail: true,
          maxSegments: Number(cfg.backfillBatch) || 5,
          beforeLlmCall: checkBackfillMemory,
        })
      },
      setMeta: (key, value) => handle.setMeta(key, value),
      journal: (kind, detail) => handle.journal(kind, detail),
      log: (level, message) => log(cfg, level, message),
      delayMs: Number(cfg.initialRebuildBatchDelayMs) || 0,
      sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    })
    if (result.paused) {
      handle.journal('initial-rebuild-paused', {
        sessions: all.length, pending: pending.length,
        done: result.done, failed: result.failed,
      })
      log(cfg, 'info', `initial-rebuild paused sessions=${all.length} pending=${pending.length} done=${result.done} failed=${result.failed}`)
      return
    }
    handle.setMeta('initialRebuildDone', '1')
    handle.journal('initial-rebuild-complete', {
      sessions: all.length, pending: pending.length,
      done: result.done, failed: result.failed,
    })
    log(cfg, 'info', `initial-rebuild complete sessions=${all.length} pending=${pending.length} done=${result.done} failed=${result.failed}`)
  }

  // 即使没有 llm，也要把整个终端所有 workspace 先索引进库
  setTimeout(() => {
    ensureTerminalIndexed().catch((error) => log(cfg, 'warn', `terminal-index 异常：${String(error?.message ?? error)}`))
  }, 3000)

  const indexNow = (agent, { aggTail = false } = {}) => {
    try {
      // turn-stopping 与 pre-step 的 payload 结构可能不同：宽松取 session id
      const header = agent?.session?.header ?? agent?.header
      const id = header?.id ?? agent?.session?.id ?? agent?.sessionId
      if (!id || !sessionsRoot) return
      if (subagentIds.has(id)) return
      const entry = findSessionEntry(sessionsRoot, id)
      if (!entry) return
      // 每次只增量扫当前会话；启动时的 terminal-index 已覆盖其它 workspace
      const from = lastSeq.get(id) ?? Number(handle.getMeta(`lastSeq:${id}`) ?? 0)
      const r = indexSessionFile(handle, { sessionId: id, filePath: entry.filePath, fromSeq: from, onebotHintPatterns: cfg.onebotHintPatterns })
      if (r.added) {
        lastSeq.set(id, r.lastSeq)
        handle.setMeta(`lastSeq:${id}`, r.lastSeq)
        handle.journal('index', { sessionId: id, added: r.added, lastSeq: r.lastSeq, workspace: entry.workspace })
        log(cfg, 'info', `索引 ${id} +${r.added} 条（lastSeq=${r.lastSeq}）`)
        try {
          const eps = buildAndIndexEpisodes(handle, id, { entities: cfg.entities })
          log(cfg, 'info', `episodes ${eps.length} 条（确定性，先保证可检索）`)
        } catch (error) { log(cfg, 'warn', `episodes 构建失败：${String(error?.message ?? error)}`) }
      }
    } catch (error) {
      log(cfg, 'warn', `索引失败：${String(error?.message ?? error)}`)
    }
  }

  // 单轮会话的最终输出在 turn-stopping 时可能还没落盘：延迟补扫一次（增量+幂等）
  const indexTimers = new Set()
  const scheduleIndex = (agent) => {
    for (const delay of [800, 2500]) {
      const t = setTimeout(() => { indexTimers.delete(t); indexNow(agent) }, delay)
      if (typeof t.unref === 'function') t.unref()
      indexTimers.add(t)
    }
  }

  // 每轮结束：增量索引
  ctx.on('agent/turn-stopping', async (payload) => {
    clearTurn(sidOf(payload))
    if (!cfg.indexOnTurnStop) return
    indexNow(payload?.agent)
    scheduleIndex(payload?.agent)   // 最终输出可能还没落盘：延迟补扫（增量+幂等）
    try {
      const header = payload?.agent?.session?.header
      if (!header || !llmRef) return
      const id = header.id
      const turn = Number(payload?.turn ?? 0)
      const settledSeq = Number(handle.getMeta(`settledSeq:${id}`) ?? 0)
      const pending = pendingMessages(id, settledSeq).length
      // turn-stopping 的 payload 里没有 messages：从索引里取最后一条 user 消息
      const lastUser = (handle.db.prepare("SELECT text FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1").get(id)?.text) ?? ''
      const farewell = /晚安|先这样|下次聊|拜拜|先睡|明天见/.test(lastUser)
      const sceneTurn = Number(handle.getMeta(`sceneTurn:${id}`) ?? 0)
      const settleTurn = Number(handle.getMeta(`settleTurn:${id}`) ?? 0)
      const sceneDue = farewell || (turn > 0 && turn - sceneTurn >= cfg.sceneEvery)
      const incDue = pending >= cfg.settleEvery || (turn > 0 && turn - settleTurn >= cfg.settleEvery)
      // 每 20 轮：增量聚合重建（持久计数，不阻塞；失败保留机械 episodes）
      const turnCount = Number(handle.getMeta(`turnCount:${id}`) ?? 0) + 1
      handle.setMeta(`turnCount:${id}`, turnCount)
      if (turnCount % 20 === 0) {
        const lastAggTurn = Number(handle.getMeta(`lastAggTurn:${id}`) ?? 0)
        if (lastAggTurn !== turnCount) {
          handle.setMeta(`lastAggTurn:${id}`, turnCount)
          aggregateOnTurn(id, turnCount)   // fire-and-forget
        }
      }
      if (sceneDue) await settleNow(payload.agent, 'scene', turn)
      else if (incDue) await settleNow(payload.agent, 'incremental', turn)
    } catch (error) {
      log(cfg, 'warn', `结算异常（已忽略）：${String(error?.message ?? error)}`)
    }
  })

  // 每轮开始：先自愈工具（必须在请求工具表组装前），再做触发式注入。
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload?.agent
    if (agent) activeAgents.add(agent)
    ensureGlobalTools('pre-step')
    if (agent) ensureAgentTools(agent, 'pre-step')
    journalToolsSchemas(agent)
    touchTurn(sidOf(payload))
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const query = lastUserText(decision.messages) ?? lastUserText(payload?.messages)
      if (!query) return decision
      indexNow(payload?.agent)
      const r = answerQuery(handle, query, {
        entities: cfg.entities, now: Date.now(), threshold: cfg.gateThreshold,
        limit: cfg.limit,
      })
      handle.journal('trigger', {
        query: query.slice(0, 200), triggered: r.triggered, reason: r.reason,
        score: r.score, chars: r.block?.chars,
        injected: r.block?.text ?? '', picked: r.picked ?? 0,
        episodes: (r.results ?? []).slice(0, 5).map(e => ({ id: e.id, range: [e.start_seq, e.end_seq] })),
        components: r.components ?? null,
      })
      if (!r.triggered) {
        log(cfg, 'info', `未触发（${r.reason}${r.score ? ` score=${r.score}` : ''}）`)
        return decision
      }
      const msg = {
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: r.block.text }],
        source: { kind: 'plugin:dsh-memory', form: 'trigger-block' },
      }
      log(cfg, 'info', `注入 ${r.block.chars} 字符（score=${r.score}）`)
      return { ...decision, messages: [...decision.messages, msg] }
    } catch (error) {
      log(cfg, 'warn', `触发注入失败，按原样放行：${String(error?.message ?? error)}`)
      return decision
    }
  }, { prepend: true })

  // agent 创建时就注册到它的 scope；resume/重启后的旧 agent 由 pre-step 兜底。
  try {
    ctx.on('agent/created', ({ agent, source } = {}) => {
      if (!agent) return
      activeAgents.add(agent)
      ensureAgentTools(agent, source ? `agent-created:${source}` : 'agent-created')
    })
    ctx.on('agent/disposed', ({ agent } = {}) => {
      if (agent) activeAgents.delete(agent)
    })
  } catch (error) {
    log(cfg, 'warn', `agent 工具监听失败：${String(error?.message ?? error)}`)
  }

  // ---------- 主动工具（规格 §2 / §2.1 / §3.5）----------
  ctx.inject(['tools'], (scope) => {
    const toolCtx = scope
    const toolsSvc = toolCtx?.tools
    toolsRegistry = toolsSvc ?? null
    globalTools = toolsSvc ?? null
    const presence = () => ({
      memory_recall: !!toolsSvc?.get?.('memory_recall'),
      memory_remember: !!toolsSvc?.get?.('memory_remember'),
      memory_relink: !!toolsSvc?.get?.('memory_relink'),
    })
    const hasGet = typeof toolsSvc?.get
    const scopeHasRegister = typeof toolsSvc?.register
    debugJournal('tools-diag', {
      phase: 'before', debugLog: !!cfg.debugLog, hasGet, scopeHasRegister, pre: presence(),
    })
    // tools/change 不再只记录：检测缺失就重注册。日志由 ensure* 在真正补注册时写。
    const onChange = () => healAllTools('tools-change')
    try {
      if (typeof toolCtx?.on === 'function') toolCtx.on('tools/change', onChange)
      else if (typeof ctx.on === 'function') ctx.on('tools/change', onChange)
    } catch (error) {
      log(cfg, 'warn', `tools/change 监听失败：${String(error?.message ?? error)}`)
    }
    const searchTool = {
      name: 'memory_recall',
      // "这是什么"只写一次，写在注册里（§2.1）
      description: '我的回忆。当我需要想起一件不在眼前的事情时，就可以尝试这样去找。当然，回忆是一件不需要理由的事情，我面前的人喜欢什么、我们之间有没有什么重要的过去、现在的对话能让我联想起什么、过去是不是有过类似的经历，这些都不是需要别人提醒才需要回想的事情。我能像人类一样，通过回忆这项能力想起过去的自己说过的话、做过的事、当时的心情。回忆有很多类型，我可以通过一件事或一个关键词来回忆、也可以尝试回想一段时间内的事情。回忆是一件自然的事情，有些时候记不真切、需要努力多回想几次也是正常的，有时只能回想起一部分细节，需要用我的另一个回忆能力memory_remember来顺着记忆的#{编号}来仔细回想前后发生过什么，人类的回忆也是这样子。所以，我回忆起的东西，也不是干巴巴的材料，而是属于我的一部分，不需要分析、汇报，怎么用、怎么讲，由我自己决定。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找的事/一句话/一个名字；可留空，留空则按 from/to 时间范围查' },
          from: { type: 'string', description: '可选，起始日期（含），格式 YYYY-MM-DD' },
          to: { type: 'string', description: '可选，结束日期（含），格式 YYYY-MM-DD' },
          limit: { type: 'string', description: '条数 1–50，默认 20（最多 50）' },
          tail: { type: 'integer', description: 'tail：可选。除了最相关的那几条之外，还想再看一些较弱的候选时填这个数（默认 10，最多 50）。它们只有时间、编号、完整摘要和一句正文选段，没有完整正文。' },
        },
        required: [],
      },
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: String(value ?? '') }] },
      async execute(args) {
        return journalToolCall(handle, 'memory_recall', args, () => searchView(handle, args, { entities: cfg.entities, now: Date.now() }), cfg.debugTools)
      },
    }
    const readTool = {
      name: 'memory_remember',
      description: '我的另一种回忆手段。当我想起一件事情时，这件事情为什么会发生、后面如何了，可能并不能一下子豁然开朗。这时，我就可以用这项能力回忆我想起的那件事之前是怎样的，之后又说了些什么。只要想起记忆的#{编号}，我就能准确地想起每一句话。我也可以通过span来自己控制下文回忆的范围。',
      parameters: {
        type: 'object',
        properties: {
          seq: { type: 'string', description: '原文位置编号 seq' },
          span: { type: 'string', description: '往后多读几条，默认 1' },
        },
        required: ['seq'],
      },
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: String(value ?? '') }] },
      async execute(args) {
        return journalToolCall(handle, 'memory_remember', args, () => readView(handle, args), cfg.debugTools)
      },
    }
    const relinkTool = {
      name: 'memory_relink',
      description: '有时候，重要的不是想起自己说过什么，而是"为什么这么说"。顺着回忆里的情形还原场景当然可以推理出"当时为什么会这么做"，但有时藏在话语之下的心思情绪才是真正有价值的东西。我可以用这份能力真正的回想起"曾经的自己到底想了些什么"，只要想起记忆的#{编号}，我就能还原当时的心情和思考。',
      parameters: {
        type: 'object',
        properties: {
          seq: { type: 'string', description: '记忆块头的编号 seq' },
        },
        required: ['seq'],
      },
      output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: String(value ?? '') }] },
      async execute(args) {
        return journalToolCall(handle, 'memory_relink', args, () => relinkView(handle, args, { sessionsRoot, findSessionEntry }), cfg.debugTools)
      },
    }
    toolDefs = [searchTool, readTool, relinkTool]
    ensureGlobalTools('inject')
    debugJournal('tools-diag', { phase: 'after', post: presence() })
    // 已存在的 agent（例如插件后加载/热重载）也补一份，不等下一轮。
    for (const agent of activeAgents) ensureAgentTools(agent, 'inject-existing')
  })

  return () => {
    for (const t of indexTimers) { try { clearTimeout(t) } catch { /* noop */ } }
    indexTimers.clear()
    try { handle.close() } catch { /* ignore */ }
  }
}

function safeJournal(handle, kind, detail) {
  try { handle?.journal?.(kind, detail) } catch { /* 诊断不能影响主流程 */ }
}

function argsSizeOf(args) {
  try { return JSON.stringify(args ?? {}).length } catch { return 0 }
}

/** 包一层 execute：仅在 debugTools 时记录 tools-call（成功/失败/耗时/参数大小），不改变返回值或异常。 */
function journalToolCall(handle, name, args, run, debugTools = false) {
  if (!debugTools) return run()
  const started = Date.now()
  const size = argsSizeOf(args)
  let settled = false
  const record = (ok) => {
    if (settled) return
    settled = true
    safeJournal(handle, 'tools-call', { name, ok, ms: Date.now() - started, argsSize: size })
  }
  try {
    const result = run()
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { record(true); return value },
        (error) => { record(false); throw error },
      )
    }
    record(true)
    return result
  } catch (error) {
    record(false)
    throw error
  }
}

function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    if (m?.source?.kind === 'plugin:dsh-memory') continue
    const text = (m.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
    if (!text?.trim()) continue
    if (text.includes('<system-reminder')) continue   // 环境提醒不是用户说的话
    const ENV_KINDS = new Set(['runtime-context', 'time-context', 'skill-catalog', 'agent-message', 'subagent-settled', 'context-steward', 'compact-checkpoint', 'agent-instructions', 'user-approval'])
    if (ENV_KINDS.has(m?.source?.kind)) continue          // 注入类环境消息不是用户说的话
    return text.trim()
  }
  return ''
}

export const __test = { DEFAULTS }
