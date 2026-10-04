import { describe, expect, it } from 'vitest'
import { createPlan, type WorkspacePlan } from '../../../shared/models'
import { COALESCE_WINDOW_MS, HISTORY_LIMIT, PlanHistoryStore } from '../planHistory'

function makePlan(id: string, tag: number): WorkspacePlan {
  return { ...createPlan(`方案-${tag}`, false), id }
}

function edit(before: WorkspacePlan, after: WorkspacePlan, coalesceKey: string | null = null, label = '编辑') {
  return { before, after, label, coalesceKey }
}

describe('plan history store', () => {
  it('撤销返回上一步编辑，重做返回同一步编辑', () => {
    const store = new PlanHistoryStore()
    const before = makePlan('plan-a', 0)
    const after = makePlan('plan-a', 1)
    store.record('plan-a', edit(before, after, null, '位置已更新'))

    expect(store.canUndo('plan-a')).toBe(true)
    expect(store.peekUndo('plan-a')?.label).toBe('位置已更新')

    const undone = store.undo('plan-a')
    expect(undone?.before).toBe(before)
    expect(store.canUndo('plan-a')).toBe(false)
    expect(store.canRedo('plan-a')).toBe(true)
    expect(store.peekRedo('plan-a')?.label).toBe('位置已更新')

    const redone = store.redo('plan-a')
    expect(redone?.after).toBe(after)
    expect(store.canUndo('plan-a')).toBe(true)
    expect(store.canRedo('plan-a')).toBe(false)
  })

  it('空栈上撤销与重做都返回 null', () => {
    const store = new PlanHistoryStore()
    expect(store.undo('plan-a')).toBeNull()
    expect(store.redo('plan-a')).toBeNull()
  })

  it('相同合并键的连续编辑在时间窗口内合并为一步，保留最早的 before', () => {
    const store = new PlanHistoryStore()
    const s0 = makePlan('plan-a', 0)
    const s1 = makePlan('plan-a', 1)
    const s2 = makePlan('plan-a', 2)
    const s3 = makePlan('plan-a', 3)
    store.record('plan-a', edit(s0, s1, 'move:item-1'), 1000)
    store.record('plan-a', edit(s1, s2, 'move:item-1'), 1000 + COALESCE_WINDOW_MS / 2)
    store.record('plan-a', edit(s2, s3, 'move:item-1'), 1000 + COALESCE_WINDOW_MS)

    const undone = store.undo('plan-a')
    expect(undone?.before).toBe(s0)
    expect(undone?.after).toBe(s3)
    expect(store.canUndo('plan-a')).toBe(false)
  })

  it('超出时间窗口或合并键不同都会另起一步', () => {
    const store = new PlanHistoryStore()
    const plans = Array.from({ length: 5 }, (_, index) => makePlan('plan-a', index))
    store.record('plan-a', edit(plans[0], plans[1], 'move:item-1'), 1000)
    store.record('plan-a', edit(plans[1], plans[2], 'move:item-1'), 1000 + COALESCE_WINDOW_MS + 1)
    store.record('plan-a', edit(plans[2], plans[3], 'move:item-2'), 2000 + COALESCE_WINDOW_MS / 2)
    store.record('plan-a', edit(plans[3], plans[4], null), 2000 + COALESCE_WINDOW_MS / 2 + 1)

    expect(store.undo('plan-a')?.before).toBe(plans[3])
    expect(store.undo('plan-a')?.before).toBe(plans[2])
    expect(store.undo('plan-a')?.before).toBe(plans[1])
    expect(store.undo('plan-a')?.before).toBe(plans[0])
    expect(store.undo('plan-a')).toBeNull()
  })

  it('撤销之后产生新编辑，重做栈立即作废', () => {
    const store = new PlanHistoryStore()
    const s0 = makePlan('plan-a', 0)
    const s1 = makePlan('plan-a', 1)
    const s2 = makePlan('plan-a', 2)
    store.record('plan-a', edit(s0, s1))
    store.undo('plan-a')
    expect(store.canRedo('plan-a')).toBe(true)

    store.record('plan-a', edit(s0, s2))
    expect(store.canRedo('plan-a')).toBe(false)
    expect(store.redo('plan-a')).toBeNull()
  })

  it(`每个方案最多保留 ${HISTORY_LIMIT} 步，超出丢弃最早记录`, () => {
    const store = new PlanHistoryStore()
    for (let index = 0; index < HISTORY_LIMIT + 10; index += 1) {
      store.record('plan-a', edit(makePlan('plan-a', index), makePlan('plan-a', index + 1), null, `编辑-${index}`), index)
    }
    let steps = 0
    let oldestLabel: string | null = null
    for (let entry = store.undo('plan-a'); entry; entry = store.undo('plan-a')) {
      steps += 1
      oldestLabel = entry.label
    }
    expect(steps).toBe(HISTORY_LIMIT)
    expect(oldestLabel).toBe('编辑-10')
  })

  it('各方案的历史相互独立，删除方案时其历史一并移除', () => {
    const store = new PlanHistoryStore()
    store.record('plan-a', edit(makePlan('plan-a', 0), makePlan('plan-a', 1)))
    store.record('plan-b', edit(makePlan('plan-b', 0), makePlan('plan-b', 1)))

    expect(store.canUndo('plan-a')).toBe(true)
    expect(store.canUndo('plan-b')).toBe(true)

    store.removePlan('plan-a')
    expect(store.canUndo('plan-a')).toBe(false)
    expect(store.undo('plan-a')).toBeNull()
    expect(store.canUndo('plan-b')).toBe(true)
  })
})
