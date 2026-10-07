import { useState, useEffect, useMemo } from 'react'
import DatePicker from './DatePicker'
import { computeSchedule, daysBetweenDateStr, earliestCompletedDate, buildCompletedAnchors } from '../utils/schedule'
import { isNonWorkDay } from '../utils/holidays'

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const addDaysStr = (dateStr, n) => {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().split('T')[0]
}

const fmtDate = (dateStr) => {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 排期方式选项（问号图标悬停展示解释）
const MODE_OPTIONS = [
  {
    value: 'forward',
    label: '正排',
    tip: '从项目开始日期起，按任务依赖与成员占用顺序向后推算每个任务的开始/结束时间，项目自然结束。'
  },
  {
    value: 'backward',
    label: '倒排',
    tip: '以项目结束日期为基准反推：先按依赖与成员占用计算总工期，再整体前移，使项目恰好在该结束日期完成。开始日期自动算出，无需填写。'
  }
]

// 跳过节假日选项（悬停展示解释）
const SKIP_OPTIONS = [
  {
    value: true,
    label: '跳过',
    tip: '任务不占用周末与法定节假日，排期时自动顺延到下一个工作日。'
  },
  {
    value: false,
    label: '不跳过',
    tip: '周末与节假日也连续排期占用，任务不间断推进。'
  }
]

// 任务衔接规则选项（问号图标悬停展示解释）
const LINK_OPTIONS = [
  {
    value: 'day',
    label: '次日开始',
    tip: '任务本身仍按实际工时排布，但衔接整天化：前序任务在半天处结束时，后续任务从下一个工作日的整日开始（而非当天中午接续），日程整齐，便于汇报与资源协调。'
  },
  {
    value: 'compact',
    label: '当日接续',
    tip: '紧凑排期：任务按实际工时连续排布，可在半天处开始或结束，后续任务当天接续，总工期最短。'
  }
]

// 一键排期弹窗：屏幕居中 + 遮罩层，设置排期规则后重新自动排期
function ProjectPeriodModal({ isOpen, onClose, scheduleMode = 'forward', startDate, endDate, skipHolidays = true, dayAligned = true, planLeaves = [], completedSchedTasks = [], dailyInputHours = 8, onApply }) {
  const [mode, setMode] = useState('forward')
  const [dateVal, setDateVal] = useState('')
  const [skip, setSkip] = useState(true)
  const [link, setLink] = useState('day')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isOpen) return
    const m = scheduleMode === 'backward' ? 'backward' : 'forward'
    setMode(m)
    // 正排默认今天；倒排默认最早可选的结束日期（从今天起正排跑一次的实际结束日，
    // 保证推算出的开始日期不早于今天）
    if (m === 'backward') {
      const probe = runMeasure(todayStr(), !!skipHolidays, dayAligned !== false)
      setDateVal(probe ? probe.end : '')
    } else {
      setDateVal(todayStr())
    }
    setSkip(!!skipHolidays)
    setLink(dayAligned === false ? 'compact' : 'day')
    setError('')
  }, [isOpen, scheduleMode, skipHolidays, dayAligned, planLeaves, completedSchedTasks, dailyInputHours])

  const isBackward = mode === 'backward'
  const missingDate = !dateVal
  const dayAlign = link === 'day'

  // 预览排期：随所选日期 / 跳过节假日 / 衔接规则实时重算。
  // 与应用逻辑同语义：已完成任务钉在快照原位（锚点固定），所选开始日期只作用于未完成任务；
  // 若最早已完成日期早于所选日期，窗口起点前移（预览的起止日期按窗口起点推算）。
  // 正排：由所选开始日期推出预计结束日期；倒排：由所选结束日期反推预计开始日期。
  // 注意：useMemo 必须在 `if (!isOpen) return null` 之前调用（Rules of Hooks）
  const earliestC = earliestCompletedDate(completedSchedTasks)
  const completedIds = new Set(completedSchedTasks.map(t => t.id))

  // 以 origin 为所选起点、按给定规则跑一次排期（与预览同语义），返回量测结果：
  // winStart/floor/anchors 供倒排迭代复用；end = 项目实际结束日；
  // statStart = 未完成任务的实际上工日（工期统计起点，排除开工前的周末/空闲天）
  const runMeasure = (origin, skipVal, alignVal) => {
    if (!planLeaves || planLeaves.length === 0) return null
    const winStart = (earliestC && earliestC < origin) ? earliestC : origin
    const anchors = buildCompletedAnchors(completedSchedTasks, winStart, dailyInputHours)
    const floor = daysBetweenDateStr(winStart, origin)
    const res = computeSchedule(planLeaves, winStart, skipVal, dailyInputHours, anchors, null, null, null, alignVal, floor)
    const list = res.scheduledTasks || []
    if (!list.length) return null
    const incomplete = list.filter(t => !completedIds.has(t.id))
    if (!incomplete.length) return null
    const firstStart = Math.min(...incomplete.map(t => t.startPos))
    const span = Math.ceil(Math.max(...list.map(t => t.endPos)))
    const end = addDaysStr(winStart, Math.max(1, span) - 1)
    const statStart = addDaysStr(winStart, Math.floor(firstStart))
    return { winStart, floor, anchors, end, statStart }
  }

  // 倒排最早可选的结束日期：从今天起正排跑一次得到的实际结束日
  const earliestBackwardEnd = useMemo(() => {
    if (!isOpen) return ''
    const m = runMeasure(todayStr(), skip, dayAlign)
    return m ? m.end : ''
  }, [isOpen, skip, dayAlign, planLeaves, completedSchedTasks, dailyInputHours, earliestC])

  // 倒排模式下若已选结束日期因规则变化（跳过节假日/衔接规则）变得早于最早可选日期，自动纠正
  useEffect(() => {
    if (!isOpen || !isBackward) return
    if (dateVal && earliestBackwardEnd && dateVal < earliestBackwardEnd) {
      setDateVal(earliestBackwardEnd)
    }
  }, [isOpen, isBackward, dateVal, earliestBackwardEnd])

  const preview = useMemo(() => {
    if (!isOpen || !dateVal || !planLeaves || planLeaves.length === 0) return null
    if (!isBackward) {
      const m = runMeasure(dateVal, skip, dayAlign)
      if (!m) return null
      // end 为项目日历终点（含已完成任务窗口）；工期统计从实际上工日（statStart）起，
      // 排除已完成窗口与开工前的空闲天，保证与倒排口径一致
      return { start: m.winStart, end: m.end, statStart: m.statStart }
    }
    // 倒排：迭代反推开始日期，使最后一个任务恰好落在所选结束日期。
    // 用「实际结束日 vs 所选结束日」的偏差校正试探起点（周末对齐会让跨度逐轮微调），
    // 收敛后返回实际上工日作为推算的开始日期。
    let tempStart = dateVal
    let last = null
    for (let i = 0; i < 8; i++) {
      const m = runMeasure(tempStart, skip, dayAlign)
      if (!m) return null
      last = m
      const overshoot = daysBetweenDateStr(dateVal, m.end)
      if (overshoot === 0) break
      tempStart = addDaysStr(tempStart, -overshoot)
    }
    return last ? { start: last.statStart, end: dateVal, statStart: last.statStart } : null
  }, [isOpen, dateVal, skip, dayAlign, isBackward, planLeaves, completedSchedTasks, dailyInputHours, earliestC])

  // 工作日 / 自然日统计（工作日 = 区间内非周末、非节假日的天数）。
  // 正排时统计起点用 statStart（所选开始日期），排除已完成任务窗口，保证工期与是否跳过节假日无关；
  // 倒排时 preview.start 本身就是反推的项目开始日期，已不含已完成窗口，直接使用。
  const countDays = (start, end) => {
    let work = 0
    let natural = 0
    const d = new Date(`${start}T00:00:00`)
    const endDate = new Date(`${end}T00:00:00`)
    while (d <= endDate) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      natural++
      if (!isNonWorkDay(`${y}-${m}-${day}`)) work++
      d.setDate(d.getDate() + 1)
    }
    return { work, natural }
  }
  const counts = useMemo(() => (preview ? countDays(preview.statStart || preview.start, preview.end) : null), [preview])

  // 开展日期限制：正排开始日期不能早于今天；倒排推算出的开始日期不能早于今天
  //（等价于结束日期必须晚于「今天 + 工期」）
  const todayVal = todayStr()
  let dateError = ''
  if (isOpen && dateVal) {
    if (!isBackward && dateVal < todayVal) {
      dateError = '开始日期不能早于今天'
    } else if (isBackward && preview && preview.start < todayVal) {
      dateError = '按当前工期推算的开始日期早于今天，请选择更晚的结束日期'
    }
  }

  if (!isOpen) return null

  const switchMode = (m) => {
    setMode(m)
    // 正排默认今天；倒排默认最早可选的结束日期
    setDateVal(m === 'backward' ? (earliestBackwardEnd || '') : todayStr())
    setError('')
  }

  const handleApply = () => {
    if (missingDate) {
      setError(isBackward ? '请选择项目结束日期' : '请选择项目开始日期')
      return
    }
    if (dateError) {
      setError(dateError)
      return
    }
    onApply({
      scheduleMode: mode,
      startDate: isBackward ? null : dateVal,
      endDate: isBackward ? dateVal : null,
      skipHolidays: skip,
      dayAligned: dayAlign
    })
    onClose()
  }

  return (
    <div className="schedule-modal-overlay" onClick={onClose}>
      <div className="schedule-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="schedule-modal-title">一键排期</h3>
        <div className="schedule-modal-row">
          <span className="schedule-modal-label">排期模式</span>
          <div className="schedule-btn-group">
            {MODE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`schedule-mode-btn${mode === opt.value ? ' active' : ''}`}
                title={opt.tip}
                onClick={() => switchMode(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="schedule-modal-row">
          <span className="schedule-modal-label">跳过节假日</span>
          <div className="schedule-btn-group">
            {SKIP_OPTIONS.map(opt => (
              <button
                key={String(opt.value)}
                type="button"
                className={`schedule-mode-btn${skip === opt.value ? ' active' : ''}`}
                title={opt.tip}
                onClick={() => setSkip(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="schedule-modal-row">
          <span className="schedule-modal-label">任务衔接规则</span>
          <div className="schedule-btn-group">
            {LINK_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`schedule-mode-btn${link === opt.value ? ' active' : ''}`}
                title={opt.tip}
                onClick={() => setLink(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="schedule-modal-row">
          <span className="schedule-modal-label">开展日期</span>
          <span className="schedule-help" tabIndex={0}>
            ?
            <span className="schedule-help-tip schedule-help-tip-short">不包含已完成的任务</span>
          </span>
          {isBackward ? (
            <div className="schedule-period-range">
              <span className="schedule-period-text">{preview ? fmtDate(preview.start) : '自动推算'}</span>
              <span className="schedule-period-sep">至</span>
              <DatePicker value={dateVal} minDate={earliestBackwardEnd || undefined} onChange={(v) => { setDateVal(v); setError('') }} />
            </div>
          ) : (
            <div className="schedule-period-range">
              <DatePicker value={dateVal} minDate={todayVal} onChange={(v) => { setDateVal(v); setError('') }} />
              <span className="schedule-period-sep">至</span>
              <span className="schedule-period-text">{preview ? fmtDate(preview.end) : '自动推算'}</span>
            </div>
          )}
        </div>
        {preview && counts && (
          <div className="project-period-summary schedule-modal-summary">
            <div>
              {skip ? `项目总工期 ${counts.work} 日，自然日 ${counts.natural} 天` : `项目总工期 ${counts.natural} 日`}
            </div>
          </div>
        )}
        {(dateError || error) && <p className="schedule-modal-hint">{dateError || error}</p>}
        <div className="schedule-modal-footer">
          <button className="btn-cancel" onClick={onClose}>取消</button>
          <button className="btn-save" onClick={handleApply} disabled={!!dateError}>开始排期</button>
        </div>
      </div>
    </div>
  )
}

export default ProjectPeriodModal
