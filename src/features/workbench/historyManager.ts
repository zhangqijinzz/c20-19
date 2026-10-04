/**
 * 撤销 / 重做历史记录。
 *
 * 语义约定（对使用者可见）：
 * - 历史以「编辑步骤」为单位，记录整个文档的快照，跨方案生效；
 *   撤销某一步会回到该步发生时的方案视图。
 * - 切换方案只是导航，不产生历史步骤。
 * - 连续的高频编辑（拖动、连续输入尺寸）按 coalesceKey + 时间窗合并为一步。
 * - 撤销之后产生新编辑，未重做的分支立即作废。
 * - 历史长度有上限（HISTORY_LIMIT），超出后丢弃最早的步骤。
 */

export interface HistoryEntry<T> {
  label: string
  coalesceKey: string | null
  before: T
  after: T
  time: number
}

export interface History<T> {
  entries: HistoryEntry<T>[]
  /** 已生效的步骤数：entries[pointer - 1] 是最近一步，entries[pointer] 是下一个可重做步骤 */
  pointer: number
}

export interface HistoryMeta {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

export const HISTORY_LIMIT = 100
export const COALESCE_WINDOW_MS = 1200

export function createHistory<T>(): History<T> {
  return { entries: [], pointer: 0 }
}

export interface RecordInput<T> {
  label: string
  coalesceKey: string | null
  before: T
  after: T
}

export function recordHistory<T>(history: History<T>, input: RecordInput<T>, now: number): History<T> {
  // 新编辑出现时，pointer 之后的重做分支立即作废
  const applied = history.entries.slice(0, history.pointer)
  const top = applied[applied.length - 1]
  if (top && input.coalesceKey !== null && top.coalesceKey === input.coalesceKey && now - top.time <= COALESCE_WINDOW_MS) {
    // 同一段连续编辑：保留最初的 before，只推进 after，合并为一步
    const merged: HistoryEntry<T> = { ...top, after: input.after, time: now }
    return { entries: [...applied.slice(0, -1), merged], pointer: applied.length }
  }
  const entry: HistoryEntry<T> = { label: input.label, coalesceKey: input.coalesceKey, before: input.before, after: input.after, time: now }
  const entries = [...applied, entry].slice(-HISTORY_LIMIT)
  return { entries, pointer: entries.length }
}

export function undoHistory<T>(history: History<T>): { history: History<T>; entry: HistoryEntry<T> } | null {
  if (history.pointer === 0) return null
  const entry = history.entries[history.pointer - 1]
  // 撤销后封口：撤销点之前的步骤不允许再与后续新编辑合并
  return { history: sealHistory({ ...history, pointer: history.pointer - 1 }), entry }
}

export function redoHistory<T>(history: History<T>): { history: History<T>; entry: HistoryEntry<T> } | null {
  if (history.pointer >= history.entries.length) return null
  const entry = history.entries[history.pointer]
  return { history: { ...history, pointer: history.pointer + 1 }, entry }
}

/** 结束一段连续编辑（如拖动松手、切换方案），之后的编辑不再并入上一步 */
export function sealHistory<T>(history: History<T>): History<T> {
  const topIndex = history.pointer - 1
  const top = history.entries[topIndex]
  if (!top || top.coalesceKey === null) return history
  const entries = [...history.entries]
  entries[topIndex] = { ...top, coalesceKey: null }
  return { ...history, entries }
}

export function readHistoryMeta<T>(history: History<T>): HistoryMeta {
  const undoEntry = history.pointer > 0 ? history.entries[history.pointer - 1] : null
  const redoEntry = history.pointer < history.entries.length ? history.entries[history.pointer] : null
  return {
    canUndo: undoEntry !== null,
    canRedo: redoEntry !== null,
    undoLabel: undoEntry?.label ?? null,
    redoLabel: redoEntry?.label ?? null,
  }
}
