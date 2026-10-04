import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createId,
  createInitialDocument,
  createPlan,
  getDeviceDefinition,
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
import {
  createHistory,
  readHistoryMeta,
  recordHistory,
  redoHistory,
  sealHistory,
  undoHistory,
  type History,
  type HistoryMeta,
} from './historyManager'
import { createSaveQueue, type SaveQueue } from './saveQueue'
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
  endGesture: () => void
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

interface HistoryStep {
  label: string
  coalesceKey?: string
}

const emptyInspection = { analysis: { overlapIds: [], outOfBoundsIds: [], coveragePercent: 0, status: 'clear' as const }, issueIds: [], issueCount: 0 }

export function useWorkspaceViewModel(repository?: WorkspaceRepository): WorkspaceViewModel {
  const repositoryRef = useRef(repository ?? new LocalWorkspaceRepository())
  const [status, setStatus] = useState<WorkspaceStatus>('loading')
  const [document, setDocument] = useState<WorkspaceDocument | null>(null)
  const documentRef = useRef<WorkspaceDocument | null>(null)
  const historyRef = useRef<History<WorkspaceDocument>>(createHistory())
  const [historyMeta, setHistoryMeta] = useState<HistoryMeta>(() => readHistoryMeta(historyRef.current))
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const [isPreviewOpen, setIsPreviewOpen] = useState(false)
  const [feedback, setFeedback] = useState('正在准备你的工作台…')

  // 保存队列：串行落盘、只写最新快照。撤销 / 重做与普通编辑共用同一队列，
  // 因此在途的自动保存永远不会把撤销前的状态写回存储。
  const saveQueueRef = useRef<SaveQueue<WorkspaceDocument> | null>(null)
  if (saveQueueRef.current === null) {
    saveQueueRef.current = createSaveQueue<WorkspaceDocument>(
      (next) => repositoryRef.current.save(next),
      {
        onBusy: () => setStatus('saving'),
        onIdle: () => setStatus('ready'),
        onError: () => {
          setStatus('error')
          setFeedback('自动保存失败，请检查浏览器本地存储权限')
        },
      },
    )
  }

  useEffect(() => {
    let active = true
    void repositoryRef.current.load().then((loaded) => {
      if (!active) return
      const nextDocument = loaded ?? createInitialDocument()
      documentRef.current = nextDocument
      setDocument(nextDocument)
      setStatus('ready')
      setFeedback(loaded ? '已恢复上次编辑状态' : '已创建示例工作台，可以直接拖动设备')
    }).catch(() => {
      if (!active) return
      const nextDocument = createInitialDocument()
      documentRef.current = nextDocument
      setDocument(nextDocument)
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

  const applyDocument = useCallback((nextDocument: WorkspaceDocument, message: string) => {
    documentRef.current = nextDocument
    setDocument(nextDocument)
    setFeedback(message)
    saveQueueRef.current?.enqueue(nextDocument)
  }, [])

  /** 所有可撤销编辑的唯一入口：先记历史，再应用并落盘 */
  const commit = useCallback((nextDocument: WorkspaceDocument, message: string, step: HistoryStep) => {
    const previous = documentRef.current
    if (previous) {
      historyRef.current = recordHistory(historyRef.current, {
        label: step.label,
        coalesceKey: step.coalesceKey ?? null,
        before: previous,
        after: nextDocument,
      }, Date.now())
      setHistoryMeta(readHistoryMeta(historyRef.current))
    }
    applyDocument(nextDocument, message)
  }, [applyDocument])

  const undo = useCallback(() => {
    const result = undoHistory(historyRef.current)
    if (!result) {
      setFeedback('没有可以撤销的修改')
      return
    }
    historyRef.current = result.history
    setHistoryMeta(readHistoryMeta(historyRef.current))
    applyDocument(result.entry.before, `已撤销：${result.entry.label}`)
  }, [applyDocument])

  const redo = useCallback(() => {
    const result = redoHistory(historyRef.current)
    if (!result) {
      setFeedback('没有可以重做的修改')
      return
    }
    historyRef.current = result.history
    setHistoryMeta(readHistoryMeta(historyRef.current))
    applyDocument(result.entry.after, `已重做：${result.entry.label}`)
  }, [applyDocument])

  /** 结束一段连续编辑（拖动松手等），后续编辑不再并入上一步 */
  const endGesture = useCallback(() => {
    historyRef.current = sealHistory(historyRef.current)
  }, [])

  const updateActivePlan = useCallback((updater: (plan: WorkspacePlan) => WorkspacePlan, message: string, step: HistoryStep) => {
    if (!document || !activePlan) return
    const nextPlan = { ...updater(activePlan), updatedAt: new Date().toISOString() }
    const nextDocument = { ...document, plans: document.plans.map((plan) => plan.id === nextPlan.id ? nextPlan : plan) }
    commit(nextDocument, message, step)
  }, [activePlan, document, commit])

  const selectItem = useCallback((id: string | null) => setSelectedItemId(id), [])

  const addItem = useCallback((type: DeviceType) => {
    if (!activePlan) return
    const draft = createMaterialDraft(type, activePlan.items.length)
    updateActivePlan((plan) => ({ ...plan, items: [...plan.items, draft.item] }), draft.feedback, { label: `添加${getDeviceDefinition(type).label}` })
    setSelectedItemId(draft.item.id)
  }, [activePlan, updateActivePlan])

  const removeItem = useCallback((id: string) => {
    const label = activePlan?.items.find((item) => item.id === id)
    updateActivePlan((plan) => ({ ...plan, items: plan.items.filter((item) => item.id !== id) }), '设备已移除', { label: `移除${label ? getDeviceDefinition(label.type).label : '设备'}` })
    setSelectedItemId((current) => current === id ? null : current)
  }, [activePlan, updateActivePlan])

  const moveItem = useCallback((id: string, x: number, y: number) => {
    updateActivePlan((plan) => ({ ...plan, items: moveCanvasItem(plan.items, id, x, y) }), '位置已更新', { label: '移动设备', coalesceKey: `move:${id}` })
  }, [updateActivePlan])

  const rotateItem = useCallback((id: string, delta: number) => {
    updateActivePlan((plan) => ({ ...plan, items: rotateCanvasItem(plan.items, id, delta) }), '角度已更新', { label: '旋转设备', coalesceKey: `rotate:${id}` })
  }, [updateActivePlan])

  const updateItem = useCallback((id: string, patch: Partial<Pick<DeskItem, 'widthMm' | 'heightMm' | 'x' | 'y'>>) => {
    const kind = patch.widthMm !== undefined || patch.heightMm !== undefined ? '尺寸' : '位置'
    updateActivePlan((plan) => ({
      ...plan,
      items: plan.items.map((item) => item.id === id ? {
        ...item,
        ...patch,
        widthMm: patch.widthMm === undefined ? item.widthMm : clampItemDimension(patch.widthMm, item.widthMm),
        heightMm: patch.heightMm === undefined ? item.heightMm : clampItemDimension(patch.heightMm, item.heightMm),
      } : item),
    }), '尺寸参数已更新', { label: `调整设备${kind}`, coalesceKey: `item:${id}` })
  }, [updateActivePlan])

  const updateDesk = useCallback((field: 'deskWidthMm' | 'deskHeightMm', value: number) => {
    if (!activePlan) return
    updateActivePlan((plan) => ({ ...plan, [field]: clampDeskSize(value, plan[field]) }), '桌面尺寸已更新', { label: '调整桌面尺寸', coalesceKey: `desk:${field}` })
  }, [activePlan, updateActivePlan])

  const createNewPlan = useCallback(() => {
    if (!document) return
    const plan = createPlan(`工作台 ${document.plans.length + 1}`, false)
    commit({ ...document, plans: [...document.plans, plan], activePlanId: plan.id }, '已创建空白方案', { label: `新建方案「${plan.name}」` })
    setSelectedItemId(null)
  }, [document, commit])

  const duplicatePlan = useCallback(() => {
    if (!document || !activePlan) return
    const copy: WorkspacePlan = {
      ...activePlan,
      id: createId('plan'),
      name: `${activePlan.name} · 副本`,
      items: activePlan.items.map((item) => ({ ...item, id: createId('item') })),
      updatedAt: new Date().toISOString(),
    }
    commit({ ...document, plans: [...document.plans, copy], activePlanId: copy.id }, '方案已复制', { label: `复制方案「${activePlan.name}」` })
    setSelectedItemId(null)
  }, [activePlan, document, commit])

  const selectPlan = useCallback((id: string) => {
    if (!document || !document.plans.some((plan) => plan.id === id)) return
    // 切换方案只是导航，不记入历史；但要给上一段连续编辑封口，避免跨方案合并
    historyRef.current = sealHistory(historyRef.current)
    applyDocument({ ...document, activePlanId: id }, '已切换方案')
    setSelectedItemId(null)
  }, [document, applyDocument])

  const deleteCurrentPlan = useCallback(() => {
    if (!document || !activePlan || document.plans.length <= 1) {
      setFeedback('至少保留一个工作台方案')
      return
    }
    const remaining = document.plans.filter((plan) => plan.id !== activePlan.id)
    commit({ ...document, plans: remaining, activePlanId: remaining[0].id }, '方案已删除', { label: `删除方案「${activePlan.name}」` })
    setSelectedItemId(null)
  }, [activePlan, document, commit])

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
    canUndo: historyMeta.canUndo,
    canRedo: historyMeta.canRedo,
    undoLabel: historyMeta.undoLabel,
    redoLabel: historyMeta.redoLabel,
    undo,
    redo,
    endGesture,
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
