import { describe, expect, it } from 'vitest'
import { createSaveQueue } from '../saveQueue'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('save queue', () => {
  it('writes in order and keeps only the latest value while a write is in flight', async () => {
    const written: string[] = []
    const gate = deferred()
    const queue = createSaveQueue<string>(async (value) => { await gate.promise; written.push(value) })

    queue.enqueue('a')
    await tick() // 第一次写入已在途
    queue.enqueue('b')
    queue.enqueue('c') // b 被更新的 c 取代
    gate.resolve()
    await queue.flush()

    expect(written).toEqual(['a', 'c'])
  })

  it('an undo result enqueued last is what ends up persisted', async () => {
    const written: string[] = []
    const queue = createSaveQueue<string>(async (value) => { written.push(value) })

    queue.enqueue('编辑后')
    queue.enqueue('撤销恢复的状态')
    await queue.flush()

    expect(written[written.length - 1]).toBe('撤销恢复的状态')
  })

  it('reports busy/idle around a drained queue', async () => {
    const events: string[] = []
    const queue = createSaveQueue<string>(async () => {}, { onBusy: () => events.push('busy'), onIdle: () => events.push('idle') })

    queue.enqueue('a')
    await queue.flush()

    expect(events).toEqual(['busy', 'idle'])
  })

  it('keeps the latest value for retry after a failed write', async () => {
    const written: string[] = []
    const errors: string[] = []
    let shouldFail = true
    const queue = createSaveQueue<string>(
      async (value) => {
        if (shouldFail) throw new Error('storage unavailable')
        written.push(value)
      },
      { onError: () => errors.push('error') },
    )

    queue.enqueue('a')
    await queue.flush()
    expect(written).toEqual([])
    expect(errors).toHaveLength(1)

    shouldFail = false
    queue.enqueue('b')
    await queue.flush()
    // 失败不会丢写：最新状态 b 在下一次入队时成功落盘
    expect(written).toEqual(['b'])
  })
})
