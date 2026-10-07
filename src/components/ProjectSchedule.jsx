import { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import MemberList from './MemberList'
import ExecStatusDot from './ExecStatusDot'
import ResourceEditModal from './ResourceEditModal'
import TaskDetailPopup from './TaskDetailPopup'
import { formatHoursByUnit } from './HoursEditPopup'
import PlanningHeaderStats from './PlanningHeaderStats'
import CustomSelect from './CustomSelect'
import MemberMultiSelect from './MemberMultiSelect'
import DateRangeCalendar from './DateRangeCalendar'
import { getTasksByProject, updateRecord, getProjectById, upsertTaskContent } from '../utils/db'
import { buildLeaves, computeSchedule, computeReadOnlySchedule, computeCriticalPath, themeColors, calcCustomDurationExceeded, findTaskPath, findTaskParent, computeEndFromDuration } from '../utils/schedule'
import { deriveExecStatus } from '../utils/execStatus'

// 任务状态筛选选项（甘特图筛选区）
const EXEC_STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'not_started', label: '未开始' },
  { value: 'delayed', label: '已延误' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' }
]
import { isNonWorkDay } from '../utils/holidays'
import { EXEC_STATUS } from '../utils/execStatus'

const findNodeInTree = (nodes, id) => {
  for (const node of nodes || []) {
    if (node.id === id) return node
    const found = findNodeInTree(node.children || [], id)
    if (found) return found
  }
  return null
}

const getWeekMonday = (d) => {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  const day = date.getDay()
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day))
  return date
}

const getWeekNo = (d) => {
  const date = new Date(d)
  const monday = getWeekMonday(date)
  const week1Monday = getWeekMonday(new Date(date.getFullYear(), 0, 1))
  return Math.round((monday - week1Monday) / 86400000 / 7) + 1
}

const updateNodeResources = (nodes, id, updater) => {
  return (nodes || []).map(node => {
    if (node.id === id) {
      return { ...node, resources: updater(node.resources || []) }
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeResources(node.children, id, updater) }
    }
    return node
  })
}

const updateNodeFields = (nodes, id, patch) => {
  return (nodes || []).map(node => {
    if (node.id === id) {
      return { ...node, ...patch }
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeFields(node.children, id, patch) }
    }
    return node
  })
}

const flattenScheduleRows = (nodes, scheduleMap, level = 1, out = []) => {
  (nodes || []).forEach(node => {
    const children = node.children || []
    const isLeaf = children.length === 0
    if (isLeaf) {
      const task = scheduleMap.get(node.id) || null
      let startBar = null
      let endBar = null
        if (task) {
          if (task.taskType === '里程碑') {
            startBar = task.startPos != null ? task.startPos : (task.startDay ?? 0)
            endBar = startBar
          } else {
          startBar = task.startPos != null ? task.startPos : (task.startDay ?? 0)
          endBar = task.endPos != null ? task.endPos : ((task.endDay ?? 0) + 1)
        }
      }
      out.push({ node, level, isLeaf: true, hasChildren: false, task, startBar, endBar })
      return
    }
    const childRows = []
    flattenScheduleRows(children, scheduleMap, level + 1, childRows)
    let startBar = null
    let endBar = null
    childRows.forEach(cr => {
      if (cr.startBar != null) startBar = startBar == null ? cr.startBar : Math.min(startBar, cr.startBar)
      if (cr.endBar != null) endBar = endBar == null ? cr.endBar : Math.max(endBar, cr.endBar)
    })
    out.push({ node, level, isLeaf: false, hasChildren: true, task: null, startBar, endBar })
    out.push(...childRows)
  })
  return out
}

const DayStepper = ({ value, onChange }) => (
  <div className="number-stepper context-menu-stepper">
    <button
      type="button"
      className="stepper-btn"
      onClick={(e) => { e.stopPropagation(); onChange(Math.max(1, value - 1)) }}
    >
      −
    </button>
    <input
      type="number"
      min="1"
      value={value}
      onChange={(e) => onChange(Math.max(1, parseInt(e.target.value) || 1))}
      onClick={(e) => e.stopPropagation()}
      className="stepper-input"
    />
    <button
      type="button"
      className="stepper-btn"
      onClick={(e) => { e.stopPropagation(); onChange(value + 1) }}
    >
      +
    </button>
  </div>
)

const ProjectSchedule = ({ wbsTreeData, teamMembers, onAddRole, onAddMember, onRenameRole, onDeleteRole, onRenameMember, onDeleteMember, onExportSchedule, dailyInputHours = 8, timeRuleUnit, timeRuleValue, isMemberListExpanded, setIsMemberListExpanded, startDate, endDate, onOpenPeriodModal, skipHolidays, dayAligned = false, scheduleRulesVersion = 0, rescheduleFloorPos = 0, onApplyTimeRule, onApplyDailyInput, onAiAssistant, projectId: projectIdProp, onTreeDataChange, onSyncPeriod, projectName, readOnly = false, onTaskBarPreview, statusOf, progressOf, filterLevel, filterDateRange, filterMembers, filterExecStatus }) => {
  const statusOfFn = statusOf || (() => null)
  const progressOfFn = progressOf || (() => 0)
  // 已执行完成的任务锁定，不允许修改任务信息
  const taskLocked = (t) => statusOfFn(t) === 'completed'
  const location = useLocation()
  const projectId = projectIdProp || location.state?.projectId || new URLSearchParams(location.search).get('projectId')
  
  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const [showDetailPopup, setShowDetailPopup] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const contextMenuRef = useRef(null)
  const [showResourceModal, setShowResourceModal] = useState(false)
  const [advanceDays, setAdvanceDays] = useState(1)
  const [delayDays, setDelayDays] = useState(1)
  const [scheduleAnchors, setScheduleAnchors] = useState({})
  // 一键排期下限：未完成任务最早开始位置（相对窗口起点）。会话内状态，重进页面自动复位
  const [rescheduleFloor, setRescheduleFloor] = useState(0)
  const [hoveredRow, setHoveredRow] = useState(-1)
  const [hoveredCol, setHoveredCol] = useState(-1)
  const [hoveredBarTaskId, setHoveredBarTaskId] = useState(null)
  // 摘要任务条悬停的列范围（父任务不在 scheduledTasks 中，单独记录 startBar/endBar）
  const [hoveredSummaryRange, setHoveredSummaryRange] = useState(null)
  const [dragActive, setDragActive] = useState(false)
  const [draggingTaskId, setDraggingTaskId] = useState(null)
  const [dragPreview, setDragPreview] = useState(null)
  const dragStateRef = useRef(null)
  const suppressClickRef = useRef(false)
  const anchorsLoadedRef = useRef(false)
  // 本会话是否已主动改动排期（拖拽/一键排期/右键平移）：改动后不再用树快照播种锚点，
  // 防止同会话内的树更新（如分配资源）把用户的排期改动冲掉；重新进入页面时复位
  const scheduleTouchedRef = useRef(false)
  const conflictHealedRef = useRef(false)
  const [selectedMember, setSelectedMember] = useState(null)
  const [localTreeData, setLocalTreeData] = useState(wbsTreeData || [])
  const [deliverablesCatalog, setDeliverablesCatalog] = useState([])
  const ganttScrollRef = useRef(null)
  const [firstVisibleCol, setFirstVisibleCol] = useState(0)
  const [taskColumnWidth, setTaskColumnWidth] = useState(216)
  // 拖拽后成员占用冲突提示（复用 member-list-toast 样式）
  const [conflictToast, setConflictToast] = useState('')
  const conflictToastTimerRef = useRef(null)
  const showConflictToast = useCallback((msg) => {
    setConflictToast(msg)
    if (conflictToastTimerRef.current) clearTimeout(conflictToastTimerRef.current)
    conflictToastTimerRef.current = setTimeout(() => setConflictToast(''), 6000)
  }, [])
  const [ganttMinLevel, setGanttMinLevel] = useState(null)
  const [ganttShowSummary, setGanttShowSummary] = useState(true)
  const [ganttShowLinks, setGanttShowLinks] = useState(true)
  const [collapsedNodeIds, setCollapsedNodeIds] = useState(() => new Set())
  const [timeGranularity, setTimeGranularity] = useState('day')
  const [ganttGranularity, setGanttGranularity] = useState('day')
  const [showGranularityMenu, setShowGranularityMenu] = useState(false)
  const granularityDropdownRef = useRef(null)
  const [quickViewMode, setQuickViewMode] = useState('schedule')
  const [tooltipInfo, setTooltipInfo] = useState(null)

  // 新增筛选状态
  const [levelFilter, setLevelFilter] = useState('all') // 'all' | 'leaf' | 数字(1,2,3...)
  const [levelDropdownOpen, setLevelDropdownOpen] = useState(false)
  // 任务状态筛选：'all' | 'not_started' | 'delayed' | 'in_progress' | 'completed'
  const [execStatusFilter, setExecStatusFilter] = useState('all')
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const statusDropdownRef = useRef(null)
  const [selectedMembers, setSelectedMembers] = useState([]) // 多选成员筛选，空数组=全部
  const [dateRangeFilter, setDateRangeFilter] = useState(null) // null=全部 | { start, end }
  const [dateRangeOpen, setDateRangeOpen] = useState(false)
  const memberMultiSelectRef = useRef(null)
  const dateRangeRef = useRef(null)
  const levelDropdownRef = useRef(null)

  // 只读模式（项目主页甘特视图）下，筛选条件由父级共享筛选栏控制；编辑模式使用内部状态
  const effLevelFilter = (readOnly && filterLevel !== undefined) ? filterLevel : levelFilter
  const effDateRangeFilter = (readOnly && filterDateRange !== undefined) ? filterDateRange : dateRangeFilter
  const effSelectedMembers = (readOnly && filterMembers !== undefined) ? filterMembers : selectedMembers
  const effExecStatusFilter = (readOnly && filterExecStatus !== undefined) ? filterExecStatus : execStatusFilter

  useEffect(() => {
    if (!showGranularityMenu) return
    const handleClickOutside = (e) => {
      if (granularityDropdownRef.current && !granularityDropdownRef.current.contains(e.target)) {
        setShowGranularityMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showGranularityMenu])

  useEffect(() => {
    if (!dateRangeOpen) return
    const handleClickOutside = (e) => {
      if (dateRangeRef.current && !dateRangeRef.current.contains(e.target) &&
          !e.target.closest('.date-range-calendar-dropdown')) {
        setDateRangeOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dateRangeOpen])

  useEffect(() => {
    if (!levelDropdownOpen) return
    const handleClickOutside = (e) => {
      if (levelDropdownRef.current && !levelDropdownRef.current.contains(e.target) &&
          !e.target.closest('.gantt-filter-dropdown')) {
        setLevelDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [levelDropdownOpen])

  useEffect(() => {
    if (!statusDropdownOpen) return
    const handleClickOutside = (e) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target) &&
          !e.target.closest('.gantt-filter-dropdown')) {
        setStatusDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [statusDropdownOpen])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getProjectById(projectId)
      .then(project => {
        if (cancelled || !project) return
        setDeliverablesCatalog(project.deliverables_catalog || [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])

  const handleAddDeliverableToCatalog = useCallback((name) => {
    const clean = (name || '').trim()
    if (!clean) return
    if (!projectId) return
    setDeliverablesCatalog(prev => {
      if (prev.includes(clean)) return prev
      const next = [...prev, clean]
      getProjectById(projectId).then(project => {
        if (!project) return
        updateRecord('projects', { ...project, deliverables_catalog: next })
      }).catch(() => {})
      return next
    })
  }, [projectId])

  // 甘特图始终消费 App 共享的实时任务数据 wbsTreeData（与 WBS、网络图共用同一数据源，
  // 不再独立读库回退）。本地维护一份可编辑副本 localTreeData 并随 wbsTreeData 同步，
  // 保证三个视图数据完全一致。
  useEffect(() => {
    setLocalTreeData(wbsTreeData || [])
  }, [wbsTreeData])

  // 直接采用与 WBS/网络图共享的实时数据（localTreeData 已随 wbsTreeData 同步）
  const currentTreeData = localTreeData

  const hasTasks = currentTreeData && currentTreeData.length > 0

  const isHoliday = (date) => {
    if (typeof date === 'string') return isNonWorkDay(date)
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return isNonWorkDay(`${y}-${m}-${d}`)
  }

  const countSpanDays = useCallback((start, end) => {
    if (!start || !end) return 0
    let count = 0
    const s = new Date(`${start}T00:00:00`).getTime()
    const e = new Date(`${end}T00:00:00`).getTime()
    for (let t = s; t <= e; t += 86400000) {
      if (!skipHolidays || !isHoliday(new Date(t))) count++
    }
    return count
  }, [skipHolidays])

  const flattenTasks = useMemo(() => buildLeaves(currentTreeData, dailyInputHours), [currentTreeData, dailyInputHours])

  const daysFromStart = (dateStr) => {
    if (!dateStr) return null
    const startMs = new Date(startDate).setHours(0, 0, 0, 0)
    const dMs = new Date(dateStr).setHours(0, 0, 0, 0)
    return Math.round((dMs - startMs) / 86400000)
  }

  // 树快照锚点：树节点上的 start_date/start_hour 与项目主页显示的进度计划同源
  // （上次保存的快照，或 AI 生成时自带的日期），以它为权威锚点来源。
  const buildSnapshotAnchors = (treeData) => {
    const anchors = {}
    if (!startDate || !treeData || treeData.length === 0) return anchors
    const walk = (nodes) => (nodes || []).forEach(n => {
      if (n.start_date && (!n.children || n.children.length === 0)) {
        const idx = daysFromStart(n.start_date)
        if (idx != null && isFinite(idx)) {
          const rawHour = n.start_hour != null ? Number(n.start_hour) : 0
          anchors[n.id] = Math.max(0, idx + rawHour / dailyInputHours)
        }
      }
      if (n.children && n.children.length) walk(n.children)
    })
    walk(treeData)
    return anchors
  }

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getTasksByProject(projectId)
      .then(tasks => {
        if (cancelled || !Array.isArray(tasks)) return
        // 会话内已主动改动排期（一键排期/拖拽）后，不再用持久化行灌回旧锚点，
        // 否则异步回填会抵消「一键排期」的清空动作
        if (scheduleTouchedRef.current) { anchorsLoadedRef.current = true; return }
        const anchors = {}
        tasks.forEach(task => {
          const startIdx = daysFromStart(task.start_date)
          if (startIdx == null || !isFinite(startIdx)) return
          const rawHour = task.start_hour != null ? task.start_hour : 0
          // 锚点键必须与调度叶子 id 一致（增量模型下叶子 id = original_task_id），
          // 否则已保存的 start_date 无法钉住，进入排期流程会被从头重算
          const anchorKey = task.original_task_id || task.task_ulid
          anchors[anchorKey] = Math.max(0, startIdx + rawHour / dailyInputHours)
        })
        // 树快照与当前显示的树同源，优先级高于 tasks 表行（表里可能混有多版本旧数据）
        const merged = { ...anchors, ...buildSnapshotAnchors(currentTreeData) }
        if (Object.keys(merged).length > 0) {
          setScheduleAnchors(prev => ({ ...prev, ...merged }))
        }
        anchorsLoadedRef.current = true
      })
      .catch(() => { if (!cancelled) anchorsLoadedRef.current = true })
    return () => { cancelled = true }
  }, [projectId, startDate, dailyInputHours, currentTreeData])

  // 锚点播种（树快照）：进入排期页时按快照钉住任务，保证未保存的排期改动
  // （一键排期/拖拽只改内存锚点）在重新进入后回退到主页快照。会话内已改动则不再播种。
  useEffect(() => {
    if (readOnly) return
    if (scheduleTouchedRef.current) return
    const anchors = buildSnapshotAnchors(currentTreeData)
    if (Object.keys(anchors).length > 0) {
      setScheduleAnchors(prev => ({ ...prev, ...anchors }))
    }
  }, [currentTreeData, startDate, dailyInputHours, readOnly])

  const prevStartDateRef = useRef(startDate)
  useEffect(() => {
    const prevStart = prevStartDateRef.current
    prevStartDateRef.current = startDate
    if (readOnly || prevStart === startDate || !projectId) return

    calculateSchedule(scheduleAnchors)
  }, [startDate])

  const calculateSchedule = (anchors = {}, extraPreds = null) => {
    if (readOnly) return computeReadOnlySchedule(flattenTasks, startDate, dailyInputHours)
    return computeSchedule(flattenTasks, startDate, skipHolidays, dailyInputHours, anchors, endDate, currentTreeData, extraPreds, dayAligned, rescheduleFloor)
  }

  const { scheduledTasks, dateRange } = useMemo(() => calculateSchedule(scheduleAnchors), [startDate, flattenTasks, skipHolidays, dayAligned, scheduleAnchors, rescheduleFloor])

  // 「一键排期」应用规则后：清空拖拽锚点，已完成任务钉在快照原位（排期不变），
  // 未完成任务按新规则从所选开始日期起排（rescheduleFloor = 所选起点相对窗口起点的位置下限）
  const prevRulesVersionRef = useRef(scheduleRulesVersion)
  useEffect(() => {
    if (scheduleRulesVersion === prevRulesVersionRef.current) return
    prevRulesVersionRef.current = scheduleRulesVersion
    if (scheduleRulesVersion > 0) {
      scheduleTouchedRef.current = true
      const anchors = {}
      const walk = (nodes) => (nodes || []).forEach(n => {
        if (n.start_date && (!n.children || n.children.length === 0) && statusOfFn(n) === 'completed') {
          const idx = daysFromStart(n.start_date)
          if (idx != null && isFinite(idx)) {
            const rawHour = n.start_hour != null ? Number(n.start_hour) : 0
            anchors[n.id] = Math.max(0, idx + rawHour / dailyInputHours)
          }
        }
        if (n.children && n.children.length) walk(n.children)
      })
      walk(currentTreeData)
      setScheduleAnchors(anchors)
      setRescheduleFloor(rescheduleFloorPos || 0)
      // 一键排期结果回写任务树：与拖拽改期同路径，把重算后的叶子日期（含日内小时偏移）
      // 写进节点 start_date/end_date/start_hour 并推回 App 共享状态。
      // 否则排期结果只存在于本组件内存锚点（scheduleAnchors/rescheduleFloor），切换到
      // 任务分解/排列顺序再回来时组件重挂载、scheduleTouchedRef 复位，锚点会从旧快照
      // 重新播种，排期日期整体回退到一键排期前
      try {
        const nextFloor = rescheduleFloorPos || 0
        const { scheduledTasks: nextScheduled, dateRange: nextRange } = computeSchedule(
          flattenTasks, startDate, skipHolidays, dailyInputHours, anchors, endDate, currentTreeData, null, dayAligned, nextFloor
        )
        const dateMap = {}
        ;(nextScheduled || []).forEach(t => {
          const startHour = Math.round((t.startPos != null ? t.startPos - t.startDay : 0) * dailyInputHours * 100) / 100
          dateMap[t.id] = {
            start_date: nextRange[t.startDay] || null,
            end_date: nextRange[t.endDay] || null,
            start_hour: startHour
          }
        })
        const applyDates = (nodes) => (nodes || []).map(n => {
          const patch = dateMap[n.id]
          const children = n.children && n.children.length ? applyDates(n.children) : (n.children || [])
          return patch ? { ...n, ...patch, children } : { ...n, children }
        })
        if (onTreeDataChange) onTreeDataChange(applyDates(currentTreeData))
      } catch (e) { console.error('一键排期回写任务树失败:', e) }
    }
  }, [scheduleRulesVersion])

  const { criticalTaskIds, criticalEdgeKeys } = useMemo(() => computeCriticalPath(flattenTasks), [flattenTasks])

  const ROW_HEIGHT = 36

  const scheduleMap = useMemo(() => {
    const m = new Map()
    ;(scheduledTasks || []).forEach(t => m.set(t.id, t))
    return m
  }, [scheduledTasks])

  // 本页排期结果的起止时间映射（id / task_ulid 双 key），供任务详情弹窗下钻子任务时兜底显示
  const scheduleDateMapLive = useMemo(() => {
    const m = {}
    ;(scheduledTasks || []).forEach(t => {
      const startHour = t.startPos != null ? Math.round((t.startPos - t.startDay) * dailyInputHours * 100) / 100 : (t.start_hour ?? null)
      const endHour = t.endPos != null ? Math.round((t.endPos - t.endDay) * dailyInputHours * 100) / 100 : (t.end_hour ?? null)
      const entry = {
        startDate: dateRange[t.startDay] || '',
        endDate: dateRange[t.endDay] || '',
        startHour,
        endHour
      }
      m[t.id] = entry
      if (t.task_ulid && t.task_ulid !== t.id) m[t.task_ulid] = entry
    })
    return m
  }, [scheduledTasks, dateRange, dailyInputHours])

  // 父级任务详情：聚合子孙叶子的排期区间（开始取最早、结束取最晚），供弹窗只读展示；
  // 子叶子均未排期时也允许打开（弹窗内由子树树字段/排期映射兜底聚合日期）
  const [parentDetailTask, setParentDetailTask] = useState(null)
  const openParentDetail = useCallback((node) => {
    const leaves = []
    const collect = (n) => {
      if (!n.children || n.children.length === 0) {
        const t = scheduleMap.get(n.id)
        if (t) leaves.push(t)
      } else {
        n.children.forEach(collect)
      }
    }
    collect(node)
    if (leaves.length === 0) {
      setParentDetailTask({ ...node })
    } else {
      let s = leaves[0]
      let e = leaves[0]
      leaves.forEach(t => {
        if (t.startDay < s.startDay || (t.startDay === s.startDay && (t.startPos ?? 0) < (s.startPos ?? 0))) s = t
        if (t.endDay > e.endDay || (t.endDay === e.endDay && (t.endPos ?? 0) > (e.endPos ?? 0))) e = t
      })
      setParentDetailTask({ ...node, startDay: s.startDay, endDay: e.endDay, startPos: s.startPos, endPos: e.endPos })
    }
    setSelectedTaskId(null)
    setShowDetailPopup(true)
  }, [scheduleMap])

  const allTreeRows = useMemo(() => flattenScheduleRows(currentTreeData || [], scheduleMap), [currentTreeData, scheduleMap])

  const firstLevelColorMap = useMemo(() => {
    const map = new Map()
    const walk = (nodes, ancestor) => {
      (nodes || []).forEach(n => {
        const cur = ancestor || n
        const t = scheduleMap.get(cur.id)
        map.set(n.id, t ? t.colorIndex : 0)
        walk(n.children || [], cur)
      })
    }
    walk(currentTreeData || [], null)
    return map
  }, [currentTreeData, scheduleMap])

  const ganttMaxDepth = useMemo(() => {
    let max = 0
    const walk = (nodes, depth) => {
      (nodes || []).forEach(n => {
        if (depth > max) max = depth
        walk(n.children || [], depth + 1)
      })
    }
    walk(currentTreeData || [], 1)
    return max
  }, [currentTreeData])

  const ganttLevelOptions = useMemo(() => {
    const opts = [{ value: 'all', label: '全部任务' }]
    for (let d = 1; d <= Math.max(1, ganttMaxDepth); d++) {
      opts.push({ value: d, label: `${d}级任务` })
    }
    opts.push({ value: 'leaf', label: '执行层级' })
    return opts
  }, [ganttMaxDepth])

  const applyPreset = useCallback((mode) => {
    setQuickViewMode(mode)
    if (mode === 'all') {
      setGanttMinLevel(ganttMaxDepth)
      setGanttShowSummary(true)
      setGanttShowLinks(true)
    } else if (mode === 'schedule') {
      setGanttMinLevel(ganttMaxDepth)
      setGanttShowSummary(false)
      setGanttShowLinks(true)
      setGanttGranularity('day')
    } else if (mode === 'report') {
      setGanttMinLevel(1)
      setGanttShowSummary(true)
      setGanttShowLinks(false)
      setGanttGranularity('week')
    }
  }, [ganttMaxDepth])

  useEffect(() => {
    if (ganttMinLevel == null && ganttMaxDepth > 0) setGanttMinLevel(ganttMaxDepth)
  }, [ganttMaxDepth, ganttMinLevel])

  const minLevel = ganttMinLevel != null ? ganttMinLevel : Math.max(1, ganttMaxDepth)

  const displayRows = useMemo(() => {
    if (!allTreeRows.length) return allTreeRows
    const out = []
    const stack = []

    // 计算层级筛选的有效 minLevel
    let effectiveMinLevel = ganttMaxDepth
    let showOnlyLeaves = false
    if (effLevelFilter === 'all') {
      effectiveMinLevel = ganttMaxDepth
      showOnlyLeaves = false
    } else if (effLevelFilter === 'leaf') {
      effectiveMinLevel = ganttMaxDepth
      showOnlyLeaves = true
    } else if (!isNaN(parseInt(effLevelFilter))) {
      effectiveMinLevel = parseInt(effLevelFilter)
      showOnlyLeaves = false
    }

    // 成员匹配检查（仅对叶子任务；摘要任务是否有匹配的叶子后代在下方统一计算）
    const memberMatchLeaf = (r) => {
      if (effSelectedMembers.length === 0) return true
      const resources = r.task?.resources || []
      return effSelectedMembers.some(sm => resources.some(res => sm.name === res.name && sm.role === res.role))
    }

    // 任务状态匹配检查（仅对叶子任务）：优先用 statusOf（含手动状态），无则退化为按日期推导
    const statusMatchLeaf = (r) => {
      if (effExecStatusFilter === 'all') return true
      const s = statusOfFn(r.task) || deriveExecStatus(r.task, null)
      return s === effExecStatusFilter
    }

    // 日期范围匹配检查（仅对叶子任务）
    const dateMatch = (r) => {
      if (!effDateRangeFilter) return true
      const rangeStart = effDateRangeFilter.start
      const rangeEnd = effDateRangeFilter.end
      if (!rangeStart || !rangeEnd) return true

      // 所有任务统一使用 startBar/endBar + dateRange 计算日期范围
      if (r.startBar != null && r.endBar != null && dateRange?.length) {
        const barStartDate = dateRange[Math.floor(r.startBar)]
        const barEndDate = dateRange[Math.min(Math.ceil(r.endBar) - 1, dateRange.length - 1)]
        if (barStartDate && barEndDate) {
          return barStartDate <= rangeEnd && barEndDate >= rangeStart
        }
      }
      return true
    }

    // 构建 index -> 子节点 index 映射，用于计算「是否有匹配的叶子后代」
    const n = allTreeRows.length
    const childrenMap = new Map()
    const parentStack = []
    allTreeRows.forEach((r, i) => {
      while (parentStack.length && r.level <= allTreeRows[parentStack[parentStack.length - 1]].level) parentStack.pop()
      if (parentStack.length) {
        const p = parentStack[parentStack.length - 1]
        if (!childrenMap.has(p)) childrenMap.set(p, [])
        childrenMap.get(p).push(i)
      }
      parentStack.push(i)
    })

    // 每个叶子是否满足（成员+日期）匹配
    const leafMatch = new Array(n)
    for (let i = 0; i < n; i++) {
      const r = allTreeRows[i]
      leafMatch[i] = r.isLeaf ? (memberMatchLeaf(r) && dateMatch(r) && statusMatchLeaf(r)) : false
    }

    // 后序计算每个节点是否有「匹配的叶子后代」
    const hasMatchingDescendant = new Array(n).fill(false)
    const visited = new Array(n).fill(false)
    const dfs = (i) => {
      if (visited[i]) return hasMatchingDescendant[i]
      visited[i] = true
      const r = allTreeRows[i]
      if (r.isLeaf) { hasMatchingDescendant[i] = leafMatch[i]; return hasMatchingDescendant[i] }
      let any = false
      const kids = childrenMap.get(i) || []
      for (const c of kids) { if (dfs(c)) any = true }
      hasMatchingDescendant[i] = any
      return any
    }
    for (let i = 0; i < n; i++) dfs(i)

    // 最终可见行：摘要任务仅在有匹配的叶子后代（或自身被折叠）时显示
    allTreeRows.forEach((r, i) => {
      while (stack.length && r.level <= stack[stack.length - 1].level) stack.pop()
      const parentCollapsed = stack.length ? stack[stack.length - 1].collapsed : false
      const levelMatch = showOnlyLeaves ? r.isLeaf : r.level <= effectiveMinLevel
      const matched = r.isLeaf
        ? (memberMatchLeaf(r) && dateMatch(r) && statusMatchLeaf(r))
        : (hasMatchingDescendant[i] || collapsedNodeIds.has(r.node.id))
      if (levelMatch && !parentCollapsed && (ganttShowSummary || r.isLeaf) && matched) {
        out.push(r)
      }
      if (r.hasChildren) {
        stack.push({ level: r.level, collapsed: parentCollapsed || collapsedNodeIds.has(r.node.id) })
      }
    })
    return out
  }, [allTreeRows, ganttMaxDepth, effLevelFilter, ganttShowSummary, collapsedNodeIds, effSelectedMembers, effDateRangeFilter, effExecStatusFilter])

  const toggleCollapseNode = useCallback((nodeId) => {
    setCollapsedNodeIds(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const rowIndexById = useMemo(() => {
    const m = new Map()
    displayRows.forEach((r, i) => {
      if (r.task) m.set(r.task.id, i)
      else if (r.node) m.set(r.node.id, i)
    })
    return m
  }, [displayRows])

  const computeMinStartDate = useCallback((taskId) => {
    const candidates = []
    if (startDate) candidates.push(startDate)
    const t = (scheduledTasks || []).find(x => x.id === taskId)
    if (t && (t.predecessors || []).length > 0) {
      let maxEnd = null
      t.predecessors.forEach(pid => {
        const p = (scheduledTasks || []).find(x => x.id === pid)
        if (p && p.endDay != null && dateRange[p.endDay] && (!maxEnd || dateRange[p.endDay] > maxEnd)) {
          maxEnd = dateRange[p.endDay]
        }
      })
      if (maxEnd) candidates.push(maxEnd)
    }
    if (candidates.length === 0) return null
    return candidates.slice().sort()[candidates.length - 1]
  }, [scheduledTasks, dateRange, startDate])

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null
    return scheduledTasks.find(t => t.id === selectedTaskId) || null
  }, [selectedTaskId, scheduledTasks])

  useEffect(() => {
    if (!scheduledTasks.length || !dateRange.length || !onSyncPeriod) return
    let maxE = -Infinity
    scheduledTasks.forEach(t => {
      if (t.endDay > maxE) maxE = t.endDay
    })
    if (maxE === -Infinity) return
    const e = dateRange[Math.min(dateRange.length - 1, maxE)] || null
    if (!e) return
    if (e !== endDate) {
      onSyncPeriod(startDate, e)
    }
  }, [scheduledTasks, dateRange, startDate, endDate, onSyncPeriod])

  const conflictInfoMap = useMemo(() => {
    const memKey = (m) => (m.name ? `${m.role}-${m.name}` : `${m.role}-待分配`)
    const memberKeys = new Set(teamMembers.map(memKey))
    const byId = {}
    const byMember = {}
    scheduledTasks.forEach(task => {
      byId[task.id] = task
      task.resources?.forEach(resource => {
        const key = memKey(resource)
        if (!memberKeys.has(key)) return
        if (!byMember[key]) byMember[key] = []
        byMember[key].push(task)
      })
    })
    const overlapByTaskMember = {}
    Object.entries(byMember).forEach(([memberKey, tasks]) => {
      if (tasks.length <= 1) return
      for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
          const t1 = tasks[i]
          const t2 = tasks[j]
          const s1 = t1.startPos != null ? t1.startPos : (t1.startDay ?? 0)
          const e1 = t1.endPos != null ? t1.endPos : (t1.endDay ?? 0)
          const s2 = t2.startPos != null ? t2.startPos : (t2.startDay ?? 0)
          const e2 = t2.endPos != null ? t2.endPos : (t2.endDay ?? 0)
          if (s1 < e2 && s2 < e1) {
            if (!overlapByTaskMember[t1.id]) overlapByTaskMember[t1.id] = {}
            if (!overlapByTaskMember[t2.id]) overlapByTaskMember[t2.id] = {}
            if (!overlapByTaskMember[t1.id][memberKey]) overlapByTaskMember[t1.id][memberKey] = new Set()
            if (!overlapByTaskMember[t2.id][memberKey]) overlapByTaskMember[t2.id][memberKey] = new Set()
            overlapByTaskMember[t1.id][memberKey].add(t2.id)
            overlapByTaskMember[t2.id][memberKey].add(t1.id)
          }
        }
      }
    })
    const info = {}
    Object.entries(overlapByTaskMember).forEach(([taskId, memberMap]) => {
      info[taskId] = []
      Object.entries(memberMap).forEach(([memberKey, otherIds]) => {
        info[taskId].push({
          member: memberKey,
          tasks: [...otherIds]
            .map(id => {
              const t = byId[id]
              return t ? `${t.code} ${t.name}` : ''
            })
            .filter(Boolean)
        })
      })
    })
    return info
  }, [scheduledTasks, teamMembers])

  const hoveredBarSegments = useMemo(() => {
    let taskId = hoveredBarTaskId
    let previewTarget = null
    if (dragActive && dragPreview && draggingTaskId) {
      taskId = draggingTaskId
      previewTarget = dragPreview.target
    }
    if (!taskId) return []
    const htask = scheduledTasks.find(t => t.id === taskId)
    if (!htask) return []
    const segs = []
    if (previewTarget != null) {
      const hStartPos = htask.startPos != null ? htask.startPos : htask.startDay
      const hEndPos = htask.endPos != null ? htask.endPos : htask.endDay
      const pEnd = previewTarget + Math.max(0, hEndPos - hStartPos)
      const startIdx = Math.max(0, Math.floor(previewTarget))
      const endIdx = Math.min(dateRange.length - 1, Math.max(startIdx, Math.ceil(pEnd) - 1))
      if (startIdx <= endIdx) {
        segs.push({ start: startIdx, end: endIdx })
      }
      return segs
    }
    const startIdx = Math.max(0, htask.startDay)
    const endIdx = Math.min(dateRange.length - 1, htask.endDay)
    if (startIdx <= endIdx) {
      segs.push({ start: startIdx, end: endIdx })
    }
    return segs
  }, [hoveredBarTaskId, dragActive, dragPreview, draggingTaskId, scheduledTasks, dateRange])

  useEffect(() => {
    const exportData = scheduledTasks.map(task => {
      const startDateStr = dateRange[task.startDay] || ''
      const endDateStr = dateRange[task.endDay] || ''
      let startHour, endHour
      if (task.taskType === '里程碑') {
        const hour = dailyInputHours > 0 ? Math.round((task.endPos != null ? task.endPos - task.endDay : 0) * dailyInputHours * 100) / 100 : 0
        startHour = hour
        endHour = hour
      } else {
        const startOffset = task.startPos != null ? task.startPos - task.startDay : 0
        const endOffset = task.endPos != null ? task.endPos - task.endDay : 0
        startHour = Math.round(startOffset * dailyInputHours * 100) / 100
        endHour = Math.round(endOffset * dailyInputHours * 100) / 100
      }
      let durationDays
      if (task.taskType === '里程碑') {
        durationDays = 0
      } else if (task.hasCustomDuration && task.customDurationDays != null) {
        durationDays = task.customDurationDays
      } else {
        const maxHours = (task.resources || []).reduce((max, r) => Math.max(max, r.hours || 0), 0)
        durationDays = dailyInputHours > 0 ? Math.ceil(maxHours / dailyInputHours) : 0
      }
      return {
        id: task.id,
        task_ulid: task.task_ulid,
        code: task.code,
        name: task.name,
        taskType: task.taskType || '等待',
        totalHours: task.totalHours,
        resources: task.resources,
        durationDays,
        startDate: startDateStr,
        endDate: endDateStr,
        startHour,
        endHour,
        predecessors: task.predecessors || [],
        description: task.description || '',
        deliverables: task.deliverables || [],
        ancestors: task.ancestors || [],
        projectName,
      }
    })
    if (onExportSchedule) {
      onExportSchedule(exportData)
    }
  }, [scheduledTasks, dateRange, onExportSchedule])

  const GANTT_CELL = 44
  const GANTT_CELL_WIDE = 88
  const GANTT_CELL_MONTH = 176

  const ganttPxPerDay = useMemo(() => {
    if (ganttGranularity === 'hour') return Math.max(1, Math.round(dailyInputHours)) * GANTT_CELL
    if (ganttGranularity === 'week') return GANTT_CELL_WIDE / 7
    if (ganttGranularity === 'month') return GANTT_CELL_MONTH / 30
    return GANTT_CELL
  }, [ganttGranularity, dailyInputHours])

  const monthSegs = useMemo(() => {
    if (ganttGranularity !== 'month') return null
    const segs = []
    const segOfDay = new Array(dateRange.length)
    let i = 0
    while (i < dateRange.length) {
      const d = new Date(dateRange[i])
      const y = d.getFullYear()
      const m = d.getMonth()
      let days = 0
      while (i + days < dateRange.length) {
        const dd = new Date(dateRange[i + days])
        if (dd.getFullYear() !== y || dd.getMonth() !== m) break
        days++
      }
      const dim = new Date(y, m + 1, 0).getDate()
      for (let k = 0; k < days; k++) segOfDay[i + k] = segs.length
      segs.push({ startIdx: i, firstCalDay: new Date(dateRange[i]).getDate(), visibleDays: days, dim })
      i += days
    }
    return { segs, segOfDay }
  }, [dateRange, ganttGranularity])

  const monthEdgePad = useMemo(() => {
    const w = ganttPxPerDay
    if (ganttGranularity === 'week') {
      if (!dateRange.length) return { before: 0, after: 0 }
      const first = new Date(dateRange[0])
      const last = new Date(dateRange[dateRange.length - 1])
      const before = Math.round((first - getWeekMonday(first)) / 86400000) * w
      const sunday = new Date(getWeekMonday(last))
      sunday.setDate(sunday.getDate() + 6)
      const after = Math.round((sunday - last) / 86400000) * w
      return { before, after }
    }
    if (!monthSegs) return { before: 0, after: 0 }
    let sumVisible = 0
    for (let k = 0; k < dateRange.length; k++) sumVisible += w
    const total = monthSegs.segs.reduce((s, seg) => s + seg.dim, 0) * w
    const before = monthSegs.segs.length ? (monthSegs.segs[0].firstCalDay - 1) * w : 0
    return { before, after: Math.max(0, total - before - sumVisible) }
  }, [ganttGranularity, monthSegs, ganttPxPerDay, dateRange])

  const posToPx = useCallback((pos) => {
    return monthEdgePad.before + pos * ganttPxPerDay
  }, [monthEdgePad.before, ganttPxPerDay])

  // 「今天」在甘特日期范围内的天序号，不在范围内为 -1
  const todayIdx = useMemo(() => {
    if (!dateRange.length) return -1
    const now = new Date()
    for (let i = 0; i < dateRange.length; i++) {
      const d = new Date(dateRange[i])
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
        return i
      }
    }
    return -1
  }, [dateRange])

  // 时间线横向位置：今日对应格子的右侧边界（posToPx 已含周/月粒度边缘补白），今天不在范围内为 null
  const todayMarkerLeft = todayIdx >= 0 ? posToPx(todayIdx + 1) : null

  const pxToPos = useCallback((px) => {
    return (px - monthEdgePad.before) / ganttPxPerDay
  }, [monthEdgePad.before, ganttPxPerDay])

  const ganttGranuleIndex = useMemo(() => {
    if (ganttGranularity === 'week') {
      const arr = []
      let counter = -1
      let lastMonday = null
      dateRange.forEach(date => {
        const m = getWeekMonday(date).getTime()
        if (m !== lastMonday) { counter++; lastMonday = m }
        arr.push(counter)
      })
      return arr
    }
    if (ganttGranularity === 'month') {
      const arr = []
      let counter = -1
      let lastKey = null
      dateRange.forEach(date => {
        const d = new Date(date)
        const key = `${d.getFullYear()}-${d.getMonth()}`
        if (key !== lastKey) { counter++; lastKey = key }
        arr.push(counter)
      })
      return arr
    }
    return dateRange.map((_, i) => i)
  }, [dateRange, ganttGranularity])

  const ganttHoursPerDay = Math.max(1, Math.round(dailyInputHours))

  const ganttCoarseCells = useMemo(() => {
    const cells = []
    if (!dateRange.length) return cells
    if (ganttGranularity === 'month') {
      let i = 0
      while (i < dateRange.length) {
        const d = new Date(dateRange[i])
        const y = d.getFullYear()
        const m = d.getMonth()
        let days = 0
        while (i + days < dateRange.length) {
          const dd = new Date(dateRange[i + days])
          if (dd.getFullYear() !== y || dd.getMonth() !== m) break
          days++
        }
        const content = `${y}年${m + 1}月`
        cells.push({ key: `cm-${y}-${m}`, width: days * ganttPxPerDay, content, start: i, end: i + days - 1 })
        i += days
      }
      return cells
    }
    if (ganttGranularity === 'week') {
      let i = 0
      while (i < dateRange.length) {
        const monday = getWeekMonday(new Date(dateRange[i])).getTime()
        let days = 1
        while (i + days < dateRange.length && getWeekMonday(new Date(dateRange[i + days])).getTime() === monday) days++
        cells.push({ key: `cw-${i}`, width: 7 * ganttPxPerDay, content: `第${getWeekNo(new Date(dateRange[i]))}周`, start: i, end: i + days - 1 })
        i += days
      }
      return cells
    }
    dateRange.forEach((date, idx) => {
      const d = new Date(date)
      let content = null
      if (ganttGranularity === 'day') {
        if (d.getDate() === 1) content = `${d.getFullYear()}年${d.getMonth() + 1}月`
      } else if (ganttGranularity === 'hour') {
        content = d.getDate() === 1 ? `${d.getFullYear()}年${d.getMonth() + 1}月` : `${d.getMonth() + 1}/${d.getDate()}`
      }
      cells.push({ key: `cm-${idx}`, width: ganttPxPerDay, content, start: idx, end: idx })
    })
    return cells
  }, [dateRange, ganttGranularity, ganttPxPerDay])

  const ganttFineCells = useMemo(() => {
    const cells = []
    if (!dateRange.length) return cells
    if (ganttGranularity === 'month') {
      let i = 0
      while (i < dateRange.length) {
        const d = new Date(dateRange[i])
        const m = d.getMonth()
        let days = 0
        while (i + days < dateRange.length) {
          const dd = new Date(dateRange[i + days])
          if (dd.getMonth() !== m) break
          days++
        }
        const dim = new Date(d.getFullYear(), m + 1, 0).getDate()
        const width = dim * ganttPxPerDay
        cells.push({ key: `fm-${i}`, type: 'month', width, content: `${m + 1}月`, start: i, end: i + days - 1 })
        i += days
      }
      return cells
    }
    if (ganttGranularity === 'week') {
      let i = 0
      while (i < dateRange.length) {
        const startDate = new Date(dateRange[i])
        const monday = getWeekMonday(startDate)
        let days = 1
        while (i + days < dateRange.length && getWeekMonday(new Date(dateRange[i + days])).getTime() === monday.getTime()) days++
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        cells.push({
          key: `fw-${i}`,
          type: 'week',
          width: 7 * ganttPxPerDay,
          week: getWeekNo(startDate),
          startText: `${monday.getMonth() + 1}/${monday.getDate()}`,
          endText: `${sunday.getMonth() + 1}/${sunday.getDate()}`,
          start: i,
          end: i + days - 1,
        })
        i += days
      }
      return cells
    }
    dateRange.forEach((date, idx) => {
      if (ganttGranularity === 'hour') {
        cells.push({
          key: `fh-${idx}`,
          type: 'hours',
          width: ganttHoursPerDay * GANTT_CELL,
          hours: Array.from({ length: ganttHoursPerDay }, (_, h) => h + 1),
          start: idx,
          end: idx,
        })
        return
      }
      cells.push({
        key: `fd-${idx}`,
        type: 'day',
        width: ganttPxPerDay,
        content: new Date(date).getDate(),
        start: idx,
        end: idx,
      })
    })
    return cells
  }, [dateRange, ganttGranularity, ganttPxPerDay, ganttHoursPerDay])

  const updateFirstVisibleCol = useCallback((scrollLeft) => {
    setFirstVisibleCol(Math.max(0, Math.ceil(pxToPos(scrollLeft))))
  }, [pxToPos])

  const handleTaskColumnResize = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = taskColumnWidth
    const onMove = (ev) => {
      setTaskColumnWidth(Math.min(560, Math.max(160, startW + (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [taskColumnWidth])

  useEffect(() => {
    const el = ganttScrollRef.current
    if (!el) return
    const maxScroll = el.scrollWidth - el.clientWidth
    if (el.scrollLeft > maxScroll) el.scrollLeft = maxScroll
    updateFirstVisibleCol(el.scrollLeft)
  }, [dateRange, startDate, updateFirstVisibleCol])

  const getMonthLabels = () => {
    if (!dateRange || dateRange.length === 0) return []
    
    const labels = []
    let currentMonth = -1
    
    dateRange.forEach((date, idx) => {
      const d = new Date(date)
      const month = d.getMonth()
      const year = d.getFullYear()
      
      if (month !== currentMonth) {
        currentMonth = month
        const nextMonthStart = dateRange.findIndex((d, i) => {
          if (i <= idx) return false
          const nextD = new Date(d)
          return nextD.getMonth() !== month
        })
        const span = nextMonthStart > 0 ? nextMonthStart - idx : dateRange.length - idx
        
        labels.push(
          <div
            key={idx}
            className="gantt-month-label"
            style={{ gridColumn: `span ${span}` }}
          >
            {year}年{month + 1}月
          </div>
        )
      }
    })
    
    return labels
  }

  const handleBarClick = useCallback((task) => {
    // 只读模式且外部传入预览回调时，打开外部任务详情预览弹窗（如项目主页）
    if (readOnly && onTaskBarPreview) { onTaskBarPreview(task); return }
    setParentDetailTask(null)
    setSelectedTaskId(task.id)
    setShowDetailPopup(true)
    setContextMenu(null)
  }, [readOnly, onTaskBarPreview])

  const handleBarRightClick = useCallback((e, task) => {
    if (readOnly) return
    // 已完成任务锁定排期，不提供右键调整菜单
    if (statusOfFn(task) === 'completed') return
    e.preventDefault()
    setSelectedTaskId(task.id)
    setAdvanceDays(1)
    setDelayDays(1)
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [statusOfFn])

  const commitScheduleShift = useCallback((taskId, target) => {
    const newTarget = Math.max(0, target ?? 0)
    const byId = new Map(scheduledTasks.map(t => [t.id, t]))
    const dragged = byId.get(taskId)
    const sPos = dragged ? (dragged.startPos != null ? dragged.startPos : (dragged.startDay ?? 0)) : 0
    const ePos = dragged ? (dragged.endPos != null ? dragged.endPos : ((dragged.endDay != null ? dragged.endDay : sPos) + 1)) : (sPos + 1)
    const dragEnd = newTarget + Math.max(0, ePos - sPos)
    const taskOldStart = (t) => t.startPos != null ? t.startPos : (t.startDay ?? 0)

    // 1) 依赖闭包：拖拽任务 + 所有（传递）依赖它的任务（即「受影响的任务」）
    //    moveReason 记录每个任务被拉进重算的原因，仅供调试日志展示
    const mustMove = new Set([taskId])
    const moveReason = {}
    let closureChanged = true
    while (closureChanged) {
      closureChanged = false
      scheduledTasks.forEach(t => {
        if (mustMove.has(t.id)) return
        const hitPreds = (t.predecessors || []).filter(pid => mustMove.has(pid))
        if (hitPreds.length > 0) {
          mustMove.add(t.id)
          moveReason[t.id] = '前置依赖 ' + hitPreds.map(pid => {
            const p = byId.get(pid)
            return p ? (p.code ? p.code + ' ' + p.name : p.name) : pid
          }).join('、')
          closureChanged = true
        }
      })
    }

    // 2) 间隔锚点：受影响任务保持与前置任务的原有间隔。
    //    gap 以「工作日」度量（而非日历位置）：前置结束与任务开始之间跨越的
    //    周末/节假日不计入间隔。若用日历位置度量，周五结束→周一 starts 会被
    //    记成 2 天间隔，任务拖到别处后重新应用就会凭空多出两天空档。
    //    重算时 开始 = advanceWorkSpan(前置新结束, gap)，按工作日推进。
    //    注意：联动只沿依赖链传播；同成员的时间占用不做自动联动，
    //    拖拽落位后如产生成员占用冲突，仅提示用户手动调整（见下方冲突检测）。
    const dayDateAt = (d) => {
      const x = new Date(startDate)
      x.setDate(x.getDate() + d)
      return x
    }
    const isWorkDayIdx = (d) => {
      if (!skipHolidays) return true
      const x = dayDateAt(d)
      const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
      return !isNonWorkDay(key)
    }
    // 位置 p 的工作时间坐标：p 之前的完整工作日数 +（p 当天为工作日时的小数部分）。
    // 同一边界值差恒为 0（相邻保持相邻），跨周末的相邻也记 0，隔 N 个工作日记 N。
    const workCoord = (p) => {
      if (p == null) return 0
      const whole = Math.floor(p + 1e-9)
      let count = 0
      for (let d = 0; d < whole; d++) if (isWorkDayIdx(d)) count++
      return count + (isWorkDayIdx(whole) ? p - whole : 0)
    }
    const oldEndOf = (id) => {
      const p = byId.get(id)
      if (!p) return 0
      return p.endPos != null ? p.endPos : ((p.endDay != null ? p.endDay : (p.startDay ?? 0)) + 1)
    }
    const computeGapAnchors = () => {
      const g = {}
      scheduledTasks.forEach(t => {
        if (t.id === taskId || !mustMove.has(t.id)) return
        let oldEarliest = 0
        ;(t.predecessors || []).forEach(pid => {
          const pe = oldEndOf(pid)
          if (pe > oldEarliest) oldEarliest = pe
        })
        g[t.id] = { gap: Math.max(0, workCoord(taskOldStart(t)) - workCoord(oldEarliest)) }
      })
      return g
    }
    const gapAnchors = computeGapAnchors()

    // 锚点表：拖拽任务钉在新位置；受影响任务用 {gap} 间隔锚点由调度器按
    // 「前置新结束 + 原间隔 + 自身工期」重新计算开始/结束；
    // 未受影响任务钉在当前位置防漂移
    const buildAnchors = () => {
      const a = { ...gapAnchors }
      a[taskId] = newTarget
      scheduledTasks.forEach(t => {
        if (t.id === taskId) return
        if (!mustMove.has(t.id)) a[t.id] = Math.max(0, taskOldStart(t) ?? 0)
      })
      return a
    }

    const nextAnchors = buildAnchors()
    const next = calculateSchedule(nextAnchors)
    const nextList = Array.isArray(next) ? next : (next?.scheduledTasks || [])

    // 3) 成员占用冲突检测：拖拽只沿依赖链联动，同成员的时间冲突不自动调整，
    //    这里检测重算结果中同成员（角色-姓名，hours>0）任务的时间区间重叠，
    //    命中则 toast 提示用户手动拖拽调整。
    {
      const memberBuckets = new Map()
      nextList.forEach(t => {
        ;(t.resources || []).forEach(r => {
          if (!(r.hours > 0)) return
          const k = r.name ? `${r.role}-${r.name}` : r.role
          if (!memberBuckets.has(k)) memberBuckets.set(k, [])
          memberBuckets.get(k).push(t)
        })
      })
      const spanOfT = (t) => {
        const s = t.startPos != null ? t.startPos : (t.startDay ?? 0)
        const e = t.endPos != null ? t.endPos : ((t.endDay != null ? t.endDay : s) + 1)
        return [s, e]
      }
      const conflicts = []
      const seenPair = new Set()
      memberBuckets.forEach((list, k) => {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [aS, aE] = spanOfT(list[i])
            const [bS, bE] = spanOfT(list[j])
            if (aS < bE - 1e-9 && bS < aE - 1e-9) {
              const pk = list[i].id < list[j].id ? `${list[i].id}|${list[j].id}` : `${list[j].id}|${list[i].id}`
              if (!seenPair.has(pk)) {
                seenPair.add(pk)
                conflicts.push({ member: k, a: list[i], b: list[j] })
              }
            }
          }
        }
      })
      if (conflicts.length) {
        const label = (t) => (t.code ? t.code + ' ' : '') + (t.name || '')
        const memberLabel = (k) => {
          const sep = k.indexOf('-')
          return sep >= 0 ? `${k.slice(sep + 1)}（${k.slice(0, sep)}）` : k
        }
        const detail = conflicts.slice(0, 2)
          .map(c => `${memberLabel(c.member)}：${label(c.a)} ↔ ${label(c.b)}`)
          .join('；')
        showConflictToast(`成员占用冲突，请手动拖拽调整：${detail}${conflicts.length > 2 ? ` 等 ${conflicts.length} 处` : ''}`)
      }
    }

    // ===== DEBUG：拖拽松手后打印受影响任务的原/新日期，方便排查联动移动问题 =====
    {
      const posToDay = (pos) => {
        const i = Math.max(0, Math.min(dateRange.length - 1, Math.floor(pos)))
        return dateRange[i] != null ? dateRange[i] : `位置${pos}`
      }
      const rangeStr = (sp, ep) => `${sp}(${posToDay(sp)}) ~ 结束于 ${ep - 1}(${posToDay(Math.max(sp, ep - 1))})`
      const nextDragged = nextList.find(t => t.id === taskId)
      const nDragEnd = nextDragged && nextDragged.endPos != null ? nextDragged.endPos : dragEnd
      console.group(`%c[甘特调试] 拖拽「${dragged ? dragged.name : taskId}」→ 新开始位置 ${newTarget}`, 'color:#7c3aed;font-weight:bold')
      console.log('拖拽任务:', {
        名称: dragged?.name,
        编号: dragged?.code,
        原: rangeStr(sPos, ePos),
        新: rangeStr(newTarget, nDragEnd),
      })
      const affected = []
      mustMove.forEach(id => {
        if (id === taskId) return
        const t = byId.get(id)
        if (!t) return
        const oS = taskOldStart(t)
        const oE = t.endPos != null ? t.endPos : ((t.endDay != null ? t.endDay : oS) + 1)
        const nt = nextList.find(x => x.id === id)
        const nS = nt ? (nt.startPos != null ? nt.startPos : (nt.startDay ?? 0)) : null
        const nE = nt ? (nt.endPos != null ? nt.endPos : ((nt.endDay != null ? nt.endDay : nS) + 1)) : null
        affected.push({
          任务: (t.code ? t.code + ' ' : '') + t.name,
          原因: moveReason[id] || '-',
          前置依赖: (t.predecessors || []).map(pid => { const p = byId.get(pid); return p ? (p.code ? p.code + ' ' + p.name : p.name) : pid }).join('、') || '无',
          间隔: gapAnchors[id] ? gapAnchors[id].gap : '-',
          原开始: `${oS}(${posToDay(oS)})`,
          原结束: `${oE - 1}(${posToDay(Math.max(oS, oE - 1))})`,
          新开始: nS != null ? `${nS}(${posToDay(nS)})` : '-',
          新结束: nE != null ? `${nE - 1}(${posToDay(Math.max(nS ?? 0, nE - 1))})` : '-',
        })
      })
      if (affected.length) {
        console.table(affected)
      } else {
        console.log('没有其他任务被联动移动')
      }
      console.log('nextAnchors(锚点表):', JSON.parse(JSON.stringify(nextAnchors)))
      console.groupEnd()
    }

    scheduleTouchedRef.current = true
    setScheduleAnchors(nextAnchors)
    return next
  }, [scheduledTasks, calculateSchedule, dateRange, showConflictToast])

  const handleShiftTask = useCallback((taskId, newStartPos) => {
    commitScheduleShift(taskId, Math.max(0, newStartPos))
  }, [scheduledTasks, commitScheduleShift, projectId, dailyInputHours])

  const computeDragSnap = (rawTarget, limit) => {
    if (rawTarget <= limit + 1e-9) {
      return { target: limit, showGuide: true }
    }
    return { target: Math.max(Math.ceil(limit - 1e-9), Math.round(rawTarget)), showGuide: false }
  }

  const handleBarMouseDown = useCallback((e, task) => {
    if (readOnly) return
    if (e.button !== 0) return
    // 已完成任务锁定排期，不允许拖拽调整
    if (statusOfFn(task) === 'completed') return
    e.preventDefault()
    e.stopPropagation()
    setSelectedTaskId(task.id)
    setContextMenu(null)
    let limit = 0
    ;(task.predecessors || []).forEach(pid => {
      const p = scheduledTasks.find(x => x.id === pid)
      if (p && p.endPos != null && p.endPos > limit) limit = p.endPos
    })
    const startPos = task.startPos != null ? task.startPos : (task.startDay ?? 0)
    dragStateRef.current = { taskId: task.id, startClientX: e.clientX, startPos, limit }
    suppressClickRef.current = true
    setDraggingTaskId(task.id)
    setDragPreview({ target: startPos, limit, showGuide: false })
    setDragActive(true)
  }, [scheduledTasks, statusOfFn])

  const handleBarMouseEnter = useCallback((e, idx, task) => {
    setHoveredRow(idx)
    setHoveredBarTaskId(task.id)
    const barsEl = e.currentTarget?.parentElement
    if (barsEl) {
      const px = e.clientX - barsEl.getBoundingClientRect().left
      const pos = pxToPos(px)
      const di = Math.max(0, Math.min(dateRange.length - 1, Math.floor(pos)))
      setHoveredCol(ganttGranuleIndex[di])
    }
  }, [pxToPos, ganttGranuleIndex, dateRange.length])

  const handleBarMouseLeave = useCallback(() => {
    setHoveredRow(-1)
    setHoveredBarTaskId(null)
    setHoveredCol(-1)
  }, [])

  useEffect(() => {
    if (!dragActive) return
    const onMouseMove = (e) => {
      const st = dragStateRef.current
      if (!st) return
      const rawTarget = st.startPos + (e.clientX - st.startClientX) / ganttPxPerDay
      setDragPreview(({ ...computeDragSnap(rawTarget, st.limit), limit: st.limit }))
    }
    const onMouseUp = (e) => {
      const st = dragStateRef.current
      dragStateRef.current = null
      setDragActive(false)
      setDraggingTaskId(null)
      setDragPreview(null)
      if (!st) return
      const distPx = e.clientX - st.startClientX
      if (Math.abs(distPx) < 5) {
        suppressClickRef.current = false
        return
      }
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 0)
      const rawTarget = st.startPos + distPx / ganttPxPerDay
      const { target } = computeDragSnap(rawTarget, st.limit)
      if (target === st.startPos) return
      handleShiftTask(st.taskId, Math.max(0, target))
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragActive, handleShiftTask, ganttPxPerDay])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const menu = contextMenuRef.current
    const { offsetWidth, offsetHeight } = menu
    const margin = 8
    let { x, y } = contextMenu
    if (x + offsetWidth > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - offsetWidth - margin)
    }
    if (y + offsetHeight > window.innerHeight - margin) {
      y = Math.max(margin, window.innerHeight - offsetHeight - margin)
    }
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu({ x, y })
    }
  }, [contextMenu])

  const handleContextMenuAction = useCallback((action) => {
    if (!selectedTask) return
    // 已完成任务锁定排期，不允许通过菜单调整（兜底）
    if (statusOfFn(selectedTask) === 'completed') { setContextMenu(null); return }

    if (action === 'assign') {
      setShowResourceModal(true)
      setContextMenu(null)
      return
    }

    const days = action === 'advance' ? advanceDays : delayDays
    if (days <= 0) return

    const adjustment = action === 'advance' ? -days : days

    const prevTask = scheduledTasks.find(t => t.id === selectedTask.id)
    const prevStart = prevTask ? prevTask.startDay : 0

    handleShiftTask(selectedTask.id, prevStart + adjustment)
    setContextMenu(null)
  }, [selectedTask, advanceDays, delayDays, scheduledTasks, handleShiftTask, statusOfFn])

  useEffect(() => {
    anchorsLoadedRef.current = true
  }, [projectId])
  const handleSaveSchedule = useCallback(async () => {
    if (!projectId || !scheduledTasks.length || !dateRange.length) return
    console.log('=== 保存进度计划 ===')
  }, [projectId, scheduledTasks, dateRange, dailyInputHours])

  const handleCloseResourceModal = useCallback(() => {
    setShowResourceModal(false)
  }, [])

  const handleSaveResources = useCallback((resources) => {
    setShowResourceModal(false)
    console.log('Save resources:', resources)
  }, [])

  const handleUpdateTaskResources = useCallback(async (taskId, resourceIndex, updater) => {
    if (!currentTreeData) return
    const newTree = updateNodeResources(currentTreeData, taskId, updater)
    setLocalTreeData(newTree)
    if (onTreeDataChange) onTreeDataChange(newTree)
  }, [currentTreeData, projectId, onTreeDataChange])

  const handleResourceMemberChange = useCallback((taskId, resourceIndex, selectedValue) => {
    const member = teamMembers.find(m => `${m.role}-${m.name}` === selectedValue)
    handleUpdateTaskResources(taskId, resourceIndex, (resources) =>
      resources.map((r, i) => (i === resourceIndex
        ? { ...r, role: member?.role || '', name: member?.name || '', avatar: member?.avatar || '' }
        : r))
    )
  }, [teamMembers, handleUpdateTaskResources])

  const handleResourceHoursChange = useCallback((taskId, resourceIndex, hours) => {
    if (!currentTreeData) return
    const task = findNodeInTree(currentTreeData, taskId)
    const newResources = (task?.resources || []).map((r, i) =>
      i === resourceIndex ? { ...r, hours } : r
    )
    // 自定义工期：工时换算天数超过自定义工期时，清除自定义转为自动计算（甘特图口径取工时合计）
    const exceeded = calcCustomDurationExceeded(task, newResources, dailyInputHours, 'sum')
    const patch = { resources: newResources }
    if (exceeded != null) patch.customDurationDays = undefined
    const newTree = updateNodeFields(currentTreeData, taskId, patch)
    setLocalTreeData(newTree)
    if (onTreeDataChange) onTreeDataChange(newTree)
  }, [currentTreeData, dailyInputHours, onTreeDataChange])

  const handleDeleteTaskResource = useCallback((taskId, resourceIndex) => {
    handleUpdateTaskResources(taskId, resourceIndex, (resources) =>
      resources.filter((_, i) => i !== resourceIndex)
    )
  }, [handleUpdateTaskResources])

  const handleAddTaskResource = useCallback((taskId, member) => {
    if (!member) return
    handleUpdateTaskResources(taskId, -1, (resources) => [
      ...resources,
      { role: member.role || '', name: member.name || '', avatar: member.avatar || '', hours: 0 }
    ])
  }, [handleUpdateTaskResources])

  const getEffectiveDurationDays = useCallback((task) => {
    if (task.customDurationDays && task.customDurationDays > 0) return task.customDurationDays
    const totalHours = (task.resources || []).reduce((sum, r) => sum + (r.hours || 0), 0)
    if (totalHours <= 0 || !dailyInputHours) return 1
    return Math.max(1, Math.ceil(totalHours / dailyInputHours))
  }, [dailyInputHours])

  const applyTreeChange = useCallback((taskId, patch) => {
    if (!currentTreeData) return null
    const newTree = updateNodeFields(currentTreeData, taskId, patch)
    setLocalTreeData(newTree)
    if (onTreeDataChange) onTreeDataChange(newTree)
    return newTree
  }, [currentTreeData, onTreeDataChange])

  const handleUpdateTaskDuration = useCallback((taskId, days) => {
    applyTreeChange(taskId, { customDurationDays: days })
  }, [applyTreeChange, currentTreeData, projectId])

  const handleAutoCalcDuration = useCallback((taskId) => {
    handleUpdateTaskDuration(taskId, null)
  }, [handleUpdateTaskDuration])

  const handleUpdateTaskDates = useCallback((taskId, startDate, endDate, which) => {
    const node = findNodeInTree(currentTreeData, taskId)
    if (!node) return
    const durDays = getEffectiveDurationDays(node)

    let nextCustomDays = node.customDurationDays
    if (which === 'range' && startDate && endDate) {
      const spanDays = countSpanDays(startDate, endDate, skipHolidays)
      if (spanDays > durDays) nextCustomDays = spanDays
    }

    let anchor = null
    if (which === 'end' && endDate) {
      const endIdx = daysFromStart(endDate)
      anchor = (endIdx != null ? endIdx : 0) - Math.max(1, durDays) + 1
    } else if (startDate && (which === 'start' || which === 'range')) {
      anchor = daysFromStart(startDate) || 0
    }
    if (anchor != null) {
      commitScheduleShift(taskId, Math.max(0, anchor))
    }
    applyTreeChange(taskId, {
      start_date: startDate || null,
      end_date: endDate || null,
      ...(nextCustomDays !== node.customDurationDays ? { customDurationDays: nextCustomDays } : {})
    })
  }, [currentTreeData, projectId, getEffectiveDurationDays, daysFromStart, applyTreeChange, skipHolidays, commitScheduleShift])

  const handleUpdateTaskHours = useCallback((taskId, which, hour) => {
    const task = scheduledTasks.find(t => t.id === taskId)
    if (!task) return
    const clamped = Math.max(0, Math.min(24, hour))
    if (which === 'start') {
      const newStartPos = (task.startDay ?? 0) + clamped / dailyInputHours
      if (newStartPos >= 0) {
        commitScheduleShift(taskId, newStartPos)
      }
    } else {
      const newEndPos = (task.endDay ?? 0) + clamped / dailyInputHours
      const dur = (task.endPos != null ? task.endPos : ((task.endDay != null ? task.endDay : 0) + 1)) - (task.startPos != null ? task.startPos : (task.startDay ?? 0))
      const newStartPos = Math.max(0, newEndPos - dur)
      commitScheduleShift(taskId, newStartPos)
    }
  }, [scheduledTasks, dailyInputHours, commitScheduleShift, projectId])

  // 切换任务级跳过节假日规则：持久化到任务树，并按开始日期+工期重新推算树字段 end_date
  // （与 WBS/网络图页同口径；本页甘特条位置由排期引擎按锚点+工期计算，树字段只作详情展示兜底）
  const handleUpdateTaskSkipHolidays = useCallback((taskId, flag) => {
    const node = findNodeInTree(currentTreeData, taskId)
    if (!node) return
    const patch = { skip_holidays: flag }
    if (node.start_date) {
      const days = node.customDurationDays > 0 ? node.customDurationDays : (getEffectiveDurationDays(node) || 0)
      if (days > 0) patch.end_date = computeEndFromDuration(node.start_date, days, flag)
    }
    applyTreeChange(taskId, patch)
  }, [applyTreeChange, currentTreeData, projectId, getEffectiveDurationDays])

  const handleUpdateTaskDeliverables = useCallback((taskId, deliverables) => {
    applyTreeChange(taskId, { deliverables })
  }, [applyTreeChange, currentTreeData, projectId])

  const handleUpdateTaskDescription = useCallback((taskId, description) => {
    applyTreeChange(taskId, { description })
  }, [applyTreeChange, currentTreeData, projectId])

  const mergedDeliverablesCatalog = useMemo(() => {
    const fromTree = []
    const collect = (nodes) => {
      (nodes || []).forEach(n => {
        (n.deliverables || []).forEach(d => { if (d) fromTree.push(d) })
        if (n.children && n.children.length > 0) collect(n.children)
      })
    }
    collect(currentTreeData)
    return Array.from(new Set([...(deliverablesCatalog || []), ...fromTree]))
  }, [deliverablesCatalog, currentTreeData])

  const getMemberTasks = () => {
    const memberMap = {}

    teamMembers.forEach(member => {
      const key = member.name ? `${member.role}-${member.name}` : member.role
      memberMap[key] = {
        ...member,
        tasks: [],
        totalHours: 0
      }
    })

    scheduledTasks.forEach(task => {
      task.resources?.forEach(resource => {
        const key = resource.name ? `${resource.role}-${resource.name}` : resource.role
        if (memberMap[key]) {
          memberMap[key].tasks.push(task)
          memberMap[key].totalHours += resource.hours || 0
        }
      })
    })

    return Object.values(memberMap)
  }

  // 顶部导航第二行（团队人数/工时粒度/每日投入）：渲染到 App content-header 的槽位
  const [headerStatsSlot, setHeaderStatsSlot] = useState(null)
  useEffect(() => {
    setHeaderStatsSlot(document.getElementById('planning-header-stats-slot'))
  }, [])
  const headerStatsPortal = headerStatsSlot ? createPortal(
    <PlanningHeaderStats
      teamMembers={getMemberTasks()}
      isMemberListExpanded={isMemberListExpanded}
      onToggleMemberList={readOnly ? undefined : setIsMemberListExpanded}
      timeRuleUnit={timeRuleUnit}
      timeRuleValue={timeRuleValue}
      dailyInputHours={dailyInputHours}
      onApplyTimeRule={readOnly ? undefined : onApplyTimeRule}
      onApplyDailyInput={readOnly ? undefined : onApplyDailyInput}
      readOnly={readOnly}
    />,
    headerStatsSlot
  ) : null

  if (!hasTasks) {
    return (
      <div className="page-container">
        {headerStatsPortal}
        <div className="page-content" style={{ display: 'flex', alignItems: 'stretch' }}>
          {!readOnly && isMemberListExpanded && (
            <div className="schedule-left">
              <MemberList
                teamMembers={getMemberTasks()}
                showDetails={true}
                timeRuleUnit={timeRuleUnit}
                selectedMember={selectedMember}
                onSelectMember={setSelectedMember}
                onCollapse={() => setIsMemberListExpanded(false)}
                onAddRole={onAddRole}
                onAddMember={onAddMember}
                onRenameRole={onRenameRole}
                onDeleteRole={onDeleteRole}
                onRenameMember={onRenameMember}
                onDeleteMember={onDeleteMember}
              />
            </div>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="wbs-empty-state">
              <div className="empty-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p className="empty-text">暂无任务</p>
              <p className="empty-text" style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '4px' }}>请先进行任务分解</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      {headerStatsPortal}
      {conflictToast && <div className="member-list-toast">{conflictToast}</div>}

      <div className="page-content schedule-content">
        {!readOnly && isMemberListExpanded && (
          <div className="schedule-left">
            <MemberList
            teamMembers={getMemberTasks()}
            showDetails={true}
            timeRuleUnit={timeRuleUnit}
            selectedMember={selectedMember}
            onSelectMember={setSelectedMember}
            onCollapse={() => setIsMemberListExpanded(false)}
            onAddRole={onAddRole}
            onAddMember={onAddMember}
            onRenameRole={onRenameRole}
            onDeleteRole={onDeleteRole}
            onRenameMember={onRenameMember}
            onDeleteMember={onDeleteMember}
          />
          </div>
        )}

        <div className="schedule-right" ref={ganttScrollRef} onScroll={(e) => updateFirstVisibleCol(e.currentTarget.scrollLeft)}>
          {/* 只读模式（项目主页）筛选栏由父级共享筛选栏承担，这里仅编辑模式渲染 */}
          {!readOnly && (
          <div className="gantt-toolbar">
            <div className="gantt-quick-btns">
              {/* 任务层级筛选 */}
              <div className="gantt-filter-item" ref={levelDropdownRef}>
                <span className="gantt-filter-label">任务层级</span>
                <div className="gantt-filter-trigger" onClick={() => setLevelDropdownOpen(v => !v)}>
                  <span className="gantt-filter-value">{ganttLevelOptions.find(o => o.value === levelFilter)?.label || '全部任务'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
              </div>

              {/* 任务状态筛选 */}
              <div className="gantt-filter-item" ref={statusDropdownRef}>
                <span className="gantt-filter-label">任务状态</span>
                <div className="gantt-filter-trigger" onClick={() => setStatusDropdownOpen(v => !v)}>
                  <span className="gantt-filter-value">{EXEC_STATUS_FILTER_OPTIONS.find(o => o.value === execStatusFilter)?.label || '全部状态'}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
              </div>

              {/* 时间范围筛选 */}
              <div className="gantt-filter-item" ref={dateRangeRef}>
                <span className="gantt-filter-label">时间范围</span>
                <div className={"gantt-filter-trigger" + (dateRangeFilter ? " has-filter" : "")} onClick={() => setDateRangeOpen(v => !v)}>
                  <span className="gantt-filter-value">
                    {dateRangeFilter ? `${dateRangeFilter.start} ~ ${dateRangeFilter.end}` : '全部时间'}
                  </span>
                  <span className="gantt-filter-icon">
                    <span className="gantt-filter-clear" onClick={(e) => { e.stopPropagation(); setDateRangeFilter(null) }}>×</span>
                    <svg className="gantt-filter-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                  </span>
                </div>
              </div>

              {/* 团队成员筛选 */}
              <div className="gantt-filter-item member-filter-item" ref={memberMultiSelectRef}>
                <span className="gantt-filter-label">团队成员</span>
                <MemberMultiSelect
                  value={selectedMembers}
                  onChange={setSelectedMembers}
                  options={teamMembers || []}
                  placeholder="全部成员"
                  triggerRef={memberMultiSelectRef}
                />
              </div>
            </div>
            <div className="gantt-toolbar-right">
              {/* 一键排期：放在筛选行右侧 */}
              <button type="button" className="time-rule-btn project-cycle-btn" onClick={onOpenPeriodModal} title="按下方规则自动排期">
                一键排期
              </button>
            </div>
          </div>
          )}

          {/* 使用 Portal 渲染下拉框，避免被父元素裁剪 */}
          {!readOnly && levelDropdownOpen && createPortal(
            <div className="gantt-filter-dropdown" style={{
              position: 'fixed',
              top: levelDropdownRef.current ? levelDropdownRef.current.getBoundingClientRect().bottom + 4 : 0,
              left: levelDropdownRef.current ? levelDropdownRef.current.getBoundingClientRect().left : 0,
              zIndex: 10000
            }}>
              {ganttLevelOptions.map(opt => (
                <div key={opt.value} className={`gantt-filter-option ${levelFilter === opt.value ? 'selected' : ''}`}
                  onClick={() => { setLevelFilter(opt.value); setLevelDropdownOpen(false) }}>
                  <span>{opt.label}</span>
                  {levelFilter === opt.value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              ))}
            </div>,
            document.body
          )}

          {!readOnly && statusDropdownOpen && createPortal(
            <div className="gantt-filter-dropdown" style={{
              position: 'fixed',
              top: statusDropdownRef.current ? statusDropdownRef.current.getBoundingClientRect().bottom + 4 : 0,
              left: statusDropdownRef.current ? statusDropdownRef.current.getBoundingClientRect().left : 0,
              zIndex: 10000
            }}>
              {EXEC_STATUS_FILTER_OPTIONS.map(opt => (
                <div key={opt.value} className={`gantt-filter-option ${execStatusFilter === opt.value ? 'selected' : ''}`}
                  onClick={() => { setExecStatusFilter(opt.value); setStatusDropdownOpen(false) }}>
                  <span>{opt.label}</span>
                  {execStatusFilter === opt.value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              ))}
            </div>,
            document.body
          )}

          {!readOnly && dateRangeOpen && createPortal(
            <DateRangeCalendar
              startDate={dateRangeFilter?.start}
              endDate={dateRangeFilter?.end}
              taskStartDate={startDate}
              taskEndDate={endDate}
              position={dateRangeRef.current ? {
                top: dateRangeRef.current.getBoundingClientRect().bottom + 4,
                left: dateRangeRef.current.getBoundingClientRect().left
              } : { top: 0, left: 0 }}
              onSelect={(start, end) => {
                setDateRangeFilter({ start, end })
                setDateRangeOpen(false)
              }}
              onClear={() => {
                setDateRangeFilter(null)
                setDateRangeOpen(false)
              }}
            />,
            document.body
          )}
          <div className="gantt-header-row">
            <div className="gantt-header-left" style={{ width: taskColumnWidth, minWidth: taskColumnWidth }}>
              <div className="gantt-granularity-dropdown" ref={granularityDropdownRef}>
                <button
                  className="gantt-granularity-trigger"
                  onClick={() => setShowGranularityMenu(!showGranularityMenu)}
                >
                  {{ hour: '小时', day: '天', week: '周', month: '月' }[ganttGranularity]}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>
                {showGranularityMenu && (
                  <div className="gantt-granularity-menu">
                    {[{ value: 'hour', label: '小时' }, { value: 'day', label: '天' }, { value: 'week', label: '周' }, { value: 'month', label: '月' }].map(opt => (
                      <div
                        key={opt.value}
                        className={`gantt-granularity-option ${ganttGranularity === opt.value ? 'active' : ''}`}
                        onClick={() => { setGanttGranularity(opt.value); setShowGranularityMenu(false) }}
                      >
                        {opt.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {dateRange.length > 0 && (
                <div className="gantt-date-label">
                  {(() => {
                    const labelIdx = Math.min(firstVisibleCol, dateRange.length - 1)
                    const firstDate = new Date(dateRange[labelIdx])
                    if (ganttGranularity === 'month') return `${firstDate.getFullYear()}年`
                    return `${firstDate.getFullYear()}年${firstDate.getMonth() + 1}月`
                  })()}
                </div>
              )}
            </div>
            <div className="gantt-header-right">
              <div className="gantt-months-overlay">
                {ganttCoarseCells.map(cell => {
                  const inBarCols = hoveredBarSegments.some(seg => cell.start <= seg.end && seg.start <= cell.end)
                  return (
                    <div key={cell.key} className={`gantt-month-overlay-item ${cell.anchor ? 'year-anchor' : ''} ${inBarCols ? 'bar-hovered' : ''}`} style={{ width: cell.width, minWidth: cell.width }}>
                      {cell.content && <span className="gantt-month-tooltip">{cell.content}</span>}
                    </div>
                  )
                })}
              </div>
              <div className="gantt-header-dates">
                {ganttFineCells.map(cell => {
                  const inBarCols = hoveredBarSegments.some(seg => cell.start <= seg.end && seg.start <= cell.end)
                  const isTodayCell = todayIdx >= 0 && cell.start === todayIdx
                  if (cell.type === 'hours') {
                    return (
                      <div key={cell.key} className={`gantt-hour-day ${isTodayCell ? 'today' : ''} ${inBarCols ? 'bar-hovered' : ''}`} style={{ width: cell.width, minWidth: cell.width }}>
                        {cell.hours.map(h => (
                          <div key={h} className="gantt-hour-cell" style={{ width: GANTT_CELL }}>{h}</div>
                        ))}
                      </div>
                    )
                  }
                  if (cell.type === 'week') {
                    return (
                      <div key={cell.key} className={`gantt-week ${inBarCols ? 'bar-hovered' : ''}`} style={{ width: cell.width, minWidth: cell.width }}>
                        <span className="gantt-week-range">{cell.startText} - {cell.endText}</span>
                      </div>
                    )
                  }
                  if (cell.type === 'month') {
                    const cellCol = ganttGranuleIndex[cell.start]
                    return (
                      <div
                        key={cell.key}
                        className={`gantt-month ${inBarCols ? 'bar-hovered' : ''} ${hoveredCol >= 0 && hoveredCol === cellCol ? 'hovered-col' : ''}`}
                        style={{ width: cell.width, minWidth: cell.width }}
                        onMouseEnter={() => { setHoveredRow(-1); setHoveredCol(cellCol) }}
                        onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                      >
                        {cell.content}
                      </div>
                    )
                  }
                  return (
                    <div key={cell.key} className={`gantt-day ${isTodayCell ? 'today' : ''} ${inBarCols ? 'bar-hovered' : ''}`} style={{ width: cell.width, minWidth: cell.width }}>
                      {cell.content != null ? cell.content : ''}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="gantt-container">
            <div className="gantt-frozen-column" style={{ width: taskColumnWidth, minWidth: taskColumnWidth }}>
              {displayRows.map((row, idx) => {
                const { task } = row
                const isParent = row.hasChildren
                const isCollapsed = isParent && collapsedNodeIds.has(row.node.id)
                const isAssignedToSelectedMember = task && selectedMember && task.resources?.some(
                  r => r.name === selectedMember.name && r.role === selectedMember.role
                )
                const conflictInfo = task ? conflictInfoMap[task.id] : null
                return (
                  <div
                    key={idx}
                    className={`gantt-task-info ${hoveredRow === idx ? 'hovered' : ''} ${isAssignedToSelectedMember ? 'member-highlight' : ''} ${conflictInfo ? 'conflict' : ''} ${isParent ? 'gantt-group-info' : ''}`}
                    style={{ paddingLeft: (row.level - 1) * 24 }}
                    onMouseEnter={() => setHoveredRow(idx)}
                    onMouseLeave={() => setHoveredRow(-1)}
                  >
                    {isParent ? (
                      <button
                        type="button"
                        className="collapse-btn"
                        onClick={(e) => { e.stopPropagation(); toggleCollapseNode(row.node.id) }}
                        title={isCollapsed ? '展开' : '收起'}
                      >
                        {isCollapsed ? '▶' : '▼'}
                      </button>
                    ) : (
                      ['completed', 'delayed', 'in_progress'].includes(statusOfFn(row.node)) ? (
                        <ExecStatusDot status={statusOfFn(row.node)} />
                      ) : (
                        <span className="collapse-placeholder">•</span>
                      )
                    )}
                    <span className="task-code">{row.node.code}</span>
                    <div className="task-name-row">
                      <span
                        className={`task-name ${isParent ? 'gantt-group-name' : ''}`}
                        style={{
                          ...(statusOfFn(row.node) === 'completed' ? { color: '#94a3b8' } : {}),
                          // 叶子走 handleBarClick；父任务：只读预览走外部回调，编辑模式打开本页父级详情弹窗
                          cursor: (task || isParent) ? 'pointer' : undefined
                        }}
                        onClick={(e) => {
                          if (task) { e.stopPropagation(); handleBarClick(task); return }
                          if (isParent) {
                            e.stopPropagation()
                            if (readOnly && onTaskBarPreview) {
                              if (suppressClickRef.current) return
                              onTaskBarPreview({ id: row.node.id })
                            } else {
                              openParentDetail(row.node)
                            }
                          }
                        }}
                      >
                        {row.node.name}
                      </span>
{conflictInfo && (
  <span className="conflict-badge">!
    <div className="conflict-popover">
      {conflictInfo.map((block, bi) => (
        <div key={bi} className="conflict-popover-block">
          <div className="conflict-popover-head">成员【{block.member}】在当前时段还参与以下任务：</div>
          <div className="conflict-popover-tasks">
            {block.tasks.map(t => (
              <div key={t} className="conflict-popover-task">{t}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </span>
)}
                    </div>
                  </div>
                )
              })}
              <div className="gantt-frozen-resizer" onMouseDown={handleTaskColumnResize} />
            </div>
            <div className="gantt-scroll-wrapper">
              <div className="gantt-scroll-area">
                <div className={`gantt-body gantt-body-${ganttGranularity}`}>
                {displayRows.map((row, idx) => {
                  const { task } = row
                  const isParent = row.hasChildren
                  const isMilestone = task && task.taskType === '里程碑'
                  const startBar = row.startBar
                  const endBar = row.endBar
                  const hasBar = startBar != null && endBar != null && (isMilestone ? endBar >= startBar : endBar > startBar)
                  const barLeft = hasBar ? posToPx(startBar) : 0
                  const barWidth = hasBar ? Math.max(0, posToPx(endBar) - posToPx(startBar)) : 0
                  const holidayIndices = []
                  if (skipHolidays && hasBar) {
                    const sIdx = Math.floor(startBar)
                    const eIdx = Math.floor(endBar)
                    for (let i = sIdx; i < eIdx; i++) {
                      if (i >= 0 && i < dateRange.length && isHoliday(dateRange[i])) holidayIndices.push(i)
                    }
                  }

                  const leadingDays = (ganttGranularity === 'month' && skipHolidays && monthEdgePad.before > 0)
                    ? Math.round(monthEdgePad.before / ganttPxPerDay)
                    : 0
                  const trailingDays = ((ganttGranularity === 'week' || ganttGranularity === 'month') && skipHolidays && monthEdgePad.after > 0)
                    ? Math.round(monthEdgePad.after / ganttPxPerDay)
                    : 0
                  const lastGranule = dateRange.length ? ganttGranuleIndex[dateRange.length - 1] : -1

                  const isAssignedToSelectedMember = task && selectedMember && task.resources?.some(
                    r => r.name === selectedMember.name && r.role === selectedMember.role
                  )

                  return (
                    <div key={idx} className={`gantt-row ${hoveredRow === idx ? 'hovered' : ''} ${isAssignedToSelectedMember ? 'member-highlight' : ''} ${isParent ? 'gantt-group-row' : ''}`}>
                      <div className="gantt-bars">
                        {/* 「今天」时间线：橙色虚线贯穿整行 */}
                        {todayMarkerLeft != null && (
                          <div className="gantt-today-line" style={{ left: todayMarkerLeft }} title="今天" />
                        )}
                        {leadingDays > 0 ? (
                          Array.from({ length: leadingDays }, (_, k) => {
                            const leadingDate = new Date(dateRange[0])
                            leadingDate.setDate(leadingDate.getDate() - leadingDays + k)
                            const isLeadingHoliday = isHoliday(leadingDate)
                            return (
                              <div
                                key={`lead-${k}`}
                                className={`gantt-cell ${isLeadingHoliday ? 'holiday' : ''} ${hoveredRow === idx ? 'hovered-row' : ''} ${hoveredCol >= 0 && hoveredCol === ganttGranuleIndex[0] ? 'hovered-col' : ''}`}
                                style={{ width: ganttPxPerDay, minWidth: ganttPxPerDay }}
                                title={isLeadingHoliday ? '节假日' : ''}
                                onMouseEnter={() => { setHoveredRow(idx); if (dateRange.length) setHoveredCol(ganttGranuleIndex[0]) }}
                                onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                              />
                            )
                          })
                        ) : (
                        <div
                          className={`gantt-space-cell ${hoveredRow === idx ? 'hovered-row' : ''} ${hoveredCol >= 0 && hoveredCol === ganttGranuleIndex[0] ? 'hovered-col' : ''}`}
                          style={{ width: monthEdgePad.before, minWidth: monthEdgePad.before }}
                          onMouseEnter={() => { setHoveredRow(idx); if (dateRange.length) setHoveredCol(ganttGranuleIndex[0]) }}
                          onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                        />
                        )}
                        {dateRange.map((date, dateIdx) => {
                          const isDateHoliday = skipHolidays && isHoliday(date)
                          const inBarCols = (hoveredSummaryRange && dateIdx >= hoveredSummaryRange.start && dateIdx <= hoveredSummaryRange.end) || hoveredBarSegments.some(seg => dateIdx >= seg.start && dateIdx <= seg.end)
                          const isMonthEnd = ganttGranularity === 'month' && (
                            (dateIdx < dateRange.length - 1 && ganttGranuleIndex[dateIdx + 1] !== ganttGranuleIndex[dateIdx]) ||
                            (dateIdx === dateRange.length - 1 && monthEdgePad.after <= 0)
                          )
                          const isWeekEnd = ganttGranularity === 'week' && (
                            (dateIdx < dateRange.length - 1 && ganttGranuleIndex[dateIdx + 1] !== ganttGranuleIndex[dateIdx]) ||
                            (dateIdx === dateRange.length - 1 && monthEdgePad.after <= 0)
                          )
                          return (
                            <div
                              key={dateIdx}
                              className={`gantt-cell ${isDateHoliday ? 'holiday' : ''} ${isMonthEnd ? 'month-end' : ''} ${isWeekEnd ? 'week-end' : ''} ${hoveredCol >= 0 && ganttGranuleIndex[dateIdx] === hoveredCol ? 'hovered-col' : ''} ${hoveredRow === idx ? 'hovered-row' : ''} ${inBarCols ? 'hovered-col' : ''}`}
                              style={{ width: ganttPxPerDay, minWidth: ganttPxPerDay }}
                              title={isDateHoliday ? '节假日' : ''}
                              onMouseEnter={() => { setHoveredRow(idx); setHoveredCol(ganttGranuleIndex[dateIdx]) }}
                              onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                            />
                          )
                        })}
                        {trailingDays > 0 ? (
                          Array.from({ length: trailingDays }, (_, k) => {
                            const trailingDate = new Date(dateRange[dateRange.length - 1])
                            trailingDate.setDate(trailingDate.getDate() + k + 1)
                            const isTrailingHoliday = isHoliday(trailingDate)
                            return (
                              <div
                                key={`trail-${k}`}
                                className={`gantt-cell ${isTrailingHoliday ? 'holiday' : ''} ${k === trailingDays - 1 ? (ganttGranularity === 'week' ? 'week-end' : 'month-end') : ''} ${hoveredRow === idx ? 'hovered-row' : ''} ${hoveredCol >= 0 && hoveredCol === lastGranule ? 'hovered-col' : ''}`}
                                style={{ width: ganttPxPerDay, minWidth: ganttPxPerDay }}
                                title={isTrailingHoliday ? '节假日' : ''}
                                onMouseEnter={() => { setHoveredRow(idx); if (dateRange.length) setHoveredCol(lastGranule) }}
                                onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                              />
                            )
                          })
                        ) : (
                        <div
                          className={`gantt-space-cell ${ganttGranularity === 'month' && monthEdgePad.after > 0 ? 'month-end-pad' : ''} ${ganttGranularity === 'week' && monthEdgePad.after > 0 ? 'week-end-pad' : ''} ${hoveredRow === idx ? 'hovered-row' : ''} ${hoveredCol >= 0 && hoveredCol === ganttGranuleIndex[dateRange.length - 1] ? 'hovered-col' : ''}`}
                          style={{ width: monthEdgePad.after, minWidth: monthEdgePad.after }}
                          onMouseEnter={() => { setHoveredRow(idx); if (dateRange.length) setHoveredCol(ganttGranuleIndex[dateRange.length - 1]) }}
                          onMouseLeave={() => { setHoveredRow(-1); setHoveredCol(-1) }}
                        />
                        )}
                        {hasBar && isParent && (() => {
                          const children = row.node.children || []
                          const parentProgress = progressOfFn(row.node)
                          const firstChildTask = children.length > 0 ? scheduleMap.get(children[0].id) : null
                          const ci = firstChildTask ? firstChildTask.colorIndex : 0
                          const c = themeColors[ci]
                          const sumHours = (n) => {
                            if (!n.children || n.children.length === 0) {
                              const t = scheduleMap.get(n.id)
                              return t ? (t.totalHours || 0) : 0
                            }
                            return n.children.reduce((s, ch) => s + sumHours(ch), 0)
                          }
                          const totalH = sumHours(row.node)
                          const durDays = Math.ceil(endBar - startBar)
                          const summaryInteractive = (readOnly && onTaskBarPreview) || !readOnly
                          const handleSummaryClick = (e) => {
                            if (suppressClickRef.current) return
                            if (readOnly && onTaskBarPreview) { onTaskBarPreview({ id: row.node.id }); return }
                            openParentDetail(row.node)
                          }
                          return (
                            <>
                            <div
                              className="gantt-summary-bar"
                              style={{
                                left: barLeft,
                                width: Math.max(12, barWidth),
                                '--sb-color-s': c.solid + '80',
                                '--sb-color-m': c.solid + '28',
                                '--sb-color-l': c.solid + '14',
                                // CSS 默认 pointer-events:none（不挡单元格 hover），可点击时需恢复以接收点击
                                pointerEvents: summaryInteractive ? 'auto' : undefined,
                                cursor: summaryInteractive ? 'pointer' : undefined,
                              }}
                              title={summaryInteractive ? `${row.node.name}: 查看任务详情` : undefined}
                              onClick={summaryInteractive ? handleSummaryClick : undefined}
                              onMouseEnter={summaryInteractive ? (e) => {
                                setHoveredRow(idx)
                                const barsEl = e.currentTarget?.parentElement
                                if (barsEl) {
                                  const px = e.clientX - barsEl.getBoundingClientRect().left
                                  const pos = pxToPos(px)
                                  const di = Math.max(0, Math.min(dateRange.length - 1, Math.floor(pos)))
                                  setHoveredCol(ganttGranuleIndex[di])
                                }
                                setHoveredSummaryRange({ start: startBar, end: endBar })
                              } : undefined}
                              onMouseLeave={summaryInteractive ? () => { handleBarMouseLeave(); setHoveredSummaryRange(null) } : undefined}
                            >
                              {parentProgress > 0 && (
                                <div
                                  style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, parentProgress)}%`, background: c.solid + '80', borderRadius: 'inherit', pointerEvents: 'none' }}
                                  title={`完成进度：${parentProgress}%`}
                                />
                              )}
                              {EXEC_STATUS[statusOfFn(row.node)] === EXEC_STATUS.completed && (
                                <span
                                  style={{ position: 'absolute', left: '4px', top: '50%', transform: 'translateY(-50%)', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, boxShadow: '0 1px 2px rgba(0,0,0,0.18)', pointerEvents: 'none' }}
                                  title="已完成"
                                >
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={c.solid} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                </span>
                              )}
                              <span className="gantt-summary-label" style={{ color: c.solid }}>
                                {totalH > 0 && <span>{totalH}h</span>}
                                {totalH > 0 && durDays > 0 && <span style={{ margin: '0 3px' }}>/</span>}
                                {durDays > 0 && <span>{durDays}天</span>}
                              </span>
                            </div>
                            <svg
                              style={{ position: 'absolute', left: barLeft, top: '50%', marginTop: -8, pointerEvents: 'none', overflow: 'visible' }}
                              width={Math.max(12, barWidth)}
                              height="16"
                            >
                              <polygon
                                points={`0,16 8,0 0,0`}
                                fill={c.solid + '60'}
                              />
                              <polygon
                                points={`${Math.max(12, barWidth)},16 ${Math.max(12, barWidth) - 8},0 ${Math.max(12, barWidth)},0`}
                                fill={c.solid + '60'}
                              />
                            </svg>
                            </>
                          )
                        })()}
                        {hasBar && !isParent && (() => {
                          const colors = themeColors[task.colorIndex]
                          const isSelected = selectedTask?.id === task.id
                          const isFollowing = task.taskType === '跟进'
                          const isMilestone = task.taskType === '里程碑'
                          const leafStatusMeta = EXEC_STATUS[statusOfFn(row.node || task)]
                          const leafProgress = Math.min(100, progressOfFn(row.node || task))

                          if (isMilestone) {
                            const diamondLeft = (task.id === draggingTaskId && dragPreview) ? posToPx(dragPreview.target) - 7 : barLeft - 7
                            return (
                              <div
                                className={`gantt-milestone-diamond ${isSelected ? 'selected' : ''}`}
                                style={{
                                  position: 'absolute',
                                  left: diamondLeft,
                                  top: '50%',
                                  transform: 'translateY(-50%) rotate(45deg)',
                                  width: '14px',
                                  height: '14px',
                                  // 已延误里程碑用红色警示，其余保持琥珀色
                                  background: leafStatusMeta === EXEC_STATUS.delayed ? '#DC2626' : '#F59E0B',
                                  cursor: 'pointer',
                                  zIndex: isSelected ? 10 : 5,
                                }}
                                title={`${task.name}: 里程碑${leafStatusMeta ? ' · 任务状态：' + leafStatusMeta.label : ''}`}
                                onClick={(e) => { if (suppressClickRef.current) return; handleBarClick(task) }}
                                onMouseDown={(e) => handleBarMouseDown(e, task)}
                                onContextMenu={(e) => handleBarRightClick(e, task)}
                                onMouseEnter={(e) => handleBarMouseEnter(e, idx, task)}
                                onMouseLeave={() => handleBarMouseLeave()}
                              />
                            )
                          }

                          let barStyle = {}
                          // 甘特条即进度条：配色与日历视图统一——底色=主题 light 色，完成段=主题色 70% 透明度（略浅于纯色）
                          // 叶子任务条不显示边框
                          // 已完成任务条使用深色（主题纯色）背景；已延误任务条用红底红边警示
                          barStyle = leafStatusMeta === EXEC_STATUS.completed
                            ? { background: colors.solid, border: 'none' }
                            : leafStatusMeta === EXEC_STATUS.delayed
                              ? { background: '#FEE2E2', border: '1px solid #DC2626' }
                              : { background: colors.light, border: 'none' }
                          const leafFillColor = colors.solid + 'B3'
                          if (isSelected) {
                            barStyle.boxShadow = `0 0 0 2px ${colors.solid}40`
                          }
                          return (
                            <div
                              className={`gantt-task-bar ${isFollowing ? 'wave-bar' : ''} ${isSelected ? 'selected' : ''} ${conflictInfoMap[task.id] ? 'conflict' : ''} ${task.id === draggingTaskId ? 'dragging' : ''}`}
                              style={{
                                left: (task.id === draggingTaskId && dragPreview) ? posToPx(dragPreview.target) : barLeft,
                                width: Math.max(4, barWidth),
                                ...barStyle,
                              }}
                              title={`${task.name}: 第${task.startDay + 1}天 - 第${task.endDay + 1}天${leafStatusMeta ? ' · 任务状态：' + leafStatusMeta.label : ''}${leafProgress > 0 ? ' · 完成进度：' + leafProgress + '%' : ''}`}
                              onClick={(e) => { if (suppressClickRef.current) return; handleBarClick(task) }}
                              onMouseDown={(e) => handleBarMouseDown(e, task)}
                              onContextMenu={(e) => handleBarRightClick(e, task)}
                              onMouseEnter={(e) => handleBarMouseEnter(e, idx, task)}
                              onMouseLeave={() => handleBarMouseLeave()}
                            >
                              {leafProgress > 0 && (
                                <div
                                  style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${leafProgress}%`, background: leafFillColor, borderRadius: 'inherit', pointerEvents: 'none', zIndex: 0 }}
                                  title={`完成进度：${leafProgress}%`}
                                />
                              )}
                              {leafStatusMeta === EXEC_STATUS.completed && (
                                <span
                                  style={{ position: 'absolute', left: '4px', top: '50%', transform: 'translateY(-50%)', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, boxShadow: '0 1px 2px rgba(0,0,0,0.18)', pointerEvents: 'none' }}
                                  title="已完成"
                                >
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={colors.solid} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                                </span>
                              )}
                              {(() => {
                                // 合并连续节假日（如周六+周日）为一段渲染，避免相邻段取整后留下露出任务颜色的细缝
                                const holRuns = []
                                holidayIndices.forEach(hi => {
                                  const last = holRuns[holRuns.length - 1]
                                  if (last && last.end === hi - 1) last.end = hi
                                  else holRuns.push({ start: hi, end: hi })
                                })
                                return holRuns.map((r, k) => (
                                  <div
                                    key={`hol-${k}`}
                                    className="gantt-bar-holiday-seg"
                                    style={{
                                      left: (r.start - startBar) * ganttPxPerDay,
                                      width: (r.end + 1 - r.start) * ganttPxPerDay
                                    }}
                                  />
                                ))
                              })()}
                              {isFollowing && (
                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 14, pointerEvents: 'none' }}>
                                  <svg width="100%" height="14" preserveAspectRatio="none" viewBox="0 0 30 14" style={{ display: 'block' }}>
                                    <defs>
                                      <linearGradient id={`wg-${task.id}`} x1="0" y1="1" x2="0" y2="0">
                                        <stop offset="0" stopColor={colors.solid} />
                                        <stop offset="1" stopColor={colors.solid} stopOpacity="0" />
                                      </linearGradient>
                                    </defs>
                                    <path d="M0 9 C7.5 9 7.5 5 15 5 C22.5 5 22.5 9 30 9 L30 14 L0 14 Z" fill={`url(#wg-${task.id})`} />
                                  </svg>
                                </div>
                              )}
                                  {task.totalHours > 0 && (
                                    <span className="gantt-bar-hours" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: '10px', fontWeight: 600, color: colors.solid, textShadow: '0 0 3px rgba(255,255,255,0.95), 0 0 2px rgba(255,255,255,0.95)', whiteSpace: 'nowrap', zIndex: 1 }}>
                                  {formatHoursByUnit(task.totalHours, timeRuleUnit)}
                                </span>
                              )}
                            </div>
                          )
                        })()}
                    </div>
                    </div>
                  )
                })}
              </div>
              {(dragActive && dragPreview && dragPreview.showGuide) && (
                <div className="gantt-drag-guide" style={{ left: posToPx(dragPreview.limit) }}>
                  <span className="gantt-drag-guide-label">前置结尾</span>
                </div>
              )}
              {ganttShowLinks && (() => {
                const lines = []
                displayRows.forEach((row, rowIdx) => {
                  const t = row.task
                  const tNode = row.node
                  const predecessors = (tNode && tNode.predecessors) || (t && t.predecessors) || []
                  if (predecessors.length === 0) return
                  predecessors.forEach(predId => {
                    const predIdx = rowIndexById.get(predId)
                    if (predIdx == null) return
                    const predRow = displayRows[predIdx]
                    const predTask = predRow.task
                    const predNode = predRow.node
                    if (!predTask && predRow.endBar == null) return
                    let predEndX, predY, isPredMilestone = false
                    if (predTask) {
                      isPredMilestone = predTask.taskType === '里程碑'
                      predEndX = isPredMilestone
                        ? posToPx(predTask.startPos != null ? predTask.startPos : (predTask.startDay ?? 0))
                        : posToPx(predTask.endPos != null ? predTask.endPos : predTask.endDay + 1)
                      predY = isPredMilestone
                        ? predIdx * ROW_HEIGHT + 18 + 7
                        : predIdx * ROW_HEIGHT + 18
                    } else if (predRow.endBar != null) {
                      predEndX = posToPx(predRow.endBar)
                      predY = predIdx * ROW_HEIGHT + 18
                    } else {
                      return
                    }
                    const succTask = t
                    const succNode = tNode
                    let succStartX, succY, isSuccMilestone = false
                    if (succTask) {
                      isSuccMilestone = succTask.taskType === '里程碑'
                      succStartX = isSuccMilestone
                        ? posToPx(succTask.startPos != null ? succTask.startPos : (succTask.startDay ?? 0)) - 7
                        : posToPx(succTask.startPos != null ? succTask.startPos : succTask.startDay) + 4
                    } else if (succNode && row.startBar != null) {
                      succStartX = posToPx(row.startBar) + 4
                    } else {
                      return
                    }
                    const isBackward = predIdx > rowIdx
                    succY = isBackward
                      ? rowIdx * ROW_HEIGHT + ROW_HEIGHT - 8
                      : rowIdx * ROW_HEIGHT + 8
                    const succId = (succTask && succTask.id) || (succNode && succNode.id) || ''
                    lines.push({ predEndX, predY, succStartX, succY, key: `${predId}->${succId}`, predId, succId, isBackward, isPredMilestone })
                  })
                })
                if (lines.length === 0) return null
                const predGroups = {}
                lines.forEach((line, idx) => {
                  if (!predGroups[line.predId]) predGroups[line.predId] = []
                  predGroups[line.predId].push(idx)
                })
                const succGroups = {}
                lines.forEach((line, idx) => {
                  if (!succGroups[line.succId]) succGroups[line.succId] = []
                  succGroups[line.succId].push(idx)
                })
                const maxX = Math.max(...lines.map(l => Math.max(l.predEndX, l.succStartX))) + 20
                const maxY = displayRows.length * ROW_HEIGHT
                return (
                  <svg
                    style={{ position: 'absolute', top: 0, left: 0, width: maxX, height: maxY, pointerEvents: 'none', zIndex: 2 }}
                  >
                    {lines.map((line, idx) => {
                      const SHIFT = 6
                      const landingX = Math.max(line.succStartX + SHIFT, line.predEndX)
                      const size = 7
                      const halfW = 3.5
                      const isCritical = criticalEdgeKeys.has(line.key)
                      // 关键路径：紫色实线；非关键路径：灰色虚线。两者粗细一致（仅颜色与虚实不同）
                      const strokeColor = isCritical ? '#8B5CF6' : '#94A3B8'
                      const strokeW = 1
                      const dashArray = isCritical ? 'none' : '4,3'
                      const pGroupSize = (predGroups[line.predId] || []).length
                      const pIdx = (predGroups[line.predId] || []).indexOf(idx)
                      const pSegXOffset = pGroupSize > 1 ? (pIdx - (pGroupSize - 1) / 2) * 5 : 0
                      const sGroupSize = (succGroups[line.succId] || []).length
                      const sIdx = (succGroups[line.succId] || []).indexOf(idx)
                      const sSegXOffset = sGroupSize > 1 ? (sIdx - (sGroupSize - 1) / 2) * 5 : 0
                      const segX = line.isPredMilestone && Math.abs(line.predEndX - landingX) < 12
                        ? line.predEndX + pSegXOffset + sSegXOffset
                        : landingX + pSegXOffset + sSegXOffset
                      const arrowDown = !line.isBackward
                      const arrowPoints = arrowDown
                        ? `${segX},${line.succY} ${segX + halfW},${line.succY - size} ${segX - halfW},${line.succY - size}`
                        : `${segX},${line.succY} ${segX + halfW},${line.succY + size} ${segX - halfW},${line.succY + size}`
                      const isStraight = Math.abs(line.predEndX - segX) < 2
                      return (
                        <g key={line.key}>
                          <path
                            d={isStraight
                              ? `M ${line.predEndX} ${line.predY} L ${line.predEndX} ${line.succY}`
                              : `M ${line.predEndX} ${line.predY} L ${segX} ${line.predY} L ${segX} ${line.succY}`
                            }
                            stroke={strokeColor}
                            strokeWidth={strokeW}
                            strokeDasharray={dashArray}
                            fill="none"
                          />
                          <polygon
                            points={arrowPoints}
                            fill={strokeColor}
                          />
                        </g>
                      )
                    })}
                  </svg>
                )
              })()}
              </div>
            </div>
          </div>
        </div>

        {!readOnly && contextMenu && (
          <div className="gantt-context-menu" ref={contextMenuRef} style={{ left: contextMenu.x, top: contextMenu.y }}>
            <div className="context-menu-item" onClick={() => handleContextMenuAction('assign')}>
              指派参与人
            </div>
            <div className="context-menu-item" onClick={() => handleContextMenuAction('advance')}>
              <span className="context-menu-label">提前</span>
              <DayStepper value={advanceDays} onChange={setAdvanceDays} />
              <span className="context-menu-unit">天</span>
            </div>
            <div className="context-menu-item" onClick={() => handleContextMenuAction('delay')}>
              <span className="context-menu-label">延后</span>
              <DayStepper value={delayDays} onChange={setDelayDays} />
              <span className="context-menu-unit">天</span>
            </div>
          </div>
        )}

        {showResourceModal && (
          <ResourceEditModal
            task={selectedTask}
            teamMembers={teamMembers}
            onSave={handleSaveResources}
            onCancel={handleCloseResourceModal}
          />
        )}

        {showDetailPopup && (selectedTask || parentDetailTask) && (() => {
          const popupTask = selectedTask || parentDetailTask
          // 编辑回调按展示任务 taskId 定位（下钻叶子子任务同样可编辑）；完成锁定由弹窗内按展示任务自行判断
          const editAllowed = !readOnly
          // 与 WBS 弹窗同能力：祖先链（路径行）+ 父节点（返回上一级，切到父任务详情）
          const popupPath = findTaskPath(currentTreeData, popupTask.id) || []
          const popupParent = findTaskParent(currentTreeData, popupTask.id)
          return (
          <TaskDetailPopup
            task={{
              ...popupTask,
              ancestors: popupPath,
              start_hour: popupTask.startPos != null ? Math.round((popupTask.startPos - popupTask.startDay) * dailyInputHours * 100) / 100 : popupTask.start_hour,
              end_hour: popupTask.endPos != null ? Math.round((popupTask.endPos - popupTask.endDay) * dailyInputHours * 100) / 100 : popupTask.end_hour,
            }}
            scheduleStartDate={dateRange[popupTask.startDay]}
            scheduleEndDate={dateRange[popupTask.endDay]}
            onBackToParent={popupParent ? () => openParentDetail(popupParent) : null}
            execStatus={statusOfFn(popupTask) || undefined}
            onClose={() => { setShowDetailPopup(false); setParentDetailTask(null) }}
            teamMembers={teamMembers}
            timeRuleUnit={timeRuleUnit}
            timeRuleValue={timeRuleValue}
            scheduleDateMap={scheduleDateMapLive}
            preferScheduleDates={true}
            onResourceMemberChange={editAllowed ? handleResourceMemberChange : null}
            onResourceHoursChange={editAllowed ? handleResourceHoursChange : null}
            onResourceDelete={editAllowed ? handleDeleteTaskResource : null}
            onAddResource={editAllowed ? handleAddTaskResource : null}
            dailyInputHours={dailyInputHours}
            skipHolidays={skipHolidays}
            minStartDate={computeMinStartDate}
            onUpdateDuration={editAllowed ? handleUpdateTaskDuration : null}
            onAutoCalcDuration={editAllowed ? handleAutoCalcDuration : null}
            onUpdateDates={editAllowed ? handleUpdateTaskDates : null}
            onUpdateDeliverables={editAllowed ? handleUpdateTaskDeliverables : null}
            onUpdateDescription={editAllowed ? handleUpdateTaskDescription : null}
            deliverablesCatalog={mergedDeliverablesCatalog}
            onAddDeliverableToCatalog={editAllowed ? handleAddDeliverableToCatalog : null}
            onUpdateHours={editAllowed ? handleUpdateTaskHours : null}
            onUpdateSkipHolidays={editAllowed ? handleUpdateTaskSkipHolidays : null}
          />
          )
        })()}

        {tooltipInfo && (
          <div
            className="gantt-quick-tip"
            style={{ left: tooltipInfo.x, top: tooltipInfo.y, transform: 'translateX(-50%)' }}
          >{tooltipInfo.text}</div>
        )}

      </div>
    </div>
  )
}

export default ProjectSchedule