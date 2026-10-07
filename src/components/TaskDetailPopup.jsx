import { useState, useRef, useEffect } from 'react'
import CustomSelect from './CustomSelect'
import HoursEditPopup, { formatHoursByUnit } from './HoursEditPopup'
import DateRangePicker from './DateRangePicker'
import MarkdownEditor from './MarkdownEditor'
import { renderMarkdownHtml } from '../utils/markdown'
import { EXEC_STATUS, MANUAL_EXEC_STATUS, deriveExecStatus } from '../utils/execStatus'
import { themeColors, computeEndFromDuration, calcGroupDurationDays } from '../utils/schedule'

const todayStr = () => {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// 动态时间格式化（MM-DD HH:mm）
const fmtDynTime = (iso) => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 状态徽标（子任务列表复用）
function StatusBadge({ status, fontSize = '11px' }) {
  const s = EXEC_STATUS[status]
  if (!s) return null
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: '10px', fontSize, fontWeight: 600, background: s.bg, color: s.color, flexShrink: 0 }}>
      {s.label}
    </span>
  )
}

// 任务详情编辑弹窗：排版与项目主页任务详情预览弹窗（TaskDetailPreview）一致
// 左主区（路径/标题/子任务/任务描述/可交付成果）+ 右属性栏（上=计划信息，下=实际完成情况）
// 编辑规则（按执行状态 execStatus，未传时按日期推导）：
// - completed：锁定编辑（所有编辑回调置空），显示计划信息 + 实际完成情况
// - in_progress：允许编辑，显示计划信息 + 实际完成情况
// - 其他（not_started/delayed）：允许编辑，不显示实际完成情况
function TaskDetailPopup({ task: taskProp, scheduleStartDate, scheduleEndDate, onClose, teamMembers = [], timeRuleUnit = '小时', timeRuleValue = 0.5, onResourceMemberChange, onResourceHoursChange, onResourceDelete, onAddResource, dailyInputHours = 8, onUpdateDuration, onAutoCalcDuration, onUpdateDates, onUpdateDeliverables, onUpdateDescription, deliverablesCatalog = [], onAddDeliverableToCatalog, skipHolidays = false, minStartDate = null, onUpdateHours, onUpdateSkipHolidays, execStatus = null, progress = null, scheduleDateMap = null, onBackToParent = null, resolveStatus = null, progressForTask = null, onSetTaskProgress = null, onSetTaskExecStatus = null, dynamicsForTask = null, onAddDynamic = null, navTasks = null, onNavigateTask = null, preferScheduleDates = false }) {
  const [editingResource, setEditingResource] = useState(null)
  const [hoursEdit, setHoursEdit] = useState(null)
  const [durationEdit, setDurationEdit] = useState(null)
  const [deliverablesPicker, setDeliverablesPicker] = useState(null)
  const [deliverablesSearch, setDeliverablesSearch] = useState('')
  const [startDateVal, setStartDateVal] = useState(scheduleStartDate)
  const [endDateVal, setEndDateVal] = useState(scheduleEndDate)
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [endRuleDropdown, setEndRuleDropdown] = useState(null)
  // 项目主页模式：任务动态输入 / 手动状态下拉 / 进度数字输入（脏值，null=未编辑，跟随外部值）
  const [dynamicDraft, setDynamicDraft] = useState('')
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [progressDirty, setProgressDirty] = useState(null)
  // 任务描述折叠：内容超过约9行时收起显示（底部渐隐），展开后可收起
  const [descExpanded, setDescExpanded] = useState(false)
  const [descOverflow, setDescOverflow] = useState(false)
  const descContentRef = useRef(null)
  const dynInputRef = useRef(null)
  const statusMenuRef = useRef(null)
  const durationEditRef = useRef(null)
  const deliverablesPickerRef = useRef(null)
  const deliverablesSearchRef = useRef(null)
  const endRuleRef = useRef(null)

  // 子任务导航栈：非叶子任务弹窗点击子任务进入其详情（只读视图），「返回上一级」逐级弹出
  const [viewIds, setViewIds] = useState([])
  useEffect(() => { setViewIds([]) }, [taskProp && (taskProp.task_ulid || taskProp.id)])

  // 切换任务或进出子任务导航时退出描述编辑态、清空动态输入/状态菜单/进度脏值、收起描述
  useEffect(() => {
    setEditingDescription(false)
    setDescriptionDraft('')
    setDynamicDraft('')
    setStatusMenuOpen(false)
    setProgressDirty(null)
    setDescExpanded(false)
  }, [taskProp && (taskProp.task_ulid || taskProp.id), viewIds.length])

  // 描述折叠测量：仅在收起状态测量内容是否溢出（展开状态保持「收起」按钮可见）
  useEffect(() => {
    if (descExpanded || editingDescription) return
    const el = descContentRef.current
    if (!el) { setDescOverflow(false); return }
    const t = setTimeout(() => setDescOverflow(el.scrollHeight > el.clientHeight + 2), 0)
    return () => clearTimeout(t)
  }, [descExpanded, editingDescription, taskProp, viewIds])

  // 手动状态下拉：点击菜单外区域关闭
  useEffect(() => {
    if (!statusMenuOpen) return
    const onDocDown = (e) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target)) setStatusMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [statusMenuOpen])

  useEffect(() => {
    if (!durationEdit) return
    const handler = (e) => {
      if (durationEditRef.current && !durationEditRef.current.contains(e.target)) {
        setDurationEdit(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [durationEdit])

  useEffect(() => {
    if (!deliverablesPicker) return
    const handler = (e) => {
      if (deliverablesPickerRef.current && !deliverablesPickerRef.current.contains(e.target)) {
        setDeliverablesPicker(null)
        setDeliverablesSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [deliverablesPicker])

  useEffect(() => {
    if (!endRuleDropdown) return
    const handler = (e) => {
      if (endRuleRef.current && !endRuleRef.current.contains(e.target)) {
        setEndRuleDropdown(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [endRuleDropdown])

  // 节点起止日期解析：每个节点优先取自身树字段（start_date/end_date），回落排期映射
  // scheduleDateMap；叶子直接返回自身值，非叶子由子树聚合（开始取最早、结束取最晚，小时跟随对应节点）
  const aggregateNodeDates = (root) => {
    if (!root) return null
    let minS = null, maxE = null, sh = null, eh = null
    const consider = (sd, ed, sH, eH) => {
      if (sd && (minS == null || sd < minS || (sd === minS && (sH ?? 99) < (sh ?? 99)))) { minS = sd; sh = sH ?? null }
      if (ed && (maxE == null || ed > maxE || (ed === maxE && (eH ?? -1) > (eh ?? -1)))) { maxE = ed; eh = eH ?? null }
    }
    const walk = (n) => {
      const d = scheduleDateMap ? (scheduleDateMap[n.id] || scheduleDateMap[String(n.task_ulid || '')]) : null
      consider(n.start_date || d?.startDate || null, n.end_date || d?.endDate || null, n.start_hour ?? d?.startHour ?? null, n.end_hour ?? d?.endHour ?? null)
      if (n.children && n.children.length > 0) n.children.forEach(walk)
    }
    walk(root)
    return (minS || maxE) ? { startDate: minS, endDate: maxE, startHour: sh, endHour: eh } : null
  }

  // 日期编辑值同步：跟随当前展示任务——顶层用外部传入的起止；
  // 下钻子任务取子任务自己的日期（叶子=自身字段；非叶子=子树聚合）
  useEffect(() => {
    if (!taskProp) return
    let s = scheduleStartDate
    let e = scheduleEndDate
    if (viewIds.length > 0 && taskProp.children) {
      const findNodeById = (nodes, id) => {
        for (const n of nodes || []) {
          if (String(n.task_ulid || n.id) === id) return n
          if (n.children && n.children.length > 0) {
            const r = findNodeById(n.children, id)
            if (r) return r
          }
        }
        return null
      }
      const n = findNodeById(taskProp.children, viewIds[viewIds.length - 1])
      if (n) {
        const agg = aggregateNodeDates(n)
        s = agg?.startDate ?? null
        e = agg?.endDate ?? null
      }
    }
    setStartDateVal(s)
    setEndDateVal(e)
  }, [scheduleStartDate, scheduleEndDate, viewIds, taskProp, scheduleDateMap])

  if (!taskProp) return null

  // 从 taskProp 子树实时解析导航目标（避免编辑后快照过期），同时收集路径
  // 路径口径与项目主页一致（祖先名称链，根→父，不含任务自己）
  const findWithPath = (nodes, id, prefix) => {
    for (const n of nodes || []) {
      if (String(n.task_ulid || n.id) === id) return { node: n, path: prefix }
      if (n.children && n.children.length > 0) {
        const r = findWithPath(n.children, id, [...prefix, n.name])
        if (r) return r
      }
    }
    return null
  }
  const navResolution = viewIds.length > 0
    ? findWithPath(taskProp.children, viewIds[viewIds.length - 1], [...(taskProp.ancestors || []), taskProp.name])
    : null
  const navTask = navResolution?.node || null
  const navPath = navResolution?.path || null
  const navActive = !!navTask
  // 子任务的起止时间/小时：优先任务树字段，回落排期结果映射
  const navDates = navTask
    ? (scheduleDateMap?.[navTask.id] || scheduleDateMap?.[String(navTask.task_ulid || '')] || null)
    : null
  const task = navTask
    ? { ...navTask, start_hour: navTask.start_hour ?? navDates?.startHour ?? null, end_hour: navTask.end_hour ?? navDates?.endHour ?? null }
    : taskProp
  const taskId = task.task_ulid || task.id
  const hasChildren = task.children && task.children.length > 0

  // 展示任务（顶层或下钻的任意层级节点）起止兜底：非叶子节点自身没有
  // start_date/end_date 时由子树聚合（树字段优先、排期映射兜底；开始取最早、结束取最晚）
  const dispAggDates = hasChildren ? aggregateNodeDates(task) : null
  // 显示用起止时间：优先自身/外部传入，再回落子树聚合
  const effScheduleStartDate = (navTask ? (navTask.start_date || navDates?.startDate || null) : scheduleStartDate) || dispAggDates?.startDate || null
  const effScheduleEndDate = (navTask ? (navTask.end_date || navDates?.endDate || null) : scheduleEndDate) || dispAggDates?.endDate || null
  // 显示用开始/结束小时（自身缺失时走子树聚合兜底）
  const effStartHour = task.start_hour ?? dispAggDates?.startHour ?? null
  const effEndHour = task.end_hour ?? dispAggDates?.endHour ?? null

  // ===== 执行状态与编辑权限 =====
  // 状态推导用开始日期：任务树 start_date 优先、排期映射兜底；
  // preferScheduleDates（进度规划页）：拖拽/重排不回写树字段，推导以排期结果优先，
  // 否则重排延后后下钻子任务的状态仍是已延误
  const deriveStartDate = (n) => {
    if (!n) return null
    const d = scheduleDateMap ? (scheduleDateMap[n.id] || scheduleDateMap[String(n.task_ulid || '')]) : null
    if (preferScheduleDates) return d?.startDate || n.start_date || null
    return n.start_date || d?.startDate || null
  }
  // 下钻子任务：叶子子任务与直接打开该任务一样可编辑计划信息（编辑回调按子任务自己的 taskId 定位）；
  // completed 任务锁定编辑（所有编辑回调置空），组件内按「回调是否存在」降级为只读展示
  // resolveStatus（项目主页模式）：系统推导 + 手动值合并，对顶层/子任务均生效
  const effExecStatus = resolveStatus
    ? resolveStatus(task)
    : ((execStatus && !navActive) ? execStatus : deriveExecStatus(task, null, deriveStartDate))
  const locked = effExecStatus === 'completed'
  // 锁定时所有编辑回调统一置空，组件内按「回调是否存在」降级为只读展示
  const H = locked ? {} : {
    onResourceMemberChange,
    onResourceHoursChange,
    onResourceDelete,
    onAddResource,
    onUpdateDuration,
    onAutoCalcDuration,
    onUpdateDates,
    onUpdateDeliverables,
    onUpdateDescription,
    onAddDeliverableToCatalog,
    onUpdateHours,
    onUpdateSkipHolidays
  }
  const editable = !!H.onResourceMemberChange || !!H.onResourceHoursChange
  // 项目主页模式（传入状态/进度回调）时实际完成情况始终显示（未开始/延期任务也需要能编辑状态与进度）
  const showActualSection = effExecStatus === 'completed' || effExecStatus === 'in_progress' || !!onSetTaskExecStatus || !!onSetTaskProgress
  // 手动状态编辑：仅叶子任务（非叶子状态由子任务聚合派生，不可手动改）
  const canSetStatus = !!onSetTaskExecStatus && !hasChildren
  // 进度编辑：仅叶子任务且非已完成
  const canEditProgress = !!onSetTaskProgress && !hasChildren && effExecStatus !== 'completed'
  // 展示用完成进度：主页模式按展示任务实时解析，否则用外部传入的 progress
  const displayProgress = Math.max(0, Math.min(100, Math.round(Number(progressForTask ? progressForTask(task) : (progress ?? 0)) || 0)))

  // 上一条/下一条任务（项目主页模式）：在传入的任务列表（叶子）中按当前展示任务定位
  const keyOfTask = (t) => String(t && (t.task_ulid || t.id) != null ? (t.task_ulid || t.id) : '')
  const navList = navTasks || []
  const navIdx = navList.findIndex(t => keyOfTask(t) === keyOfTask(task))
  const prevTask = navIdx > 0 ? navList[navIdx - 1] : null
  const nextTask = (navIdx >= 0 && navIdx < navList.length - 1) ? navList[navIdx + 1] : null

  // 任务动态（项目主页模式）：旧版行内数组（task.dynamics）+ 独立记录（store），只展示手动动态
  const isLegacyAutoDynamic = (text) => {
    if (!text) return false
    return /^任务状态手动改为「.+」/.test(text)
      || text === '任务状态恢复系统自动判定'
      || /^完成进度更新为 \d+%$/.test(text)
      || /^完成进度变更，任务状态自动改为「.+」$/.test(text)
  }
  const dynamics = [...(task.dynamics || []), ...(dynamicsForTask ? dynamicsForTask(task) : [])]
    .filter(d => {
      if (d.type) return d.type === 'manual'
      return !isLegacyAutoDynamic(d.text)
    })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))

  const sendDynamic = () => {
    const text = dynamicDraft.trim()
    if (!text || !onAddDynamic) return
    onAddDynamic(task, text)
    setDynamicDraft('')
  }

  // 任务类型推导：树节点未存 taskType 时与 WBS 列表 getTaskTypeInfo 同口径
  // （里程碑 → 执行：有工时且无自定义工期 → 跟进：有工时且有自定义工期 → 等待）
  const maxResourceHoursForType = Math.max(0, ...(task.resources || []).map(r => r.hours || 0))
  const taskType = task.taskType === '里程碑'
    ? '里程碑'
    : (task.taskType || (maxResourceHoursForType !== 0
        ? (task.customDurationDays !== undefined ? '跟进' : '执行')
        : '等待'))
  const typeBg = taskType === '里程碑' ? '#fef3c7' : taskType === '等待' ? '#FEF3C7' : taskType === '跟进' ? '#DBEAFE' : '#D1FAE5'
  const typeColor = taskType === '里程碑' ? '#b45309' : taskType === '等待' ? '#92400E' : taskType === '跟进' ? '#1E40AF' : '#065F46'
  const fieldRow = { display: 'flex', alignItems: 'center', marginBottom: '16px' }
  const fieldLabel = { fontSize: '13px', color: '#6B7280', width: '76px', flexShrink: 0 }
  const fieldValue = { fontSize: '14px', color: '#1F2937', flex: 1, minWidth: 0 }
  const iconBtn = { background: 'none', border: 'none', cursor: 'pointer', color: '#6B7280', padding: '4px', borderRadius: '6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }

  // 非叶子任务：与表格/预览同口径计算总预估工时（递归累加叶子工时）与总工期（子叶子最大天数）
  const sumLeafHours = (n) => {
    if (n.children && n.children.length > 0) return n.children.reduce((s, c) => s + sumLeafHours(c), 0)
    return (n.resources || []).reduce((s, r) => s + (r.hours || 0), 0)
  }
  // 非叶子任务：与 WBS 分解列表「共X天」同口径（共享工具：子叶子按前驱依赖链排布取最大结束天数）
  const displayDays = calcGroupDurationDays(task, dailyInputHours)
  const displayTotalHours = hasChildren
    ? sumLeafHours(task)
    : (task.totalHours != null && task.totalHours > 0 ? task.totalHours : sumLeafHours(task))

  const maxResourceHours = Math.max(0, ...(task.resources || []).map(r => r.hours || 0))
  const defaultDays = maxResourceHours > 0 && dailyInputHours > 0
    ? Math.ceil(maxResourceHours / dailyInputHours)
    : 0

  // 跳过节假日口径：任务级 skip_holidays 优先，未设置时回落到项目全局设置。
  // 开始时间选择后，结束时间按该口径 + 工期自动推算（DateRangePicker.endFromStart 同规则）
  const effectiveSkip = task.skip_holidays != null ? !!task.skip_holidays : !!skipHolidays
  // 结束时间为只读推算结果，统一以 2026/09/14 8h 格式展示
  const fmtEndDate = (dateStr) => {
    if (!dateStr) return null
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  }
  // 下拉里展示两种口径的推算结果（跳过 / 不跳过节假日），供用户按规则选择
  const endHourText = task.end_hour != null ? ` ${task.end_hour}h` : ''
  const noStartHint = '请先设置开始时间'
  const endRuleOptions = [
    { skip: true, label: '跳过节假日', end: (startDateVal && displayDays > 0) ? computeEndFromDuration(startDateVal, displayDays, true) : null },
    { skip: false, label: '不跳过节假日', end: (startDateVal && displayDays > 0) ? computeEndFromDuration(startDateVal, displayDays, false) : null }
  ].map(op => ({ ...op, text: op.end ? `${fmtEndDate(op.end)}${endHourText}` : noStartHint }))

  // 甘特条颜色：与甘特图同口径（按编号首级取 themeColors）
  const barColor = (() => {
    const firstLevel = parseInt(String(task.code || '').split('.')[0], 10) || 1
    return (themeColors[(firstLevel - 1) % themeColors.length] || themeColors[0]).solid
  })()

  const openDurationEdit = (e) => {
    if (!H.onUpdateDuration || hasChildren) return
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const minDays = defaultDays
    const curVal = task.customDurationDays > 0 ? task.customDurationDays : minDays
    setDurationEdit({ x: rect.left, y: rect.bottom + 4, minDays, curVal })
  }

  const saveDuration = () => {
    if (!durationEdit) return
    const val = parseFloat(durationEdit.curVal)
    const finalVal = isNaN(val) || val <= 0 ? durationEdit.minDays || 1 : Math.floor(val)
    H.onUpdateDuration(taskId, finalVal)
    setDurationEdit(null)
  }

  const addDeliverable = (name) => {
    const clean = (name || '').trim()
    if (!clean || (task.deliverables || []).includes(clean)) return
    H.onUpdateDeliverables(taskId, [...(task.deliverables || []), clean])
    if (H.onAddDeliverableToCatalog) H.onAddDeliverableToCatalog(clean)
  }

  const deliverablesKeyword = deliverablesSearch.trim().toLowerCase()
  const filteredDeliverables = deliverablesCatalog
    .filter(n => !(task.deliverables || []).includes(n))
    .filter(n => !deliverablesKeyword || n.toLowerCase().includes(deliverablesKeyword))
  const showCreateDeliverable = deliverablesKeyword && !deliverablesCatalog.some(n => n.toLowerCase() === deliverablesKeyword)

  const startDescEdit = () => {
    if (!H.onUpdateDescription) return
    setDescriptionDraft(task.description || '')
    setEditingDescription(true)
  }

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}
    >
      <div style={{ position: 'relative', background: 'white', borderRadius: '12px', width: '800px', maxWidth: '94vw', height: '80vh', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
        {/* 顶部操作栏：左=上一条/下一条（项目主页模式），右=动态定位/关闭（路径移至标题上方） */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid #F3F4F6', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            {onNavigateTask && (
              <>
                <button
                  style={{ ...iconBtn, color: prevTask ? '#6B7280' : '#D1D5DB', cursor: prevTask ? 'pointer' : 'default' }}
                  title="上一条任务"
                  disabled={!prevTask}
                  onClick={() => { if (prevTask) onNavigateTask(prevTask) }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                </button>
                <button
                  style={{ ...iconBtn, color: nextTask ? '#6B7280' : '#D1D5DB', cursor: nextTask ? 'pointer' : 'default' }}
                  title="下一条任务"
                  disabled={!nextTask}
                  onClick={() => { if (nextTask) onNavigateTask(nextTask) }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
            {onAddDynamic && (
              <button style={iconBtn} title="添加任务动态" onClick={() => { if (dynInputRef.current) dynInputRef.current.focus() }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </button>
            )}
            <button style={iconBtn} title="关闭" onClick={onClose}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* 左侧主区 */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {/* 固定头部：路径行 + 任务名称（不随内容滚动） */}
            <div style={{ padding: '12px 28px 12px', flexShrink: 0, borderBottom: '1px solid #F3F4F6' }}>
              {/* 任务路径行：返回上一级图标（子任务下钻=弹出导航栈；顶层有父任务=切换到父任务弹窗）+ 完整路径 */}
              {(navActive || (task.ancestors && task.ancestors.length > 0)) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
                  {(() => {
                    const canPopStack = navActive
                    const canGoParent = !navActive && !!onBackToParent
                    return (
                      <button
                        style={{ ...iconBtn, color: (canPopStack || canGoParent) ? '#6B7280' : '#D1D5DB', cursor: (canPopStack || canGoParent) ? 'pointer' : 'default', padding: '2px' }}
                        title={(canPopStack || canGoParent) ? '返回上一级' : ''}
                        disabled={!(canPopStack || canGoParent)}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (canPopStack) setViewIds(ids => ids.slice(0, -1))
                          else if (canGoParent) onBackToParent()
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></svg>
                      </button>
                    )
                  })()}
                  {(navActive ? (navPath || []) : (task.ancestors || [])).length > 0 && (
                    <span style={{ fontSize: '13px', color: '#6B7280' }}>
                      {(navActive ? (navPath || []) : (task.ancestors || [])).join(' / ')}
                    </span>
                  )}
                </div>
              )}
              <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: '#1F2937' }}>{task.code} {task.name}</h3>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 28px 20px' }}>
              {/* 非叶子任务：直接子任务列表（编号 + 名称 + 状态徽标），点击进入子任务详情 */}
              {hasChildren && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '13px', color: '#6B7280', marginBottom: '8px' }}>子任务</div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {task.children.map((c, i) => (
                      <div
                        key={String(c.task_ulid || c.id || i)}
                        style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid #F3F4F6', fontSize: '14px', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); setViewIds(ids => [...ids, String(c.task_ulid || c.id)]) }}
                        title="查看子任务详情"
                      >
                        <span style={{ color: '#6B7280', flexShrink: 0 }}>{c.code}</span>
                        <span style={{ color: '#1F2937', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        <StatusBadge status={resolveStatus ? resolveStatus(c) : deriveExecStatus(c, null, deriveStartDate)} />
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 'auto', flexShrink: 0 }}><polyline points="9 18 15 12 9 6" /></svg>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '13px', color: '#6B7280', marginBottom: '8px' }}>任务描述</div>
                {editingDescription ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <MarkdownEditor
                      value={descriptionDraft}
                      onChange={setDescriptionDraft}
                      height={300}
                      placeholder="请输入任务描述，支持 Markdown 即时渲染"
                      autoFocus
                    />
                    <div
                      className={'char-counter' + (descriptionDraft.length > 1000 ? ' char-counter-over' : '')}
                    >
                      {descriptionDraft.length}/1000
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="btn-save"
                        style={{ padding: '6px 16px', fontSize: '13px' }}
                        onClick={() => {
                          H.onUpdateDescription(taskId, descriptionDraft.slice(0, 1000))
                          setEditingDescription(false)
                          // 保存后描述默认展开：完整展示刚保存的内容（长文本不再截断渐隐）
                          setDescExpanded(true)
                        }}
                      >保存</button>
                      <button
                        className="btn-cancel"
                        style={{ padding: '6px 16px', fontSize: '13px' }}
                        onClick={() => setEditingDescription(false)}
                      >取消</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      ref={descContentRef}
                      className={(H.onUpdateDescription ? 'clickable-description ' : '') + 'description-markdown'}
                      style={{
                        fontSize: '14px', color: '#1F2937', lineHeight: '1.6', cursor: H.onUpdateDescription ? 'pointer' : 'default',
                        // 收起状态：限高约9行 + 底部渐隐；展开后不限高
                        ...(descExpanded ? {} : {
                          maxHeight: '200px', overflow: 'hidden',
                          WebkitMaskImage: 'linear-gradient(to bottom, #000 55%, transparent 100%)',
                          maskImage: 'linear-gradient(to bottom, #000 55%, transparent 100%)'
                        })
                      }}
                      title={H.onUpdateDescription ? '点击编辑任务描述（支持 Markdown）' : ''}
                      onClick={(e) => {
                        if (!H.onUpdateDescription) return
                        // 点击链接不进入编辑
                        if (e.target.closest('a')) return
                        e.stopPropagation()
                        startDescEdit()
                      }}
                      dangerouslySetInnerHTML={{ __html: task.description ? renderMarkdownHtml(task.description) : '-' }}
                    />
                    {descOverflow && (
                      <div
                        className="desc-expand-toggle"
                        onClick={(e) => { e.stopPropagation(); setDescExpanded(v => !v) }}
                      >
                        {descExpanded ? '收起' : '展开'}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: descExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><polyline points="6 9 12 15 18 9" /></svg>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '13px', color: '#6B7280', marginBottom: '8px' }}>可交付成果</div>
                {H.onUpdateDeliverables ? (
                  <div className="deliverables-container">
                    {(task.deliverables || []).map((fileName, idx) => (
                      <span key={idx} className="deliverable-chip" title={fileName}>
                        <span className="deliverable-chip-name">{fileName}</span>
                        <button
                          className="deliverable-chip-remove"
                          onClick={(e) => {
                            e.stopPropagation()
                            const newList = (task.deliverables || []).filter((_, i) => i !== idx)
                            H.onUpdateDeliverables(taskId, newList)
                          }}
                          title="删除"
                        >×</button>
                      </span>
                    ))}
                    <div
                      className="deliverable-add-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setDeliverablesPicker({ x: rect.left, y: rect.bottom })
                        setDeliverablesSearch('')
                        setTimeout(() => deliverablesSearchRef.current?.focus(), 0)
                      }}
                      title="添加可交付成果"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '14px', color: '#1F2937' }}>
                    {task.deliverables && task.deliverables.length > 0 ? task.deliverables.join('、') : '-'}
                  </div>
                )}
              </div>

              {/* 任务动态（项目主页模式）：只展示用户手动添加的动态；顶部细分隔线与可交付成果拉开层次 */}
              {onAddDynamic && (
                <div style={{ borderTop: '1px solid #F3F4F6', paddingTop: '16px', marginBottom: 0 }}>
                  <div style={{ fontSize: '13px', color: '#6B7280', marginBottom: '8px' }}>任务动态</div>
                  {dynamics.length === 0 ? (
                    <div style={{ fontSize: '14px', color: '#9CA3AF' }}>暂无动态</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {dynamics.map((d, i) => (
                        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <div style={{ fontSize: '14px', color: '#1F2937', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>{d.text}</div>
                          <div style={{ fontSize: '12px', color: '#9CA3AF' }}>{fmtDynTime(d.created_at)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 底部动态输入区（项目主页模式） */}
            {onAddDynamic && (
              <div style={{ borderTop: '1px solid #F3F4F6', padding: '12px 28px', flexShrink: 0, display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  ref={dynInputRef}
                  type="text"
                  value={dynamicDraft}
                  onChange={(e) => setDynamicDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendDynamic() } }}
                  placeholder="输入任务动态，回车发送"
                  style={{ flex: 1, padding: '8px 12px', border: '1px solid #E5E7EB', borderRadius: '8px', fontSize: '14px', color: '#1F2937', outline: 'none', background: '#F9FAFB' }}
                />
                <button
                  className="btn-save"
                  style={{ padding: '8px 16px', fontSize: '13px', flexShrink: 0 }}
                  onClick={sendDynamic}
                >发送</button>
              </div>
            )}
          </div>

          {/* 右侧属性栏：上=计划信息，下=实际完成情况 */}
          <div style={{ width: '300px', flexShrink: 0, background: '#F7F8FA', padding: '24px 20px', overflowY: 'auto' }}>
            {/* 上半部分：计划信息 */}
            <div style={{ fontSize: '12px', color: '#9CA3AF', fontWeight: 600, marginBottom: '14px', letterSpacing: '1px' }}>计划信息</div>
            {!hasChildren && (
              <div style={{ ...fieldRow, alignItems: 'flex-start' }}>
                <div style={fieldLabel}>资源需求</div>
                <div style={{ ...fieldValue, display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
                  {task.resources && task.resources.length > 0
                    ? task.resources.map((r, idx) => (
                        <div
                          key={idx}
                          className={editable ? 'resource-item clickable-resource' : 'resource-item'}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!H.onResourceMemberChange) return
                            const rect = e.currentTarget.getBoundingClientRect()
                            setHoursEdit(null)
                            setEditingResource({ x: rect.left, y: rect.bottom, resourceIndex: idx })
                          }}
                        >
                          <span className={`avatar ${!r.name ? 'empty-avatar' : ''}`}>
                            {r.name ? (r.avatar || r.name.charAt(0)) : '?'}
                          </span>
                          <div className="resource-info" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
                            <span
                              className={`resource-name ${!r.name ? 'empty-name' : ''}`}
                              style={{ maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}
                            >
                              {r.name || r.role}
                            </span>
                            <span
                              className="resource-hours"
                              style={{ flexShrink: 0, whiteSpace: 'nowrap', cursor: H.onResourceHoursChange ? 'pointer' : 'default' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (!H.onResourceHoursChange) return
                                const rect = e.currentTarget.getBoundingClientRect()
                                setEditingResource(null)
                                setHoursEdit({ x: rect.left, y: rect.bottom + 8, resourceIndex: idx })
                              }}
                            >
                              {formatHoursByUnit(r.hours || 0, timeRuleUnit)}
                            </span>
                          </div>
                          {H.onResourceDelete && (
                            <button
                              className="delete-resource-btn"
                              onClick={(e) => {
                                e.stopPropagation()
                                H.onResourceDelete(taskId, idx)
                              }}
                              title="删除资源"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))
                    : <span style={{ fontSize: '14px', color: '#9CA3AF' }}>-</span>
                  }
                  {editable && H.onAddResource && (
                    <div
                      className="resource-item more-resources add-resource-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = e.currentTarget.getBoundingClientRect()
                        setHoursEdit(null)
                        setEditingResource({ x: rect.left, y: rect.bottom, resourceIndex: -1 })
                      }}
                      title="添加资源"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            )}
            {!hasChildren && (
              <div style={fieldRow}>
                <div style={fieldLabel}>任务类型</div>
                <div style={fieldValue}>
                  <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, background: typeBg, color: typeColor }}>{taskType}</span>
                </div>
              </div>
            )}
            <div style={fieldRow}>
              <div style={fieldLabel}>总预估工时</div>
              <div style={fieldValue}>{displayTotalHours > 0 ? formatHoursByUnit(displayTotalHours, timeRuleUnit) : '-'}</div>
            </div>
            <div style={fieldRow}>
              <div style={fieldLabel}>总工期(天)</div>
              <div style={fieldValue}>
                {!hasChildren && H.onUpdateDuration && displayDays > 0 ? (
                  <span
                    className="duration-days"
                    title="点击编辑工期"
                    onClick={openDurationEdit}
                  >
                    {displayDays}
                    {task.customDurationDays !== undefined && task.customDurationDays > 0 && (
                      <span className="duration-custom-badge">自定义</span>
                    )}
                  </span>
                ) : (displayDays > 0 ? displayDays : '-')}
              </div>
            </div>
            {H.onUpdateDates && !hasChildren ? (
              <>
                <div style={fieldRow}>
                  <div style={fieldLabel}>开始时间</div>
                  <div style={{ ...fieldValue, display: 'flex', alignItems: 'center' }}>
                    <DateRangePicker
                      startDate={startDateVal}
                      endDate={endDateVal}
                      minDate={todayStr()}
                      minStartDate={typeof minStartDate === 'function' ? minStartDate(task.id) : minStartDate}
                      minDurationDays={Math.max(1, displayDays || 1)}
                      skipHolidays={effectiveSkip}
                      startHour={task.start_hour != null ? task.start_hour : 0}
                      onHourChange={H.onUpdateHours ? (which, val) => H.onUpdateHours(task.id, which, val) : undefined}
                      timeRuleUnit={timeRuleValue}
                      dailyInputHours={dailyInputHours}
                      onlySide="start"
                      onChange={(s, e) => {
                        setStartDateVal(s)
                        setEndDateVal(e)
                        H.onUpdateDates(taskId, s, e, 'range')
                      }}
                    />
                  </div>
                </div>
                <div style={fieldRow}>
                  <div style={fieldLabel}>结束时间</div>
                  <div style={{ ...fieldValue, display: 'flex', alignItems: 'center' }}>
                    {H.onUpdateSkipHolidays ? (
                      <button
                        type="button"
                        className={'end-rule-trigger' + (endRuleDropdown ? ' is-open' : '')}
                        title={endDateVal ? '选择推算规则' : '请先设置开始时间'}
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setEndRuleDropdown(prev => prev ? null : { x: rect.left, y: rect.bottom + 4 })
                        }}
                      >
                        <span>{endDateVal ? `${fmtEndDate(endDateVal)}${endHourText}` : '-'}</span>
                        <svg className="end-rule-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                      </button>
                    ) : (
                      <div style={{ fontSize: '14px', color: '#1F2937' }}>
                        {endDateVal ? `${fmtEndDate(endDateVal)}${endHourText}` : '-'}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={fieldRow}>
                  <div style={fieldLabel}>开始时间</div>
                  <div style={fieldValue}>
                    {effScheduleStartDate
                      ? `${effScheduleStartDate}${effStartHour != null ? ' ' + effStartHour + 'h' : ''}`
                      : '-'}
                  </div>
                </div>
                <div style={{ ...fieldRow, marginBottom: showActualSection ? '16px' : 0 }}>
                  <div style={fieldLabel}>结束时间</div>
                  <div style={fieldValue}>
                    {effScheduleEndDate
                      ? `${effScheduleEndDate}${effEndHour != null ? ' ' + effEndHour + 'h' : ''}`
                      : '-'}
                  </div>
                </div>
              </>
            )}

            {/* 下半部分：实际完成情况（仅进行中/已完成任务显示；主页模式始终显示） */}
            {showActualSection && (
              <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #E5E7EB' }}>
                <div style={{ fontSize: '12px', color: '#9CA3AF', fontWeight: 600, marginBottom: '14px', letterSpacing: '1px' }}>实际完成情况</div>
                {EXEC_STATUS[effExecStatus] && (
                  <div style={{ ...fieldRow, alignItems: 'flex-start' }}>
                    <div style={fieldLabel}>任务状态</div>
                    <div style={{ ...fieldValue, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                      {canSetStatus ? (
                        <div ref={statusMenuRef} style={{ position: 'relative' }}>
                          <button
                            onClick={() => setStatusMenuOpen(o => !o)}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '2px 10px', borderRadius: '12px',
                              border: 'none', cursor: 'pointer', background: EXEC_STATUS[effExecStatus].bg
                            }}
                            title="点击切换任务状态"
                          >
                            <span style={{ fontSize: '12px', fontWeight: 600, color: EXEC_STATUS[effExecStatus].color }}>
                              {EXEC_STATUS[effExecStatus].label}
                            </span>
                            <svg
                              width="12" height="12" viewBox="0 0 24 24" fill="none"
                              stroke={EXEC_STATUS[effExecStatus].color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                              style={{ transform: statusMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
                            ><polyline points="6 9 12 15 18 9"></polyline></svg>
                          </button>
                          {statusMenuOpen && (
                            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: '128px', background: '#fff', border: '1px solid #E5E7EB', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: '4px' }}>
                              {(effExecStatus === 'in_progress' || effExecStatus === 'completed') && (
                                <div
                                  onClick={() => { onSetTaskExecStatus(task, null); setStatusMenuOpen(false) }}
                                  style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '13px', color: '#6B7280', cursor: 'pointer', whiteSpace: 'nowrap' }}
                                  onMouseEnter={e => { e.currentTarget.style.background = '#F3F4F6' }}
                                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                                  title="清除手动状态，恢复系统自动判定"
                                >恢复自动（{EXEC_STATUS[deriveExecStatus(task, null, deriveStartDate)].label}）</div>
                              )}
                              {MANUAL_EXEC_STATUS.map(s => {
                                const active = effExecStatus === s
                                return (
                                  <div
                                    key={s}
                                    onClick={() => { onSetTaskExecStatus(task, active ? null : s); setStatusMenuOpen(false) }}
                                    style={{
                                      padding: '6px 10px', borderRadius: '6px', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap',
                                      color: EXEC_STATUS[s].color, fontWeight: active ? 600 : 400, background: active ? EXEC_STATUS[s].bg : 'transparent'
                                    }}
                                    onMouseEnter={e => { if (!active) e.currentTarget.style.background = '#F3F4F6' }}
                                    onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
                                    title={active ? '清除手动状态，恢复系统自动判定' : `手动标记为${EXEC_STATUS[s].label}`}
                                  >{EXEC_STATUS[s].label}{active ? ' ✓' : ''}</div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, background: EXEC_STATUS[effExecStatus].bg, color: EXEC_STATUS[effExecStatus].color }}>
                          {EXEC_STATUS[effExecStatus].label}
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {/* 完成进度：叶子且可编辑=滑块+数字输入；非叶子/只读=静态进度条（颜色跟随任务甘特条） */}
                <div style={{ ...fieldRow, marginBottom: 0, alignItems: 'center' }}>
                  <div style={fieldLabel}>完成进度</div>
                  {canEditProgress ? (
                    <div style={{ ...fieldValue, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        type="range"
                        className="progress-slider"
                        min={0}
                        max={100}
                        step={1}
                        value={displayProgress}
                        onChange={(e) => onSetTaskProgress(task, Number(e.target.value))}
                        style={{
                          flex: 1, minWidth: 0, cursor: 'pointer',
                          background: `linear-gradient(to right, ${barColor} 0%, ${barColor} ${displayProgress}%, #E5E7EB ${displayProgress}%, #E5E7EB 100%)`,
                          '--thumb-color': barColor
                        }}
                      />
                      <input
                        type="number"
                        className="progress-number-input"
                        min={0}
                        max={100}
                        step={1}
                        value={progressDirty != null ? progressDirty : String(displayProgress)}
                        onChange={(e) => {
                          const raw = e.target.value
                          setProgressDirty(raw)
                          if (raw === '') return
                          let n = parseInt(raw, 10)
                          if (isNaN(n)) return
                          onSetTaskProgress(task, Math.max(0, Math.min(100, n)))
                        }}
                        onBlur={() => {
                          let n = parseInt(progressDirty ?? '', 10)
                          if (isNaN(n)) n = displayProgress
                          n = Math.max(0, Math.min(100, n))
                          setProgressDirty(null)
                          if (n !== displayProgress) onSetTaskProgress(task, n)
                        }}
                        style={{ width: '52px', flexShrink: 0, padding: '4px 6px', border: '1px solid #E5E7EB', borderRadius: '6px', fontSize: '13px', color: '#1F2937', textAlign: 'center', outline: 'none', background: '#fff', cursor: 'text' }}
                      />
                      <span style={{ fontSize: '13px', color: '#6B7280', flexShrink: 0 }}>%</span>
                    </div>
                  ) : (
                    <div style={{ ...fieldValue, display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: '#E5E7EB', overflow: 'hidden', minWidth: 0 }}>
                        <div style={{ width: `${displayProgress}%`, height: '100%', borderRadius: '3px', background: barColor }} />
                      </div>
                      <span style={{ fontSize: '13px', color: '#6B7280', flexShrink: 0 }}>{displayProgress}%</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {editingResource && H.onResourceMemberChange && (() => {
        const isNew = editingResource.resourceIndex === -1
        const existingResource = task.resources?.[editingResource.resourceIndex]
        if (!isNew && !existingResource) return null
        const disabledValues = isNew
          ? (task.resources || []).filter(r => r.role).map(r => `${r.role}-${r.name}`)
          : (task.resources || []).filter((_, i) => i !== editingResource.resourceIndex && _.role).map(r => `${r.role}-${r.name}`)
        return (
          <div
            className="resource-select-popup"
            style={{ left: editingResource.x, top: editingResource.y, zIndex: 1010 }}
            onClick={(e) => e.stopPropagation()}
          >
            <CustomSelect
              isOpen
              onClose={() => {
                setEditingResource(null)
              }}
              hideTrigger
              value={isNew ? '' : (existingResource.role ? `${existingResource.role}-${existingResource.name}` : '')}
              onChange={(value) => {
                if (isNew) {
                  const member = teamMembers.find(m => `${m.role}-${m.name}` === value)
                  const newIndex = (task.resources || []).length
                  const { x, y } = editingResource
                  if (member) {
                    H.onAddResource(taskId, member)
                  }
                  setEditingResource(null)
                  if (member && H.onResourceHoursChange) {
                    setHoursEdit({ x, y, resourceIndex: newIndex })
                  }
                } else {
                  H.onResourceMemberChange(taskId, editingResource.resourceIndex, value)
                  setEditingResource(null)
                }
              }}
              options={teamMembers.map(m => ({
                value: `${m.role}-${m.name}`,
                role: m.role,
                name: m.name,
                avatar: m.avatar
              }))}
              placeholder="选择角色"
              disabledValues={disabledValues}
            />
          </div>
        )
      })()}

      {hoursEdit && H.onResourceHoursChange && (() => {
        const resource = task.resources?.[hoursEdit.resourceIndex]
        if (!resource) return null
        return (
          <HoursEditPopup
            x={hoursEdit.x}
            y={hoursEdit.y}
            hours={resource.hours || 0}
            ruleUnit={timeRuleUnit}
            ruleValue={timeRuleValue}
            onSave={(hours) => {
              H.onResourceHoursChange(taskId, hoursEdit.resourceIndex, hours)
              setHoursEdit(null)
            }}
            onClose={() => setHoursEdit(null)}
          />
        )
      })()}

      {durationEdit && H.onUpdateDuration && (() => {
        const { curVal } = durationEdit
        const minDays = durationEdit.minDays || 1
        return (
          <div
            ref={durationEditRef}
            className="duration-edit-popup"
            style={{ position: 'fixed', left: durationEdit.x, top: durationEdit.y, zIndex: 1010 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="duration-edit-content">
              <div className="duration-edit-header">
                <span className="duration-edit-title">编辑工期</span>
                {task.customDurationDays !== undefined && task.customDurationDays > 0 && (
                  <button
                    type="button"
                    className="duration-auto-calc-text"
                    onClick={() => {
                      if (H.onAutoCalcDuration) H.onAutoCalcDuration(taskId)
                      setDurationEdit(null)
                    }}
                  >
                    自动计算
                  </button>
                )}
              </div>
              <div className="duration-edit-body">
                <div className="number-stepper">
                  <button
                    type="button"
                    className="stepper-btn"
                    disabled={curVal <= minDays}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDurationEdit(prev => ({ ...prev, curVal: Math.max(minDays, Math.floor(parseFloat(prev.curVal) || minDays) - 1) }))
                    }}
                  >−</button>
                  <input
                    type="number"
                    min={minDays}
                    step="1"
                    className="stepper-input"
                    value={curVal}
                    onChange={(e) => {
                      setDurationEdit(prev => ({ ...prev, curVal: e.target.value }))
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        saveDuration()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setDurationEdit(null)
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="stepper-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDurationEdit(prev => ({ ...prev, curVal: Math.floor(parseFloat(prev.curVal) || minDays) + 1 }))
                    }}
                  >+</button>
                </div>
                <span className="duration-edit-unit">天</span>
                <button className="btn-save time-rule-confirm-btn" onClick={saveDuration} title="确定" aria-label="确定">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {endRuleDropdown && H.onUpdateSkipHolidays && (
        <div
          ref={endRuleRef}
          className="duration-edit-popup end-rule-dropdown"
          style={{ left: endRuleDropdown.x, top: endRuleDropdown.y, zIndex: 1010 }}
          onClick={(e) => e.stopPropagation()}
        >
          {endRuleOptions.map(op => (
            <div
              key={op.label}
              className={'end-rule-option' + (effectiveSkip === op.skip ? ' end-rule-option-active' : '')}
              onClick={() => {
                if (effectiveSkip !== op.skip) H.onUpdateSkipHolidays(taskId, op.skip)
                setEndRuleDropdown(null)
              }}
            >
              <svg
                className="end-rule-option-check"
                style={{ visibility: effectiveSkip === op.skip ? 'visible' : 'hidden' }}
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              ><polyline points="20 6 9 17 4 12" /></svg>
              <span className="end-rule-option-value">{op.text}</span>
              <span className="end-rule-option-desc">{op.label}</span>
            </div>
          ))}
        </div>
      )}

      {deliverablesPicker && H.onUpdateDeliverables && (
        <div
          ref={deliverablesPickerRef}
          className="deliverables-picker"
          style={{ position: 'fixed', left: deliverablesPicker.x, top: deliverablesPicker.y + 4, zIndex: 1010 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="deliverables-picker-search">
            <input
              ref={deliverablesSearchRef}
              type="text"
              placeholder="搜索或添加文件类型"
              value={deliverablesSearch}
              onChange={(e) => setDeliverablesSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const clean = deliverablesSearch.trim()
                  if (clean) {
                    addDeliverable(clean)
                    setDeliverablesPicker(null)
                    setDeliverablesSearch('')
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setDeliverablesPicker(null)
                  setDeliverablesSearch('')
                }
              }}
            />
          </div>
          <div className="deliverables-picker-list">
            {filteredDeliverables.length === 0 && !showCreateDeliverable && (
              <div className="deliverables-picker-empty">暂无可选文件名称</div>
            )}
            {filteredDeliverables.map(name => (
              <div
                key={name}
                className="deliverables-picker-option"
                onClick={() => {
                  addDeliverable(name)
                  setDeliverablesPicker(null)
                  setDeliverablesSearch('')
                }}
              >
                {name}
              </div>
            ))}
            {showCreateDeliverable && (
              <div
                className="deliverables-picker-option create-option"
                onClick={() => {
                  addDeliverable(deliverablesSearch.trim())
                  setDeliverablesPicker(null)
                  setDeliverablesSearch('')
                }}
              >
                <span className="create-label">创建文件类型</span>
                <span className="create-name">{deliverablesSearch.trim()}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default TaskDetailPopup
