import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import SimpleDropdown from './SimpleDropdown'
import { isNonWorkDay } from '../utils/holidays'

const toISO = (date) => {
  const d = new Date(date)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatDisplayDate = (dateStr) => {
  if (!dateStr) return '选择日期'
  const d = new Date(dateStr)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

const countSpanDays = (start, end, skipHolidays) => {
  let count = 0
  const s = new Date(`${start}T00:00:00`).getTime()
  const e = new Date(`${end}T00:00:00`).getTime()
  for (let t = s; t <= e; t += 86400000) {
    if (!skipHolidays || !isNonWorkDay(toISO(new Date(t)))) count++
  }
  return count
}

const addDays = (dateStr, offset) => {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + offset)
  return toISO(d)
}

// onlySide: 'start' | 'end' | null。仅渲染单侧触发器（拆分的开始/结束时间行），null 为默认双侧
const DateRangePicker = ({ startDate, endDate, onChange, minDate, minStartDate, minDurationDays = 1, skipHolidays = false, startHour, endHour, onHourChange, timeRuleUnit = 0.5, dailyInputHours = 8, onlySide = null }) => {
  const [openSide, setOpenSide] = useState(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const [pickerDate, setPickerDate] = useState(() => new Date(startDate || endDate || new Date()))
  const wrapperRef = useRef(null)
  const triggerStartRef = useRef(null)
  const triggerEndRef = useRef(null)
  const dropdownRef = useRef(null)

  const D = Math.max(1, minDurationDays)
  const effectiveMinStart = [minDate, minStartDate].filter(Boolean).sort()[1] || [minDate, minStartDate].filter(Boolean)[0] || null

  useEffect(() => {
    if (!openSide) return
    const trigger = openSide === 'start' ? triggerStartRef.current : triggerEndRef.current
    const rect = trigger?.getBoundingClientRect()
    if (!rect) return
    let left = rect.left
    const dropdownWidth = 304
    if (typeof window !== 'undefined' && left + dropdownWidth > window.innerWidth) {
      left = Math.max(8, window.innerWidth - dropdownWidth - 8)
    }
    setPos({ top: rect.bottom + 4, left })
    if (openSide === 'start') {
      setPickerDate(new Date(startDate || new Date()))
    } else {
      setPickerDate(new Date(endDate || new Date()))
    }
  }, [openSide])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (wrapperRef.current?.contains(event.target)) return
      if (dropdownRef.current && dropdownRef.current.contains(event.target)) return
      setOpenSide(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const endFromStart = (start) => {
    let cur = start
    while (countSpanDays(start, cur, skipHolidays) < D) {
      cur = addDays(cur, 1)
    }
    return cur
  }

  const startFromEnd = (end) => {
    let cur = end
    while (countSpanDays(cur, end, skipHolidays) < D) {
      cur = addDays(cur, -1)
    }
    return cur
  }

  const selectStart = (dateStr) => {
    if (effectiveMinStart && dateStr < effectiveMinStart) return
    const computedEnd = endFromStart(dateStr)
    setOpenSide(null)
    onChange(dateStr, computedEnd)
  }

  const selectEnd = (dateStr) => {
    const computedStart = startFromEnd(dateStr)
    if (effectiveMinStart && computedStart < effectiveMinStart) return
    setOpenSide(null)
    onChange(computedStart, dateStr)
  }

  const isStartDisabled = (dateStr) => {
    return !!(effectiveMinStart && dateStr < effectiveMinStart)
  }

  const isEndDisabled = (dateStr) => {
    return !!(effectiveMinStart && startFromEnd(dateStr) < effectiveMinStart)
  }

  const prevMonth = () => {
    setPickerDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  }

  const nextMonth = () => {
    setPickerDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
  }

  const today = new Date()
  const year = pickerDate.getFullYear()
  const month = pickerDate.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstDay = new Date(year, month, 1).getDay()

  const renderDays = (side) => {
    const days = []
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="datepicker-empty-cell" />)
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = toISO(new Date(year, month, day))
      const isToday = today.getDate() === day && today.getMonth() === month && today.getFullYear() === year
      const isSelected = side === 'start' ? dateStr === startDate : dateStr === endDate
      const isDisabled = side === 'start' ? isStartDisabled(dateStr) : isEndDisabled(dateStr)

      days.push(
        <button
          key={day}
          className={`datepicker-day ${isToday ? 'today' : ''} ${isSelected ? 'selected-lite' : ''} ${isDisabled ? 'disabled' : ''}`}
          disabled={isDisabled}
          onClick={() => (side === 'start' ? selectStart(dateStr) : selectEnd(dateStr))}
        >
          {day}
        </button>
      )
    }
    return days
  }

  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']

  const hourOptions = []
  for (let h = 0; h <= dailyInputHours; h = Math.round((h + timeRuleUnit) * 100) / 100) {
    hourOptions.push(h)
  }

  return (
      <div className="daterange-dual-wrapper" ref={wrapperRef}>
      {onlySide !== 'end' && (
        <>
        <div className="datepicker-trigger" ref={triggerStartRef} onClick={() => setOpenSide(openSide === 'start' ? null : 'start')}>
          <span className="datepicker-value">{formatDisplayDate(startDate)}</span>
          <svg className="datepicker-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </div>
        {onHourChange && startHour != null && (
          <SimpleDropdown
            value={startHour}
            options={hourOptions.map(h => ({ value: h, label: `${h}h` }))}
            onChange={(val) => onHourChange('start', val)}
          />
        )}
        </>
      )}
      {onlySide == null && <span className="daterange-dual-sep">~</span>}
      {onlySide !== 'start' && (
        <>
        <div className="datepicker-trigger" ref={triggerEndRef} onClick={() => setOpenSide(openSide === 'end' ? null : 'end')}>
          <span className="datepicker-value">{formatDisplayDate(endDate)}</span>
          <svg className="datepicker-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </div>
        {onHourChange && endHour != null && (
          <SimpleDropdown
            value={endHour}
            options={hourOptions.map(h => ({ value: h, label: `${h}h` }))}
            onChange={(val) => onHourChange('end', val)}
          />
        )}
        </>
      )}

      {openSide && createPortal(
        <div
          ref={dropdownRef}
          className="datepicker-dropdown"
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 2000 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="datepicker-header">
            <button className="datepicker-nav-btn" onClick={prevMonth}>‹</button>
            <div className="datepicker-title">
              {year}年{monthNames[month]}
            </div>
            <button className="datepicker-nav-btn" onClick={nextMonth}>›</button>
          </div>
          <div className="datepicker-weekdays">
            {weekDays.map((day, index) => (
              <div key={index} className="datepicker-weekday">{day}</div>
            ))}
          </div>
          <div className="datepicker-days">
            {renderDays(openSide)}
          </div>
          <div className="datepicker-range-hint">
            {openSide === 'start' ? `选择开始时间，结束时间按工期自动推算` : `选择结束时间，开始时间按工期自动推算`}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default DateRangePicker