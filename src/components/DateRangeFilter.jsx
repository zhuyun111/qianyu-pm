import { useState } from 'react'
import DatePicker from './DatePicker'

function formatDate(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export default function DateRangeFilter({ startDate, endDate, position, onSelect, onClear }) {
  const [tempStart, setTempStart] = useState(startDate || null)
  const [tempEnd, setTempEnd] = useState(endDate || null)

  const handleQuickSelect = (type) => {
    const now = new Date()
    let start, end

    if (type === 'week') {
      const dayOfWeek = now.getDay()
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      start = new Date(now)
      start.setDate(now.getDate() - diff)
      end = new Date(start)
      end.setDate(start.getDate() + 6)
    } else if (type === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1)
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    } else if (type === 'quarter') {
      const quarter = Math.floor(now.getMonth() / 3)
      start = new Date(now.getFullYear(), quarter * 3, 1)
      end = new Date(now.getFullYear(), quarter * 3 + 3, 0)
    }

    const startStr = formatDate(start)
    const endStr = formatDate(end)
    setTempStart(startStr)
    setTempEnd(endStr)
    onSelect(startStr, endStr)
  }

  const handleConfirm = () => {
    if (tempStart && tempEnd) {
      onSelect(tempStart, tempEnd)
    }
  }

  const handleClear = () => {
    setTempStart(null)
    setTempEnd(null)
    onClear()
  }

  return (
    <div
      className="gantt-filter-dropdown date-range-filter-dropdown"
      style={{
        position: 'fixed',
        top: position?.top || 0,
        left: position?.left || 0,
        zIndex: 10000
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="date-range-filter-quick-btns">
        <button className="date-range-filter-quick-btn" onClick={() => handleQuickSelect('week')}>本周</button>
        <button className="date-range-filter-quick-btn" onClick={() => handleQuickSelect('month')}>本月</button>
        <button className="date-range-filter-quick-btn" onClick={() => handleQuickSelect('quarter')}>本季度</button>
        <button className="date-range-filter-quick-btn" onClick={handleClear}>清除</button>
      </div>

      <div className="date-range-filter-pickers">
        <div className="date-range-filter-row">
          <span className="date-range-filter-label">开始日期</span>
          <DatePicker value={tempStart} onChange={setTempStart} />
        </div>
        <div className="date-range-filter-row">
          <span className="date-range-filter-label">结束日期</span>
          <DatePicker value={tempEnd} onChange={setTempEnd} minDate={tempStart} />
        </div>
      </div>

      <div className="date-range-filter-footer">
        <button className="date-range-filter-confirm" onClick={handleConfirm} disabled={!tempStart || !tempEnd}>
          确定
        </button>
      </div>
    </div>
  )
}
