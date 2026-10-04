import type { WorkspacePlan } from '../../shared/models'

/**
 * 撤销 / 重做的边界约定（改动这里之前先读完）：
 *
 * - 历史按方案各自独立记录：切换方案不会清空任何一方的记录，切回去仍可继续撤销。
 * - 新建、复制得到的方案从空白历史开始；删除方案会连同它的历史一起移除，
 *   「删除方案」本身不可撤销（视图层在反馈文案里向用户明示这一点）。
 * - 只有方案内容编辑会入栈：增删设备、拖动、旋转、改设备尺寸、改桌面尺寸；
 *   切换方案、选中设备、打开预览等导航类操作不入栈。
 * - 连续同类编辑（同一件设备的拖动、同一个输入框的连续输入）携带相同 coalesceKey，
 *   在 COALESCE_WINDOW_MS 内合并为一步，避免一次拖动产生几十条记录。
 * - 撤销之后再产生新编辑，该方案的重做栈立即作废。
 * - 每个方案最多保留 HISTORY_LIMIT 步，超出的最早记录被丢弃；
 *   快照直接引用不可变状态（更新均为展开拷贝），结构共享，内存占用有界，
 *   长时间编辑不会越用越卡。
 */
export const HISTORY_LIMIT = 50
export const COALESCE_WINDOW_MS = 800

export interface HistoryEntry {
  /** 编辑前的方案快照（撤销要恢复到的状态） */
  before: WorkspacePlan
  /** 编辑后的方案快照（重做要恢复到的状态） */
  after: WorkspacePlan
  /** 用于反馈文案与悬浮提示，例如「位置已更新」 */
  label: string
  /** 相同键且在时间窗口内的连续编辑会合并为一步；null 表示绝不合并 */
  coalesceKey: string | null
  recordedAt: number
}

interface PlanHistory {
  past: HistoryEntry[]
  future: HistoryEntry[]
}

export class PlanHistoryStore {
  private readonly histories = new Map<string, PlanHistory>()

  private getHistory(planId: string): PlanHistory {
    let history = this.histories.get(planId)
    if (!history) {
      history = { past: [], future: [] }
      this.histories.set(planId, history)
    }
    return history
  }

  record(planId: string, entry: Omit<HistoryEntry, 'recordedAt'>, now: number = Date.now()): void {
    const history = this.getHistory(planId)
    // 任何新编辑都会作废当前的重做栈
    history.future = []
    const last = history.past[history.past.length - 1]
    if (entry.coalesceKey !== null && last?.coalesceKey === entry.coalesceKey && now - last.recordedAt <= COALESCE_WINDOW_MS) {
      // 合并：保留最早的 before，只推进 after，整段连续编辑算一步
      last.after = entry.after
      last.label = entry.label
      last.recordedAt = now
      return
    }
    history.past.push({ ...entry, recordedAt: now })
    if (history.past.length > HISTORY_LIMIT) history.past.shift()
  }

  /** 弹出最近一步编辑，调用方负责把 entry.before 整体写回；返回 null 表示没有可撤销的编辑 */
  undo(planId: string): HistoryEntry | null {
    const history = this.getHistory(planId)
    const entry = history.past.pop() ?? null
    if (!entry) return null
    history.future.push(entry)
    return entry
  }

  /** 弹出最近一步被撤销的编辑，调用方负责把 entry.after 整体写回；返回 null 表示没有可重做的编辑 */
  redo(planId: string): HistoryEntry | null {
    const history = this.getHistory(planId)
    const entry = history.future.pop() ?? null
    if (!entry) return null
    history.past.push(entry)
    if (history.past.length > HISTORY_LIMIT) history.past.shift()
    return entry
  }

  canUndo(planId: string): boolean {
    return this.getHistory(planId).past.length > 0
  }

  canRedo(planId: string): boolean {
    return this.getHistory(planId).future.length > 0
  }

  peekUndo(planId: string): HistoryEntry | null {
    const { past } = this.getHistory(planId)
    return past[past.length - 1] ?? null
  }

  peekRedo(planId: string): HistoryEntry | null {
    const { future } = this.getHistory(planId)
    return future[future.length - 1] ?? null
  }

  /** 删除方案时调用：该方案的历史一并移除，删除操作不可撤销 */
  removePlan(planId: string): void {
    this.histories.delete(planId)
  }
}
