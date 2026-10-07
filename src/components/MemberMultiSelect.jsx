import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

const MemberMultiSelect = ({ value = [], onChange, options = [], placeholder = '全部成员', triggerRef }) => {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const dropdownRef = useRef(null)
  const searchInputRef = useRef(null)

  const filteredOptions = options.filter(opt => {
    if (!searchTerm) return true
    const search = searchTerm.toLowerCase()
    return (opt.role || '').toLowerCase().includes(search) ||
           (opt.name || '').toLowerCase().includes(search)
  })

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [isOpen])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          triggerRef?.current && !triggerRef.current.contains(e.target)) {
        setIsOpen(false)
        setSearchTerm('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [triggerRef])

  const handleToggle = useCallback((option) => {
    const exists = value.some(v => v.name === option.name && v.role === option.role)
    if (exists) {
      onChange(value.filter(v => !(v.name === option.name && v.role === option.role)))
    } else {
      onChange([...value, option])
    }
  }, [value, onChange])

  const handleRemove = useCallback((option, e) => {
    e.stopPropagation()
    onChange(value.filter(v => !(v.name === option.name && v.role === option.role)))
  }, [value, onChange])

  const handleSelectAll = useCallback(() => {
    onChange([])
  }, [onChange])

  const handleKeyDown = useCallback((e) => {
    if (!isOpen) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlightedIndex(prev => prev < filteredOptions.length - 1 ? prev + 1 : prev)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlightedIndex(prev => prev > 0 ? prev - 1 : prev)
        break
      case 'Enter':
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < filteredOptions.length) {
          handleToggle(filteredOptions[highlightedIndex])
        }
        break
      case 'Escape':
        setIsOpen(false)
        setSearchTerm('')
        break
    }
  }, [isOpen, highlightedIndex, filteredOptions, handleToggle])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const isSelected = (option) => value.some(v => v.name === option.name && v.role === option.role)
  const isAllSelected = value.length === 0

  const getDropdownPosition = () => {
    if (triggerRef?.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      return {
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        width: 220,
        zIndex: 10000
      }
    }
    return { position: 'fixed', top: 0, left: 0, width: 220, zIndex: 10000 }
  }

  const getMemberLabel = (m) => m.name || m.role

  const MAX_VISIBLE = 2
  const showOverflow = value.length > MAX_VISIBLE
  const visibleMembers = value.slice(0, MAX_VISIBLE)
  const overflowCount = value.length - MAX_VISIBLE

  return (
    <>
      <div
        className="member-multi-select-trigger"
        onClick={() => setIsOpen(v => !v)}
      >
        <div className="member-multi-select-tags">
          {value.length === 0 ? (
            <span className="member-multi-select-placeholder">{placeholder}</span>
          ) : (
            <>
              {visibleMembers.map((m) => (
                <div key={`${m.role}-${m.name}`} className="resource-item member-multi-tag-item">
                  <span className={`avatar ${!m.name ? 'empty-avatar' : ''}`}>
                    {m.name ? (m.avatar || m.name.charAt(0).toUpperCase()) : '?'}
                  </span>
                  <span className={`resource-name ${!m.name ? 'empty-name' : ''}`}>
                    {getMemberLabel(m)}
                  </span>
                </div>
              ))}
              {showOverflow && (
                <span className="member-multi-overflow">+{overflowCount}</span>
              )}
            </>
          )}
        </div>
        <span className="member-multi-select-arrow">{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && createPortal(
        <div ref={dropdownRef} className="member-multi-dropdown" style={getDropdownPosition()}>
          <input
            ref={searchInputRef}
            type="text"
            className="custom-select-search"
            placeholder="搜索角色/成员..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              setHighlightedIndex(-1)
            }}
          />
          <div
            className={`custom-select-option member-multi-all ${isAllSelected ? 'is-selected' : ''}`}
            onClick={handleSelectAll}
          >
            <span className="custom-select-option-text">全部成员</span>
            {isAllSelected && (
              <svg className="custom-select-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            )}
          </div>
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option, index) => {
              const checked = isSelected(option)
              return (
                <div
                  key={`${option.role}-${option.name}`}
                  className={`custom-select-option ${checked ? 'is-selected' : ''} ${highlightedIndex === index ? 'highlighted' : ''}`}
                  onClick={() => handleToggle(option)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className={`custom-select-avatar ${!option.name ? 'empty' : ''}`}>
                    {option.name ? (option.avatar || option.name.charAt(0).toUpperCase()) : '?'}
                  </span>
                  <span className="custom-select-option-text">
                    {option.name ? `${option.role} - ${option.name}` : `${option.role} - 待分配`}
                  </span>
                  {checked && (
                    <svg className="custom-select-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              )
            })
          ) : (
            <div className="custom-select-no-results">未找到匹配项</div>
          )}
        </div>,
        document.body
      )}
    </>
  )
}

export default MemberMultiSelect
