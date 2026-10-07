import { useState, useRef, useEffect, useCallback } from 'react'

const CustomSelect = ({ value, onChange, options, placeholder, disabledValues = [], isOpen: externalIsOpen, onClose, renderTrigger, hideTrigger = false, onCreateRole }) => {
  const [internalIsOpen, setInternalIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [searchTerm, setSearchTerm] = useState('')
  const selectRef = useRef(null)
  const searchInputRef = useRef(null)

  const isOpen = externalIsOpen !== undefined ? externalIsOpen : internalIsOpen

  const filteredOptions = options.filter(opt => {
    if (!searchTerm) return true
    const search = searchTerm.toLowerCase()
    return opt.role.toLowerCase().includes(search) || 
           (opt.name && opt.name.toLowerCase().includes(search))
  })

  const isOptionDisabled = (optionValue) => {
    return disabledValues.includes(optionValue)
  }

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (selectRef.current && !selectRef.current.contains(e.target)) {
        if (externalIsOpen !== undefined && onClose) {
          onClose()
        } else {
          setInternalIsOpen(false)
        }
        setSearchTerm('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [externalIsOpen, onClose])

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [isOpen])

  const handleKeyDown = useCallback((e) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (externalIsOpen !== undefined && onClose) {
          // 外部控制模式下，不处理打开逻辑
        } else {
          setInternalIsOpen(true)
        }
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev => 
          prev < filteredOptions.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => prev > 0 ? prev - 1 : prev)
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIndex >= 0 && selectedIndex < filteredOptions.length) {
          onChange(filteredOptions[selectedIndex].value)
          if (externalIsOpen !== undefined && onClose) {
            onClose()
          } else {
            setInternalIsOpen(false)
          }
          setSearchTerm('')
        }
        break
      case 'Escape':
        if (externalIsOpen !== undefined && onClose) {
          onClose()
        } else {
          setInternalIsOpen(false)
        }
        setSearchTerm('')
        break
    }
  }, [isOpen, selectedIndex, filteredOptions, onChange, externalIsOpen, onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const selectedOption = options.find(opt => opt.value === value)

  const handleOptionClick = (option) => {
    if (isOptionDisabled(option.value)) return
    onChange(option.value)
    if (externalIsOpen !== undefined && onClose) {
      onClose()
    } else {
      setInternalIsOpen(false)
    }
    setSearchTerm('')
  }

  const handleClear = () => {
    onChange('')
    if (externalIsOpen !== undefined && onClose) {
      onClose()
    } else {
      setInternalIsOpen(false)
    }
    setSearchTerm('')
  }

  const handleTriggerClick = () => {
    if (externalIsOpen !== undefined && onClose) {
      // 外部控制模式下，点击触发由外部处理
    } else {
      setInternalIsOpen(!internalIsOpen)
    }
  }

  return (
    <div 
      ref={selectRef} 
      className="custom-select-container"
      onClick={handleTriggerClick}
    >
      {!hideTrigger && (
        <div className="custom-select-trigger">
          {renderTrigger ? (
            renderTrigger()
          ) : selectedOption ? (
            <>
              <span className={`custom-select-avatar ${!selectedOption.name ? 'empty' : ''}`}>
                {selectedOption.name ? selectedOption.avatar : '?'}
              </span>
              <span className="custom-select-text">
                {selectedOption.name ? `${selectedOption.role} - ${selectedOption.name}` : `${selectedOption.role} - 待分配`}
              </span>
              <button className="custom-select-clear" onClick={(e) => { e.stopPropagation(); handleClear(); }}>×</button>
            </>
          ) : (
            <span className="custom-select-placeholder">{placeholder}</span>
          )}
          {!renderTrigger && <span className="custom-select-arrow">{isOpen ? '▲' : '▼'}</span>}
        </div>
      )}

      {isOpen && (
        <div className="custom-select-dropdown">
          <input
            ref={searchInputRef}
            type="text"
            className="custom-select-search"
            placeholder="搜索角色/成员..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              setSelectedIndex(-1)
            }}
          />
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option, index) => {
              const disabled = isOptionDisabled(option.value)
              const isSelected = option.value === value
              return (
                <div
                  key={index}
                  className={`custom-select-option ${selectedIndex === index ? 'highlighted' : ''} ${disabled ? 'disabled' : ''} ${isSelected ? 'is-selected' : ''}`}
                  onClick={() => handleOptionClick(option)}
                  onMouseEnter={() => !disabled && setSelectedIndex(index)}
                >
                  <span className={`custom-select-avatar ${!option.name ? 'empty' : ''} ${disabled ? 'disabled' : ''}`}>
                    {option.name ? option.avatar : '?'}
                  </span>
                  <span className={`custom-select-option-text ${disabled ? 'disabled' : ''}`}>
                    {option.name ? `${option.role} - ${option.name}` : `${option.role} - 待分配`}
                  </span>
                  {isSelected && (
                    <svg className="custom-select-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  )}
                </div>
              )
            })
          ) : searchTerm && onCreateRole ? (
            <div className="custom-select-create-role">
              <button 
                className="create-role-btn"
                onClick={() => {
                  const newRole = searchTerm.trim()
                  if (newRole) {
                    const newMember = {
                      role: newRole,
                      name: '',
                      avatar: newRole.charAt(0)
                    }
                    onCreateRole(newMember)
                    if (onClose) onClose()
                  }
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                创建角色: {searchTerm}
              </button>
            </div>
          ) : (
            <div className="custom-select-no-results">未找到匹配项</div>
          )}
        </div>
      )}
    </div>
  )
}

export default CustomSelect