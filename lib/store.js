// P1 存储：episodes / facts / profile / entities / conflicts（规格 §5）
import { DatabaseSync } from 'node:sqlite'
import { tokenize } from './db.js'

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      start_seq INTEGER NOT NULL,
      end_seq INTEGER NOT NULL,
      start_at INTEGER,
      end_at INTEGER,
      title TEXT,
      summary TEXT,
      cues TEXT,
      quote_seq INTEGER,
      quote_text TEXT,
      salience INTEGER DEFAULT 1,
      verified TEXT
    );
    CREATE TABLE IF NOT EXISTS facts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      attribute TEXT NOT NULL,
      value TEXT NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      status TEXT DEFAULT 'active',
      source_seq INTEGER,
      cardinality TEXT DEFAULT 'single',
      superseded_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS profile(
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS entities(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      kind TEXT
    );
    CREATE TABLE IF NOT EXISTS entity_aliases(
      alias TEXT PRIMARY KEY,
      entity_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS conflicts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      attribute TEXT,
      old_value TEXT,
      new_value TEXT,
      status TEXT DEFAULT 'open',
      created_at INTEGER,
      resolved_at INTEGER
    );
  `)
  // 兼容升级：facts 增加原话列（弱事实拒收用）
  try { db.exec('ALTER TABLE facts ADD COLUMN quote_text TEXT') } catch { /* already exists */ }
}

export function insertEpisode(db, ep) {
  const r = db.prepare(`INSERT INTO episodes(session_id,start_seq,end_seq,start_at,end_at,title,summary,cues,quote_seq,quote_text,salience,verified)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    ep.sessionId, ep.startSeq, ep.endSeq, ep.startAt ?? null, ep.endAt ?? null,
    ep.title ?? '', ep.summary ?? '', JSON.stringify(ep.cues ?? []),
    ep.quoteSeq ?? null, ep.quoteText ?? '', ep.salience ?? 1, JSON.stringify(ep.verified ?? {}),
  )
  return Number(r.lastInsertRowid)
}

export function listEpisodes(db, limit = 50) {
  return db.prepare('SELECT * FROM episodes ORDER BY id DESC LIMIT ?').all(limit)
}

/** 冲突四态（§5.2）：NOOP / UPDATE(single 失效) / ADD(multi 并存) / CONFLICT(进 conflicts) */
export function upsertFact(db, fact, { now = Date.now(), journal = () => {} } = {}) {
  const active = db.prepare(`SELECT * FROM facts WHERE subject = ? AND attribute = ? AND status = 'active'`).all(fact.subject, fact.attribute)
  const same = active.find(f => String(f.value).trim() === String(fact.value).trim())
  if (same) { journal('fact-noop', { id: same.id, ...fact }); return { action: 'NOOP', id: same.id } }
  if (!active.length) {
    const r = db.prepare(`INSERT INTO facts(subject,category,attribute,value,valid_from,valid_to,status,source_seq,cardinality)
      VALUES (?,?,?,?,?,NULL,'active',?,?)`).run(
      fact.subject, fact.category, fact.attribute, String(fact.value), now, fact.sourceSeq ?? null, fact.cardinality ?? 'single')
    const addId = Number(r.lastInsertRowid)
    if (fact.quoteText) db.prepare('UPDATE facts SET quote_text = ? WHERE id = ?').run(String(fact.quoteText), addId)
    journal('fact-add', { id: addId, ...fact })
    return { action: 'ADD', id: Number(r.lastInsertRowid) }
  }
  const card = fact.cardinality ?? active[0].cardinality ?? 'single'
  const stampQuote = (id) => { if (fact.quoteText) db.prepare('UPDATE facts SET quote_text = ? WHERE id = ?').run(String(fact.quoteText), id) }
  if (card === 'multi') {
    const r = db.prepare(`INSERT INTO facts(subject,category,attribute,value,valid_from,valid_to,status,source_seq,cardinality)
      VALUES (?,?,?,?,?,NULL,'active',?,'multi')`).run(
      fact.subject, fact.category, fact.attribute, String(fact.value), now, fact.sourceSeq ?? null)
    stampQuote(Number(r.lastInsertRowid))
    journal('fact-add-multi', { id: Number(r.lastInsertRowid), ...fact })
    return { action: 'ADD', id: Number(r.lastInsertRowid) }
  }
  if (card === 'single') {
    const old = active[0]
    const r = db.prepare(`INSERT INTO facts(subject,category,attribute,value,valid_from,valid_to,status,source_seq,cardinality)
      VALUES (?,?,?,?,?,NULL,'active',?,'single')`).run(
      fact.subject, fact.category, fact.attribute, String(fact.value), now, fact.sourceSeq ?? null)
    const newId = Number(r.lastInsertRowid)
    stampQuote(newId)
    db.prepare('UPDATE facts SET valid_to = ?, status = ?, superseded_by = ? WHERE id = ?').run(now, 'superseded', newId, old.id)
    journal('fact-supersede', { oldId: old.id, oldValue: old.value, newId, newValue: fact.value })
    return { action: 'UPDATE', id: newId, superseded: old.id }
  }
  // 无法判断：进 conflicts，等待下次结算复核
  db.prepare('INSERT INTO conflicts(subject,attribute,old_value,new_value,status,created_at) VALUES (?,?,?,?,?,?)')
    .run(fact.subject, fact.attribute, active.map(f => f.value).join(' | '), String(fact.value), 'open', now)
  journal('fact-conflict', { ...fact })
  return { action: 'CONFLICT' }
}

export function setProfile(db, key, value, now = Date.now()) {
  db.prepare('INSERT OR REPLACE INTO profile(key,value,updated_at) VALUES (?,?,?)').run(key, value, now)
}
export function getProfile(db) {
  return db.prepare('SELECT key, value, updated_at FROM profile ORDER BY updated_at DESC').all()
}
export function upsertEntity(db, name, kind = '') {
  db.prepare('INSERT OR IGNORE INTO entities(name,kind) VALUES (?,?)').run(name, kind)
  return db.prepare('SELECT id FROM entities WHERE name = ?').get(name)?.id
}
export function linkAlias(db, alias, entityId) {
  db.prepare('INSERT OR REPLACE INTO entity_aliases(alias,entity_id) VALUES (?,?)').run(alias, entityId)
}
export function listConflicts(db, limit = 20) {
  return db.prepare("SELECT * FROM conflicts WHERE status = 'open' ORDER BY id DESC LIMIT ?").all(limit)
}

// ---------- 防编四道闸 ----------
export function sourceExists(db, seqs) {
  const q = db.prepare('SELECT seq FROM messages WHERE seq = ?')
  return seqs.every(s => !!q.get(s))
}
export function quoteVerbatim(db, quote, [from, to]) {
  if (!quote) return true
  const rows = db.prepare('SELECT text FROM messages WHERE seq BETWEEN ? AND ?').all(from, to)
  return rows.some(r => String(r.text).includes(quote))
}
const grams = (s) => new Set(tokenize(s))
export function grounding(summary, sourceText) {
  const g = grams(summary), src = grams(sourceText)
  if (!g.size) return 0
  let hit = 0
  for (const x of g) if (src.has(x)) hit++
  return hit / g.size
}
export function entitiesGrounded(text, sourceText) {
  const nums = [...String(text).matchAll(/\d{2,}/g)].map(m => m[0])
  const names = [...String(text).matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)].map(m => m[0])
  return [...nums, ...names].every(x => String(sourceText).includes(x))
}

/**
 * 四道闸：来源存在 / 引语逐字 / 内容接地 / 数字与英文实体回查。
 * @returns {{ ok:boolean, reasons:string[], grounding:number }}
 */
export function runGates(db, item, [from, to]) {
  const reasons = []
  const seqs = (item.source_seqs ?? []).map(Number)
  if (!seqs.length || !sourceExists(db, seqs)) reasons.push('source-missing')
  if (item.quote && !quoteVerbatim(db, item.quote, [from, to])) reasons.push('quote-mismatch')
  const rows = db.prepare('SELECT text FROM messages WHERE seq BETWEEN ? AND ?').all(from, to)
  const sourceText = rows.map(r => r.text).join('\n')
  const gr = grounding(item.summary ?? '', sourceText)
  if (gr < 0.20) reasons.push(`low-grounding:${gr.toFixed(2)}`)
  if (!entitiesGrounded(item.summary ?? '', sourceText)) reasons.push('entity-number-mismatch')
  return { ok: reasons.length === 0, reasons, grounding: Number(gr.toFixed(3)) }
}
