/**
 * 把异步保存串行化：后入队的保存一定等先入队的完成后才开始。
 *
 * 撤销/重做会立刻产生一份新文档并要求落盘，而编辑时的自动保存可能还在
 * IndexedDB 里写着旧状态。如果不排队，旧保存可能后提交，把撤销结果覆盖回去。
 * 串行化之后，落盘顺序与状态产生顺序一致，最后一个落盘的永远是最新状态；
 * 单次失败不会阻塞后续写入，但错误会透传给调用方。
 */
export type SaveTask<T> = (value: T) => Promise<void>

export interface SerializedSaver<T> {
  enqueue(value: T): Promise<void>
}

export function createSerializedSaver<T>(save: SaveTask<T>): SerializedSaver<T> {
  let chain: Promise<void> = Promise.resolve()
  return {
    enqueue(value: T): Promise<void> {
      const run = chain.then(() => save(value))
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
}
