import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { getProjectById, getProjectMembers, getProjectWbsTreeByVersion, getLatestPlanTree, getVersionsByProject, ensureOriginalTaskIds, getExecStatusByProject, setTaskExecStatusAndProgress, getTaskDynamicsByProject, addTaskDynamicRecord, updateProjectMember, renameMemberResources, renameRoleInResources, deleteProjectMember, deleteUnassignedResourcesByRole, getTaskContentByProject, upsertTaskContent, updateRecord } from '../utils/db'
import ProjectSchedule from './ProjectSchedule'
import MemberList from './MemberList'
import { formatHoursByUnit } from './HoursEditPopup'
import DateRangeCalendar from './DateRangeCalendar'
import MemberMultiSelect from './MemberMultiSelect'
import { themeColors, calcGroupDurationDays } from '../utils/schedule'
import TaskDetailPopup from './TaskDetailPopup'
import ExecStatusDot from './ExecStatusDot'
import { isNonWorkDay } from '../utils/holidays'
import { deriveExecStatus, resolveExecStatus, resolveProgress, EXEC_STATUS } from '../utils/execStatus'

// 任务执行状态徽标（表格/看板等视图共用）：小号圆角标签
function ExecStatusBadge({ status }) {
  const meta = EXEC_STATUS[status]
  if (!meta) return null
  return (
    <span
      className="exec-status-badge"
      style={{ display: 'inline-block', padding: '1px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, lineHeight: '18px', background: meta.bg, color: meta.color, whiteSpace: 'nowrap' }}
      title={`任务状态：${meta.label}`}
    >{meta.label}</span>
  )
}

// 任务状态筛选选项（甘特/表格/看板/日历四个视图筛选区共用）
const EXEC_STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  { value: 'not_started', label: '未开始' },
  { value: 'delayed', label: '已延误' },
  { value: 'in_progress', label: '进行中' },
  { value: 'completed', label: '已完成' }
]

function ProjectHome({ onHeaderInfo }) {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [project, setProject] = useState(null)
  const [members, setMembers] = useState([])
  const [wbsTreeData, setWbsTreeData] = useState([])
  const [displayedVersion, setDisplayedVersion] = useState(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('tasks')
  const [projectStatus, setProjectStatus] = useState(null) // 'no_tasks' | 'draft_only' | 'published'
  const [draftTaskCount, setDraftTaskCount] = useState(0)
  // 当前展示的计划版本号（用于顶部导航条「计划版本」）：已发布取版本名，未发布显示「草稿」
  const [planVersionLabel, setPlanVersionLabel] = useState('')
  // 是否存在已发布版本的进度计划：false 时顶部导航条第二行只显示成员数量
  const [hasPublishedVersion, setHasPublishedVersion] = useState(false)
  const [memberSidebarOpen, setMemberSidebarOpen] = useState(false)
  const [dateRangeFilter, setDateRangeFilter] = useState(null)
  const [dateRangeOpen, setDateRangeOpen] = useState(false)
  const dateRangeRef = useRef(null)
  const [levelFilter, setLevelFilter] = useState('all')
  const [levelDropdownOpen, setLevelDropdownOpen] = useState(false)
  const levelDropdownRef = useRef(null)
  // 任务状态筛选：'all' | 'not_started' | 'delayed' | 'in_progress' | 'completed'
  const [execStatusFilter, setExecStatusFilter] = useState('all')
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const statusDropdownRef = useRef(null)
  // 看板视图分组方式：'parent' 按一级任务 | 'status' 按任务状态
  const [kanbanGroupBy, setKanbanGroupBy] = useState('parent')
  const [groupByDropdownOpen, setGroupByDropdownOpen] = useState(false)
  const groupByDropdownRef = useRef(null)
  const [selectedMembers, setSelectedMembers] = useState([])
  const memberMultiSelectRef = useRef(null)
  const [calendarDate, setCalendarDate] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1) })
  const [selectedCalendarTask, setSelectedCalendarTask] = useState(null)
  const [selectedKanbanTask, setSelectedKanbanTask] = useState(null)
  // 任务执行状态（手动值，original_task_id → 'in_progress'|'completed'）与任务动态记录（task_dynamics store）
  const [execStatusMap, setExecStatusMap] = useState(new Map())
  const [progressMap, setProgressMap] = useState(new Map())
  const [dynamicsMap, setDynamicsMap] = useState(new Map())
  // 任务内容层（任务描述 / 可交付成果，task_content store，original_task_id → 行）：
  // 执行层内容跨版本存储，主页弹窗可直接编辑，不触发进度计划版本变更
  const [taskContentRows, setTaskContentRows] = useState([])
  // 进度动态防抖计时器 / 最新进度值缓存（拖拽连续触发时只在停止后写一条动态）
  const dynTimerRef = useRef({})
  const latestProgressRef = useRef({})
  // 项目数据被清空后的成功提示（侧边栏「清空项目数据」确认后触发）
  const [clearedToast, setClearedToast] = useState('')

  // 编辑成员（成员侧栏「编辑」）：更新成员姓名/角色，并同步该成员在全部任务资源中的姓名
  // 待分配成员（无姓名）也允许编辑：按角色匹配其占位的任务资源并写入新姓名
  const handleRenameMember = async (role, oldName, newName, newRole) => {
    try {
      const target = members.find(m =>
        m.role === role && (m.name === oldName || (!m.name && !oldName))
      )
      const newAvatar = newName ? newName.charAt(0).toUpperCase() : ''
      // 更新成员记录（待分配占位若无成员记录则跳过，仅更新任务资源）
      if (target?.member_ulid) {
        const updates = { member_ulid: target.member_ulid, display_name: newName }
        if (newRole && newRole !== role) {
          updates.job_role = newRole
        }
        await updateProjectMember(updates)
      }
      // 同步任务资源姓名（待分配按角色匹配占位资源），任务详情弹窗显示新姓名
      await renameMemberResources(projectId, oldName, newName, newAvatar, role, newRole)
      // 重载成员与任务树，侧栏与任务详情同步刷新
      await loadProjectData()
    } catch (e) {
      console.error('编辑成员失败:', e)
      alert('修改成员信息失败，请重试')
    }
  }

  // 成员角色口径（与 loadProjectData 的展示逻辑一致）：job_role 优先，OWNER 兜底「项目经理」
  const memberRoleOf = (m) => m.job_role || (m.role === 'OWNER' ? '项目经理' : '未分组')

  // 重命名角色：更新成员表 job_role，并同步任务资源中的角色名
  const handleRenameRole = async (oldRole, newRole) => {
    try {
      const rows = await getProjectMembers(projectId)
      for (const m of rows) {
        if (memberRoleOf(m) === oldRole) {
          await updateProjectMember({ member_ulid: m.member_ulid, job_role: newRole })
        }
      }
      await renameRoleInResources(projectId, oldRole, newRole)
      await loadProjectData()
    } catch (e) {
      console.error('重命名角色失败:', e)
      alert('重命名角色失败，请重试')
    }
  }

  // 删除角色：仅空角色会走到这里（有成员时 MemberList 已拦截），删除成员记录及未分配占位资源
  const handleDeleteRole = async (role) => {
    try {
      const rows = await getProjectMembers(projectId)
      for (const m of rows) {
        if (memberRoleOf(m) === role) {
          await deleteProjectMember(m.member_ulid)
        }
      }
      await deleteUnassignedResourcesByRole(projectId, role)
      await loadProjectData()
    } catch (e) {
      console.error('删除角色失败:', e)
      alert('删除角色失败，请重试')
    }
  }

  // 删除成员：删除成员记录（有任务的成员已在 MemberList 拦截，不会走到这里）
  const handleDeleteMember = async (role, memberName) => {
    try {
      const rows = await getProjectMembers(projectId)
      const target = rows.find(m => memberRoleOf(m) === role && (m.display_name || '') === memberName)
      if (target) {
        await deleteProjectMember(target.member_ulid)
      }
      await loadProjectData()
    } catch (e) {
      console.error('删除成员失败:', e)
      alert('删除成员失败，请重试')
    }
  }

  // 卸载时清理未触发的防抖计时器
  useEffect(() => () => {
    Object.values(dynTimerRef.current).forEach(t => clearTimeout(t))
  }, [])
  // 表格视图：资源需求列展开子行的任务 id（复用 WBS 分解页面 expanded-resource-row 样式）
  const [expandedResourceId, setExpandedResourceId] = useState(null)

  useEffect(() => {
    loadProjectData()
  }, [projectId])

  // 侧边栏等处修改项目信息（如项目名称）后同步刷新本项目页头数据
  useEffect(() => {
    const handler = async () => {
      try {
        const fresh = await getProjectById(projectId)
        if (fresh) setProject(prev => (prev ? { ...prev, name: fresh.name, description: fresh.description } : fresh))
      } catch (e) {
        console.error('刷新项目信息失败:', e)
      }
    }
    window.addEventListener('pmflow:projects-changed', handler)
    return () => window.removeEventListener('pmflow:projects-changed', handler)
  }, [projectId])

  // 侧边栏「清空项目数据」确认后：重载本项目数据并展示清空成功提示
  useEffect(() => {
    const handler = (e) => {
      const clearedId = e.detail?.projectId
      if (!clearedId || clearedId !== projectId) return
      loadProjectData()
      setClearedToast('项目数据已清空')
      setTimeout(() => setClearedToast(''), 3000)
    }
    window.addEventListener('pmflow:project-data-cleared', handler)
    return () => window.removeEventListener('pmflow:project-data-cleared', handler)
  }, [projectId])

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
    if (!groupByDropdownOpen) return
    const handleClickOutside = (e) => {
      if (groupByDropdownRef.current && !groupByDropdownRef.current.contains(e.target) &&
          !e.target.closest('.gantt-filter-dropdown')) {
        setGroupByDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [groupByDropdownOpen])

  // 任务状态筛选：触发器 + 下拉（表格/看板/日历工具栏复用；同一时刻仅一个视图挂载）
  const statusFilterItem = (
    <div className="gantt-filter-item" ref={statusDropdownRef}>
      <span className="gantt-filter-label">任务状态</span>
      <div className="gantt-filter-trigger" onClick={() => setStatusDropdownOpen(v => !v)}>
        <span className="gantt-filter-value">{EXEC_STATUS_FILTER_OPTIONS.find(o => o.value === execStatusFilter)?.label || '全部状态'}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </div>
    </div>
  )
  const statusFilterDropdown = statusDropdownOpen && createPortal(
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
  )

  async function loadProjectData() {
    setLoading(true)
    try {
      const projectData = await getProjectById(projectId)
      setProject(projectData)
      if (projectData) {
        const [memberData, versions] = await Promise.all([
          getProjectMembers(projectId),
          getVersionsByProject(projectId)
        ])
        const formatted = memberData.map(m => ({
          member_ulid: m.member_ulid,
          role: m.job_role || (m.role === 'OWNER' ? '项目经理' : '未分组'),
          name: m.display_name || '',
          avatar: m.display_name ? m.display_name.charAt(0).toUpperCase() : ''
        }))
        setMembers(formatted)

        // 获取项目原始任务数据，判断是否有任务
        const originalTree = await getLatestPlanTree(projectId)
        const hasTaskData = originalTree.length > 0

        if (!hasTaskData) {
          // 没有任务数据
          setProjectStatus('no_tasks')
          setWbsTreeData([])
          setDisplayedVersion(null)
          setPlanVersionLabel('')
          setHasPublishedVersion(false)
        } else {
          // 有任务数据，检查版本状态
          const isPublished = (v) => v.is_draft === 0 || v.is_draft === false || v.status === '正式版'
          const sortByTime = (a, b) => {
            const ta = a.release_time || a.updated_at || a.created_at || ''
            const tb = b.release_time || b.updated_at || b.created_at || ''
            return tb.localeCompare(ta)
          }
          const publishedVersions = versions.filter(isPublished).sort(sortByTime)

          if (publishedVersions.length > 0) {
            // 有发布状态的版本，显示最新发布版本
            const published = publishedVersions[0]
            setHasPublishedVersion(true)
            const versionTree = await getProjectWbsTreeByVersion(published.version_ulid)
            if (versionTree.length > 0) {
              setProjectStatus('published')
              setWbsTreeData(versionTree)
              setDisplayedVersion(published)
              setPlanVersionLabel(published.version_name || '')
            } else {
              // 发布版本快照不存在，兜底显示原始任务
              setProjectStatus('published')
              setWbsTreeData(originalTree)
              setDisplayedVersion(null)
              setPlanVersionLabel(published.version_name || '')
            }
          } else if (versions.length > 0) {
            // 没有发布版本，只有草稿版本
            const draftVersions = versions.filter(v => !isPublished(v))
            const draftCount = originalTree.reduce((count, node) => {
              const countNodes = (n) => {
                let c = 1
                if (n.children) n.children.forEach(child => c += countNodes(child))
                return c
              }
              return count + countNodes(node)
            }, 0)
            setProjectStatus('draft_only')
            setDraftTaskCount(draftCount)
            setWbsTreeData(originalTree)
            setDisplayedVersion(null)
            setPlanVersionLabel('草稿')
            setHasPublishedVersion(false)
          } else {
            // 有任务但无版本记录（原始任务）
            setProjectStatus('published')
            setWbsTreeData(originalTree)
            setDisplayedVersion(null)
            setPlanVersionLabel('草稿')
            setHasPublishedVersion(false)
          }
        }

        // 任务执行状态 / 任务动态 / 任务内容层（独立 store，按逻辑任务 original_task_id 跨版本存储）
        try {
          await ensureOriginalTaskIds(projectId)
          const [execRows, dynRows, contentRows] = await Promise.all([
            getExecStatusByProject(projectId),
            getTaskDynamicsByProject(projectId),
            getTaskContentByProject(projectId).catch(() => [])
          ])
          const eMap = new Map()
          const pMap = new Map()
          // 按 updated_at 升序写入：同一任务若有历史重复行（并发拖动竞态产生），最新值最后落 Map、优先生效
          const sortedExecRows = [...execRows].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))
          for (const r of sortedExecRows) {
            if (r.exec_status) eMap.set(r.original_task_id, r.exec_status)
            if (r.progress !== null && r.progress !== undefined) pMap.set(r.original_task_id, r.progress)
          }
          setExecStatusMap(eMap)
          setProgressMap(pMap)
          const dMap = new Map()
          for (const r of dynRows) {
            if (!dMap.has(r.original_task_id)) dMap.set(r.original_task_id, [])
            dMap.get(r.original_task_id).push(r)
          }
          setDynamicsMap(dMap)
          setTaskContentRows(contentRows || [])
        } catch (e) {
          console.error('加载任务执行状态/动态失败', e)
        }
      }
    } catch (error) {
      console.error('Failed to load project data:', error)
    }
    setLoading(false)
  }

  // 甘特图的「跳过节假日」以当前显示的版本 schedule_rules 为准，
  // 兜底使用项目记录上的 skip_holidays（避免版本未保存时丢失设置）
  const displaySkipHolidays = useMemo(() => {
    if (displayedVersion) {
      try {
        const rules = JSON.parse(displayedVersion.schedule_rules || '{}')
        if (rules.skip_holidays != null) return !!rules.skip_holidays
      } catch (e) { /* ignore */ }
    }
    return !!project?.skip_holidays
  }, [displayedVersion, project])

  // 日历任务条按小时占比换算宽度：以当前显示版本的每日投入工时为准，兜底项目记录，再兜底 8
  const displayDailyInputHours = useMemo(() => {
    if (displayedVersion) {
      try {
        const rules = JSON.parse(displayedVersion.schedule_rules || '{}')
        if (rules.daily_input_hours != null && Number(rules.daily_input_hours) > 0) return Number(rules.daily_input_hours)
      } catch (e) { /* ignore */ }
    }
    const ph = Number(project?.daily_input_hours)
    return ph > 0 ? ph : 8
  }, [displayedVersion, project])

  const startDate = useMemo(() => {
    if (project?.start_date) return project.start_date
    let earliest = null
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.start_date && (!earliest || n.start_date < earliest)) earliest = n.start_date
        if (n.children) walk(n.children)
      }
    }
    walk(wbsTreeData)
    return earliest || new Date().toISOString().slice(0, 10)
  }, [project, wbsTreeData])

  const endDate = useMemo(() => {
    if (project?.end_date) return project.end_date
    let latest = null
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.end_date && (!latest || n.end_date > latest)) latest = n.end_date
        if (n.children) walk(n.children)
      }
    }
    walk(wbsTreeData)
    return latest || null
  }, [project, wbsTreeData])

  const tabs = [
    { key: 'tasks', label: '甘特图' },
    { key: 'table', label: '表格' },
    { key: 'kanban', label: '看板' },
    { key: 'calendar', label: '日历' }
  ]

  const ganttMaxDepth = useMemo(() => {
    let max = 0
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        if (depth > max) max = depth
        if (n.children) walk(n.children, depth + 1)
      }
    }
    walk(wbsTreeData, 1)
    return max
  }, [wbsTreeData])

  const ganttLevelOptions = useMemo(() => {
    const opts = [{ value: 'all', label: '全部任务' }]
    for (let d = 1; d <= Math.max(1, ganttMaxDepth); d++) {
      opts.push({ value: d, label: `${d}级任务` })
    }
    opts.push({ value: 'leaf', label: '执行层级' })
    return opts
  }, [ganttMaxDepth])

  // 任务层级筛选按视图差异化：
  // 看板固定为执行层级（不可切换）；日历仅可选 1级任务/执行层级，默认执行层级；甘特/表格为完整选项
  const levelOptionsForTab = useMemo(() => {
    if (activeTab === 'calendar') {
      return [
        { value: 1, label: '1级任务' },
        { value: 'leaf', label: '执行层级' }
      ]
    }
    return ganttLevelOptions
  }, [activeTab, ganttLevelOptions])

  const effectiveLevelFilter = useMemo(() => {
    if (activeTab === 'kanban') return 'leaf'
    if (activeTab === 'calendar') {
      // 日历默认选中执行层级；仅当共享值为 1 级任务时保持，其余（全部/中间层级）回落为执行层级
      if (levelFilter === 1) return 1
      return 'leaf'
    }
    return levelFilter
  }, [activeTab, levelFilter])

  // 任务内容层索引：original_task_id → 最新内容行（描述/可交付成果）
  const contentMap = useMemo(() => {
    const m = new Map()
    for (const r of taskContentRows || []) {
      if (!r || !r.original_task_id) continue
      const prev = m.get(String(r.original_task_id))
      if (!prev || String(prev.updated_at || '') < String(r.updated_at || '')) m.set(String(r.original_task_id), r)
    }
    return m
  }, [taskContentRows])

  // 主页弹窗编辑任务描述 / 可交付成果：写入任务内容层（跨版本，不触发进度计划版本变更），
  // 并把返回行合并进本地状态，flatTasks 覆盖后弹窗/各视图立即刷新
  const mergeContentRow = (row) => {
    if (!row) return
    setTaskContentRows(prev => {
      const others = prev.filter(r => r.original_task_id !== row.original_task_id)
      return [...others, row]
    })
  }
  const handleUpdateTaskDescription = useCallback((taskId, description) => {
    if (!projectId) return
    upsertTaskContent(projectId, taskId, { description })
      .then(mergeContentRow)
      .catch(e => console.error('upsertTaskContent failed:', e))
  }, [projectId])
  const handleUpdateTaskDeliverables = useCallback((taskId, deliverables) => {
    if (!projectId) return
    upsertTaskContent(projectId, taskId, { deliverables })
      .then(mergeContentRow)
      .catch(e => console.error('upsertTaskContent failed:', e))
  }, [projectId])

  const flatTasks = useMemo(() => {
    const calcNodeTotalHours = (node) => {
      if (node.children && node.children.length > 0) {
        return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
      }
      return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
    }
    // 非叶子结点的计划开展时间 = 子节点（递归至叶子）最早开始时间 / 最晚结束时间
    // 小时取提供该日期的节点值：同日开始取更早的 start_hour，同日结束取更晚的 end_hour
    const computeAggRange = (node) => {
      if (!node.children || node.children.length === 0) {
        return (node.start_date || node.end_date) ? { sd: node.start_date || null, sh: node.start_hour ?? null, ed: node.end_date || null, eh: node.end_hour ?? null } : null
      }
      let sd = null, sh = null, ed = null, eh = null
      for (const c of node.children) {
        const r = computeAggRange(c)
        if (!r) continue
        if (r.sd && (sd == null || r.sd < sd || (r.sd === sd && r.sh != null && (sh == null || r.sh < sh)))) { sd = r.sd; sh = r.sh }
        if (r.ed && (ed == null || r.ed > ed || (r.ed === ed && r.eh != null && (eh == null || r.eh > eh)))) { ed = r.ed; eh = r.eh }
      }
      return (sd || ed) ? { sd, sh, ed, eh } : null
    }
    const result = []
    // 任务内容层覆盖（递归到子树）：弹窗下钻子任务从 task.children 取节点，
    // 描述/可交付成果必须一并覆盖为 task_content 最新值，否则下钻弹窗显示旧数据
    const overlayNode = (node) => {
      const crow = contentMap.get(String(node.id)) || contentMap.get(String(node.task_ulid || ''))
      if (!crow) {
        return (node.children && node.children.length > 0)
          ? { ...node, children: node.children.map(overlayNode) }
          : node
      }
      return {
        ...node,
        ...('description' in crow ? { description: crow.description } : {}),
        ...('deliverables' in crow ? { deliverables: crow.deliverables || [] } : {}),
        ...(node.children && node.children.length > 0 ? { children: node.children.map(overlayNode) } : {})
      }
    }
    const walk = (nodes, level) => {
      for (const raw of nodes || []) {
        const n = overlayNode(raw)
        const totalHours = calcNodeTotalHours(n)
        const hasCustomDuration = n.customDurationDays !== undefined && n.customDurationDays > 0
        let taskType = '等待'
        if (n.taskType === '里程碑') {
          taskType = '里程碑'
        } else if (totalHours !== 0 && !hasCustomDuration) {
          taskType = '执行'
        } else if (totalHours !== 0 && hasCustomDuration) {
          taskType = '跟进'
        }
        const agg = (n.children && n.children.length > 0) ? computeAggRange(n) : null
        result.push({
          ...n, level, taskType, totalHours,
          ...(agg ? { start_date: agg.sd, end_date: agg.ed, start_hour: agg.sh, end_hour: agg.eh } : {})
        })
        if (n.children) walk(n.children, level + 1)
      }
    }
    walk(wbsTreeData, 0)
    return result
  }, [wbsTreeData, taskContentRows])

  // 可交付成果目录（主页弹窗成果选择器用）：项目记录目录 + 树内已用成果去重合并
  const deliverablesCatalogMerged = useMemo(() => {
    const fromTree = []
    for (const t of flatTasks || []) {
      (t.deliverables || []).forEach(d => { if (d) fromTree.push(d) })
    }
    return Array.from(new Set([...(project?.deliverables_catalog || []), ...fromTree]))
  }, [flatTasks, project])

  // 新建成果名称时持久化到项目记录的 deliverables_catalog（与排期流程各页同口径）
  const handleAddDeliverableToCatalog = useCallback((name) => {
    const clean = (name || '').trim()
    if (!clean || !projectId) return
    getProjectById(projectId).then(p => {
      if (!p) return
      const catalog = p.deliverables_catalog || []
      if (!catalog.includes(clean)) {
        updateRecord('projects', { ...p, deliverables_catalog: [...catalog, clean] })
      }
    }).catch(() => {})
    setProject(prev => {
      if (!prev) return prev
      const catalog = prev.deliverables_catalog || []
      if (catalog.includes(clean)) return prev
      return { ...prev, deliverables_catalog: [...catalog, clean] }
    })
  }, [projectId])

  // 任务 key → { parent: 父任务节点, chain: 祖先名称链（根→父） }（预览弹窗「返回上一级」与路径行用）
  const parentMap = useMemo(() => {
    const map = new Map()
    const walk = (nodes, parent, chain) => {
      for (const n of nodes || []) {
        map.set(String(n.task_ulid || n.id), { parent: parent || null, chain })
        if (n.children) walk(n.children, n, [...chain, n.name])
      }
    }
    walk(wbsTreeData, null, [])
    return map
  }, [wbsTreeData])

  // 追加一条动态到 dynamicsMap（taskId 与 DB 存储口径一致：original_task_id 链）
  const appendDynamics = (taskId, record) => {
    setDynamicsMap(prev => {
      const next = new Map(prev)
      next.set(taskId, [...(next.get(taskId) || []), record])
      return next
    })
  }

  // 新增任务动态：每次提交向 task_dynamics store 写入一条记录（按逻辑任务跨版本存储）
  async function addTaskDynamic(task, text) {
    const taskId = String(task.original_task_id || task.task_ulid || task.id)
    try {
      const record = await addTaskDynamicRecord(projectId, taskId, text)
      appendDynamics(taskId, record)
    } catch (e) {
      console.error('保存任务动态失败', e)
    }
  }

  // 手动设置/清除任务执行状态：状态↔进度联动（进行中/恢复自动→进度0；已完成→进度100）+ 动态记录
  async function handleSetExecStatus(task, status) {
    // 手动状态按逻辑任务身份 original_task_id 存储（跨版本延续）；缺省退化到 task_ulid/id
    const taskId = String(task.original_task_id || task.task_ulid || task.id)
    const prevProgress = progressMap.get(taskId) ?? 0
    const newProgress = status === 'completed' ? 100 : 0
    try {
      await setTaskExecStatusAndProgress(projectId, taskId, status, newProgress)
      setExecStatusMap(prev => {
        const next = new Map(prev)
        if (status) next.set(taskId, status)
        else next.delete(taskId)
        return next
      })
      setProgressMap(prev => {
        const next = new Map(prev)
        next.set(taskId, newProgress)
        return next
      })
      const statusLabel = status ? `任务状态手动改为「${EXEC_STATUS[status].label}」` : '任务状态恢复系统自动判定'
      const text = prevProgress !== newProgress ? `${statusLabel}，完成进度设为 ${newProgress}%` : statusLabel
      const record = await addTaskDynamicRecord(projectId, taskId, text, 'auto')
      appendDynamics(taskId, record)
      // 状态联动已直接落进度，取消尚未写入的防抖进度动态，避免重复记录
      if (dynTimerRef.current[taskId]) {
        clearTimeout(dynTimerRef.current[taskId])
        delete dynTimerRef.current[taskId]
      }
    } catch (e) {
      console.error('设置任务状态失败', e)
    }
  }

  // 手动设置任务完成进度（0-100 整数）；状态联动：
  // - 当前未开始/已延误且进度 >0 → 自动变为进行中；进度 =100 → 自动变为已完成
  // - 进行中时进度调回 0 保持进行中；已完成时禁止修改
  // 拖拽会连续触发，进度动态防抖 800ms 只在停止后写一条
  async function handleSetProgress(task, value) {
    const taskId = String(task.original_task_id || task.task_ulid || task.id)
    const prevProgress = progressMap.get(taskId) ?? 0
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
    const orig = task.original_task_id
    const ulid = task.task_ulid || task.id
    const manual = (orig && execStatusMap.has(String(orig))) ? execStatusMap.get(String(orig))
      : (ulid && execStatusMap.has(String(ulid))) ? execStatusMap.get(String(ulid)) : null
    const curStatus = deriveExecStatus(task, manual)
    if (curStatus === 'completed') return
    if (v === prevProgress) return
    let newManual = manual
    let statusAuto = null
    if (v === 100) {
      newManual = 'completed'
      statusAuto = 'completed'
    } else if (v > 0 && (curStatus === 'not_started' || curStatus === 'delayed')) {
      newManual = 'in_progress'
      statusAuto = 'in_progress'
    }
    try {
      await setTaskExecStatusAndProgress(projectId, taskId, newManual, v)
      setExecStatusMap(prev => {
        const next = new Map(prev)
        if (newManual) next.set(taskId, newManual)
        else next.delete(taskId)
        return next
      })
      setProgressMap(prev => {
        const next = new Map(prev)
        next.set(taskId, v)
        return next
      })
      latestProgressRef.current[taskId] = v
      if (statusAuto) {
        const record = await addTaskDynamicRecord(projectId, taskId, `完成进度变更，任务状态自动改为「${EXEC_STATUS[statusAuto].label}」`, 'auto')
        appendDynamics(taskId, record)
      }
      if (dynTimerRef.current[taskId]) clearTimeout(dynTimerRef.current[taskId])
      dynTimerRef.current[taskId] = setTimeout(async () => {
        delete dynTimerRef.current[taskId]
        const finalV = latestProgressRef.current[taskId]
        if (finalV == null) return
        try {
          const record = await addTaskDynamicRecord(projectId, taskId, `完成进度更新为 ${finalV}%`, 'auto')
          appendDynamics(taskId, record)
        } catch (e) {
          console.error('保存进度动态失败', e)
        }
      }, 800)
    } catch (e) {
      console.error('设置任务进度失败', e)
    }
  }

  // 手动状态/进度查找：优先按 original_task_id（DB 存储口径），退化到 task_ulid/id
  // 提升到组件作用域，供预览弹窗与四个视图共用
  const getExecManual = (node) => {
    const orig = node?.original_task_id
    const ulid = node?.task_ulid || node?.id
    if (orig && execStatusMap.has(String(orig))) return execStatusMap.get(String(orig))
    if (ulid && execStatusMap.has(String(ulid))) return execStatusMap.get(String(ulid))
    return null
  }
  const getExecProgress = (node) => {
    const orig = node?.original_task_id
    const ulid = node?.task_ulid || node?.id
    if (orig && progressMap.has(String(orig))) return progressMap.get(String(orig))
    if (ulid && progressMap.has(String(ulid))) return progressMap.get(String(ulid))
    return null
  }
  // 任意任务节点的执行状态（非叶子按子任务聚合）：甘特/表格/看板/日历四视图共用
  const statusOf = (node) => resolveExecStatus(node, getExecManual)
  // 任意任务节点的完成进度（非叶子按子任务均值聚合）：甘特条深色填充用
  const progressOf = (node) => resolveProgress(node, getExecProgress)

  // 项目整体统计（顶部统计条，四个视图通用）：
  //  - 总体进度 = Σ(叶子工时 × 完成比例) / Σ(叶子工时)。已完成任务按 100% 计，
  //    例如 任务1 8h 已完成 + 任务2 8h 进行中(50%) → (8 + 4) / 16 = 75%。
  //  - 任务状态比例 = 各执行状态的叶子任务条数占比。
  const projectStats = useMemo(() => {
    const leaves = (flatTasks || []).filter(t => !t.children || t.children.length === 0)
    const counts = { not_started: 0, in_progress: 0, completed: 0, delayed: 0 }
    let totalHours = 0
    let doneHours = 0
    for (const t of leaves) {
      const st = statusOf(t)
      if (counts[st] !== undefined) counts[st] += 1
      const h = Number(t.totalHours) || 0
      totalHours += h
      const p = st === 'completed' ? 100 : Math.min(100, Math.max(0, Number(progressOf(t)) || 0))
      doneHours += h * p / 100
    }
    const total = leaves.length
    const overall = totalHours > 0 ? Math.round(doneHours / totalHours * 100) : 0
    const pctOf = (n) => (total > 0 ? Math.round(n / total * 100) : 0)
    return { total, totalHours, doneHours, overall, counts, pctOf }
  }, [flatTasks, execStatusMap, progressMap])

  // 汇报给顶部导航条（App 的 content-header）：项目周期 / 总体进度 / 计划版本 / 成员人数与侧栏开关。
  // 统计条已上移到项目名称下方（第二行），数据仍由本组件计算，避免 App 重复加载任务数据。
  useEffect(() => {
    if (!onHeaderInfo) return
    if (loading) { onHeaderInfo(null); return }
    // 无任务数据、或任务尚无已发布版本的进度计划：顶部导航条第二行只显示成员数量
    if (!flatTasks.length || !hasPublishedVersion) {
      onHeaderInfo({
        noTasks: true,
        startDate: null,
        endDate: null,
        overall: 0,
        statuses: [],
        versionLabel: planVersionLabel,
        membersCount: members.length,
        toggleMembersSidebar: () => setMemberSidebarOpen(v => !v)
      })
      return
    }
    onHeaderInfo({
      startDate,
      endDate,
      overall: projectStats.overall,
      statuses: ['not_started', 'in_progress', 'completed', 'delayed']
        .filter(s => projectStats.counts[s] > 0)
        .map(s => ({
          key: s,
          label: EXEC_STATUS[s].label,
          color: EXEC_STATUS[s].color,
          count: projectStats.counts[s],
          pct: projectStats.pctOf(projectStats.counts[s])
        })),
      versionLabel: planVersionLabel,
      membersCount: members.length,
      toggleMembersSidebar: () => setMemberSidebarOpen(v => !v)
    })
  }, [onHeaderInfo, loading, flatTasks.length, hasPublishedVersion, startDate, endDate, projectStats, planVersionLabel, members])

  // 离开项目主页时清空头部信息，避免影响其他页面
  useEffect(() => () => { if (onHeaderInfo) onHeaderInfo(null) }, [onHeaderInfo])

  // 详情弹窗（统一 TaskDetailPopup）的动态/状态/进度 props：
  // - 非叶子任务：状态按子任务聚合派生（不可手动编辑）、进度为聚合只读
  // - 叶子任务：状态 = 系统推导 + 手动值；动态 = 旧数组 + store 记录
  // 均按「当前展示任务」实时解析（支持弹窗内子任务下钻/上一条下一条导航）
  const execPropsFor = () => ({
    dynamicsForTask: (t) => dynamicsMap.get(String(t.original_task_id || t.task_ulid || t.id)) || [],
    onAddDynamic: addTaskDynamic,
    onSetTaskExecStatus: (t, s) => {
      if (t.children && t.children.length > 0) return
      handleSetExecStatus(t, s)
    },
    resolveStatus: (node) => resolveExecStatus(node, getExecManual),
    progressForTask: (t) => resolveProgress(t, getExecProgress),
    onSetTaskProgress: (t, v) => {
      if (t.children && t.children.length > 0) return
      if (resolveExecStatus(t, getExecManual) === 'completed') return
      handleSetProgress(t, v)
    }
  })

  const filteredTasks = useMemo(() => {
    let result = flatTasks

    if (levelFilter !== 'all') {
      if (levelFilter === 'leaf') {
        result = result.filter(item => !item.children || item.children.length === 0)
      } else {
        result = result.filter(item => item.level + 1 <= levelFilter)
      }
    }

    if (selectedMembers.length > 0) {
      const memberKeys = new Set(selectedMembers.map(m => m.member_ulid || `${m.role}|${m.name}`))
      result = result.filter(item => {
        if (!item.resources || item.resources.length === 0) return false
        return item.resources.some(r => {
          const key = r.member_ulid || `${r.role}|${r.name}`
          return memberKeys.has(key)
        })
      })
    }

    if (execStatusFilter !== 'all') {
      result = result.filter(item => statusOf(item) === execStatusFilter)
    }

    if (dateRangeFilter) {
      const { start, end } = dateRangeFilter
      result = result.filter(item => {
        const sd = item.start_date
        const ed = item.end_date
        if (!sd && !ed) return false
        if (start && ed && ed < start) return false
        if (end && sd && sd > end) return false
        return true
      })
    }

    return result
  }, [flatTasks, levelFilter, selectedMembers, dateRangeFilter, execStatusFilter, execStatusMap])

  // 预览弹窗上一条/下一条导航列表 = 当前筛选下的叶子任务（与看板卡片/日历任务条同源）
  const navTasks = useMemo(() => filteredTasks.filter(t => !t.children || t.children.length === 0), [filteredTasks])

  const getIdToCodeMap = (nodes) => {
    const map = {}
    const walk = (list) => {
      for (const n of list || []) {
        map[n.id || n.task_ulid] = n.code
        if (n.children) walk(n.children)
      }
    }
    walk(nodes)
    return map
  }

  const calculateMaxHours = (node) => {
    if (node.children && node.children.length > 0) {
      return Math.max(...node.children.map(child => calculateMaxHours(child)))
    }
    return node.resources?.reduce((max, r) => Math.max(max, r.hours || 0), 0) || 0
  }

  const calculateTotalHours = (node) => {
    if (node.children && node.children.length > 0) {
      return node.children.reduce((sum, child) => sum + calculateTotalHours(child), 0)
    }
    return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
  }

  const getTaskTypeInfo = (task) => {
    if (task.taskType === '里程碑') {
      return { type: '里程碑', typeClass: 'task-type-milestone' }
    }
    const totalHours = calculateMaxHours(task)
    const isCustomDuration = task.customDurationDays !== undefined
    if (totalHours !== 0 && !isCustomDuration) return { type: '执行', typeClass: 'task-type-executing' }
    if (totalHours !== 0 && isCustomDuration) return { type: '跟进', typeClass: 'task-type-following' }
    return { type: '等待', typeClass: 'task-type-waiting' }
  }

  const statusMap = { pending: '待开始', in_progress: '进行中', completed: '已完成', blocked: '已阻塞' }

  const kanbanGroups = useMemo(() => {
    const leafTasks = flatTasks.filter(item => !item.children || item.children.length === 0)
    const filtered = leafTasks.filter(item => {
      // 看板视图固定显示执行层级（叶子）任务，任务层级筛选不可用
      if (selectedMembers.length > 0) {
        const memberKeys = new Set(selectedMembers.map(m => m.member_ulid || `${m.role}|${m.name}`))
        if (!item.resources || !item.resources.some(r => memberKeys.has(r.member_ulid || `${r.role}|${r.name}`))) return false
      }
      if (dateRangeFilter) {
        const { start, end } = dateRangeFilter
        const sd = item.start_date
        const ed = item.end_date
        if (!sd && !ed) return false
        if (start && ed && ed < start) return false
        if (end && sd && sd > end) return false
      }
      if (execStatusFilter !== 'all' && statusOf(item) !== execStatusFilter) return false
      return true
    })
    const groups = {}
    const groupOrder = []
    if (kanbanGroupBy === 'status') {
      // 固定顺序：未开始 → 已延误 → 进行中 → 已完成（从左到右）
      const statusOrder = ['not_started', 'delayed', 'in_progress', 'completed']
      const seen = new Set()
      for (const key of statusOrder) {
        const label = EXEC_STATUS[key]?.label || key
        const items = filtered.filter(item => statusOf(item) === key)
        if (items.length) {
          groups[label] = items
          groupOrder.push(label)
          seen.add(label)
        }
      }
      // 兜底：理论上只会出现上述四种状态，这里防止遗漏的状态丢失
      for (const item of filtered) {
        const label = EXEC_STATUS[statusOf(item)]?.label || '未开始'
        if (!seen.has(label)) {
          if (!groups[label]) {
            groups[label] = []
            groupOrder.push(label)
            seen.add(label)
          }
          groups[label].push(item)
        }
      }
    } else {
      for (const item of filtered) {
        const ancestor = wbsTreeData.find(root => {
          const find = (nodes) => {
            for (const n of nodes || []) {
              if (n.id === item.id || n.task_ulid === item.id) return true
              if (n.children && find(n.children)) return true
            }
            return false
          }
          return find([root])
        })
        const groupName = ancestor ? (ancestor.code ? ancestor.code + ' ' + ancestor.name : ancestor.name) : '未分组'
        if (!groups[groupName]) {
          groups[groupName] = []
          groupOrder.push(groupName)
        }
        groups[groupName].push(item)
      }
    }
    return { groups, groupOrder }
  }, [flatTasks, wbsTreeData, selectedMembers, dateRangeFilter, execStatusFilter, execStatusMap, kanbanGroupBy])

  const memberStats = useMemo(() => {
    const stats = {}
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (!n.children || n.children.length === 0) {
          for (const r of (n.resources || [])) {
            const uid = r.member_ulid || ''
            const role = r.role || ''
            const name = r.name || ''
            const key = uid ? `uid:${uid}` : `role:${role}|name:${name}`
            if (!stats[key]) stats[key] = { taskCount: 0, totalHours: 0 }
            stats[key].taskCount++
            stats[key].totalHours += r.hours || 0
          }
        }
        if (n.children) walk(n.children)
      }
    }
    walk(wbsTreeData)
    return stats
  }, [wbsTreeData])

  const lookupMemberStats = (member) => {
    if (member.member_ulid) {
      const uidKey = `uid:${member.member_ulid}`
      if (memberStats[uidKey]) return memberStats[uidKey]
    }
    const roleNameKey = `role:${member.role || ''}|name:${member.name || ''}`
    if (memberStats[roleNameKey]) return memberStats[roleNameKey]
    if (!member.name) {
      const roleKey = `role:${member.role || ''}|name:`
      if (memberStats[roleKey]) return memberStats[roleKey]
    }
    return { taskCount: 0, totalHours: 0 }
  }

  if (loading) {
    return <div className="project-home"><div style={{ textAlign: 'center', padding: '50px' }}>加载中...</div></div>
  }
  if (!project) {
    return <div className="project-home"><div style={{ textAlign: 'center', padding: '50px' }}>项目不存在</div></div>
  }

  return (
    <div className="project-home">
      {/* 成员面板展开时作为最左列，视图切换/筛选行与内容区整体右移 */}
      <div className="project-home-main">
      {memberSidebarOpen && (
        <div className="project-home-member-sidebar">
          <MemberList
            teamMembers={members.map(m => {
              const stat = lookupMemberStats(m)
              return { ...m, tasks: Array(stat.taskCount).fill(null), totalHours: stat.totalHours }
            })}
            showDetails={true}
            projectId={projectId}
            onRenameMember={handleRenameMember}
            onDeleteMember={handleDeleteMember}
            onRenameRole={handleRenameRole}
            onDeleteRole={handleDeleteRole}
            onCollapse={() => setMemberSidebarOpen(false)}
          />
        </div>
      )}
      <div className="project-home-right">
      {/* 视图切换 + 共享筛选栏：视图 tab 在最前，任务层级/状态/时间/成员筛选一次设置四个视图通用 */}
      <div className="gantt-toolbar" style={{ padding: '10px 0 10px 10px', background: '#fff', flexShrink: 0 }}>
        {/* 视图切换 tab：筛选行的第一个元素，紧凑分段式 */}
        <div className="project-tabs-left">
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={`project-tab ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {flatTasks.length > 0 && (
        <div className="gantt-quick-btns">
          {/* 任务层级筛选：看板锁定执行层级；日历限一级/执行层级；其余完整选项 */}
          <div className="gantt-filter-item" ref={levelDropdownRef}>
            <span className="gantt-filter-label">任务层级</span>
            <div
              className={"gantt-filter-trigger" + (activeTab === 'kanban' ? " is-locked" : "")}
              style={activeTab === 'kanban' ? { cursor: 'default', opacity: 0.75 } : undefined}
              onClick={() => { if (activeTab !== 'kanban') setLevelDropdownOpen(v => !v) }}
              title={activeTab === 'kanban' ? '看板视图固定显示执行层级任务' : undefined}
            >
              <span className="gantt-filter-value">
                {activeTab === 'kanban' ? '执行层级' : (levelOptionsForTab.find(o => o.value === effectiveLevelFilter)?.label || '全部任务')}
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
            </div>
          </div>

          {statusFilterItem}

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
              options={members || []}
              placeholder="全部成员"
              triggerRef={memberMultiSelectRef}
            />
          </div>

          {/* 看板视图分组字段：按一级任务 / 按任务状态 */}
          {activeTab === 'kanban' && (
            <div className="gantt-filter-item" ref={groupByDropdownRef}>
              <span className="gantt-filter-label">分组</span>
              <div className="gantt-filter-trigger" onClick={() => setGroupByDropdownOpen(v => !v)}>
                <span className="gantt-filter-value">
                  {kanbanGroupBy === 'status' ? '任务状态' : '一级任务'}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {flatTasks.length > 0 && (
      <>
      {levelDropdownOpen && createPortal(
            <div className="gantt-filter-dropdown" style={{
              position: 'fixed',
              top: levelDropdownRef.current ? levelDropdownRef.current.getBoundingClientRect().bottom + 4 : 0,
              left: levelDropdownRef.current ? levelDropdownRef.current.getBoundingClientRect().left : 0,
              zIndex: 10000
            }}>
              {levelOptionsForTab.map(opt => (
                <div key={opt.value} className={`gantt-filter-option ${effectiveLevelFilter === opt.value ? 'selected' : ''}`}
                  onClick={() => { setLevelFilter(opt.value); setLevelDropdownOpen(false) }}>
                  <span>{opt.label}</span>
                  {effectiveLevelFilter === opt.value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              ))}
            </div>,
            document.body
          )}

          {statusFilterDropdown}

          {activeTab === 'kanban' && groupByDropdownOpen && createPortal(
            <div className="gantt-filter-dropdown" style={{
              position: 'fixed',
              top: groupByDropdownRef.current ? groupByDropdownRef.current.getBoundingClientRect().bottom + 4 : 0,
              left: groupByDropdownRef.current ? groupByDropdownRef.current.getBoundingClientRect().left : 0,
              zIndex: 10000
            }}>
              {[{ value: 'parent', label: '一级任务' }, { value: 'status', label: '任务状态' }].map(opt => (
                <div key={opt.value} className={`gantt-filter-option ${kanbanGroupBy === opt.value ? 'selected' : ''}`}
                  onClick={() => { setKanbanGroupBy(opt.value); setGroupByDropdownOpen(false) }}>
                  <span>{opt.label}</span>
                  {kanbanGroupBy === opt.value && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              ))}
            </div>,
            document.body
          )}

          {dateRangeOpen && createPortal(
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
      </>
      )}

      <div className="project-home-body">
      <div className="project-tab-content">
        {activeTab === 'tasks' && (
          <div className="project-schedule-wrapper">
            {/* 无任务状态 */}
            {projectStatus === 'no_tasks' && (
              <div className="empty-state">
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-text">暂无任务</div>
                <button 
                  className="empty-state-button"
                  onClick={() => navigate(`/wbs?projectId=${projectId}`)}
                >
                  去添加任务
                </button>
              </div>
            )}

            {/* 草稿版本状态 */}
            {projectStatus === 'draft_only' && (
              <div className="empty-state">
                <div className="empty-state-icon">📝</div>
                <div className="empty-state-text">任务正在规划中</div>
                <div className="empty-state-detail">{draftTaskCount} 条任务待发布</div>
                <button 
                  className="empty-state-button"
                  onClick={() => navigate(`/wbs?projectId=${projectId}`)}
                >
                  查看规划
                </button>
              </div>
            )}

            {/* 已发布版本状态 */}
            {projectStatus === 'published' && (
              <ProjectSchedule
                wbsTreeData={wbsTreeData}
                teamMembers={members}
                startDate={startDate}
                endDate={endDate}
                projectId={projectId}
                projectName={project.name || '项目'}
                readOnly={true}
                skipHolidays={displaySkipHolidays}
                showPageHeader={false}
                onTaskBarPreview={(task) => {
                  const item = flatTasks.find(t => String(t.id || t.task_ulid) === String(task.id))
                  if (item) setSelectedKanbanTask(item)
                }}
                statusOf={statusOf}
                progressOf={progressOf}
                filterLevel={levelFilter}
                filterDateRange={dateRangeFilter}
                filterMembers={selectedMembers}
                filterExecStatus={execStatusFilter}
              />
            )}
          </div>
        )}

        {activeTab === 'table' && (
          <div className="wbs-table-container" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {flatTasks.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-text">暂无任务</div>
                <button className="empty-state-button" onClick={() => navigate(`/wbs?projectId=${projectId}`)}>去添加任务</button>
              </div>
            ) : (
              <>
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  <table className="wbs-table">
                    <thead>
                      <tr>
                        <th style={{ width: '20%' }}>任务名称</th>
                        <th style={{ width: '8%' }}>前置任务</th>
                        <th style={{ width: '15%' }}>资源需求</th>
                        <th style={{ width: '8%' }}>总预估工时</th>
                        <th style={{ width: '8%' }}>工期（天）</th>
                        <th style={{ width: '13%' }}>计划开展时间</th>
                        <th style={{ width: '7%' }}>任务类型</th>
                        <th style={{ width: '8%' }}>任务状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTasks.map((item) => (
                        <Fragment key={item.id || item.task_ulid}>
                          <tr className="wbs-row" style={{ cursor: 'pointer' }} onClick={() => setSelectedKanbanTask(item)}>
                            <td style={{ paddingLeft: `${item.level * 24 + 8}px` }}>
                              <div className="wbs-cell-content">
                                {item.children && item.children.length > 0 && (
                                  <span className="collapse-btn">▼</span>
                                )}
                                {(!item.children || item.children.length === 0) && (
                                  ['completed', 'delayed', 'in_progress'].includes(statusOf(item)) ? (
                                    <ExecStatusDot status={statusOf(item)} />
                                  ) : (
                                    <span className="collapse-placeholder">•</span>
                                  )
                                )}
                                <span className="task-code">{item.code}</span>
                                <div className="task-container">
                                  <div className="task-content">
                                    <span className="task-name">{item.name}</span>
                                    {item.taskType === '里程碑' && (
                                      <span className="milestone-btn milestone-active" title="里程碑">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                                          <line x1="4" y1="22" x2="4" y2="15"/>
                                        </svg>
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td>
                              <div className="predecessors-cell">
                                {(item.predecessors || []).map((predId, idx) => {
                                  const codeMap = getIdToCodeMap(wbsTreeData)
                                  const predCode = codeMap[predId] || predId
                                  return <span key={idx} className="predecessor-tag">{predCode}</span>
                                })}
                              </div>
                            </td>
                            <td>
                              <div
                                className={`resources-container ${item.taskType === '里程碑' ? 'milestone-disabled' : ''}`}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (item.taskType !== '里程碑' && item.resources && item.resources.length > 0) {
                                    const tid = item.id || item.task_ulid
                                    setExpandedResourceId(prev => prev === tid ? null : tid)
                                  }
                                }}
                                style={{ cursor: item.taskType === '里程碑' ? 'not-allowed' : (item.resources && item.resources.length > 0) ? 'pointer' : 'default' }}
                              >
                                {item.taskType === '里程碑' ? (
                                  <span className="milestone-dash">—</span>
                                ) : (
                                  <>
                                    {(item.resources || []).slice(0, 2).map((resource, idx) => (
                                      <div key={idx} className="resource-item">
                                        <span className={`avatar ${!resource.name ? 'empty-avatar' : ''}`}>
                                          {resource.name ? resource.avatar : '?'}
                                        </span>
                                        <div className="resource-info">
                                          <span className={`resource-name ${!resource.name ? 'empty-name' : ''}`}>
                                            {resource.name || resource.role}
                                          </span>
                                          <span className="resource-hours">
                                            {formatHoursByUnit(resource.hours || 0, '小时')}
                                          </span>
                                        </div>
                                      </div>
                                    ))}
                                    {item.resources && item.resources.length > 2 && (
                                      <div className="resource-item more-resources">
                                        <span className="more-badge">+{item.resources.length - 2}</span>
                                      </div>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                            <td>
                              {/* 与 WBS 分解页一致：非叶子结点显示「共XXh」，叶子结点不显示「共」字 */}
                              {item.children && item.children.length > 0 ? (
                                <span className="duration-days-text">
                                  {(() => {
                                    const total = calculateTotalHours(item)
                                    return `共${formatHoursByUnit(total > 0 ? total : 0, '小时')}`
                                  })()}
                                </span>
                              ) : (
                                <span className="duration-tag">
                                  {(() => {
                                    const total = calculateTotalHours(item)
                                    return formatHoursByUnit(total > 0 ? total : 0, '小时')
                                  })()}
                                </span>
                              )}
                            </td>
                            <td>
                              {item.taskType === '里程碑' ? (
                                <span className="milestone-dash">—</span>
                              ) : (!item.children || item.children.length === 0) ? (
                                <span className="duration-days">
                                  {item.customDurationDays !== undefined
                                    ? item.customDurationDays
                                    : (() => { const h = calculateMaxHours(item); return h > 0 ? Math.ceil(h / displayDailyInputHours) : 0 })()}
                                </span>
                              ) : (
                                <span className="duration-days-text">
                                  {(() => {
                                    // 与 WBS 分解列表「共X天」同口径：子叶子按前驱依赖链排布取最大结束天数
                                    const days = calcGroupDurationDays(item, displayDailyInputHours)
                                    return `共${days}天`
                                  })()}
                                </span>
                              )}
                            </td>
                            <td>
                              {(() => {
                                const sd = item.start_date
                                const ed = item.end_date
                                const sh = item.start_hour
                                const eh = item.end_hour
                                if (!sd && !ed) return '-'
                                const startStr = sd ? `${sd}${sh != null ? ' ' + sh + 'h' : ''}` : '-'
                                const endStr = ed ? `${ed}${eh != null ? ' ' + eh + 'h' : ''}` : '-'
                                return <span style={{ fontSize: '13px', color: '#374151' }}>{startStr} 至 {endStr}</span>
                              })()}
                            </td>
                            <td className="cell-task-type">
                              {(!item.children || item.children.length === 0) && (() => {
                                const { type, typeClass } = getTaskTypeInfo(item)
                                return <span className={`task-type-badge ${typeClass}`}>{type}</span>
                              })()}
                            </td>
                            <td>
                              <ExecStatusBadge status={statusOf(item)} />
                            </td>
                          </tr>
                          {/* 资源需求展开子行：样式复用 WBS 分解页面 expanded-resource-row */}
                          {expandedResourceId === (item.id || item.task_ulid) && item.resources && item.resources.length > 0 && item.resources.map((resource, idx) => (
                            <tr key={`exp-${item.id || item.task_ulid}-${idx}`} className="expanded-resource-row">
                              <td></td>
                              <td></td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                <div className="resource-item" style={{ display: 'inline-flex' }}>
                                  <span className={`avatar ${!resource.name ? 'empty-avatar' : ''}`}>
                                    {resource.name ? resource.avatar : '?'}
                                  </span>
                                  <div className="resource-info">
                                    <span className={`resource-name ${!resource.name ? 'empty-name' : ''}`}>
                                      {resource.name || resource.role}
                                    </span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <span className="resource-hours">
                                  {formatHoursByUnit(resource.hours || 0, '小时')}
                                </span>
                              </td>
                              <td>
                                <div className="duration-days">
                                  {(() => { const h = resource.hours || 0; return h > 0 ? Math.ceil(h / 8) : '—' })()}
                                </div>
                              </td>
                              <td></td>
                              <td></td>
                              <td></td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'kanban' && (
          <div className="wbs-table-container" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {flatTasks.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-text">暂无任务</div>
                <button className="empty-state-button" onClick={() => navigate(`/wbs?projectId=${projectId}`)}>去添加任务</button>
              </div>
            ) : (
              <>
                <div className="kanban-board">
                  {kanbanGroups.groupOrder.length === 0 ? (
                    <div className="empty-state">暂无匹配任务</div>
                  ) : (
                    kanbanGroups.groupOrder.map(groupName => (
                      <div key={groupName} className="kanban-column">
                        <div className="kanban-column-header">
                          <div className="kanban-column-header-left">
                            <span className="kanban-column-title">{groupName}</span>
                            <span className="kanban-column-count">{kanbanGroups.groups[groupName].length}</span>
                          </div>
                        </div>
                        <div className="kanban-column-body">
                          {kanbanGroups.groups[groupName].map(item => (
                            <div key={item.id || item.task_ulid} className="kanban-card" style={{ cursor: 'pointer' }} onClick={() => setSelectedKanbanTask(item)}>
                              <div className="kanban-card-header">
                                <span className="task-code">{item.code}</span>
                                {item.taskType === '里程碑' && (
                                  <span className="milestone-btn milestone-active" title="里程碑">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                                      <line x1="4" y1="22" x2="4" y2="15"/>
                                    </svg>
                                  </span>
                                )}
                              </div>
                              <div className="kanban-card-name">{item.name}</div>
                              {/* 统计信息：人员图标+人数 / 时钟图标+工时（芯片样式，居左） */}
                              <div className="kanban-card-stats">
                                <span className="kanban-card-stat" title="参与人数">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                                    <circle cx="9" cy="7" r="4"/>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                                  </svg>
                                  {item.resources ? item.resources.length : 0}人
                                </span>
                                <span className="kanban-card-stat" title="总预估工时">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12 6 12 12 16 14"/>
                                  </svg>
                                  {formatHoursByUnit(item.totalHours || 0, '小时')}
                                </span>
                              </div>
                              {/* 任务状态 + 完成进度 */}
                              <div className="kanban-card-status">
                                <ExecStatusBadge status={statusOf(item)} />
                                {statusOf(item) === 'in_progress' && (
                                  <span className="kanban-card-progress" title="完成进度">{progressOf(item)}%</span>
                                )}
                              </div>
                              {/* 开展时间（页脚） */}
                              {(item.start_date || item.end_date) && (
                                <div className="kanban-card-footer">
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                  </svg>
                                  <span className="kanban-card-dates">
                                    {item.start_date}{item.start_hour != null ? ' ' + item.start_hour + 'h' : ''} 至 {item.end_date}{item.end_hour != null ? ' ' + item.end_hour + 'h' : ''}
                                  </span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'calendar' && (
          <div className="wbs-table-container" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {flatTasks.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">📋</div>
                <div className="empty-state-text">暂无任务</div>
                <button className="empty-state-button" onClick={() => navigate(`/wbs?projectId=${projectId}`)}>去添加任务</button>
              </div>
            ) : (
              <>
                <div className="gantt-toolbar" style={{ borderBottom: '1px solid #e2e8f0', padding: '8px 16px', background: '#fff', flexShrink: 0 }}>
                  <div className="gantt-quick-btns">
                    <div className="calendar-nav">
                      <button className="calendar-nav-btn" onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                      </button>
                      <span className="calendar-nav-label">{calendarDate.getFullYear()}年{calendarDate.getMonth() + 1}月</span>
                      <button className="calendar-nav-btn" onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                      </button>
                      <button className="calendar-today-btn" onClick={() => { const d = new Date(); setCalendarDate(new Date(d.getFullYear(), d.getMonth(), 1)) }}>今天</button>
                    </div>
                  </div>
                </div>

                {(() => {
                  const year = calendarDate.getFullYear()
                  const month = calendarDate.getMonth()
                  const firstDay = new Date(year, month, 1).getDay()
                  const daysInMonth = new Date(year, month + 1, 0).getDate()
                  const cells = []
                  for (let i = 0; i < firstDay; i++) cells.push(null)
                  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
                  const weeks = []
                  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

                  // 执行层级：全部叶子任务条；1级任务：一级任务条（含带子任务的一级汇总条，起止为子任务聚合日期）
                  const baseTasks = effectiveLevelFilter === 1
                    ? flatTasks.filter(item => item.level + 1 <= 1)
                    : flatTasks.filter(item => !item.children || item.children.length === 0)
                  const filtered = baseTasks.filter(item => {
                    if (selectedMembers.length > 0) {
                      const memberKeys = new Set(selectedMembers.map(m => m.member_ulid || `${m.role}|${m.name}`))
                      if (!item.resources || !item.resources.some(r => memberKeys.has(r.member_ulid || `${r.role}|${r.name}`))) return false
                    }
                    if (execStatusFilter !== 'all' && statusOf(item) !== execStatusFilter) return false
                    if (dateRangeFilter) {
                      const { start, end } = dateRangeFilter
                      const sd = item.start_date
                      const ed = item.end_date
                      if (!sd && !ed) return false
                      if (start && ed && ed < start) return false
                      if (end && sd && sd > end) return false
                    }
                    return true
                  })

                  // 任务起止范围（与当月有交集才显示，渲染为跨日完整任务条）
                  const mm = String(month + 1).padStart(2, '0')
                  const monthStartKey = `${year}-${mm}-01`
                  const monthEndKey = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`
                  const keyOf = (d) => `${year}-${mm}-${String(d).padStart(2, '0')}`
                  const dowOf = (key) => { const [yy, mo, dd] = key.split('-').map(Number); return new Date(yy, mo - 1, dd).getDay() }
                  // 绝对天数序号：跨周任务条的进度填充需要全局时间轴（每段按实际被填充比例渲染，而非每段都填 progress%）
                  const dayNum = (key) => { const [yy, mo, dd] = key.split('-').map(Number); return Math.round(new Date(yy, mo - 1, dd).getTime() / 86400000) }
                  const ranges = []
                  for (const item of filtered) {
                    if (!item.start_date) continue
                    const sd = item.start_date
                    const ed = item.end_date || item.start_date
                    if (ed < monthStartKey || sd > monthEndKey) continue
                    ranges.push({ task: item, sd, ed })
                  }

                  const today = new Date()
                  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

                  const weekdays = ['日', '一', '二', '三', '四', '五', '六']

                  return (
                    <div className="calendar-container">
                      <div className="calendar-header-row">
                        {weekdays.map(w => (
                          <div key={w} className="calendar-header-cell">{w}</div>
                        ))}
                      </div>
                      <div className="calendar-grid">
                        {weeks.map((week, wi) => {
                          const realDays = week.filter(d => d !== null)
                          if (!realDays.length) return null
                          const wStartKey = keyOf(realDays[0])
                          const wEndKey = keyOf(realDays[realDays.length - 1])
                          // 本周任务段：裁剪到本周范围，按列(周日~周六)定位
                          // 首日/末日按 start_hour/end_hour 占每日投入工时的比例裁剪宽度（仅任务真实起止日生效）
                          const segs = []
                          for (const r of ranges) {
                            const s = r.sd > wStartKey ? r.sd : wStartKey
                            const e = r.ed < wEndKey ? r.ed : wEndKey
                            if (s > e) continue
                            const rawSh = r.task.start_hour != null ? Number(r.task.start_hour) / displayDailyInputHours : 0
                            const rawEh = r.task.end_hour != null ? Number(r.task.end_hour) / displayDailyInputHours : 1
                            // 里程碑 0 工时（end_hour=start_hour）会算出零宽段导致整段被泳道/渲染逻辑跳过：
                            // end 按整天占位参与泳道分配；start 按 start_hour 占比偏移（旗帜从当日时刻位置起绘）
                            const isMs = r.task.taskType === '里程碑'
                            const shFrac = (isMs || s === r.sd) ? Math.min(1, Math.max(0, rawSh)) : 0
                            const ehFrac = isMs ? 1 : ((e === r.ed) ? Math.min(1, Math.max(0, rawEh)) : 1)
                            segs.push({ task: r.task, cs: dowOf(s), ce: dowOf(e), shFrac, ehFrac })
                          }
                          // 泳道分配：按小数天单位（含起止小时占比）判断不重叠，
                          // 同日前后紧接的任务（如 1.1 在 4h 结束、1.2 从 4h 开始）可共用一行
                          segs.forEach(sg => { sg.startUnit = sg.cs + sg.shFrac; sg.endUnit = sg.ce + sg.ehFrac })
                          segs.sort((a, b) => a.startUnit - b.startUnit || (b.endUnit - b.startUnit) - (a.endUnit - a.startUnit))
                          const laneEnds = []
                          for (const sg of segs) {
                            let lane = laneEnds.findIndex(le => le <= sg.startUnit + 1e-6)
                            if (lane === -1) { laneEnds.push(sg.endUnit); lane = laneEnds.length - 1 }
                            else laneEnds[lane] = sg.endUnit
                            sg.lane = lane
                          }
                          const rowMinH = Math.max(90, 24 + laneEnds.length * 20 + 8)
                          return (
                            <div key={`week-${wi}`} className="calendar-week-row" style={{ minHeight: rowMinH + 'px' }}>
                              {week.map((day, di) => {
                                if (day === null) return <div key={`empty-${wi}-${di}`} className="calendar-cell calendar-cell-empty" />
                                const dateKey = keyOf(day)
                                const isToday = dateKey === todayKey
                                const isHoliday = displaySkipHolidays && isNonWorkDay(dateKey)
                                return (
                                  <div key={dateKey} className={`calendar-cell ${isToday ? 'calendar-cell-today' : ''} ${isHoliday ? 'calendar-cell-holiday' : ''}`}>
                                    <div className={`calendar-cell-day ${isToday ? 'calendar-day-today' : ''}`}>{day}</div>
                                  </div>
                                )
                              })}
                              {/* 任务条拆段渲染：跳过节假日时节假日段不渲染（截断），工作日段各自独立成条 */}
                              {segs.flatMap((sg, si) => {
                                const task = sg.task
                                const stMeta = EXEC_STATUS[statusOf(task)]
                                const firstLevel = parseInt((task.code || '').split('.')[0], 10) || 1
                                const colorIdx = ((firstLevel - 1) % themeColors.length)
                                const tc = themeColors[colorIdx]
                                // 拆分连续段：相邻工作日合并为一段，节假日段直接丢弃（截断）
                                // 里程碑是单点事件：即使落在节假日（跳过节假日开启时）也照常绘制旗帜
                                const runs = []
                                for (let d = sg.cs; d <= sg.ce; d++) {
                                  const s0 = Math.max(d, sg.startUnit)
                                  const e0 = Math.min(d + 1, sg.endUnit)
                                  if (e0 <= s0) continue
                                  const isHol = displaySkipHolidays && task.taskType !== '里程碑' && week[d] != null && isNonWorkDay(keyOf(week[d]))
                                  if (isHol) continue
                                  const last = runs[runs.length - 1]
                                  if (last && last.end === s0) last.end = e0
                                  else runs.push({ start: s0, end: e0 })
                                }
                                return runs.map((run, ri) => {
                                  // 里程碑：绘制旗帜图标（不定宽任务条），从当日 start_hour 对应位置起绘，
                                  // 宽度不超过当日剩余空间，避免压到后一天的格子
                                  if (task.taskType === '里程碑') {
                                    const dayFrac = run.start - Math.floor(run.start)
                                    return (
                                      <div key={`bar-${wi}-${si}-${ri}`} className="calendar-task-chip calendar-milestone-chip"
                                        style={{
                                          left: `calc(${run.start} * 100% / 7 + 1px)`,
                                          top: (24 + sg.lane * 20) + 'px',
                                          maxWidth: `calc(${(1 - dayFrac) * 100}% / 7 - 4px)`
                                        }}
                                        title={`${task.code} ${task.name} · 里程碑${stMeta ? ' · 任务状态：' + stMeta.label : ''}`}
                                        onClick={() => setSelectedCalendarTask(task)}>
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'relative', zIndex: 1 }}>
                                          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                                          <line x1="4" y1="22" x2="4" y2="15"/>
                                        </svg>
                                        <span className="task-code" style={{ fontSize: '10px', color: '#b45309', position: 'relative', zIndex: 1 }}>{task.code}</span>
                                        <span className="calendar-task-name" style={{ color: '#b45309', position: 'relative', zIndex: 1 }}>{task.name}</span>
                                      </div>
                                    )
                                  }
                                  const span = Math.max(run.end - run.start, 0.12)
                                  const showText = ri === 0
                                  const calProgress = Math.min(100, progressOf(task))
                                  // 任务条颜色始终跟随甘特条主题色；状态通过任务名文字样式 + 条右侧状态图标/比例体现
                                  // 已完成 = 名称删除线置灰 + 右侧绿对勾；已延误 = 名称红字 + 右侧红感叹号；进行中 = 右侧比例
                                  const isCalCompleted = stMeta === EXEC_STATUS.completed
                                  const isCalDelayed = stMeta === EXEC_STATUS.delayed
                                  const isCalInProgress = stMeta === EXEC_STATUS.in_progress
                                  const chipNameStyle = isCalCompleted
                                    ? { textDecoration: 'line-through', color: '#94a3b8' }
                                    : isCalDelayed
                                      ? { color: '#DC2626' }
                                      : { color: '#2d3748' }
                                  const calRightSlot = isCalCompleted ? (
                                    <ExecStatusDot status="completed" size={12} style={{ marginLeft: 'auto' }} />
                                  ) : isCalDelayed ? (
                                    <ExecStatusDot status="delayed" size={12} style={{ marginLeft: 'auto' }} />
                                  ) : isCalInProgress ? (
                                    <span style={{ marginLeft: 'auto', fontSize: '10px', fontWeight: 600, color: '#1D4ED8', position: 'relative', zIndex: 1, whiteSpace: 'nowrap', flexShrink: 0 }}>{calProgress}%</span>
                                  ) : null
                                  // 进度填充按任务绝对时间轴换算：已完成的绝对区间与本段的重叠比例，
                                  // 跨周拆段时每段只填各自实际完成的部分（而非每段都填 calProgress%）
                                  const rawSh = task.start_hour != null ? Number(task.start_hour) / displayDailyInputHours : 0
                                  const rawEh = task.end_hour != null ? Number(task.end_hour) / displayDailyInputHours : 1
                                  const tStartAbs = dayNum(task.start_date) + rawSh
                                  const tEndAbs = dayNum(task.end_date || task.start_date) + rawEh
                                  const filledAbs = calProgress > 0 ? tStartAbs + (tEndAbs - tStartAbs) * calProgress / 100 : null
                                  const sF = Math.floor(run.start), eF = Math.min(Math.floor(run.end), 6)
                                  const runStartAbs = dayNum(keyOf(week[sF])) + (run.start - sF)
                                  const runEndAbs = dayNum(keyOf(week[eF])) + (run.end - eF)
                                  const runLen = runEndAbs - runStartAbs
                                  let fillPct = 0
                                  if (filledAbs != null) {
                                    const ov = Math.min(runEndAbs, filledAbs) - runStartAbs
                                    fillPct = runLen > 1e-9 ? Math.max(0, Math.min(1, ov / runLen)) * 100 : (filledAbs >= runEndAbs ? 100 : 0)
                                  }
                                  return (
                                    <div key={`bar-${wi}-${si}-${ri}`} className="calendar-task-chip calendar-task-bar"
                                      style={{
                                        left: `calc(${run.start} * 100% / 7 + 1px)`,
                                        width: `calc(${span} * 100% / 7 - 2px)`,
                                        top: (24 + sg.lane * 20) + 'px',
                                        background: tc.light, borderLeft: `3px solid ${tc.solid}`
                                      }}
                                      title={`${task.code} ${task.name}${stMeta ? ' · 任务状态：' + stMeta.label : ''}${calProgress > 0 ? ' · 完成进度：' + calProgress + '%' : ''}`}
                                      onClick={() => setSelectedCalendarTask(task)}>
                                      {/* 完成进度：深色填充（主题色 70%，与甘特条配色一致） */}
                                      {calProgress > 0 && fillPct > 0 && (
                                        <div
                                          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fillPct}%`, background: tc.solid + 'B3', borderRadius: 'inherit', pointerEvents: 'none', zIndex: 0 }}
                                          title={`完成进度：${calProgress}%`}
                                        />
                                      )}
                                      {showText && (
                                        <>
                                          <span className="task-code" style={{ fontSize: '10px', color: tc.dash, position: 'relative', zIndex: 1 }}>{task.code}</span>
                                          <span className="calendar-task-name" style={{ ...chipNameStyle, position: 'relative', zIndex: 1 }}>{task.name}</span>
                                          {calRightSlot}
                                        </>
                                      )}
                                    </div>
                                  )
                                })
                              })}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}
              </>
            )}
          </div>
        )}
      </div>
      </div>
      </div>
      </div>
      {selectedCalendarTask && (() => {
        // 展示任务从 flatTasks 实时解析（编辑描述/成果后内容层更新会重算 flatTasks），
        // 避免点击时的快照对象导致保存后弹窗仍显示旧值
        const live = flatTasks.find(t => String(t.task_ulid || t.id) === String(selectedCalendarTask.task_ulid || selectedCalendarTask.id)) || selectedCalendarTask
        const meta = parentMap.get(String(live.task_ulid || live.id)) || {}
        return (
          <TaskDetailPopup
            task={{ ...live, ancestors: meta.chain || [] }}
            scheduleStartDate={live.start_date || startDate}
            scheduleEndDate={live.end_date || endDate}
            dailyInputHours={displayDailyInputHours}
            {...execPropsFor()}
            onUpdateDescription={handleUpdateTaskDescription}
            onUpdateDeliverables={handleUpdateTaskDeliverables}
            deliverablesCatalog={deliverablesCatalogMerged}
            onAddDeliverableToCatalog={handleAddDeliverableToCatalog}
            onClose={() => setSelectedCalendarTask(null)}
            onBackToParent={meta.parent ? () => setSelectedCalendarTask(meta.parent) : null}
            navTasks={navTasks}
            onNavigateTask={(t) => setSelectedCalendarTask(t)}
          />
        )
      })()}
      {selectedKanbanTask && (() => {
        // 展示任务从 flatTasks 实时解析（编辑描述/成果后内容层更新会重算 flatTasks），
        // 避免点击时的快照对象导致保存后弹窗仍显示旧值
        const live = flatTasks.find(t => String(t.task_ulid || t.id) === String(selectedKanbanTask.task_ulid || selectedKanbanTask.id)) || selectedKanbanTask
        const meta = parentMap.get(String(live.task_ulid || live.id)) || {}
        return (
          <TaskDetailPopup
            task={{ ...live, ancestors: meta.chain || [] }}
            scheduleStartDate={live.start_date || startDate}
            scheduleEndDate={live.end_date || endDate}
            dailyInputHours={displayDailyInputHours}
            {...execPropsFor()}
            onUpdateDescription={handleUpdateTaskDescription}
            onUpdateDeliverables={handleUpdateTaskDeliverables}
            deliverablesCatalog={deliverablesCatalogMerged}
            onAddDeliverableToCatalog={handleAddDeliverableToCatalog}
            onClose={() => setSelectedKanbanTask(null)}
            onBackToParent={meta.parent ? () => setSelectedKanbanTask(meta.parent) : null}
            navTasks={navTasks}
            onNavigateTask={(t) => setSelectedKanbanTask(t)}
          />
        )
      })()}
      {/* 清空项目数据成功提示（复用 member-list-toast 顶部居中样式） */}
      {clearedToast && <div className="member-list-toast">{clearedToast}</div>}
    </div>
  )
}

export default ProjectHome
