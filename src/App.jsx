import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Routes, Route, useLocation, Navigate, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import WbsBreakdown from './components/WbsBreakdown'
import TeamMembers from './components/TeamMembers'
import NetworkDiagramStandalone from './components/NetworkDiagramStandalone'
import ProjectSchedule from './components/ProjectSchedule'
import ProjectList from './components/ProjectList'
import ProjectPeriodModal from './components/ProjectPeriodModal'
import IconButton from './components/IconButton'
import ProjectHome from './components/ProjectHome'
import { generateExcel } from './utils/excelExporter'
import { generateProjectHomeHtml } from './utils/projectHomeHtml'
import { initDefaultData, getProjects, getProjectMembers, addProjectMember, updateProjectMember, deleteProjectMember, getProjectById, getLatestPlanTree, getProjectWbsTreeByVersion, updateRecord, hoursToUnitValue, unitValueToHours, ceilToStep, createVersion, getLatestVersion, getDraftVersion, getVersionsByProject, updateVersion, saveVersionSnapshot, generateULID, ensureOriginalTaskIds, getExecStatusByProject, aliasExecStatusMapsByTaskRow, clearDraftVersionRows, getTaskContentByProject, applyTaskContentOverlay } from './utils/db'
import { buildLeaves, computeSchedule, daysBetweenDateStr, earliestCompletedDate, buildCompletedAnchors, themeColors } from './utils/schedule'
import { buildScheduleDocxBlob, svgToPng } from './utils/wordExporter.mjs'
import { resolveExecStatus, deriveExecStatus } from './utils/execStatus'
import { planContentEqual } from './utils/planCompare'

// 排期相关内容签名：只比对影响排期的字段（名称/状态/工期/资源工时/前置/日期等），
// 忽略折叠、选中态等视图状态。用于判断「修改任务或工时后需要重新排期」
const scheduleSignature = (nodes) => JSON.stringify((nodes || []).map(n => ({
  c: n.code ?? null,
  n: n.name ?? null,
  s: n.status ?? null,
  d: n.duration ?? null,
  cd: n.customDurationDays ?? null,
  tt: n.taskType ?? null,
  sd: n.start_date ?? null,
  ed: n.end_date ?? null,
  r: (n.resources || []).map(x => [x.role ?? '', x.name ?? '', x.hours || 0]),
  p: n.predecessors || [],
  ch: n.children ? scheduleSignature(n.children) : null,
})))

// 版本内容签名：与 comparePlanToVersion 同字段口径（名称/日期/工时/状态/工期/前置/资源/描述/交付物/类型/自定义工期），
// 版本内容签名 / planContentEqual 已抽到 utils/planCompare.js（WbsBreakdown 也需要做回环短路），
// 见文件顶部 import { planContentEqual } from './utils/planCompare'

// 版本 schedule_rules 签名（纯数据解析，不依赖会话状态；归一化口径与 comparePlanToVersion 一致）
const versionRulesSignatureOf = (rulesJson) => {
  try {
    const r = JSON.parse(rulesJson || '{}')
    return JSON.stringify([
      r.daily_input_hours ?? null, r.time_rule_unit ?? null, r.time_rule_value ?? null,
      !!r.skip_holidays, r.day_aligned !== false, r.schedule_mode || 'forward',
      r.start_date || null, r.end_date || null
    ])
  } catch { return '' }
}

// 两棵版本树内容比对已移至 utils/planCompare.js

function EditableProjectTitle({ projectId, projects, setProjects }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef(null)

  const project = projects.find(p => p.project_ulid === projectId)
  const displayName = project?.name || '任务排期'

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = () => {
    setEditValue(displayName)
    setIsEditing(true)
  }

  const handleSave = async () => {
    const newName = editValue.trim()
    if (!newName || newName === displayName) {
      setIsEditing(false)
      return
    }
    if (newName.length > 50) {
      alert('项目名称不能超过50个字')
      return
    }
    try {
      await updateRecord('projects', { ...project, name: newName })
      setProjects(prev => prev.map(p =>
        p.project_ulid === projectId ? { ...p, name: newName } : p
      ))
      // 通知侧边栏项目模块刷新
      window.dispatchEvent(new Event('pmflow:projects-changed'))
    } catch (err) {
      console.error('更新项目名称失败:', err)
    }
    setIsEditing(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
    }
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        className="editable-project-title"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        maxLength={50}
      />
    )
  }

  return (
    <h2
      className="editable-project-title-display"
      onClick={handleStartEdit}
      title="点击修改项目名称"
    >
      {displayName}
    </h2>
  )
}

// 开源核心 App：项目列表 / 项目主页 / 任务排期三页。
// 扩展点参数见 createApp.jsx（official 版通过它们注入私有功能）
function App({ extraRoutes = [], homePath = '/projects', renderSidebarNavItems = null, extraUserMenuItems = [], renderAiAssistant = null }) {
  const [showTeamModal, setShowTeamModal] = useState(false)
  // 侧边栏收起状态：收起后侧边栏整栏隐藏，展开按钮内嵌在顶部导航条最左侧
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [publishedVersionLabel, setPublishedVersionLabel] = useState('')
  const [downloadDropdownOpen, setDownloadDropdownOpen] = useState(false)
  const downloadBtnRef = useRef(null)
  const downloadMenuRef = useRef(null)
  const downloadCloseTimer = useRef(null)
  // 进度规划页的下载格式下拉
  const [scheduleDownloadOpen, setScheduleDownloadOpen] = useState(false)
  const scheduleDownloadBtnRef = useRef(null)
  const scheduleDownloadMenuRef = useRef(null)
  const scheduleDownloadCloseTimer = useRef(null)
  const [showNoChangeModal, setShowNoChangeModal] = useState(false)
  // 项目主页头部信息（由 ProjectHome 上报）：项目周期 / 总体进度 / 计划版本，
  // 渲染在顶部导航条项目名称下方一行（四个视图通用）
  const [projectHeaderInfo, setProjectHeaderInfo] = useState(null)
  // 「无需保存」/「无需发布」共用弹窗，通过类型区分文案
  const [noChangeType, setNoChangeType] = useState('save')
  const [wbsTreeData, setWbsTreeData] = useState(null)
  const wbsTreeDataRef = useRef(wbsTreeData)
  useEffect(() => { wbsTreeDataRef.current = wbsTreeData }, [wbsTreeData])
  const [appliedWbsTree, setAppliedWbsTree] = useState(null)
  const [scheduleExportData, setScheduleExportData] = useState(null)
  const [teamMembers, setTeamMembers] = useState([])
  const [dailyInputHours, setDailyInputHours] = useState(8)
  const [timeRuleUnit, setTimeRuleUnit] = useState('小时')
  const [timeRuleValue, setTimeRuleValue] = useState(0.5)
  const [isMemberListExpanded, setIsMemberListExpanded] = useState(true)
  const [startDate, setStartDate] = useState(null)
  const [endDate, setEndDate] = useState(null)
  const [scheduleMode, setScheduleMode] = useState('forward')
  const [skipHolidays, setSkipHolidays] = useState(true)
  // 任务衔接规则：true = 次日开始（整日排期，默认），false = 当日接续（紧凑排期）
  const [dayAligned, setDayAligned] = useState(true)
  // 「一键排期」应用次数：每次应用后通知排期页清空锚点、从头重排
  const [scheduleRulesVersion, setScheduleRulesVersion] = useState(0)
  // 一键排期下限：未完成任务最早开始位置（相对甘特图窗口起点的天数），已完成任务钉在原位
  const [rescheduleFloorPos, setRescheduleFloorPos] = useState(0)
  const [showPeriodModal, setShowPeriodModal] = useState(false)
  // 任务内容脏标记：在任务分解/排列顺序页修改任务或工时后置 true，
  // 进入进度规划页时自动打开一键排期弹窗提醒重新排期；应用排期或提示过一次后复位
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState(null)
  const [toastMsg, setToastMsg] = useState('')
  const [showAiAssistant, setShowAiAssistant] = useState(false)
  const [currentProject, setCurrentProject] = useState(null)
  const [currentProjectId, setCurrentProjectId] = useState(null)
  const location = useLocation()
  // 任务执行状态（task_execution_status），用于 WBS/网络图/甘特图统一显示与锁定「已完成」任务
  const [execStatusMap, setExecStatusMap] = useState(() => new Map())
  // 草稿加载确认弹窗（自定义组件，替代浏览器原生 confirm）
  const [draftPrompt, setDraftPrompt] = useState(null) // { versionName }
  const draftPromptResolveRef = useRef(null)
  const resolveDraftPrompt = (useDraft) => {
    setDraftPrompt(null)
    const resolve = draftPromptResolveRef.current
    draftPromptResolveRef.current = null
    if (resolve) resolve(useDraft)
  }
  // 版本规则已应用到会话状态的标记：防止项目记录里的旧排期设置异步加载后覆盖版本规则
  const versionRulesAppliedRef = useRef(false)
  // 把版本的 schedule_rules 应用到会话状态（进入排期流程时与所选版本对齐）。
  // 规则权威来源是版本记录：未保存的一键排期/拖拽改动不写库，重进后回到已保存状态。
  // 注意：工时粒度/每日投入也随版本走——否则重进后与发布版规则签名不一致，
  // 自动保存会误判「有修改」建出幽灵草稿（无修改却弹出加载草稿询问的根因）。
  const applyVersionScheduleRules = (v) => {
    if (!v || !v.schedule_rules) return
    try {
      const rules = JSON.parse(v.schedule_rules)
      if (rules && typeof rules.skip_holidays === 'boolean') setSkipHolidays(rules.skip_holidays)
      if (rules && typeof rules.day_aligned === 'boolean') setDayAligned(rules.day_aligned)
      if (rules && rules.schedule_mode) setScheduleMode(rules.schedule_mode)
      if (rules && rules.start_date) setStartDate(rules.start_date)
      if (rules && rules.end_date) setEndDate(rules.end_date)
      if (rules && rules.daily_input_hours != null) setDailyInputHours(rules.daily_input_hours)
      if (rules && rules.time_rule_unit) setTimeRuleUnit(rules.time_rule_unit)
      if (rules && rules.time_rule_value != null) setTimeRuleValue(rules.time_rule_value)
      versionRulesAppliedRef.current = true
    } catch (e) { /* 解析失败保持现状 */ }
  }

  // 唯一数据源初始化：仅在任务排期流程页（WBS/网络图/甘特图）执行。
  // 项目主页始终显示最新已发布版本，由 ProjectHome 组件自行加载，不走此处。
  // WBS/网络图/甘特图三个视图不再各自独立读库回退，统一以 wbsTreeData 为准，
  // 保证三视图数据完全一致；WBS 实时编辑后通过 onTreeDataChange 把最新树推送回来覆盖此处初值。
  // 用 ref 守护：若 wbsTreeData 已被推送为非空，则种子加载不再覆盖，避免数据打架。
  useEffect(() => {
    if (!currentProjectId) return
    if (!['/wbs', '/network', '/schedule'].includes(location.pathname)) return
    if (wbsTreeDataRef.current != null) return
    let cancelled = false
    // 树加载统一走内容层覆盖：描述/可交付成果以 task_content 最新值为准（跨版本存储），
    // 覆盖需递归到子树（弹窗下钻子任务从 children 取节点）
    const loadContentOverlayTree = async (tree) => {
      const t = tree || []
      if (t.length === 0) return t
      try {
        const rows = await getTaskContentByProject(currentProjectId)
        if (!cancelled) applyTaskContentOverlay(t, rows)
      } catch (e) { /* 内容层缺失时按树字段显示 */ }
      return t
    }
    ;(async () => {
      // 进入排期流程：先检查是否有比项目主页最新发布计划版本号更高的草稿版本。
      // 有 → 询问用户是否加载草稿；选「否」则加载最新发布计划并清除草稿任务数据（版本记录与版本号保留，
      // 后续修改仍保存到该草稿版本，直到发布为止）。无 → 沿用原逻辑按最新版本回放。
      // 最新发布版（回放任务树与排期规则的权威来源），供下方无草稿路径使用
      let latestPublished = null
      try {
        const versions = await getVersionsByProject(currentProjectId)
        const verNum = (v) => { const m = (v.version_name || '').match(/V(\d+)/); return m ? parseInt(m[1], 10) : 0 }
        const isPublished = (v) => v.is_draft === 0 || v.is_draft === false || v.status === '正式版'
        const published = versions
          .filter(isPublished)
          .sort((a, b) => (b.release_time || b.updated_at || b.created_at || '').localeCompare(a.release_time || a.updated_at || a.created_at || ''))
        const publishedNum = published.length > 0 ? verNum(published[0]) : 0
        latestPublished = published[0] || null
        // 有发布版：只认版本号更高的草稿；从未发布过：任何草稿都要询问
        const higherDrafts = versions
          .filter(v => v.is_draft === 1 || v.is_draft === true)
          .filter(v => published.length === 0 || verNum(v) > publishedNum)
          .sort((a, b) => verNum(b) - verNum(a))
        const topDraft = higherDrafts[0] || null
        if (topDraft) {
          const hasPublished = published.length > 0
          // 幽灵草稿过滤：自动保存可能在规则/树尚未加载完等瞬间建出与发布版内容完全一致的草稿，
          // 或历史「取消」路径留下已清空内容的草稿记录。这类草稿没有任何用户修改，静默清除不询问，
          // 直接加载最新发布计划；只有草稿包含真实未发布的修改（内容或规则有差异）才打断用户
          if (hasPublished) {
            const [draftTree, publishedTree] = await Promise.all([
              getProjectWbsTreeByVersion(topDraft.version_ulid).catch(() => null),
              getProjectWbsTreeByVersion(published[0].version_ulid).catch(() => null)
            ])
            const ghostDraft = !draftTree || draftTree.length === 0 ||
              planContentEqual(draftTree, publishedTree || [])
            if (ghostDraft) {
              try { await clearDraftVersionRows(currentProjectId, topDraft.version_ulid) } catch (e) { console.error('清除幽灵草稿失败:', e) }
              if (!cancelled && wbsTreeDataRef.current == null) {
                setWbsTreeData(await loadContentOverlayTree(publishedTree))
                applyVersionScheduleRules(published[0])
              }
              return
            }
          }
          // 用自定义确认弹窗询问（替代浏览器原生 confirm）
          setDraftPrompt({ versionName: topDraft.version_name })
          const useDraft = await new Promise((resolve) => { draftPromptResolveRef.current = resolve })
          if (cancelled) return
          if (useDraft) {
            const draftTree = await getProjectWbsTreeByVersion(topDraft.version_ulid)
            if (!cancelled) {
              setCurrentVersion(topDraft)
              setWbsTreeData(await loadContentOverlayTree(draftTree))
              // 排期规则随草稿版本走（草稿保存时写入的 schedule_rules）
              applyVersionScheduleRules(topDraft)
            }
            return
          }
          // 不加载草稿：清除全部草稿版本的任务数据（先把资源正本指回基线行，版本记录与版本号保留，
          // 后续修改仍存到该版本），基于最新发布计划（无发布版则为空白）重新修改
          const allDrafts = versions.filter(v => v.is_draft === 1 || v.is_draft === true)
          for (const d of allDrafts) {
            try { await clearDraftVersionRows(currentProjectId, d.version_ulid) } catch (e) { console.error('清除草稿数据失败:', e) }
          }
          if (hasPublished) {
            const publishedTree = await getProjectWbsTreeByVersion(published[0].version_ulid)
            if (!cancelled) {
              setWbsTreeData(await loadContentOverlayTree(publishedTree))
              // 放弃草稿后基于发布计划修改，规则与发布版本对齐
              applyVersionScheduleRules(published[0])
            }
          } else if (!cancelled && wbsTreeDataRef.current == null) {
            // 无发布版：没有可回放的计划，保留内存中未保存的任务树（若有），
            // 不能用空树覆盖——否则用户正在编辑的任务会凭空丢失
            setWbsTreeData([])
          }
          return
        }
      } catch (e) {
        console.error('检查草稿版本失败:', e)
      }
      try {
        const tree = await getLatestPlanTree(currentProjectId)
        if (!cancelled && wbsTreeDataRef.current == null) {
          setWbsTreeData(await loadContentOverlayTree(tree))
          // 规则随版本走：无草稿路径也要对齐发布版规则，否则自动保存会因规则签名
          // 不一致（会话状态来自项目记录旧值）误判「有修改」建出幽灵草稿
          applyVersionScheduleRules(latestPublished)
        }
      } catch {
        if (!cancelled && wbsTreeDataRef.current == null) setWbsTreeData([])
      }
    })()
    return () => {
      cancelled = true
      // 路由切换/卸载时关闭尚未应答的草稿询问弹窗
      setDraftPrompt(null)
      draftPromptResolveRef.current = null
    }
  }, [currentProjectId, location.pathname])

  // 排期结果映射（叶子任务 id → 排期开始日期）：进度规划页拖拽/重排只更新排期结果、
  // 不回写任务树 start_date，推导「未开始/已延误」时开始日期以最新排期结果优先，
  // 否则重排延后后任务条仍显示已延误的红色
  const scheduleStartMap = useMemo(() => {
    const m = {}
    ;(scheduleExportData || []).forEach(t => { if (t.startDate) m[String(t.id)] = t.startDate })
    return m
  }, [scheduleExportData])

  // 统一的任务执行状态解析（节点可含 children）：getManual 优先 original_task_id，回退 task_ulid
  const statusOf = useCallback((node) => {
    if (!node) return 'not_started'
    const getManual = (n) => {
      if (!n) return null
      const key = n.original_task_id || n.task_ulid || n.id
      const v = execStatusMap.get(String(key))
      if (v) return v
      const alt = n.task_ulid || n.id
      return alt ? (execStatusMap.get(String(alt)) || null) : null
    }
    const getStartDate = (n) => {
      if (!n) return null
      const key = n.original_task_id || n.task_ulid || n.id
      const scheduled = key ? scheduleStartMap[String(key)] : null
      const alt = n.task_ulid || n.id
      return scheduled || (alt ? scheduleStartMap[String(alt)] : null) || n.start_date || null
    }
    return resolveExecStatus(node, getManual, getStartDate)
  }, [execStatusMap, scheduleStartMap])

  const [projects, setProjects] = useState([])
  const predecessorsSyncRef = useRef(null)
  // WBS 空名任务命名守卫：正在命名且名称为空时阻止切换视图（任务分解→排列顺序/进度规划）
  const wbsEditGuardRef = useRef(null)
  const [currentVersion, setCurrentVersion] = useState(null)
  const [isSaving, setIsSaving] = useState(false)

  // 加载任务执行状态（task_execution_status），供 WBS/网络图/甘特图统一显示「已完成」并锁定编辑。
  // 依赖路由：在其他页面（如项目主页）标记完成后切回排期流程时刷新。
  useEffect(() => {
    if (!currentProjectId) { setExecStatusMap(new Map()); return }
    let cancelled = false
    ;(async () => {
      try {
        await ensureOriginalTaskIds(currentProjectId)
        const rows = await getExecStatusByProject(currentProjectId)
        const m = new Map()
        for (const r of rows || []) {
          if (r.exec_status) m.set(String(r.original_task_id), r.exec_status)
        }
        if (!cancelled) setExecStatusMap(m)
      } catch (e) {
        console.error('加载任务执行状态失败:', e)
        if (!cancelled) setExecStatusMap(new Map())
      }
    })()
    return () => { cancelled = true }
  }, [currentProjectId, location.pathname])
  const navigate = useNavigate()

  useEffect(() => {
    initDefaultData()
    loadProjects()
  }, [])

  // 项目数据在别处发生增删改（侧边栏改名/新建/删除项目等）时，刷新 App 层的项目列表，
  // 保证项目主页顶部标题（EditableProjectTitle 从此处读取项目名）与 DB 保持一致
  useEffect(() => {
    const handler = () => { loadProjects() }
    window.addEventListener('pmflow:projects-changed', handler)
    return () => window.removeEventListener('pmflow:projects-changed', handler)
  }, [])

  // 从URL中提取当前项目ID
  useEffect(() => {
    const path = location.pathname
    let projectId = null
    if (path.startsWith('/project/')) {
      projectId = path.split('/')[2]
    } else if (['/wbs', '/network', '/schedule'].includes(path)) {
      projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
    }
    setCurrentProjectId(projectId || null)
  }, [location])

  // 加载项目成员
  useEffect(() => {
    if (currentProjectId) {
      loadProjectMembers(currentProjectId)
    } else {
      setTeamMembers([])
    }
  }, [currentProjectId])

  // 加载项目排期设置（工时粒度、每日投入）。
  // 注意：项目周期/排期规则不在这里设置——权威来源是版本 schedule_rules
  //（见下方版本加载 effect），避免两个异步加载相互覆盖。
  useEffect(() => {
    if (!currentProjectId) return
    let cancelled = false
    planEnvReadyRef.current = false
    versionRulesAppliedRef.current = false
    getProjectById(currentProjectId)
      .then(project => {
        if (cancelled) return
        // 版本规则（权威来源）已应用时不回填项目记录旧值，避免覆盖导致规则签名不一致
        if (project && !versionRulesAppliedRef.current) {
          if (project.time_rule_unit) setTimeRuleUnit(project.time_rule_unit)
          if (project.time_rule_value != null) setTimeRuleValue(project.time_rule_value)
          if (project.daily_input_hours != null) setDailyInputHours(project.daily_input_hours)
        }
        // 排期设置加载完成（无论项目记录是否有值），自动保存放行
        planEnvReadyRef.current = true
      })
      .catch(() => { planEnvReadyRef.current = true })
    return () => { cancelled = true }
  }, [currentProjectId])

  useEffect(() => {
    if (!downloadDropdownOpen) return
    const handleClickOutside = (e) => {
      const inBtn = downloadBtnRef.current && downloadBtnRef.current.contains(e.target)
      const inMenu = downloadMenuRef.current && downloadMenuRef.current.contains(e.target)
      if (!inBtn && !inMenu) {
        setDownloadDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [downloadDropdownOpen])

  useEffect(() => {
    if (!scheduleDownloadOpen) return
    const handleClickOutside = (e) => {
      const inBtn = scheduleDownloadBtnRef.current && scheduleDownloadBtnRef.current.contains(e.target)
      const inMenu = scheduleDownloadMenuRef.current && scheduleDownloadMenuRef.current.contains(e.target)
      if (!inBtn && !inMenu) {
        setScheduleDownloadOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [scheduleDownloadOpen])

  useEffect(() => {
    if (!currentProjectId) {
      setCurrentVersion(null)
      return
    }
    let cancelled = false
    getLatestVersion(currentProjectId)
      .then(v => {
        if (cancelled) return
        setCurrentVersion(v)
        // 排期规则以最新版本的 schedule_rules 为权威来源（保存草稿时写入）：
        // 未保存的一键排期/拖拽改动不会进入这里，重进页面自然回到已保存状态；
        // 项目主页同样读取版本的 schedule_rules，因此两端永远一致。
        let skip = null
        let dayRule = null
        let ruleStart = null
        let ruleEnd = null
        let ruleMode = null
        if (v && v.schedule_rules) {
          try {
            const rules = JSON.parse(v.schedule_rules)
            if (rules && typeof rules.skip_holidays === 'boolean') skip = rules.skip_holidays
            if (rules && typeof rules.day_aligned === 'boolean') dayRule = rules.day_aligned
            if (rules && rules.start_date) ruleStart = rules.start_date
            if (rules && rules.end_date) ruleEnd = rules.end_date
            if (rules && rules.schedule_mode) ruleMode = rules.schedule_mode
          } catch (e) { /* 解析失败则走兜底 */ }
        }
        if (skip == null || dayRule == null || !ruleStart || !ruleMode) {
          // 兜底：版本无规则（或字段缺失）时沿用项目记录（首版尚未保存 / 旧数据）
          getProjectById(currentProjectId).then(p => {
            if (cancelled || !p) return
            if (skip == null && p.skip_holidays != null) setSkipHolidays(!!p.skip_holidays)
            if (dayRule == null && p.day_aligned != null) setDayAligned(!!p.day_aligned)
            if (!ruleStart && p.start_date) setStartDate(p.start_date)
            if (!ruleEnd && p.end_date) setEndDate(p.end_date)
            if (!ruleMode && p.schedule_mode) setScheduleMode(p.schedule_mode)
          })
        }
        if (skip != null) setSkipHolidays(skip)
        if (dayRule != null) setDayAligned(dayRule)
        if (ruleStart) setStartDate(ruleStart)
        if (ruleEnd) setEndDate(ruleEnd)
        if (ruleMode) setScheduleMode(ruleMode)
      })
      .catch(() => { if (!cancelled) setCurrentVersion(null) })
    return () => { cancelled = true }
  }, [currentProjectId])

  async function loadProjectMembers(projectId) {
    try {
      const members = await getProjectMembers(projectId)
      const formatted = members.map(m => ({
        member_ulid: m.member_ulid,
        role: m.job_role || (m.role === 'OWNER' ? '项目经理' : '未分组'),
        name: m.display_name || '',
        avatar: m.display_name ? m.display_name.charAt(0).toUpperCase() : ''
      }))
      setTeamMembers(formatted)
    } catch (error) {
      console.error('Failed to load project members:', error)
      setTeamMembers([])
    }
  }

  async function loadProjects() {
    try {
      const data = await getProjects()
      setProjects(data)
    } catch (error) {
      console.error('Failed to load projects:', error)
    }
  }

  const handleAddRole = async (roleName) => {
    if (!currentProjectId) return
    try {
      const member = await addProjectMember({
        project_ulid: currentProjectId,
        display_name: '',
        job_role: roleName,
        role: 'VIEWER'
      })
      setTeamMembers(prev => [...prev, {
        member_ulid: member.member_ulid,
        role: roleName,
        name: '',
        avatar: ''
      }])
    } catch (error) {
      console.error('Failed to add role:', error)
    }
  }

  const handleAddMember = async (role, memberName) => {
    if (!currentProjectId) return
    try {
      const avatar = memberName.charAt(0).toUpperCase()
      const member = await addProjectMember({
        project_ulid: currentProjectId,
        display_name: memberName,
        job_role: role,
        role: 'EDITOR'
      })
      setTeamMembers(prev => [...prev, {
        member_ulid: member.member_ulid,
        role,
        name: memberName,
        avatar
      }])
    } catch (error) {
      console.error('Failed to add member:', error)
    }
  }

  const handleRenameRole = async (oldRole, newRole) => {
    setTeamMembers(prev => prev.map(member =>
      member.role === oldRole ? { ...member, role: newRole } : member
    ))
    // 同步到数据库
    try {
      const members = await getProjectMembers(currentProjectId)
      for (const m of members) {
        if (m.job_role === oldRole) {
          await updateProjectMember({ member_ulid: m.member_ulid, job_role: newRole })
        }
      }
    } catch (error) {
      console.error('Failed to rename role:', error)
    }
  }

  const handleDeleteRole = async (role) => {
    const roleMembers = teamMembers.filter(member => member.role === role)
    const hasRealMembers = roleMembers.some(member => member.name && member.name !== '待分配')

    if (!hasRealMembers) {
      // 删除空角色下的所有成员
      for (const member of roleMembers) {
        if (member.member_ulid) {
          await deleteProjectMember(member.member_ulid)
        }
      }
      setTeamMembers(prev => prev.filter(member => member.role !== role))
    } else {
      // 有成员的角色，将成员移至"未分组"
      for (const member of roleMembers) {
        if (member.member_ulid) {
          await updateProjectMember({ member_ulid: member.member_ulid, job_role: '未分组' })
        }
      }
      setTeamMembers(prev => prev.map(member =>
        member.role === role ? { ...member, role: '未分组' } : member
      ))
    }
  }

  const handleRenameMember = async (role, oldName, newName, newRole) => {
    const target = teamMembers.find(m =>
      m.role === role && (m.name === oldName || (!m.name && !oldName))
    )
    setTeamMembers(prev => prev.map(member =>
      member.role === role && (member.name === oldName || (!member.name && !oldName))
        ? { ...member, name: newName, avatar: newName ? newName.charAt(0).toUpperCase() : '', role: newRole || role }
        : member
    ))
    if (target?.member_ulid) {
      try {
        const updates = { member_ulid: target.member_ulid, display_name: newName }
        if (newRole && newRole !== role) {
          updates.job_role = newRole
        }
        await updateProjectMember(updates)
      } catch (error) {
        console.error('Failed to rename member:', error)
      }
    }
  }

  const handleDeleteMember = async (role, memberName) => {
    const target = teamMembers.find(m => m.role === role && m.name === memberName)
    if (target?.member_ulid) {
      try {
        await deleteProjectMember(target.member_ulid)
      } catch (error) {
        console.error('Failed to delete member:', error)
      }
    }
    setTeamMembers(prev => prev.filter(member =>
      !(member.role === role && member.name === memberName)
    ))
  }

  const handleExportSchedule = useCallback((data) => {
    setScheduleExportData(data)
  }, [])

  const getExportData = useCallback(async () => {
    if (!currentProjectId) return []
    try {
      const versions = await getVersionsByProject(currentProjectId)
      const isPublished = (v) => v.is_draft === 0 || v.is_draft === false || v.status === '正式版'
      const sortByTime = (a, b) => {
        const ta = a.release_time || a.updated_at || a.created_at || ''
        const tb = b.release_time || b.updated_at || b.created_at || ''
        return tb.localeCompare(ta)
      }
      const publishedVersions = versions.filter(isPublished).sort(sortByTime)
      let tree = null
      if (publishedVersions.length > 0) {
        tree = await getProjectWbsTreeByVersion(publishedVersions[0].version_ulid)
      }
      if (!tree || tree.length === 0) {
        tree = await getLatestPlanTree(currentProjectId)
      }
      if (!tree || tree.length === 0) return []
      const project = projects.find(p => p.project_ulid === currentProjectId)
      const projectName = project?.name || '进度计划'
      const leaves = buildLeaves(tree, dailyInputHours)
      // 导出前应用任务内容层（描述/可交付成果最新值，跨版本存储）
      try {
        const contentRows = await getTaskContentByProject(currentProjectId)
        applyTaskContentOverlay(leaves, contentRows)
      } catch (e) { /* 内容层缺失时按树字段导出 */ }
      return leaves.map(node => ({
        id: node.id, code: node.code, name: node.name,
        taskType: node.taskType || '等待', totalHours: node.totalHours,
        resources: node.resources || [],
        durationDays: node.hasCustomDuration ? node.customDurationDays : (dailyInputHours > 0 ? Math.ceil((node.totalHours || 0) / dailyInputHours) : 0),
        startDate: node.start_date || '', endDate: node.end_date || '',
        startHour: node.start_hour != null ? node.start_hour : 0,
        endHour: node.end_hour != null ? node.end_hour : 0,
        predecessors: node.predecessors || [],
        description: node.description || '',
        deliverables: node.deliverables || [],
        ancestors: node.ancestors || [],
        projectName,
      }))
    } catch (e) {
      console.error('构建导出数据失败:', e)
      return []
    }
  }, [currentProjectId, dailyInputHours, projects])

  // 加载最新已发布（正式版）版本记录
  const getLatestPublishedVersion = useCallback(async () => {
    if (!currentProjectId) return null
    const versions = await getVersionsByProject(currentProjectId)
    const isPublished = (v) => v.is_draft === 0 || v.is_draft === false || v.status === '正式版'
    const sortByTime = (a, b) => {
      const ta = a.release_time || a.updated_at || a.created_at || ''
      const tb = b.release_time || b.updated_at || b.created_at || ''
      return tb.localeCompare(ta)
    }
    return versions.filter(isPublished).sort(sortByTime)[0] || null
  }, [currentProjectId])

  // 计划版本信息查询：有草稿 → 最新草稿版本（草稿）；无草稿 → 最新发布版本（正式版）
  const getPlanVersionInfo = useCallback(async () => {
    let versionLabel = null
    let versionStatus = null
    if (currentProjectId) {
      try {
        const versions = await getVersionsByProject(currentProjectId)
        const byTime = (a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''))
        const latestDraft = versions.filter(v => v.is_draft === 1 || v.is_draft === true).sort(byTime)[0] || null
        if (latestDraft) {
          versionLabel = latestDraft.version_name || null
          versionStatus = '草稿'
        } else {
          const published = await getLatestPublishedVersion()
          if (published) {
            versionLabel = published.version_name || null
            versionStatus = '正式版'
          }
        }
      } catch (e) { console.error('查询计划版本失败:', e) }
    }
    return { versionLabel, versionStatus }
  }, [currentProjectId, getLatestPublishedVersion])

  // 导出文件名 = 项目名 + 进度计划 + 版本号 +（草稿版追加「草稿」，已发布不显示状态）+ 扩展名
  const buildPlanFileName = useCallback(async (data, ext) => {
    const projectName = data.length > 0 ? data[0].projectName || '进度计划' : '进度计划'
    const { versionLabel, versionStatus } = await getPlanVersionInfo()
    const suffix = versionLabel ? `${versionLabel}${versionStatus === '草稿' ? '草稿' : ''}` : ''
    return `${projectName}进度计划${suffix}.${ext}`
  }, [getPlanVersionInfo])

  // 进度计划 HTML 导出（草稿/正式版共用）：按传入的任务树与规则生成
  const exportPlanHtml = useCallback(async ({ tree, skipHolidays, dailyHours, versionLabel }) => {
    if (!currentProjectId || !tree || tree.length === 0) return
    try {
      const project = projects.find(p => p.project_ulid === currentProjectId)
      const proj = project ? await getProjectById(currentProjectId) : null
      const memberData = await getProjectMembers(currentProjectId)
      const members = memberData.map(m => ({
        member_ulid: m.member_ulid,
        role: m.job_role || (m.role === 'OWNER' ? '项目经理' : '未分组'),
        name: m.display_name || '',
        avatar: m.display_name ? m.display_name.charAt(0).toUpperCase() : ''
      }))
      let startD = startDate || proj?.start_date || null
      if (!startD) {
        let earliest = null
        const walk = (nodes) => { for (const n of nodes || []) { if (n.start_date && (!earliest || n.start_date < earliest)) earliest = n.start_date; if (n.children) walk(n.children) } }
        walk(tree)
        startD = earliest || new Date().toISOString().slice(0, 10)
      }
      let endD = endDate || proj?.end_date || null
      if (!endD) {
        let latest = null
        const walk = (nodes) => { for (const n of nodes || []) { if (n.end_date && (!latest || n.end_date > latest)) latest = n.end_date; if (n.children) walk(n.children) } }
        walk(tree)
        endD = latest || null
      }
      // 任务执行状态/完成进度：导出快照带上手动覆盖（按 original_task_id 关联）
      let execStatusMap = new Map()
      let progressMap = new Map()
      try {
        await ensureOriginalTaskIds(currentProjectId)
        const execRows = await getExecStatusByProject(currentProjectId)
        // 按 updated_at 升序写入：历史重复行（并发拖动竞态产生）时最新值最后落 Map、优先生效
        for (const r of [...(execRows || [])].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))) {
          if (r.exec_status) execStatusMap.set(String(r.original_task_id), r.exec_status)
          if (r.progress !== null && r.progress !== undefined) progressMap.set(String(r.original_task_id), r.progress)
        }
        // 行 task_ulid 别名键：保证导出树节点携带行身份时也能命中手动状态/进度（与主页同值）
        await aliasExecStatusMapsByTaskRow(currentProjectId, execStatusMap, progressMap)
      } catch (e) { console.error('加载任务执行状态失败:', e) }
      // 文件名 = 项目名 + 进度计划 + 版本号 +（草稿版追加「草稿」，已发布不显示状态）
      const projectName = project?.name || '项目'
      const { versionLabel: vLabel, versionStatus: vStatus } = await getPlanVersionInfo()
      const htmlName = `${projectName}进度计划${vLabel || ''}${vStatus === '草稿' ? '草稿' : ''}.html`
      generateProjectHomeHtml({
        projectName,
        downloadName: htmlName,
        tree,
        members,
        startDate: startD,
        endDate: endD,
        skipHolidays: !!skipHolidays,
        dailyInputHours: dailyHours || proj?.daily_input_hours || 8,
        execStatusMap,
        progressMap,
        versionLabel: versionLabel || '草稿'
      })
    } catch (e) { console.error('生成HTML失败:', e) }
  }, [currentProjectId, projects, startDate, endDate, getPlanVersionInfo])

  const handleSaveScheduleToDb = useCallback(async () => {
    if (!scheduleExportData || scheduleExportData.length === 0) return
    console.log('=== 保存进度计划到本地缓存完成 ===', scheduleExportData.map(t => ({
      code: t.code, name: t.name, start_date: t.startDate, end_date: t.endDate,
      start_hour: t.startHour, end_hour: t.endHour
    })))
  }, [scheduleExportData])

  const handleDownloadSchedule = useCallback(async () => {
    if (scheduleExportData && scheduleExportData.length > 0) {
      generateExcel(scheduleExportData, await buildPlanFileName(scheduleExportData, 'csv'))
    }
  }, [scheduleExportData, buildPlanFileName])

  // Word 导出：真正生成 .docx（docx 库），双分节 —— 竖版正文 + 横版附件（自动另起一页）
  const generateWord = useCallback(async (data, filename) => {
    const { versionLabel, versionStatus } = await getPlanVersionInfo()
    const finalFilename = filename || await buildPlanFileName(data, 'docx')
    const blob = await buildScheduleDocxBlob(data, { themeColors, renderGanttImage: svgToPng, versionLabel: versionLabel || '—', versionStatus: versionStatus || '—' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = finalFilename
    document.body.appendChild(link); link.click()
    document.body.removeChild(link); URL.revokeObjectURL(url)
  }, [getPlanVersionInfo, buildPlanFileName])

  const generateHtml = useCallback((data, filename) => {
    const projectName = data.length > 0 ? data[0].projectName || '进度计划' : '进度计划'
    const finalFilename = filename || `${projectName}进度计划.html`
    const maxLevel = data.reduce((max, item) => Math.max(max, (item.ancestors || []).length + 1), 1)
    const idToCode = new Map(data.map(item => [item.id || item.code, item.code]))
    const headers = ['任务编号', '任务名称', '任务类型', '任务总工时(h)', '资源需求', '任务总工期(天)', '前置任务', '可交付成果', '任务描述', '开始时间', '结束时间']
    for (let i = 1; i <= maxLevel; i++) headers.push(`${i}级任务`)
    const rows = data.map(item => {
      const ancestors = item.ancestors || []
      const predCodes = (item.predecessors || []).map(id => idToCode.get(id) || id)
      const row = [
        item.code, item.name, item.taskType || '-', item.totalHours.toFixed(1),
        item.resources?.map(r => `${r.role}${r.name ? `(${r.name})` : ''}: ${r.hours}h`).join('; ') || '-',
        item.duration.toFixed(1),
        predCodes.join('; ') || '-',
        (item.deliverables || []).join('; ') || '-',
        item.description || '-',
        item.startDate || '-', item.endDate || '-'
      ]
      for (let i = 0; i < maxLevel; i++) row.push(i < ancestors.length ? ancestors[i] : '')
      return row
    })
    let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${projectName}进度计划</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 10px;text-align:left}th{background:#f8f9fa;font-weight:600}tr:hover{background:#f1f3f5}</style></head><body><h2>${projectName}进度计划</h2><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = finalFilename
    document.body.appendChild(link); link.click()
    document.body.removeChild(link); URL.revokeObjectURL(url)
  }, [])

  // ---- 项目排期统计（显示在页面标题下方） ----

  const planLeaves = useMemo(() => buildLeaves(wbsTreeData, dailyInputHours), [wbsTreeData, dailyInputHours])
  const planResult = useMemo(
    () => computeSchedule(planLeaves, startDate, skipHolidays, dailyInputHours, {}, null, null, null, dayAligned),
    [planLeaves, startDate, skipHolidays, dailyInputHours, dayAligned]
  )

  // 已完成任务清单（叶子、执行状态 completed、有快照开始日期）：
  // 一键排期时这些任务钉在原位不变，所选开始日期只作用于未完成任务
  const completedSchedTasks = useMemo(() => {
    const out = []
    const walk = (nodes) => (nodes || []).forEach(n => {
      if (n.start_date && (!n.children || n.children.length === 0)) {
        const key = String(n.original_task_id || n.task_ulid || n.id)
        const manual = execStatusMap.get(key) || execStatusMap.get(String(n.task_ulid || n.id)) || null
        if (deriveExecStatus(n, manual) === 'completed') {
          out.push({ id: n.id, startDate: n.start_date, startHour: n.start_hour != null ? Number(n.start_hour) : 0 })
        }
      }
      if (n.children && n.children.length) walk(n.children)
    })
    walk(wbsTreeData || [])
    return out
  }, [wbsTreeData, execStatusMap])

  // ---- 全局排期设置应用（网络图/甘特图等只读页面共用） ----

  const handleApplyDailyInputGlobal = useCallback(async (hours) => {
    setDailyInputHours(hours)
    if (!currentProjectId) return
    try {
      const project = await getProjectById(currentProjectId)
      if (project) {
        await updateRecord('projects', { ...project, daily_input_hours: hours })
      }
    } catch (error) {
      console.error('修改每日投入时间失败:', error)
      alert('修改每日投入时间失败: ' + error.message)
    }
  }, [currentProjectId])

  const handleApplyTimeRuleGlobal = useCallback(async (newUnit, newValue) => {
    if (!currentProjectId) return
    setTimeRuleUnit(newUnit)
    setTimeRuleValue(newValue)
    try {
      const project = await getProjectById(currentProjectId)
      const stateTree = wbsTreeData || []
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
      collectUpdates(stateTree)

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
      const nextTree = applyUpdates(stateTree)

      const dailyStep = newUnit === '分钟' ? 5 : 0.5
      const dailyMax = newUnit === '分钟' ? 1440 : newUnit === '小时' ? 24 : 1
      const dailyUnitValue = hoursToUnitValue(dailyInputHours, newUnit)
      const dailyCeiled = Math.min(dailyMax, ceilToStep(dailyUnitValue, dailyStep))
      const newDailyHours = parseFloat(unitValueToHours(dailyCeiled, newUnit).toFixed(4))

      setDailyInputHours(newDailyHours)
      setWbsTreeData(nextTree)

      if (project) {
        await updateRecord('projects', {
          ...project,
          time_rule_unit: newUnit,
          time_rule_value: newValue,
          daily_input_hours: newDailyHours
        })
      }
    } catch (error) {
      console.error('修改时间规则失败:', error)
      alert('修改时间规则失败: ' + error.message)
    }
  }, [currentProjectId, wbsTreeData, dailyInputHours])

  const renumberAiTree = useCallback((nodes, prefix = '') => {
    return nodes.map((node, index) => {
      const newCode = prefix ? `${prefix}.${index + 1}` : `${index + 1}`
      return {
        ...node,
        code: newCode,
        children: node.children ? renumberAiTree(node.children, newCode) : []
      }
    })
  }, [])

  const handleOpenAiAssistant = useCallback(() => {
    setShowAiAssistant(true)
  }, [])

  // 检查项目周期是否已设置，未设置则打开弹窗并记录待跳转目标
  const handleCheckPeriodAndNavigate = useCallback(async (targetPath) => {
    const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
    if (!projectId) return
    try {
      const project = await getProjectById(projectId)
      // 放行条件：项目记录有开始日期，或最新版本 schedule_rules 已写入开始日期
      //（保存草稿时落库）。一键排期本身不持久化，不影响这里的判断。
      let hasPeriod = !!(project && project.start_date)
      if (!hasPeriod) {
        const v = await getLatestVersion(projectId)
        if (v && v.schedule_rules) {
          try {
            const rules = JSON.parse(v.schedule_rules)
            if (rules && rules.start_date) hasPeriod = true
          } catch (e) { /* 解析失败视为无周期 */ }
        }
      }
      if (hasPeriod) {
        // 已设置项目周期，直接跳转
        navigate(targetPath, { state: { projectId } })
      } else {
        // 未设置项目周期，提示并打开一键排期弹窗
        setToastMsg('请先设置项目周期')
        setTimeout(() => setToastMsg(''), 3000)
        setPendingNavigation({ path: targetPath, projectId })
        setShowPeriodModal(true)
      }
    } catch (error) {
      console.error('检查项目周期失败:', error)
    }
  }, [location, navigate])

  const handleOpenPeriodModal = useCallback(() => {
    setShowPeriodModal(true)
  }, [])

  // 任务分解/排列顺序页的树变更：同步状态，且仅当排期相关内容真正变化时标记「待重新排期」。
  // 组件挂载后会把加载的树原样推送一次，靠签名比对过滤掉，避免误标脏
  const handlePlanningTreeChange = useCallback((tree) => {
    const prev = wbsTreeDataRef.current
    // 回环短路：WBS 推送的树与当前状态内容完全一致时不再 setState。
    // 否则「WBS 推送 → App 换引用下发 initialData → WBS effect 重置再推送」会在乱序导航后
    // 因引用不断翻新形成 Maximum update depth 无限循环，且循环中异步种子回放可能把内存树覆盖丢失。
    // 含内容层字段比对（true）：只改描述/可交付成果时也要穿透短路更新 App 状态，
    // 否则切换页面后组件从 App 状态重新初始化，内容层修改会回退
    if (prev != null && tree != null && planContentEqual(prev, tree, true)) return
    setWbsTreeData(tree)
    if (prev && tree && scheduleSignature(prev) !== scheduleSignature(tree)) {
      setScheduleDirty(true)
    }
  }, [])

  // 修改任务/工时后进入进度规划页：自动打开一键排期弹窗，提醒重新排期（仅提示一次）
  useEffect(() => {
    if (location.pathname === '/schedule' && scheduleDirty && wbsTreeData && wbsTreeData.length > 0) {
      setScheduleDirty(false)
      setShowPeriodModal(true)
    }
  }, [location.pathname, scheduleDirty, wbsTreeData])

  // 日期字符串加减天数（YYYY-MM-DD）
  const addDaysStr = (dateStr, n) => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + n)
    return d.toISOString().split('T')[0]
  }
  const todayStr = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  const handleApplyScheduleConfig = useCallback(async ({ scheduleMode: mode, startDate: s, endDate: e, skipHolidays: sh, dayAligned: da }) => {
    const m = mode === 'backward' ? 'backward' : 'forward'
    const dayAlign = da !== false
    setScheduleMode(m)
    setSkipHolidays(!!sh)
    setDayAligned(dayAlign)
    setScheduleRulesVersion(v => v + 1)
    // 已重新排期，清除待排期标记
    setScheduleDirty(false)

    // 「已完成任务排期不变」：已完成任务钉在快照原位，所选开始日期只作用于未完成任务。
    // 若最早已完成任务的日期早于所选开始日期，甘特图窗口起点前移到它，保证已完成条可见；
    // rescheduleFloor（窗口起点 → 排期起点的位置差）传给引擎，未完成任务不会早于所选起点。
    const earliestC = earliestCompletedDate(completedSchedTasks)
    let finalStart = s || null
    let finalEnd = e || null
    let floorPos = 0
    if (m === 'forward') {
      // 正排弹窗只填开始日期；结束日期仅用于甘特图显示范围，保留项目已有值
      if (!finalEnd) finalEnd = endDate
    }
    if (m === 'backward' && finalEnd) {
      // 倒排：以结束日期为锚点反推开始日期。
      // 已完成任务钉在原位；只统计未完成任务链的跨度 spanUf，
      // 令 开始日期 = 结束日期 - (spanUf - 1)，使未完成工作恰好结束于结束日期；
      // 平移后周末/节假日相对位置会变，迭代至工期稳定（最多 5 次）。
      if ((planLeaves || []).length > 0) {
        let D = null
        let tempStart = finalEnd
        for (let i = 0; i < 5; i++) {
          const winStart = (earliestC && earliestC < tempStart) ? earliestC : tempStart
          const anchors = buildCompletedAnchors(completedSchedTasks, winStart, dailyInputHours)
          const floor = daysBetweenDateStr(winStart, tempStart)
          const res = computeSchedule(planLeaves, winStart, !!sh, dailyInputHours, anchors, null, null, null, dayAlign, floor)
          const list = res.scheduledTasks || []
          if (!list.length) { D = null; break }
          const maxEnd = Math.ceil(Math.max(...list.map(t => t.endPos)))
          const d = Math.max(1, maxEnd - floor)
          if (D != null && d === D) break
          D = d
          tempStart = addDaysStr(finalEnd, -(D - 1))
        }
        finalStart = D != null && D > 0 ? tempStart : todayStr()
      } else {
        finalStart = todayStr()
      }
    } else if (!finalStart) {
      // 正排：未设置开始日期时以今天作为排期起点
      finalStart = todayStr()
    }
    // 甘特图窗口起点 = min(排期起点, 最早已完成日期)；排期起点相对窗口的位置差作为下限
    const winStart = (earliestC && earliestC < finalStart) ? earliestC : finalStart
    floorPos = Math.max(0, daysBetweenDateStr(winStart, finalStart))
    finalStart = winStart
    setStartDate(finalStart)
    setEndDate(finalEnd)
    setRescheduleFloorPos(floorPos)

    // 一键排期是会话级预览：只更新内存状态用于当前页面重算，
    // 不写 projects 记录。规则随「保存草稿」写入版本 schedule_rules，
    // 随「发布」成为项目主页显示的最新进度计划；未保存就离开则自然丢弃。
    // 如果有待跳转的页面，设置完项目周期后执行跳转
    if (pendingNavigation) {
      const target = pendingNavigation
      setPendingNavigation(null)
      navigate(target.path, { state: { projectId: target.projectId } })
    }
  }, [endDate, pendingNavigation, navigate, planLeaves, dailyInputHours, completedSchedTasks])

  // 甘特图排期跨度变化时同步会话内的项目周期（仅内存状态，不落库）。
  // 持久化统一发生在「保存草稿」（写入版本 schedule_rules）。
  const handleSyncPeriod = useCallback((s, e) => {
    if (s && s !== startDate) setStartDate(s)
    if (e && e !== endDate) setEndDate(e)
  }, [startDate, endDate])

  const handleApplyAiWbs = useCallback(async (newTree, newRoles = []) => {
    const renumbered = renumberAiTree(newTree)
    setAppliedWbsTree(renumbered)
    setWbsTreeData(renumbered)
    if (newRoles.length > 0) {
      const existingRoles = new Set((teamMembers || []).map(m => m.role))
      for (const role of newRoles) {
        if (!existingRoles.has(role)) {
          await handleAddRole(role)
        }
      }
    }
  }, [currentProjectId, teamMembers, renumberAiTree])

  const isPlanningPage = ['/wbs', '/network', '/schedule'].includes(location.pathname)
  const isProjectPage = location.pathname.startsWith('/project/')

  const getPageTitle = () => {
    const path = location.pathname.replace('/', '')
    if (path.startsWith('project/')) {
      const projectId = path.split('/')[1]
      return projects.find(p => p.project_ulid === projectId)?.name || '项目主页'
    }
    if (isPlanningPage) {
      const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
      if (projectId) {
        return projects.find(p => p.project_ulid === projectId)?.name || '任务排期'
      }
    }
    switch (path) {
      case 'projects': return '项目管理'
      case 'wbs': return '任务分解'
      case 'network': return '排列顺序'
      case 'schedule': return '进度规划'
      default: return '项目管理'
    }
  }

  const menuTabs = [
    { id: 'wbs', label: '任务分解', path: '/wbs', step: 1 },
    { id: 'network', label: '排列顺序', path: '/network', step: 2 },
    { id: 'schedule', label: '进度规划', path: '/schedule', step: 3 },
  ]

  const calculateTotalHours = (nodes) => {
    let total = 0
    const traverse = (items) => {
      for (const item of items) {
        if (!item.children || item.children.length === 0) {
          total += item.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
        }
        if (item.children) {
          traverse(item.children)
        }
      }
    }
    if (wbsTreeData) {
      traverse(wbsTreeData)
    }
    return total
  }

  const formatTotalHours = () => {
    const totalHours = calculateTotalHours()
    const hours = Math.floor(totalHours)
    const minutes = Math.round((totalHours % 1) * 60)
    const personDays = (totalHours / 8).toFixed(1)
    return `项目总工时：${hours}h ${minutes}min，合${personDays}人天`
  }

  // 草稿导出数据：当前内存中的任务树 + 排期页回传的最新排期日期（与存草稿快照同一份数据）
  const buildDraftExportTree = useCallback(() => {
    if (!wbsTreeData) return []
    if (!scheduleExportData || scheduleExportData.length === 0) return wbsTreeData
    const dateMap = {}
    scheduleExportData.forEach(t => { dateMap[t.id] = { startDate: t.startDate, endDate: t.endDate, startHour: t.startHour, endHour: t.endHour } })
    const merge = (nodes) => nodes.map(n => ({
      ...n,
      start_date: dateMap[n.id]?.startDate || n.start_date || null,
      end_date: dateMap[n.id]?.endDate || n.end_date || null,
      start_hour: dateMap[n.id]?.startHour ?? n.start_hour ?? null,
      end_hour: dateMap[n.id]?.endHour ?? n.end_hour ?? null,
      children: n.children && n.children.length > 0 ? merge(n.children) : []
    }))
    return merge(wbsTreeData)
  }, [wbsTreeData, scheduleExportData])

  // 排期页回传的各任务开始/结束日期映射（id → {startDate, endDate, startHour, endHour}）。
  // 排期引擎算出的日期只存在排期结果与版本快照中，不回写任务树；WBS/网络图的任务详情
  // 弹窗在任务树节点没有 start_date/end_date 时用它兜底显示。
  const scheduleDateMap = useMemo(() => {
    const m = {}
    ;(scheduleExportData || []).forEach(t => {
      const entry = { startDate: t.startDate, endDate: t.endDate, startHour: t.startHour, endHour: t.endHour }
      m[t.id] = entry
      if (t.task_ulid && t.task_ulid !== t.id) m[t.task_ulid] = entry
    })
    // 非叶子任务：由子孙叶子任务的起止聚合（开始取最早、结束取最晚，小时跟随对应叶子），
    // 保证 WBS/网络图的任务详情弹窗对父级任务也能显示起止时间
    const fillParents = (n) => {
      if (n.children && n.children.length > 0) {
        let minS = null, minSh = null, maxE = null, maxEh = null
        n.children.forEach(c => {
          const r = fillParents(c)
          if (!r) return
          if (r.startDate && (minS == null || r.startDate < minS)) { minS = r.startDate; minSh = r.startHour ?? null }
          if (r.endDate && (maxE == null || r.endDate > maxE)) { maxE = r.endDate; maxEh = r.endHour ?? null }
        })
        if (minS && maxE) {
          const entry = { startDate: minS, endDate: maxE, startHour: minSh, endHour: maxEh }
          m[n.id] = entry
          if (n.task_ulid && n.task_ulid !== n.id) m[n.task_ulid] = entry
          return entry
        }
        return null
      }
      const d = m[n.id] || m[String(n.task_ulid || '')]
      return d || null
    }
    ;(wbsTreeData || []).forEach(fillParents)
    return m
  }, [wbsTreeData, scheduleExportData])

  const handleSaveVersion = async (changeSummary = '', changeReason = '') => {
    if (!currentProjectId || !wbsTreeData) return
    setIsSaving(true)
    isSavingRef.current = true
    try {
      const project = await getProjectById(currentProjectId)
      const workspaceUlid = project?.workspace_ulid || null

      const scheduleRules = {
        daily_input_hours: dailyInputHours,
        time_rule_unit: timeRuleUnit,
        time_rule_value: timeRuleValue,
        skip_holidays: skipHolidays,
        day_aligned: dayAligned,
        schedule_mode: scheduleMode,
        start_date: startDate,
        end_date: endDate
      }

      const existingDraft = await getDraftVersion(currentProjectId)

      let version
      if (existingDraft) {
        // 草稿版本号可能是旧的：放弃草稿只清任务行、版本记录保留（继续沿用），
        // 若期间已发布更高版本，草稿名会落后（如草稿 V9 但已发布 V10）。
        // 发布前校名：草稿名必须 = 全部其他版本最大号 + 1，避免发布出重复/回退的版本号
        const allVersions = await getVersionsByProject(currentProjectId)
        const parseNum = (v) => { const m = (v.version_name || '').match(/V(\d+)/); return m ? parseInt(m[1], 10) : 0 }
        const maxOther = allVersions
          .filter(v => v.version_ulid !== existingDraft.version_ulid)
          .reduce((m, v) => Math.max(m, parseNum(v)), 0)
        const draftNum = parseNum(existingDraft)
        const updates = {
          version_ulid: existingDraft.version_ulid,
          schedule_rules: JSON.stringify(scheduleRules),
          change_summary: changeSummary,
          change_reason: changeReason,
          updated_at: new Date().toISOString()
        }
        if (draftNum <= maxOther) updates.version_name = `V${maxOther + 1}`
        const updated = await updateVersion(updates)
        version = { ...existingDraft, ...updates, ...updated }
        console.log('已有草稿版本，覆盖保存, version_ulid:', version.version_ulid, 'version_name:', version.version_name)
      } else {
        const allVersions = await getVersionsByProject(currentProjectId)
        let maxNum = 0
        allVersions.forEach(v => {
          const m = (v.version_name || '').match(/V(\d+)/)
          if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10))
        })
        const nextNum = maxNum + 1

        version = await createVersion({
          project_ulid: currentProjectId,
          version_name: `V${nextNum}`,
          schedule_rules: JSON.stringify(scheduleRules),
          change_summary: changeSummary,
          change_reason: changeReason,
          is_draft: 1
        })
        console.log(`无草稿版本，新建版本: V${nextNum}, version_ulid:`, version.version_ulid)
      }

      const treeToSave = buildDraftExportTree()

      await saveVersionSnapshot(currentProjectId, workspaceUlid, version.version_ulid, treeToSave)

      const { getTasksByVersion, getVersionById } = await import('./utils/db.js')
      const savedVersion = await getVersionById(version.version_ulid)
      console.log('=== 版本记录全部字段 ===')
      console.log(JSON.parse(JSON.stringify(savedVersion)))

      const savedTasks = await getTasksByVersion(version.version_ulid)
      console.log('=== IndexedDB中保存的任务（含version_ulid/change_type/start_date/end_date） ===')
      savedTasks.forEach(t => {
        console.log(`  ${t.code} ${t.name} | version_ulid: ${t.version_ulid} | change_type: ${t.change_type} | start_date: ${t.start_date} | end_date: ${t.end_date}`)
      })
      console.log('完整数据:', JSON.parse(JSON.stringify(savedTasks)))
      setCurrentVersion(version)
      return version
    } catch (error) {
      console.error('保存版本失败:', error)
    } finally {
      setIsSaving(false)
      isSavingRef.current = false
    }
  }

  // 支持传入刚保存的版本对象：保存与发布在同一次异步流程中时，
  // currentVersion state 可能尚未更新，直接传参更可靠
  const handlePublishVersion = async (versionToPublish = null) => {
    if (!versionToPublish && !currentVersion) return
    const target = versionToPublish || currentVersion
    try {
      const published = await updateVersion({
        version_ulid: target.version_ulid,
        is_draft: 0,
        status: '正式版',
        release_time: new Date().toISOString()
      })
      setCurrentVersion(published)
      console.log('=== 版本已发布为正式版，版本状态已修改成功，版本信息如下 ===')
      console.log(JSON.parse(JSON.stringify(published)))
      return published
    } catch (error) {
      console.error('发布版本失败:', error)
    }
  }

  // 比较「当前内存中的进度计划」与某个版本记录是否完全一致
  // rulesSig：当前排期规则签名（与版本 schedule_rules 换算后对比，规则变化也算有修改）
  const comparePlanToVersion = async (formalVersionUlid, db, rulesSig = '') => {
    // 排期规则对比
    try {
      const versionRow = await db.getVersionById(formalVersionUlid)
      const r = JSON.parse(versionRow?.schedule_rules || '{}')
      const vRulesSig = JSON.stringify([
        r.daily_input_hours ?? null, r.time_rule_unit ?? null, r.time_rule_value ?? null,
        !!r.skip_holidays, r.day_aligned !== false, r.schedule_mode || 'forward',
        r.start_date || null, r.end_date || null
      ])
      if (rulesSig && rulesSig !== vRulesSig) return false
    } catch (e) { /* 版本规则缺失时不拦截 */ }
    const dateMap = {}
    if (scheduleExportData && scheduleExportData.length > 0) {
      scheduleExportData.forEach(t => { dateMap[t.id] = { startDate: t.startDate, endDate: t.endDate } })
    }
    const buildSignature = (nodes) => {
      const map = {}
      const walk = (ns) => {
        ns.forEach(n => {
          const d = dateMap[n.id] || {}
          const res = (n.resources || []).map(r => `${r.role}|${r.name}|${r.hours}`).sort().join(';')
          map[n.code] = {
            name: n.name || '',
            start: d.startDate || n.start_date || null,
            end: d.endDate || n.end_date || null,
            hours: n.hours ?? 0,
            status: n.status || '',
            duration: n.duration || '',
            pred: (n.predecessors || []).slice().sort().join(','),
            res,
            type: n.taskType || '',
            custom: n.customDurationDays ?? null
          }
          if (n.children && n.children.length) walk(n.children)
        })
      }
      walk(nodes)
      return map
    }
    const sigA = buildSignature(wbsTreeData)
    // 对比「正式版」完整还原后的任务树（而非该版本的增量行）
    const planTree = await db.getProjectWbsTreeByVersion(formalVersionUlid)
    const flatTree = []
    const walkTree = (ns) => ns.forEach(n => { flatTree.push(n); if (n.children) walkTree(n.children) })
    walkTree(planTree || [])
    const sigB = {}
    flatTree.forEach(t => {
      const rs = (t.resources || []).map(r => `${r.role}|${r.name}|${r.hours}`).sort().join(';')
      sigB[t.code] = {
        name: t.name || '',
        start: t.start_date || null,
        end: t.end_date || null,
        hours: t.hours ?? 0,
        status: t.status || '',
        duration: t.duration || '',
        pred: (t.predecessors || []).slice().sort().join(','),
        res: rs,
        type: t.taskType || '',
        custom: t.customDurationDays ?? null
      }
    })
    const keysA = Object.keys(sigA).sort()
    const keysB = Object.keys(sigB).sort()
    if (keysA.length !== keysB.length) return false
    if (keysA.join(',') !== keysB.join(',')) return false
    for (const k of keysA) {
      const a = sigA[k], b = sigB[k]
      if (a.name !== b.name || a.start !== b.start || a.end !== b.end ||
        a.hours !== b.hours || a.status !== b.status || a.duration !== b.duration ||
        a.pred !== b.pred || a.res !== b.res ||
        a.type !== b.type || a.custom !== b.custom) return false
    }
    return true
  }

  // 当前排期规则签名（自动保存变更检测用）
  const buildRulesSignature = () => JSON.stringify([
    dailyInputHours ?? null, timeRuleUnit ?? null, timeRuleValue ?? null,
    !!skipHolidays, dayAligned !== false, scheduleMode || 'forward',
    startDate || null, endDate || null
  ])

  // ===== 修改后自动保存草稿 =====
  const isSavingRef = useRef(false)
  const autoSaveTimerRef = useRef(null)
  // 排期环境（项目排期设置 + 任务树）加载完成前禁止自动保存：
  // 加载是异步的，此前规则状态还是默认值，会误判「有修改」建出幽灵草稿
  const planEnvReadyRef = useRef(false)

  // 有实际修改才写草稿：与现有草稿一致→跳过；无草稿且与最新正式版一致→不产生草稿
  const autoSaveDraft = async () => {
    if (!currentProjectId || !wbsTreeData || wbsTreeData.length === 0) return
    if (isSavingRef.current) return
    if (!planEnvReadyRef.current) return
    try {
      const db = await import('./utils/db.js')
      const allVersions = await db.getVersionsByProject(currentProjectId)
      const sortByTime = (a, b) => {
        const ta = a.release_time || a.updated_at || a.created_at || ''
        const tb = b.release_time || b.updated_at || b.created_at || ''
        return tb.localeCompare(ta)
      }
      const rulesSig = buildRulesSignature()
      const existingDraft = allVersions.filter(v => v.is_draft === 1).sort(sortByTime)[0]
      if (existingDraft) {
        // 与草稿内容一致：无需重复写库
        const identical = await comparePlanToVersion(existingDraft.version_ulid, db, rulesSig)
        if (identical) return
      } else {
        // 无草稿：与最新正式版完全一致时不产生新草稿
        const latestFormal = allVersions.filter(v => v.is_draft === 0 && v.status === '正式版').sort(sortByTime)[0]
        if (latestFormal && await comparePlanToVersion(latestFormal.version_ulid, db, rulesSig)) return
      }
      await handleSaveVersion('自动保存')
    } catch (error) {
      console.error('自动保存草稿失败:', error)
    }
  }

  // 任务树 / 排期结果 / 排期规则任一变化后，防抖 1 秒自动写入草稿版本
  useEffect(() => {
    if (!currentProjectId || !wbsTreeData || wbsTreeData.length === 0) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => { autoSaveDraft() }, 1000)
    return () => clearTimeout(autoSaveTimerRef.current)
  }, [wbsTreeData, scheduleExportData, dailyInputHours, timeRuleUnit, timeRuleValue, skipHolidays, dayAligned, scheduleMode, startDate, endDate, currentProjectId])

  return (
    <div className="app">
      {!isPlanningPage && (
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
          extraNavItems={typeof renderSidebarNavItems === 'function' ? renderSidebarNavItems() : renderSidebarNavItems}
          extraUserMenuItems={extraUserMenuItems}
        />
      )}
      <main className={`content ${isPlanningPage ? 'content-full-width' : ''}`}>
        <header className="content-header">
          <>
              <div className={`header-title ${isProjectPage ? 'header-title-project' : ''} ${isPlanningPage ? 'header-title-planning' : ''} ${location.pathname === '/ai' ? 'has-tooltip' : ''}`}>
                {/* 侧边栏收起后，展开按钮内嵌在标题行最左侧，与项目名称同一行 */}
                {!isPlanningPage && sidebarCollapsed && (
                  <button className="sidebar-expand-btn" onClick={() => setSidebarCollapsed(false)} title="展开菜单">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                )}
                {/* 任务排期流程页：返回图标，点击返回项目主页（项目主页不显示任何图标） */}
                {isPlanningPage && (
                  <button className="home-btn" onClick={() => {
                    const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
                    if (projectId) {
                      navigate(`/project/${projectId}`)
                    } else {
                      navigate(homePath)
                    }
                  }} title="返回项目主页">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="19" y1="12" x2="5" y2="12"/>
                      <polyline points="12 19 5 12 12 5"/>
                    </svg>
                  </button>
                )}
                <div className="header-title-block">
                    {/* 第一行：项目名称 + AI助理（仅任务排期页显示，紧跟名称之后） */}
                    <div className="header-title-row">
                      {isPlanningPage || isProjectPage ? (
                        <EditableProjectTitle
                          projectId={location.state?.projectId || new URLSearchParams(location.search).get('projectId') || location.pathname.split('/')[2]}
                          projects={projects}
                          setProjects={setProjects}
                        />
                      ) : location.pathname === '/projects' ? (
                        /* 项目管理页：标题 + 项目数量描述语，与项目主页（标题+统计条）两行结构等高统一 */
                        <div className="header-title-block">
                          <h2>{getPageTitle()}</h2>
                          <span className="header-title-desc">共 {projects.length} 个项目</span>
                        </div>
                      ) : (
                        <h2>{getPageTitle()}</h2>
                      )}
                      {/* AI助理入口已按要求隐藏（任务排期三页） */}
                    </div>
                    {/* 任务排期页面第二行：团队人数 / 工时粒度 / 每日投入
                        （由各排期页面通过 createPortal 渲染 PlanningHeaderStats 到此槽位） */}
                    {isPlanningPage && <div id="planning-header-stats-slot" />}
                    {/* 项目主页第二行：项目周期 / 总体进度 / 计划版本（修改、下载按钮跟在版本名称后），四个视图通用
                        （数据由 ProjectHome 上报，见 projectHeaderInfo） */}
                    {isProjectPage && projectHeaderInfo && (
                      <div className="project-stats-bar">
                        <div className="project-stat">
                          <button
                            className="icon-btn project-members-btn"
                            onClick={() => projectHeaderInfo.toggleMembersSidebar && projectHeaderInfo.toggleMembersSidebar()}
                            title="查看成员列表"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                              <circle cx="9" cy="7" r="4" />
                              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                            </svg>
                            <span className="icon-btn-text">{projectHeaderInfo.membersCount != null ? `${projectHeaderInfo.membersCount}人` : '—'}</span>
                          </button>
                        </div>
                        {/* 无任务（尚未创建/发布进度计划）时只显示成员数量，不显示项目周期/总体进度/计划版本 */}
                        {!projectHeaderInfo.noTasks && (
                          <>
                        <span className="project-stat-divider" />
                        <div className="project-stat">
                          <span className="project-stat-label">项目周期</span>
                          <span className="project-stat-value">{projectHeaderInfo.startDate || '—'} 至 {projectHeaderInfo.endDate || '—'}</span>
                        </div>
                        <span className="project-stat-divider" />
                        <div className="project-stat">
                          <span className="project-stat-label">总体进度</span>
                          <span className="project-stat-progress">
                            <span className="project-stat-track">
                              <span className="project-stat-fill" style={{ width: `${projectHeaderInfo.overall}%` }} />
                            </span>
                            <span className="project-stat-pct">{projectHeaderInfo.overall}%</span>
                          </span>
                        </div>
                        <span className="project-stat-divider" />
                        <div className="project-stat">
                          <span className="project-stat-label">计划版本</span>
                          <b className="project-stat-version">{projectHeaderInfo.versionLabel || '草稿'}</b>
                          <IconButton
                            text="修改"
                            icon={
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>
                                <path d="M15 5l4 4"/>
                              </svg>
                            }
                            onClick={() => {
                              const projectId = location.pathname.split('/')[2]
                              window.open(`${window.location.origin}/wbs?projectId=${projectId}`, '_blank')
                            }}
                            tooltip="进入任务排期修改计划"
                          />
                          <div className="download-dropdown-wrapper">
                            <button className="icon-btn download-trigger-btn" ref={downloadBtnRef}
                              onClick={() => { clearTimeout(downloadCloseTimer.current); setDownloadDropdownOpen(v => !v) }}
                              onMouseEnter={() => { clearTimeout(downloadCloseTimer.current); setDownloadDropdownOpen(true) }}
                              onMouseLeave={() => { downloadCloseTimer.current = setTimeout(() => setDownloadDropdownOpen(false), 200) }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                              </svg>
                              <span className="icon-btn-text">下载</span>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '2px' }}>
                                <polyline points="6 9 12 15 18 9"/>
                              </svg>
                            </button>
                            {downloadDropdownOpen && (
                              <div className="download-dropdown-menu" ref={downloadMenuRef}
                                onMouseEnter={() => clearTimeout(downloadCloseTimer.current)}
                                onMouseLeave={() => { downloadCloseTimer.current = setTimeout(() => setDownloadDropdownOpen(false), 200) }}>
                                <div className="download-dropdown-item" onClick={async () => {
                                  const data = await getExportData()
                                  if (data.length > 0) { generateExcel(data, await buildPlanFileName(data, 'csv')); setDownloadDropdownOpen(false) }
                                }}>
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <polyline points="14 2 14 8 20 8"/>
                                    <line x1="16" y1="13" x2="8" y2="13"/>
                                    <line x1="16" y1="17" x2="8" y2="17"/>
                                  </svg>
                                  <div className="download-dropdown-text">
                                    <span className="download-dropdown-label">Excel 表格</span>
                                    <span className="download-dropdown-desc">结构化数据，可用于数据分析和二次加工</span>
                                  </div>
                                </div>
                                <div className="download-dropdown-item" onClick={async () => {
                                  const data = await getExportData()
                                  if (data.length > 0) { generateWord(data); setDownloadDropdownOpen(false) }
                                }}>
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <polyline points="14 2 14 8 20 8"/>
                                    <path d="M9 13h2"/>
                                    <path d="M9 17h6"/>
                                  </svg>
                                  <div className="download-dropdown-text">
                                    <span className="download-dropdown-label">Word 文档</span>
                                    <span className="download-dropdown-desc">可直接打印或分发的进度计划文档</span>
                                  </div>
                                </div>
                                <div className="download-dropdown-item" onClick={async () => {
                                  if (!currentProjectId) return
                                  try {
                                    const versions = await getVersionsByProject(currentProjectId)
                                    const isPublished = (v) => v.is_draft === 0 || v.is_draft === false || v.status === '正式版'
                                    const sortByTime = (a, b) => {
                                      const ta = a.release_time || a.updated_at || a.created_at || ''
                                      const tb = b.release_time || b.updated_at || b.created_at || ''
                                      return tb.localeCompare(ta)
                                    }
                                    const publishedVersions = versions.filter(isPublished).sort(sortByTime)
                                    let tree = null
                                    if (publishedVersions.length > 0) {
                                      tree = await getProjectWbsTreeByVersion(publishedVersions[0].version_ulid)
                                    }
                                    if (!tree || tree.length === 0) {
                                      tree = await getLatestPlanTree(currentProjectId)
                                    }
                                    if (!tree || tree.length === 0) return
                                    const project = projects.find(p => p.project_ulid === currentProjectId)
                                    const proj = project ? await getProjectById(currentProjectId) : null
                                    const memberData = await getProjectMembers(currentProjectId)
                                    const members = memberData.map(m => ({
                                      member_ulid: m.member_ulid,
                                      role: m.job_role || (m.role === 'OWNER' ? '项目经理' : '未分组'),
                                      name: m.display_name || '',
                                      avatar: m.display_name ? m.display_name.charAt(0).toUpperCase() : ''
                                    }))
                                    let skipHolidays = false
                                    if (publishedVersions.length > 0) {
                                      try { const rules = JSON.parse(publishedVersions[0].schedule_rules || '{}'); if (rules.skip_holidays != null) skipHolidays = !!rules.skip_holidays } catch {}
                                    }
                                    if (!skipHolidays && proj) skipHolidays = !!proj.skip_holidays
                                    let startD = proj?.start_date
                                    if (!startD) {
                                      let earliest = null
                                      const walk = (nodes) => { for (const n of nodes || []) { if (n.start_date && (!earliest || n.start_date < earliest)) earliest = n.start_date; if (n.children) walk(n.children) } }
                                      walk(tree)
                                      startD = earliest || new Date().toISOString().slice(0, 10)
                                    }
                                    let endD = proj?.end_date
                                    if (!endD) {
                                      let latest = null
                                      const walk = (nodes) => { for (const n of nodes || []) { if (n.end_date && (!latest || n.end_date > latest)) latest = n.end_date; if (n.children) walk(n.children) } }
                                      walk(tree)
                                      endD = latest || null
                                    }
                                    // 任务执行状态/完成进度：导出快照带上手动覆盖（按 original_task_id 关联）
                                    let execStatusMap = new Map()
                                    let progressMap = new Map()
                                    try {
                                      await ensureOriginalTaskIds(currentProjectId)
                                      const execRows = await getExecStatusByProject(currentProjectId)
                                      // 按 updated_at 升序写入：历史重复行（并发拖动竞态产生）时最新值最后落 Map、优先生效
                                      for (const r of [...(execRows || [])].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))) {
                                        if (r.exec_status) execStatusMap.set(String(r.original_task_id), r.exec_status)
                                        if (r.progress !== null && r.progress !== undefined) progressMap.set(String(r.original_task_id), r.progress)
                                      }
                                      // 行 task_ulid 别名键：保证导出树节点携带行身份时也能命中手动状态/进度（与主页同值）
                                      await aliasExecStatusMapsByTaskRow(currentProjectId, execStatusMap, progressMap)
                                    } catch (e) { console.error('加载任务执行状态失败:', e) }
                                    // 文件名 = 项目名 + 进度计划 + 版本号 +（草稿版追加「草稿」，已发布不显示状态）
                                    const htmlProjName = project?.name || '项目'
                                    const { versionLabel: vLabel, versionStatus: vStatus } = await getPlanVersionInfo()
                                    generateProjectHomeHtml({
                                      projectName: htmlProjName,
                                      downloadName: `${htmlProjName}进度计划${vLabel || ''}${vStatus === '草稿' ? '草稿' : ''}.html`,
                                      tree, members, startDate: startD, endDate: endD,
                                      skipHolidays, dailyInputHours: proj?.daily_input_hours || 8,
                                      execStatusMap, progressMap,
                                      versionLabel: projectHeaderInfo?.versionLabel || '草稿'
                                    })
                                    setDownloadDropdownOpen(false)
                                  } catch (e) { console.error('生成HTML失败:', e) }
                                }}>
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="16 18 22 12 16 6"/>
                                    <polyline points="8 6 2 12 8 18"/>
                                  </svg>
                                  <div className="download-dropdown-text">
                                    <span className="download-dropdown-label">HTML 文件</span>
                                    <span className="download-dropdown-desc">带交互的进度计划，包含甘特图等多种视图</span>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        </>
                        )}
                      </div>
                    )}
                  </div>
              </div>
              {isPlanningPage && (
              <div className="header-center">
                <div className="stepper">
                  {menuTabs.map((tab, index) => (
                    <div key={tab.id} className="stepper-item">
                      <button
                        className={`stepper-step ${location.pathname === tab.path ? 'active' : ''}`}
                        onClick={() => {
                          // 正在 WBS 命名空名任务：提示且阻止切换视图
                          if (wbsEditGuardRef.current && wbsEditGuardRef.current()) return
                          const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
                          // 仅当已有任务时才检查项目周期；无任务时直接进入，显示空任务提示
                          if (tab.path === '/schedule' && projectId && wbsTreeData && wbsTreeData.length > 0) {
                            // 跳转到进度规划页面前，检查项目周期
                            handleCheckPeriodAndNavigate(tab.path)
                          } else if (projectId) {
                            navigate(tab.path, { state: { projectId } })
                          } else {
                            navigate(tab.path)
                          }
                        }}
                      >
                        <span className="step-number">{tab.step}</span>
                        <span className="step-label">{tab.label}</span>
                      </button>
                      {index < menuTabs.length - 1 && <div className={`stepper-line ${location.pathname === '/schedule' || (location.pathname === '/network' && index === 0) || (location.pathname === '/wbs' && index === 0) ? 'completed' : ''}`} />}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {isPlanningPage && (
              <div className="nav-buttons">
                <button
                  className="stepper-nav-btn prev"
                  onClick={() => {
                    // 正在 WBS 命名空名任务：提示且阻止切换视图
                    if (wbsEditGuardRef.current && wbsEditGuardRef.current()) return
                    const currentIndex = menuTabs.findIndex(tab => tab.path === location.pathname)
                    if (currentIndex > 0) {
                      const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
                      if (projectId) {
                        navigate(menuTabs[currentIndex - 1].path, { state: { projectId } })
                      } else {
                        navigate(menuTabs[currentIndex - 1].path)
                      }
                    }
                  }}
                  disabled={location.pathname === '/wbs'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6"/>
                  </svg>
                  上一步
                </button>
                {currentProjectId && wbsTreeData && wbsTreeData.length > 0 && location.pathname === '/schedule' && (
                  <div className="download-dropdown-wrapper" style={{ marginRight: '8px' }}>
                    <button className="icon-btn download-trigger-btn" ref={scheduleDownloadBtnRef}
                      onClick={() => { clearTimeout(scheduleDownloadCloseTimer.current); setScheduleDownloadOpen(v => !v) }}
                      onMouseEnter={() => { clearTimeout(scheduleDownloadCloseTimer.current); setScheduleDownloadOpen(true) }}
                      onMouseLeave={() => { scheduleDownloadCloseTimer.current = setTimeout(() => setScheduleDownloadOpen(false), 200) }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      <span className="icon-btn-text">下载</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '2px' }}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
                    </button>
                    {scheduleDownloadOpen && (
                      <div className="download-dropdown-menu" ref={scheduleDownloadMenuRef}
                        style={{ left: 'auto', right: 0 }}
                        onMouseEnter={() => clearTimeout(scheduleDownloadCloseTimer.current)}
                        onMouseLeave={() => { scheduleDownloadCloseTimer.current = setTimeout(() => setScheduleDownloadOpen(false), 200) }}>
                        <div className="download-dropdown-item" onClick={async () => {
                          if (scheduleExportData?.length > 0) { generateExcel(scheduleExportData, await buildPlanFileName(scheduleExportData, 'csv')); setScheduleDownloadOpen(false) }
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                          </svg>
                          <div className="download-dropdown-text">
                            <span className="download-dropdown-label">Excel 表格</span>
                            <span className="download-dropdown-desc">当前草稿计划的结构化数据，可用于数据分析</span>
                          </div>
                        </div>
                        <div className="download-dropdown-item" onClick={() => {
                          if (scheduleExportData?.length > 0) { generateWord(scheduleExportData); setScheduleDownloadOpen(false) }
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <path d="M9 13h2"/>
                            <path d="M9 17h6"/>
                          </svg>
                          <div className="download-dropdown-text">
                            <span className="download-dropdown-label">Word 文档</span>
                            <span className="download-dropdown-desc">当前草稿计划的文档，可直接打印或分发</span>
                          </div>
                        </div>
                        <div className="download-dropdown-item" onClick={async () => {
                          await exportPlanHtml({ tree: buildDraftExportTree(), skipHolidays, dailyHours: dailyInputHours, versionLabel: '草稿' })
                          setScheduleDownloadOpen(false)
                        }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="16 18 22 12 16 6"/>
                            <polyline points="8 6 2 12 8 18"/>
                          </svg>
                          <div className="download-dropdown-text">
                            <span className="download-dropdown-label">HTML 文件</span>
                            <span className="download-dropdown-desc">当前草稿计划的交互页面，包含甘特图等视图</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <button
                  className="stepper-nav-btn next"
                  disabled={isSaving && location.pathname === '/schedule'}
                  onClick={async () => {
                    // 正在 WBS 命名空名任务：提示且阻止切换视图
                    if (location.pathname !== '/schedule' && wbsEditGuardRef.current && wbsEditGuardRef.current()) return
                    if (location.pathname === '/schedule') {
                      // 与最新正式版对比：进度计划没有任何修改时，直接提示「无需发布」
                      const db = await import('./utils/db.js')
                      const allVersions = await db.getVersionsByProject(currentProjectId)
                      const formalVersions = allVersions.filter(v => v.is_draft === 0 && v.status === '正式版')
                      const latestFormal = formalVersions.sort(
                        (a, b) => new Date(b.release_time || b.updated_at || 0) - new Date(a.release_time || a.updated_at || 0)
                      )[0]
                      if (latestFormal) {
                        const identical = await comparePlanToVersion(latestFormal.version_ulid, db, buildRulesSignature())
                        if (identical) {
                          setNoChangeType('publish')
                          setShowNoChangeModal(true)
                          return
                        }
                      }
                      // 有修改：保存草稿版本并发布为正式版，成功后打开「计划已发布」弹窗
                      const version = await handleSaveVersion('进度计划保存')
                      if (!version) return
                      const published = await handlePublishVersion(version)
                      if (published) {
                        setPublishedVersionLabel(version.version_name || '')
                        setShowSaveModal(true)
                      }
                    } else {
                      const currentIndex = menuTabs.findIndex(tab => tab.path === location.pathname)
                      if (currentIndex < menuTabs.length - 1) {
                        const nextPath = menuTabs[currentIndex + 1].path
                        const projectId = location.state?.projectId || new URLSearchParams(location.search).get('projectId')
                        // 仅当已有任务时才检查项目周期；无任务时直接进入，显示空任务提示
                        if (nextPath === '/schedule' && projectId && wbsTreeData && wbsTreeData.length > 0) {
                          // 下一步是进度规划，检查项目周期
                          handleCheckPeriodAndNavigate(nextPath)
                        } else if (projectId) {
                          navigate(nextPath, { state: { projectId } })
                        } else {
                          navigate(nextPath)
                        }
                      }
                    }
                  }}
                >
                  {location.pathname === '/schedule' ? '发布进度计划' : '下一步'}
                  {location.pathname !== '/schedule' && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  )}
                </button>
              </div>
            )}
          </>
        </header>
        <div className={`content-body ${location.pathname === '/ai' ? 'ai-chat-body' : ''}`}>
          <Routes>
            <Route path="/projects" element={<ProjectList />} />
            <Route path="/project/:projectId" element={<ProjectHome onHeaderInfo={setProjectHeaderInfo} />} />
            <Route path="/wbs" element={<WbsBreakdown
            onTreeDataChange={handlePlanningTreeChange}
            appliedTree={appliedWbsTree}
            teamMembers={teamMembers} 
            setTeamMembers={setTeamMembers} 
            onShowTeamModal={() => setShowTeamModal(true)}
            onAddRole={handleAddRole}
            onAddMember={handleAddMember}
            onRenameRole={handleRenameRole}
            onDeleteRole={handleDeleteRole}
            onRenameMember={handleRenameMember}
            onDeleteMember={handleDeleteMember}
            initialData={wbsTreeData}
            dailyInputHours={dailyInputHours}
            setDailyInputHours={setDailyInputHours}
            timeRuleUnit={timeRuleUnit}
            setTimeRuleUnit={setTimeRuleUnit}
            timeRuleValue={timeRuleValue}
            setTimeRuleValue={setTimeRuleValue}
            isMemberListExpanded={isMemberListExpanded}
            setIsMemberListExpanded={setIsMemberListExpanded}
            startDate={startDate}
            setStartDate={setStartDate}
            skipHolidays={skipHolidays}
            setSkipHolidays={setSkipHolidays}
            endDate={endDate}
            onOpenPeriodModal={handleOpenPeriodModal}
            onAiAssistant={handleOpenAiAssistant}
            predecessorsSyncRef={predecessorsSyncRef}
            editGuardRef={wbsEditGuardRef}
            statusOf={statusOf}
            scheduleDateMap={scheduleDateMap}
          />} />
            <Route path="/network" element={<NetworkDiagramStandalone
              wbsTreeData={wbsTreeData}
              predecessorsSyncRef={predecessorsSyncRef}
              onTreeDataChange={handlePlanningTreeChange}
              teamMembers={teamMembers}
              onShowTeamModal={() => setShowTeamModal(true)}
              onAddMember={handleAddMember}
              onAddRole={handleAddRole}
              isMemberListExpanded={isMemberListExpanded}
              setIsMemberListExpanded={setIsMemberListExpanded}
              timeRuleUnit={timeRuleUnit}
              timeRuleValue={timeRuleValue}
              dailyInputHours={dailyInputHours}
              startDate={startDate}
              setStartDate={setStartDate}
              skipHolidays={skipHolidays}
              setSkipHolidays={setSkipHolidays}
              endDate={endDate}
              onOpenPeriodModal={handleOpenPeriodModal}
              onApplyTimeRule={handleApplyTimeRuleGlobal}
              onApplyDailyInput={handleApplyDailyInputGlobal}
              onAiAssistant={handleOpenAiAssistant}
              projectId={currentProjectId}
              statusOf={statusOf}
              scheduleDateMap={scheduleDateMap}
            />} />
            <Route path="/schedule" element={<ProjectSchedule wbsTreeData={wbsTreeData} teamMembers={teamMembers} 
            onAddRole={handleAddRole}
            onAddMember={handleAddMember}
            onRenameRole={handleRenameRole}
            onDeleteRole={handleDeleteRole}
            onRenameMember={handleRenameMember}
            onDeleteMember={handleDeleteMember}
            onExportSchedule={handleExportSchedule}
            dailyInputHours={dailyInputHours}
            timeRuleUnit={timeRuleUnit}
            timeRuleValue={timeRuleValue}
            isMemberListExpanded={isMemberListExpanded}
            setIsMemberListExpanded={setIsMemberListExpanded}
            startDate={startDate}
            setStartDate={setStartDate}
            skipHolidays={skipHolidays}
            setSkipHolidays={setSkipHolidays}
            dayAligned={dayAligned}
            scheduleRulesVersion={scheduleRulesVersion}
            rescheduleFloorPos={rescheduleFloorPos}
endDate={endDate}
            onOpenPeriodModal={handleOpenPeriodModal}
            onApplyTimeRule={handleApplyTimeRuleGlobal}
            onApplyDailyInput={handleApplyDailyInputGlobal}
            onAiAssistant={handleOpenAiAssistant}
            projectId={currentProjectId}
            onSyncPeriod={handleSyncPeriod}
            onTreeDataChange={setWbsTreeData}
            projectName={projects.find(p => p.project_ulid === currentProjectId)?.name || '进度计划'}
            statusOf={statusOf}
          />} />
            <Route path="/" element={<Navigate to={homePath} />} />
            {extraRoutes}
          </Routes>
        </div>
      </main>

      {showTeamModal && (
        <TeamMembers
          onClose={() => setShowTeamModal(false)}
        />
      )}

      {/* AI 助理插槽：开源核心不渲染任何 AI 组件，official 版经 createApp 的
          renderAiAssistant 注入实现（入参：isOpen / onClose / onApplyWbs / teamMembers） */}
      {renderAiAssistant && renderAiAssistant({
        isOpen: showAiAssistant,
        onClose: () => setShowAiAssistant(false),
        onApplyWbs: handleApplyAiWbs,
        teamMembers,
      })}

      <ProjectPeriodModal
        isOpen={showPeriodModal}
        onClose={() => { setShowPeriodModal(false); setPendingNavigation(null) }}
        scheduleMode={scheduleMode}
        startDate={startDate}
        endDate={endDate}
        skipHolidays={skipHolidays}
        dayAligned={dayAligned}
        planLeaves={planLeaves}
        completedSchedTasks={completedSchedTasks}
        dailyInputHours={dailyInputHours}
        onApply={handleApplyScheduleConfig}
      />
      {draftPrompt && (
        <div className="time-rule-confirm-overlay" onClick={() => resolveDraftPrompt(false)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">检测到草稿箱中有任务计划（{draftPrompt.versionName}）<br />是否加载草稿箱中的任务计划?</p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => resolveDraftPrompt(false)}>取消</button>
              <button className="btn-save" onClick={() => resolveDraftPrompt(true)}>加载草稿</button>
            </div>
          </div>
        </div>
      )}

      {showSaveModal && (
        <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
          <div className="modal-content save-modal" onClick={e => e.stopPropagation()}>
            <div className="save-modal-header">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <h3>进度计划{publishedVersionLabel}已发布</h3>
              <p>数据暂存至浏览器缓存中，请及时下载，避免数据丢失</p>
            </div>
            <div className="save-modal-body">
              <div className="save-modal-section">
                <div className="save-modal-section-title">下载最新发布版本</div>
                <div className="save-modal-btns-row">
                  <button className="save-modal-btn excel save-modal-btn-tooltip" onClick={async () => {
                    const data = await getExportData()
                    if (data.length > 0) { generateExcel(data, await buildPlanFileName(data, 'csv')) }
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    Excel
                    <span className="save-modal-tooltip">任务结构化数据，可用于数据分析和二次加工</span>
                  </button>
                  <button className="save-modal-btn word save-modal-btn-tooltip" onClick={async () => {
                    const data = await getExportData()
                    if (data.length > 0) { generateWord(data) }
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                    Word
                    <span className="save-modal-tooltip">完整的项目进度计划文档，可直接打印或分发</span>
                  </button>
                  <button className="save-modal-btn html save-modal-btn-tooltip" onClick={async () => {
                    if (!currentProjectId) return
                    try {
                      // 最新发布版本的进度计划数据
                      const published = await getLatestPublishedVersion()
                      let tree = null
                      let skipHolidaysLocal = !!skipHolidays
                      if (published) {
                        tree = await getProjectWbsTreeByVersion(published.version_ulid)
                        try {
                          const rules = JSON.parse(published.schedule_rules || '{}')
                          if (rules.skip_holidays != null) skipHolidaysLocal = !!rules.skip_holidays
                        } catch {}
                      }
                      if (!tree || tree.length === 0) {
                        tree = await getLatestPlanTree(currentProjectId)
                      }
                      await exportPlanHtml({
                        tree,
                        skipHolidays: skipHolidaysLocal,
                        dailyHours: dailyInputHours,
                        versionLabel: published?.version_name || '正式版'
                      })
                    } catch (e) { console.error('生成HTML失败:', e) }
                  }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                    HTML
                    <span className="save-modal-tooltip">带交互的进度计划，包含甘特图、网络图等多种视图</span>
                  </button>
                </div>
              </div>
              {/* 「或 + 同步到云端」区块已按要求隐藏 */}
            </div>
            <div className="save-modal-footer">
              <button className="save-modal-close" onClick={() => {
                setShowSaveModal(false)
                if (currentProjectId) navigate(`/project/${currentProjectId}`)
              }}>去项目主页</button>
            </div>
          </div>
        </div>
      )}
      {showNoChangeModal && (
        <div className="modal-overlay" onClick={() => setShowNoChangeModal(false)}>
          <div className="modal-content publish-success-modal" onClick={e => e.stopPropagation()}>
            <div className="publish-success-header">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
              <h3>{noChangeType === 'publish' ? '无需发布' : '无需保存'}</h3>
              <p>{noChangeType === 'publish' ? '进度计划没有任何修改，无需发布。' : '您没有修改进度计划，无需保存。'}</p>
            </div>
            <div className="publish-success-footer">
              <button
                className="publish-success-btn"
                onClick={() => {
                  setShowNoChangeModal(false)
                  if (currentProjectId) navigate(`/project/${currentProjectId}`)
                }}
              >跳转项目主页</button>
            </div>
          </div>
        </div>
      )}
      {toastMsg && (
        <div style={{
          position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
          background: '#1F2937', color: '#fff', padding: '10px 24px', borderRadius: '8px',
          fontSize: '14px', zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          animation: 'fadeIn 0.2s ease'
        }}>
          {toastMsg}
        </div>
      )}
    </div>
  )
}

export default App