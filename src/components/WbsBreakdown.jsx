import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useSearchParams } from 'react-router-dom'
import ResourceEditModal from './ResourceEditModal'
import TaskDetailPopup from './TaskDetailPopup'
import PredecessorEditPopup from './PredecessorEditPopup'
import PlanningHeaderStats from './PlanningHeaderStats'
import MemberList from './MemberList'
import HoursEditPopup, { formatHoursByUnit } from './HoursEditPopup'
import CustomSelect from './CustomSelect'
import { getTasksByProject, createTask, updateTask, deleteTask, updateRecord, generateULID, getProjectById, getTaskResourcesByTask, createTaskResource, updateTaskResource, deleteTaskResourcesByTask, getLatestVersion, getProjectWbsTreeByVersion, upsertTaskContent } from '../utils/db'
import { calcCustomDurationExceeded, computeEndFromDuration, autoDurationDaysOf, calcGroupDurationDays as calcGroupDurationDaysUtil, findTaskPath, findTaskParent } from '../utils/schedule'
import { planContentEqual } from '../utils/planCompare'

const initialWbsData = [
  {
    id: 'node-1',
    code: '1',
    name: '项目启动',
    duration: '16h 0min',
    resources: [],
    status: 'completed',
    collapsed: false,
    predecessors: [],
    children: [
      {
        id: 'node-2',
        code: '1.1',
        name: '需求收集',
        duration: '8h 0min',
        resources: [
          { role: '项目经理', name: '张三', avatar: 'Z', hours: 8 }
        ],
        status: 'completed',
        collapsed: false,
        predecessors: [],
        children: []
      },
      {
        id: 'node-3',
        code: '1.2',
        name: '项目规划',
        duration: '8h 0min',
        resources: [
          { role: '前端开发', name: '李四', avatar: 'L', hours: 8 }
        ],
        status: 'completed',
        collapsed: false,
        predecessors: ['node-2'],
        children: []
      }
    ]
  },
  {
    id: 'node-4',
    code: '2',
    name: '系统设计',
    duration: '40h 0min',
    resources: [],
    status: 'completed',
    collapsed: false,
    predecessors: [],
    children: [
      {
        id: 'node-5',
        code: '2.1',
        name: '架构设计',
        duration: '16h 0min',
        resources: [
          { role: '后端开发', name: '王五', avatar: 'W', hours: 16 }
        ],
        status: 'completed',
        collapsed: false,
        predecessors: ['node-3'],
        children: []
      },
      {
        id: 'node-6',
        code: '2.2',
        name: '数据库设计',
        duration: '16h 0min',
        resources: [
          { role: '后端开发', name: '赵六', avatar: 'Z', hours: 16 }
        ],
        status: 'completed',
        collapsed: false,
        predecessors: ['node-5'],
        children: []
      },
      {
        id: 'node-7',
        code: '2.3',
        name: 'UI设计',
        duration: '8h 0min',
        resources: [
          { role: 'UI设计', name: '钱七', avatar: 'Q', hours: 8 }
        ],
        status: 'completed',
        collapsed: false,
        predecessors: ['node-6'],
        children: []
      }
    ]
  },
  {
    id: 'node-8',
    code: '3',
    name: '开发实现',
    duration: '80h 0min',
    resources: [],
    status: 'in-progress',
    collapsed: false,
    predecessors: [],
    children: [
      {
        id: 'node-9',
        code: '3.1',
        name: '前端开发',
        duration: '40h 0min',
        resources: [],
        status: 'in-progress',
        collapsed: false,
        predecessors: [],
        children: [
          {
            id: 'node-10',
            code: '3.1.1',
            name: '登录模块',
            duration: '8h 0min',
            resources: [
              { role: '前端开发', name: '张三', avatar: 'Z', hours: 8 }
            ],
            status: 'completed',
            collapsed: false,
            predecessors: ['node-7'],
            children: []
          },
          {
            id: 'node-11',
            code: '3.1.2',
            name: '首页开发',
            duration: '16h 0min',
            resources: [
              { role: '前端开发', name: '张三', avatar: 'Z', hours: 16 }
            ],
            status: 'in-progress',
            collapsed: false,
            predecessors: ['node-10'],
            children: []
          },
          {
            id: 'node-12',
            code: '3.1.3',
            name: '任务管理',
            duration: '16h 0min',
            resources: [
              { role: '前端开发', name: '李四', avatar: 'L', hours: 16 }
            ],
            status: 'pending',
            collapsed: false,
            predecessors: ['node-11'],
            children: []
          }
        ]
      },
      {
        id: 'node-13',
        code: '3.2',
        name: '后端开发',
        duration: '40h 0min',
        resources: [
          { role: '后端开发', name: '王五', avatar: 'W', hours: 40 }
        ],
        status: 'in-progress',
        collapsed: false,
        predecessors: ['node-11'],
        children: []
      }
    ]
  },
  {
    id: 'node-14',
    code: '4',
    name: '测试上线',
    duration: '24h 0min',
    resources: [],
    status: 'pending',
    collapsed: false,
    predecessors: ['node-13'],
    children: [
      {
        id: 'node-15',
        code: '4.1',
        name: '功能测试',
        duration: '16h 0min',
        resources: [
          { role: '测试工程师', name: '', avatar: '', hours: 8 },
          { role: '前端开发', name: '李四', avatar: 'L', hours: 8 }
        ],
        status: 'pending',
        collapsed: false,
        predecessors: [],
        children: []
      },
      {
        id: 'node-16',
        code: '4.2',
        name: '性能测试',
        duration: '8h 0min',
        resources: [
          { role: '测试工程师', name: '', avatar: '', hours: 8 }
        ],
        status: 'pending',
        collapsed: false,
        predecessors: ['node-15'],
        children: []
      }
    ]
  },
  {
    id: 'node-17',
    code: '5',
    name: '项目验收',
    duration: '16h 0min',
    resources: [
      { role: '项目经理', name: '张三', avatar: 'Z', hours: 8 },
      { role: '客户代表', name: '', avatar: '', hours: 8 }
    ],
    status: 'pending',
    collapsed: false,
    predecessors: ['node-16'],
    children: []
  }
]

// 判断任务是否「已完成」：以执行状态为准（statusOf 由 App 下发），回退到本地 task.status
function isTaskCompleted(node, statusOfFn) {
  if (!node) return false
  const s = statusOfFn ? statusOfFn(node) : (node.status || 'pending')
  return s === 'completed'
}

function WbsBreakdown({ onTreeDataChange, teamMembers, setTeamMembers, onShowTeamModal, onAddRole, onAddMember, onRenameRole, onDeleteRole, onRenameMember, onDeleteMember, initialData, appliedTree, predecessorsSyncRef, editGuardRef, dailyInputHours, setDailyInputHours, timeRuleUnit, setTimeRuleUnit, timeRuleValue, setTimeRuleValue, isMemberListExpanded, setIsMemberListExpanded, startDate, endDate, onOpenPeriodModal, onAiAssistant, statusOf, skipHolidays = false, scheduleDateMap = null }) {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const projectId = location.state?.projectId || searchParams.get('projectId')
  const [treeData, setTreeData] = useState([])
  const treeDataRef = useRef(treeData)
  
  // 保持 treeDataRef 同步
  useEffect(() => {
    treeDataRef.current = treeData
  }, [treeData])
  const [loading, setLoading] = useState(true)
  const [workspaceId, setWorkspaceId] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const inputRef = useRef(null)

  const getDefaultResources = () => {
    const namedMembers = (teamMembers || []).filter(m => m.name && m.name !== '待分配')
    if (namedMembers.length === 1) {
      return [{
        role: namedMembers[0].role,
        name: namedMembers[0].name,
        avatar: namedMembers[0].avatar,
        hours: 1
      }]
    }
    return []
  }

  // 项目设置加载（工时规则、交付物目录）：与任务树无关，进入页面即加载
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    ;(async () => {
      try {
        const project = await getProjectById(projectId)
        if (cancelled || !project) return
        setWorkspaceId(project.workspace_ulid)
        if (project.time_rule_unit) setTimeRuleUnit(project.time_rule_unit)
        if (project.time_rule_value != null) setTimeRuleValue(project.time_rule_value)
        if (project.daily_input_hours != null) setDailyInputHours(project.daily_input_hours)
        if (Array.isArray(project.deliverables_catalog)) {
          setProjectDeliverablesCatalog(project.deliverables_catalog)
        }
      } catch (error) {
        console.error('加载项目设置失败:', error)
      }
    })()
    return () => { cancelled = true }
  }, [projectId])

  // 任务树数据源：统一由 App 下发（App 负责草稿版本询问 / 发布计划回放）。
  // initialData == null 表示 App 种子加载尚未完成（可能正在询问是否加载草稿），保持 loading 等待；
  // initialData 为 [] 是 App 的明确决定（如用户拒绝加载草稿且无发布版），直接显示空树。
  useEffect(() => {
    console.log('useEffect triggered, projectId:', projectId, 'initialData:', initialData)

    if (!projectId) {
      console.log('No projectId, using initialData')
      setTreeData(initialData || initialWbsData)
      setLoading(false)
      return
    }

    if (initialData == null) {
      console.log('Waiting for App seed data (draft prompt may be pending)...')
      setLoading(true)
      return
    }

    console.log('Using App-provided tree (', (initialData || []).length, 'root nodes)')
    // 回环短路：App 下发的树与本地内容完全一致时不重置——
    // 保留本地引用身份，避免「重置 → 推送 → App 换引用 → 再重置」的无限循环。
    // 含内容层字段比对（true）：描述/可交付成果的差异不能被短路吞掉
    if (planContentEqual(treeData, initialData, true)) {
      setLoading(false)
      return
    }
    setTreeData(initialData)
    setLoading(false)
  }, [projectId, initialData])

  // AI 助理「应用到项目」：把生成的任务树直接写进正在渲染的 treeData，
  // 行为与手动添加一致（随后通过 onTreeDataChange 自动向上同步到 App）
  useEffect(() => {
    if (appliedTree && appliedTree.length > 0) {
      console.log('Applying AI WBS tree, root nodes:', appliedTree.length)
      setTreeData(appliedTree)
    }
  }, [appliedTree])

  // 重载任务树（成员变更后刷新资源）：按最新版本回放。
  // 注意：树数据源仍以 App 下发为准，这里仅用于成员资源变更后的本组件内刷新
  const reloadTree = async () => {
    if (!projectId) return
    try {
      const latestVersion = await getLatestVersion(projectId)
      if (!latestVersion) return
      const tree = await getProjectWbsTreeByVersion(latestVersion.version_ulid)
      setTreeData(tree || [])
    } catch (error) {
      console.error('重载任务树失败:', error)
    }
  }

  function buildTreeFromTasks(tasks, resources) {
    const taskMap = new Map()
    const rootTasks = []
    const resourcesByTask = new Map()

    resources.forEach(r => {
      if (!resourcesByTask.has(r.task_ulid)) {
        resourcesByTask.set(r.task_ulid, [])
      }
      resourcesByTask.get(r.task_ulid).push({
        task_resource_ulid: r.task_resource_ulid,
        role: r.role,
        name: r.name,
        avatar: r.avatar,
        hours: r.hours
      })
    })

    tasks.forEach(task => {
      const node = {
        id: task.task_ulid,
        task_ulid: task.task_ulid,
        original_task_id: task.original_task_id || task.task_ulid,
        code: task.code || '',
        name: task.name || '',
        duration: task.duration || '0h 0min',
        resources: resourcesByTask.get(task.task_ulid) || [],
        status: task.status || 'pending',
        collapsed: task.collapsed || false,
        predecessors: task.predecessors || [],
        start_date: task.start_date,
        end_date: task.end_date,
        hours: task.hours || 0,
        description: task.description || '',
        deliverables: task.deliverables || [],
        priority: task.priority || 'medium',
        customDurationDays: task.custom_duration_days != null ? task.custom_duration_days : undefined,
        taskType: task.task_type || null,
        start_hour: task.start_hour != null ? task.start_hour : null,
        end_hour: task.end_hour != null ? task.end_hour : null,
        skip_holidays: task.skip_holidays == null ? null : !!task.skip_holidays,
        children: []
      }
      taskMap.set(task.task_ulid, node)

      if (!task.parent_task_ulid) {
        rootTasks.push(node)
      }
    })

    tasks.forEach(task => {
      if (task.parent_task_ulid && taskMap.has(task.parent_task_ulid)) {
        const parent = taskMap.get(task.parent_task_ulid)
        const child = taskMap.get(task.task_ulid)
        if (child) {
          parent.children.push(child)
        }
      }
    })

    return rootTasks.length > 0 ? rootTasks : []
  }

  const handleAddFirstTask = async () => {
    if (!projectId) return

    const defaultResources = getDefaultResources()
    const ulid = generateULID()

    const newNode = {
      id: ulid,
      task_ulid: ulid,
      code: '1',
      name: '',
      duration: '0h 0min',
      resources: defaultResources,
      status: 'pending',
      collapsed: false,
      predecessors: [],
      start_date: null,
      end_date: null,
      hours: 0,
      children: []
    }

    setTreeData([newNode])
    setIsNewTask(true)
    setOriginalTaskName('')
    setTimeout(() => {
      setEditCell({ id: ulid, field: 'name' })
    }, 100)
  }

  const [connectingFrom, setConnectingFrom] = useState(null)
  const [hoursEditPopup, setHoursEditPopup] = useState(null)
  const [editingResource, setEditingResource] = useState(null)
  const [expandedResourceId, setExpandedResourceId] = useState(null)
  const [predecessorModal, setPredecessorModal] = useState(null)
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 })
  const predecessorPopupRef = useRef(null)

  // 前置任务弹窗定位：靠近屏幕底部时向上翻转，避免被视口裁剪导致无法选择
  useLayoutEffect(() => {
    if (!predecessorModal || !predecessorPopupRef.current) return
    const el = predecessorPopupRef.current
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let { x, y } = popupPosition
    // 下方空间不足则向上翻转（弹窗底部对齐触发行底部）
    if (y + rect.height > vh - 8) {
      const flipped = popupPosition.y - rect.height
      y = flipped < 8 ? 8 : flipped
    }
    // 水平方向也做边界收敛
    if (x + rect.width > vw - 8) {
      const clamped = vw - rect.width - 8
      x = clamped < 8 ? 8 : clamped
    }
    if (x !== popupPosition.x || y !== popupPosition.y) {
      setPopupPosition({ x, y })
    }
  }, [predecessorModal, popupPosition])
  const resourceSelectPopupRef = useRef(null)
  // 记录「+ 添加资源」按钮的原始位置：选择弹窗翻转后 popupPosition 已变，工时弹窗需贴按钮打开
  const resourceAddAnchorRef = useRef({ x: 0, y: 0 })

  // 资源选择下拉定位：靠近屏幕底部时向上翻转，避免被视口裁剪（最后一行任务点 + 号场景）
  useLayoutEffect(() => {
    if (!editingResource || !resourceSelectPopupRef.current) return
    const el = resourceSelectPopupRef.current
    const rect = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let { x, y } = popupPosition
    if (y + rect.height > vh - 8) {
      // 上方翻转：弹窗底部对齐 + 号按钮底部（补偿 margin-top 4px）
      const flipped = popupPosition.y - rect.height - 4
      y = flipped < 8 ? 8 : flipped
    }
    if (x + rect.width > vw - 8) {
      const clamped = vw - rect.width - 8
      x = clamped < 8 ? 8 : clamped
    }
    if (x !== popupPosition.x || y !== popupPosition.y) {
      setPopupPosition({ x, y })
    }
  }, [editingResource, popupPosition])
  const [durationEditTask, setDurationEditTask] = useState(null)
  const durationEditPopupRef = useRef(null)
  const [hoveredTaskId, setHoveredTaskId] = useState(null)
  const [connectingTo, setConnectingTo] = useState(null)
  // 成员任务数量/工时统计：直接从当前内存任务树聚合（口径与 getMemberStats 一致：
  // key=role-name / 待分配用 role，taskCount=去重任务数）。
  // AI 助理「应用到项目」的任务树只存在内存中、尚未落库，DB 聚合会永远为 0；
  // 内存聚合对已加载的发布版/草稿同样成立（树即 DB 行的镜像），且随每次编辑实时更新
  const memberStats = useMemo(() => {
    const stats = {}
    const walk = (nodes) => {
      for (const node of nodes || []) {
        for (const r of (node.resources || [])) {
          const key = r.name ? `${r.role || '未分组'}-${r.name}` : (r.role || '未分组')
          if (!stats[key]) stats[key] = { taskCount: 0, totalHours: 0, taskUids: new Set() }
          stats[key].totalHours += r.hours || 0
          stats[key].taskUids.add(node.task_ulid || node.id)
        }
        if (node.children && node.children.length > 0) walk(node.children)
      }
    }
    walk(treeData)
    Object.values(stats).forEach(s => { s.taskCount = s.taskUids.size; delete s.taskUids })
    return stats
  }, [treeData])
  // 统计已随树实时聚合，此函数保留为空操作以兼容历史调用点
  const reloadMemberStats = useCallback(() => {}, [])
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false)
  const [pendingDeleteItemId, setPendingDeleteItemId] = useState(null)
  const [pendingDeleteCount, setPendingDeleteCount] = useState(0)
  const [deliverablesPicker, setDeliverablesPicker] = useState(null)
  const [deliverablesSearch, setDeliverablesSearch] = useState('')
  const [projectDeliverablesCatalog, setProjectDeliverablesCatalog] = useState([])
  const deliverablesSearchRef = useRef(null)
  const deliverablesPickerRef = useRef(null)
  const [showDetailPopup, setShowDetailPopup] = useState(false)
  const [detailTaskId, setDetailTaskId] = useState(null)

  const persistDeliverablesCatalog = useCallback(async (catalog) => {
    if (!projectId) return
    try {
      const project = await getProjectById(projectId)
      if (project) {
        await updateRecord('projects', {
          ...project,
          deliverables_catalog: catalog
        })
      }
    } catch (error) {
      console.error('Failed to persist deliverables catalog:', error)
    }
  }, [projectId])

  const addDeliverableNameToCatalog = useCallback((name) => {
    const clean = (name || '').trim()
    if (!clean) return
    setProjectDeliverablesCatalog(prev => {
      if (prev.includes(clean)) return prev
      const next = [...prev, clean]
      persistDeliverablesCatalog(next)
      return next
    })
  }, [persistDeliverablesCatalog])

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

  const getMemberTasks = () => {
    // 任务树尚未下发（App 草稿确认弹窗等待中）时，统计传 null，
    // MemberList 显示省略号而非误导性的 0
    if (loading) {
      return teamMembers.map(member => ({ ...member, tasks: null, totalHours: null }))
    }
    return teamMembers.map(member => {
      const key = member.name ? `${member.role}-${member.name}` : member.role
      const stats = memberStats[key]
      return {
        ...member,
        tasks: stats ? new Array(stats.taskCount).fill(null) : [],
        totalHours: stats ? stats.totalHours : 0
      }
    })
  }

  const [editCell, setEditCell] = useState(null)
  const editCellRef = useRef(null)
  const [prevEditCell, setPrevEditCell] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  // 叶子任务转摘要时「前置关系改接」的用户提示（复用 member-list-toast 样式）
  const [rewireToast, setRewireToast] = useState('')
  const rewireToastTimerRef = useRef(null)
  const showRewireToast = (msg) => {
    setRewireToast(msg)
    if (rewireToastTimerRef.current) clearTimeout(rewireToastTimerRef.current)
    rewireToastTimerRef.current = setTimeout(() => setRewireToast(''), 4500)
  }
  // 方案二待改接上下文：Tab 给叶子任务添加第一个子任务（属性下放）时记录，
  // 等新子任务命名回车确认（handleFinishEdit）后才真正执行前置改接；
  // 命名为空取消创建时一并作废，不产生任何改接。
  const pendingRewireRef = useRef(null)
  const [isNewTask, setIsNewTask] = useState(false)
  const isNewTaskRef = useRef(false)
  useEffect(() => { isNewTaskRef.current = isNewTask }, [isNewTask])

  // 空名命名守卫：若正在命名且名称为空，提示「任务名称不能为空」并聚焦回输入框，返回 true 表示命中。
  // 用于点击其他任务/区域、切换视图（App 侧 stepper 守卫）等所有离开命名态的路径——保留空任务行不移除。
  const blockIfNamingEmpty = useCallback(() => {
    const cell = editCellRef.current
    if (!cell || cell.field !== 'name') return false
    const node = findNode(treeDataRef.current, cell.id)
    if (!node || node.name.trim()) return false
    setErrorMessage('任务名称不能为空')
    setTimeout(() => { document.querySelector('.wbs-edit-input')?.focus() }, 0)
    return true
  }, [])

  // 视图切换守卫：注册到 App，stepper/上一步/下一步导航前调用，命中时阻止切换
  useEffect(() => {
    if (!editGuardRef) return
    editGuardRef.current = blockIfNamingEmpty
    return () => { editGuardRef.current = null }
  }, [editGuardRef, blockIfNamingEmpty])
  const [originalTaskName, setOriginalTaskName] = useState('')
  const [draggedItem, setDraggedItem] = useState(null)
  const [dragOverItem, setDragOverItem] = useState(null)
  const [dragOverPosition, setDragOverPosition] = useState(null)
  const tableRef = useRef(null)
  const rowRefs = useRef({})

  useEffect(() => {
    editCellRef.current = editCell
  }, [editCell])

  // 树中是否存在未命名节点（正在命名的新建任务）
  const hasUnnamedNode = (nodes) => nodes.some(n => !(n.name || '').trim() || (n.children && hasUnnamedNode(n.children)))

  useEffect(() => {
    // loading 期间不推送：避免把初始空树推给 App，误触发 App 侧「已有数据」守卫、
    // 跳过草稿版本询问
    if (loading) return
    // 含未命名新建任务时不下发：防止空名任务经 wbsTreeData 泄漏到网络图/甘特图与草稿自动保存，
    // 也避免父任务「属性已下放、子任务还没命名」的中间态被持久化；命名确认（或取消）后恢复下发
    if (hasUnnamedNode(treeData)) return
    if (onTreeDataChange) {
      onTreeDataChange(treeData)
    }
  }, [treeData, onTreeDataChange, loading])

  const flattenTree = (nodes, level = 0, parentIds = []) => {
    let result = []
    for (const node of nodes) {
      result.push({ ...node, level, parentIds })
      if (!node.collapsed && node.children && node.children.length > 0) {
        result = result.concat(flattenTree(node.children, level + 1, [...parentIds, node.id]))
      }
    }
    return result
  }

  const getLeafNodes = (nodes) => {
    let leaves = []
    for (const node of nodes) {
      if (!node.children || node.children.length === 0) {
        leaves.push(node)
      }
      if (node.children) {
        leaves = leaves.concat(getLeafNodes(node.children))
      }
    }
    return leaves
  }

  const countDescendants = (node) => {
    if (!node.children || node.children.length === 0) return 0
    let count = node.children.length
    for (const child of node.children) {
      count += countDescendants(child)
    }
    return count
  }

  const collectDescendantIds = (node) => {
    let ids = []
    if (!node.children) return ids
    for (const child of node.children) {
      ids.push(child.id)
      ids = ids.concat(collectDescendantIds(child))
    }
    return ids
  }

  const parseDuration = (duration) => {
    if (!duration) return { hours: 0, minutes: 0 }
    
    const hoursMatch = duration.match(/(\d+)h/)
    const minutesMatch = duration.match(/(\d+)min/)
    
    return {
      hours: hoursMatch ? parseInt(hoursMatch[1]) : 0,
      minutes: minutesMatch ? parseInt(minutesMatch[1]) : 0
    }
  }

  const calculateMaxHours = (node) => {
    if (node.children && node.children.length > 0) {
      return Math.max(...node.children.map((child) => calculateMaxHours(child)))
    }
    return node.resources?.reduce((max, r) => Math.max(max, r.hours || 0), 0) || 0
  }

  const calcDefaultDurationDays = (node) => {
    const maxHours = calculateMaxHours(node)
    if (maxHours > 0 && dailyInputHours > 0) {
      return Math.ceil(maxHours / dailyInputHours)
    }
    return 0
  }

  const calcEffectiveDurationDays = (node) => {
    if (node.customDurationDays !== undefined) {
      return node.customDurationDays
    }
    if (node.children && node.children.length > 0) {
      return Math.max(0, ...node.children.map((child) => calcEffectiveDurationDays(child)))
    }
    return calcDefaultDurationDays(node)
  }

  // 群组任务工期：与共享工具同口径（子叶子按前驱依赖链排布，取最大结束天数）
  const calcGroupDurationDays = (node) => calcGroupDurationDaysUtil(node, dailyInputHours)

  const formatDuration = (duration) => {
    const { hours, minutes } = parseDuration(duration)
    
    if (hours === 0 && minutes === 0) {
      return '0'
    } else if (hours === 0) {
      return `${minutes}min`
    } else if (minutes === 0) {
      return `${hours}h`
    } else {
      return `${hours}h ${minutes}min`
    }
  }

  const getIdToCodeMap = (nodes) => {
    const map = {}
    const buildMap = (nodes) => {
      for (const node of nodes) {
        map[node.id] = node.code
        if (node.children) {
          buildMap(node.children)
        }
      }
    }
    buildMap(nodes)
    return map
  }

  const getAllTasksInfo = (nodes) => {
    const map = {}
    const buildMap = (nodes) => {
      for (const node of nodes) {
        map[node.id] = { code: node.code, name: node.name }
        if (node.children) {
          buildMap(node.children)
        }
      }
    }
    buildMap(nodes)
    return map
  }

  const getLeafTasksInfo = (nodes) => {
    const map = {}
    const buildMap = (nodes) => {
      for (const node of nodes) {
        if (!node.children || node.children.length === 0) {
          map[node.id] = { code: node.code, name: node.name }
        } else if (node.children) {
          buildMap(node.children)
        }
      }
    }
    buildMap(nodes)
    return map
  }

  const findNode = (nodes, id) => {
    for (const node of nodes) {
      if (node.id === id) return node
      if (node.children) {
        const found = findNode(node.children, id)
        if (found) return found
      }
    }
    return null
  }

  // 任务祖先名称链 / 父节点：用共享工具（与进度规划、网络图弹窗同实现）

  const updateNode = (nodes, id, updates) => {
    return nodes.map(node => {
      if (node.id === id) {
        return { ...node, ...updates }
      }
      if (node.children) {
        return { ...node, children: updateNode(node.children, id, updates) }
      }
      return node
    })
  }

  const deleteNode = (nodes, id) => {
    return nodes.filter(node => node.id !== id).map(node => {
      if (node.children) {
        return { ...node, children: deleteNode(node.children, id) }
      }
      return node
    })
  }

  const removePredecessorRefs = (nodes, taskId) => {
    return nodes.map(node => {
      const updated = { ...node }
      if (updated.predecessors) {
        updated.predecessors = updated.predecessors.filter(p => p !== taskId)
      }
      if (updated.children && updated.children.length > 0) {
        updated.children = removePredecessorRefs(updated.children, taskId)
      }
      return updated
    })
  }

  // 前置关系改接（方案二）：叶子任务因添加第一个子任务转为摘要任务时，
  // 其资源/前置/工时已整体下放给新子任务，语义上新子任务就是原任务的延续。
  // 因此把所有「以被转换任务为前置」的任务，等价改接为以新子任务为前置，
  // 避免数据层残留指向摘要任务的前置依赖（schedule.js 运行时展开仅作兜底）。
  // skipIds：新子任务继承的前置集合。若其中某任务同时也依赖被转换任务，
  // 改接会形成环（该任务→新子任务→该任务），跳过不改，保留原引用由运行时展开兜底。
  const rewirePredecessorRefs = (nodes, fromId, toId, affected, skipIds) => {
    return nodes.map(node => {
      const updated = { ...node }
      if (updated.predecessors && updated.predecessors.includes(fromId)) {
        if (skipIds && skipIds.has(node.id)) {
          // 会成环，跳过
        } else {
          affected.push({ id: node.id, name: node.name || '未命名任务' })
          updated.predecessors = updated.predecessors.map(p => (p === fromId ? toId : p))
        }
      }
      if (updated.children && updated.children.length > 0) {
        updated.children = rewirePredecessorRefs(updated.children, fromId, toId, affected, skipIds)
      }
      return updated
    })
  }

  const renumberTree = (nodes, prefix = '') => {
    return nodes.map((node, index) => {
      const newCode = prefix ? `${prefix}.${index + 1}` : `${index + 1}`
      return {
        ...node,
        code: newCode,
        children: node.children ? renumberTree(node.children, newCode) : []
      }
    })
  }

  const addChild = (nodes, parentId, newNode) => {
    return nodes.map(node => {
      if (node.id === parentId) {
        return {
          ...node,
          children: [...(node.children || []), { ...newNode }]
        }
      }
      if (node.children) {
        return { ...node, children: addChild(node.children, parentId, newNode) }
      }
      return node
    })
  }

  const addSibling = (nodes, targetId, newNode) => {
    const insertSibling = (currentNodes) => {
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].id === targetId) {
          return [...currentNodes.slice(0, i), { ...newNode }, ...currentNodes.slice(i)]
        }
      }
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].children) {
          const updated = insertSibling(currentNodes[i].children)
          if (updated) {
            return [...currentNodes.slice(0, i), { ...currentNodes[i], children: updated }, ...currentNodes.slice(i + 1)]
          }
        }
      }
      return null
    }
    
    const result = insertSibling(nodes)
    return result || [...nodes, { ...newNode }]
  }

  const insertAfter = (nodes, targetId, newNode) => {
    const insertAfterRecursively = (currentNodes) => {
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].id === targetId) {
          if (i === currentNodes.length - 1) {
            return [...currentNodes, { ...newNode }]
          } else {
            return [...currentNodes.slice(0, i + 1), { ...newNode }, ...currentNodes.slice(i + 1)]
          }
        }
        if (currentNodes[i].children) {
          const updated = insertAfterRecursively(currentNodes[i].children)
          if (updated) {
            return [...currentNodes.slice(0, i), { ...currentNodes[i], children: updated }, ...currentNodes.slice(i + 1)]
          }
        }
      }
      return null
    }
    
    const result = insertAfterRecursively(nodes)
    return result || [...nodes, { ...newNode }]
  }

  const promoteNode = (nodes, id) => {
    const findParentAndIndex = (currentNodes, target, parent = null, index = -1) => {
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].id === target) {
          return { parent, index: i, siblings: currentNodes }
        }
        if (currentNodes[i].children) {
          const found = findParentAndIndex(currentNodes[i].children, target, currentNodes[i], i)
          if (found) return found
        }
      }
      return null
    }

    const result = findParentAndIndex(nodes, id)
    if (!result || !result.parent) return nodes

    const { parent, index: nodeIndexInParent, siblings: parentChildren } = result
    const nodeToPromote = { ...parentChildren[nodeIndexInParent] }

    parentChildren.splice(nodeIndexInParent, 1)

    const grandparentResult = findParentAndIndex(nodes, parent.id)
    
    if (!grandparentResult || !grandparentResult.parent) {
      const parentIndexInRoot = nodes.indexOf(parent)
      if (parentIndexInRoot !== -1) {
        nodes.splice(parentIndexInRoot + 1, 0, nodeToPromote)
      }
    } else {
      const grandparentSiblings = grandparentResult.siblings
      const parentIndexInGrandparent = grandparentResult.index
      
      grandparentSiblings.splice(parentIndexInGrandparent + 1, 0, nodeToPromote)
    }

    return [...nodes]
  }

  const demoteNode = (nodes, id) => {
    const findParentAndIndex = (currentNodes, target, parent = null, index = -1) => {
      for (let i = 0; i < currentNodes.length; i++) {
        if (currentNodes[i].id === target) {
          return { parent, index: i, siblings: currentNodes }
        }
        if (currentNodes[i].children) {
          const found = findParentAndIndex(currentNodes[i].children, target, currentNodes[i], i)
          if (found) return found
        }
      }
      return null
    }

    const result = findParentAndIndex(nodes, id)
    if (!result || !result.parent || result.index === 0) return nodes

    const nodeToDemote = result.siblings[result.index]
    result.siblings.splice(result.index, 1)
    
    const prevSibling = result.siblings[result.index - 1]
    if (!prevSibling.children) prevSibling.children = []
    
    const newCode = `${prevSibling.code}.${(prevSibling.children?.length || 0) + 1}`
    nodeToDemote.code = newCode
    prevSibling.children.push(nodeToDemote)
    
    return [...nodes]
  }

  const handleToggleCollapse = useCallback((id) => {
    setTreeData(prev => updateNode(prev, id, { collapsed: !findNode(prev, id)?.collapsed }))
  }, [])

  const handleConnectToTarget = useCallback((targetId) => {
    if (connectingTo && connectingTo !== targetId) {
      const sourceNode = findNode(treeData, connectingTo)
      if (sourceNode) {
        setTreeData(prev => {
          const targetNode = findNode(prev, targetId)
          const newPredecessors = [...(targetNode?.predecessors || [])]
          if (!newPredecessors.includes(sourceNode.id)) {
            newPredecessors.push(sourceNode.id)
          }
          persistTask(targetId, { predecessors: newPredecessors })
          return updateNode(prev, targetId, { predecessors: newPredecessors })
        })
      }
    }
    setConnectingTo(null)
  }, [connectingTo, treeData, projectId])

  const handleSelect = useCallback((e, id) => {
    if (editCell) {
      const target = e?.target
      if (target && (target.classList.contains('wbs-edit-input') || target.tagName === 'INPUT' || target.closest('.duration-edit-container'))) {
        return
      }
      // 正在命名且名称为空：提示且保持编辑态（保留空任务行，不移除）
      if (blockIfNamingEmpty()) return
      setEditCell(null)
      setSelectedId(null)
      return
    }
    
    if (connectingTo && connectingTo !== id) {
      handleConnectToTarget(id)
      return
    }
    
    if (connectingFrom && connectingFrom.id !== id) {
      const sourceNode = findNode(treeData, connectingFrom.id)
      if (connectingFrom.type === 'out' && sourceNode) {
        setTreeData(prev => {
          const targetNode = findNode(prev, id)
          const newPredecessors = [...(targetNode?.predecessors || [])]
          if (!newPredecessors.includes(sourceNode.id)) {
            newPredecessors.push(sourceNode.id)
          }
          persistTask(id, { predecessors: newPredecessors })
          return updateNode(prev, id, { predecessors: newPredecessors })
        })
      }
      setConnectingFrom(null)
      return
    }
    
    if (selectedId === id) {
      setSelectedId(null)
    } else {
      setSelectedId(id)
      // macOS 浏览器点击非输入元素不会自动转移焦点（Windows 会），
      // 而行级快捷键（Tab/Enter/Delete…）绑定在 <tr> 的 onKeyDown 上，
      // 不显式聚焦的话，点击选中后 activeElement 仍是 BODY，按键全部无响应。
      rowRefs.current[id]?.focus()
    }
    // 单击仅选中（不弹详情弹窗）：详情通过任务名称旁悬浮的详情图标（展开样式）打开。
    // 单击即弹窗会打断「点击选中 → Tab/Enter 快捷键」的键盘流，且弹窗关闭后焦点易丢失。
    setConnectingFrom(null)
  }, [connectingFrom, connectingTo, handleConnectToTarget, selectedId])

  const handleStartConnect = useCallback((id, type) => {
    setConnectingFrom({ id, type })
  }, [])

  const handleDeletePredecessor = useCallback((taskId, predecessorCode) => {
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      const newPredecessors = task?.predecessors?.filter(c => c !== predecessorCode) || []
      persistTask(taskId, { predecessors: newPredecessors })
      return updateNode(prev, taskId, { predecessors: newPredecessors })
    })
  }, [projectId, statusOf])

  const handleEdit = useCallback((id, field) => {
    // 正在命名且名称为空时切换编辑目标：提示且保持当前编辑态，不切换、不移除
    if (editCellRef.current?.id !== id && blockIfNamingEmpty()) return
    const node = findNode(treeData, id)
    if (isTaskCompleted(node, statusOf)) return
    // 双击进入行内编辑：关闭已打开的详情弹窗
    setShowDetailPopup(false)
    setDetailTaskId(null)
    setEditCell({ id, field })
    setSelectedId(id)
    if (field === 'name' && node) {
      setIsNewTask(false)
      setOriginalTaskName(node.name)
    }
  }, [treeData, statusOf])

  const persistTask = async (taskId, updates) => {}

  const handlePredecessorsChange = useCallback(async (edges) => {
    const predMap = {}
    for (const edge of edges) {
      if (edge.source === '__start__' || edge.target === '__end__') continue
      if (!predMap[edge.target]) predMap[edge.target] = []
      predMap[edge.target].push(edge.source)
    }
    setTreeData(prev => {
      const update = (nodes) => nodes.map(node => ({
        ...node,
        predecessors: predMap[node.id] || [],
        children: node.children ? update(node.children) : [],
      }))
      return update(prev)
    })
    for (const [taskId, preds] of Object.entries(predMap)) {
      await persistTask(taskId, { predecessors: preds })
    }
  }, [projectId, workspaceId])

  useEffect(() => {
    if (predecessorsSyncRef) predecessorsSyncRef.current = handlePredecessorsChange
  }, [handlePredecessorsChange, predecessorsSyncRef])

  const persistResources = async (taskId, resources) => {}

  // Convert hours (in hours) to the numeric value in the given unit
  const hoursToUnitValue = (hours, unit) => {
    if (unit === '分钟') return hours * 60
    if (unit === '天') return hours / 8
    return hours
  }
  // Convert a numeric value in the given unit back to hours
  const unitValueToHours = (value, unit) => {
    if (unit === '分钟') return value / 60
    if (unit === '天') return value * 8
    return value
  }
  // Ceil value to the nearest multiple of step
  const ceilToStep = (value, step) => Math.ceil(value / step) * step

  const handleApplyTimeRule = async (newUnit, newValue) => {
    // Iterate all nodes, compute new resources with hours ceiled to new granularity
    const updatesByTaskId = new Map()
    const collectUpdates = (nodes) => {
      for (const node of nodes) {
        if (node.resources && node.resources.length > 0) {
          const newResources = node.resources.map(r => {
            const hours = r.hours || 0
            const unitValue = hoursToUnitValue(hours, newUnit)
            const ceiled = ceilToStep(unitValue, newValue)
            const newHours = unitValueToHours(ceiled, newUnit)
            return { ...r, hours: parseFloat(newHours.toFixed(4)) }
          })
          updatesByTaskId.set(node.task_ulid || node.id, newResources)
        }
        if (node.children && node.children.length > 0) {
          collectUpdates(node.children)
        }
      }
    }
    collectUpdates(treeData)

    try {
      // Update treeData state with new resource hours
      setTreeData(prev => {
        const applyUpdates = (nodes) => nodes.map(node => {
          const updated = { ...node }
          const taskId = node.task_ulid || node.id
          if (updatesByTaskId.has(taskId)) {
            updated.resources = updatesByTaskId.get(taskId)
          }
          if (node.children && node.children.length > 0) {
            updated.children = applyUpdates(node.children)
          }
          return updated
        })
        return applyUpdates(prev)
      })
      // Apply new time rule
      setTimeRuleUnit(newUnit)
      setTimeRuleValue(newValue)
      // Recalculate daily input hours to fit new unit constraints
      const dailyStep = newUnit === '分钟' ? 5 : 0.5
      const dailyMax = newUnit === '分钟' ? 1440 : newUnit === '小时' ? 24 : 1
      const dailyUnitValue = hoursToUnitValue(dailyInputHours, newUnit)
      const dailyCeiled = Math.min(dailyMax, ceilToStep(dailyUnitValue, dailyStep))
      const newDailyHours = parseFloat(unitValueToHours(dailyCeiled, newUnit).toFixed(4))
      setDailyInputHours(newDailyHours)
      // Persist time rule + daily input hours to project record
      const project = await getProjectById(projectId)
      if (project) {
        await updateRecord('projects', {
          ...project,
          time_rule_unit: newUnit,
          time_rule_value: newValue,
          daily_input_hours: newDailyHours
        })
      }
      reloadMemberStats()
    } catch (error) {
      console.error('Failed to apply time rule change:', error)
      alert('修改时间规则失败: ' + error.message)
    }
  }

  const handleApplyDailyInput = async (hours) => {
    try {
      setDailyInputHours(hours)
      const project = await getProjectById(projectId)
      if (project) {
        await updateRecord('projects', {
          ...project,
          daily_input_hours: hours
        })
      }
    } catch (error) {
      console.error('Failed to apply daily input change:', error)
      alert('修改每日投入时间失败: ' + error.message)
    }
  }

  const syncingRef = useRef(false)
  const pendingSyncRef = useRef(null)

  const syncTreeToDB = async (nodes) => {
    return new Map()
  }

  const deleteTaskFromDB = async (taskId, descendantIds = []) => {
    reloadMemberStats()
  }

  const handleDeleteTask = useCallback((itemId) => {
    const node = findNode(treeData, itemId)
    if (!node) return
    if (isTaskCompleted(node, statusOf)) return
    const descendantCount = countDescendants(node)
    if (descendantCount > 0) {
      setPendingDeleteItemId(itemId)
      setPendingDeleteCount(descendantCount)
      setShowDeleteConfirmModal(true)
    } else {
      executeDeleteTask(itemId)
    }
  }, [treeData, selectedId, projectId, workspaceId, statusOf])

  const executeDeleteTask = useCallback((itemId) => {
    const node = findNode(treeData, itemId)
    const descendantIds = node ? collectDescendantIds(node) : []
    deleteTaskFromDB(itemId, descendantIds)
    // 若删除的是待改接的未命名新子任务（首个子任务下放场景）：作废改接并还原父任务属性
    const pw = pendingRewireRef.current
    const isPendingRewireChild = pw && pw.childId === itemId
    if (isPendingRewireChild) {
      pendingRewireRef.current = null
    }
    setTreeData(prev => {
      let cleaned = removePredecessorRefs(deleteNode(prev, itemId), itemId)
      if (isPendingRewireChild) {
        cleaned = updateNode(cleaned, pw.parentId, {
          predecessors: pw.parentPreds,
          resources: pw.parentResources,
          deliverables: pw.parentDeliverables
        })
      }
      const updated = renumberTree(cleaned)
      syncTreeToDB(updated)
      return updated
    })
    // 清理指向被删任务的编辑态与错误提示
    if (editCellRef.current && editCellRef.current.id === itemId) {
      editCellRef.current = null
      setEditCell(null)
      setIsNewTask(false)
      setOriginalTaskName('')
      setErrorMessage('')
      setSelectedId(isPendingRewireChild ? pw.parentId : null)
    }
    if (selectedId === itemId) setSelectedId(null)
  }, [treeData, selectedId, projectId, workspaceId])

  const handleSaveEdit = useCallback((id, field, value) => {
    const node = findNode(treeData, id)
    if (isTaskCompleted(node, statusOf)) return
    let patch = { [field]: value }
    if (field === 'resources') {
      // 自定义工期：工时换算天数超过自定义工期时，清除自定义转为自动计算
      const exceeded = calcCustomDurationExceeded(node, value, dailyInputHours, 'max')
      if (exceeded != null) patch.customDurationDays = undefined
    }
    setTreeData(prev => updateNode(prev, id, patch))
    if (field === 'resources') {
      reloadMemberStats()
    } else if (field === 'customDurationDays') {
      persistTask(id, { custom_duration_days: value != null ? value : null })
    } else if (['name', 'code', 'status', 'duration', 'hours', 'start_date', 'end_date', 'predecessors', 'collapsed', 'description', 'deliverables', 'priority', 'taskType'].includes(field)) {
      persistTask(id, { [field === 'taskType' ? 'task_type' : field]: value })
    }
  }, [treeData, projectId, workspaceId, statusOf, dailyInputHours])

  const handleResourceHoursClick = useCallback((e, taskId, resourceIndex, fromExpanded) => {
    e.stopPropagation()
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    const rect = e.currentTarget.getBoundingClientRect()
    setHoursEditPopup({
      taskId,
      resourceIndex,
      x: rect.left,
      y: rect.bottom + 4,
      fromExpanded: !!fromExpanded
    })
  }, [statusOf])

  const handleSaveResourceHours = useCallback((taskId, resourceIndex, hours) => {
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task && task.resources && task.resources[resourceIndex]) {
        const newResources = [...task.resources]
        newResources[resourceIndex] = { ...newResources[resourceIndex], hours }
        // 自定义工期：工时换算天数超过自定义工期时，清除自定义转为自动计算
        const exceeded = calcCustomDurationExceeded(task, newResources, dailyInputHours, 'max')
        const patch = { resources: newResources }
        if (exceeded != null) patch.customDurationDays = undefined
        return updateNode(prev, taskId, patch)
      }
      return prev
    })
    setHoursEditPopup(null)
    reloadMemberStats()
  }, [treeData, dailyInputHours, statusOf])

  const handleSaveDurationDays = useCallback((taskId, days) => {
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    const minDays = node ? calcDefaultDurationDays(node) : 0
    const parsedDays = Math.max(minDays, parseFloat(days) || minDays)
    setTreeData(prev => {
      return updateNode(prev, taskId, { customDurationDays: parsedDays })
    })
    setDurationEditTask(null)
  }, [treeData, dailyInputHours, statusOf])

  const handleAutoCalculateDuration = useCallback((taskId) => {
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    setTreeData(prev => {
      return updateNode(prev, taskId, { customDurationDays: undefined })
    })
    setDurationEditTask(null)
  }, [dailyInputHours, statusOf])

  useEffect(() => {
    if (!durationEditTask) return
    const handleClickOutside = (e) => {
      if (durationEditPopupRef.current && !durationEditPopupRef.current.contains(e.target)) {
        setDurationEditTask(null)
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setDurationEditTask(null)
      } else if (e.key === 'Enter') {
        // 回车 = 点击对勾：保存自定义工期
        handleSaveDurationDays(durationEditTask.id, durationEditTask.customDurationDays)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [durationEditTask])

  const handleResourceMemberChange = useCallback((taskId, resourceIndex, selectedValue, directMember = null) => {
    const member = directMember || teamMembers.find(m => `${m.role}-${m.name}` === selectedValue)
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task && task.resources && task.resources[resourceIndex]) {
        const newResources = [...task.resources]
        newResources[resourceIndex] = {
          ...newResources[resourceIndex],
          role: member?.role || '',
          name: member?.name || '',
          avatar: member?.avatar || ''
        }
        return updateNode(prev, taskId, { resources: newResources })
      }
      return prev
    })
    setEditingResource(null)
  }, [teamMembers])

  const handleCreateAndAssignRole = useCallback((taskId, resourceIndex, newMember) => {
    setTeamMembers(prev => [...prev, newMember])
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task && task.resources && task.resources[resourceIndex]) {
        const newResources = [...task.resources]
        newResources[resourceIndex] = {
          ...newResources[resourceIndex],
          role: newMember.role,
          name: newMember.name,
          avatar: newMember.avatar
        }
        return updateNode(prev, taskId, { resources: newResources })
      }
      return prev
    })
    setEditingResource(null)
  }, [setTeamMembers])

  // 任务级跳过节假日口径：任务设置了 skip_holidays 用任务值，否则回落到项目全局设置。
  // 结束时间推算（computeEndFromDuration）统一按此口径执行
  const effSkipOf = (task) => (task && task.skip_holidays != null) ? !!task.skip_holidays : !!skipHolidays

  const handleDeleteResource = useCallback((taskId, resourceIndex) => {
    const node = findNode(treeData, taskId)
    if (isTaskCompleted(node, statusOf)) return
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task && task.resources) {
        const newResources = task.resources.filter((_, idx) => idx !== resourceIndex)
        const patch = { resources: newResources }
        // 删除资源改变工时（无自定义工期时）联动重算结束日期
        if (task.start_date && task.customDurationDays == null) {
          const autoDays = autoDurationDaysOf({ ...task, resources: newResources }, dailyInputHours)
          if (autoDays) patch.end_date = computeEndFromDuration(task.start_date, autoDays, effSkipOf(task))
        }
        return updateNode(prev, taskId, patch)
      }
      return prev
    })
    setEditingResource(null)
    reloadMemberStats()
  }, [statusOf, dailyInputHours, skipHolidays])

  const handleResourceHoursChange = useCallback((taskId, resourceIndex, hours) => {
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task && task.resources && task.resources[resourceIndex]) {
        const newResources = task.resources.map((r, i) => i === resourceIndex ? { ...r, hours } : r)
        // 自定义工期：工时换算天数超过自定义工期时，清除自定义转为自动计算
        const exceeded = calcCustomDurationExceeded(task, newResources, dailyInputHours, 'max')
        const patch = { resources: newResources }
        if (exceeded != null) patch.customDurationDays = undefined
        // 无自定义工期（或刚被清除）时，工时变化联动重算结束日期（保持开始日期不变）
        if (task.start_date && (task.customDurationDays == null || exceeded != null)) {
          const autoDays = autoDurationDaysOf({ ...task, resources: newResources }, dailyInputHours)
          if (autoDays) patch.end_date = computeEndFromDuration(task.start_date, autoDays, effSkipOf(task))
        }
        return updateNode(prev, taskId, patch)
      }
      return prev
    })
  }, [dailyInputHours, skipHolidays])

  const handleAddTaskResource = useCallback((taskId, member) => {
    if (!member) return
    setTreeData(prev => {
      const task = findNode(prev, taskId)
      if (task) {
        const newResources = [...(task.resources || []), { role: member.role || '', name: member.name || '', avatar: member.avatar || '', hours: 0 }]
        return updateNode(prev, taskId, { resources: newResources })
      }
      return prev
    })
  }, [])

  const handleOpenDetailPopup = useCallback((taskId) => {
    setDetailTaskId(taskId)
    setShowDetailPopup(true)
  }, [])

  const handleAddRole = (roleName) => {
    onAddRole(roleName)
  }

  const handleAddMember = (role, memberName) => {
    onAddMember(role, memberName)
  }

  const handleRenameRole = (oldRole, newRole) => {
    onRenameRole(oldRole, newRole)
  }

  const handleDeleteRole = (role) => {
    onDeleteRole(role)
  }

  const handleRenameMember = async (role, oldName, newName, newRole) => {
    if (projectId) {
      const { renameMemberResources } = await import('../utils/db')
      const newAvatar = newName ? newName.charAt(0).toUpperCase() : ''
      await renameMemberResources(projectId, oldName, newName, newAvatar, role, newRole)
      await reloadTree()
      reloadMemberStats()
    }
    onRenameMember(role, oldName, newName, newRole)
  }

  const handleDeleteMember = async (role, memberName) => {
    if (!memberName && projectId) {
      // 待分配成员：清理该角色的待分配任务资源
      const { deleteUnassignedResourcesByRole } = await import('../utils/db')
      await deleteUnassignedResourcesByRole(projectId, role)
      await reloadTree()
      reloadMemberStats()
    }
    onDeleteMember(role, memberName)
  }

  const handleFinishEdit = useCallback(() => {
    if (editCell && editCell.field === 'name') {
      const currentTreeData = treeDataRef.current
      const node = findNode(currentTreeData, editCell.id)
      if (node && !node.name.trim()) {
        if (isNewTask) {
          // 新建任务但名称为空，直接从树中移除（未保存到数据库）；待改接上下文一并作废
          const pw = pendingRewireRef.current
          const isPendingRewire = pw && pw.childId === editCell.id
          pendingRewireRef.current = null
          setTreeData(prev => {
            let cleaned = removePredecessorRefs(deleteNode(prev, editCell.id), editCell.id)
            if (isPendingRewire) {
              // 取消首个子任务创建：还原 Tab 时下放给子任务的父任务属性（前置/资源/交付物）
              cleaned = updateNode(cleaned, pw.parentId, {
                predecessors: pw.parentPreds,
                resources: pw.parentResources,
                deliverables: pw.parentDeliverables
              })
            }
            const updated = renumberTree(cleaned)
            return updated
          })
          setSelectedId(isPendingRewire ? pw.parentId : null)
          if (isPendingRewire) {
            // 焦点还给父任务行，Escape 取消后 Tab/Enter 快捷键可无缝继续
            setTimeout(() => {
              rowRefs.current[pw.parentId]?.focus()
            }, 0)
          }
        } else {
          setTreeData(prev => updateNode(prev, editCell.id, { name: originalTaskName }))
          setSelectedId(null)
        }
      } else {
        // 名称不为空，保存到数据库
        if (isNewTask) {
          // 方案二：新子任务命名确认后，才执行前置关系改接（引用原父任务的任务改接为本子任务的前置）
          let treeToSync = currentTreeData
          const pw = pendingRewireRef.current
          if (pw && pw.childId === editCell.id) {
            pendingRewireRef.current = null
            const affected = []
            const rewired = rewirePredecessorRefs(currentTreeData, pw.parentId, pw.childId, affected, pw.skipPreds)
            if (affected.length > 0) {
              const childNode = findNode(rewired, pw.childId)
              const childName = (childNode && childNode.name) || '新子任务'
              const names = affected.map(a => a.name)
              const label = affected.length === 1
                ? `「${names[0]}」的前置任务`
                : `${affected.length} 个任务（${names.slice(0, 3).join('、')}${affected.length > 3 ? '等' : ''}）的前置任务`
              showRewireToast(`已将${label}由「${pw.parentName}」改接为「${childName}」`)
              treeToSync = renumberTree(rewired)
              setTreeData(treeToSync)
            }
          }
          // 新建任务且有名称，同步到数据库
          syncTreeToDB(treeToSync)
        }
        setSelectedId(editCell.id)
      }
    }
    setPrevEditCell(editCell)
    setEditCell(null)
    setIsNewTask(false)
    setOriginalTaskName('')
  }, [editCell, isNewTask, originalTaskName])

  const handleDragStart = useCallback((e, item) => {
    if (isTaskCompleted(item, statusOf)) {
      e.preventDefault()
      return
    }
    if (editCell) {
      e.preventDefault()
      return
    }
    setDraggedItem(item)
    setSelectedId(item.id)
    e.dataTransfer.effectAllowed = 'move'
  }, [editCell, statusOf])

  const handleDragOver = useCallback((e, item) => {
    if (!draggedItem || draggedItem.id === item.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverItem(item)
    
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const height = rect.height
    
    let position
    if (y < height * 0.3) {
      position = 'top'
    } else if (y > height * 0.7) {
      position = 'bottom'
    } else {
      position = 'child'
    }
    
    setDragOverPosition(position)
  }, [draggedItem])

  const handleDragLeave = useCallback(() => {
    setDragOverItem(null)
    setDragOverPosition(null)
  }, [])

  const handleDrop = useCallback((e, targetItem) => {
    if (!draggedItem || draggedItem.id === targetItem.id) return
    e.preventDefault()

    if (dragOverPosition === 'child') {
      setTreeData(prev => {
        const newData = deleteNode(prev, draggedItem.id)
        const withChild = addChild(newData, targetItem.id, draggedItem)
        const updated = renumberTree(withChild)
        syncTreeToDB(updated)
        return updated
      })
    } else if (dragOverPosition === 'top') {
      setTreeData(prev => {
        const newData = deleteNode(prev, draggedItem.id)
        const withSibling = addSibling(newData, targetItem.id, draggedItem)
        const updated = renumberTree(withSibling)
        syncTreeToDB(updated)
        return updated
      })
    } else {
      setTreeData(prev => {
        const newData = deleteNode(prev, draggedItem.id)
        const withSibling = insertAfter(newData, targetItem.id, draggedItem)
        const updated = renumberTree(withSibling)
        syncTreeToDB(updated)
        return updated
      })
    }
    
    setDraggedItem(null)
    setDragOverItem(null)
    setDragOverPosition(null)
  }, [draggedItem, dragOverPosition])

  const handleDragEnd = useCallback(() => {
    setDraggedItem(null)
    setDragOverItem(null)
    setDragOverPosition(null)
  }, [])

  const handleStartConnectTo = useCallback((id) => {
    const node = findNode(treeData, id)
    if (isTaskCompleted(node, statusOf)) return
    setConnectingTo(id)
  }, [statusOf])

  const handleKeyDown = useCallback((e, item) => {
    if (e.target.tagName === 'INPUT') return
    
    switch (e.key) {
      case 'Enter':
        e.preventDefault()
        const ulid = generateULID()
        const itemIsLeaf = !item.children || item.children.length === 0
        let predecessors = []
        if (itemIsLeaf) {
          predecessors = [item.id]
        }
        const newTask = {
          id: ulid,
          task_ulid: ulid,
          name: '',
          duration: '8h 0min',
          resources: getDefaultResources(),
          status: 'pending',
          collapsed: false,
          children: [],
          predecessors,
          description: '',
          deliverables: [],
          priority: 'medium',
          customDurationDays: undefined
        }
        setTreeData(prev => {
          const updated = renumberTree(insertAfter(prev, item.id, newTask))
          // 新建任务时不立即保存到数据库，等用户输入名称后再保存
          return updated
        })
        setIsNewTask(true)
        setOriginalTaskName('')
        setErrorMessage('')
        setTimeout(() => {
          setEditCell({ id: ulid, field: 'name' })
          setSelectedId(ulid)
        }, 0)
        break
      case 'Tab':
        e.preventDefault()
        if (e.shiftKey) {
          setTreeData(prev => {
            const updated = renumberTree(promoteNode(prev, item.id))
            syncTreeToDB(updated)
            return updated
          })
        } else {
          const ulid = generateULID()
          let predecessors = []
          let resources = []
          let deliverables = []
          let clearParentData = false
          
          if (item.children && item.children.length > 0) {
            const lastChild = item.children[item.children.length - 1]
            predecessors = [lastChild.id]
            resources = getDefaultResources()
          } else {
            predecessors = [...(item.predecessors || [])]
            resources = [...(item.resources || [])]
            deliverables = [...(item.deliverables || [])]
            clearParentData = true
          }
          
          const newTask = {
            id: ulid,
            task_ulid: ulid,
            name: '',
            duration: '8h 0min',
            resources,
            status: 'pending',
            collapsed: false,
            children: [],
            predecessors,
            description: '',
            deliverables,
            priority: 'medium',
            customDurationDays: undefined
          }
          
          setTreeData(prev => {
            let updated = addChild(prev, item.id, newTask)
            if (clearParentData) {
              updated = updateNode(updated, item.id, { predecessors: [], resources: [], deliverables: [] })
              // 方案二：记录待改接上下文，等新子任务命名回车确认后再改接引用「任务2」为前置的任务；
              // 同时快照父任务被下放的原始属性，命名取消（Escape）时还原
              pendingRewireRef.current = {
                parentId: item.id,
                childId: ulid,
                skipPreds: new Set(predecessors),
                parentName: item.name || '未命名任务',
                parentPreds: [...predecessors],
                parentResources: [...resources],
                parentDeliverables: [...deliverables]
              }
            }
            updated = renumberTree(updated)
            // 新建任务时不立即保存到数据库，等用户输入名称后再保存
            return updated
          })
          
          setIsNewTask(true)
          setOriginalTaskName('')
          setErrorMessage('')
          setTimeout(() => {
            setEditCell({ id: ulid, field: 'name' })
            setSelectedId(ulid)
          }, 0)
        }
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        if (selectedId === item.id) {
          handleDeleteTask(item.id)
        }
        break
      default:
        break
    }
  }, [editCell, selectedId])

  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if (e.key === 'Escape') {
        setConnectingFrom(null)
        setEditCell(null)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  

  useEffect(() => {
    const handleGlobalClick = (e) => {
      const currentEditCell = editCellRef.current
      if (currentEditCell && currentEditCell.field === 'name') {
        const isInput = e.target.classList.contains('wbs-edit-input')
        if (!isInput) {
          const node = findNode(treeDataRef.current, currentEditCell.id)
          if (node && !node.name.trim()) {
            // 名称为空，显示错误提示并保持焦点在输入框
            setErrorMessage('任务名称不能为空')
            // 找到输入框并重新聚焦
            setTimeout(() => {
              const input = document.querySelector('.wbs-edit-input')
              if (input) input.focus()
            }, 0)
          } else {
            // 名称不为空，完成编辑
            setEditCell(null)
            setSelectedId(currentEditCell.id)
            setIsNewTask(false)
            setOriginalTaskName('')
          }
        }
      } else if (currentEditCell) {
        const isInput = e.target.classList.contains('wbs-edit-input') || e.target.tagName === 'INPUT'
        const isDurationTag = e.target.classList.contains('duration-tag')
        const isDurationEditContainer = e.target.closest('.duration-edit-container')
        if (!isInput && !isDurationTag && !isDurationEditContainer) {
          setEditCell(null)
          setSelectedId(currentEditCell.id)
          // 同 handleSelect：退出编辑后显式聚焦行，保证快捷键继续可用
          rowRefs.current[currentEditCell.id]?.focus()
        }
      }
    }
    window.addEventListener('click', handleGlobalClick)
    return () => window.removeEventListener('click', handleGlobalClick)
  }, [])

  useEffect(() => {
    if (!editCell && prevEditCell) {
      setTimeout(() => {
        if (rowRefs.current[prevEditCell.id]) {
          rowRefs.current[prevEditCell.id].focus()
        }
      }, 0)
      setPrevEditCell(null)
    }
  }, [editCell, prevEditCell])

  const flatData = flattenTree(treeData)

  const getStatusBadge = (status) => {
    const badgeClass = `status-badge ${status}`
    const labels = {
      'pending': '待开始',
      'in-progress': '进行中',
      'completed': '已完成'
    }
    return <span className={badgeClass}>{labels[status]}</span>
  }

  const getTaskTypeInfo = (task, nodeMaxHours = null) => {
    if (task.taskType === '里程碑') {
      return { type: '里程碑', typeClass: 'task-type-milestone', totalHours: 0, isCustomDuration: false }
    }
    const calculateMaxHours = (node) => {
      if (node.children && node.children.length > 0) {
        return Math.max(...node.children.map(child => calculateMaxHours(child)))
      } else {
        return node.resources?.reduce((max, r) => Math.max(max, r.hours || 0), 0) || 0
      }
    }
    const totalHours = nodeMaxHours != null ? nodeMaxHours : calculateMaxHours(task)
    const isCustomDuration = task.customDurationDays !== undefined
    let type = '等待'
    let typeClass = 'task-type-waiting'
    if (totalHours !== 0 && !isCustomDuration) {
      type = '执行'
      typeClass = 'task-type-executing'
    } else if (totalHours !== 0 && isCustomDuration) {
      type = '跟进'
      typeClass = 'task-type-following'
    }
    return { type, typeClass, totalHours, isCustomDuration }
  }

  const generateNetworkData = () => {
    const allNodes = []
    const allEdges = []
    const START_NODE_ID = 'start-node'
    const END_NODE_ID = 'end-node'
    
    const collectNodes = (nodes) => {
      for (const node of nodes) {
        if (!node.children || node.children.length === 0) {
          allNodes.push({
            id: node.id,
            code: node.code,
            name: node.name,
            status: node.status,
            level: node.level,
            predecessors: node.predecessors
          })
        }
        if (node.children) {
          collectNodes(node.children)
        }
      }
    }
    
    collectNodes(treeData)
    
    const nodeIdSet = new Set(allNodes.map(n => n.id))

    const getLeafDescendantIds = (nodeId) => {
      const node = findNode(treeData, nodeId)
      if (!node) return []
      if (!node.children || node.children.length === 0) return [node.id]
      let ids = []
      for (const child of node.children) {
        ids = ids.concat(getLeafDescendantIds(child.id))
      }
      return ids
    }
    
    for (const node of allNodes) {
      if (node.predecessors && node.predecessors.length > 0) {
        for (const predId of node.predecessors) {
          if (predId === node.id) continue
          if (nodeIdSet.has(predId)) {
            allEdges.push({
              from: predId,
              to: node.id,
              type: 'dependency'
            })
          } else {
            const leafIds = getLeafDescendantIds(predId)
            for (const leafId of leafIds) {
              if (nodeIdSet.has(leafId) && leafId !== node.id) {
                allEdges.push({
                  from: leafId,
                  to: node.id,
                  type: 'dependency'
                })
              }
            }
          }
        }
      }
    }
    
    for (const node of allNodes) {
      if (!node.predecessors || node.predecessors.length === 0) {
        allEdges.push({
          from: START_NODE_ID,
          to: node.id,
          type: 'dependency'
        })
      }
    }
    
    const nodesWithOutgoingEdges = new Set(allEdges.map(e => e.from))
    for (const node of allNodes) {
      if (!nodesWithOutgoingEdges.has(node.id)) {
        allEdges.push({
          from: node.id,
          to: END_NODE_ID,
          type: 'dependency'
        })
      }
    }
    
    allNodes.unshift({
      id: START_NODE_ID,
      code: 'START',
      name: '开始',
      status: 'completed',
      level: 0
    })
    
    allNodes.push({
      id: END_NODE_ID,
      code: 'END',
      name: '结束',
      status: 'completed',
      level: 999
    })
    
    return { nodes: allNodes, edges: allEdges }
  }

  const networkData = generateNetworkData()

  // 顶部导航第二行（团队人数/工时粒度/每日投入）挂载点：由 App 的 content-header 提供
  const [headerStatsSlot, setHeaderStatsSlot] = useState(null)
  useEffect(() => {
    setHeaderStatsSlot(document.getElementById('planning-header-stats-slot'))
  }, [])
  const headerStatsPortal = headerStatsSlot ? createPortal(
    <PlanningHeaderStats
      teamMembers={teamMembers}
      isMemberListExpanded={isMemberListExpanded}
      onToggleMemberList={setIsMemberListExpanded}
      timeRuleUnit={timeRuleUnit}
      timeRuleValue={timeRuleValue}
      dailyInputHours={dailyInputHours}
      onApplyTimeRule={handleApplyTimeRule}
      onApplyDailyInput={handleApplyDailyInput}
    />,
    headerStatsSlot
  ) : null

  return (
    <div className="page-container">
      {headerStatsPortal}
      <div className="page-content wbs-content">
        {isMemberListExpanded && (
          <div className="wbs-left">
            <MemberList
            teamMembers={getMemberTasks()}
            showDetails={true}
            projectId={projectId}
            timeRuleUnit={timeRuleUnit}
            onCollapse={() => setIsMemberListExpanded(false)}
            onAddRole={handleAddRole}
            onAddMember={handleAddMember}
            onRenameRole={handleRenameRole}
            onDeleteRole={handleDeleteRole}
            onRenameMember={handleRenameMember}
            onDeleteMember={handleDeleteMember}
            onReassignResources={async (oldName, newName, newRole) => {
              if (!projectId) return
              const { reassignMemberResources, unassignMemberResources } = await import('../utils/db')
              if (newName) {
                // 分配给具名成员
                await reassignMemberResources(projectId, oldName, newName, newRole)
              } else if (newRole) {
                // 分配给其他角色的待分配成员
                await reassignMemberResources(projectId, oldName, '', newRole)
              } else {
                // 暂不分配（保持原角色）
                await unassignMemberResources(projectId, oldName)
                // 暂不分配：在成员列表该角色下增加待分配成员
                const oldRole = teamMembers.find(m => m.name === oldName)?.role
                if (oldRole) {
                  const hasPlaceholder = teamMembers.some(m => m.role === oldRole && !m.name)
                  if (!hasPlaceholder) {
                    const { addProjectMember } = await import('../utils/db')
                    const placeholder = await addProjectMember({
                      project_ulid: projectId,
                      display_name: '',
                      job_role: oldRole,
                      role: 'VIEWER'
                    })
                    setTeamMembers(prev => [...prev, {
                      member_ulid: placeholder.member_ulid,
                      role: oldRole,
                      name: '',
                      avatar: ''
                    }])
                  }
                }
              }
              await reloadTree()
              reloadMemberStats()
            }}
            />
          </div>
        )}
        <div className="wbs-right">
          {/* 快捷键提示放在右栏内：成员面板展开时随任务列表一起右移 */}
          <div className="wbs-keyboard-hints">
            <span className="hint">Enter: 新建同级</span>
            <span className="hint">Tab: 新建子级</span>
            <span className="hint">Shift+Tab: 升级</span>
            <span className="hint">Delete: 删除</span>
            <span className="hint">Esc: 取消</span>
          </div>
          {loading ? (
            <div className="wbs-loading">加载中...</div>
          ) : projectId && treeData.length === 0 ? (
            <div className="wbs-empty-state">
              <div className="empty-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p className="empty-text">暂无任务</p>
              <button className="btn btn-primary add-task-btn" onClick={handleAddFirstTask}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                添加任务
              </button>
            </div>
          ) : (
            <table className="wbs-table">
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>任务名称</th>
                  <th style={{ width: '8%' }}>前置任务</th>
                  <th style={{ width: '22%' }}>资源需求</th>
                  <th style={{ width: '8%' }}>总预估工时</th>
                  <th style={{ width: '9%' }}>工期（天）</th>
                  <th style={{ width: '13%' }}>可交付成果</th>
                  <th style={{ width: '7%' }}>任务类型</th>
                  <th style={{ width: '5%' }}></th>
                </tr>
              </thead>
              <tbody>
                {flatData.map((item) => (
              <Fragment key={item.id}>
              <tr 
                className={`wbs-row ${selectedId === item.id ? 'selected' : ''} ${draggedItem?.id === item.id ? 'dragging' : ''} ${dragOverItem?.id === item.id ? 'drag-over' : ''} ${isTaskCompleted(item, statusOf) ? 'locked' : ''}`}
                onClick={(e) => handleSelect(e, item.id)}
                onKeyDown={(e) => handleKeyDown(e, item)}
                tabIndex={0}
                ref={(el) => { rowRefs.current[item.id] = el }}
                draggable={!editCell && !isTaskCompleted(item, statusOf)}
                onDragStart={(e) => handleDragStart(e, item)}
                onDragOver={(e) => handleDragOver(e, item)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, item)}
                onDragEnd={handleDragEnd}
              >
                <td style={{ paddingLeft: `${item.level * 24 + 8}px` }} onMouseEnter={() => setHoveredTaskId(item.id)} onMouseLeave={() => setHoveredTaskId(null)}>
                  {dragOverItem?.id === item.id && (
                    <div className={`drag-indicator ${dragOverPosition === 'child' ? 'child' : dragOverPosition === 'top' ? 'top' : 'bottom'}`} style={{ marginLeft: dragOverPosition === 'child' ? `${(item.level + 1) * 24}px` : `${item.level * 24}px` }} />
                  )}
                  <div className="wbs-cell-content">
                    {item.children && item.children.length > 0 && (
                      <button 
                        className="collapse-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleToggleCollapse(item.id)
                        }}
                      >
                        {item.collapsed ? '▶' : '▼'}
                      </button>
                    )}
                    {item.children && item.children.length === 0 && (
                      isTaskCompleted(item, statusOf) ? (
                        <svg className="collapse-placeholder completed-dot" width="13" height="13" viewBox="0 0 24 24" title="已完成">
                          <circle cx="12" cy="12" r="10" fill="#DCFCE7" stroke="#16A34A" strokeWidth="1.5" />
                          <path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="#16A34A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span className="collapse-placeholder">•</span>
                      )
                    )}
                    <span className="task-code">{item.code}</span>
                    <div className="task-container">
                      <div className="task-content">
                        {editCell?.id === item.id && editCell?.field === 'name' ? (
                          <div className="edit-container">
                            <input
                              type="text"
                              className={`wbs-edit-input ${!item.name.trim() && errorMessage ? 'error' : ''}`}
                              value={item.name}
                              onChange={(e) => {
                                handleSaveEdit(item.id, 'name', e.target.value)
                                if (errorMessage) setErrorMessage('')
                              }}
                              onKeyDown={(e) => {
                                e.stopPropagation()
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  if (e.target.value.trim()) {
                                    handleFinishEdit()
                                    setErrorMessage('')
                                  } else {
                                    setErrorMessage('任务名称不能为空')
                                  }
                                } else if (e.key === 'Escape') {
                                  e.preventDefault()
                                  handleFinishEdit()
                                  setErrorMessage('')
                                }
                              }}
                              onBlur={(e) => {
                                if (item.name.trim()) {
                                  handleFinishEdit()
                                  setErrorMessage('')
                                } else {
                                  setErrorMessage('任务名称不能为空')
                                  // 保持焦点在输入框
                                  setTimeout(() => {
                                    e.target.focus()
                                  }, 0)
                                }
                              }}
                              autoFocus
                            />
                            {!item.name.trim() && errorMessage && (
                              <span className="error-hint">{errorMessage}</span>
                            )}
                          </div>
                        ) : (
                          <>
                          <span
                            className="task-name"
                            onDoubleClick={() => {
                              if (isTaskCompleted(item, statusOf)) return
                              handleEdit(item.id, 'name')
                            }}
                          >
                            {item.name}
                          </span>
                          <button
                            className="action-btn description-edit-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (isTaskCompleted(item, statusOf)) return
                              handleOpenDetailPopup(item.id)
                            }}
                            title="任务详情"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="15 3 21 3 21 9" />
                              <polyline points="9 21 3 21 3 15" />
                              <line x1="21" y1="3" x2="14" y2="10" />
                              <line x1="3" y1="21" x2="10" y2="14" />
                            </svg>
                          </button>
                          {(!item.children || item.children.length === 0) && (
                            <button
                              className={`milestone-btn ${item.taskType === '里程碑' ? 'milestone-active' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (item.taskType === '里程碑') {
                                  handleSaveEdit(item.id, 'taskType', null)
                                } else {
                                  // 一次性更新所有里程碑相关字段，避免竞态条件
                                  setTreeData(prev => updateNode(prev, item.id, {
                                    taskType: '里程碑',
                                    resources: [],
                                    customDurationDays: undefined
                                  }))
                                  reloadMemberStats()
                                }
                              }}
                              title={item.taskType === '里程碑' ? '取消里程碑' : '设为里程碑'}
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill={item.taskType === '里程碑' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                                <line x1="4" y1="22" x2="4" y2="15"/>
                              </svg>
                            </button>
                          )}
                          </>
                        )}
                        {(!item.children || item.children.length === 0) && (
                        <button
                          className="action-btn connect-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleStartConnectTo(item.id)
                          }}
                          title="引出到"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m17 8 5 5-5 5"/>
                            <path d="M3 12h18"/>
                          </svg>
                        </button>
                        )}
                      </div>
                    </div>
                  </div>
                </td>
                
                <td>
                  <div className="predecessors-cell">
                    {item.predecessors?.map((predId, idx) => {
                      const predCode = getIdToCodeMap(treeData)[predId] || predId
                      return (
                        <span
                          key={idx}
                          className="predecessor-tag clickable-resource"
                          onClick={(e) => {
                            e.stopPropagation()
                            const rect = e.currentTarget.getBoundingClientRect()
                            setPopupPosition({ x: rect.left, y: rect.bottom })
                            setPredecessorModal({ taskId: item.id, predecessorId: predId })
                          }}
                          title={`点击修改: ${predCode}`}
                        >
                          {predCode}
                          <button
                            className="delete-resource-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeletePredecessor(item.id, predId)
                            }}
                          >
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </span>
                      )
                    })}
                    {(!item.children || item.children.length === 0) && (
                      <div
                        className="resource-item more-resources add-resource-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setPopupPosition({ x: rect.left, y: rect.bottom })
                          setPredecessorModal({ taskId: item.id, predecessorId: null })
                        }}
                        title="添加前置任务"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </div>
                    )}
                  </div>
                </td>
                
                <td>
                  {editCell && editCell.id === item.id && editCell.field === 'resources' ? (
                    <ResourceEditModal
                      task={item}
                      teamMembers={teamMembers}
                      timeRuleUnit={timeRuleUnit}
                      timeRuleValue={timeRuleValue}
                      onSave={(resources) => {
                        handleSaveEdit(item.id, 'resources', resources)
                        setEditCell(null)
                      }}
                      onCancel={() => {
                        setEditCell(null)
                      }}
                    />
                  ) : (
                    <div 
                      className={`resources-container ${item.taskType === '里程碑' ? 'milestone-disabled' : ''}`}
                      onClick={(e) => {
                        if (e.target.closest('.resource-hours') || e.target.closest('.delete-resource-btn') || e.target.closest('.expanded-delete-btn')) return
                        e.stopPropagation()
                        if (item.taskType !== '里程碑' && item.resources && item.resources.length > 0) {
                          setExpandedResourceId(prev => prev === item.id ? null : item.id)
                        }
                      }}
                      style={{ cursor: item.taskType === '里程碑' ? 'not-allowed' : (item.resources && item.resources.length > 0) ? 'pointer' : 'default' }}
                    >
                      {item.taskType === '里程碑' ? (
                        <span className="milestone-dash">—</span>
                      ) : (
                      <>
                      {item.resources && item.resources.length > 2 ? (
                        <>
                          {item.resources.slice(0, (hoursEditPopup && hoursEditPopup.taskId === item.id && !hoursEditPopup.fromExpanded) ? item.resources.length : 2).map((resource, idx) => (
                            <div 
                              key={idx} 
                              className="resource-item clickable-resource"
                              onClick={(e) => {
                                e.stopPropagation()
                                const rect = e.currentTarget.getBoundingClientRect()
                                setPopupPosition({ x: rect.left, y: rect.bottom })
                                setEditingResource({ taskId: item.id, resourceIndex: idx })
                              }}
                            >
                              <span className={`avatar ${!resource.name ? 'empty-avatar' : ''}`}>
                                {resource.name ? resource.avatar : '?'}
                              </span>
                              <div className="resource-info">
                                <span className={`resource-name ${!resource.name ? 'empty-name' : ''}`}>
                                  {resource.name || resource.role}
                                </span>
                                <span 
                                  className="resource-hours"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleResourceHoursClick(e, item.id, idx)
                                  }}
                                >
                                {(() => {
                                  return formatHoursByUnit(resource.hours || 0, timeRuleUnit)
                                })()}
                              </span>
                              </div>
                              <button
                                className="delete-resource-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteResource(item.id, idx)
                                }}
                                title="删除资源"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>
                          ))}
                           {(() => {
                             const n = (hoursEditPopup && hoursEditPopup.taskId === item.id)
                               ? Math.max(0, item.resources.filter(r => (r.hours || 0) > 0).length - 2)
                               : Math.max(0, item.resources.length - 2)
                             return n > 0 ? (
                                <div className="resource-item more-resources" 
                                     title={item.resources.slice(2).map(r => {
                                       const h = Math.floor(r.hours)
                                       const m = Math.round((r.hours % 1) * 60)
                                       return `${r.name || r.role}: ${h > 0 ? h + 'h' + (m > 0 ? ' ' + m + 'min' : '') : m + 'min'}`
                                     }).join('\n')}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setExpandedResourceId(prev => prev === item.id ? null : item.id)
                                    }}>
                                 <span className="more-badge">+{n}</span>
                               </div>
                             ) : null
                           })()}
                          <div className="resource-item more-resources add-resource-btn"
                               onClick={(e) => {
                                 e.stopPropagation()
                                 const rect = e.currentTarget.getBoundingClientRect()
                                 resourceAddAnchorRef.current = { x: rect.left, y: rect.bottom }
                                 setPopupPosition({ x: rect.left, y: rect.bottom })
                                 setEditingResource({ taskId: item.id, resourceIndex: -1, isAdding: true })
                               }}
                               title="添加资源">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </div>
                        </>
                      ) : (
                        <>
                          {item.resources?.map((resource, idx) => (
                            <div 
                              key={idx} 
                              className="resource-item clickable-resource"
                              onClick={(e) => {
                                e.stopPropagation()
                                const rect = e.currentTarget.getBoundingClientRect()
                                setPopupPosition({ x: rect.left, y: rect.bottom })
                                setEditingResource({ taskId: item.id, resourceIndex: idx })
                              }}
                            >
                              <span className={`avatar ${!resource.name ? 'empty-avatar' : ''}`}>
                                {resource.name ? resource.avatar : '?'}
                              </span>
                              <div className="resource-info">
                                <span className={`resource-name ${!resource.name ? 'empty-name' : ''}`}>
                                  {resource.name || resource.role}
                                </span>
                                <span 
                                  className="resource-hours"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleResourceHoursClick(e, item.id, idx)
                                  }}
                                >
                                  {(() => {
                                    return formatHoursByUnit(resource.hours || 0, timeRuleUnit)
                                  })()}
                                </span>
                              </div>
                              <button 
                                className="delete-resource-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteResource(item.id, idx)
                                }}
                                title="删除资源"
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>
                          ))}
                          {(!item.children || item.children.length === 0) && (
                            <div className="resource-item more-resources add-resource-btn"
                                 onClick={(e) => {
                                   e.stopPropagation()
                                   const rect = e.currentTarget.getBoundingClientRect()
                                   resourceAddAnchorRef.current = { x: rect.left, y: rect.bottom }
                                   setPopupPosition({ x: rect.left, y: rect.bottom })
                                   setEditingResource({ taskId: item.id, resourceIndex: -1, isAdding: true })
                                 }}
                                 title="添加资源">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                              </svg>
                            </div>
                          )}
                        </>
                      )}
                      </>
                      )}
                    </div>
                  )}
                </td>
                
                <td>
                  {item.children && item.children.length > 0 ? (
                    <span className="duration-days-text">
                      {(() => {
                        const calculateHours = (node) => {
                          if (node.children && node.children.length > 0) {
                            return node.children.reduce((sum, child) => sum + calculateHours(child), 0)
                          } else {
                            return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
                          }
                        }
                        const totalHours = calculateHours(item)
                        return totalHours > 0 ? `共${formatHoursByUnit(totalHours, timeRuleUnit)}` : `共${formatHoursByUnit(0, timeRuleUnit)}`
                      })()}
                    </span>
                  ) : (
                    <span className="duration-tag">
                      {(() => {
                        const calculateHours = (node) => {
                          if (node.children && node.children.length > 0) {
                            return node.children.reduce((sum, child) => sum + calculateHours(child), 0)
                          } else {
                            return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
                          }
                        }
                        const totalHours = calculateHours(item)
                        return formatHoursByUnit(totalHours, timeRuleUnit)
                      })()}
                    </span>
                  )}
                </td>
                
                <td>
                  {item.taskType === '里程碑' ? (
                    <span className="milestone-dash">—</span>
                  ) : (!item.children || item.children.length === 0) ? (
                    <span 
                    className={`duration-days`}
                    onClick={(e) => {
                      e.stopPropagation()
                      const rect = e.currentTarget.getBoundingClientRect()
                      setPopupPosition({ x: rect.left, y: rect.bottom })
                      setDurationEditTask({ 
                        ...item, 
                        isCustomDuration: item.customDurationDays !== undefined 
                      })
                    }}
                    title="点击编辑工期"
                  >
                      {(() => {
                        const displayDays = calcEffectiveDurationDays(item)
                        const customDays = item.customDurationDays
                        return (
                          <>{displayDays}{customDays !== undefined && <span className="duration-custom-badge">自定义</span>}</>
                        )
                      })()}
                    </span>
                  ) : (item.children && item.children.length > 0) ? (
                    <span className="duration-days-text">
                      {(() => {
                        const days = calcGroupDurationDays(item)
                        return `共${days}天`
                      })()}
                    </span>
                  ) : null}
                </td>

                <td className="cell-deliverables" onClick={(e) => e.stopPropagation()}>
                  {(!item.children || item.children.length === 0) && (
                  <div className="deliverables-container">
                    {(item.deliverables || []).map((fileName, idx) => (
                      <span key={idx} className="deliverable-chip" title={fileName}>
                        <span className="deliverable-chip-name">{fileName}</span>
                        <button
                          className="deliverable-chip-remove"
                          onClick={(e) => {
                            e.stopPropagation()
                            const newList = (item.deliverables || []).filter((_, i) => i !== idx)
                            handleSaveEdit(item.id, 'deliverables', newList)
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
                        setDeliverablesPicker({ taskId: item.id, x: rect.left, y: rect.bottom })
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
                  )}
                </td>

                <td className="cell-task-type">
                  {(!item.children || item.children.length === 0) && (() => {
                    const { type, typeClass } = getTaskTypeInfo(item)
                    return <span className={`task-type-badge ${typeClass}`}>{type}</span>
                  })()}
                </td>
                
                <td>
                  <button 
                    className="delete-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteTask(item.id)
                    }}
                    title="删除任务"
                  >
                    ×
                  </button>
                </td>
                </tr>
              {expandedResourceId === item.id && item.resources && item.resources.length > 0 && item.resources.map((resource, idx) => (
                <tr key={`exp-${item.id}-${idx}`} className="expanded-resource-row">
                  <td style={{ width: '28%' }}></td>
                  <td style={{ width: '8%' }}></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div className="resource-item" style={{ display: 'inline-flex' }}>
                      <span className={`avatar ${!resource.name ? 'empty-avatar' : ''}`}>
                        {resource.name ? resource.avatar : '?'}
                      </span>
                      <div className="resource-info">
                        {resource.name ? (
                          <span className="resource-name">{resource.name}</span>
                        ) : (
                          <span className="resource-name empty-name">{resource.role} 待分配</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <span 
                      className="resource-hours"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleResourceHoursClick(e, item.id, idx, true)
                      }}
                    >
                      {formatHoursByUnit(resource.hours || 0, timeRuleUnit)}
                    </span>
                  </td>
                  <td>
                    <div className="duration-days">
                      {(() => {
                        const h = resource.hours || 0
                        return h > 0 ? Math.ceil(h / dailyInputHours) : '—'
                      })()}
                    </div>
                  </td>
                  <td></td>
                  <td></td>
                  <td className="expanded-delete-td">
                    <button
                      className="expanded-delete-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteResource(item.id, idx)
                        if (item.resources.length <= 1) {
                          setExpandedResourceId(null)
                        }
                      }}
                      title="删除资源"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
              </Fragment>
            ))}
          </tbody>
              </table>
            )}
        </div>
      </div>
      
      {hoursEditPopup && (
        <HoursEditPopup
          x={hoursEditPopup.x}
          y={hoursEditPopup.y}
          hours={findNode(treeData, hoursEditPopup.taskId)?.resources?.[hoursEditPopup.resourceIndex]?.hours || 0}
          ruleUnit={timeRuleUnit}
          ruleValue={timeRuleValue}
          onSave={(hours) => handleSaveResourceHours(hoursEditPopup.taskId, hoursEditPopup.resourceIndex, hours)}
          onClose={() => {
            setHoursEditPopup(null)
          }}
        />
      )}

      {editingResource && (
        <div
          ref={resourceSelectPopupRef}
          className="resource-select-popup"
          style={{ left: popupPosition.x, top: popupPosition.y }}
        >
          <CustomSelect
            isOpen={true}
            onClose={() => setEditingResource(null)}
            hideTrigger={true}
            value={(() => {
              if (editingResource?.resourceIndex === -1) return ''
              const task = findNode(treeData, editingResource.taskId)
              if (!task?.resources?.[editingResource.resourceIndex]) return ''
              const resource = task.resources[editingResource.resourceIndex]
              return resource.role ? `${resource.role}-${resource.name}` : ''
            })()}
            onChange={(value) => {
              const member = teamMembers.find(m => `${m.role}-${m.name}` === value)
              if (!member) return
              if (editingResource?.resourceIndex === -1) {
                const taskId = editingResource.taskId
                // 用「+ 按钮」的原始位置定位工时弹窗（popupPosition 可能已被翻转逻辑改掉）
                const pos = { ...resourceAddAnchorRef.current }
                const task = findNode(treeData, taskId)
                const newIdx = (task?.resources?.length || 0)
                setTreeData(prev => {
                  const t = findNode(prev, taskId)
                  if (!t) return prev
                  const newResources = [...(t.resources || []), { role: member.role || '', name: member.name || '', avatar: member.avatar || '', hours: 0 }]
                  return updateNode(prev, taskId, { resources: newResources })
                })
                setEditingResource(null)
                setHoursEditPopup({ taskId, resourceIndex: newIdx, x: pos.x, y: pos.y + 4 })
              } else {
                handleResourceMemberChange(editingResource.taskId, editingResource.resourceIndex, value)
              }
            }}
            options={teamMembers.map(m => ({
              value: `${m.role}-${m.name}`,
              role: m.role,
              name: m.name,
              avatar: m.avatar
            }))}
            placeholder="选择角色"
            disabledValues={(() => {
              const task = findNode(treeData, editingResource.taskId)
              if (!task?.resources) return []
              return task.resources
                .filter((_, i) => i !== editingResource.resourceIndex && _.role)
                .map(r => `${r.role}-${r.name}`)
            })()}
            onCreateRole={(newMember, onAssigned) => {
              const exists = teamMembers.some(m => m.role === newMember.role && m.name === newMember.name)
              if (!exists) {
                handleCreateAndAssignRole(editingResource.taskId, editingResource.resourceIndex, newMember)
              }
            }}
          />
        </div>
      )}

      {durationEditTask && (() => {
        const minDays = calcDefaultDurationDays(durationEditTask)
        const curVal = durationEditTask.customDurationDays !== undefined
          ? (parseFloat(durationEditTask.customDurationDays) || minDays)
          : minDays
        return (
          <div
            ref={durationEditPopupRef}
            className="duration-edit-popup"
            style={{
              position: 'fixed',
              left: popupPosition.x,
              top: popupPosition.y,
              zIndex: 1000
            }}
          >
            <div className="duration-edit-content">
              <div className="duration-edit-header">
                <span className="duration-edit-title">编辑工期</span>
                {durationEditTask.isCustomDuration && (
                  <button
                    type="button"
                    className="duration-auto-calc-text"
                    onClick={() => handleAutoCalculateDuration(durationEditTask.id)}
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
                      setDurationEditTask(prev => ({ ...prev, customDurationDays: Math.max(minDays, Math.floor(parseFloat(curVal) || minDays) - 1) }))
                    }}
                  >−</button>
                  <input
                    type="number"
                    min={minDays}
                    step="1"
                    className="stepper-input"
                    value={durationEditTask.customDurationDays !== undefined
                      ? durationEditTask.customDurationDays
                      : minDays}
                    onChange={(e) => {
                      setDurationEditTask(prev => ({ ...prev, customDurationDays: e.target.value }))
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="stepper-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDurationEditTask(prev => ({ ...prev, customDurationDays: Math.floor(parseFloat(curVal) || minDays) + 1 }))
                    }}
                  >+</button>
                </div>
                <span className="duration-edit-unit">天</span>
                <button className="btn-save time-rule-confirm-btn" onClick={() => handleSaveDurationDays(durationEditTask.id, durationEditTask.customDurationDays)} title="确定" aria-label="确定">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )
      })()}
      
      {predecessorModal && (
        <div
          ref={predecessorPopupRef}
          className="predecessor-edit-popup-container"
          style={{
            position: 'fixed',
            left: popupPosition.x,
            top: popupPosition.y,
            zIndex: 1000
          }}
        >
          <PredecessorEditPopup
            task={findNode(treeData, predecessorModal.taskId)}
            allTasks={getLeafTasksInfo(treeData)}
            editingPredecessor={predecessorModal.predecessorId}
            onSave={(newPredecessorId) => {
              if (predecessorModal.predecessorId) {
                setTreeData(prev => {
                  const task = findNode(prev, predecessorModal.taskId)
                  const newPredecessors = task?.predecessors?.map(p =>
                    p === predecessorModal.predecessorId ? newPredecessorId : p
                  ) || []
                  persistTask(predecessorModal.taskId, { predecessors: newPredecessors })
                  return updateNode(prev, predecessorModal.taskId, { predecessors: newPredecessors })
                })
              } else {
                setTreeData(prev => {
                  const task = findNode(prev, predecessorModal.taskId)
                  const newPredecessors = [...(task?.predecessors || []), newPredecessorId]
                  persistTask(predecessorModal.taskId, { predecessors: newPredecessors })
                  return updateNode(prev, predecessorModal.taskId, { predecessors: newPredecessors })
                })
              }
              setPredecessorModal(null)
            }}
            onClose={() => setPredecessorModal(null)}
          />
        </div>
      )}

      {deliverablesPicker && (
        (() => {
          const task = findNode(treeData, deliverablesPicker.taskId)
          if (!task) return null
          const existing = task.deliverables || []
          const allNames = projectDeliverablesCatalog
          const keyword = deliverablesSearch.trim().toLowerCase()
          const filtered = allNames
            .filter(n => !existing.includes(n))
            .filter(n => !keyword || n.toLowerCase().includes(keyword))
          const showCreate = keyword && !allNames.some(n => n.toLowerCase() === keyword)
          const addDeliverable = (name) => {
            const clean = (name || '').trim()
            if (!clean || existing.includes(clean)) return
            handleSaveEdit(task.id, 'deliverables', [...existing, clean])
            addDeliverableNameToCatalog(clean)
          }
          return (
            <div
              ref={deliverablesPickerRef}
              className="deliverables-picker"
              style={{ position: 'fixed', left: deliverablesPicker.x, top: deliverablesPicker.y + 4, zIndex: 1000 }}
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
                {filtered.length === 0 && !showCreate && (
                  <div className="deliverables-picker-empty">暂无可选文件名称</div>
                )}
                {filtered.map(name => (
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
                {showCreate && (
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
          )
        })()
      )}

      {connectingFrom && (
        <div className="connection-hint">
          正在设置依赖: 从 {findNode(treeData, connectingFrom.id)?.code} {findNode(treeData, connectingFrom.id)?.name}
          {connectingFrom.type === 'out' ? ' 引出依赖到目标任务' : ' 引入来自目标任务的依赖'}，点击目标任务完成连接或按 Esc 取消
        </div>
      )}

      {connectingTo && (
        <div className="connection-hint">
          正在引出依赖: 从 {findNode(treeData, connectingTo)?.code} {findNode(treeData, connectingTo)?.name}
          引出到目标任务，点击目标任务完成连接或按 Esc 取消
        </div>
      )}

      {showDeleteConfirmModal && (
        <div className="time-rule-confirm-overlay" onClick={() => { setShowDeleteConfirmModal(false); setPendingDeleteItemId(null) }}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">该任务下有 {pendingDeleteCount} 个子任务也会一起删除，是否确定要删除？</p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => { setShowDeleteConfirmModal(false); setPendingDeleteItemId(null) }}>取消</button>
              <button className="btn-save" onClick={() => { setShowDeleteConfirmModal(false); executeDeleteTask(pendingDeleteItemId); setPendingDeleteItemId(null) }}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {showDetailPopup && detailTaskId && (() => {
        const detailTask = findNode(treeData, detailTaskId)
        if (!detailTask) return null
        // 排期页计算的日期不回写任务树：任务树节点没有 start_date/end_date 时，
        // 用排期结果映射（scheduleDateMap）兜底，保证详情弹窗能看到已排的起止时间
        const detailDates = scheduleDateMap?.[detailTask.task_ulid || detailTask.id] || scheduleDateMap?.[detailTask.id] || {}
        return (
          <TaskDetailPopup
            task={{
              ...detailTask,
              ancestors: findTaskPath(treeData, detailTaskId) || [],
              start_hour: detailTask.start_hour ?? detailDates.startHour ?? null,
              end_hour: detailTask.end_hour ?? detailDates.endHour ?? null,
              totalHours: (() => {
                const calc = (n) => {
                  if (n.children && n.children.length > 0) return n.children.reduce((s, c) => s + calc(c), 0)
                  return (n.resources || []).reduce((s, r) => s + (r.hours || 0), 0)
                }
                return calc(detailTask)
              })(),
              taskType: detailTask.taskType || getTaskTypeInfo(detailTask).type,
            }}
            scheduleStartDate={detailTask.start_date || detailDates.startDate || null}
            scheduleEndDate={detailTask.end_date || detailDates.endDate || null}
            onBackToParent={() => {
              const parent = findTaskParent(treeData, detailTaskId)
              if (parent) setDetailTaskId(parent.id)
            }}
            execStatus={statusOf ? statusOf(detailTask) : undefined}
            onClose={() => {
              setShowDetailPopup(false)
              const closedTaskId = detailTaskId
              setDetailTaskId(null)
              // 归还键盘焦点到任务行：否则弹窗关闭后 activeElement 为 BODY，
              // 行级快捷键（Tab/Enter/Delete…）全部失效
              if (closedTaskId && rowRefs.current[closedTaskId]) {
                rowRefs.current[closedTaskId].focus()
              }
            }}
            teamMembers={teamMembers}
            timeRuleUnit={timeRuleUnit}
            timeRuleValue={timeRuleValue}
            scheduleDateMap={scheduleDateMap}
            onResourceMemberChange={handleResourceMemberChange}
            onResourceHoursChange={handleResourceHoursChange}
            onResourceDelete={handleDeleteResource}
            onAddResource={handleAddTaskResource}
            dailyInputHours={dailyInputHours}
            skipHolidays={skipHolidays}
            onUpdateDuration={(taskId, days) => {
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                const patch = { customDurationDays: days }
                // 工期变化联动重算结束日期（保持开始日期不变）
                if (task.start_date) patch.end_date = computeEndFromDuration(task.start_date, days, effSkipOf(task))
                persistTask(taskId, patch)
                return updateNode(prev, taskId, patch)
              })
            }}
            onAutoCalcDuration={(taskId) => {
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                const patch = { customDurationDays: null }
                // 恢复自动计算后按工时推算的工期重算结束日期
                if (task.start_date) {
                  const autoDays = autoDurationDaysOf(task, dailyInputHours)
                  if (autoDays) patch.end_date = computeEndFromDuration(task.start_date, autoDays, effSkipOf(task))
                }
                persistTask(taskId, patch)
                return updateNode(prev, taskId, patch)
              })
            }}
            onUpdateHours={(taskId, which, val) => {
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                const patch = which === 'start' ? { start_hour: val } : { end_hour: val }
                persistTask(taskId, patch)
                return updateNode(prev, taskId, patch)
              })
            }}
            onUpdateSkipHolidays={(taskId, flag) => {
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                const patch = { skip_holidays: flag }
                // 切换规则后按开始日期+工期重新推算结束日期
                if (task.start_date) {
                  const days = task.customDurationDays > 0 ? task.customDurationDays : (autoDurationDaysOf(task, dailyInputHours) || 0)
                  if (days > 0) patch.end_date = computeEndFromDuration(task.start_date, days, flag)
                }
                persistTask(taskId, patch)
                return updateNode(prev, taskId, patch)
              })
            }}
            onUpdateDates={(taskId, startDate, endDate) => {
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                persistTask(taskId, { start_date: startDate, end_date: endDate })
                return updateNode(prev, taskId, { start_date: startDate, end_date: endDate })
              })
            }}
            onUpdateDeliverables={(taskId, deliverables) => {
              upsertTaskContent(projectId, taskId, { deliverables }).catch(e => console.error('upsertTaskContent failed:', e))
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                persistTask(taskId, { deliverables })
                return updateNode(prev, taskId, { deliverables })
              })
            }}
            onUpdateDescription={(taskId, description) => {
              upsertTaskContent(projectId, taskId, { description }).catch(e => console.error('upsertTaskContent failed:', e))
              setTreeData(prev => {
                const task = findNode(prev, taskId)
                if (!task) return prev
                persistTask(taskId, { description })
                return updateNode(prev, taskId, { description })
              })
            }}
            deliverablesCatalog={projectDeliverablesCatalog}
            onAddDeliverableToCatalog={(item) => {
              setProjectDeliverablesCatalog(prev => [...prev, item])
            }}
          />
        )
      })()}

      {rewireToast && createPortal(
        <div className="member-list-toast">{rewireToast}</div>,
        document.body
      )}

    </div>
  )
}

export default WbsBreakdown