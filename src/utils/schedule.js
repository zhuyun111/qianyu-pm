import { isNonWorkDay } from './holidays'

export const themeColors = [
  { solid: '#7eb8f0', medium: '#b8d8fa', light: '#e8f2fc', border: '#a8d0f5', dash: '#5a9fd4' },
  { solid: '#7ecba1', medium: '#a8ddc0', light: '#e6f7ee', border: '#a0ddb8', dash: '#5aad82' },
  { solid: '#b8a1e8', medium: '#d0c4f0', light: '#f0ebf9', border: '#cfc0f0', dash: '#9678d4' },
  { solid: '#f0c87a', medium: '#f5daa0', light: '#fdf4e2', border: '#f5d9a0', dash: '#d4a84e' },
  { solid: '#f0a1a1', medium: '#f5c0c0', light: '#fdeaea', border: '#f5c0c0', dash: '#d47070' },
  { solid: '#7ad4d4', medium: '#a0e5e5', light: '#e6f7f7', border: '#a0e5e5', dash: '#4eb8b8' },
  { solid: '#e8a1c8', medium: '#f0c0de', light: '#f9eef4', border: '#f0c0de', dash: '#d470a0' },
]

const calcTotalHours = (node) => {
  if (!node.children || node.children.length === 0) {
    return node.resources?.reduce((sum, r) => sum + (r.hours || 0), 0) || 0
  } else {
    return node.children.reduce((sum, child) => sum + calcTotalHours(child), 0)
  }
}

export const buildLeaves = (tree, dailyInputHours = 8) => {
  if (!tree) return []
  const leaves = []
  const traverse = (nodes, ancestors = []) => {
    for (const node of nodes) {
      if (!node.children || node.children.length === 0) {
        const totalHoursFromResources = calcTotalHours(node)
        const customDurationDays = node.customDurationDays
        const hasCustomDuration = customDurationDays !== undefined && customDurationDays > 0
        const customDurationHours = hasCustomDuration ? customDurationDays * Math.max(0.5, dailyInputHours) : 0

        let taskType = '等待'
        if (node.taskType === '里程碑') {
          taskType = '里程碑'
        } else if (totalHoursFromResources !== 0 && !hasCustomDuration) {
          taskType = '执行'
        } else if (totalHoursFromResources !== 0 && hasCustomDuration) {
          taskType = '跟进'
        }

        const isMilestone = taskType === '里程碑'

        const firstLevel = parseInt(node.code.split('.')[0], 10) || 1
        const colorIndex = ((firstLevel - 1) % themeColors.length)

        leaves.push({
          id: node.id,
          task_ulid: node.task_ulid || node.id,
          code: node.code,
          name: node.name,
          resources: node.resources || [],
          predecessors: node.predecessors || [],
          totalHours: isMilestone ? 0 : totalHoursFromResources,
          customDuration: node.duration,
          customDurationDays,
          hasCustomDuration,
          durationHours: isMilestone ? 0 : (hasCustomDuration ? customDurationHours : totalHoursFromResources),
          taskType,
          colorIndex,
          description: node.description || '',
          deliverables: node.deliverables || [],
          ancestors,
          start_date: node.start_date || null,
          end_date: node.end_date || null,
          start_hour: node.start_hour != null ? node.start_hour : null,
          end_hour: node.end_hour != null ? node.end_hour : null,
          skip_holidays: node.skip_holidays != null ? !!node.skip_holidays : null,
        })
      }
      if (node.children) {
        traverse(node.children, [...ancestors, node.name])
      }
    }
  }
  traverse(tree)
  return leaves
}

const isHoliday = (date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return isNonWorkDay(`${y}-${m}-${d}`)
}

export const computeSchedule = (rawLeaves, startDate, skipHolidays = false, dailyInputHours = 8, anchors = {}, endDate = null, tree = null, extraPreds = null, dayAligned = false, minStartPos = 0) => {
  if (!startDate || rawLeaves.length === 0) return { scheduledTasks: [], dateRange: [] }

  // 前置任务可能指向「父任务」(node.predecessors 存的是 task_ulid，手动/AI 设置时可能选到父节点)。
  // computeSchedule 只调度叶子，父任务不在 leaves 中、永远不会被标记完成，
  // 导致该叶子及其下游整条依赖链排不出日期（甘特图上父任务的汇总条也会消失）。
  // 这里把「指向父任务的前置」展开为其所有叶子后代，语义：子任务等父任务全部叶子完成后再开始。
  const leafIds = new Set(rawLeaves.map(l => l.id))
  const parentLeafMap = new Map()
  if (tree) {
    const collectLeaves = (nodes, acc) => {
      ;(nodes || []).forEach(n => {
        if (!n.children || n.children.length === 0) acc.push(n.id)
        else collectLeaves(n.children, acc)
      })
    }
    const walk = (nodes) => {
      ;(nodes || []).forEach(n => {
        if (n.children && n.children.length) {
          const acc = []
          collectLeaves(n.children, acc)
          parentLeafMap.set(n.id, acc)
          walk(n.children)
        }
      })
    }
    walk(tree)
  }
  const expandedLeaves = rawLeaves.map(l => {
    if (!l.predecessors || l.predecessors.length === 0) return l
    const expanded = []
    let changed = false
    l.predecessors.forEach(p => {
      if (!leafIds.has(p) && parentLeafMap.has(p)) { expanded.push(...parentLeafMap.get(p)); changed = true }
      else expanded.push(p)
    })
    return changed ? { ...l, predecessors: expanded } : l
  })
  // 后续调度统一使用展开后的叶子集合
  let leaves = expandedLeaves
  // 拖拽前移联动：注入「同成员执行顺序」隐式前置（仅本次重算生效，不落库）。
  // 同成员后续任务之间没有显式依赖、靠成员游标顺排；往前拖拽时需要让它们跟随前移，
  // 通过临时注入隐式前置，使这些任务按 implicitPreds 指定的前序任务新结束重新推位。
  if (extraPreds && Object.keys(extraPreds).length > 0) {
    leaves = expandedLeaves.map(l => {
      const imp = extraPreds[l.id]
      if (imp == null) return l
      const preds = (l.predecessors || []).slice()
      if (!preds.includes(imp)) preds.push(imp)
      return { ...l, predecessors: preds }
    })
  }

  const isHolidayDay = (dayIdx) => {
    const d = new Date(startDate)
    d.setDate(d.getDate() + dayIdx)
    return isHoliday(d)
  }

  // 任务级跳过节假日口径：任务设置了 skip_holidays 用任务值，否则回落项目全局设置
  const leafSkip = (l) => (l && l.skip_holidays != null) ? !!l.skip_holidays : !!skipHolidays

  const advanceWorkSpan = (startF, workDays, skip = skipHolidays) => {
    let d = Math.floor(startF)
    let offset = Math.max(0, startF - d)
    let remaining = Math.max(0, workDays)
    let guard = 0
    while (guard++ < 2000) {
      if (skip && isHolidayDay(d)) {
        d++
        offset = 0
        continue
      }
      const usable = 1 - offset
      if (remaining <= usable + 1e-9) {
        return d + offset + remaining
      }
      remaining -= usable
      d++
      offset = 0
    }
    return d + offset
  }

  const alignToWorkDay = (startF, skip = skipHolidays) => {
    if (!skip) return startF
    let f = startF
    while (isHolidayDay(Math.floor(f))) {
      f = Math.floor(f) + 1
    }
    return f
  }

  const fStarts = {}
  const fEnds = {}
  const completed = new Set()
  const taskEnds = {}
  const memberCursor = {}
  const pinnedByMember = new Map()

  const pinInterval = (mk, s, e) => {
    if (!pinnedByMember.has(mk)) pinnedByMember.set(mk, [])
    pinnedByMember.get(mk).push([s, e])
  }

  const placeTask = (task, earliest, customDays, fixed = false) => {
    // 该任务自己的节假日口径（任务级 skip_holidays 优先，回落全局）
    const skip = leafSkip(task)
    const participating = (task.resources || []).filter(r => (r.hours || 0) > 0)
    const keys = participating.map(r => (r.name ? `${r.role}-${r.name}` : r.role))

    // 整日排期（衔接规则「次日开始」）：任务自身仍按实际工时占位（可为 0.5 天），
    // 但开始位置对齐到整天——前继在半天处结束时，后续任务从下一个工作日整天开始，
    // 而不是当天中午接续。工期不做向上取整（否则 20h 任务会被撑成 3 个整天）。
    // nextDay=true：自由落位（前继结束/成员游标传播），小数位置推到下一天整天；
    // nextDay=false：显式锚点固定落位（已保存排期的 start_date+start_hour、
    //   拖拽/编辑时间指定的小时级开始），顺延节假日但保留小时偏移——
    //   否则持久化的「9/7 4h」锚点会被 floor 成「9/7 0h」，与项目主页显示不一致。
    const alignDayStart = (s, nextDay, skipFlag = skip) => {
      if (!dayAligned) return s
      const isInt = Math.abs(s - Math.round(s)) < 1e-9
      if (nextDay) {
        return alignToWorkDay(isInt ? s : Math.floor(s + 1e-9) + 1, skipFlag)
      }
      const base = Math.floor(s + 1e-9)
      return alignToWorkDay(base, skipFlag) + (isInt ? 0 : s - base)
    }

    const custom = customDays != null && customDays > 0
    const startForFree = (mk, days, skipFlag = skip) => {
      let s = alignToWorkDay(Math.max(earliest, memberCursor[mk] ?? 0), skipFlag)
      const pins = pinnedByMember.get(mk) || []
      let guard3 = 0
      while (guard3++ < 100) {
        let jumped = false
        for (const [ps, pe] of pins) {
          const e = advanceWorkSpan(s, days, skipFlag)
          if (s < pe && ps < e) {
            s = pe
            jumped = true
            break
          }
        }
        if (!jumped) break
      }
      return alignDayStart(s, true, skipFlag)
    }

    if (keys.length === 0) {
      const days = custom ? customDays : 1
      const s = alignDayStart(Math.max(0, earliest), !fixed, skip)
      const e = advanceWorkSpan(s, days, skip)
      if (fixed) pinInterval(null, s, e)
      return { fStart: s, fEnd: e }
    }

    let fStart = Infinity
    let fEnd = -Infinity
    participating.forEach((r, i) => {
      const mk = keys[i]
      const days = custom ? customDays : Math.max(r.hours, 1e-3) / Math.max(1, dailyInputHours)
      const s = fixed
        ? alignDayStart(Math.max(0, earliest), false, skip)
        : startForFree(mk, days, skip)
      const e = advanceWorkSpan(s, days, skip)
      if (fixed) pinInterval(mk, s, e)
      else if (e > (memberCursor[mk] ?? 0)) memberCursor[mk] = e
      fStart = Math.min(fStart, s)
      fEnd = Math.max(fEnd, e)
    })
    return { fStart, fEnd }
  }

  const finalizeTask = (task, { fStart, fEnd }) => {
    fStarts[task.id] = fStart
    fEnds[task.id] = fEnd
    taskEnds[task.id] = fEnd
    completed.add(task.id)
    leaves.forEach(t => {
      if (completed.has(t.id) || t.id === task.id) return
      if ((t.predecessors || []).includes(task.id)) {
        if (taskEnds[t.id] == null || fEnd > taskEnds[t.id]) taskEnds[t.id] = fEnd
      }
    })
  }

  Object.entries(anchors).forEach(([taskId, anchorStart]) => {
    const task = leaves.find(t => t.id === taskId)
    if (!task) return
    // {gap} 间隔锚点不在此处理：依赖前置任务的新结束，需在主循环按拓扑序落位
    if (anchorStart == null || typeof anchorStart !== 'number') return
    if (task.taskType === '里程碑') {
      const preds = task.predecessors || []
      const allPredsDone = preds.every(p => completed.has(p))
      if (!allPredsDone) return
      let maxPredEnd = anchorStart
      preds.forEach(pid => {
        const pe = fEnds[pid]
        if (pe != null && pe > maxPredEnd) maxPredEnd = pe
      })
      fStarts[task.id] = maxPredEnd
      fEnds[task.id] = maxPredEnd
      taskEnds[task.id] = maxPredEnd
      completed.add(task.id)
      leaves.forEach(t => {
        if (completed.has(t.id) || t.id === task.id) return
        if ((t.predecessors || []).includes(task.id)) {
          if (taskEnds[t.id] == null || maxPredEnd > taskEnds[t.id]) taskEnds[t.id] = maxPredEnd
        }
      })
      return
    }
    const custom = task.customDurationDays && task.customDurationDays > 0 ? task.customDurationDays : null
    const placed = placeTask(task, anchorStart, custom, true)
    finalizeTask(task, placed)
  })

  // {gap} 间隔锚点：开始 = max(前置任务结束) + gap（保持任务与前置的原有间隔）
  const gapAnchors = {}
  Object.entries(anchors).forEach(([taskId, v]) => {
    if (v && typeof v === 'object' && typeof v.gap === 'number') gapAnchors[taskId] = Math.max(0, v.gap)
  })

  let guard = 0
  const maxIterations = leaves.length * 20 + 50

  while (completed.size < leaves.length && guard++ < maxIterations) {
    let scheduled = false

    for (const task of leaves) {
      if (completed.has(task.id)) continue
      const predecessors = task.predecessors || []
      const allDone = predecessors.length === 0 || predecessors.every(p => completed.has(p))
      if (!allDone) continue

      const gapOff = gapAnchors[task.id]
      const predEnd = taskEnds[task.id] != null ? taskEnds[task.id] : 0
      // {gap} 间隔锚点以工作日度量：从「前置新结束」起按工作日推进 gap 天
      // （跨越周末/节假日自动顺延），与测量侧（拖拽处按工作日测间隔）配套。
      // 无前置的闭包任务例外：其 gap 承载的是绝对位置（原位钉住），直接加上。
      let earliest = (gapOff != null && predecessors.length > 0)
        ? advanceWorkSpan(predEnd, gapOff, leafSkip(task))
        : predEnd + (gapOff != null ? gapOff : 0)
      // 一键排期「已完成任务不变」：未完成任务的开始不得早于所选排期起点
      // （minStartPos = 所选起点相对甘特图窗口起点的位置索引）
      if (minStartPos > 0 && earliest < minStartPos) earliest = minStartPos

      if (task.taskType === '里程碑') {
        fStarts[task.id] = earliest
        fEnds[task.id] = earliest
        taskEnds[task.id] = earliest
        completed.add(task.id)
        leaves.forEach(t => {
          if (completed.has(t.id) || t.id === task.id) return
          if ((t.predecessors || []).includes(task.id)) {
            if (taskEnds[t.id] == null || earliest > taskEnds[t.id]) taskEnds[t.id] = earliest
          }
        })
        scheduled = true
        continue
      }

      const custom = task.customDurationDays && task.customDurationDays > 0 ? task.customDurationDays : null
      const placed = placeTask(task, earliest, custom, false)
      finalizeTask(task, placed)
      scheduled = true
    }

    if (completed.size < leaves.length && !scheduled) {
      Object.keys(taskEnds).forEach(id => {
        if (!completed.has(id)) taskEnds[id] = (taskEnds[id] ?? 0) + 0.5
      })
    }
  }

  const scheduledTasks = leaves
    .filter(t => fStarts[t.id] !== undefined)
    .map(task => {
      const fStart = fStarts[task.id]
      const fEnd = fEnds[task.id]
      let startDay, endDay
      if (task.taskType === '里程碑') {
        startDay = Math.max(0, Math.floor(fEnd - 1e-9))
        endDay = startDay
      } else {
        startDay = Math.floor(fStart)
        endDay = Math.max(startDay, Math.ceil(fEnd) - 1)
      }
      return {
        ...task,
        startPos: fStart,
        endPos: fEnd,
        startDay,
        endDay,
        duration: fEnd - fStart
      }
    })

  const maxEndDay = scheduledTasks.length > 0 ? Math.max(...scheduledTasks.map(t => t.endDay)) : 0
  let totalProjectDays = maxEndDay + 1

  if (endDate && startDate) {
    const startMs = new Date(startDate).getTime()
    const endMs = new Date(endDate).getTime()
    const endDayFromProject = Math.ceil((endMs - startMs) / 86400000)
    if (endDayFromProject >= totalProjectDays) {
      totalProjectDays = endDayFromProject + 1
    }
  }

  const dateRange = []
  for (let i = 0; i < totalProjectDays; i++) {
    const date = new Date(startDate)
    date.setDate(date.getDate() + i)
    dateRange.push(date.toISOString().split('T')[0])
  }

  return { scheduledTasks, dateRange }
}

export const computeReadOnlySchedule = (leaves, projectStartDate, dailyInputHours = 8) => {
  if (!leaves || leaves.length === 0) return { scheduledTasks: [], dateRange: [] }

  let earliest = projectStartDate || null
  let latest = null
  leaves.forEach(l => {
    if (l.start_date && (!earliest || l.start_date < earliest)) earliest = l.start_date
    if (l.end_date && (!latest || l.end_date > latest)) latest = l.end_date
  })
  if (!earliest || !latest) return { scheduledTasks: [], dateRange: [] }

  const startDate = earliest
  const totalDays = Math.round((new Date(latest).setHours(0,0,0,0) - new Date(startDate).setHours(0,0,0,0)) / 86400000) + 1
  const dateRange = []
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate)
    d.setDate(d.getDate() + i)
    dateRange.push(d.toISOString().split('T')[0])
  }

  const daysFrom = (dateStr) => {
    if (!dateStr) return 0
    return Math.round((new Date(dateStr).setHours(0,0,0,0) - new Date(startDate).setHours(0,0,0,0)) / 86400000)
  }

  const scheduledTasks = leaves.map(task => {
    const startDay = task.start_date ? daysFrom(task.start_date) : 0
    const endDay = task.end_date ? daysFrom(task.end_date) : startDay
    const sHour = task.start_hour != null ? task.start_hour : 0
    const eHour = task.end_hour != null ? task.end_hour : dailyInputHours
    const sOff = sHour / dailyInputHours
    const eOff = eHour / dailyInputHours
    return {
      ...task,
      startPos: startDay + sOff,
      endPos: endDay + eOff,
      startDay,
      endDay,
      duration: (endDay + eOff) - (startDay + sOff),
    }
  })

  return { scheduledTasks, dateRange }
}

export const computeCriticalPath = (leaves) => {
  if (!leaves || leaves.length === 0) {
    return { criticalTaskIds: new Set(), criticalEdgeKeys: new Set(), taskFloatMap: new Map() }
  }

  const taskMap = new Map()
  leaves.forEach(task => {
    taskMap.set(task.id, task)
  })

  const es = new Map()
  const ef = new Map()
  const ls = new Map()
  const lf = new Map()

  const sortedTasks = []
  const visited = new Set()
  const visit = (taskId) => {
    if (visited.has(taskId)) return
    visited.add(taskId)
    const task = taskMap.get(taskId)
    if (!task) return
    for (const pred of (task.predecessors || [])) {
      visit(pred)
    }
    sortedTasks.push(task)
  }
  leaves.forEach(task => visit(task.id))

  for (const task of sortedTasks) {
    let maxEf = 0
    for (const pred of (task.predecessors || [])) {
      if (ef.has(pred) && ef.get(pred) > maxEf) {
        maxEf = ef.get(pred)
      }
    }
    es.set(task.id, maxEf)
    ef.set(task.id, maxEf + (task.durationHours || 0))
  }

  let projectEnd = 0
  for (const task of leaves) {
    if (ef.has(task.id) && ef.get(task.id) > projectEnd) {
      projectEnd = ef.get(task.id)
    }
  }

  for (const task of sortedTasks.reverse()) {
    const successors = []
    for (const t of leaves) {
      if ((t.predecessors || []).includes(task.id)) {
        successors.push(t)
      }
    }

    if (successors.length === 0) {
      lf.set(task.id, projectEnd)
    } else {
      let minLs = Infinity
      for (const succ of successors) {
        if (ls.has(succ.id) && ls.get(succ.id) < minLs) {
          minLs = ls.get(succ.id)
        }
      }
      lf.set(task.id, minLs === Infinity ? projectEnd : minLs)
    }
    ls.set(task.id, lf.get(task.id) - (task.durationHours || 0))
  }

  const taskFloatMap = new Map()
  const criticalTaskIds = new Set()

  for (const task of leaves) {
    const taskEs = es.get(task.id) || 0
    const taskLs = ls.get(task.id) || 0
    const float = Math.round((taskLs - taskEs) * 100) / 100
    taskFloatMap.set(task.id, float)
    if (Math.abs(float) < 1e-9) {
      criticalTaskIds.add(task.id)
    }
  }

  const criticalEdgeKeys = new Set()
  for (const task of leaves) {
    if (!criticalTaskIds.has(task.id)) continue
    for (const pred of (task.predecessors || [])) {
      if (criticalTaskIds.has(pred)) {
        criticalEdgeKeys.add(`${pred}->${task.id}`)
      }
    }
  }

  return { criticalTaskIds, criticalEdgeKeys, taskFloatMap }
}
// ===== 一键排期「已完成任务排期不变」辅助 =====

// 两个 YYYY-MM-DD 之间的日历天数差（b - a）
export const daysBetweenDateStr = (a, b) => {
  if (!a || !b) return 0
  return Math.round((new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0)) / 86400000)
}

// 已完成任务列表中最早的开始日期（无则返回 null）
export const earliestCompletedDate = (completedTasks) => {
  if (!completedTasks || completedTasks.length === 0) return null
  return completedTasks.reduce((m, t) => (t.startDate && t.startDate < m ? t.startDate : m), completedTasks[0].startDate || null)
}

// 把已完成任务（{id, startDate, startHour}）转成固定锚点：
// 位置索引相对甘特图窗口起点 windowStart（保证 ≥ 0，窗口起点已前移到最早已完成日期）。
// 引擎对数值锚点按 fixed 落位并登记成员占用区间，未完成任务会自动避开这些时段。
export const buildCompletedAnchors = (completedTasks, windowStart, dailyInputHours = 8) => {
  const anchors = {}
  if (!completedTasks || !windowStart) return anchors
  completedTasks.forEach(t => {
    if (!t.startDate) return
    const idx = daysBetweenDateStr(windowStart, t.startDate)
    if (!isFinite(idx)) return
    anchors[t.id] = Math.max(0, idx + (t.startHour || 0) / Math.max(1, dailyInputHours))
  })
  return anchors
}

// 修改资源工时后：若任务为自定义工期，且工时换算出的工期超过自定义工期，
// 返回换算天数（调用方应清除 customDurationDays，让工期转为自动计算，此后增减都自动联动）；
// 未超过则返回 null（自定义工期保持不动）。叶子任务限定（有 children 不处理）。
// mode='max' 与 WBS/排列顺序口径一致（取成员工时最大值），mode='sum' 与甘特图口径一致（取工时合计）
export const calcCustomDurationExceeded = (task, newResources, dailyInputHours, mode = 'max') => {
  if (!task) return null
  if (task.customDurationDays === undefined || task.customDurationDays === null) return null
  if (task.children && task.children.length > 0) return null
  const hoursList = (newResources || []).map(r => r.hours || 0)
  if (hoursList.length === 0) return null
  const effectiveHours = mode === 'sum' ? hoursList.reduce((s, h) => s + h, 0) : Math.max(0, ...hoursList)
  if (!dailyInputHours || dailyInputHours <= 0 || effectiveHours <= 0) return null
  const needDays = Math.ceil(effectiveHours / dailyInputHours)
  return needDays > task.customDurationDays ? needDays : null
}

// 任务按资源工时自动计算的工期天数（口径与 WBS/排列顺序一致：取成员工时最大值换算天数）
// 无有效工时返回 null
export const autoDurationDaysOf = (task, dailyInputHours) => {
  if (!task || task.children && task.children.length > 0) return null
  const maxHours = Math.max(0, ...(task.resources || []).map(r => r.hours || 0))
  if (maxHours <= 0 || !dailyInputHours || dailyInputHours <= 0) return null
  return Math.ceil(maxHours / dailyInputHours)
}

// 从开始日期按工期(天)推算结束日期。口径与 DateRangePicker.endFromStart 一致：
// skipHolidays 时跳过非工作日（周末/节假日），保证跨期包含足够的工作日。无开始日期返回 null。
export const computeEndFromDuration = (startStr, days, skipHolidays = false) => {
  if (!startStr) return null
  const D = Math.max(1, Math.floor(Number(days) || 1))
  const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const spanCount = (endStr) => {
    let count = 0
    const s = new Date(`${startStr}T00:00:00`).getTime()
    const e = new Date(`${endStr}T00:00:00`).getTime()
    for (let t = s; t <= e; t += 86400000) {
      if (!skipHolidays || !isNonWorkDay(toISO(new Date(t)))) count++
    }
    return count
  }
  const addOne = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00`)
    d.setDate(d.getDate() + 1)
    return toISO(d)
  }
  let cur = startStr
  let guard = 0
  while (spanCount(cur) < D && guard < 3650) { cur = addOne(cur); guard++ }
  return cur
}

// 群组任务工期：与 WBS 分解列表「共X天」同口径——子叶子按前驱依赖链排布
// （有前驱的叶子在前驱结束后才能开始），取最大结束天数；
// 叶子工期自定义（customDurationDays）优先，否则按最大单人工时 ÷ 每日投入工时换算
export const calcGroupDurationDays = (node, dailyInputHours = 8) => {
  if (!node) return 0
  if (node.customDurationDays !== undefined) return node.customDurationDays
  const leafDur = (m) => {
    if (m.customDurationDays !== undefined) return m.customDurationDays
    const maxHours = Math.max(0, ...(m.resources || []).map(r => r.hours || 0))
    return maxHours > 0 && dailyInputHours > 0 ? Math.ceil(maxHours / dailyInputHours) : 0
  }
  if (!node.children || node.children.length === 0) return leafDur(node)
  const leaves = []
  const idSet = new Set()
  const collectLeaves = (m) => {
    if (!m.children || m.children.length === 0) {
      idSet.add(m.id)
      leaves.push({ id: m.id, dur: leafDur(m), predecessors: m.predecessors || [] })
    } else {
      m.children.forEach(collectLeaves)
    }
  }
  collectLeaves(node)
  const ends = {}
  let guard = 0
  let changed = true
  while (changed && guard < leaves.length + 10) {
    changed = false
    guard++
    for (const l of leaves) {
      let earliest = 0
      for (const p of l.predecessors) {
        if (idSet.has(p) && (ends[p] || 0) > earliest) earliest = ends[p] || 0
      }
      const e = earliest + Math.max(0, l.dur)
      if ((ends[l.id] || 0) !== e) {
        ends[l.id] = e
        changed = true
      }
    }
  }
  return Math.max(0, ...Object.values(ends))
}

// 任务祖先名称链（根→父，不含任务自己）：详情弹窗顶部路径行用
export const findTaskPath = (nodes, id, chain = []) => {
  for (const node of nodes || []) {
    if (node.id === id) return chain
    if (node.children && node.children.length > 0) {
      const found = findTaskPath(node.children, id, [...chain, node.name])
      if (found) return found
    }
  }
  return null
}

// 任务父节点：详情弹窗「返回上一级」切到父任务详情用
export const findTaskParent = (nodes, id) => {
  for (const node of nodes || []) {
    if (node.children && node.children.some(c => c.id === id)) return node
    if (node.children && node.children.length > 0) {
      const found = findTaskParent(node.children, id)
      if (found) return found
    }
  }
  return null
}
