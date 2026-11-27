// 单一来源：episode 标签枚举 + 权重（redating / memory_recall 共用）
// 训练员 2026-11-27 定稿：最高档 fact/promise/feeling，次档 turn/care/decision，最低档 task/daily/meta。
export const AGG_KINDS = ['fact', 'promise', 'feeling', 'turn', 'care', 'decision', 'task', 'daily', 'meta']

export const LABEL_WEIGHTS = {
  fact: 1.00,
  promise: 1.00,
  feeling: 0.90,
  turn: 0.85,
  care: 0.65,
  decision: 0.55,
  task: 0.30,
  daily: 0.25,
  meta: 0.20,
}

export const LABEL_KIND_SET = new Set(AGG_KINDS)

export function isAggKind (value) {
  return LABEL_KIND_SET.has(String(value ?? '').trim().toLowerCase())
}

export function labelWeight (kind) {
  return LABEL_WEIGHTS[String(kind ?? '').trim().toLowerCase()] ?? 0
}
