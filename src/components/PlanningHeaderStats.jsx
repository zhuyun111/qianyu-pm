import { useState, useRef, useEffect } from 'react'

// 任务排期页面顶部导航第二行：团队人数 / 工时粒度 / 每日投入
// 样式与项目主页顶部导航第二行（.project-stats-bar）一致；
// 由各排期页面通过 createPortal 渲染到 App 顶部导航的 #planning-header-stats-slot 中，
// 因此工时粒度/每日投入的修改回调仍由各页面传入（WBS 页面使用本地树数据，甘特/网络图使用全局处理器）
function PlanningHeaderStats({
  teamMembers = [],
  isMemberListExpanded = true,
  onToggleMemberList,
  timeRuleUnit = '小时',
  timeRuleValue = 0.5,
  dailyInputHours = 8,
  onApplyTimeRule,
  onApplyDailyInput,
  readOnly = false
}) {
  const [showTimeRuleModal, setShowTimeRuleModal] = useState(false)
  const [draftUnit, setDraftUnit] = useState('小时')
  const [draftValue, setDraftValue] = useState(() => timeRuleValue || 0.5)
  const [draftError, setDraftError] = useState('')
  const [showTimeRuleConfirmModal, setShowTimeRuleConfirmModal] = useState(false)
  const [pendingTimeRule, setPendingTimeRule] = useState(null)

  const [showDailyInputModal, setShowDailyInputModal] = useState(false)
  const [dailyDraftValue, setDailyDraftValue] = useState(8)
  const [dailyDraftError, setDailyDraftError] = useState('')
  const [showDailyInputConfirmModal, setShowDailyInputConfirmModal] = useState(false)
  const [pendingDailyInputHours, setPendingDailyInputHours] = useState(null)

  const timeRuleBtnRef = useRef(null)
  const timeRulePopoverRef = useRef(null)
  const stepperInputRef = useRef(null)
  const dailyInputBtnRef = useRef(null)
  const dailyInputPopoverRef = useRef(null)
  const dailyStepperInputRef = useRef(null)

  const openTimeRule = () => {
    // 单位暂不允许修改：固定为小时(h)。历史数据若为分钟/天，先换算成小时再编辑
    const conv = timeRuleUnit === '分钟' ? (timeRuleValue || 0) / 60
      : timeRuleUnit === '天' ? (timeRuleValue || 0) * 8
      : (timeRuleValue || 0.5)
    setDraftUnit('小时')
    setDraftValue(parseFloat(conv.toFixed(2)) || 0.5)
    setDraftError('')
    setShowTimeRuleModal(v => !v)
  }

  const openDailyInput = () => {
    const conv = timeRuleUnit === '分钟' ? dailyInputHours * 60
      : timeRuleUnit === '天' ? dailyInputHours / 8
      : dailyInputHours
    setDailyDraftValue(parseFloat(conv.toFixed(2)))
    setDailyDraftError('')
    setShowDailyInputModal(v => !v)
  }

  const confirmApplyTimeRule = () => {
    if (!pendingTimeRule) return
    onApplyTimeRule && onApplyTimeRule(pendingTimeRule.unit, pendingTimeRule.value)
    setShowTimeRuleConfirmModal(false)
    setShowTimeRuleModal(false)
    setPendingTimeRule(null)
  }

  const confirmApplyDailyInput = () => {
    if (pendingDailyInputHours == null) return
    onApplyDailyInput && onApplyDailyInput(pendingDailyInputHours)
    setShowDailyInputConfirmModal(false)
    setShowDailyInputModal(false)
    setPendingDailyInputHours(null)
  }

  // 提交工时粒度修改（对勾按钮与回车键共用）：校验通过后弹出二次确认
  const submitTimeRule = () => {
    const step = draftUnit === '分钟' ? 5 : 0.5
    const min = draftUnit === '分钟' ? 5 : 0.5
    const max = draftUnit === '分钟' ? 60 : draftUnit === '小时' ? 24 : 100
    const val = draftValue
    if (isNaN(val) || val < min || val > max) {
      setDraftError(`请输入${min}~${max}之间的值`)
      setTimeout(() => { stepperInputRef.current?.select() }, 0)
      return
    }
    const remainder = val % step
    if (remainder !== 0) {
      setDraftError(`请输入${step}的倍数`)
      setTimeout(() => { stepperInputRef.current?.select() }, 0)
      return
    }
    setPendingTimeRule({ unit: draftUnit, value: draftValue })
    setShowTimeRuleConfirmModal(true)
  }

  // 提交每日投入修改（对勾按钮与回车键共用）：校验通过后弹出二次确认
  const submitDailyInput = () => {
    const step = timeRuleUnit === '分钟' ? 5 : 0.5
    const min = timeRuleUnit === '分钟' ? 5 : 0.5
    const max = timeRuleUnit === '分钟' ? 1440 : timeRuleUnit === '小时' ? 24 : 1
    const val = dailyDraftValue
    if (isNaN(val) || val < min || val > max) {
      setDailyDraftError(`请输入${min}~${max}之间的值`)
      setTimeout(() => dailyStepperInputRef.current?.select(), 0)
      return
    }
    const remainder = Math.round((val % step) * 1000) / 1000
    if (remainder !== 0) {
      setDailyDraftError(`请输入${step}的倍数`)
      setTimeout(() => dailyStepperInputRef.current?.select(), 0)
      return
    }
    setDailyDraftError('')
    const hoursVal = timeRuleUnit === '分钟' ? val / 60
      : timeRuleUnit === '天' ? val * 8
      : val
    setPendingDailyInputHours(parseFloat(hoursVal.toFixed(4)))
    setShowDailyInputConfirmModal(true)
  }

  useEffect(() => {
    if (!showTimeRuleModal) return
    const handler = (e) => {
      if (
        timeRulePopoverRef.current && !timeRulePopoverRef.current.contains(e.target) &&
        timeRuleBtnRef.current && !timeRuleBtnRef.current.contains(e.target)
      ) {
        setShowTimeRuleModal(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showTimeRuleModal])

  useEffect(() => {
    if (!showDailyInputModal) return
    const handler = (e) => {
      if (
        dailyInputPopoverRef.current && !dailyInputPopoverRef.current.contains(e.target) &&
        dailyInputBtnRef.current && !dailyInputBtnRef.current.contains(e.target)
      ) {
        setShowDailyInputModal(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDailyInputModal])

  const unitSuffix = timeRuleUnit === '分钟' ? 'min' : timeRuleUnit === '小时' ? 'h' : 'd'
  const dailySuffix = timeRuleUnit === '分钟' ? 'min' : timeRuleUnit === '天' ? 'd' : 'h'

  return (
    <div className="project-stats-bar planning-header-stats">
      {/* 团队人数：成员图标 + 人数（同项目主页），点击开关左侧成员列表面板 */}
      <button
        type="button"
        className="project-stat planning-stat-btn"
        onClick={() => onToggleMemberList && onToggleMemberList(!isMemberListExpanded)}
        title="显示/隐藏成员列表"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#94a3b8' }}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span className="project-stat-value">{teamMembers.length}人</span>
      </button>
      <span className="project-stat-divider" />
      {/* 工时粒度 */}
      <span className="planning-stat-wrap">
        <button
          ref={timeRuleBtnRef}
          type="button"
          className="project-stat planning-stat-btn"
          onClick={openTimeRule}
          disabled={readOnly}
        >
          <span className="project-stat-label">工时粒度</span>
          <span className="project-stat-value">
            {timeRuleValue}{unitSuffix}
            <svg className="stat-edit-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
        {showTimeRuleModal && (
          <div
            ref={timeRulePopoverRef}
            className="time-rule-popover"
            style={{
              top: timeRuleBtnRef.current ? timeRuleBtnRef.current.offsetTop + timeRuleBtnRef.current.offsetHeight + 4 : 0,
              left: timeRuleBtnRef.current ? timeRuleBtnRef.current.offsetLeft : 0,
            }}
          >
            <div className="time-rule-popover-content">
              <div className="time-rule-popover-row">
                <div className="number-stepper">
                  <button
                    className="stepper-btn"
                    onClick={() => {
                      const step = draftUnit === '分钟' ? 5 : 0.5
                      const min = draftUnit === '分钟' ? 5 : 0.5
                      setDraftError('')
                      setDraftValue(prev => Math.max(min, parseFloat((prev - step).toFixed(2))))
                    }}
                  >−</button>
                  <input
                    type="number"
                    className={`stepper-input ${draftError ? 'input-error' : ''}`}
                    ref={stepperInputRef}
                    value={draftValue}
                    step={draftUnit === '分钟' ? 5 : 0.5}
                    min={draftUnit === '分钟' ? 5 : 0.5}
                    max={draftUnit === '分钟' ? 60 : draftUnit === '小时' ? 24 : 100}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') return
                      const val = parseFloat(raw)
                      if (isNaN(val)) return
                      setDraftValue(val)
                      setDraftError('')
                    }}
                    onBlur={() => {
                      const step = draftUnit === '分钟' ? 5 : 0.5
                      const min = draftUnit === '分钟' ? 5 : 0.5
                      const max = draftUnit === '分钟' ? 60 : draftUnit === '小时' ? 24 : 100
                      const val = draftValue
                      if (isNaN(val) || val < min || val > max) {
                        setDraftError(`请输入${min}~${max}之间的值`)
                        setTimeout(() => { stepperInputRef.current?.select() }, 0)
                        return
                      }
                      const remainder = val % step
                      if (remainder !== 0) {
                        setDraftError(`请输入${step}的倍数`)
                        setTimeout(() => { stepperInputRef.current?.select() }, 0)
                        return
                      }
                      setDraftError('')
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitTimeRule() }}
                  />
                  <button
                    className="stepper-btn"
                    onClick={() => {
                      const step = draftUnit === '分钟' ? 5 : 0.5
                      const max = draftUnit === '分钟' ? 60 : draftUnit === '小时' ? 24 : 100
                      setDraftError('')
                      setDraftValue(prev => Math.min(max, parseFloat((prev + step).toFixed(2))))
                    }}
                  >+</button>
                </div>
                {/* 单位暂不允许修改：固定显示 小时 */}
                <span
                  className="time-unit-trigger"
                  style={{ cursor: 'default', color: '#6B7280' }}
                  title="单位暂不支持修改"
                >小时</span>
                <button
                  className="btn-save time-rule-confirm-btn"
                  onClick={submitTimeRule}
                  title="确定"
                  aria-label="确定"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>
              {draftError ? (
                <p className="time-rule-error">{draftError}</p>
              ) : (
                <p className="time-rule-hint">
                  {draftUnit === '分钟'
                    ? '请输入5的倍数，范围5~60'
                    : `请输入0.5的倍数，范围0.5~${draftUnit === '小时' ? 24 : 100}`}
                </p>
              )}
            </div>
          </div>
        )}
      </span>
      <span className="project-stat-divider" />
      {/* 每日投入 */}
      <span className="planning-stat-wrap">
        <button
          ref={dailyInputBtnRef}
          type="button"
          className="project-stat planning-stat-btn"
          onClick={openDailyInput}
          disabled={readOnly}
        >
          <span className="project-stat-label">每日投入</span>
          <span className="project-stat-value">
            {(() => {
              const v = timeRuleUnit === '分钟' ? dailyInputHours * 60
                : timeRuleUnit === '天' ? dailyInputHours / 8
                : dailyInputHours
              return `${parseFloat(v.toFixed(2))}${dailySuffix}`
            })()}
            <svg className="stat-edit-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
        {showDailyInputModal && (
          <div
            ref={dailyInputPopoverRef}
            className="time-rule-popover"
            style={{
              top: dailyInputBtnRef.current ? dailyInputBtnRef.current.offsetTop + dailyInputBtnRef.current.offsetHeight + 4 : 0,
              left: dailyInputBtnRef.current ? dailyInputBtnRef.current.offsetLeft : 0,
            }}
          >
            <div className="time-rule-popover-content">
              <div className="time-rule-popover-row">
                <div className="number-stepper">
                  <button
                    className="stepper-btn"
                    onClick={() => {
                      const step = timeRuleUnit === '分钟' ? 5 : 0.5
                      const min = timeRuleUnit === '分钟' ? 5 : 0.5
                      setDailyDraftError('')
                      setDailyDraftValue(prev => Math.max(min, parseFloat((prev - step).toFixed(2))))
                    }}
                  >−</button>
                  <input
                    ref={dailyStepperInputRef}
                    type="number"
                    className={`stepper-input ${dailyDraftError ? 'input-error' : ''}`}
                    value={dailyDraftValue}
                    step={timeRuleUnit === '分钟' ? 5 : 0.5}
                    min={timeRuleUnit === '分钟' ? 5 : 0.5}
                    max={timeRuleUnit === '分钟' ? 1440 : timeRuleUnit === '小时' ? 24 : 1}
                    onChange={(e) => {
                      const raw = e.target.value
                      if (raw === '') return
                      const val = parseFloat(raw)
                      if (isNaN(val)) return
                      setDailyDraftValue(val)
                      setDailyDraftError('')
                    }}
                    onBlur={() => {
                      const step = timeRuleUnit === '分钟' ? 5 : 0.5
                      const min = timeRuleUnit === '分钟' ? 5 : 0.5
                      const max = timeRuleUnit === '分钟' ? 1440 : timeRuleUnit === '小时' ? 24 : 1
                      const val = dailyDraftValue
                      if (isNaN(val) || val < min || val > max) {
                        setDailyDraftError(`请输入${min}~${max}之间的值`)
                        setTimeout(() => dailyStepperInputRef.current?.select(), 0)
                        return
                      }
                      const remainder = Math.round((val % step) * 1000) / 1000
                      if (remainder !== 0) {
                        setDailyDraftError(`请输入${step}的倍数`)
                        setTimeout(() => dailyStepperInputRef.current?.select(), 0)
                        return
                      }
                      setDailyDraftError('')
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitDailyInput() }}
                  />
                  <button
                    className="stepper-btn"
                    onClick={() => {
                      const step = timeRuleUnit === '分钟' ? 5 : 0.5
                      const max = timeRuleUnit === '分钟' ? 1440 : timeRuleUnit === '小时' ? 24 : 1
                      setDailyDraftError('')
                      setDailyDraftValue(prev => Math.min(max, parseFloat((prev + step).toFixed(2))))
                    }}
                  >+</button>
                </div>
                <span style={{ fontSize: 13, color: '#374151', minWidth: 24 }}>
                  {timeRuleUnit === '分钟' ? 'min' : timeRuleUnit === '天' ? 'd' : 'h'}
                </span>
                <button
                  className="btn-save time-rule-confirm-btn"
                  onClick={submitDailyInput}
                  title="确定"
                  aria-label="确定"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
              </div>
              {dailyDraftError ? (
                <p className="time-rule-error">{dailyDraftError}</p>
              ) : (
                <p className="time-rule-hint">
                  {timeRuleUnit === '分钟'
                    ? '请输入5的倍数，范围5~1440'
                    : timeRuleUnit === '小时'
                    ? '请输入0.5的倍数，范围0.5~24'
                    : '请输入0.5的倍数，范围0.5~1'}
                </p>
              )}
            </div>
          </div>
        )}
      </span>

      {showTimeRuleConfirmModal && (
        <div className="time-rule-confirm-overlay" onClick={() => setShowTimeRuleConfirmModal(false)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">是否确认修改？任务的投入工时将自动修改（向上取整）</p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => setShowTimeRuleConfirmModal(false)}>取消</button>
              <button className="btn-save" onClick={confirmApplyTimeRule}>确认修改</button>
            </div>
          </div>
        </div>
      )}

      {showDailyInputConfirmModal && (
        <div className="time-rule-confirm-overlay" onClick={() => setShowDailyInputConfirmModal(false)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">是否确认修改？修改后工期将自动重新计算</p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => setShowDailyInputConfirmModal(false)}>取消</button>
              <button className="btn-save" onClick={confirmApplyDailyInput}>确认修改</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default PlanningHeaderStats
