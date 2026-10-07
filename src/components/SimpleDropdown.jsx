import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

const SimpleDropdown = ({ value, options, onChange, className = '', disabled = false, renderLabel }) => {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      const inTrigger = ref.current && ref.current.contains(e.target)
      const inMenu = menuRef.current && menuRef.current.contains(e.target)
      if (!inTrigger && !inMenu) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ top: rect.bottom + 3, left: rect.left })
    }
  }, [open])

  const selected = options.find(o => o.value === value)
  const label = renderLabel ? renderLabel(selected) : (selected ? selected.label : value)

  return (
    <div ref={ref} className={`simple-dropdown ${className} ${disabled ? 'disabled' : ''}`}>
      <button
        ref={triggerRef}
        className="simple-dropdown-trigger"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="simple-dropdown-value">{label}</span>
        <svg className={`simple-dropdown-arrow ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="simple-dropdown-menu"
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 2000 }}
        >
          {options.map(opt => (
            <div
              key={opt.value}
              className={`simple-dropdown-item ${opt.value === value ? 'selected' : ''}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => { onChange(opt.value); setOpen(false) }}
            >
              {opt.label}
              {opt.value === value && (
                <svg className="simple-dropdown-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

export default SimpleDropdown
