/**
 * 串行化保存队列。
 *
 * 保证：
 * - 同一时间最多一个写入在途，写入按入队顺序执行，不会出现旧状态后写完覆盖新状态；
 * - 在途写入期间到来的新状态只保留最新一份（latest wins），拖动等高频编辑不会堆积大量写请求；
 * - 每次写入都是完整快照，队列中不存在半截状态；
 * - 写入失败时保留最新待写数据，等下一次 enqueue 重试，不静默丢写。
 */

export interface SaveQueueCallbacks {
  onBusy?: () => void
  onIdle?: () => void
  onError?: () => void
}

export interface SaveQueue<T> {
  enqueue(value: T): void
  /** 等待当前已入队的写入全部完成（测试用） */
  flush(): Promise<void>
}

export function createSaveQueue<T>(save: (value: T) => Promise<void>, callbacks: SaveQueueCallbacks = {}): SaveQueue<T> {
  let pending: T | null = null
  let running = false
  let chain: Promise<void> = Promise.resolve()

  const drain = async (): Promise<void> => {
    callbacks.onBusy?.()
    try {
      while (pending !== null) {
        const value = pending
        pending = null
        try {
          await save(value)
        } catch {
          // 保留最新状态等待下次 enqueue 重试；若期间已有更新的状态则以其为准
          if (pending === null) pending = value
          callbacks.onError?.()
          return
        }
      }
      callbacks.onIdle?.()
    } finally {
      running = false
    }
  }

  return {
    enqueue(value: T): void {
      pending = value
      if (running) return
      running = true
      chain = chain.then(drain)
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
