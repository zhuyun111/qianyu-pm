import { themeColors, buildLeaves, computeReadOnlySchedule, computeCriticalPath, calcGroupDurationDays } from './schedule'
import { isNonWorkDay, HOLIDAY_DATES, MAKEUP_WORKDAY_DATES } from './holidays'
import { EXEC_STATUS, resolveExecStatus, resolveProgress } from './execStatus'
import { renderMarkdownHtml } from './markdown'
import appCss from '../index.css?raw'

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// 将 Date 转为 isNonWorkDay 期望的 'YYYY-MM-DD' 字符串（与项目主页 isHoliday 行为一致）
const fmtYMD = (d) => {
  const dt = d instanceof Date ? d : new Date(d)
  const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, '0'), day = String(dt.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}
const getWeekMonday = (d) => {
  const date = new Date(d)
  const day = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - day)
  date.setHours(0, 0, 0, 0)
  return date
}
const getWeekNo = (d) => {
  const date = new Date(d)
  const onejan = new Date(date.getFullYear(), 0, 1)
  const dayOfYear = Math.floor((date - onejan) / 86400000) + 1
  return Math.ceil(dayOfYear / 7)
}
const calcNodeTotalHours = (n) => n.resources?.reduce((s, r) => s + (r.hours || 0), 0) || 0
const calcTotalHoursRecursive = (n) => {
  if (n.children && n.children.length > 0) return n.children.reduce((s, c) => s + calcTotalHoursRecursive(c), 0)
  return n.resources?.reduce((s, r) => s + (r.hours || 0), 0) || 0
}
const calcMaxHours = (n) => {
  if (n.children && n.children.length > 0) return Math.max(...n.children.map(calcMaxHours))
  return n.resources?.reduce((m, r) => Math.max(m, r.hours || 0), 0) || 0
}
// 工时展示，与项目主页完全同口径（formatHoursByUnit(h, '小时')）：
// 统一为「44.5h」这类小数小时写法，最多保留 2 位小数并去掉多余的 0，
// 不做「44h 30min」式的时/分换算（否则与项目主页显示不一致）
const fmtH = (h) => {
  const v = Number(h)
  if (!v || v <= 0) return '0h'
  return parseFloat(v.toFixed(2)) + 'h'
}
const getTaskType = (n) => {
  const t = calcNodeTotalHours(n), h = n.customDurationDays !== undefined && n.customDurationDays > 0
  if (n.taskType === '里程碑') return '里程碑'
  if (t !== 0 && !h) return '执行'
  if (t !== 0 && h) return '跟进'
  return '等待'
}
const TTC = (t) => t === '里程碑' ? 'task-type-milestone' : t === '执行' ? 'task-type-executing' : t === '跟进' ? 'task-type-following' : 'task-type-waiting'

// 执行状态小图标（字符串版，与 src/components/ExecStatusDot.jsx 同构）：
// 圆底描边风格统一——已完成绿对勾 / 已延误红感叹号 / 进行中蓝播放三角；未开始返回空串（调用方回退圆点占位符）
function statusDotSvg(status, size, extraStyle) {
  const SZ = size || 13
  const conf = {
    completed: { bg: '#DCFCE7', stroke: '#16A34A', label: '已完成', body: '<path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="#16A34A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' },
    delayed: { bg: '#FEE2E2', stroke: '#DC2626', label: '已延误', body: '<line x1="12" y1="7" x2="12" y2="13" stroke="#DC2626" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="1.3" fill="#DC2626"/>' },
    in_progress: { bg: '#DBEAFE', stroke: '#2563EB', label: '进行中', body: '<polygon points="10,8.5 16.5,12 10,15.5" fill="#2563EB"/>' }
  }[status]
  if (!conf) return ''
  const st = extraStyle ? ' style="' + extraStyle + '"' : ''
  return '<svg class="collapse-placeholder status-dot" width="' + SZ + '" height="' + SZ + '" viewBox="0 0 24 24" title="' + conf.label + '"' + st + '><circle cx="12" cy="12" r="10" fill="' + conf.bg + '" stroke="' + conf.stroke + '" stroke-width="1.5"/>' + conf.body + '</svg>'
}

// 任务资源 / 成员 统一标识：优先用 member_ulid，缺失时退化为 "role|name"。
// 行内 data-members 与下拉选项 data-member-value 必须共用此函数，否则筛选无法匹配。
const memberKey = (r) => (r && (r.member_ulid || `${r.role || ''}|${r.name || ''}`)) || ''
// 一行任务的成员标识可能有多个：人员分配(member_ulid) + 角色分配(role|name)。
// 二者都写入 data-members，使「选人」与「选角色」都能命中（本项目任务多按角色分配）。
function memberTokens(r) {
  if (!r) return []
  const arr = []
  if (r.member_ulid) arr.push(r.member_ulid)
  const rk = (r.role || '') + '|' + (r.name || '')
  if (rk !== '|') arr.push(rk)
  return arr
}
function rowMemberAttr(resources) {
  const seen = {}
  const out = []
  ;(resources || []).forEach(r => memberTokens(r).forEach(t => { if (t && !seen[t]) { seen[t] = 1; out.push(t) } }))
  return out.join(',')
}
// 下拉选项 = 项目成员 ∪ 任务资源里出现过的所有成员标识，保证每个任务的 data-members 都能被选中。
// 同一人可能同时以两种键出现（成员记录按 member_ulid、任务资源按 role|name），
// 显示上按身份（role+name）去重：带 uid 的成员选项在 rowHasMember 中本就能同时命中
// 行内的 uid token 与 role|name token，因此同身份的资源选项无需重复展示。
function collectMemberOptions(members, tree) {
  const map = new Map()
  const seenIdentity = new Map() // 身份键(role|name) -> 已加入的选项键
  const add = (m) => {
    if (!m) return
    const key = memberKey(m)
    if (!key) return
    const identity = (m.role || '') + '|' + (m.name || '')
    if (map.has(key)) return
    if (seenIdentity.has(identity)) return
    seenIdentity.set(identity, key)
    map.set(key, {
      member_ulid: m.member_ulid || null,
      role: m.role || '',
      name: m.name || '',
      avatar: m.avatar || (m.name ? String(m.name).charAt(0).toUpperCase() : '?')
    })
  }
  ;(members || []).forEach(add)
  const walk = (nodes) => { for (const n of nodes || []) { for (const r of (n.resources || [])) add(r); if (n.children) walk(n.children) } }
  walk(tree)
  return [...map.values()]
}

const flattenScheduleRows = (nodes, scheduleMap, level = 1, out = []) => {
  (nodes || []).forEach(node => {
    const children = node.children || []
    const isLeaf = children.length === 0
    if (isLeaf) {
      const task = scheduleMap.get(node.id) || null
      let startBar = null, endBar = null
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
    let startBar = null, endBar = null
    childRows.forEach(cr => {
      if (cr.startBar != null) startBar = startBar == null ? cr.startBar : Math.min(startBar, cr.startBar)
      if (cr.endBar != null) endBar = endBar == null ? cr.endBar : Math.max(endBar, cr.endBar)
    })
    out.push({ node, level, isLeaf: false, hasChildren: true, task: null, startBar, endBar })
    out.push(...childRows)
  })
  return out
}

const buildIdToCodeMap = (tree) => {
  const m = {}
  const w = (n) => { for (const x of n || []) { m[x.id || x.task_ulid] = x.code; if (x.children) w(x.children) } }
  w(tree); return m
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

const buildFlatTasks = (tree) => {
  const r = []
  const walk = (nodes, level) => {
    for (const n of nodes || []) {
      const agg = (n.children && n.children.length > 0) ? computeAggRange(n) : null
      r.push({ ...n, level, taskType: getTaskType(n), totalHours: calcNodeTotalHours(n),
        ...(agg ? { start_date: agg.sd, end_date: agg.ed, start_hour: agg.sh, end_hour: agg.eh } : {}) })
      if (n.children) walk(n.children, level + 1)
    }
  }
  walk(tree, 0); return r
}

const buildMemberStats = (tree) => {
  const stats = {}
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n.children || n.children.length === 0) {
        for (const r of (n.resources || [])) {
          const uid = r.member_ulid || '', key = uid ? 'uid:' + uid : 'role:' + (r.role || '') + '|name:' + (r.name || '')
          if (!stats[key]) stats[key] = { taskCount: 0, totalHours: 0 }
          stats[key].taskCount++; stats[key].totalHours += r.hours || 0
        }
      }
      if (n.children) walk(n.children)
    }
  }
  walk(tree); return stats
}

function buildKanbanGroups(flatTasks, tree) {
  const leaves = flatTasks.filter(i => !i.children || i.children.length === 0)
  const g = {}, o = []
  for (const item of leaves) {
    const anc = tree.find(root => { const f = (ns) => { for (const n of ns || []) { if (n.id === item.id || n.task_ulid === item.id) return true; if (n.children && f(n.children)) return true } return false }; return f([root]) })
    const gn = anc ? (anc.code ? anc.code + ' ' + anc.name : anc.name) : '未分组'
    if (!g[gn]) { g[gn] = []; o.push(gn) }
    g[gn].push(item)
  }
  return { groups: g, groupOrder: o }
}

const GANTT_CELL = 44
const ROW_HEIGHT = 36

function computeGanttMaxDepth(tree) {
  let max = 0
  const walk = (nodes, depth) => {
    for (const n of nodes || []) {
      if (depth > max) max = depth
      if (n.children) walk(n.children, depth + 1)
    }
  }
  walk(tree, 1)
  return max
}

function buildLevelOptionsHtml(ganttMaxDepth) {
  const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
  let html = '<div class="gantt-filter-option selected" data-value="all"><span>全部任务</span>' + CHECK_SVG + '</div>'
  for (let d = 1; d <= Math.max(1, ganttMaxDepth); d++) {
    html += '<div class="gantt-filter-option" data-value="' + d + '"><span>' + d + '级任务</span></div>'
  }
  html += '<div class="gantt-filter-option" data-value="leaf"><span>执行层级</span></div>'
  return html
}

// 任务状态筛选下拉选项 HTML（四个视图筛选区共用）
function buildStatusFilterHtml() {
  const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
  const opts = [['all', '全部状态'], ['not_started', '未开始'], ['delayed', '已延误'], ['in_progress', '进行中'], ['completed', '已完成']]
  const inner = opts.map(o => '<div class="gantt-filter-option' + (o[0] === 'all' ? ' selected' : '') + '" data-status-value="' + o[0] + '"><span>' + o[1] + '</span>' + (o[0] === 'all' ? CHECK_SVG : '') + '</div>').join('')
  return '<div class="gantt-filter-item"><span class="gantt-filter-label">任务状态</span><div class="gantt-filter-trigger" data-filter="status"><span class="gantt-filter-value">全部状态</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div><div class="gantt-filter-dropdown filter-dd" style="display:none">' + inner + '</div></div>'
}

function buildMemberDropdownHtml(members, idSuffix) {
  let html = '<input type="text" class="custom-select-search" placeholder="搜索角色/成员..." id="member-search-' + idSuffix + '">'
  html += '<div class="custom-select-option member-multi-all is-selected" data-member-search="#member-search-' + idSuffix + '"><span class="custom-select-option-text">全部成员</span></div>'
  ;(members || []).forEach(m => {
    const label = m.name ? (m.role || '') + ' - ' + (m.name || '待分配') : (m.role || '未分组') + ' - 待分配'
    const avatar = m.name ? (m.avatar || m.name.charAt(0).toUpperCase()) : '?'
    const value = esc(memberKey(m))
    html += '<div class="custom-select-option" data-member-value="' + value + '" data-member-uid="' + esc(m.member_ulid || '') + '" data-member-role="' + esc(m.role || '') + '" data-member-name="' + esc(m.name || '') + '" data-member-search="#member-search-' + idSuffix + '"><span class="custom-select-avatar' + (!m.name ? ' empty' : '') + '">' + esc(avatar) + '</span><span class="custom-select-option-text">' + esc(label) + '</span></div>'
  })
  if (!members || !members.length) html += '<div class="custom-select-no-results">未找到匹配项</div>'
  return html
}

// 共享筛选栏：视图切换 tab 在最前（分段式一组），后接 任务层级/任务状态/时间范围/团队成员 四个筛选（一次设置四视图通用）
function buildSharedFilterBar(members, ganttMaxDepth) {
  const levelOptionsHtml = buildLevelOptionsHtml(ganttMaxDepth)
  const memberDropdownHtml = buildMemberDropdownHtml(members, 'shared')
  const tabs = [['gantt', '甘特图'], ['table', '表格'], ['kanban', '看板'], ['calendar', '日历']]
  const tabsHtml = tabs.map((t, i) => '<button class="project-tab' + (i === 0 ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>').join('')
  return '<div class="gantt-toolbar filter-bar" style="padding:10px 0 10px 10px;background:#fff">' +
    '<div class="project-tabs-left">' + tabsHtml + '</div>' +
    '<div class="gantt-quick-btns">' +
    '<div class="gantt-filter-item" id="level-filter-item"><span class="gantt-filter-label">任务层级</span><div class="gantt-filter-trigger" data-filter="level"><span class="gantt-filter-value">全部任务</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div><div class="gantt-filter-dropdown filter-dd" style="display:none">' + levelOptionsHtml + '</div></div>' +
    buildStatusFilterHtml() +
    '<div class="gantt-filter-item" ref-dr="true"><span class="gantt-filter-label">时间范围</span><div class="gantt-filter-trigger" data-filter="time"><span class="gantt-filter-value">全部时间</span><span class="gantt-filter-icon"><span class="gantt-filter-clear">×</span><svg class="gantt-filter-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></span></div><div class="gantt-filter-dropdown date-range-calendar-dropdown" style="display:none" id="dr-calendar-shared"></div></div>' +
    '<div class="gantt-filter-item member-filter-item"><span class="gantt-filter-label">团队成员</span><div class="member-multi-select-trigger" data-filter="member"><div class="member-multi-select-tags"><span class="member-multi-select-placeholder">全部成员</span></div><span class="member-multi-select-arrow">▼</span></div><div class="member-multi-dropdown" style="display:none;position:absolute;top:100%;left:0;min-width:220px;margin-top:4px">' + memberDropdownHtml + '</div></div>' +
    '<div class="gantt-filter-item" id="group-filter-item" style="display:none"><span class="gantt-filter-label">分组</span><div class="gantt-filter-trigger" data-filter="group"><span class="gantt-filter-value">一级任务</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg></div><div class="gantt-filter-dropdown filter-dd" style="display:none"><div class="gantt-filter-option selected" data-group-value="parent"><span>一级任务</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div><div class="gantt-filter-option" data-group-value="status"><span>任务状态</span></div></div></div>' +
    '</div>' +
    '</div>'
}

// 任务执行状态徽标 HTML（与主页 ExecStatusBadge 样式一致）
function execStatusBadgeHtml(status) {
  const meta = EXEC_STATUS[status]
  if (!meta) return ''
  return '<span class="exec-status-badge" style="display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;line-height:18px;background:' + meta.bg + ';color:' + meta.color + ';white-space:nowrap" title="任务状态：' + meta.label + '">' + meta.label + '</span>'
}

// 已完成任务的对勾徽标（白色圆底 + 主题色对勾，置于条形左端）
function checkBadgeHtml(color) {
  return '<span style="position:absolute;left:4px;top:50%;transform:translateY(-50%);width:14px;height:14px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;z-index:2;box-shadow:0 1px 2px rgba(0,0,0,0.18);pointer-events:none" title="已完成"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>'
}

function renderGanttTab(displayRows, dateRange, dailyInputHours, criticalEdgeKeys, skipHolidays, members, ganttMaxDepth, statusOf, progressOf) {
  if (!displayRows || !displayRows.length) return '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无任务</div></div>'
  if (!dateRange || !dateRange.length) return '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无排期数据</div></div>'

  const totalDays = dateRange.length
  const hoursPerDay = Math.max(1, Math.round(dailyInputHours || 8))
  const GANTT_CELL = 44
  const ganttPxPerDayOf = (g) => {
    if (g === 'hour') return hoursPerDay * GANTT_CELL
    if (g === 'week') return 88 / 7
    if (g === 'month') return 176 / 30
    return GANTT_CELL
  }
  const GRANS = ['hour', 'day', 'week', 'month']

  // 与项目主页 ganttGranuleIndex 对齐：把每一天映射到「列分组」下标。
  // 天/小时粒度：每天一列（di）；周粒度：同一周某列；月粒度：同月某列。
  // 渲染时写入 data-col，悬停高亮整列用。
  const buildGranuleIndex = (gran) => {
    if (gran === 'week') {
      const arr = []
      let counter = -1, lastMonday = null
      dateRange.forEach(d => {
        const m = getWeekMonday(new Date(d)).getTime()
        if (m !== lastMonday) { counter++; lastMonday = m }
        arr.push(counter)
      })
      return arr
    }
    if (gran === 'month') {
      const arr = []
      let counter = -1, lastKey = null
      dateRange.forEach(d => {
        const dt = new Date(d)
        const key = dt.getFullYear() + '-' + dt.getMonth()
        if (key !== lastKey) { counter++; lastKey = key }
        arr.push(counter)
      })
      return arr
    }
    return dateRange.map((_, i) => i)
  }

  const firstDate = new Date(dateRange[0])
  const dateLabel = firstDate.getFullYear() + '年' + (firstDate.getMonth() + 1) + '月'

  const headerLeft = '<div class="gantt-header-left" style="width:216px;min-width:216px"><div class="gantt-granularity-dropdown"><button class="gantt-granularity-trigger">天<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button><div class="gantt-granularity-menu" style="display:none"><div class="gantt-granularity-option" data-value="hour">小时</div><div class="gantt-granularity-option active" data-value="day">天</div><div class="gantt-granularity-option" data-value="week">周</div><div class="gantt-granularity-option" data-value="month">月</div></div></div><div class="gantt-date-label">' + dateLabel + '</div></div>'

  const frozenRows = displayRows.map((row, idx) => {
    const isP = row.hasChildren
    const ind = (row.level - 1) * 24
    const node = row.node
    const memberKeys = rowMemberAttr(node.resources)
    // 任务名称可点击打开详情弹窗：叶子带排期用 task.id，父任务用 node.id（详情弹窗为所有任务生成）；
    // 已完成任务名变灰（与排期页 ProjectSchedule 一致）
    const st = statusOf(node) || ''
    const isCompleted = st === 'completed'
    const clickTaskId = isP ? node.id : (row.task ? row.task.id : null)
    const nameClick = clickTaskId != null
      ? ' data-task-id="' + esc(String(clickTaskId)) + '" style="cursor:pointer' + (isCompleted ? ';color:#94a3b8' : '') + '"'
      : (isCompleted ? ' style="color:#94a3b8"' : '')
    const collapseCell = isP
      ? '<button type="button" class="collapse-btn">▼</button>'
      : (['completed', 'delayed', 'in_progress'].includes(st)
          ? statusDotSvg(st)
          : '<span class="collapse-placeholder">•</span>')
    return '<div class="gantt-task-info' + (isP ? ' gantt-group-info' : '') + '" style="padding-left:' + ind + 'px" data-idx="' + idx + '" data-level="' + row.level + '" data-status="' + st + '" data-start="' + (node.start_date || '') + '" data-end="' + (node.end_date || '') + '" data-members="' + esc(memberKeys) + '">' +
      collapseCell +
      '<span class="task-code">' + esc(row.node.code) + '</span>' +
      '<div class="task-name-row"><span class="task-name' + (isP ? ' gantt-group-name' : '') + '"' + nameClick + '>' + esc(row.node.name) + '</span></div></div>'
  }).join('')

  const rowIndexById = new Map()
  displayRows.forEach((r, i) => {
    if (r.task) rowIndexById.set(r.task.id, i)
    else if (r.node) rowIndexById.set(r.node.id, i)
  })

  // 「今天」在甘特日期范围内的天序号（用于今天时间线与表头高亮），不在范围内为 -1
  const todayIdx = (() => {
    if (!dateRange.length) return -1
    const now = new Date()
    for (let i = 0; i < dateRange.length; i++) {
      const d = new Date(dateRange[i])
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return i
    }
    return -1
  })()

  function renderHeaderRightInner(gran) {
    const px = ganttPxPerDayOf(gran)
    const gIndex = buildGranuleIndex(gran)
    let monthsHtml = '', datesHtml = ''
    if (gran === 'week') {
      let i = 0
      while (i < totalDays) {
        const monday = getWeekMonday(new Date(dateRange[i])).getTime()
        let days = 1
        while (i + days < totalDays && getWeekMonday(new Date(dateRange[i + days])).getTime() === monday) days++
        const w = 7 * px
        const txt = '第' + getWeekNo(new Date(dateRange[i])) + '周'
        monthsHtml += '<div class="gantt-month-overlay-item" style="width:' + w + 'px;min-width:' + w + 'px"><span class="gantt-month-tooltip">' + txt + '</span></div>'
        datesHtml += '<div class="gantt-week" data-col="' + gIndex[i] + '" style="width:' + w + 'px;min-width:' + w + 'px">' + txt + '</div>'
        i += days
      }
    } else if (gran === 'month') {
      let i = 0
      while (i < totalDays) {
        const d = new Date(dateRange[i])
        const m = d.getMonth(), y = d.getFullYear()
        let days = 0
        while (i + days < totalDays) {
          const dd = new Date(dateRange[i + days])
          if (dd.getMonth() !== m || dd.getFullYear() !== y) break
          days++
        }
        const w = days * px
        monthsHtml += '<div class="gantt-month-overlay-item" style="width:' + w + 'px;min-width:' + w + 'px"><span class="gantt-month-tooltip">' + (y + '年' + (m + 1) + '月') + '</span></div>'
        datesHtml += '<div class="gantt-month" data-col="' + gIndex[i] + '" style="width:' + w + 'px;min-width:' + w + 'px">' + ((m + 1) + '月') + '</div>'
        i += days
      }
    } else {
      // 月份覆盖层：与主页 ganttCoarseCells 一致，天/小时粒度为「逐日项」，
      // 月标签挂在每月 1 号的格子上（否则条悬停时会出现整月横带高亮）
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(dateRange[i])
        const label = d.getDate() === 1 ? (d.getFullYear() + '年' + (d.getMonth() + 1) + '月') : (gran === 'hour' ? (d.getMonth() + 1) + '/' + d.getDate() : '')
        monthsHtml += '<div class="gantt-month-overlay-item" style="width:' + px + 'px;min-width:' + px + 'px">' + (label ? '<span class="gantt-month-tooltip">' + label + '</span>' : '') + '</div>'
      }
      for (let i = 0; i < totalDays; i++) {
        const d = new Date(dateRange[i])
        const isToday = todayIdx >= 0 && i === todayIdx
        const isHoliday = skipHolidays && isNonWorkDay(fmtYMD(d))
        const cls = 'gantt-day' + (isToday ? ' today' : '') + (isHoliday ? ' holiday' : '') + (gran === 'hour' ? ' gantt-hour-day' : '')
        let inner = '<div class="gantt-day-num">' + d.getDate() + '</div>'
        if (gran === 'hour') {
          let hc = ''
          for (let h = 0; h < hoursPerDay; h++) hc += '<div class="gantt-hour-cell" style="width:' + GANTT_CELL + 'px;min-width:' + GANTT_CELL + 'px">' + (h + 1) + '</div>'
          inner = '<div class="gantt-hour-cells">' + hc + '</div>'
        }
        datesHtml += '<div class="' + cls + '" data-col="' + gIndex[i] + '" style="width:' + px + 'px;min-width:' + px + 'px">' + inner + '</div>'
      }
    }
    return '<div class="gantt-months-overlay">' + monthsHtml + '</div><div class="gantt-header-dates">' + datesHtml + '</div>'
  }

  function renderBody(gran) {
    const px = ganttPxPerDayOf(gran)
    const gIndex = buildGranuleIndex(gran)
    const posToPx = (pos) => pos * px
    // 「今天」时间线：橙色虚线贯穿所有行，位于今日对应格子的右侧边界（今天不在甘特范围内则不渲染）
    const todayLine = todayIdx >= 0 ? '<div class="gantt-today-line" style="left:' + posToPx(todayIdx + 1) + 'px" title="今天"></div>' : ''
    const barRows = displayRows.map((row, idx) => {
      const { task } = row
      const isP = row.hasChildren
      const startBar = row.startBar, endBar = row.endBar
      const hasBar = startBar != null && endBar != null && (task && task.taskType === '里程碑' ? endBar >= startBar : endBar > startBar)
      const barLeft = hasBar ? posToPx(startBar) : 0
      const barWidth = hasBar ? Math.max(0, posToPx(endBar) - posToPx(startBar)) : 0
      const cells = dateRange.map((date, di) => {
        const isDateHoliday = skipHolidays && isNonWorkDay(fmtYMD(date))
        return '<div class="gantt-cell' + (isDateHoliday ? ' holiday' : '') + '" data-col="' + gIndex[di] + '" style="width:' + px + 'px;min-width:' + px + 'px" title="' + (isDateHoliday ? '节假日' : '') + '"></div>'
      }).join('')
      let barHtml = ''
      if (hasBar && isP) {
        const ci = task ? task.colorIndex : 0, c = themeColors[ci]
        const sumHours = (n) => {
          if (!n.children || n.children.length === 0) {
            const t = n.id ? displayRows.find(r => r.node.id === n.id)?.task : null
            return t ? (t.totalHours || 0) : 0
          }
          return (n.children || []).reduce((s, ch) => s + sumHours(ch), 0)
        }
        const totalH = sumHours(row.node)
        const durDays = Math.ceil(endBar - startBar)
        const pProgress = Math.min(100, progressOf(row.node))
        const pCompleted = EXEC_STATUS[statusOf(row.node)] === EXEC_STATUS.completed
        barHtml = '<div class="gantt-summary-bar" data-task-id="' + esc(String(row.node.id)) + '" style="left:' + barLeft + 'px;width:' + Math.max(12, barWidth) + 'px;--sb-color-s:' + c.solid + '80;--sb-color-m:' + c.solid + '28;--sb-color-l:' + c.solid + '14">' +
          (pProgress > 0 ? '<div style="position:absolute;left:0;top:0;bottom:0;width:' + pProgress + '%;background:' + c.solid + '80;border-radius:inherit;pointer-events:none" title="完成进度：' + pProgress + '%"></div>' : '') +
          (pCompleted ? checkBadgeHtml(c.solid) : '') +
          '<span class="gantt-summary-label" style="color:' + c.solid + '">' + (totalH > 0 ? totalH + 'h' : '') + (totalH > 0 && durDays > 0 ? '<span style="margin:0 3px">/</span>' : '') + (durDays > 0 ? durDays + '天' : '') + '</span></div>' +
          '<svg style="position:absolute;left:' + barLeft + 'px;top:50%;margin-top:-8px;pointer-events:none;overflow:visible" width="' + Math.max(12, barWidth) + '" height="16"><polygon points="0,16 8,0 0,0" fill="' + c.solid + '60"/><polygon points="' + Math.max(12, barWidth) + ',16 ' + (Math.max(12, barWidth) - 8) + ',0 ' + Math.max(12, barWidth) + ',0" fill="' + c.solid + '60"/></svg>'
      } else if (hasBar && !isP && task) {
        const colors = themeColors[task.colorIndex || 0]
        const isMilestone = task.taskType === '里程碑'
        if (isMilestone) {
          const msMeta = EXEC_STATUS[statusOf(task)]
          // 已延误里程碑用红色警示，其余保持琥珀色
          const msBg = msMeta === EXEC_STATUS.delayed ? '#DC2626' : '#F59E0B'
          barHtml = '<div class="gantt-milestone-diamond" data-task-id="' + esc(String(task.id)) + '" style="position:absolute;left:' + (barLeft - 7) + 'px;top:50%;transform:translateY(-50%) rotate(45deg);width:14px;height:14px;background:' + msBg + ';cursor:pointer;z-index:5" title="' + esc(task.name) + ': 里程碑' + (msMeta ? ' · 任务状态：' + msMeta.label : '') + '"></div>'
        } else {
          const isFollowing = task.taskType === '跟进'
          // 配色与主页统一：底色=主题 light 色、无边框；完成段=主题 solid 色 70% 透明度；已延误用红底红边警示
          const leafProgress = Math.min(100, progressOf(task))
          const stMeta = EXEC_STATUS[statusOf(task)]
          const leafCompleted = stMeta === EXEC_STATUS.completed
          const leafDelayed = stMeta === EXEC_STATUS.delayed
          const leafBg = leafCompleted ? colors.solid : leafDelayed ? '#FEE2E2' : colors.light
          const leafBorder = leafDelayed ? '1px solid #DC2626' : 'none'
          const hoursLabel = task.totalHours > 0 ? '<span class="gantt-bar-hours" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:10px;font-weight:600;color:' + colors.solid + ';text-shadow:0 0 3px rgba(255,255,255,0.95),0 0 2px rgba(255,255,255,0.95);white-space:nowrap;z-index:1">' + task.totalHours + 'h</span>' : ''
          // 合并连续节假日（如周六+周日）为一段，避免取整细缝
          let holidaySegs = ''
          if (skipHolidays && startBar != null && endBar != null) {
            const sIdx = Math.floor(startBar), eIdx = Math.floor(endBar)
            const holRuns = []
            for (let hi = sIdx; hi < eIdx; hi++) {
              if (hi >= 0 && hi < dateRange.length && isNonWorkDay(fmtYMD(dateRange[hi]))) {
                const lastRun = holRuns[holRuns.length - 1]
                if (lastRun && lastRun.end === hi - 1) lastRun.end = hi
                else holRuns.push({ start: hi, end: hi })
              }
            }
            holRuns.forEach(r => {
              holidaySegs += '<div class="gantt-bar-holiday-seg" style="left:' + (posToPx(r.start) - posToPx(startBar)) + 'px;width:' + (posToPx(r.end + 1) - posToPx(r.start)) + 'px"></div>'
            })
          }
          barHtml = '<div class="gantt-task-bar' + (isFollowing ? ' wave-bar' : '') + '" data-task-id="' + esc(String(task.id)) + '" style="left:' + barLeft + 'px;width:' + Math.max(4, barWidth) + 'px;background:' + leafBg + ';border:' + leafBorder + '">' +
            (leafProgress > 0 ? '<div style="position:absolute;left:0;top:0;bottom:0;width:' + leafProgress + '%;background:' + colors.solid + 'B3;border-radius:inherit;pointer-events:none;z-index:0" title="完成进度：' + leafProgress + '%"></div>' : '') +
            holidaySegs +
            (leafCompleted ? checkBadgeHtml(colors.solid) : '') +
            hoursLabel + '</div>'
        }
      }
      return '<div class="gantt-row" data-idx="' + idx + '"><div class="gantt-bars">' + cells + barHtml + todayLine + '</div></div>'
    }).join('')

    const lines = []
    displayRows.forEach((row, rowIdx) => {
      const t = row.task, tNode = row.node
      const predecessors = (tNode && tNode.predecessors) || []
      if (predecessors.length === 0) return
      predecessors.forEach(predId => {
        const predIdx = rowIndexById.get(predId)
        if (predIdx == null) return
        const predRow = displayRows[predIdx]
        const predTask = predRow.task
        if (!predTask && predRow.endBar == null) return
        let predEndX
        if (predTask) {
          const isPredMilestone = predTask.taskType === '里程碑'
          predEndX = isPredMilestone ? posToPx(predTask.startPos) : posToPx(predTask.endPos)
        } else if (predRow.endBar != null) {
          predEndX = posToPx(predRow.endBar)
        } else return
        let succStartX
        if (t) {
          const isSuccMilestone = t.taskType === '里程碑'
          succStartX = isSuccMilestone ? posToPx(t.startPos) - 7 : posToPx(t.startPos) + 4
        } else if (row.startBar != null) {
          succStartX = posToPx(row.startBar) + 4
        } else return
        const succId = (t && t.id) || (tNode && tNode.id) || ''
        // isCritical：该前置连线是否属于关键路径（与项目主页 gantt 同口径，key = `${predId}->${succId}`）
        lines.push({ predEndX, succStartX, predRowIdx: predIdx, succRowIdx: rowIdx, isBackward: predIdx > rowIdx, predId, succId, isMilestonePred: !!(predTask && predTask.taskType === '里程碑'), isCritical: criticalEdgeKeys.has(predId + '->' + succId) })
      })
    })
    return { barRows, linesJson: JSON.stringify(lines) }
  }

  const headerRights = GRANS.map(g => '<div class="gantt-header-right" data-gran="' + g + '"' + (g === 'day' ? '' : ' style="display:none"') + '>' + renderHeaderRightInner(g) + '</div>').join('')
  const headerRow = '<div class="gantt-header-row">' + headerLeft + headerRights + '</div>'

  const bodies = GRANS.map(g => {
    const { barRows, linesJson } = renderBody(g)
    const depSvg = '<svg id="gantt-dep-svg-' + g + '" class="gantt-dep-svg" style="position:absolute;top:0;left:0;width:100%;pointer-events:none;z-index:2" data-lines="' + esc(linesJson) + '" data-total-rows="' + displayRows.length + '"></svg>'
    return '<div class="gantt-body gantt-body-' + g + '" data-gran="' + g + '"' + (g === 'day' ? '' : ' style="display:none"') + '>' + barRows + depSvg + '</div>'
  }).join('')

  // 筛选条件在顶部共享筛选栏（视图切换 tab 一行），甘特视图不再内嵌工具栏
  return headerRow + '<div class="gantt-container"><div class="gantt-frozen-column" style="width:216px;min-width:216px">' + frozenRows + '<div class="gantt-frozen-resizer"></div></div><div class="gantt-scroll-wrapper"><div class="gantt-scroll-area">' + bodies + '</div></div></div>'
}

function renderTableTab(flatTasks, tree, dailyInputHours, members, ganttMaxDepth, statusOf) {
  if (!flatTasks.length) return '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无任务</div></div>'
  const idMap = buildIdToCodeMap(tree)
  // 资源头像：与项目主页一致用 .avatar 圆形样式，优先取资源自带 avatar 字段
  const avatarHtml = (r) => '<span class="avatar' + (!r.name ? ' empty-avatar' : '') + '">' + (r.name ? esc(r.avatar || String(r.name).charAt(0).toUpperCase()) : '?') + '</span>'
  const rows = flatTasks.map(item => {
    const type = getTaskType(item), tc = TTC(type), total = calcTotalHoursRecursive(item)
    let dd
    if (type === '里程碑') dd = '—'
    else if (!item.children || item.children.length === 0) dd = item.customDurationDays != null ? item.customDurationDays : (() => { const h = calcMaxHours(item); return h > 0 ? Math.ceil(h / dailyInputHours) : 0 })()
    else { const lv = []; const cl = (n) => { if (!n.children || n.children.length === 0) { const h = calcMaxHours(n); lv.push(h > 0 ? Math.ceil(h / dailyInputHours) : 0) } else n.children.forEach(cl) }; cl(item); dd = '共' + Math.max(0, ...lv) + '天' }
    const pred = (item.predecessors || []).map(p => '<span class="predecessor-tag">' + esc(idMap[p] || p) + '</span>').join('')
    const taskId = String(item.id || item.task_ulid || '')
    const rs = item.resources || []
    // 折叠展示前 2 个资源 + "+N" 徽章（与项目主页一致），点击可展开全部子行
    const res = rs.slice(0, 2).map(r =>
      '<div class="resource-item">' + avatarHtml(r) + '<div class="resource-info">'
      + '<span class="resource-name' + (!r.name ? ' empty-name' : '') + '">' + esc(r.name || r.role) + '</span>'
      + '<span class="resource-hours">' + fmtH(r.hours) + '</span></div></div>').join('')
    const more = rs.length > 2 ? '<div class="resource-item more-resources"><span class="more-badge">+' + (rs.length - 2) + '</span></div>' : ''
    const expandable = type !== '里程碑' && rs.length > 0
    const resHtml = type === '里程碑' ? '<span class="milestone-dash">—</span>' : ((res + more) || '-')
    // 展开子行：复用 WBS 分解页面 expanded-resource-row 样式（默认隐藏，脚本控制显隐）
    const expRows = expandable ? rs.map(r =>
      '<tr class="expanded-resource-row" data-parent="' + esc(taskId) + '" style="display:none">'
      + '<td></td><td></td>'
      + '<td style="white-space:nowrap"><div class="resource-item" style="display:inline-flex">' + avatarHtml(r)
      + '<div class="resource-info"><span class="resource-name' + (!r.name ? ' empty-name' : '') + '">' + esc(r.name || r.role) + '</span></div></div></td>'
      + '<td><span class="resource-hours">' + fmtH(r.hours) + '</span></td>'
      + '<td><div class="duration-days">' + ((r.hours || 0) > 0 ? Math.ceil(r.hours / dailyInputHours) : '—') + '</div></td>'
      + '<td></td><td></td><td></td></tr>').join('') : ''
    const sd = item.start_date, ed = item.end_date, sh = item.start_hour, eh = item.end_hour
    const ts = (!sd && !ed) ? '-' : (sd || '-') + (sh != null ? ' ' + sh + 'h' : '') + ' 至 ' + (ed || '-') + (eh != null ? ' ' + eh + 'h' : '')
    const memberKeys = rowMemberAttr(item.resources)
    const hasChildren = item.children && item.children.length > 0
    // 任务类型仅在叶子任务行显示（与项目主页一致）
    const typeCell = '<td class="cell-task-type">' + (!hasChildren ? '<span class="task-type-badge ' + tc + '">' + type + '</span>' : '') + '</td>'
    const statusCell = '<td>' + execStatusBadgeHtml(statusOf(item)) + '</td>'
    // 任务名前图标：非叶子结点显示折叠箭头（与项目主页表格视图同款，点击折叠/展开子孙行）；
    // 叶子结点按执行状态显示图标（已完成/已延误/进行中），未开始保持灰色圆点
    const tableDot = hasChildren
      ? '<span class="collapse-btn" title="折叠/展开">▼</span>'
      : (['completed', 'delayed', 'in_progress'].includes(statusOf(item))
        ? statusDotSvg(statusOf(item))
        : '<span class="collapse-placeholder">•</span>')
    return '<tr class="wbs-row" data-task-id="' + esc(taskId) + '" data-level="' + item.level + '" data-status="' + (statusOf(item) || '') + '" data-start="' + (sd || '') + '" data-end="' + (ed || '') + '" data-members="' + esc(memberKeys) + '" data-leaf="' + (!hasChildren) + '"><td style="padding-left:' + (item.level * 24 + 8) + 'px"><div class="wbs-cell-content">' + tableDot + '<span class="task-code">' + esc(item.code) + '</span><div class="task-container"><div class="task-content"><span class="task-name">' + esc(item.name) + '</span>' + (item.taskType === '里程碑' ? '<span class="milestone-btn milestone-active" title="里程碑"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></span>' : '') + '</div></div></div></td><td><div class="predecessors-cell">' + (pred || '-') + '</div></td><td><div class="resources-container' + (type === '里程碑' ? ' milestone-disabled' : '') + '" style="cursor:' + (expandable ? 'pointer' : 'default') + '">' + resHtml + '</div></td><td>' + (hasChildren ? '<span class="duration-days-text">共' + fmtH(total) + '</span>' : '<span class="duration-tag">' + fmtH(total) + '</span>') + '</td><td>' + (type === '里程碑' ? '<span class="milestone-dash">—</span>' : '<span class="duration-days">' + dd + '</span>') + '</td><td><span style="font-size:13px;color:#374151">' + ts + '</span></td>' + typeCell + statusCell + '</tr>' + expRows
  }).join('')
  // 筛选条件在顶部共享筛选栏，表格视图不再内嵌工具栏
  return '<div style="flex:1;overflow-y:auto"><table class="wbs-table"><thead><tr><th style="width:20%">任务名称</th><th style="width:8%">前置任务</th><th style="width:15%">资源需求</th><th style="width:8%">总预估工时</th><th style="width:8%">工期（天）</th><th style="width:13%">计划开展时间</th><th style="width:7%">任务类型</th><th style="width:8%">任务状态</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
}

// 任务详情只读预览弹窗（对齐主页 TaskDetailPreview），各视图共用；支持叶子/父任务
function buildTaskDetailPopupHtml(item, tree, dailyInputHours, execStatusMap, progressMap) {
  const execMap = execStatusMap || new Map()
  const progMap = progressMap || new Map()
  const itemId = item.id != null ? item.id : item.task_ulid
  let anc = []
  let parentNode = null
  const walk = (nodes, acc, parent) => {
    for (const n of nodes || []) {
      if (n.id === itemId || n.task_ulid === itemId) { anc = [...acc, n.name]; parentNode = parent; return true }
      if (n.children && walk(n.children, [...acc, n.name], n)) return true
    }
    return false
  }
  walk(tree, [], null)
  anc = anc.slice(0, -1)
  const parentId = parentNode ? String(parentNode.id != null ? parentNode.id : parentNode.task_ulid) : ''
  const hasChildren = item.children && item.children.length > 0
  // 任务执行状态/完成进度：按逻辑任务身份（original_task_id，退化到 task_ulid/id）查手动值；
  // 状态=系统推导+手动合并+非叶子聚合；进度=叶子手动值（缺省0）+非叶子聚合
  const lookupMap = (map, node) => {
    const orig = node && node.original_task_id
    const ulid = node && (node.task_ulid != null ? node.task_ulid : node.id)
    if (orig != null && map.has(String(orig))) return map.get(String(orig))
    if (ulid != null && map.has(String(ulid))) return map.get(String(ulid))
    return null
  }
  const getManual = (n) => lookupMap(execMap, n) || null
  const getProgress = (n) => {
    const v = lookupMap(progMap, n)
    return v === null || v === undefined ? null : v
  }
  const status = resolveExecStatus(item, getManual)
  const prog = resolveProgress(item, getProgress)
  // 进度条填充色跟随任务甘特条颜色（与甘特图同口径：按编号首级取 themeColors）
  const barColor = (() => {
    const firstLevel = parseInt(String(item.code || '').split('.')[0], 10) || 1
    return (themeColors[(firstLevel - 1) % themeColors.length] || themeColors[0]).solid
  })()
  const childStatusOf = (c) => resolveExecStatus(c, getManual)
  const statusBadge = (st) => {
    const s = EXEC_STATUS[st] || EXEC_STATUS.not_started
    return '<span class="task-status-badge" style="background:' + s.bg + ';color:' + s.color + '">' + s.label + '</span>'
  }
  const type = getTaskType(item)
  // 工期与主应用同口径：前驱依赖链排布（子叶子依次进行取链上累计最大值），而非简单取最大
  const days = calcGroupDurationDays(item, dailyInputHours)
  // 总预估工时：父任务递归累加叶子工时；叶子缺 totalHours 时用自身 resources 求和兜底
  const totalH = hasChildren ? calcTotalHoursRecursive(item) : (item.totalHours != null && item.totalHours > 0 ? item.totalHours : calcNodeTotalHours(item))
  const resRows = (item.resources || []).map(r => '<div class="resource-item"><span class="avatar' + (!r.name ? ' empty-avatar' : '') + '">' + (r.name ? esc(r.avatar || String(r.name).charAt(0).toUpperCase()) : '?') + '</span><div class="resource-info"><span class="resource-name' + (!r.name ? ' empty-name' : '') + '">' + esc(r.name || r.role) + '</span><span class="resource-hours">' + fmtH(r.hours || 0) + '</span></div></div>').join('')
  // 可交付成果：与主页弹窗同款 chip 样式（只读，无删除按钮）
  const deliv = item.deliverables && item.deliverables.length > 0
    ? '<div class="deliverables-container">' + item.deliverables.map(d => '<span class="deliverable-chip" title="' + esc(d) + '"><span class="deliverable-chip-name">' + esc(d) + '</span></span>').join('') + '</div>'
    : '-'
  // 任务描述：与主页弹窗同款 Markdown 渲染（description-markdown 样式随 index.css 内嵌）
  const desc = item.description ? renderMarkdownHtml(item.description) : '-'
  const p2 = (n) => String(n).padStart(2, '0')
  const dyns = (item.dynamics || []).map(d => {
    let t = ''
    if (d.created_at) { const dt = new Date(d.created_at); if (!isNaN(dt.getTime())) t = (dt.getMonth() + 1) + '-' + p2(dt.getDate()) + ' ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes()) }
    return '<div class="task-dynamic-item"><div class="task-dynamic-text">' + esc(d.text || '') + '</div>' + (t ? '<div class="task-dynamic-time">' + t + '</div>' : '') + '</div>'
  }).join('')
  const dynHtml = dyns || '<div class="task-detail-empty">暂无动态</div>'
  // 非叶子任务：直接子任务列表（编号+名称+状态徽标，可点击打开子任务弹窗）
  const childRows = hasChildren ? (item.children || []).map(c => '<div class="task-detail-child" data-child-task-id="' + esc(String(c.id != null ? c.id : c.task_ulid)) + '"><span class="task-detail-child-code">' + esc(c.code) + '</span><span class="task-detail-child-name">' + esc(c.name) + '</span>' + statusBadge(childStatusOf(c)) + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9CA3AF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>').join('') : ''
  // 返回上一级：存在父任务时可点击（全局弹窗容器中查找父任务弹窗）
  const backAttrs = parentId ? ' data-parent="' + esc(parentId) + '"' : ' disabled'
  const backCls = parentId ? ' task-detail-back' : ' task-detail-back is-disabled'
  const crumb = (parentId || anc.length)
    ? '<div class="task-detail-crumb"><button class="task-detail-icon-btn' + backCls + '"' + backAttrs + '><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></button>' + (anc.length ? '<span class="task-detail-ancestors">' + esc(anc.join(' / ')) + '</span>' : '') + '</div>'
    : ''
  // 父任务不在 prev/next 导航序列（与主页 navTasks 仅叶子一致）
  const navDisabled = hasChildren ? ' disabled' : ''
  const tid = esc(String(itemId))
  return '<div class="task-detail-overlay" data-task-detail="' + tid + '" data-leaf="' + (!hasChildren) + '" style="display:none"><div class="task-detail-panel">' +
    '<div class="task-detail-topbar">' +
    '<div class="task-detail-topbar-left">' +
    '<button class="task-detail-icon-btn" data-task-nav="prev" title="上一条任务"' + navDisabled + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>' +
    '<button class="task-detail-icon-btn" data-task-nav="next" title="下一条任务"' + navDisabled + '><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>' +
    '</div>' +
    '<div class="task-detail-topbar-right">' +
    '<button class="task-detail-icon-btn task-detail-msg" data-action="focus-dynamic" title="添加任务动态"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
    '<button class="task-detail-icon-btn task-detail-close" title="关闭"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
    '</div></div>' +
    '<div class="task-detail-content">' +
    '<div class="task-detail-main">' +
    '<div class="task-detail-main-scroll">' +
    crumb +
    '<h3>' + esc(item.code) + ' ' + esc(item.name) + '</h3>' +
    (childRows ? '<div class="task-detail-section"><div class="task-detail-section-label">子任务</div>' + childRows + '</div>' : '') +
    '<div class="task-detail-section"><div class="task-detail-section-label">任务描述</div><div class="task-detail-desc description-markdown">' + desc + '</div></div>' +
    '<div class="task-detail-section"><div class="task-detail-section-label">可交付成果</div>' + deliv + '</div>' +
    '<div class="task-detail-section" style="margin-bottom:0"><div class="task-detail-section-label">任务动态</div>' + dynHtml + '</div>' +
    '</div>' +
    '<div class="task-detail-inputbar"><input class="task-detail-input" placeholder="输入任务动态，回车发送" disabled title="静态页面不支持输入动态"><button class="btn-save task-detail-send" disabled>发送</button></div>' +
    '</div>' +
    '<div class="task-detail-side">' +
    '<div class="task-detail-group-title">计划信息</div>' +
    (!hasChildren ? '<div class="task-detail-row" style="align-items:flex-start"><div class="task-detail-label">资源需求</div><div class="task-detail-value task-detail-res">' + (resRows || '<span style="font-size:14px;color:#9CA3AF">-</span>') + '</div></div>' +
    '<div class="task-detail-row"><div class="task-detail-label">任务类型</div><div class="task-detail-value"><span class="task-type-badge ' + TTC(type) + '">' + type + '</span></div></div>' : '') +
    '<div class="task-detail-row"><div class="task-detail-label">总预估工时</div><div class="task-detail-value">' + (totalH > 0 ? totalH + 'h' : '-') + '</div></div>' +
    '<div class="task-detail-row"><div class="task-detail-label">总工期(天)</div><div class="task-detail-value">' + (days > 0 ? days : '-') + '</div></div>' +
    '<div class="task-detail-row"><div class="task-detail-label">开始时间</div><div class="task-detail-value">' + (item.start_date ? esc(item.start_date + (item.start_hour != null ? ' ' + item.start_hour + 'h' : '')) : '-') + '</div></div>' +
    '<div class="task-detail-row" style="margin-bottom:0"><div class="task-detail-label">结束时间</div><div class="task-detail-value">' + (item.end_date ? esc(item.end_date + (item.end_hour != null ? ' ' + item.end_hour + 'h' : '')) : '-') + '</div></div>' +
    '<div class="task-detail-side-bottom">' +
    '<div class="task-detail-group-title">实际完成情况</div>' +
    '<div class="task-detail-row"><div class="task-detail-label">任务状态</div><div class="task-detail-value">' + statusBadge(status) + '</div></div>' +
    '<div class="task-detail-row" style="margin-bottom:0"><div class="task-detail-label">完成进度</div><div class="task-detail-value"><div class="task-detail-progress"><div class="task-detail-progress-track"><div class="task-detail-progress-fill" style="width:' + prog + '%;background:' + barColor + '"></div></div><span class="task-detail-progress-num">' + prog + '%</span></div></div></div>' +
    '</div>' +
    '</div></div></div></div>'
}

function renderKanbanTab(flatTasks, tree, members, ganttMaxDepth, dailyInputHours, statusOf, progressOf) {
  const { groups, groupOrder } = buildKanbanGroups(flatTasks, tree)
  // 每个叶子卡片记录其一级任务分组名，供前端「按任务状态」切换时客户端重排
  const parentGroupOf = (item, t) => {
    const anc = (t || []).find(root => { const f = (ns) => { for (const n of ns || []) { if (n.id === item.id || n.task_ulid === item.id) return true; if (n.children && f(n.children)) return true } return false }; return f([root]) })
    return anc ? (anc.code ? anc.code + ' ' + anc.name : anc.name) : '未分组'
  }
  if (!groupOrder.length) return '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">暂无任务</div></div>'
  const cols = groupOrder.map(name => {
    const cards = groups[name].map(item => {
      const type = getTaskType(item)
      const memberKeys = rowMemberAttr(item.resources)
      const dt = (item.start_date || item.end_date) ? '<div class="kanban-card-dates">' + (item.start_date || '') + (item.start_hour != null ? ' ' + item.start_hour + 'h' : '') + ' 至 ' + (item.end_date || '') + (item.end_hour != null ? ' ' + item.end_hour + 'h' : '') + '</div>' : ''
      const milestoneFlag = type === '里程碑' ? '<span class="milestone-btn milestone-active" title="里程碑"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg></span>' : ''
      // 统计芯片：人员图标+人数 / 时钟图标+工时（与项目主页看板卡片同结构）
      const memberStat = '<span class="kanban-card-stat" title="参与人数"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' + ((item.resources && item.resources.length) || 0) + '人</span>'
      const hoursStat = '<span class="kanban-card-stat" title="总预估工时"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' + fmtH(item.totalHours || 0) + '</span>'
      const statsLine = '<div class="kanban-card-stats">' + memberStat + hoursStat + '</div>'
      const statusLine = '<div class="kanban-card-status">' + execStatusBadgeHtml(statusOf(item)) + (statusOf(item) === 'in_progress' ? '<span class="kanban-card-progress" title="完成进度">' + (progressOf ? progressOf(item) : 0) + '%</span>' : '') + '</div>'
      const calIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
      const footerLine = dt ? '<div class="kanban-card-footer">' + calIcon + '<span class="kanban-card-dates">' + (item.start_date || '') + (item.start_hour != null ? ' ' + item.start_hour + 'h' : '') + ' 至 ' + (item.end_date || '') + (item.end_hour != null ? ' ' + item.end_hour + 'h' : '') + '</span></div>' : ''
      return '<div class="kanban-card" data-task-id="' + esc(String(item.id != null ? item.id : item.task_ulid)) + '" data-level="' + item.level + '" data-status="' + (statusOf(item) || '') + '" data-parent-group="' + esc(parentGroupOf(item, tree)) + '" data-members="' + esc(memberKeys) + '" data-start="' + (item.start_date || '') + '" data-end="' + (item.end_date || '') + '"><div class="kanban-card-header"><span class="task-code">' + esc(item.code) + '</span>' + milestoneFlag + '</div><div class="kanban-card-name">' + esc(item.name) + '</div>' + statsLine + statusLine + footerLine + '</div>'
    }).join('')
    return '<div class="kanban-column"><div class="kanban-column-header"><div class="kanban-column-header-left"><span class="kanban-column-title">' + esc(name) + '</span><span class="kanban-column-count">' + groups[name].length + '</span></div></div><div class="kanban-column-body">' + cards + '</div></div>'
  }).join('')
  // 筛选条件在顶部共享筛选栏；看板视图锁定执行层级（JS 端控制），不再内嵌工具栏
  return '<div class="kanban-board">' + cols + '</div>'
}

function renderCalendarTab(flatTasks, tree, skipHolidays, members, dailyInputHours, statusOf, progressOf) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth()
  const fd = new Date(y, m, 1).getDay(), dim = new Date(y, m + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < fd; i++) cells.push(null)
  for (let d = 1; d <= dim; d++) cells.push(d)
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const mm = String(m + 1).padStart(2, '0')
  const keyOf = (d) => y + '-' + mm + '-' + String(d).padStart(2, '0')
  const dowOf = (key) => { const p = key.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]).getDay() }
  // 绝对天数序号：跨周任务条的进度填充需要全局时间轴（每段按实际被填充比例渲染，而非每段都填 progress%）
  const dayNum = (key) => { const p = key.split('-').map(Number); return Math.round(new Date(p[0], p[1] - 1, p[2]).getTime() / 86400000) }
  const monthStartKey = keyOf(1), monthEndKey = keyOf(dim)
  // 任务起止范围（与当月有交集才显示，渲染为跨日完整任务条）
  // 执行层级：全部叶子任务条；1级任务：一级任务条（含带子任务的一级汇总条，起止为子任务聚合日期）
  const leaves = flatTasks.filter(i => !i.children || i.children.length === 0)
  const ranges = []
  for (const item of leaves) {
    if (!item.start_date) continue
    const sd = item.start_date, ed = item.end_date || item.start_date
    if (ed < monthStartKey || sd > monthEndKey) continue
    ranges.push({ task: item, sd, ed })
  }
  const sumRanges = []
  for (const item of flatTasks) {
    if (!item.children || item.children.length === 0 || item.level !== 0) continue
    if (!item.start_date) continue
    const sd = item.start_date, ed = item.end_date || item.start_date
    if (ed < monthStartKey || sd > monthEndKey) continue
    sumRanges.push({ task: item, sd, ed })
  }
  const tk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  const wk = ['日', '一', '二', '三', '四', '五', '六']
  const weekRows = weeks.map((week) => {
    const realDays = week.filter(d => d !== null)
    if (!realDays.length) return ''
    const wStartKey = keyOf(realDays[0]), wEndKey = keyOf(realDays[realDays.length - 1])
    // 本周任务段：裁剪到本周范围，按列(周日~周六)定位
    // 首日/末日按 start_hour/end_hour 占每日投入工时的比例裁剪宽度（仅任务真实起止日生效）
    const dHours = Math.max(1, dailyInputHours || 8)
    const buildSegs = (rs) => {
      const arr = []
      for (const r of rs) {
        const s = r.sd > wStartKey ? r.sd : wStartKey
        const e = r.ed < wEndKey ? r.ed : wEndKey
        if (s > e) continue
        const rawSh = r.task.start_hour != null ? Number(r.task.start_hour) / dHours : 0
        const rawEh = r.task.end_hour != null ? Number(r.task.end_hour) / dHours : 1
        // 里程碑：start 按 start_hour 占比偏移（旗帜从当日时刻位置起绘），end 按整天占位防零宽段被泳道/渲染跳过
        const isMs = r.task.taskType === '里程碑'
        const shFrac = (isMs || s === r.sd) ? Math.min(1, Math.max(0, rawSh)) : 0
        const ehFrac = isMs ? 1 : ((e === r.ed) ? Math.min(1, Math.max(0, rawEh)) : 1)
        arr.push({ task: r.task, cs: dowOf(s), ce: dowOf(e), shFrac, ehFrac })
      }
      // 泳道分配：按小数天单位（含起止小时占比）判断不重叠，
      // 同日前后紧接的任务（如 1.1 在 4h 结束、1.2 从 4h 开始）可共用一行
      arr.forEach(sg => { sg.startUnit = sg.cs + sg.shFrac; sg.endUnit = sg.ce + sg.ehFrac })
      arr.sort((a, b) => a.startUnit - b.startUnit || (b.endUnit - b.startUnit) - (a.endUnit - a.startUnit))
      const ends = []
      for (const sg of arr) {
        let lane = ends.findIndex(le => le <= sg.startUnit + 1e-6)
        if (lane === -1) { ends.push(sg.endUnit); lane = ends.length - 1 }
        else ends[lane] = sg.endUnit
        sg.lane = lane
      }
      return { segs: arr, laneCount: ends.length }
    }
    const { segs, laneCount: leafLanes } = buildSegs(ranges)
    // 一级汇总任务条：独立泳道（排在叶子泳道之后），仅「1级任务」层级筛选时显示（默认 display:none）
    const { segs: sumSegs, laneCount: sumLanes } = buildSegs(sumRanges)
    const rowMinH = Math.max(90, 24 + (leafLanes + sumLanes) * 20 + 8)
    const dayCells = week.map((day) => {
      if (day === null) return '<div class="calendar-cell calendar-cell-empty"></div>'
      const dk = keyOf(day), isT = dk === tk, isH = skipHolidays && isNonWorkDay(dk)
      return '<div class="calendar-cell' + (isT ? ' calendar-cell-today' : '') + (isH ? ' calendar-cell-holiday' : '') + '"><div class="calendar-cell-day' + (isT ? ' calendar-day-today' : '') + '">' + day + '</div></div>'
    }).join('')
    // 任务条拆段渲染：跳过节假日时节假日段不渲染（截断），工作日段各自独立成条
    const buildBars = (segsArr, laneOffset, extraCls) => segsArr.map((sg) => {
      const task = sg.task
      const fl = parseInt((task.code || '').split('.')[0], 10) || 1, ci = ((fl - 1) % themeColors.length), tc = themeColors[ci]
      const cmk = (task.resources || []).map(r => memberKey(r)).filter(Boolean).join(',')
      const tid = String(task.id != null ? task.id : task.task_ulid)
      const runs = []
      for (let d = sg.cs; d <= sg.ce; d++) {
        const s0 = Math.max(d, sg.startUnit)
        const e0 = Math.min(d + 1, sg.endUnit)
        if (e0 <= s0) continue
        // 里程碑是单点事件：即使落在节假日（跳过节假日开启时）也照常绘制旗帜
        const isHol = skipHolidays && task.taskType !== '里程碑' && week[d] != null && isNonWorkDay(keyOf(week[d]))
        if (isHol) continue
        const last = runs[runs.length - 1]
        if (last && last.end === s0) last.end = e0
        else runs.push({ start: s0, end: e0 })
      }
      return runs.map((run, ri) => {
        // 里程碑：绘制旗帜图标（不定宽任务条），从当日 start_hour 对应位置起绘，宽度不超过当日剩余空间
        if (task.taskType === '里程碑') {
          const dayFrac = run.start - Math.floor(run.start)
          const mLeft = 'left:calc(' + run.start + ' * 100% / 7 + 1px)'
          const mTop = 'top:' + (24 + (laneOffset + sg.lane) * 20) + 'px'
          const mMaxW = 'max-width:calc(' + ((1 - dayFrac) * 100) + '% / 7 - 4px)'
          const mMeta = EXEC_STATUS[statusOf(task)]
          const mTip = esc(task.code + ' ' + task.name + ' · 里程碑' + (mMeta ? ' · 任务状态：' + mMeta.label : ''))
          return '<div class="calendar-task-chip calendar-milestone-chip" data-task-id="' + esc(tid) + '" data-level="' + task.level + '" data-status="' + (statusOf(task) || '') + '" data-members="' + esc(cmk) + '" data-start="' + (task.start_date || '') + '" data-end="' + (task.end_date || '') + '" style="' + mLeft + ';' + mTop + ';' + mMaxW + '" title="' + mTip + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position:relative;z-index:1"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><span class="task-code" style="font-size:10px;color:#b45309;position:relative;z-index:1">' + esc(task.code) + '</span><span class="calendar-task-name" style="color:#b45309;position:relative;z-index:1">' + esc(task.name) + '</span></div>'
        }
        const span = Math.max(run.end - run.start, 0.12)
        const showText = ri === 0
        const calProgress = Math.min(100, progressOf(task))
        const stMeta = EXEC_STATUS[statusOf(task)]
        const stNow = statusOf(task)
        const left = 'left:calc(' + run.start + ' * 100% / 7 + 1px)'
        const width = 'width:calc(' + span + ' * 100% / 7 - 2px)'
        const top = 'top:' + (24 + (laneOffset + sg.lane) * 20) + 'px'
        // 任务条颜色始终跟随甘特条主题色；状态通过名称文字样式 + 条右侧状态图标/比例体现：
        // 已完成 = 名称删除线置灰 + 右侧绿对勾；已延误 = 名称红字 + 右侧红感叹号；进行中 = 右侧比例
        const bg = 'background:' + tc.light + ';border-left:3px solid ' + tc.solid
        // 完成进度：深色填充按任务绝对时间轴换算——已完成绝对区间与本段的重叠比例，
        // 跨周拆段时每段只填各自实际完成的部分（而非每段都填 calProgress%）
        let fill = ''
        if (calProgress > 0) {
          const dH = dHours
          const rawSh = task.start_hour != null ? Number(task.start_hour) / dH : 0
          const rawEh = task.end_hour != null ? Number(task.end_hour) / dH : 1
          const tStartAbs = dayNum(task.start_date) + rawSh
          const tEndAbs = dayNum(task.end_date || task.start_date) + rawEh
          const filledAbs = tStartAbs + (tEndAbs - tStartAbs) * calProgress / 100
          const sF = Math.floor(run.start), eF = Math.min(Math.floor(run.end), 6)
          const runStartAbs = dayNum(keyOf(week[sF])) + (run.start - sF)
          const runEndAbs = dayNum(keyOf(week[eF])) + (run.end - eF)
          const runLen = runEndAbs - runStartAbs
          let fillPct = 0
          if (runLen > 1e-9) fillPct = Math.max(0, Math.min(1, (Math.min(runEndAbs, filledAbs) - runStartAbs) / runLen)) * 100
          else if (filledAbs >= runEndAbs) fillPct = 100
          if (fillPct > 0) fill = '<div style="position:absolute;left:0;top:0;bottom:0;width:' + fillPct + '%;background:' + tc.solid + 'B3;border-radius:inherit;pointer-events:none;z-index:0" title="完成进度：' + calProgress + '%"></div>'
        }
        const nameStyle = stNow === 'completed' ? 'text-decoration:line-through;color:#94a3b8' : stNow === 'delayed' ? 'color:#DC2626' : 'color:#2d3748'
        const rightSlot = stNow === 'completed'
          ? statusDotSvg('completed', 12, 'margin-left:auto;flex-shrink:0;position:relative;z-index:1')
          : stNow === 'delayed'
            ? statusDotSvg('delayed', 12, 'margin-left:auto;flex-shrink:0;position:relative;z-index:1')
            : (stNow === 'in_progress' ? '<span style="margin-left:auto;font-size:10px;font-weight:600;color:#1D4ED8;position:relative;z-index:1;white-space:nowrap;flex-shrink:0">' + calProgress + '%</span>' : '')
        const text = showText ? '<span class="task-code" style="font-size:10px;color:' + tc.dash + ';position:relative;z-index:1">' + esc(task.code) + '</span><span class="calendar-task-name" style="' + nameStyle + ';position:relative;z-index:1">' + esc(task.name) + '</span>' + rightSlot : ''
        const tip = esc(task.code + ' ' + task.name + (stMeta ? ' · 任务状态：' + stMeta.label : '') + (calProgress > 0 ? ' · 完成进度：' + calProgress + '%' : ''))
        return '<div class="calendar-task-chip calendar-task-bar' + extraCls + '" data-task-id="' + esc(tid) + '" data-level="' + task.level + '" data-status="' + (statusOf(task) || '') + '" data-members="' + esc(cmk) + '" data-start="' + (task.start_date || '') + '" data-end="' + (task.end_date || '') + '" style="' + left + ';' + width + ';' + top + ';' + bg + '" title="' + tip + '">' + fill + text + '</div>'
      }).join('')
    }).join('')
    const bars = buildBars(segs, 0, '')
    const sumBars = buildBars(sumSegs, leafLanes, ' calendar-level1-summary')
    return '<div class="calendar-week-row" style="min-height:' + rowMinH + 'px">' + dayCells + bars + sumBars + '</div>'
  }).join('')
  // 筛选条件在顶部共享筛选栏；日历视图保留月份导航（上一月/下一月/今天，由客户端脚本切换重渲染）
  return '<div class="gantt-toolbar calendar-toolbar" style="border-bottom:1px solid #e2e8f0"><div class="gantt-quick-btns"><div class="calendar-nav">' +
    '<button class="calendar-nav-btn" id="cal-prev" title="上一月"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
    '<span class="calendar-nav-label" id="cal-nav-label">' + y + '年' + (m + 1) + '月</span>' +
    '<button class="calendar-nav-btn" id="cal-next" title="下一月"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
    '<button class="calendar-today-btn" id="cal-today">今天</button>' +
    '</div></div></div>' +
    '<div id="calendar-dynamic"><div class="calendar-container"><div class="calendar-header-row">' + wk.map(w => '<div class="calendar-header-cell">' + w + '</div>').join('') + '</div><div class="calendar-grid">' + weekRows + '</div></div></div>'
}

// 团队成员侧边栏：结构与主页 MemberList（showDetails 只读态）对齐，但静态导出不渲染任何编辑入口
// （添加角色/添加成员/更多操作按钮均不输出），样式类均来自内联的 index.css
function renderMembersSidebar(members, memberStats) {
  if (!members || !members.length) return ''
  const grouped = {}
  for (const m of members) { const role = m.role || '未分组'; if (!grouped[role]) grouped[role] = []; grouped[role].push(m) }
  const groups = Object.entries(grouped).map(([role, mems]) => {
    const items = mems.map(m => {
      // 与主页 lookupMemberStats 一致的三级回退：member_ulid → role+name → 空姓名按 role
      const lookup = (mm) => {
        if (mm.member_ulid) { const s = memberStats['uid:' + mm.member_ulid]; if (s) return s }
        const s2 = memberStats['role:' + (mm.role || '') + '|name:' + (mm.name || '')]
        if (s2) return s2
        if (!mm.name) { const s3 = memberStats['role:' + (mm.role || '') + '|name:']; if (s3) return s3 }
        return { taskCount: 0, totalHours: 0 }
      }
      const stat = lookup(m)
      // 主页侧边栏 tasks 为占位（无排期信息），冲突检测恒为 false → 状态标签恒为「正常」
      return '<li class="member-item-wrapper"><div class="member-item"><div class="member-item-top">' +
        '<span class="member-avatar' + (!m.name ? ' empty' : '') + '">' + (m.name ? esc(m.avatar || '') : '?') + '</span>' +
        '<div class="member-info">' +
        '<div class="member-name-row"><span class="member-name">' + esc(m.name || '待分配') + '</span><span class="status-tag normal">正常</span></div>' +
        '<div class="member-meta"><span class="meta-text">任务: ' + stat.taskCount + '个</span><span class="meta-text">工时: ' + (parseFloat((stat.totalHours || 0).toFixed(2)) + 'h') + '</span></div>' +
        '</div>' +
        '</div></div></li>'
    }).join('')
    return '<div class="role-group"><div class="role-header"><div class="role-title"><span class="role-name">' + esc(role) + '</span><span class="role-count">(' + mems.length + '人)</span></div></div><ul class="member-items">' + items + '</ul></div>'
  }).join('')
  return '<div class="member-list"><div class="member-list-header"><button class="member-collapse-btn" id="team-collapse" title="收起成员列表"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg></button></div>' + groups + '</div>'
}

const CSS = appCss

const OVERRIDES_CSS = `
/* 顶部导航条：结构与类名与项目主页一致（content-header / header-title-project / project-stats-bar），
   样式全部复用内联 index.css，此处仅补充导出页所需的少量覆盖 */
.content-header{background:#fff;border-bottom:1px solid #f1f5f9}
/* 任务详情只读预览弹窗（对齐主页 TaskDetailPreview）：顶部操作栏 + 左主区（路径/标题/描述/成果/动态/输入区）+ 右属性栏 */
.kanban-card{cursor:pointer}
.task-detail-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000}
.task-detail-panel{position:relative;display:flex;flex-direction:column;background:#fff;border-radius:12px;width:800px;max-width:94vw;height:80vh;max-height:80vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
.task-detail-topbar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f3f4f6;flex-shrink:0}
.task-detail-topbar-left,.task-detail-topbar-right{display:flex;align-items:center;gap:2px}
.task-detail-icon-btn{background:none;border:none;cursor:pointer;color:#6b7280;padding:4px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.task-detail-icon-btn:hover{background:#f3f4f6}
.task-detail-icon-btn:disabled{color:#d1d5db;cursor:default;background:none}
.task-detail-icon-btn.is-disabled{color:#d1d5db;cursor:default}
.task-detail-content{display:flex;flex:1;min-height:0}
.task-detail-main{flex:1;min-width:0;display:flex;flex-direction:column}
.task-detail-main-scroll{flex:1;overflow-y:auto;padding:20px 28px}
.task-detail-main h3{margin:0 0 20px;font-size:20px;font-weight:600;color:#1F2937}
.task-detail-crumb{display:flex;align-items:center;gap:6px;margin-bottom:12px}
.task-detail-back{padding:2px}
.task-detail-ancestors{font-size:13px;color:#6B7280}
.task-detail-section{margin-bottom:20px}
.task-detail-section-label{font-size:13px;color:#6B7280;margin-bottom:8px}
.task-detail-inputbar{border-top:1px solid #f3f4f6;padding:12px 28px;display:flex;gap:8px;align-items:center;flex-shrink:0}
.task-detail-input{flex:1;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;background:#f9fafb;color:#1f2937;outline:none}
.task-detail-input:disabled{cursor:not-allowed}
.task-detail-send{padding:8px 16px;font-size:13px;flex-shrink:0}
.task-dynamic-item{margin-bottom:12px}
.task-dynamic-text{font-size:14px;color:#1f2937;line-height:1.5;white-space:pre-wrap}
.task-dynamic-time{font-size:12px;color:#9ca3af;margin-top:2px}
.task-detail-empty{font-size:14px;color:#9ca3af}
.task-detail-side{width:300px;flex-shrink:0;background:#F7F8FA;padding:24px 20px;overflow-y:auto}
.task-detail-group-title{font-size:12px;color:#9CA3AF;font-weight:600;margin-bottom:14px;letter-spacing:1px}
.task-detail-side-bottom{margin-top:24px;padding-top:20px;border-top:1px solid #E5E7EB}
.task-detail-progress{display:flex;align-items:center;gap:8px}
.task-detail-progress-track{flex:1;height:6px;border-radius:3px;background:#E5E7EB;overflow:hidden;min-width:0}
.task-detail-progress-fill{height:100%;border-radius:3px;background:#2563EB}
.task-detail-progress-num{font-size:13px;color:#6B7280;flex-shrink:0}
.task-detail-row{display:flex;align-items:center;margin-bottom:16px}
.task-detail-label{font-size:13px;color:#6B7280;width:76px;flex-shrink:0}
.task-detail-value{font-size:14px;color:#1F2937;flex:1;min-width:0}
.task-detail-res{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.task-detail-res .resource-item{max-width:100%;min-width:0}
.task-detail-res .resource-info{display:flex;align-items:center;min-width:0}
.task-detail-res .resource-name{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1}
.task-detail-res .resource-hours{flex-shrink:0;white-space:nowrap}
/* 摘要任务条：与主页一致可悬停（列高亮）可点击（打开预览弹窗） */
.gantt-summary-bar{pointer-events:auto;cursor:pointer}
/* 非叶子任务弹窗：子任务列表行 */
.task-detail-child{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #F3F4F6;font-size:14px;cursor:pointer}
.task-detail-child-code{color:#6B7280;flex-shrink:0}
.task-detail-child-name{color:#1F2937;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-detail-child .task-status-badge{margin-left:8px;flex-shrink:0}
.task-detail-child svg{margin-left:auto;flex-shrink:0}
.task-status-badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;flex-shrink:0}
.task-detail-desc{white-space:pre-wrap;line-height:1.6}
.gantt-filter-item{position:relative}
.gantt-filter-dropdown{position:absolute!important;top:100%;left:0;margin-top:4px;z-index:10000}
.member-multi-dropdown{z-index:10001!important}
.project-schedule-wrapper{overflow:auto!important}
.wbs-table-container{overflow:visible!important}
/* 筛选栏固定：水平滚动时保持左侧，垂直滚动时吸顶 */
.gantt-toolbar{position:sticky!important;top:0;left:0;z-index:20!important;background:#fff!important}
/* 表头吸顶在筛选栏下方，避免重叠 */
.gantt-header-row{position:sticky!important;top:0;z-index:11!important}
/* 日历视图：一级汇总任务条默认隐藏，仅「1级任务」层级筛选时由脚本显示 */
.calendar-level1-summary{display:none}
/* 左侧任务列在水平滚动时固定 */
.gantt-frozen-column{position:sticky!important;left:0;z-index:10!important;background:#fff!important}
/* 共享筛选栏压过各视图内部工具栏（含日历月份行），保证下拉不被遮挡 */
.gantt-toolbar.filter-bar{z-index:31!important}
/* 日历月份导航行：与主页一致不吸顶，不被压缩 */
.gantt-toolbar.calendar-toolbar{position:static!important;flex-shrink:0}
/* 页面高度约束：顶栏 + 主区铺满视口，各视图/成员侧栏内部滚动（修复侧栏滚不到底、最后一个成员被截断） */
body{margin:0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
.project-home{flex:1;min-height:0;height:auto}
/* 各视图面板铺满主区并内部滚动（与主页布局一致） */
.tab-panel{flex:1;min-height:0}
#calendar-dynamic{flex:1;min-height:0;display:flex;flex-direction:column}
.project-home-member-sidebar .member-list{padding-bottom:16px}
`

const TAB_SCRIPT = `
<script>
(function(){
  var DR_MIN = window.__DR_MIN || null;
  var DR_MAX = window.__DR_MAX || null;
  function parseDateStr(s){ if(!s) return null; var p=String(s).split('-'); if(p.length<3) return null; return new Date(+p[0], +p[1]-1, +p[2]); }
  var DR_MIN_D = parseDateStr(DR_MIN);
  var DR_MAX_D = parseDateStr(DR_MAX);
  document.querySelectorAll('.project-tab').forEach(function(tab){
    tab.addEventListener('click',function(){
      document.querySelectorAll('.project-tab').forEach(function(t){t.classList.remove('active')});
      this.classList.add('active');
      var key=this.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(function(p){p.style.display='none'});
      document.getElementById('tab-'+key).style.display='flex';
      var groupItem=document.getElementById('group-filter-item');
      if(groupItem)groupItem.style.display=(key==='kanban')?'':'none';
      updateLevelFilterUI();
      applyFilters();
    });
  });
  var teamBtn=document.getElementById('team-toggle');
  var sidebar=document.getElementById('team-sidebar');
  var collapseBtn=document.getElementById('team-collapse');
  function toggleTeamSidebar(){if(sidebar){sidebar.style.display=sidebar.style.display==='none'?'':'none'}}
  if(teamBtn&&sidebar){teamBtn.addEventListener('click',toggleTeamSidebar)}
  if(collapseBtn&&sidebar){collapseBtn.addEventListener('click',toggleTeamSidebar)}

  var granBtn=document.querySelector('.gantt-granularity-trigger');
  var granMenu=document.querySelector('.gantt-granularity-menu');
  if(granBtn&&granMenu){
    granBtn.addEventListener('click',function(e){
      e.stopPropagation();
      var wasOpen=granMenu.style.display==='block';
      document.querySelectorAll('.gantt-filter-dropdown,.member-multi-dropdown').forEach(function(d){d.style.display='none'});
      granMenu.style.display=wasOpen?'none':'block';
    });
  }
  document.querySelectorAll('.gantt-granularity-option').forEach(function(opt){
    opt.addEventListener('click',function(e){
      e.stopPropagation();
      var g=this.dataset.value;
      if(granBtn){granBtn.childNodes[0].textContent=this.textContent}
      if(granMenu){granMenu.style.display='none'}
      document.querySelectorAll('.gantt-granularity-option').forEach(function(o){o.classList.remove('active')});
      this.classList.add('active');
      // 切换可见的时间粒度（表头右侧 + 主体）
      currentGran=g;
      document.querySelectorAll('#tab-gantt .gantt-header-right').forEach(function(hr){hr.style.display=(hr.dataset.gran===g)?'':'none';});
      document.querySelectorAll('#tab-gantt .gantt-body').forEach(function(b){b.style.display=(b.dataset.gran===g)?'':'none';});
      rebuildArrows();
    });
  });

  // 左侧任务列拖动加宽（与项目主页 taskColumnWidth 行为一致：clamp 160~560）
  var ganttResizer=document.querySelector('#tab-gantt .gantt-frozen-resizer');
  if(ganttResizer){
    ganttResizer.addEventListener('mousedown',function(e){
      e.preventDefault();
      e.stopPropagation();
      var frozenCol=document.querySelector('#tab-gantt .gantt-frozen-column');
      var headerLeft=document.querySelector('#tab-gantt .gantt-header-left');
      if(!frozenCol)return;
      var startX=e.clientX;
      var startW=parseFloat(frozenCol.style.width)||frozenCol.getBoundingClientRect().width;
      function onMove(ev){
        var w=Math.min(560,Math.max(160,startW+(ev.clientX-startX)));
        frozenCol.style.width=w+'px';frozenCol.style.minWidth=w+'px';
        if(headerLeft){headerLeft.style.width=w+'px';headerLeft.style.minWidth=w+'px';}
      }
      function onUp(){
        window.removeEventListener('mousemove',onMove);
        window.removeEventListener('mouseup',onUp);
        document.body.style.cursor='';document.body.style.userSelect='';
      }
      window.addEventListener('mousemove',onMove);
      window.addEventListener('mouseup',onUp);
      document.body.style.cursor='col-resize';document.body.style.userSelect='none';
    });
  }

  var drState={selecting:'start',tempStart:null,tempEnd:null,hoverDate:null,calYear:new Date().getFullYear(),calMonth:new Date().getMonth()};
  var WEEKDAYS=['日','一','二','三','四','五','六'];
  var MONTHS=['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  function pad2(n){return n<10?'0'+n:''+n}
  function fmtDate(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())}
  function sameDay(a,b){return a&&b&&a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate()}
  function getDaysInMonth(y,m){return new Date(y,m+1,0).getDate()}
  function getFirstDayOfMonth(y,m){return new Date(y,m,1).getDay()}
  function isToday(d){return sameDay(d,new Date())}
  var CHECK_SVG='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  function buildDRCalendarHtml(calId){
    var y=drState.calYear,m=drState.calMonth;
    var daysInMonth=getDaysInMonth(y,m),firstDay=getFirstDayOfMonth(y,m);
    var hint='';
    if(drState.selecting==='start'){hint='请选择开始日期'}
    else if(drState.tempStart){hint=fmtDate(drState.tempStart)+' \\u2192 请选择结束日期'}
    else{hint='请选择结束日期'}
    var html='<div class="datepicker-header"><button class="datepicker-nav-btn dr-prev" data-cal="'+calId+'">\\u2039</button><div class="datepicker-title">'+y+'年'+MONTHS[m]+'</div><button class="datepicker-nav-btn dr-next" data-cal="'+calId+'">\\u203A</button></div>';
    html+='<div class="datepicker-weekdays">'+WEEKDAYS.map(function(d){return '<div class="datepicker-weekday">'+d+'</div>'}).join('')+'</div>';
    html+='<div class="datepicker-days">';
    for(var i=0;i<firstDay;i++) html+='<div class="datepicker-empty-cell"></div>';
    var rStart=drState.selecting==='end'?drState.tempStart:null;
    var rEnd=drState.selecting==='end'?drState.hoverDate:drState.tempEnd;
    for(var day=1;day<=daysInMonth;day++){
      var cellDate=new Date(y,m,day);
      var cls='datepicker-day';
      if(isToday(cellDate)) cls+=' today';
      if(rStart&&sameDay(cellDate,rStart)) cls+=' selected';
      if(rEnd&&sameDay(cellDate,rEnd)) cls+=' selected';
      if(rStart&&rEnd&&cellDate>rStart&&cellDate<rEnd) cls+=' in-range';
      var isDisabled = (DR_MIN_D && cellDate < DR_MIN_D) || (DR_MAX_D && cellDate > DR_MAX_D);
      if(isDisabled) cls+=' disabled';
      html+='<button class="'+cls+'" data-cal="'+calId+'" data-day="'+day+'"'+(isDisabled?' disabled':'')+'>'+day+'</button>';
    }
    html+='</div><div class="date-range-calendar-hint">'+hint+'</div>';
    return html;
  }
  function renderDRCalendar(calId){
    var el=document.getElementById(calId);
    if(el) el.innerHTML=buildDRCalendarHtml(calId);
  }
  function handleDRCalClick(calId,day){
    var clickedDate=new Date(drState.calYear,drState.calMonth,day);
    if(drState.selecting==='start'){
      drState.tempStart=clickedDate;drState.tempEnd=null;drState.selecting='end';
    }else{
      var s=drState.tempStart||clickedDate,e=clickedDate;
      if(clickedDate<s){var t=s;s=e;e=t}
      drState.tempStart=s;drState.tempEnd=e;drState.selecting='start';
      var val=fmtDate(s)+' ~ '+fmtDate(e);
      // 跨视图同步：更新四个视图的时间范围触发器文案
      document.querySelectorAll('.gantt-filter-trigger[data-filter="time"] .gantt-filter-value').forEach(function(v){ v.textContent=val; });
      setTimeHasFilter(true);
      document.getElementById(calId).style.display='none';
      currentDateRange={start:fmtDate(s),end:fmtDate(e)};
      drState.tempStart=null;drState.tempEnd=null;
      applyFilters();
    }
    renderDRCalendar(calId);
  }

  function closeAllDropdowns(){
    document.querySelectorAll('.gantt-filter-dropdown,.member-multi-dropdown,.gantt-granularity-menu').forEach(function(d){d.style.display='none'});
  }
  function setTimeHasFilter(on){
    document.querySelectorAll('.gantt-filter-trigger[data-filter="time"]').forEach(function(el){
      if(on) el.classList.add('has-filter'); else el.classList.remove('has-filter');
    });
  }

  document.querySelectorAll('.gantt-filter-trigger').forEach(function(trigger){
    trigger.addEventListener('click',function(e){
      e.stopPropagation();
      // 任务层级筛选在看板视图锁定，不可展开
      if(this.dataset.filter==='level'&&this.classList.contains('is-locked'))return;
      var item=this.closest('.gantt-filter-item');
      if(!item)return;
      var dd=item.querySelector('.gantt-filter-dropdown')||item.querySelector('.member-multi-dropdown');
      if(!dd)return;
      var wasOpen=dd.style.display==='block';
      closeAllDropdowns();
      if(!wasOpen){
        dd.style.display='block';
        if(dd.classList.contains('date-range-calendar-dropdown')){
          drState={selecting:'start',tempStart:null,tempEnd:null,hoverDate:null,calYear:new Date().getFullYear(),calMonth:new Date().getMonth()};
          renderDRCalendar(dd.id);
        }
      }
    });
  });
  document.querySelectorAll('.gantt-filter-clear').forEach(function(el){
    el.addEventListener('click',function(e){
      e.stopPropagation();
      currentDateRange=null;
      document.querySelectorAll('.gantt-filter-trigger[data-filter="time"] .gantt-filter-value').forEach(function(v){ v.textContent='全部时间'; });
      setTimeHasFilter(false);
      applyFilters();
    });
  });
  document.addEventListener('click',function(e){
    if(!e.target.closest('.gantt-filter-dropdown')&&!e.target.closest('.member-multi-dropdown')&&!e.target.closest('.gantt-filter-trigger')&&!e.target.closest('.gantt-granularity-menu')&&!e.target.closest('.gantt-granularity-trigger')){
      closeAllDropdowns();
    }
  });
  document.addEventListener('click',function(e){
    if(e.target.classList.contains('dr-prev')){
      e.stopPropagation();
      var calId=e.target.dataset.cal;drState.calMonth--;if(drState.calMonth<0){drState.calMonth=11;drState.calYear--}
      renderDRCalendar(calId);
    }
    if(e.target.classList.contains('dr-next')){
      e.stopPropagation();
      var calId=e.target.dataset.cal;drState.calMonth++;if(drState.calMonth>11){drState.calMonth=0;drState.calYear++}
      renderDRCalendar(calId);
    }
    if(e.target.classList.contains('datepicker-day')&&!e.target.classList.contains('disabled')){
      e.stopPropagation();
      var calId=e.target.dataset.cal,day=parseInt(e.target.dataset.day);handleDRCalClick(calId,day);
    }
  });
  function updateDRCalendarRange(calId){
    var el=document.getElementById(calId);if(!el)return;
    var rStart=drState.selecting==='end'?drState.tempStart:null;
    var rEnd=drState.selecting==='end'?drState.hoverDate:drState.tempEnd;
    el.querySelectorAll('.datepicker-day').forEach(function(btn){
      var day=parseInt(btn.dataset.day);
      var cellDate=new Date(drState.calYear,drState.calMonth,day);
      btn.classList.toggle('selected',sameDay(cellDate,rStart)||sameDay(cellDate,rEnd));
      btn.classList.toggle('in-range',rStart&&rEnd&&cellDate>rStart&&cellDate<rEnd);
    });
    var hint=el.querySelector('.date-range-calendar-hint');
    if(hint){
      if(drState.selecting==='start')hint.textContent='请选择开始日期';
      else if(drState.tempStart)hint.textContent=fmtDate(drState.tempStart)+' \\u2192 请选择结束日期';
      else hint.textContent='请选择结束日期';
    }
  }
  document.addEventListener('mouseover',function(e){
    if(e.target.classList.contains('datepicker-day')&&!e.target.classList.contains('disabled')&&drState.selecting==='end'){
      e.stopPropagation();
      drState.hoverDate=new Date(drState.calYear,drState.calMonth,parseInt(e.target.dataset.day));
      updateDRCalendarRange(e.target.dataset.cal);
    }
  });

  var currentLevel='all';
  var currentStatus='all';
  var currentDateRange=null;
  var currentMembers=[];
  var currentGroupBy='parent'; // 看板分组：'parent' 一级任务 | 'status' 任务状态
  // 任务层级筛选按视图差异化：看板锁定执行层级；日历仅可选 1级任务/执行层级（默认执行层级）；甘特/表格为完整选项
  function effLevelFor(tabKey){
    if(tabKey==='kanban') return 'leaf';
    if(tabKey==='calendar') return currentLevel==='1' ? '1' : 'leaf';
    return currentLevel;
  }
  function updateLevelFilterUI(){
    var item=document.getElementById('level-filter-item');
    if(!item)return;
    var tab=document.querySelector('.project-tab.active');
    var key=tab?tab.dataset.tab:'gantt';
    var trigger=item.querySelector('.gantt-filter-trigger');
    var trg=trigger?trigger.querySelector('.gantt-filter-value'):null;
    var dd=item.querySelector('.filter-dd');
    var locked=(key==='kanban');
    if(trigger){
      trigger.classList.toggle('is-locked',locked);
      trigger.style.cursor=locked?'default':'';
      trigger.style.opacity=locked?'0.75':'';
      trigger.title=locked?'看板视图固定显示执行层级任务':'';
    }
    var eff=effLevelFor(key);
    var label='';
    if(dd){
      dd.querySelectorAll('.gantt-filter-option[data-value]').forEach(function(o){
        var v=o.getAttribute('data-value');
        // 日历视图只显示 1级任务/执行层级 两个选项，其余隐藏
        var visible=(key==='calendar')?(v==='1'||v==='leaf'):true;
        o.style.display=visible?'':'none';
        var on=String(v)===String(eff);
        o.classList.toggle('selected',on);
        var ex=o.querySelector('svg');if(ex)ex.remove();
        if(on){o.insertAdjacentHTML('beforeend',CHECK_SVG);var sp=o.querySelector('span');if(sp)label=sp.textContent;}
      });
    }
    if(key==='kanban') label='执行层级';
    if(trg&&label)trg.textContent=label;
  }
  updateLevelFilterUI();
  // 表格视图：资源需求列展开子行的任务 id 集合
  var expandedTableTasks={};
  // 表格视图折叠状态：taskId -> 1（折叠后隐藏其全部子孙行，父行自身保持可见）
  var collapsedTableTasks={};

  var ROW_HEIGHT=36;
  var currentGran='day';
  function rebuildArrows(){
    var svg=document.getElementById('gantt-dep-svg-'+currentGran);
    if(!svg)return;
    var lineData;
    try{lineData=JSON.parse(svg.dataset.lines||'[]')}catch(e){lineData=[]}
    var totalRows=parseInt(svg.dataset.totalRows||'0');
    if(!lineData.length){svg.innerHTML='';return}
    var frozenContainer=document.querySelector('#tab-gantt .gantt-frozen-column');
    if(!frozenContainer)return;
    var frozenRows=frozenContainer.querySelectorAll('.gantt-task-info');
    var origToVis={};
    var visIdx=0;
    frozenRows.forEach(function(fr){
      var origIdx=parseInt(fr.dataset.idx);
      if(fr.style.visibility!=='hidden'){
        origToVis[origIdx]=visIdx;
        visIdx++;
      }
    });
    var visCount=visIdx;
    svg.style.height=(visCount*ROW_HEIGHT)+'px';
    var predGroups={},succGroups={};
    lineData.forEach(function(l,i){
      if(origToVis[l.predRowIdx]==null||origToVis[l.succRowIdx]==null)return;
      if(!predGroups[l.predId])predGroups[l.predId]=[];
      predGroups[l.predId].push(i);
      if(!succGroups[l.succId])succGroups[l.succId]=[];
      succGroups[l.succId].push(i);
    });
    var html='';
    lineData.forEach(function(l,idx){
      var vp=origToVis[l.predRowIdx];
      var vs=origToVis[l.succRowIdx];
      if(vp==null||vs==null)return;
      var predY=l.isMilestonePred?vp*ROW_HEIGHT+25:vp*ROW_HEIGHT+18;
      var succY=l.isBackward?vs*ROW_HEIGHT+ROW_HEIGHT-8:vs*ROW_HEIGHT+8;
      var SHIFT=6;
      var landingX=Math.max(l.succStartX+SHIFT,l.predEndX);
      var size=7,halfW=3.5;
      var pGroupSize=(predGroups[l.predId]||[]).length;
      var pIdx=(predGroups[l.predId]||[]).indexOf(idx);
      var pSegXOffset=pGroupSize>1?(pIdx-(pGroupSize-1)/2)*5:0;
      var sGroupSize=(succGroups[l.succId]||[]).length;
      var sIdx=(succGroups[l.succId]||[]).indexOf(idx);
      var sSegXOffset=sGroupSize>1?(sIdx-(sGroupSize-1)/2)*5:0;
      var segX=landingX+pSegXOffset+sSegXOffset;
      var arrowDown=!l.isBackward;
      var arrowPoints=arrowDown
        ?segX+','+succY+' '+(segX+halfW)+','+(succY-size)+' '+(segX-halfW)+','+(succY-size)
        :segX+','+succY+' '+(segX+halfW)+','+(succY+size)+' '+(segX-halfW)+','+(succY+size);
      var isStraight=Math.abs(l.predEndX-segX)<2;
      var d=isStraight
        ?'M '+l.predEndX+' '+predY+' L '+l.predEndX+' '+succY
        :'M '+l.predEndX+' '+predY+' L '+segX+' '+predY+' L '+segX+' '+succY;
      var stroke=l.isCritical?'#8B5CF6':'#94A3B8';
      var dash=l.isCritical?'none':'4,3';
      var sw=1;
      html+='<g><path d="'+d+'" stroke="'+stroke+'" stroke-width="'+sw+'" stroke-dasharray="'+dash+'" fill="none"/><polygon points="'+arrowPoints+'" fill="'+stroke+'"/></g>';
    });
    svg.innerHTML=html;
  }

  var HIDE_STYLE='visibility:hidden;height:0 !important;min-height:0 !important;padding:0 !important;border:0 !important;overflow:hidden';
  var origStyles=new Map();
  function SHOW_STYLE(el){
    // 对从未隐藏过的元素，保留其当前内联样式（例如 gantt-task-info 的 padding-left）。
    // 若 origStyles 中无记录，直接返回 '' 会清空初始 style，导致清除筛选后缩进丢失。
    return origStyles.has(el)?origStyles.get(el):(el.getAttribute('style')||'');
  }
  // 行成员标识 mk 与选中成员 currentMembers 的匹配（与项目主页 Gantt 的 memberMatchLeaf 完全一致）：
  //  - 选「人」(uid 存在)：按 member_ulid 命中，或按 name+role 精确命中（role|name 令牌拆出 role/name 比对）
  //  - 选「角色」项(uid 为空，如资源里出现的 角色|姓名)：按令牌精确命中（role 分配的任务）
  // 注意：不再做「role 单独命中」，否则选某角色的人会把所有同角色任务都算进来（6.2 误显即是此因）。
  function rowHasMember(mk){
    if(!currentMembers.length) return true;
    for(var i=0;i<currentMembers.length;i++){
      var m=currentMembers[i];
      for(var j=0;j<mk.length;j++){
        var k=mk[j];
        if(!k) continue;
        if(m.uid){
          if(k===m.uid) return true;
          var parts=k.split('|');
          if(parts.length>=2 && parts[0]===m.role && parts[1]===m.name) return true;
        } else if(k===m.raw){
          return true;
        }
      }
    }
    return false;
  }
  // 计算树形行的可见性：摘要行仅在「层级合适」且「存在匹配的叶子后代」时显示，
  // 避免筛选成员/时间后，一级摘要任务仍全部显示。
  // acc: { level(row), levelOk(row), isSummary(row), dateOk(row), memberOk(row) }
  function computeDescendantVisibility(rows, acc){
    var n=rows.length;
    var levels=new Array(n), isSum=new Array(n);
    for(var i=0;i<n;i++){ levels[i]=acc.level(rows[i]); isSum[i]=acc.isSummary(rows[i]); }
    var childMap={}, pstack=[];
    for(var i=0;i<n;i++){
      while(pstack.length && levels[i]<=levels[pstack[pstack.length-1]]) pstack.pop();
      if(pstack.length){ var pp=pstack[pstack.length-1]; (childMap[pp]=childMap[pp]||[]).push(i); }
      pstack.push(i);
    }
    var leafOk=new Array(n), hasDesc=new Array(n).fill(false);
    for(var i=0;i<n;i++){ leafOk[i]=!isSum[i] && acc.dateOk(rows[i]) && acc.memberOk(rows[i]) && acc.statusOk(rows[i]); }
    var visited=new Array(n).fill(false);
    function dfs(i){
      if(visited[i]) return hasDesc[i];
      visited[i]=true;
      if(!isSum[i]){ hasDesc[i]=leafOk[i]; return hasDesc[i]; }
      var any=false, kids=childMap[i]||[];
      for(var k=0;k<kids.length;k++){ if(dfs(kids[k])) any=true; }
      hasDesc[i]=any; return any;
    }
    for(var i=0;i<n;i++) dfs(i);
    var show=new Array(n);
    for(var i=0;i<n;i++){
      if(isSum[i]) show[i]=acc.levelOk(rows[i]) && hasDesc[i];
      else show[i]=leafOk[i];
    }
    return show;
  }
  // 看板卡片可见性（成员/状态/时间范围筛选；锁定执行层级，任务层级不参与）
  function applyKanbanFilters(){
    var cards=document.querySelectorAll('#tab-kanban .kanban-card');
    cards.forEach(function(card){
      var match=true;
      if(currentMembers.length>0){
        var mk=(card.dataset.members||'').split(',').filter(Boolean);
        if(!rowHasMember(mk))match=false;
      }
      if(match&&currentStatus!=='all'&&(card.dataset.status||'')!==currentStatus)match=false;
      if(match&&currentDateRange){
        var rs=card.dataset.start,re=card.dataset.end;
        if(!rs&&!re)match=false;
        else{
          if(currentDateRange.end&&re&&re<currentDateRange.start)match=false;
          if(currentDateRange.start&&rs&&rs>currentDateRange.end)match=false;
        }
      }
      if(match){card.style.cssText=SHOW_STYLE(card)}else{if(!origStyles.has(card))origStyles.set(card,card.getAttribute('style')||'');card.style.cssText=HIDE_STYLE}
    });
  }
  // 看板分组切换（一级任务 / 任务状态）：按 data-parent-group / data-status 客户端重排列
  function regroupKanban(){
    var board=document.querySelector('#tab-kanban .kanban-board');
    if(!board)return;
    var cards=Array.prototype.slice.call(board.querySelectorAll('.kanban-card'));
    var by={};
    cards.forEach(function(card){
      var g = currentGroupBy==='status' ? (card.dataset.status||'not_started') : (card.dataset.parentGroup||'未分组');
      if(!by[g])by[g]=[];
      by[g].push(card);
    });
    var buckets=[];
    if(currentGroupBy==='status'){
      // 固定顺序：未开始 → 已延误 → 进行中 → 已完成（从左到右）
      var statusOrder=['not_started','delayed','in_progress','completed'];
      var statusLabels={not_started:'未开始',delayed:'已延误',in_progress:'进行中',completed:'已完成'};
      statusOrder.forEach(function(k){ if(by[k])buckets.push({label:statusLabels[k]||k,items:by[k]}); });
      Object.keys(by).forEach(function(k){ if(statusOrder.indexOf(k)<0)buckets.push({label:statusLabels[k]||k,items:by[k]}); });
    } else {
      Object.keys(by).forEach(function(k){ buckets.push({label:k,items:by[k]}); });
    }
    board.innerHTML='';
    buckets.forEach(function(b){
      var col=document.createElement('div'); col.className='kanban-column';
      var header=document.createElement('div'); header.className='kanban-column-header';
      var hl=document.createElement('div'); hl.className='kanban-column-header-left';
      var title=document.createElement('span'); title.className='kanban-column-title'; title.textContent=b.label;
      var cnt=document.createElement('span'); cnt.className='kanban-column-count'; cnt.textContent=b.items.length;
      hl.appendChild(title); hl.appendChild(cnt); header.appendChild(hl);
      var body=document.createElement('div'); body.className='kanban-column-body';
      b.items.forEach(function(c){ body.appendChild(c); });
      col.appendChild(header); col.appendChild(body);
      board.appendChild(col);
    });
    applyKanbanFilters();
  }
  function applyFilters(){
    var activeTab=document.querySelector('.project-tab.active');
    var tabKey=activeTab?activeTab.dataset.tab:'gantt';
    if(tabKey==='gantt'){
      var frozenContainer=document.querySelector('#tab-gantt .gantt-frozen-column');
      var barContainer=document.querySelector('#tab-gantt .gantt-scroll-area');
      if(!frozenContainer){return;}
      var frozenRows=Array.prototype.slice.call(frozenContainer.querySelectorAll('.gantt-task-info'));
      var barRows=barContainer?barContainer.querySelectorAll('.gantt-row'):[];
      var show=computeDescendantVisibility(frozenRows,{
        level:function(fr){return parseInt(fr.dataset.level);},
        levelOk:function(fr){
          if(currentLevel==='all') return true;
          var lv=parseInt(fr.dataset.level);
          if(currentLevel==='leaf') return false; // 摘要不是叶子
          return lv<=parseInt(currentLevel);
        },
        isSummary:function(fr){return fr.querySelector('.collapse-btn')!=null;},
        dateOk:function(fr){
          if(!currentDateRange) return true;
          var rs=fr.dataset.start,re=fr.dataset.end;
          if(!rs&&!re) return false;
          if(currentDateRange.end&&re&&re<currentDateRange.start) return false;
          if(currentDateRange.start&&rs&&rs>currentDateRange.end) return false;
          return true;
        },
        memberOk:function(fr){
          if(currentMembers.length===0) return true;
          var mk=(fr.dataset.members||'').split(',').filter(Boolean);
          return rowHasMember(mk);
        },
        statusOk:function(fr){
          if(currentStatus==='all') return true;
          return (fr.dataset.status||'')===currentStatus;
        }
      });
      var hiddenIdxs=new Set();
      for(var i=0;i<frozenRows.length;i++){
        var fr=frozenRows[i], idx=parseInt(fr.dataset.idx);
        if(show[i]){
          fr.style.cssText=SHOW_STYLE(fr);
          var br=barRows[idx];
          if(br)br.style.cssText=SHOW_STYLE(br);
        }else{
          if(!origStyles.has(fr))origStyles.set(fr,fr.getAttribute('style')||'');
          fr.style.cssText=HIDE_STYLE;
          var br=barRows[idx];
          if(br){
            if(!origStyles.has(br))origStyles.set(br,br.getAttribute('style')||'');
            br.style.cssText=HIDE_STYLE;
          }
          hiddenIdxs.add(idx);
        }
      }
      rebuildArrows();
    }
    if(tabKey==='table'){
      var rows=Array.prototype.slice.call(document.querySelectorAll('#tab-table .wbs-row'));
      var show=computeDescendantVisibility(rows,{
        level:function(tr){return parseInt(tr.dataset.level);},
        levelOk:function(tr){
          if(currentLevel==='all') return true;
          var lv=parseInt(tr.dataset.level);
          if(currentLevel==='leaf') return tr.dataset.leaf==='true';
          return lv+1<=parseInt(currentLevel);
        },
        isSummary:function(tr){return tr.dataset.leaf!=='true';},
        dateOk:function(tr){
          if(!currentDateRange) return true;
          var rs=tr.dataset.start,re=tr.dataset.end;
          if(!rs&&!re) return false;
          if(currentDateRange.end&&re&&re<currentDateRange.start) return false;
          if(currentDateRange.start&&rs&&rs>currentDateRange.end) return false;
          return true;
        },
        memberOk:function(tr){
          if(currentMembers.length===0) return true;
          var mk=(tr.dataset.members||'').split(',').filter(Boolean);
          return rowHasMember(mk);
        },
        statusOk:function(tr){
          if(currentStatus==='all') return true;
          return (tr.dataset.status||'')===currentStatus;
        }
      });
      // 任务折叠：任一祖先行被折叠时隐藏该行（折叠的父行自身保持可见）；与筛选条件叠加生效
      var cstack=[];
      for(var ci=0;ci<rows.length;ci++){
        var clv=parseInt(rows[ci].dataset.level);
        while(cstack.length&&cstack[cstack.length-1].lv>=clv)cstack.pop();
        var ancC=cstack.some(function(e){return e.c});
        if(ancC)show[ci]=false;
        var isSumC=rows[ci].dataset.leaf!=='true';
        cstack.push({lv:clv,c:ancC||(isSumC&&!!collapsedTableTasks[rows[ci].dataset.taskId])});
      }
      for(var i=0;i<rows.length;i++){
        var tr=rows[i];
        if(show[i]){
          tr.style.cssText=SHOW_STYLE(tr);
          tr.removeAttribute('data-hidden');
        }else{
          if(!origStyles.has(tr))origStyles.set(tr,tr.getAttribute('style')||'');
          // 表格行必须用 display:none——HIDE_STYLE 的 visibility:hidden+height:0 对 <tr> 无效（行高仍被内容撑开，显示为空行）
          tr.style.cssText='display:none';
          tr.setAttribute('data-hidden','1');
        }
      }
      // 同步资源需求展开子行：父行被筛选隐藏或未展开时保持隐藏
      syncTableExpandedRows();
    }

  if(tabKey==='kanban'){
    applyKanbanFilters();
  }
  if(tabKey==='calendar'){
    var chips=document.querySelectorAll('#tab-calendar .calendar-task-chip');
    chips.forEach(function(chip){
      var match=true;
      if(currentMembers.length>0){
        var mk=(chip.dataset.members||'').split(',').filter(Boolean);
        if(!rowHasMember(mk))match=false;
      }
      if(match&&currentStatus!=='all'&&(chip.dataset.status||'')!==currentStatus)match=false;
      if(match&&currentDateRange){
        var rs=chip.dataset.start,re=chip.dataset.end;
        if(!rs&&!re)match=false;
        else{
          if(currentDateRange.end&&re&&re<currentDateRange.start)match=false;
          if(currentDateRange.start&&rs&&rs>currentDateRange.end)match=false;
        }
      }
      // 任务层级过滤：'执行层级'显示全部叶子条（隐藏一级汇总条）；'1级任务'只显示一级任务条（含一级汇总条）
      if(match){
        var eff=effLevelFor(tabKey);
        if(eff==='1'){ if(!(parseInt(chip.dataset.level||'0')+1<=1))match=false; }
        else if(chip.classList.contains('calendar-level1-summary'))match=false;
      }
      if(match){
        var ss=SHOW_STYLE(chip);
        // 一级汇总条默认被 CSS 隐藏，显示时需内联 display:block 覆盖
        if(chip.classList.contains('calendar-level1-summary'))ss+=';display:block';
        chip.style.cssText=ss;
      }else{if(!origStyles.has(chip))origStyles.set(chip,chip.getAttribute('style')||'');chip.style.cssText=HIDE_STYLE}
    });
  }
  }

  // 筛选条件跨视图同步：把某一次选择（label/value）同步到四个视图的同款筛选下拉与触发器文案
  function syncFilterOptions(attr, value, label){
    document.querySelectorAll('.gantt-filter-item').forEach(function(item){
      var dd=item.querySelector('.gantt-filter-dropdown.filter-dd');
      if(!dd)return;
      var opts=dd.querySelectorAll('.gantt-filter-option['+attr+']');
      if(!opts.length)return;
      var trg=item.querySelector('.gantt-filter-trigger .gantt-filter-value');
      if(trg)trg.textContent=label;
      opts.forEach(function(o){
        var on=o.getAttribute(attr)===value;
        o.classList.toggle('selected',on);
        var ex=o.querySelector('svg');if(ex)ex.remove();
        if(on)o.insertAdjacentHTML('beforeend',CHECK_SVG);
      });
    });
  }

  document.querySelectorAll('.gantt-filter-option').forEach(function(opt){
    opt.addEventListener('click',function(e){
      e.stopPropagation();
      var dd=this.closest('.gantt-filter-dropdown');
      if(!dd)return;
      // 任务状态筛选选项（data-status-value）：与层级筛选（data-value）分开处理
      var statusValue=this.dataset.statusValue;
      if(statusValue!=null&&statusValue!==undefined&&statusValue!==''){
        currentStatus=statusValue;
        syncFilterOptions('data-status-value',statusValue,this.querySelector('span').textContent);
        dd.style.display='none';
        applyFilters();
        return;
      }
      var groupValue=this.dataset.groupValue;
      if(groupValue!=null&&groupValue!==undefined&&groupValue!==''){
        currentGroupBy=groupValue;
        syncFilterOptions('data-group-value',groupValue,this.querySelector('span').textContent);
        dd.style.display='none';
        regroupKanban();
        return;
      }
      var value=this.dataset.value;
      currentLevel=value;
      syncFilterOptions('data-value',value,this.querySelector('span').textContent);
      dd.style.display='none';
      applyFilters();
    });
  });

  var MEMBER_CHECK_SVG='<svg class="custom-select-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  function syncMemberCheckmarks(dd){
    dd.querySelectorAll('.custom-select-option[data-member-value]').forEach(function(opt){
      var existing=opt.querySelector('.custom-select-check');
      if(opt.classList.contains('is-selected')){if(!existing)opt.insertAdjacentHTML('beforeend',MEMBER_CHECK_SVG)}
      else{if(existing)existing.remove()}
    });
    var allOpt=dd.querySelector('.member-multi-all');
    if(allOpt){
      var existingAll=allOpt.querySelector('.custom-select-check');
      if(allOpt.classList.contains('is-selected')){if(!existingAll)allOpt.insertAdjacentHTML('beforeend',MEMBER_CHECK_SVG)}
      else{if(existingAll)existingAll.remove()}
    }
  }

  function syncAllMemberDropdowns(){
    document.querySelectorAll('.member-multi-dropdown').forEach(function(dd){
      var allOpt=dd.querySelector('.member-multi-all');
      dd.querySelectorAll('.custom-select-option[data-member-value]').forEach(function(opt){
        if(currentMembers.some(function(m){return m.raw===opt.dataset.memberValue}))opt.classList.add('is-selected');else opt.classList.remove('is-selected');
      });
      if(allOpt){if(currentMembers.length===0)allOpt.classList.add('is-selected');else allOpt.classList.remove('is-selected')}
      syncMemberCheckmarks(dd);
      updateMemberTrigger(dd);
    });
  }
  document.querySelectorAll('.member-multi-all').forEach(function(el){
    el.addEventListener('click',function(e){
      e.stopPropagation();
      var dd=this.closest('.member-multi-dropdown');
      if(!dd)return;
      var isCurrentlySelected=this.classList.contains('is-selected');
      dd.querySelectorAll('.custom-select-option[data-member-value]').forEach(function(o){o.classList.remove('is-selected')});
      if(isCurrentlySelected){
        this.classList.remove('is-selected');
      }else{
        this.classList.add('is-selected');
      }
      currentMembers=[];
      syncAllMemberDropdowns();
      applyFilters();
    });
  });
  document.querySelectorAll('.custom-select-option[data-member-value]').forEach(function(opt){
    opt.addEventListener('click',function(e){
      e.stopPropagation();
      var dd=this.closest('.member-multi-dropdown');
      if(!dd)return;
      this.classList.toggle('is-selected');
      var allOpt=dd.querySelector('.member-multi-all');
      var selected=dd.querySelectorAll('.custom-select-option[data-member-value].is-selected');
      var total=dd.querySelectorAll('.custom-select-option[data-member-value]').length;
      if(allOpt){
        if(selected.length===0){allOpt.classList.add('is-selected')}else{allOpt.classList.remove('is-selected')}
      }
      currentMembers=[];
      selected.forEach(function(s){currentMembers.push({uid:s.dataset.memberUid||'', role:s.dataset.memberRole||'', name:s.dataset.memberName||'', raw:s.dataset.memberValue})});
      syncAllMemberDropdowns();
      applyFilters();
    });
  });
  function updateMemberTrigger(dd){
    var item=dd.closest('.gantt-filter-item');
    if(!item)return;
    var tagsEl=item.querySelector('.member-multi-select-tags');
    if(!tagsEl)return;
    var selected=dd.querySelectorAll('.custom-select-option[data-member-value].is-selected');
    if(selected.length===0){
      tagsEl.innerHTML='<span class="member-multi-select-placeholder">全部成员</span>';
    }else{
      var html='';
      var show=Math.min(selected.length,2);
      for(var i=0;i<show;i++){
        var s=selected[i];
        var txt=s.querySelector('.custom-select-option-text').textContent;
        var avatar=s.querySelector('.custom-select-avatar');
        var avatarCls=avatar?(avatar.classList.contains('empty')?'avatar empty-avatar':'avatar'):'avatar';
        var avatarTxt=avatar?avatar.textContent:'?';
        html+='<div class="resource-item member-multi-tag-item"><span class="'+avatarCls+'">'+avatarTxt+'</span><span class="resource-name">'+txt+'</span></div>';
      }
      if(selected.length>2) html+='<span class="member-multi-overflow">+'+(selected.length-2)+'</span>';
      tagsEl.innerHTML=html;
    }
  }

  document.querySelectorAll('.custom-select-search').forEach(function(input){
    input.addEventListener('input',function(e){
      e.stopPropagation();
      var dd=this.closest('.member-multi-dropdown');
      if(!dd)return;
      var term=this.value.toLowerCase();
      dd.querySelectorAll('.custom-select-option[data-member-value]').forEach(function(opt){
        var txt=(opt.querySelector('.custom-select-option-text').textContent||'').toLowerCase();
        opt.style.display=(!term||txt.indexOf(term)>=0)?'':'none';
      });
    });
  });

  document.querySelectorAll('.member-multi-select-trigger').forEach(function(trigger){
    trigger.addEventListener('click',function(e){
      e.stopPropagation();
      var item=this.closest('.gantt-filter-item');
      if(!item)return;
      var dd=item.querySelector('.member-multi-dropdown');
      if(!dd)return;
      var wasOpen=dd.style.display==='block';
      closeAllDropdowns();
      if(!wasOpen) dd.style.display='block';
    });
  });
  // 甘特图单元格悬停：高亮整行 + 整列（与项目主页鼠标悬停交叉高亮一致）
  function clearGanttHover(){
    document.querySelectorAll('#tab-gantt .hovered-col,#tab-gantt .hovered-row,#tab-gantt .hovered,#tab-gantt .bar-hovered').forEach(function(el){
      el.classList.remove('hovered-col','hovered-row','hovered','bar-hovered');
    });
  }
  document.querySelectorAll('#tab-gantt .gantt-cell').forEach(function(cell){
    cell.addEventListener('mouseenter',function(){
      clearGanttHover();
      var body=cell.closest('.gantt-body');
      if(!body)return;
      var gran=body.dataset.gran;
      var row=cell.closest('.gantt-row');
      if(!row)return;
      var rowIdx=row.dataset.idx;
      var col=cell.dataset.col;
      // 整行高亮：主体行 + 左侧冻结列任务信息
      row.classList.add('hovered');
      row.querySelectorAll('.gantt-cell').forEach(function(c){c.classList.add('hovered-row')});
      var frozen=document.querySelector('#tab-gantt .gantt-task-info[data-idx="'+rowIdx+'"]');
      if(frozen) frozen.classList.add('hovered');
      // 整列高亮：主体内同 data-col 的所有单元格
      if(col!=null){
        body.querySelectorAll('.gantt-cell[data-col="'+col+'"]').forEach(function(c){c.classList.add('hovered-col')});
        // 表头对应粒度列高亮
        var hr=document.querySelector('#tab-gantt .gantt-header-right[data-gran="'+gran+'"]');
        if(hr){ hr.querySelectorAll('[data-col="'+col+'"]').forEach(function(h){h.classList.add('hovered-col')}); }
      }
      // 交叉点（行 + 列）
      cell.classList.add('hovered-col','hovered-row');
    });
    cell.addEventListener('mouseleave',function(){
      clearGanttHover();
    });
  });
  // 任务条悬停：与项目主页 handleBarMouseEnter 一致 —— 整行高亮 + 条覆盖列【整列（跨所有行）】高亮
  // 主页 hoveredBarSegments 对所有行单元格生效（inBarCols 不依赖 hoveredRow），条占用的每一列在所有行都有 hovered-col
  function highlightBarRange(bar){
    clearGanttHover();
    var body=bar.closest('.gantt-body');
    var row=bar.closest('.gantt-row');
    if(!body||!row)return;
    var gran=body.dataset.gran;
    var rowIdx=row.dataset.idx;
    var bl=parseFloat(bar.style.left)||0;
    var bw=parseFloat(bar.style.width)||bar.offsetWidth||14;
    // 整行高亮：主体行 + 左侧冻结列任务信息
    row.classList.add('hovered');
    row.querySelectorAll('.gantt-cell').forEach(function(c){c.classList.add('hovered-row')});
    var frozen=document.querySelector('#tab-gantt .gantt-task-info[data-idx="'+rowIdx+'"]');
    if(frozen) frozen.classList.add('hovered');
    // 条覆盖列整列高亮：条水平范围重叠的 data-col（周/月粒度一天一格映射），
    // 对 body 内所有行同 data-col 单元格 + 表头同列元素加 hovered-col
    var cols=[];
    var x=0;
    row.querySelectorAll('.gantt-cell').forEach(function(c){
      var w=parseFloat(c.style.width)||0;
      if(x < bl+bw && x+w > bl){
        var col=c.dataset.col;
        if(cols.indexOf(col)<0) cols.push(col);
      }
      x+=w;
    });
    var hr=document.querySelector('#tab-gantt .gantt-header-right[data-gran="'+gran+'"]');
    cols.forEach(function(col){
      body.querySelectorAll('.gantt-cell[data-col="'+col+'"]').forEach(function(c){c.classList.add('hovered-col')});
      if(hr){ hr.querySelectorAll('[data-col="'+col+'"]').forEach(function(h){h.classList.add('hovered-col')}); }
    });
    // 表头：与 bar 水平范围重叠的日期列加 bar-hovered（含月历覆盖层）
    if(hr){
      var hAcc=0;
      hr.querySelectorAll('.gantt-day,.gantt-hour-day,.gantt-week,.gantt-month').forEach(function(h){
        var w=parseFloat(h.style.width)||0;
        if(hAcc < bl+bw && hAcc+w > bl) h.classList.add('bar-hovered');
        hAcc+=w;
      });
      var ov=hr.querySelector('.gantt-months-overlay');
      if(ov){
        var oAcc=0;
        ov.querySelectorAll('.gantt-month-overlay-item').forEach(function(o){
          var w=parseFloat(o.style.width)||0;
          if(oAcc < bl+bw && oAcc+w > bl) o.classList.add('bar-hovered');
          oAcc+=w;
        });
      }
    }
  }
  document.querySelectorAll('#tab-gantt .gantt-task-bar, #tab-gantt .gantt-summary-bar, #tab-gantt .gantt-milestone-diamond').forEach(function(bar){
    bar.addEventListener('mouseenter',function(){ highlightBarRange(bar); });
    bar.addEventListener('mouseleave',function(){ clearGanttHover(); });
  });
  // 表格视图：资源需求列点击展开/收起子行（样式复用 WBS 分解页面 expanded-resource-row）
  // 注意：折叠必须用 display:none——HIDE_STYLE 的 visibility:hidden+height:0 对 <tr> 无效（行高仍被内容撑开，显示为空行）
  function syncTableExpandedRows(){
    var expRows=document.querySelectorAll('#tab-table .expanded-resource-row');
    expRows.forEach(function(er){
      var pTr=document.querySelector('#tab-table .wbs-row[data-task-id="'+er.dataset.parent+'"]');
      var parentVisible=pTr&&!pTr.hasAttribute('data-hidden');
      if(parentVisible&&expandedTableTasks[er.dataset.parent]){
        er.style.cssText='';
      }else{
        er.style.cssText='display:none';
      }
    });
  }
  document.querySelectorAll('#tab-table .wbs-row').forEach(function(tr){
    var taskId=tr.dataset.taskId;
    if(!taskId)return;
    var container=tr.querySelector('.resources-container');
    if(!container||container.classList.contains('milestone-disabled'))return;
    if(!container.querySelector('.resource-item'))return;
    container.addEventListener('click',function(e){
      e.stopPropagation();
      if(expandedTableTasks[taskId]){delete expandedTableTasks[taskId]}else{expandedTableTasks[taskId]=1}
      syncTableExpandedRows();
    });
  });
  // 表格视图：非叶子任务行名称前箭头 → 折叠/展开全部子孙行（与项目主页表格视图箭头图标同款；
  // 点击任务名称/行其余区域仍打开任务详情弹窗，箭头点击 stopPropagation 不触发弹窗）
  document.querySelectorAll('#tab-table .wbs-row .collapse-btn').forEach(function(btn){
    btn.addEventListener('click',function(e){
      e.stopPropagation();
      var tr=btn.closest('.wbs-row');if(!tr)return;
      var tid=tr.dataset.taskId;if(!tid)return;
      if(collapsedTableTasks[tid]){delete collapsedTableTasks[tid];btn.textContent='▼';btn.setAttribute('title','折叠')}
      else{collapsedTableTasks[tid]=1;btn.textContent='▶';btn.setAttribute('title','展开')}
      applyFilters();
    });
  });
  // 看板卡片/日历任务条点击 → 打开任务详情预览弹窗（对齐主页 TaskDetailPreview）
  function syncDetailNav(ov){
    // 弹窗统一放在全局容器 #task-detail-overlays；prev/next 序列 = 叶子任务弹窗顺序（与主页 navTasks 仅叶子一致）
    var list=Array.prototype.slice.call(document.querySelectorAll('#task-detail-overlays .task-detail-overlay[data-leaf="true"]'));
    var idx=list.indexOf(ov);
    var prev=idx>0?list[idx-1]:null, next=(idx>-1&&idx<list.length-1)?list[idx+1]:null;
    var pb=ov.querySelector('[data-task-nav="prev"]'), nb=ov.querySelector('[data-task-nav="next"]');
    if(pb)pb.disabled=!prev;
    if(nb)nb.disabled=!next;
  }
  function openDetailByTaskId(tid){
    if(!tid)return;
    var t=document.querySelector('#task-detail-overlays .task-detail-overlay[data-task-detail="'+tid+'"]');
    if(t) showDetail(t);
  }
  function showDetail(ov){ ov.style.display='flex'; syncDetailNav(ov); }
  document.querySelectorAll('#tab-kanban .kanban-card, #tab-gantt .gantt-task-bar, #tab-gantt .gantt-milestone-diamond, #tab-gantt .gantt-summary-bar').forEach(function(card){
    card.addEventListener('click',function(){
      openDetailByTaskId(card.getAttribute('data-task-id'));
    });
  });
  // 甘特图左侧任务名称列：点击任务名打开详情弹窗（仅叶子任务带 data-task-id，与主页口径一致）
  document.querySelectorAll('#tab-gantt .gantt-task-info .task-name[data-task-id]').forEach(function(nameEl){
    nameEl.addEventListener('click',function(e){
      e.stopPropagation();
      openDetailByTaskId(nameEl.getAttribute('data-task-id'));
    });
  });
  // 日历任务条为动态重渲染内容，点击绑定封装成函数（月份切换后重新绑定）
  function bindCalendarBarClicks(){
    document.querySelectorAll('#tab-calendar .calendar-task-bar, #tab-calendar .calendar-milestone-chip').forEach(function(card){
      if(card.dataset.calBound)return;
      card.dataset.calBound='1';
      card.addEventListener('click',function(){
        openDetailByTaskId(card.getAttribute('data-task-id'));
      });
    });
  }
  bindCalendarBarClicks();
  // 表格视图：点击任务行打开预览弹窗（资源展开子行已 stopPropagation）
  document.querySelectorAll('#tab-table .wbs-row[data-task-id]').forEach(function(tr){
    tr.addEventListener('click',function(){
      openDetailByTaskId(tr.getAttribute('data-task-id'));
    });
  });
  document.querySelectorAll('.task-detail-overlay').forEach(function(ov){
    ov.addEventListener('click',function(){ ov.style.display='none'; });
    var panel=ov.querySelector('.task-detail-panel');
    if(panel) panel.addEventListener('click',function(e){ e.stopPropagation(); });
    var closeBtn=ov.querySelector('.task-detail-close');
    if(closeBtn) closeBtn.addEventListener('click',function(){ ov.style.display='none'; });
    // 上一条/下一条：在全局叶子任务弹窗序列中切换
    ov.querySelectorAll('[data-task-nav]').forEach(function(btn){
      btn.addEventListener('click',function(e){
        e.stopPropagation();
        var list=Array.prototype.slice.call(document.querySelectorAll('#task-detail-overlays .task-detail-overlay[data-leaf="true"]'));
        var idx=list.indexOf(ov);
        var target=list[idx+(btn.getAttribute('data-task-nav')==='prev'?-1:1)];
        if(target){ ov.style.display='none'; showDetail(target); }
      });
    });
    // 返回上一级：打开父任务弹窗（全局容器中查找）
    var backBtn=ov.querySelector('.task-detail-back');
    if(backBtn&&backBtn.getAttribute('data-parent')){
      backBtn.addEventListener('click',function(e){
        e.stopPropagation();
        var t=document.querySelector('#task-detail-overlays .task-detail-overlay[data-task-detail="'+backBtn.getAttribute('data-parent')+'"]');
        if(t){ ov.style.display='none'; showDetail(t); }
      });
    }
    // 非叶子任务：点击子任务行 → 打开子任务弹窗
    ov.querySelectorAll('.task-detail-child[data-child-task-id]').forEach(function(ch){
      ch.addEventListener('click',function(e){
        e.stopPropagation();
        var t=document.querySelector('#task-detail-overlays .task-detail-overlay[data-task-detail="'+ch.getAttribute('data-child-task-id')+'"]');
        if(t){ ov.style.display='none'; showDetail(t); }
      });
    });
  });
  rebuildArrows();

  // ===== 日历视图：月份切换（客户端重渲染，与导出端 renderCalendarTab 逻辑一致）=====
  var CAL = window.__CAL || null;
  // 执行状态图标（构建期由 statusDotSvg 渲染注入，浏览器端无法访问模块函数）：日历任务条右侧用
  var STATUS_DOTS = ${JSON.stringify({
    completed: statusDotSvg('completed', 12, 'margin-left:auto;flex-shrink:0;position:relative;z-index:1'),
    delayed: statusDotSvg('delayed', 12, 'margin-left:auto;flex-shrink:0;position:relative;z-index:1')
  })};
  var calY = null, calM = null;
  function calEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
  function calIsNonWorkDay(key){
    if(!CAL.skipHolidays)return false;
    if(CAL.makeup.indexOf(key)>=0)return false;
    if(CAL.holidays.indexOf(key)>=0)return true;
    var p=key.split('-');var d=new Date(+p[0],+p[1]-1,+p[2]);
    return d.getDay()===0||d.getDay()===6;
  }
  function renderCalendarMonth(){
    if(!CAL||calY===null)return;
    var y=calY,m=calM;
    function pad(n){return n<10?'0'+n:''+n}
    var fd=new Date(y,m,1).getDay(),dim=new Date(y,m+1,0).getDate();
    var cells=[];for(var i=0;i<fd;i++)cells.push(null);for(var d=1;d<=dim;d++)cells.push(d);
    var weeks=[];for(var i=0;i<cells.length;i+=7)weeks.push(cells.slice(i,i+7));
    var keyOf=function(day){return y+'-'+pad(m+1)+'-'+pad(day)};
    var dowOf=function(key){var p=key.split('-');return new Date(+p[0],+p[1]-1,+p[2]).getDay()};
    var dayNum=function(key){var p=key.split('-');return Math.round(new Date(+p[0],+p[1]-1,+p[2]).getTime()/86400000)};
    var monthStartKey=keyOf(1),monthEndKey=keyOf(dim);
    var ranges=[],sumRanges=[];
    CAL.tasks.forEach(function(item){
      if(!item.sd)return;
      if(item.ed<monthStartKey||item.sd>monthEndKey)return;
      (item.t==='leaf'?ranges:sumRanges).push({t:item,sd:item.sd,ed:item.ed});
    });
    var nowD=new Date();
    var tk=nowD.getFullYear()+'-'+pad(nowD.getMonth()+1)+'-'+pad(nowD.getDate());
    var dH=Math.max(1,CAL.dailyHours||8);
    // 泳道分配：按小数天单位（含起止小时占比）判断不重叠
    function buildSegs(rs,wStartKey,wEndKey){
      var arr=[];
      rs.forEach(function(r){
        var s=r.sd>wStartKey?r.sd:wStartKey,e=r.ed<wEndKey?r.ed:wEndKey;
        if(s>e)return;
        var rawSh=r.t.sh!=null?Number(r.t.sh)/dH:0;
        var rawEh=r.t.eh!=null?Number(r.t.eh)/dH:1;
        var isMs=r.t.ms===true;
        var shFrac=(isMs||s===r.sd)?Math.min(1,Math.max(0,rawSh)):0;
        var ehFrac=isMs?1:((e===r.ed)?Math.min(1,Math.max(0,rawEh)):1);
        arr.push({t:r.t,cs:dowOf(s),ce:dowOf(e),shFrac:shFrac,ehFrac:ehFrac});
      });
      arr.forEach(function(sg){sg.startUnit=sg.cs+sg.shFrac;sg.endUnit=sg.ce+sg.ehFrac});
      arr.sort(function(a,b){return a.startUnit-b.startUnit||(b.endUnit-b.startUnit)-(a.endUnit-a.startUnit)});
      var ends=[];
      arr.forEach(function(sg){
        var lane=-1;
        for(var i=0;i<ends.length;i++){if(ends[i]<=sg.startUnit+1e-6){lane=i;break}}
        if(lane===-1){ends.push(sg.endUnit);lane=ends.length-1}else{ends[lane]=sg.endUnit}
        sg.lane=lane;
      });
      return {segs:arr,laneCount:ends.length};
    }
    // 任务条拆段渲染：跳过节假日时节假日段截断，工作日段合并成条
    function buildBars(segsArr,laneOffset,extraCls,week){
      var html='';
      segsArr.forEach(function(sg){
        var task=sg.t;
        var fl=parseInt((task.code||'').split('.')[0],10)||1;
        var tc=CAL.colors[(fl-1)%CAL.colors.length];
        // 进度填充按任务绝对时间轴换算：跨周拆段时每段只填各自实际完成的部分
        var tStartAbs=null,filledAbs=null;
        if(task.pg>0){
          var rawSh=task.sh!=null?Number(task.sh)/dH:0;
          var rawEh=task.eh!=null?Number(task.eh)/dH:1;
          tStartAbs=dayNum(task.sd)+rawSh;
          var tEndAbs=dayNum(task.ed)+rawEh;
          filledAbs=tStartAbs+(tEndAbs-tStartAbs)*task.pg/100;
        }
        var runs=[];
        for(var d=sg.cs;d<=sg.ce;d++){
          var s0=Math.max(d,sg.startUnit),e0=Math.min(d+1,sg.endUnit);
          if(e0<=s0)continue;
          if(week[d]!=null&&task.ms!==true&&calIsNonWorkDay(keyOf(week[d])))continue;
          var last=runs[runs.length-1];
          if(last&&last.end===s0){last.end=e0}else{runs.push({start:s0,end:e0})}
        }
        runs.forEach(function(run,ri){
          if(task.ms===true){
            var msDayFrac=run.start-Math.floor(run.start);
            var msLeft='left:calc('+run.start+' * 100% / 7 + 1px)';
            var msTop='top:'+(24+(laneOffset+sg.lane)*20)+'px';
            var msMaxW='max-width:calc('+((1-msDayFrac)*100)+'% / 7 - 4px)';
            var msStLabel=CAL.statusLabels[task.st]||'';
            var msTip=calEsc(task.code+' '+task.name+' · 里程碑'+(msStLabel?' · 任务状态：'+msStLabel:''));
            html+='<div class="calendar-task-chip calendar-milestone-chip" data-task-id="'+calEsc(task.id)+'" data-level="'+task.level+'" data-status="'+(task.st||'')+'" data-members="'+calEsc(task.mk)+'" data-start="'+(task.sd||'')+'" data-end="'+(task.ed||'')+'" style="'+msLeft+';'+msTop+';'+msMaxW+'" title="'+msTip+'"><svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position:relative;z-index:1"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><span class="task-code" style="font-size:10px;color:#b45309;position:relative;z-index:1">'+calEsc(task.code)+'</span><span class="calendar-task-name" style="color:#b45309;position:relative;z-index:1">'+calEsc(task.name)+'</span></div>';
            return;
          }
          var span=Math.max(run.end-run.start,0.12);
          var showText=ri===0;
          var left='left:calc('+run.start+' * 100% / 7 + 1px)';
          var width='width:calc('+span+' * 100% / 7 - 2px)';
          var top='top:'+(24+(laneOffset+sg.lane)*20)+'px';
          // 任务条颜色始终跟随甘特条主题色；状态通过名称文字样式 + 条右侧状态图标/比例体现
          var bg='background:'+tc.light+';border-left:3px solid '+tc.solid;
          var fill='';
          if(filledAbs!=null){
            var sF=Math.floor(run.start),eF=Math.min(Math.floor(run.end),6);
            var runStartAbs=dayNum(keyOf(week[sF]))+(run.start-sF);
            var runEndAbs=dayNum(keyOf(week[eF]))+(run.end-eF);
            var runLen=runEndAbs-runStartAbs;
            var fillPct=0;
            if(runLen>1e-9)fillPct=Math.max(0,Math.min(1,(Math.min(runEndAbs,filledAbs)-runStartAbs)/runLen))*100;
            else if(filledAbs>=runEndAbs)fillPct=100;
            if(fillPct>0)fill='<div style="position:absolute;left:0;top:0;bottom:0;width:'+fillPct+'%;background:'+tc.solid+'B3;border-radius:inherit;pointer-events:none;z-index:0" title="完成进度：'+task.pg+'%"></div>';
          }
          var stLabel=CAL.statusLabels[task.st]||'';
          var nameStyle=task.st==='completed'?'text-decoration:line-through;color:#94a3b8':task.st==='delayed'?'color:#DC2626':'color:#2d3748';
          var rightSlot=task.st==='completed'?STATUS_DOTS.completed:task.st==='delayed'?STATUS_DOTS.delayed:(task.st==='in_progress'?'<span style="margin-left:auto;font-size:10px;font-weight:600;color:#1D4ED8;position:relative;z-index:1;white-space:nowrap;flex-shrink:0">'+task.pg+'%</span>':'');
          var text=showText?'<span class="task-code" style="font-size:10px;color:'+tc.dash+';position:relative;z-index:1">'+calEsc(task.code)+'</span><span class="calendar-task-name" style="'+nameStyle+';position:relative;z-index:1">'+calEsc(task.name)+'</span>'+rightSlot:'';
          var tip=calEsc(task.code+' '+task.name+(stLabel?' · 任务状态：'+stLabel:'')+(task.pg>0?' · 完成进度：'+task.pg+'%':''));
          html+='<div class="calendar-task-chip calendar-task-bar'+extraCls+'" data-task-id="'+calEsc(task.id)+'" data-level="'+task.level+'" data-status="'+(task.st||'')+'" data-members="'+calEsc(task.mk)+'" data-start="'+(task.sd||'')+'" data-end="'+(task.ed||'')+'" style="'+left+';'+width+';'+top+';'+bg+'" title="'+tip+'">'+fill+text+'</div>';
        });
      });
      return html;
    }
    var gridHtml='';
    weeks.forEach(function(week){
      var realDays=week.filter(function(dd){return dd!==null});
      if(!realDays.length)return;
      var wStartKey=keyOf(realDays[0]),wEndKey=keyOf(realDays[realDays.length-1]);
      var leafR=buildSegs(ranges,wStartKey,wEndKey);
      var sumR=buildSegs(sumRanges,wStartKey,wEndKey);
      var rowMinH=Math.max(90,24+(leafR.laneCount+sumR.laneCount)*20+8);
      var dayCells=week.map(function(day){
        if(day===null)return '<div class="calendar-cell calendar-cell-empty"></div>';
        var dk=keyOf(day),isT=dk===tk,isH=CAL.skipHolidays&&calIsNonWorkDay(dk);
        return '<div class="calendar-cell'+(isT?' calendar-cell-today':'')+(isH?' calendar-cell-holiday':'')+'"><div class="calendar-cell-day'+(isT?' calendar-day-today':'')+'">'+day+'</div></div>';
      }).join('');
      var bars=buildBars(leafR.segs,0,'',week);
      var sumBars=buildBars(sumR.segs,leafR.laneCount,' calendar-level1-summary',week);
      gridHtml+='<div class="calendar-week-row" style="min-height:'+rowMinH+'px">'+dayCells+bars+sumBars+'</div>';
    });
    var wrap=document.getElementById('calendar-dynamic');
    if(wrap){
      var wk=['日','一','二','三','四','五','六'];
      wrap.innerHTML='<div class="calendar-container"><div class="calendar-header-row">'+wk.map(function(w){return '<div class="calendar-header-cell">'+w+'</div>'}).join('')+'</div><div class="calendar-grid">'+gridHtml+'</div></div>';
    }
    var label=document.getElementById('cal-nav-label');
    if(label)label.textContent=y+'年'+(m+1)+'月';
    bindCalendarBarClicks();
    origStyles.clear();
    applyFilters();
  }
  var calPrev=document.getElementById('cal-prev'),calNext=document.getElementById('cal-next'),calToday=document.getElementById('cal-today');
  if(CAL&&calPrev&&calNext&&calToday){
    var initD=new Date();calY=initD.getFullYear();calM=initD.getMonth();
    calPrev.addEventListener('click',function(e){e.stopPropagation();calM--;if(calM<0){calM=11;calY--}renderCalendarMonth()});
    calNext.addEventListener('click',function(e){e.stopPropagation();calM++;if(calM>11){calM=0;calY++}renderCalendarMonth()});
    calToday.addEventListener('click',function(e){e.stopPropagation();var n=new Date();calY=n.getFullYear();calM=n.getMonth();renderCalendarMonth()});
  }
})()
</script>
`

// 顶部统计条：成员人数 / 项目周期 / 总体进度 / 计划版本（与项目主页顶部导航第二行同口径同结构）
//  - 总体进度 = Σ(叶子工时 × 完成比例) / Σ(叶子工时)，已完成任务按 100% 计
//  - 成员按钮在行首，点击从左侧展开成员列表（与主页一致）；导出为静态文件，版本后不带修改/下载按钮
function buildProjectStatsBar(flatTasks, startDate, endDate, statusOf, progressOf, versionLabel, membersCount) {
  const leaves = (flatTasks || []).filter(t => !t.children || t.children.length === 0)
  const memberBtnHtml = '<div class="project-stat"><button id="team-toggle" class="icon-btn project-members-btn" title="查看成员列表">'
    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
    + '<span class="icon-btn-text">' + (membersCount != null ? membersCount + '人' : '—') + '</span></button></div>'
    + '<span class="project-stat-divider"></span>'
  if (!leaves.length) return '<div class="project-stats-bar">' + memberBtnHtml + '</div>'
  let totalHours = 0, doneHours = 0
  for (const t of leaves) {
    const st = statusOf(t)
    const h = Number(t.totalHours) || 0
    totalHours += h
    const p = st === 'completed' ? 100 : Math.min(100, Math.max(0, Number(progressOf(t)) || 0))
    doneHours += h * p / 100
  }
  const overall = totalHours > 0 ? Math.round(doneHours / totalHours * 100) : 0
  return '<div class="project-stats-bar">'
    + memberBtnHtml
    + '<div class="project-stat"><span class="project-stat-label">项目周期</span><span class="project-stat-value">' + esc(startDate || '—') + ' 至 ' + esc(endDate || '—') + '</span></div>'
    + '<span class="project-stat-divider"></span>'
    + '<div class="project-stat"><span class="project-stat-label">总体进度</span><span class="project-stat-progress"><span class="project-stat-track"><span class="project-stat-fill" style="width:' + overall + '%"></span></span><span class="project-stat-pct">' + overall + '%</span></span></div>'
    + '<span class="project-stat-divider"></span>'
    + '<div class="project-stat"><span class="project-stat-label">计划版本</span><b class="project-stat-version">' + esc(versionLabel || '草稿') + '</b></div>'
    + '<span class="project-stat-divider"></span>'
    + '<div class="project-stat"><a class="project-stat-tool" href="https://www.qianyupm.top" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:600;font-size:12px">千羽-轻量级在线项目排期工具 www.qianyupm.top</a></div>'
    + '</div>'
}

export function buildProjectHomeHtml({ projectName, tree, members, startDate, endDate, skipHolidays, dailyInputHours, execStatusMap, progressMap, versionLabel }) {
  const leaves = buildLeaves(tree || [], dailyInputHours || 8)
  const dih = Math.max(1, dailyInputHours || 8)
  // 与项目主页只读甘特图完全同口径：直接按已发布快照里保存的 start_date / end_date / start_hour / end_hour
  // 摆放进度条（computeReadOnlySchedule），不再用 computeSchedule 重算。
  // 重算会按依赖关系与工时把任务推离保存位置（且未带 dayAligned 等规则），
  // 导致导出 HTML 的任务条与项目主页显示不一致。
  const { scheduledTasks, dateRange } = computeReadOnlySchedule(leaves, startDate, dih)
  const scheduleMap = new Map()
  ;(scheduledTasks || []).forEach(t => scheduleMap.set(t.id, t))
  const allTreeRows = flattenScheduleRows(tree || [], scheduleMap)
  const displayRows = allTreeRows.filter(() => true)
  const { criticalEdgeKeys } = computeCriticalPath(leaves)
  const ganttPxPerDay = GANTT_CELL

  const flatTasks = buildFlatTasks(tree || [])
  // 执行状态/完成进度查找（与主页四视图同口径）：按 original_task_id 退化 task_ulid/id 查手动值
  const execMapAll = execStatusMap || new Map()
  const progMapAll = progressMap || new Map()
  const lookupMap = (map, node) => {
    const orig = node && node.original_task_id
    const ulid = node && (node.task_ulid != null ? node.task_ulid : node.id)
    if (orig != null && map.has(String(orig))) return map.get(String(orig))
    if (ulid != null && map.has(String(ulid))) return map.get(String(ulid))
    return null
  }
  const statusOf = (node) => resolveExecStatus(node, (n) => lookupMap(execMapAll, n) || null)
  const progressOf = (node) => resolveProgress(node, (n) => { const v = lookupMap(progMapAll, n); return v == null ? null : v })
  // 下拉选项 = 项目成员 ∪ 任务资源中出现过的成员标识，确保每行 data-members 都能被选中
  const memberOptions = collectMemberOptions(members, tree || [])
  const memberStats = buildMemberStats(tree || [])
  const ganttMaxDepth = computeGanttMaxDepth(tree || [])
  const ganttHtml = renderGanttTab(displayRows, dateRange, dailyInputHours || 8, criticalEdgeKeys, skipHolidays, memberOptions, ganttMaxDepth, statusOf, progressOf)
  const tableHtml = renderTableTab(flatTasks, tree || [], dailyInputHours || 8, memberOptions, ganttMaxDepth, statusOf)
  const kanbanHtml = renderKanbanTab(flatTasks, tree || [], memberOptions, ganttMaxDepth, dailyInputHours || 8, statusOf, progressOf)
  const calendarHtml = renderCalendarTab(flatTasks, tree || [], skipHolidays, memberOptions, dailyInputHours || 8, statusOf, progressOf)
  const memberListHtml = renderMembersSidebar(members, memberStats)
  // 日历客户端渲染数据：任务（叶子 + 一级汇总）静态字段 + 主题配色 + 节假日（月份切换时在浏览器重渲染）
  const calTasks = flatTasks.map(item => {
    const isLeaf = !item.children || item.children.length === 0
    if (!isLeaf && item.level !== 0) return null
    if (!item.start_date) return null
    return {
      t: isLeaf ? 'leaf' : 'sum',
      id: String(item.id != null ? item.id : item.task_ulid),
      code: item.code || '',
      name: item.name || '',
      level: item.level,
      sd: item.start_date,
      ed: item.end_date || item.start_date,
      sh: item.start_hour != null ? item.start_hour : null,
      eh: item.end_hour != null ? item.end_hour : null,
      st: statusOf(item) || '',
      ms: item.taskType === '里程碑',
      mk: (item.resources || []).map(r => memberKey(r)).filter(Boolean).join(','),
      pg: Math.min(100, progressOf(item) || 0)
    }
  }).filter(Boolean)
  const calData = {
    tasks: calTasks,
    colors: themeColors,
    statusLabels: Object.fromEntries(Object.entries(EXEC_STATUS).map(([k, v]) => [k, v.label])),
    holidays: HOLIDAY_DATES,
    makeup: MAKEUP_WORKDAY_DATES,
    skipHolidays: !!skipHolidays,
    dailyHours: dailyInputHours || 8
  }
  // 全局任务详情预览弹窗：为所有任务（含父任务）生成，各视图（甘特/表格/看板/日历）点击打开
  const seenPopup = new Set()
  const overlayHtml = flatTasks.map(item => {
    const tid = String(item.id != null ? item.id : item.task_ulid || '')
    if (!tid || seenPopup.has(tid)) return ''
    seenPopup.add(tid)
    return buildTaskDetailPopupHtml(item, tree || [], dailyInputHours || 8, execStatusMap, progressMap)
  }).join('')
  const name = esc(projectName || '项目'), mc = (members || []).length
  // 顶部导航条与项目主页同构同类名（content-header / header-title-project / header-title-block / header-title-row），
  // 样式直接复用内联的 index.css：第一行 = 项目名称；第二行 = 项目周期 / 总体进度 / 计划版本
  // （导出为静态文件，版本后不带修改/下载按钮；标题不可编辑，cursor 固定默认）
  const topbarHtml = '<div class="content-header">'
    + '<div class="header-title header-title-project">'
    + '<div class="header-title-block">'
    + '<div class="header-title-row"><h2 class="editable-project-title-display" style="cursor:default">' + name + '</h2></div>'
    + buildProjectStatsBar(flatTasks, startDate, endDate, statusOf, progressOf, versionLabel, (members || []).length)
    + '</div></div></div>'
  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + name + ' - 项目主页</title><style>' + CSS + '</style><style>' + OVERRIDES_CSS + '</style></head><body>' + topbarHtml + '<div class="project-home">' +
    // 与主页一致：成员面板为最左列，视图切换/筛选行与内容区整体右移
    '<div class="project-home-main">' +
    '<div id="team-sidebar" class="project-home-member-sidebar" style="display:none">' + memberListHtml + '</div>' +
    '<div class="project-home-right">' +
    buildSharedFilterBar(memberOptions, ganttMaxDepth) +
    '<div class="project-home-body"><div class="project-tab-content">' +
    '<div id="tab-gantt" class="tab-panel project-schedule-wrapper" style="display:flex;flex-direction:column">' + ganttHtml + '</div>' +
    '<div id="tab-table" class="tab-panel wbs-table-container" style="display:none;flex-direction:column">' + tableHtml + '</div>' +
    '<div id="tab-kanban" class="tab-panel wbs-table-container" style="display:none;flex-direction:column">' + kanbanHtml + '</div>' +
    '<div id="tab-calendar" class="tab-panel wbs-table-container" style="display:none;flex-direction:column">' + calendarHtml + '</div>' +
    '</div></div>' +
    '</div></div></div>' + '<div id="task-detail-overlays">' + overlayHtml + '</div>' + '<script>window.__DR_MIN=' + JSON.stringify(startDate) + ';window.__DR_MAX=' + JSON.stringify(endDate) + ';window.__CAL=' + JSON.stringify(calData) + ';</script>' + TAB_SCRIPT + '</body></html>'
  return html
}

export function generateProjectHomeHtml(opts) {
  const html = buildProjectHomeHtml(opts)
  const name = esc(opts.projectName || '项目')
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = opts.downloadName || (name + '项目主页.html')
  document.body.appendChild(link); link.click()
  document.body.removeChild(link); URL.revokeObjectURL(url)
}
