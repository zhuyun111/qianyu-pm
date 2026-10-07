import { useState, useEffect, useLayoutEffect, useRef } from 'react'

export function convertHoursToUnit(hours, unit) {
  if (unit === '分钟') return Math.round(hours * 60)
  if (unit === '天') return hours / 8
  return hours
}

function formatHoursByUnit(hours, unit) {
  const value = convertHoursToUnit(hours, unit)
  if (unit === '分钟') return `${value}min`
  if (unit === '天') return `${parseFloat(value.toFixed(2))}d`
  return `${parseFloat(value.toFixed(2))}h`
}

export { formatHoursByUnit }

function convertUnitToHours(value, unit) {
  if (unit === '分钟') return value / 60
  if (unit === '天') return value * 8
  return value
}

function roundToStep(value, step) {
  return Math.round(value / step) * step
}

function HoursEditPopup({ x, y, hours, ruleUnit = '小时', ruleValue = 0.5, onSave, onClose }) {
  const step = ruleValue
  const min = ruleValue
  const max = 10000

  const initial = convertHoursToUnit(hours, ruleUnit)
  const rounded = Math.max(min, Math.min(max, roundToStep(initial, step)))
  const roundedDisplay = ruleUnit === '分钟' ? rounded : parseFloat(rounded.toFixed(2))

  const [value, setValue] = useState(roundedDisplay)
  const [error, setError] = useState('')
  const popupRef = useRef(null)
  const inputRef = useRef(null)

  // 用 ref 保存最新的 handleSave，避免键盘事件闭包捕获旧的 value
  const handleSaveRef = useRef(null)

  // 靠近视口底部/右缘时向内收敛，避免弹窗被屏幕裁剪（最后一行任务场景）
  const [adjustedPos, setAdjustedPos] = useState({ x, y })
  useLayoutEffect(() => {
    if (!popupRef.current) return
    const rect = popupRef.current.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth
    let nx = x
    let ny = y
    if (y + rect.height > vh - 8) {
      const flipped = y - rect.height - 4
      ny = flipped < 8 ? 8 : flipped
    }
    if (x + rect.width > vw - 8) {
      const clamped = vw - rect.width - 8
      nx = clamped < 8 ? 8 : clamped
    }
    if (nx !== adjustedPos.x || ny !== adjustedPos.y) {
      setAdjustedPos({ x: nx, y: ny })
    }
  }, [x, y])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        onClose()
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveRef.current?.()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  useEffect(() => {
    handleSaveRef.current = handleSave
  })

  const validate = (val) => {
    if (val === '' || isNaN(val) || val < min || val > max) {
      return `请输入${min}~${max}之间的值`
    }
    const remainder = Math.round((val % step) * 1000) / 1000
    if (remainder !== 0) {
      return `请输入${step}的倍数`
    }
    return ''
  }

  const handleSave = () => {
    const val = value
    const err = validate(val)
    if (err) {
      setError(err)
      setTimeout(() => { inputRef.current?.select() }, 0)
      return
    }
    setError('')
    const totalHours = convertUnitToHours(val, ruleUnit)
    onSave(totalHours)
  }

  const handleDecrease = () => {
    setError('')
    setValue(prev => {
      const base = prev === '' ? 0 : prev
      const next = Math.max(min, roundToStep(base - step, step))
      return ruleUnit === '分钟' ? next : parseFloat(next.toFixed(2))
    })
  }

  const handleIncrease = () => {
    setError('')
    setValue(prev => {
      const base = prev === '' ? 0 : prev
      const next = Math.min(max, roundToStep(base + step, step))
      return ruleUnit === '分钟' ? next : parseFloat(next.toFixed(2))
    })
  }

  const handleChange = (e) => {
    const raw = e.target.value
    if (raw === '') {
      // 允许清空，方便用户重新输入
      setError('')
      setValue('')
      return
    }
    const val = parseFloat(raw)
    if (isNaN(val)) return
    setError('')
    setValue(val)
  }

  const handleBlur = () => {
    const val = value
    const err = validate(val)
    if (err) {
      setError(err)
      setTimeout(() => { inputRef.current?.select() }, 0)
    } else {
      setError('')
    }
  }

  return (
    <div
      ref={popupRef}
      className="hours-edit-popup"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        zIndex: 1000
      }}
    >
      <div className="hours-edit-content">
        <div className="hours-edit-inputs">
          <div className="number-stepper">
            <button className="stepper-btn" onClick={handleDecrease}>−</button>
            <input
              ref={inputRef}
              type="number"
              className={`stepper-input ${error ? 'input-error' : ''}`}
              value={value}
              step={step}
              min={min}
              max={max}
              onChange={handleChange}
              onBlur={handleBlur}
              autoFocus
            />
            <button className="stepper-btn" onClick={handleIncrease}>+</button>
          </div>
          <span className="hours-edit-unit-text">
            {ruleUnit === '分钟' ? 'min' : ruleUnit === '小时' ? 'h' : 'd'}
          </span>
          <button className="btn-save time-rule-confirm-btn" onClick={handleSave} title="确定" aria-label="确定">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
        </div>
        {error && (
          <p className="time-rule-error" style={{ margin: '8px 0 0 0' }}>{error}</p>
        )}
      </div>
    </div>
  )
}

export default HoursEditPopup
