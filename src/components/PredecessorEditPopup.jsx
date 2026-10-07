import { useState, useEffect, useRef } from 'react'

const PredecessorEditPopup = ({ task, allTasks, editingPredecessor, onSave, onClose }) => {
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const inputRef = useRef(null)
  const popupRef = useRef(null)

  const allTasksArray = Object.entries(allTasks).map(([id, info]) => ({
    id,
    code: info.code,
    name: info.name
  })).filter(t => t.id !== task.id)

  const disabledIds = task.predecessors || []
  const isEditing = editingPredecessor != null

  const filteredTasks = allTasksArray.filter(t => {
    if (!searchTerm) return true
    const search = searchTerm.toLowerCase()
    return t.code.toLowerCase().includes(search) ||
           (t.name && t.name.toLowerCase().includes(search))
  })

  const availableTasks = filteredTasks

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus()
    }, 50)
  }, [])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        onClose()
      }
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const currentIndex = availableTasks.findIndex(t => !disabledIds.includes(t.id) || t.id === editingPredecessor)
        if (currentIndex === -1 || selectedIndex === -1) {
          const firstAvailable = availableTasks.findIndex(t => !disabledIds.includes(t.id))
          setSelectedIndex(firstAvailable)
        } else {
          let nextIndex = selectedIndex + 1
          while (nextIndex < availableTasks.length && disabledIds.includes(availableTasks[nextIndex].id) && availableTasks[nextIndex].id !== editingPredecessor) {
            nextIndex++
          }
          if (nextIndex < availableTasks.length) {
            setSelectedIndex(nextIndex)
          }
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (selectedIndex > 0) {
          let prevIndex = selectedIndex - 1
          while (prevIndex >= 0 && disabledIds.includes(availableTasks[prevIndex].id) && availableTasks[prevIndex].id !== editingPredecessor) {
            prevIndex--
          }
          if (prevIndex >= 0) {
            setSelectedIndex(prevIndex)
          }
        }
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault()
        const selectedTask = availableTasks[selectedIndex]
        if (selectedTask && (!disabledIds.includes(selectedTask.id) || selectedTask.id === editingPredecessor)) {
          onSave(selectedTask.id)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose, selectedIndex, availableTasks, disabledIds, editingPredecessor])

  const handleSelectTask = (taskId) => {
    if (!disabledIds.includes(taskId) || taskId === editingPredecessor) {
      onSave(taskId)
    }
  }

  const getItemState = (taskId) => {
    if (taskId === editingPredecessor) return 'selected'
    if (disabledIds.includes(taskId)) return 'disabled'
    return 'available'
  }

  return (
    <div
      ref={popupRef}
      className="predecessor-edit-popup"
    >
      <div className="predecessor-edit-content">
        <div className="predecessor-edit-body">
          <input
            ref={inputRef}
            type="text"
            className="predecessor-edit-input"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value)
              setSelectedIndex(-1)
            }}
            placeholder="搜索任务编号或名称..."
          />
        </div>

        <div className="predecessor-dropdown">
          {availableTasks.length > 0 ? (
            availableTasks.map((t, index) => {
              const state = getItemState(t.id)
              return (
                <div
                  key={t.id}
                  className={`predecessor-dropdown-item predecessor-item-${state}`}
                  onClick={() => handleSelectTask(t.id)}
                  onMouseEnter={() => state !== 'disabled' && setSelectedIndex(index)}
                >
                  <span className="predecessor-task-code">{t.code}</span>
                  <span className="predecessor-task-name">{t.name}</span>
                </div>
              )
            })
          ) : (
            <div className="predecessor-no-results">未找到匹配任务</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default PredecessorEditPopup