import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createId,
  createInitialDocument,
  createPlan,
  type DeskItem,
  type DeviceType,
  type LayoutAnalysis,
  type WorkspaceDocument,
  type WorkspacePlan,
  type WorkspaceStatus,
} from '../../shared/models'
import { clampDeskSize, clampItemDimension } from '../../shared/layoutRules'
import { moveCanvasItem, rotateCanvasItem } from '../canvas/canvasViewModel'
import { createMaterialDraft } from '../materials/materialsViewModel'
import { inspectPlan } from '../inspection/inspectionViewModel'
import { PlanHistoryStore } from './planHistory'
import { createSerializedSaver, type SerializedSaver } from './saveQueue'
import { LocalWorkspaceRepository, type WorkspaceRepository } from './workspaceRepository'

export interface WorkspaceViewModel {
  status: WorkspaceStatus
  document: WorkspaceDocument | null
  activePlan: WorkspacePlan | null
  selectedItem: DeskItem | null
  analysis: LayoutAnalysis
  issueIds: string[]
  issueCount: number
  feedback: string
  isPreviewOpen: boolean
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undo: () => void
  redo: () => void
  selectItem: (id: string | null) => void
  addItem: (type: DeviceType) => void
  removeItem: (id: string) => void
  moveItem: (id: string, x: number, y: number) => void
  rotateItem: (id: string, delta: number) => void
  updateItem: (id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => void
  updateDesk: (field: 'deskWidthMm' | 'deskHeightMm', value: number) => void
  createNewPlan: () => void
  duplicatePlan: () => void
  selectPlan: (id: string) => void
  deleteCurrentPlan: () => void
  openPreview: () => void
  closePreview: () => void
}

const emptyInspection = { analysis: { overlapIds: [], outOfBoundsIds: [], coveragePercent: 0, status: 'clear' as const }, issueIds: [], issueCount: 0 }

interface HistoryAvailability {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
}

const noHistory: HistoryAvailability = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null }

export function useWorkspaceViewModel(repository?: WorkspaceRepository): WorkspaceViewModel {
  const repositoryRef = useRef(repository ?? new LocalWorkspaceRepository())
  // 撤销记录按方案各自独立保存，语义见 planHistory.ts 顶部约定
  const historyRef = useRef(new PlanHistoryStore())
  // 保存串行排队：撤销产生的新状态一定最后在磁盘上落定，在途的旧自动保存无法把它覆盖回去
  const saverRef = useRef<SerializedSaver<WorkspaceDocument>>(
    createSerializedSaver((nextDocument) => repositoryRef.current.save(nextDocument)),
  )
  const saveSeqRef = useRef(0)
  const [status, setStatus] = useState<WorkspaceStatus>('loading')
  const [document, setDocument] = useState<WorkspaceDocument | null>(null)
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [feedback, setFeedback] = useState('正在准备你的工作台…')
  const [historyAvailability, setHistoryAvailability] = useState<HistoryAvailability>(noHistory)

  useEffect(() => {
    let active = true
    void repositoryRef.current.load().then((loaded) => {
      if (!active) return
      const nextDocument = loaded ?? createInitialDocument()
      setDocument(nextDocument)
      setStatus('ready')
      setFeedback(loaded ? '已恢复上次编辑状态' : '已创建示例工作台，可以直接拖动设备')
    }).catch(() => {
      if (!active) return
      setDocument(createInitialDocument())
      setStatus('error')
      setFeedback('本地数据读取失败，当前使用临时工作台')
    })
    return () => { active = false }
  }, [])

  const activePlan = useMemo(
    () => document?.plans.find((plan) => plan.id === document.activePlanId) ?? null,
    [document],
  )
  const selectedItem = activePlan?.items.find((item) => item.id === selectedItemId) ?? null
  const inspection = useMemo(() => activePlan ? inspectPlan(activePlan) : emptyInspection, [activePlan])
  const { analysis, issueIds, issueCount } = inspection

  const syncHistoryAvailability = useCallback((planId: string | null) => {
    if (!planId) {
      setHistoryAvailability(noHistory)
      return
    }
    const history = historyRef.current
    setHistoryAvailability({
      canUndo: history.canUndo(planId),
      canRedo: history.canRedo(planId),
      undoLabel: history.peekUndo(planId)?.label ?? null,
      redoLabel: history.peekRedo(planId)?.label ?? null,
    })
  }, [])

  const persist = useCallback(async (nextDocument: WorkspaceDocument, message: string) => {
    setDocument(nextDocument)
    setStatus('saving')
    setFeedback(message)
    const seq = ++saveSeqRef.current
    try {
      await saverRef.current.enqueue(nextDocument)
      // 只让最后一次保存决定状态，避免在途的旧保存把界面打回「已保存」
      if (saveSeqRef.current === seq) setStatus('ready')
    } catch {
      if (saveSeqRef.current === seq) {
        setStatus('error')
        setFeedback('自动保存失败，请检查浏览器本地存储权限')
      }
    }
  }, [])

  const updateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan, message: string, coalesceKey: string | null = null) => {
    if (!document || !activePlan) return
    const nextPlan = { ...updater(activePlan), updatedAt: new Date().toISOString() }
    historyRef.current.record(activePlan.id, { before: activePlan, after: nextPlan, label: message, coalesceKey })
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan) }
    syncHistoryAvailability(activePlan.id)
    void persist(nextDocument, message)
  }, [activePlan, document, persist, syncHistoryAvailability])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    if (!activePlan) return
    const draft = createMaterialDraft(type, activePlan.items.length)
    updateActivePlan((plan) => ({ ...plan, items: [...plan.items, draft.item] }), draft.feedback)
    setSelectedItemId(draft.item.id)
  }, [activePlan, updateActivePlan])

  const removeItem = useCallback((id: string) => {
    updateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }), '设备已移除')
    setSelectedItemId((current) => current === id ? null : current)
  }, [updateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    // 同一件设备的连续拖动合并为一步
    updateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }), '位置已更新', `move:${id}`)
  }, [updateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    updateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }), '角度已更新')
  }, [updateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    // 同一个输入框的连续敲击合并为一步，不同字段各算各的
    const coalesceKey = `item:${id}:${Object.keys(patch).sort().join('+')}`
    updateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }), '尺寸参数已更新', coalesceKey)
  }, [updateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    if (!activePlan) return
    updateActivePlan((plan) => ({ ...plan, [field]: clampDeskSize(value, plan[field]) }), '桌面尺寸已更新', `desk:${field}`)
  }, [activePlan, updateActivePlan])

  const undo = useCallback(() => {
    if (!document || !activePlan) return
    const entry = historyRef.current.undo(activePlan.id)
    if (!entry) return
    // 一次性写回完整快照，撤销不会出现只恢复了一半的中间态
    const restored = entry.before
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === restored.id ? restored : plan) }
    setSelectedItemId((current) => (current && !restored.items.some((item) => item.id === current) ? null : current))
    syncHistoryAvailability(activePlan.id)
    void persist(nextDocument, `已撤销：${entry.label}`)
  }, [activePlan, document, persist, syncHistoryAvailability])

  const redo = useCallback(() => {
    if (!document || !activePlan) return
    const entry = historyRef.current.redo(activePlan.id)
    if (!entry) return
    const restored = entry.after
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === restored.id ? restored : plan) }
    setSelectedItemId((current) => (current && !restored.items.some((item) => item.id === current) ? null : current))
    syncHistoryAvailability(activePlan.id)
    void persist(nextDocument, `已重做：${entry.label}`)
  }, [activePlan, document, persist, syncHistoryAvailability])

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [undo, redo])

  const createNewPlan = useCallback(() => {
    if (!document) return
    const plan = createPlan(`工作台 ${document.plans.length + 1}`, false)
    void persist({ ...document, plans: [...document.plans, plan], activePlanId: plan.id }, '已创建空白方案，撤销记录从零开始')
    setSelectedItemId(null)
    syncHistoryAvailability(plan.id)
  }, [document, persist, syncHistoryAvailability])

  const duplicatePlan = useCallback(() => {
    if (!document || !activePlan) return
    const copy: WorkspacePlan = {
      ...activePlan,
      id: createId('plan'),
      name: `${activePlan.name} · 副本`,
      items: activePlan.items.map((item) => ({ ...item, id: createId('item') })),
      updatedAt: new Date().toISOString(),
    }
    void persist({ ...document, plans: [...document.plans, copy], activePlanId: copy.id }, '方案已复制，副本从空白撤销记录开始')
    setSelectedItemId(null)
    syncHistoryAvailability(copy.id)
  }, [activePlan, document, persist, syncHistoryAvailability])

  const selectPlan = useCallback((id: string) => {
    if (!document || !document.plans.some((plan) => plan.id === id)) return
    void persist({ ...document, activePlanId: id }, '已切换方案，撤销记录按方案各自保留')
    setSelectedItemId(null)
    syncHistoryAvailability(id)
  }, [document, persist, syncHistoryAvailability])

  const deleteCurrentPlan = useCallback(() => {
    if (!document || !activePlan || document.plans.length <= 1) {
      setFeedback('至少保留一个工作台方案')
      return
    }
    const remaining = document.plans.filter((plan) => plan.id !== activePlan.id)
    // 删除方案不可撤销：该方案的撤销记录一并移除
    historyRef.current.removePlan(activePlan.id)
    void persist({ ...document, plans: remaining, activePlanId: remaining[0].id }, '方案已删除，删除方案不可撤销')
    setSelectedItemId(null)
    syncHistoryAvailability(remaining[0].id)
  }, [activePlan, document, persist, syncHistoryAvailability])

  const openPreview = useCallback(() => setIsPreviewOpen(true), [])
  const closePreview = useCallback(() => setIsPreviewOpen(false), [])

  return {
    status,
    document,
    activePlan,
    selectedItem,
    analysis,
    issueIds,
    issueCount,
    feedback,
    isPreviewOpen,
    canUndo: historyAvailability.canUndo,
    canRedo: historyAvailability.canRedo,
    undoLabel: historyAvailability.undoLabel,
    redoLabel: historyAvailability.redoLabel,
    undo,
    redo,
    selectItem,
    addItem,
    removeItem,
    moveItem,
    rotateItem,
    updateItem,
    updateDesk,
    createNewPlan,
    duplicatePlan,
    selectPlan,
    deleteCurrentPlan,
    openPreview,
    closePreview,
  }
}
