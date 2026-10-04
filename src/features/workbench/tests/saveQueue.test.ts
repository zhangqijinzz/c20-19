import { describe, expect, it } from 'vitest'
import { createSerializedSaver } from '../saveQueue'

describe('serialized saver', () => {
  it('并发入队的保存严格按顺序落盘，旧状态不会覆盖新状态', async () => {
    const written: string[] = []
    const delays: Record<string, number> = { 撤销前: 30, 撤销后: 0 }
    const saver = createSerializedSaver<string>(async (value) => {
      // 旧状态写得更慢：如果不排队，它会后落定并覆盖撤销结果
      await new Promise((resolve) => setTimeout(resolve, delays[value]))
      written.push(value)
    })

    await Promise.all([saver.enqueue('撤销前'), saver.enqueue('撤销后')])
    expect(written).toEqual(['撤销前', '撤销后'])
  })

  it('落盘的最终内容是最后一次入队的状态', async () => {
    let stored = ''
    const saver = createSerializedSaver<string>(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === '编辑中' ? 20 : 0))
      stored = value
    })

    await Promise.all([saver.enqueue('编辑中'), saver.enqueue('撤销结果')])
    expect(stored).toBe('撤销结果')
  })

  it('单次保存失败不会阻塞后续写入，错误透传给调用方', async () => {
    const written: string[] = []
    let shouldFail = true
    const saver = createSerializedSaver<string>(async (value) => {
      if (shouldFail) {
        shouldFail = false
        throw new Error('disk full')
      }
      written.push(value)
    })

    await expect(saver.enqueue('坏')).rejects.toThrow('disk full')
    await saver.enqueue('好')
    expect(written).toEqual(['好'])
  })
})
