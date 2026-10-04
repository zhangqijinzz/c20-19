import { describe, expect, it } from 'vitest'
import {
  COALESCE_WINDOW_MS,
  HISTORY_LIMIT,
  createHistory,
  readHistoryMeta,
  recordHistory,
  redoHistory,
  sealHistory,
  undoHistory,
} from '../historyManager'

function record(history: ReturnType<typeof createHistory<string>>, label: string, coalesceKey: string | null = null, now = 0) {
  return recordHistory(history, { label, coalesceKey, before: `before:${label}`, after: `after:${label}` }, now)
}

describe('history manager', () => {
  it('undoes and redoes a recorded step', () => {
    let history = createHistory<string>()
    history = record(history, '移动设备')
    expect(readHistoryMeta(history)).toEqual({ canUndo: true, canRedo: false, undoLabel: '移动设备', redoLabel: null })

    const undone = undoHistory(history)
    expect(undone?.entry.before).toBe('before:移动设备')
    history = undone!.history
    expect(readHistoryMeta(history)).toEqual({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: '移动设备' })

    const redone = redoHistory(history)
    expect(redone?.entry.after).toBe('after:移动设备')
    history = redone!.history
    expect(readHistoryMeta(history).canUndo).toBe(true)
    expect(readHistoryMeta(history).canRedo).toBe(false)
  })

  it('returns null when there is nothing to undo or redo', () => {
    const history = createHistory<string>()
    expect(undoHistory(history)).toBeNull()
    expect(redoHistory(history)).toBeNull()
  })

  it('merges a continuous drag into a single step', () => {
    let history = createHistory<string>()
    // 模拟一次拖动产生的几十个 pointermove
    for (let i = 0; i < 30; i += 1) {
      history = recordHistory(history, { label: '移动设备', coalesceKey: 'move:item-1', before: 'origin', after: `pos-${i}` }, i * 16)
    }
    expect(history.entries).toHaveLength(1)
    const undone = undoHistory(history)
    expect(undone?.entry.before).toBe('origin')
    expect(undone?.entry.after).toBe('pos-29')
  })

  it('does not merge once the coalesce window has passed', () => {
    let history = createHistory<string>()
    history = record(history, '调整尺寸', 'item:item-1', 0)
    history = record(history, '调整尺寸', 'item:item-1', COALESCE_WINDOW_MS + 1)
    expect(history.entries).toHaveLength(2)
  })

  it('does not merge different coalesce keys', () => {
    let history = createHistory<string>()
    history = record(history, '移动设备', 'move:item-1', 0)
    history = record(history, '移动设备', 'move:item-2', 100)
    expect(history.entries).toHaveLength(2)
  })

  it('sealing ends a gesture so the next drag starts a new step', () => {
    let history = createHistory<string>()
    history = record(history, '移动设备', 'move:item-1', 0)
    history = sealHistory(history)
    history = record(history, '移动设备', 'move:item-1', 100)
    expect(history.entries).toHaveLength(2)
  })

  it('discards the redo branch when a new edit happens after undo', () => {
    let history = createHistory<string>()
    history = record(history, '第一步')
    history = record(history, '第二步')
    history = undoHistory(history)!.history
    expect(readHistoryMeta(history).canRedo).toBe(true)
    history = record(history, '新编辑')
    expect(readHistoryMeta(history).canRedo).toBe(false)
    expect(history.entries.map((entry) => entry.label)).toEqual(['第一步', '新编辑'])
  })

  it('does not merge a new edit into the step before an undo', () => {
    let history = createHistory<string>()
    history = record(history, '第一步', 'move:item-1', 0)
    history = record(history, '第二步', null, 10)
    history = undoHistory(history)!.history
    history = record(history, '新编辑', 'move:item-1', 20)
    // 若没有封口，「新编辑」会被错误地并入「第一步」
    expect(history.entries.map((entry) => entry.label)).toEqual(['第一步', '新编辑'])
    expect(history.entries[0].after).toBe('after:第一步')
  })

  it('caps the history length so long sessions stay bounded', () => {
    let history = createHistory<string>()
    for (let i = 0; i < HISTORY_LIMIT + 50; i += 1) {
      history = record(history, `步骤 ${i}`, null, i * (COALESCE_WINDOW_MS + 1))
    }
    expect(history.entries).toHaveLength(HISTORY_LIMIT)
    expect(history.pointer).toBe(HISTORY_LIMIT)
    expect(history.entries[0].label).toBe('步骤 50')
    expect(readHistoryMeta(history).undoLabel).toBe(`步骤 ${HISTORY_LIMIT + 49}`)
  })
})
