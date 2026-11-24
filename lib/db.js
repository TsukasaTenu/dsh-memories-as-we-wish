// SQLite 索引层：messages + FTS5（unicode61；应用层 bigram 预分词）
// 用 node:sqlite 的 DatabaseSync（不引 better-sqlite3）。
import { DatabaseSync } from 'node:sqlite'

/** 旧库的会话编号基数；新库统一使用 1000 万。 */
const OLD_SEQ_BASE = 1_000_000
export const SEQ_BASE = 10_000_000

function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
}

/**
 * 旧库 seq 基数迁移：rowSeq = ordinal * base + rawSeq。
 * 同一会话的所有 seq 等距平移 delta = ordinal * (newBase - oldBase)。
 * 两阶段更新主键，避免旧区段与新 1000 万区段相撞。
 */
function migrateSeqBase(db, oldBase) {
  if (!Number.isFinite(oldBase) || oldBase <= 0 || oldBase === SEQ_BASE) return null
  const sessions = db.prepare('SELECT session_id, COUNT(*) AS n FROM messages GROUP BY session_id').all()
  if (!sessions.length) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('seq-base', ?)").run(String(SEQ_BASE))
    return null
  }
  const ordinalRows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'ordinal:%'").all()
  const ordinal = new Map(ordinalRows.map(r => [String(r.key).slice('ordinal:'.length), Number(r.value)]))
  for (const s of sessions) {
    if (!Number.isFinite(ordinal.get(s.session_id)) || ordinal.get(s.session_id) <= 0) {
      throw new Error(`seq-base migration: missing ordinal for ${s.session_id}`)
    }
  }

  const before = { messages: countRows(db, 'messages'), episodes: countRows(db, 'episodes_v2'), aggregates: countRows(db, 'episode_aggregates') }
  let changedMessages = 0, changedEpisodes = 0, changedAggregates = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    // 先把所有消息主键移到负数区，彻底避开旧正向区段。
    db.exec('UPDATE messages SET seq = -seq')
    for (const s of sessions) {
      const delta = ordinal.get(s.session_id) * (SEQ_BASE - oldBase)
      changedMessages += Number(db.prepare('UPDATE messages SET seq = -seq + ? WHERE session_id = ?').run(delta, s.session_id).changes)
      changedEpisodes += Number(db.prepare(`UPDATE episodes_v2 SET start_seq = start_seq + ?, end_seq = end_seq + ?,
        quote_seq = CASE WHEN quote_seq IS NULL THEN NULL ELSE quote_seq + ? END WHERE session_id = ?`).run(delta, delta, delta, s.session_id).changes)
      changedAggregates += Number(db.prepare('UPDATE episode_aggregates SET start_seq = start_seq + ?, end_seq = end_seq + ? WHERE session_id = ?').run(delta, delta, s.session_id).changes)
    }
    // seq 已变化；这些 FTS 的 token 是应用层 bigram 预分词，不能用 FTS 的 rebuild
    // （external content 表没有 tokens 列），直接重建虚拟表并按新主键重写索引。
    db.exec(`
      DROP TABLE IF EXISTS messages_fts;
      CREATE VIRTUAL TABLE messages_fts USING fts5(tokens, content='messages', content_rowid='seq', tokenize='unicode61');
    `)
    const insMsgFts = db.prepare('INSERT INTO messages_fts(rowid, tokens) VALUES (?,?)')
    for (const r of db.prepare('SELECT seq, text FROM messages').all()) insMsgFts.run(r.seq, tokenString(r.text))
    // episodes_fts / episodes_fts2 的 rowid 是 episode.id，迁移不改 id，也不能重建：
    // 旧索引里可能已有历史 stale token，重建会改变召回集合；保持原索引不动。
    const after = { messages: countRows(db, 'messages'), episodes: countRows(db, 'episodes_v2'), aggregates: countRows(db, 'episode_aggregates') }
    if (before.messages !== after.messages || before.episodes !== after.episodes || before.aggregates !== after.aggregates) {
      throw new Error(`seq-base migration: row count changed ${JSON.stringify({ before, after })}`)
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('seq-base', ?)").run(String(SEQ_BASE))
    db.prepare('INSERT INTO journal(at, kind, detail) VALUES (?,?,?)').run(Date.now(), 'seq-base-migrated', JSON.stringify({
      oldBase, newBase: SEQ_BASE, sessions: sessions.length,
      messages: changedMessages, episodes: changedEpisodes, aggregates: changedAggregates,
      before, after,
    }))
    db.exec('COMMIT')
    return { oldBase, newBase: SEQ_BASE, sessions: sessions.length, messages: changedMessages, episodes: changedEpisodes, aggregates: changedAggregates, before, after }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* noop */ }
    throw e
  }
}

function ensureSeqBase(db) {
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'seq-base'").get()?.value ?? 0)
  if (current === SEQ_BASE) return null
  if (current && current !== OLD_SEQ_BASE) throw new Error(`unsupported seq-base: ${current}`)
  const oldBase = current || OLD_SEQ_BASE
  const hasData = countRows(db, 'messages') + countRows(db, 'episodes_v2') + countRows(db, 'episode_aggregates') > 0
  if (!hasData) {
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('seq-base', ?)").run(String(SEQ_BASE))
    return null
  }
  return migrateSeqBase(db, oldBase)
}

/** 中文 bigram 预分词 + 英文/数字小写 token；FTS5 只存 token 流。 */
export function tokenize(text) {
  const t = String(text ?? '').toLowerCase()
  const tokens = []
  // 英文/数字词
  for (const m of t.matchAll(/[a-z0-9_]+/g)) if (m[0].length >= 2) tokens.push(m[0])
  // CJK 连续段 → 2-gram
  for (const m of t.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = m[0]
    for (let i = 0; i + 2 <= s.length; i++) tokens.push(s.slice(i, i + 2))
  }
  return tokens
}

export function tokenString(text) {
  return tokenize(text).join(' ')
}

export function openDb(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages(
      seq INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      time INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      tokens, content='messages', content_rowid='seq', tokenize='unicode61'
    );
    CREATE TABLE IF NOT EXISTS journal(at INTEGER, kind TEXT, detail TEXT);
  `)
  // episodes：检索单位（body + quote 建 FTS；messages 只做证据）
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes_v2(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      title TEXT,
      body TEXT NOT NULL,
      quote TEXT,
      quote_seq INTEGER,
      valuable INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      tokens, content='episodes_v2', content_rowid='id', tokenize='unicode61'
    );
    -- task-23：分字段 FTS（title/summary/cues/entities/time），正文只做 payload
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts2 USING fts5(
      title, summary, cues, entities, time_tokens,
      content='episodes_v2', content_rowid='id', tokenize='unicode61'
    );
    -- LLM 聚合缓存：同一消息段只调用一次模型（失败/重跑复用）
    CREATE TABLE IF NOT EXISTS episode_aggregates(
      session_id TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER NOT NULL,
      title TEXT,
      summary TEXT,
      cues TEXT,
      quote TEXT,
      updated_at INTEGER,
      PRIMARY KEY(session_id, start_seq, end_seq)
    );
  `)
  for (const sql of [
    'ALTER TABLE episodes_v2 ADD COLUMN summary TEXT',
    'ALTER TABLE episodes_v2 ADD COLUMN cues TEXT',
    'ALTER TABLE episodes_v2 ADD COLUMN entities TEXT',
    'ALTER TABLE episodes_v2 ADD COLUMN time_tokens TEXT',
  ]) { try { db.exec(sql) } catch { /* already exists */ } }
  // 兼容升级：来源 kind / 状态（rejected 不参与检索）
  for (const sql of [
    "ALTER TABLE messages ADD COLUMN kind TEXT",
    "ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'active'",
    "ALTER TABLE messages ADD COLUMN raw_seq INTEGER",
  ]) { try { db.exec(sql) } catch { /* already exists */ } }
  // 跨会话隔离：每个 session 分配一个持久化序号；行主键 rowSeq = ordinal * SEQ_BASE + 原始 seq
  ensureSeqBase(db)
  const ordinalOf = (sessionId) => {
    const k = `ordinal:${sessionId}`
    const cur = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? 0)
    if (cur) return cur
    const next = Number(db.prepare("SELECT value FROM meta WHERE key = 'ordinal-next'").get()?.value ?? 0) + 1
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('ordinal-next', ?)").run(String(next))
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(k, String(next))
    return next
  }
  const insertMsg = db.prepare('INSERT OR REPLACE INTO messages(seq, session_id, role, time, text, kind, status, raw_seq) VALUES (?,?,?,?,?,?,?,?)')
  const insertFts = db.prepare('INSERT OR REPLACE INTO messages_fts(rowid, tokens) VALUES (?,?)')
  const deleteMsg = db.prepare('DELETE FROM messages WHERE seq = ?')
  const deleteFts = db.prepare('DELETE FROM messages_fts WHERE rowid = ?')
  return {
    db,
    /** 原始 seq → 跨会话行号（测试/证据查询用） */
    rowSeq(sessionId, rawSeq) { return ordinalOf(sessionId) * SEQ_BASE + Number(rawSeq) },
    baseOf(sessionId) { return ordinalOf(sessionId) * SEQ_BASE },
    sessionOrdinal: ordinalOf,
    insert(msg) {
      const rawSeq = Number(msg.seq)
      if (!Number.isFinite(rawSeq) || rawSeq >= SEQ_BASE) {
        db.prepare('INSERT INTO journal(at, kind, detail) VALUES (?,?,?)').run(Date.now(), 'seq-overflow', JSON.stringify({
          sessionId: msg.sessionId, rawSeq: Number.isFinite(rawSeq) ? rawSeq : String(msg.seq),
        }))
        return null
      }
      const rowSeq = ordinalOf(msg.sessionId) * SEQ_BASE + rawSeq
      insertMsg.run(rowSeq, msg.sessionId, msg.role, msg.time, msg.text, msg.kind ?? null, msg.status ?? 'active', rawSeq)
      insertFts.run(rowSeq, tokenString(msg.text))
      return rowSeq
    },
    /** 旧库清理：按条件把消息标记 rejected（保留原文，不参与检索） */
    rejectWhere(predicate, journal) {
      const rows = db.prepare("SELECT seq, role, text FROM messages WHERE status IS NULL OR status != 'rejected'").all()
      let n = 0
      for (const r of rows) {
        if (!predicate(r)) continue
        db.prepare("UPDATE messages SET status = 'rejected' WHERE seq = ?").run(r.seq)
        journal?.('index-rejected', { seq: r.seq, role: r.role, text: String(r.text).slice(0, 80) })
        n++
      }
      return n
    },
    removeBySession(sessionId) {
      for (const row of db.prepare('SELECT seq FROM messages WHERE session_id = ?').all(sessionId)) {
        deleteFts.run(row.seq); deleteMsg.run(row.seq)
      }
    },
    /**
     * 一次性清理子代理会话：messages/episodes/aggregates/skip 标记，随后重建三张 FTS。
     * 只应由启动时的 root/subagent 判定调用；失败回滚，不清半截数据。
     */
    purgeSessions(sessionIds, journal) {
      const ids = [...new Set((sessionIds ?? []).filter(Boolean))]
      if (!ids.length) return { sessions: 0, before: null, after: null }
      const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
      const before = {
        messages: count('messages'), episodes: count('episodes_v2'), aggregates: count('episode_aggregates'),
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const ph = ids.map(() => '?').join(',')
        // 先精确删除两张 episodes FTS 中属于子代理的行，再删内容表：
        // 全量重建 episodes FTS 会把旧索引里缺失的 root token 一并补齐，改变根会话
        // 的召回集合（实测 rank 命中数 47→49、42→79）。这里用 FTS5 的 delete 命令
        // 按 rowid 精确清理，保住根会话原有召回；messages_fts 的 rowid=seq，整表重建。
        const purgedEpisodes = db.prepare(`SELECT id, body, quote, title, summary, cues, entities, time_tokens
          FROM episodes_v2 WHERE session_id IN (${ph})`).all(...ids)
        const delEpFts = db.prepare("INSERT INTO episodes_fts(episodes_fts, rowid, tokens) VALUES('delete', ?, ?)")
        const delEpFts2 = db.prepare("INSERT INTO episodes_fts2(episodes_fts2, rowid, title, summary, cues, entities, time_tokens) VALUES('delete', ?, ?, ?, ?, ?, ?)")
        for (const r of purgedEpisodes) {
          delEpFts.run(r.id, tokenString(`${r.body ?? ''}\n${r.quote ?? ''}`))
          delEpFts2.run(r.id, tokenString(r.title ?? ''), tokenString(`${r.summary ?? ''} ${r.quote ?? ''}`), tokenString(r.cues ?? ''), tokenString(r.entities ?? ''), tokenString(r.time_tokens ?? ''))
        }
        db.prepare(`DELETE FROM messages WHERE session_id IN (${ph})`).run(...ids)
        db.prepare(`DELETE FROM episodes_v2 WHERE session_id IN (${ph})`).run(...ids)
        db.prepare(`DELETE FROM episode_aggregates WHERE session_id IN (${ph})`).run(...ids)
        for (const sid of ids) {
          db.prepare('DELETE FROM meta WHERE key LIKE ?').run(`aggSkipped:${sid}:%`)
          db.prepare('DELETE FROM meta WHERE key LIKE ?').run(`aggRetryAt:${sid}:%`)
        }
        // messages_fts 只重建这一张；根消息 token 保持不变。
        db.exec(`
          DROP TABLE IF EXISTS messages_fts;
          CREATE VIRTUAL TABLE messages_fts USING fts5(tokens, content='messages', content_rowid='seq', tokenize='unicode61');
        `)
        const insMsg = db.prepare('INSERT INTO messages_fts(rowid, tokens) VALUES (?,?)')
        for (const r of db.prepare('SELECT seq, text FROM messages').all()) insMsg.run(r.seq, tokenString(r.text))
        const after = {
          messages: count('messages'), episodes: count('episodes_v2'), aggregates: count('episode_aggregates'),
        }
        journal?.('subagent-purged', { sessions: ids.length, before, after })
        db.exec('COMMIT')
        return { sessions: ids.length, before, after }
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* noop */ }
        throw e
      }
    },
    getMeta(key) {
      const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      return r?.value
    },
    setMeta(key, value) {
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)').run(key, String(value))
    },
    deleteMeta(key) {
      db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    },
    journal(kind, detail) {
      db.prepare('INSERT INTO journal(at, kind, detail) VALUES (?,?,?)').run(Date.now(), kind, JSON.stringify(detail ?? {}))
    },
    count() { return db.prepare('SELECT COUNT(*) AS n FROM messages').get().n },
    close() { db.close() },
    /** FTS5 bigram 查询：OR 各 bigram，返回按 bm25 升序（越负越相关）；rejected 不参与 */
    search(tokens, limit = 50) {
      if (!tokens.length) return []
      const q = tokens.slice(0, 24).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      try {
        return db.prepare(`
          SELECT m.seq, m.session_id, m.role, m.time, m.text, bm25(messages_fts) AS rank
          FROM messages_fts JOIN messages m ON m.seq = messages_fts.rowid
          WHERE messages_fts MATCH ? AND (m.status IS NULL OR m.status != 'rejected')
          ORDER BY rank LIMIT ?
        `).all(q, limit)
      } catch { return [] }
    },

    // ---------- episodes（检索单位）----------
    /** 重建某会话的 episodes（幂等：先删后插），写旧 FTS（body+quote）与新分字段 FTS2 */
    indexEpisodes(sessionId, episodes) {
      const old = db.prepare('SELECT id FROM episodes_v2 WHERE session_id = ?').all(sessionId)
      for (const r of old) {
        try { db.prepare('DELETE FROM episodes_fts WHERE rowid = ?').run(r.id) } catch { /* noop */ }
        try { db.prepare('DELETE FROM episodes_fts2 WHERE rowid = ?').run(r.id) } catch { /* noop */ }
      }
      db.prepare('DELETE FROM episodes_v2 WHERE session_id = ?').run(sessionId)
      const ins = db.prepare(`INSERT INTO episodes_v2(session_id,start_seq,end_seq,start_at,end_at,title,body,quote,quote_seq,valuable,status,summary,cues,entities,time_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`)
      const insFts = db.prepare('INSERT INTO episodes_fts(rowid, tokens) VALUES (?,?)')
      const insFts2 = db.prepare('INSERT INTO episodes_fts2(rowid, title, summary, cues, entities, time_tokens) VALUES (?,?,?,?,?,?)')
      let n = 0
      for (const ep of episodes) {
        const r = ins.run(sessionId, ep.startSeq, ep.endSeq, ep.startAt ?? null, ep.endAt ?? null,
          ep.title ?? null, String(ep.body ?? ''), ep.quote ?? null, ep.quoteSeq ?? null, ep.valuable === false ? 0 : 1,
          ep.summary ?? '', ep.cues ?? '', ep.entities ?? '', ep.timeTokens ?? '')
        const id = Number(r.lastInsertRowid)
        insFts.run(id, tokenString(`${ep.body ?? ''}\n${ep.quote ?? ''}`))
        insFts2.run(id, tokenString(ep.title ?? ''), tokenString(`${ep.summary ?? ''} ${ep.quote ?? ''}`), tokenString(ep.cues ?? ''), tokenString(ep.entities ?? ''), tokenString(ep.timeTokens ?? ''))
        n++
      }
      return n
    },
    episodeCount() { return db.prepare("SELECT COUNT(*) AS n FROM episodes_v2 WHERE status = 'active'").get().n },
    /** 旧检索（body+quote，baseline 对照用） */
    searchEpisodes(tokens, limit = 20) {
      if (!tokens.length) return []
      const q = tokens.slice(0, 24).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      try {
        return db.prepare(`
          SELECT e.id, e.session_id, e.start_seq, e.end_seq, e.start_at, e.end_at, e.title, e.body, e.quote, e.quote_seq, e.valuable,
                 bm25(episodes_fts) AS rank
          FROM episodes_fts JOIN episodes_v2 e ON e.id = episodes_fts.rowid
          WHERE episodes_fts MATCH ? AND e.status = 'active'
          ORDER BY rank LIMIT ?
        `).all(q, limit)
      } catch { return [] }
    },
    /** 新检索（task-23）：分字段 FTS + 字段加权（title 4 / summary 2 / cues 2 / entities 3 / time 1） */
    searchEpisodes2(tokens, limit = 40) {
      if (!tokens.length) return []
      const q = tokens.slice(0, 24).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      try {
        return db.prepare(`
          SELECT e.id, e.session_id, e.start_seq, e.end_seq, e.start_at, e.end_at, e.title, e.body, e.summary, e.cues, e.entities, e.time_tokens,
                 e.quote, e.quote_seq, e.valuable,
                 bm25(episodes_fts2, 4.0, 1.0, 3.0, 1.0, 0.0) AS rank
          FROM episodes_fts2 JOIN episodes_v2 e ON e.id = episodes_fts2.rowid
          WHERE episodes_fts2 MATCH ? AND e.status = 'active'
          ORDER BY rank LIMIT ?
        `).all(q, limit)
      } catch { return [] }
    },
    /** 证据：按 episode 的 seq 范围取原文（messages 只做证据） */
    messagesInRange(startSeq, endSeq, limit = 6) {
      return db.prepare(`SELECT seq, role, time, text FROM messages
        WHERE seq BETWEEN ? AND ? AND (status IS NULL OR status != 'rejected')
        ORDER BY seq LIMIT ?`).all(startSeq, endSeq, limit)
    },
    // ---------- LLM 聚合缓存 ----------
    getAggregate(sessionId, startSeq, endSeq) {
      return db.prepare('SELECT title, summary, cues, quote FROM episode_aggregates WHERE session_id = ? AND start_seq = ? AND end_seq = ?')
        .get(sessionId, startSeq, endSeq) ?? null
    },
    putAggregate(sessionId, startSeq, endSeq, agg) {
      db.prepare(`INSERT OR REPLACE INTO episode_aggregates(session_id, start_seq, end_seq, title, summary, cues, quote, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, startSeq, endSeq,
        String(agg?.title ?? ''), String(agg?.summary ?? ''),
        Array.isArray(agg?.cues) ? agg.cues.join(' ') : String(agg?.cues ?? ''),
        String(agg?.quote ?? ''), Date.now())
    },
  }
}
