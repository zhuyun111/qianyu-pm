import { useState, useEffect, useRef } from 'react'

const DatePicker = ({ value, onChange, minDate }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [currentDate, setCurrentDate] = useState(value ? new Date(value) : new Date())
  const wrapperRef = useRef(null)

  const min = minDate ? new Date(`${minDate}T00:00:00`) : null

  useEffect(() => {
    if (value) {
      setCurrentDate(new Date(value))
    }
  }, [value])

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const formatDate = (date) => {
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

  const getDaysInMonth = (year, month) => {
    return new Date(year, month + 1, 0).getDate()
  }

  const getFirstDayOfMonth = (year, month) => {
    return new Date(year, month, 1).getDay()
  }

  const prevMonth = () => {
    setCurrentDate(prev => {
      const newDate = new Date(prev.getFullYear(), prev.getMonth() - 1, 1)
      return newDate
    })
  }

  const nextMonth = () => {
    setCurrentDate(prev => {
      const newDate = new Date(prev.getFullYear(), prev.getMonth() + 1, 1)
      return newDate
    })
  }

  const selectDate = (day) => {
    if (min) {
      const dayDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day)
      if (dayDate < min) return
    }
    const selectedDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day)
    onChange(formatDate(selectedDate))
    setIsOpen(false)
  }

  const today = new Date()
  const year = currentDate.getFullYear()
  const month = currentDate.getMonth()
  const daysInMonth = getDaysInMonth(year, month)
  const firstDay = getFirstDayOfMonth(year, month)
  const selectedDate = value ? new Date(value) : null

  const weekDays = ['日', '一', '二', '三', '四', '五', '六']

  const renderDays = () => {
    const days = []
    
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="datepicker-empty-cell" />)
    }
    
    for (let day = 1; day <= daysInMonth; day++) {
      const isToday = today.getDate() === day && 
                     today.getMonth() === month && 
                     today.getFullYear() === year
      const isSelected = selectedDate && 
                        selectedDate.getDate() === day && 
                        selectedDate.getMonth() === month && 
                        selectedDate.getFullYear() === year
      const isDisabled = min ? new Date(year, month, day) < min : false
      
      days.push(
        <button
          key={day}
          className={`datepicker-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
          onClick={() => selectDate(day)}
        >
          {day}
        </button>
      )
    }
    
    return days
  }

  const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']

  return (
    <div className="datepicker-wrapper" ref={wrapperRef}>
      <div className="datepicker-trigger" onClick={() => setIsOpen(!isOpen)}>
        <span className="datepicker-value">{formatDisplayDate(value)}</span>
        <svg className="datepicker-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
      </div>
      
      {isOpen && (
        <div className="datepicker-dropdown">
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
        </div>
      )}
    </div>
  )
}

export default DatePicker