import { useState, useEffect, useRef, useCallback } from 'react'
import CustomSelect from './CustomSelect'

// Convert hours (in hours) to the numeric value in the given unit
const hoursToUnitValue = (hours, unit) => {
  if (unit === '分钟') return hours * 60
  if (unit === '天') return hours / 8
  return hours
}
// Convert a numeric value in the given unit back to hours
const unitValueToHours = (value, unit) => {
  if (unit === '分钟') return value / 60
  if (unit === '天') return value * 8
  return value
}

const ResourceEditModal = ({ task, teamMembers, onSave, onCancel, timeRuleUnit = '小时', timeRuleValue = 0.5 }) => {
  const unitSuffix = timeRuleUnit === '分钟' ? 'min' : timeRuleUnit === '天' ? 'd' : 'h'
  const maxValue = 10000

  const [resources, setResources] = useState([
    { role: '', name: '', avatar: '', value: 0 }
  ])
  const [errors, setErrors] = useState({})
  const rowRefs = useRef({})

  useEffect(() => {
    if (task) {
      if (task.resources && task.resources.length > 0) {
        const mappedResources = task.resources.map(r => {
          const unitValue = hoursToUnitValue(r.hours || 0, timeRuleUnit)
          const ceiled = unitValue > 0 ? Math.ceil(unitValue / timeRuleValue) * timeRuleValue : 0
          return {
            role: r.role,
            name: r.name,
            avatar: r.avatar,
            value: parseFloat(ceiled.toFixed(2))
          }
        })
        mappedResources.push({ role: '', name: '', avatar: '', value: 0 })
        setResources(mappedResources)
        setTimeout(() => {
          const nextIndex = mappedResources.length - 1
          const selectEl = rowRefs.current[`select-${nextIndex}`]
          if (selectEl) {
            selectEl.click()
          }
        }, 50)
      } else {
        setResources([{ role: '', name: '', avatar: '', value: 0 }])
      }
    }
    setErrors({})
  }, [task, timeRuleUnit, timeRuleValue])

  const handleRoleChange = (index, selectedValue) => {
    const member = teamMembers.find(m => `${m.role}-${m.name}` === selectedValue)
    const updated = [...resources]
    updated[index] = {
      ...updated[index],
      role: member?.role || '',
      name: member?.name || '',
      avatar: member?.avatar || ''
    }
    setResources(updated)
  }

  const handleAddRow = () => {
    setResources([...resources, { role: '', name: '', avatar: '', value: 0 }])
  }

  const handleRemoveRow = (index) => {
    if (resources.length === 1) return
    setResources(resources.filter((_, i) => i !== index))
  }

  const handleValueChange = (index, raw) => {
    if (raw === '') {
      const updated = [...resources]
      updated[index] = { ...updated[index], value: '' }
      setResources(updated)
      return
    }
    const val = parseFloat(raw)
    if (isNaN(val)) return
    const updated = [...resources]
    updated[index] = { ...updated[index], value: val }
    setResources(updated)
  }

  const handleValueBlur = (index) => {
    let val = resources[index].value
    if (val === '' || isNaN(val)) val = 0
    if (val < 0) val = 0
    if (val > maxValue) val = maxValue
    if (val > 0) {
      val = Math.ceil(val / timeRuleValue) * timeRuleValue
    }
    const updated = [...resources]
    updated[index] = { ...updated[index], value: parseFloat(val.toFixed(2)) }
    setResources(updated)
  }

  const handleStepDown = (index) => {
    const val = parseFloat(resources[index].value) || 0
    if (val <= 0) return
    const newVal = parseFloat((val - timeRuleValue).toFixed(2))
    const updated = [...resources]
    updated[index] = { ...updated[index], value: Math.max(0, newVal) }
    setResources(updated)
  }

  const handleStepUp = (index) => {
    const val = parseFloat(resources[index].value) || 0
    const newVal = parseFloat((val + timeRuleValue).toFixed(2))
    const updated = [...resources]
    updated[index] = { ...updated[index], value: Math.min(maxValue, newVal) }
    setResources(updated)
  }

  const handleSave = () => {
    const newErrors = {}
    let isValid = true

    resources.forEach((row, index) => {
      const rowKey = `row-${index}`
      const hasDuplicate = resources.some((r, i) =>
        i !== index && r.role && r.role === row.role && r.name === row.name
      )

      if (!row.role) {
        newErrors[rowKey] = '请选择角色/成员'
        isValid = false
      } else if (hasDuplicate) {
        newErrors[rowKey] = '角色/成员不能重复'
        isValid = false
      } else if (!parseFloat(row.value) || parseFloat(row.value) <= 0) {
        newErrors[rowKey] = '工时不能为0'
        isValid = false
      }
    })

    setErrors(newErrors)

    if (isValid) {
      const validResources = resources
        .filter(r => r.role && parseFloat(r.value) > 0)
        .map(r => {
          const val = parseFloat(r.value)
          const hours = unitValueToHours(val, timeRuleUnit)
          return {
            role: r.role,
            name: r.name,
            avatar: r.avatar,
            hours: parseFloat(hours.toFixed(4))
          }
        })
      onSave(validResources)
    }
  }

  const handleKeyDown = useCallback((e, index) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const nextIndex = index + 1
      if (nextIndex < resources.length) {
        const selectEl = rowRefs.current[`select-${nextIndex}`]
        if (selectEl) {
          selectEl.click()
        }
      } else {
        handleAddRow()
        setTimeout(() => {
          const selectEl = rowRefs.current[`select-${nextIndex}`]
          if (selectEl) {
            selectEl.click()
          }
        }, 0)
      }
    }
  }, [resources.length])

  const totalValue = resources.reduce((sum, r) => sum + (parseFloat(r.value) || 0), 0)
  const totalDisplay = parseFloat(totalValue.toFixed(2))

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content resource-modal" onClick={e => e.stopPropagation()}>
        <div className="resource-modal-header">
          <span className="resource-modal-title">资源分配</span>
          <button className="resource-modal-close" onClick={onCancel}>×</button>
        </div>

        <div className="resource-modal-body">
          <div className="task-info-section">
            <div className="task-info-item">
              <span className="task-info-label">任务编号：</span>
              <span className="task-info-value">{task?.code}</span>
            </div>
            <div className="task-info-item">
              <span className="task-info-label">任务名称：</span>
              <span className="task-info-value">{task?.name}</span>
            </div>
            <div className="task-info-item">
              <span className="task-info-label">总预估工时：</span>
              <span className="task-info-value">{totalDisplay}{unitSuffix}</span>
            </div>
          </div>

          <div className="resource-table-section">
            <div className="resource-table-header">
              <span className="col-role">角色/成员</span>
              <span className="col-hours">投入工时</span>
              <span className="col-action"></span>
            </div>

            <div className="resource-table-body">
              {resources.map((resource, index) => (
                <div key={index} className="resource-table-row">
                  <div className="col-role">
                    <div
                      ref={(el) => { rowRefs.current[`select-${index}`] = el?.querySelector('.custom-select-trigger') }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <CustomSelect
                        value={resource.role ? `${resource.role}-${resource.name}` : ''}
                        onChange={(value) => handleRoleChange(index, value)}
                        options={teamMembers.map(m => ({
                          value: `${m.role}-${m.name}`,
                          role: m.role,
                          name: m.name,
                          avatar: m.avatar
                        }))}
                        placeholder="选择角色"
                        disabledValues={resources
                          .filter((_, i) => i !== index && _.role)
                          .map(r => `${r.role}-${r.name}`)
                        }
                      />
                    </div>
                  </div>

                  <div className="col-hours">
                    <div className="number-stepper">
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => handleStepDown(index)}
                      >−</button>
                      <input
                        type="number"
                        className="stepper-input"
                        value={resource.value}
                        step={timeRuleValue}
                        min={0}
                        max={maxValue}
                        onChange={(e) => handleValueChange(index, e.target.value)}
                        onBlur={() => handleValueBlur(index)}
                        onKeyDown={(e) => handleKeyDown(e, index)}
                      />
                      <button
                        type="button"
                        className="stepper-btn"
                        onClick={() => handleStepUp(index)}
                      >+</button>
                    </div>
                    <span className="time-separator">{unitSuffix}</span>
                    {errors[`row-${index}`] && (
                      <span className="row-error">✗ {errors[`row-${index}`]}</span>
                    )}
                  </div>

                  <div className="col-action">
                    {resources.length > 1 && (
                      <button
                        className="row-delete-btn"
                        onClick={() => handleRemoveRow(index)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button className="add-row-btn" onClick={handleAddRow}>
              + 添加资源行
            </button>
          </div>
        </div>

        <div className="resource-modal-footer">
          <button className="btn-cancel" onClick={onCancel}>取消</button>
          <button className="btn-save" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}

export default ResourceEditModal
