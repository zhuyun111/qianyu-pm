import { useState, useEffect, useRef } from 'react'

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseLocalDate(dateStr) {
  if (!dateStr) return null
  const parts = dateStr.split('-')
  return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]))
}

function isSameDay(d1, d2) {
  if (!d1 || !d2) return false
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
}

export default function DateRangeCalendar({ startDate, endDate, position, onSelect, taskStartDate, taskEndDate }) {
  const initStart = startDate ? parseLocalDate(startDate) : null
  const initEnd = endDate ? parseLocalDate(endDate) : null

  const [currentDate, setCurrentDate] = useState(initStart || new Date())
  const [selecting, setSelecting] = useState('start')
  const [tempStart, setTempStart] = useState(initStart)
  const [tempEnd, setTempEnd] = useState(initEnd)
  const [hoverDate, setHoverDate] = useState(null)
  const wrapperRef = useRef(null)

  const today = new Date()
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()

  const taskStart = taskStartDate ? parseLocalDate(taskStartDate) : null
  const taskEnd = taskEndDate ? parseLocalDate(taskEndDate) : null

  const displayStart = selecting === 'end' ? tempStart : initStart
  const displayEnd = selecting === 'end' ? null : initEnd

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        // 由父组件控制关闭
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const getDaysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()
  const getFirstDayOfMonth = (y, m) => new Date(y, m, 1).getDay()

  const prevMonth = (e) => {
    e.stopPropagation()
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
  }

  const nextMonth = (e) => {
    e.stopPropagation()
    setCurrentDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
  }

  const handleDayClick = (day) => {
    const clickedDate = new Date(year, month, day)

    if (taskStart && clickedDate < taskStart) return
    if (taskEnd && clickedDate > taskEnd) return

    if (selecting === 'start') {
      setTempStart(clickedDate)
      setTempEnd(null)
      setSelecting('end')
    } else {
      const start = tempStart || clickedDate
      if (clickedDate < start) {
        onSelect(formatDate(clickedDate), formatDate(start))
      } else {
        onSelect(formatDate(start), formatDate(clickedDate))
      }
      setSelecting('start')
      setTempStart(null)
      setTempEnd(null)
    }
  }

  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']

  const renderDays = () => {
    const days = []

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="datepicker-empty-cell" />)
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const cellDate = new Date(year, month, day)
      const isToday = isSameDay(cellDate, today)
      const isDisabled = (taskStart && cellDate < taskStart) || (taskEnd && cellDate > taskEnd)

      const rangeStart = displayStart
      const rangeEnd = selecting === 'end' ? hoverDate : displayEnd

      const isRangeStart = rangeStart && isSameDay(cellDate, rangeStart)
      const isRangeEnd = rangeEnd && isSameDay(cellDate, rangeEnd)
      const isInRange = rangeStart && rangeEnd && cellDate > rangeStart && cellDate < rangeEnd

      let className = 'datepicker-day'
      if (isToday) className += ' today'
      if (isDisabled) className += ' disabled'
      if (isRangeStart || isRangeEnd) className += ' selected'
      if (isInRange) className += ' in-range'

      days.push(
        <button
          key={day}
          className={className}
          onClick={() => handleDayClick(day)}
          onMouseEnter={() => selecting === 'end' && setHoverDate(cellDate)}
          onMouseLeave={() => selecting === 'end' && setHoverDate(null)}
        >
          {day}
        </button>
      )
    }

    return days
  }

  const hintText = (() => {
    if (selecting === 'start') {
      return '请选择开始日期'
    }
    if (tempStart) {
      return `${formatDate(tempStart)} → 请选择结束日期`
    }
    return '请选择结束日期'
  })()

  return (
    <div
      ref={wrapperRef}
      className="gantt-filter-dropdown date-range-calendar-dropdown"
      style={{
        position: 'fixed',
        top: position?.top || 0,
        left: position?.left || 0,
        zIndex: 10000
      }}
      onClick={(e) => e.stopPropagation()}
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
        {renderDays()}
      </div>

      <div className="date-range-calendar-hint">
        {hintText}
      </div>
    </div>
  )
}
