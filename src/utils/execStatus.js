// 任务执行状态：推导 + 元数据
// 手动状态只存 in_progress / completed（task_execution_status 表，按逻辑任务跨版本存储）；
// not_started / delayed 是「当前时间 vs 计划开始时间」的推导值，永不落库。

export const EXEC_STATUS = {
  not_started: { label: '未开始', color: '#6B7280', bg: '#F3F4F6', border: '#E5E7EB' },
  delayed: { label: '已延误', color: '#DC2626', bg: '#FEE2E2', border: '#FECACA' },
  in_progress: { label: '进行中', color: '#2563EB', bg: '#DBEAFE', border: '#BFDBFE' },
  completed: { label: '已完成', color: '#16A34A', bg: '#DCFCE7', border: '#BBF7D0' }
}

// 手动状态值（可存库的）
export const MANUAL_EXEC_STATUS = ['in_progress', 'completed']

const todayStr = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// task: 含 start_date 的任务节点（树节点/flatTasks 项）
// manual: task_execution_status 表中的手动状态（in_progress / completed）或 null
// startDateOf: 可选，(node) => 开始日期字符串；默认取节点自身 start_date。
// 进度规划页拖拽/重排只更新排期结果、不回写任务树 start_date，推导「未开始/已延误」
// 需传入排期感知的取日期函数，否则重排后任务条仍是已延误的红色。
export function deriveExecStatus(task, manual, startDateOf) {
  if (manual === 'in_progress' || manual === 'completed') return manual
  const getSd = startDateOf || ((n) => n?.start_date)
  const start = getSd(task)
  if (!start) return 'not_started'
  return todayStr() >= start ? 'delayed' : 'not_started'
}

// 解析任意任务节点（可含嵌套 children）的执行状态：
// - 叶子节点：系统推导 + 手动值（deriveExecStatus）
// - 非叶子节点：根据直接子任务（递归至叶子）状态聚合，不判定「已延误」
//   全部未开始→not_started；全部已完成→completed；其余（部分完成/进行中/含已延误/混合）→in_progress
// getManual(node) 返回该节点手动状态（in_progress/completed/null），通常按 original_task_id 查 execStatusMap
// startDateOf: 可选，透传给 deriveExecStatus（见上）
export function resolveExecStatus(node, getManual, startDateOf) {
  if (!node) return 'not_started'
  const leafStatus = (n) => deriveExecStatus(n, getManual ? (getManual(n) || null) : null, startDateOf)
  const roll = (n) => {
    if (n.children && n.children.length > 0) {
      const statuses = n.children.map(roll)
      if (statuses.length === 0) return 'not_started'
      if (statuses.every(s => s === 'completed')) return 'completed'
      if (statuses.every(s => s === 'not_started')) return 'not_started'
      return 'in_progress'
    }
    return leafStatus(n)
  }
  return roll(node)
}

// 解析任意任务节点（可含嵌套 children）的完成进度（0-100 整数）：
// - 叶子节点：取手动进度（getProgress 返回 0-100，无则返回 0）
// - 非叶子节点：对其直接子任务（递归至叶子）进度求均值并四舍五入
// getProgress(node) 返回该节点手动进度（0-100）或 null，通常按 original_task_id 查 progressMap
export function resolveProgress(node, getProgress) {
  if (!node) return 0
  const leafP = (n) => {
    const v = getProgress ? getProgress(n) : null
    if (v === null || v === undefined) return 0
    const num = Number(v)
    if (isNaN(num)) return 0
    return Math.max(0, Math.min(100, Math.round(num)))
  }
  const roll = (n) => {
    if (n.children && n.children.length > 0) {
      const ps = n.children.map(roll)
      if (ps.length === 0) return 0
      const sum = ps.reduce((a, b) => a + b, 0)
      return Math.round(sum / ps.length)
    }
    return leafP(n)
  }
  return roll(node)
}
