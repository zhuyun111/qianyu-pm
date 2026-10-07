import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { getMemberTaskSummary, unassignMemberResources } from '../utils/db'

import CustomSelect from './CustomSelect'
import { formatHoursByUnit } from './HoursEditPopup'

const MemberList = ({ teamMembers, showDetails = false, projectId, timeRuleUnit = '小时', selectedMember, onSelectMember, onAddRole, onAddMember, onRenameRole, onDeleteRole, onRenameMember, onDeleteMember, onReassignResources, onCollapse }) => {
  const [showAddRoleModal, setShowAddRoleModal] = useState(false)
  const [showAddMemberModal, setShowAddMemberModal] = useState(false)
  const [showRenameModal, setShowRenameModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showRenameMemberModal, setShowRenameMemberModal] = useState(false)
  const [showDeleteMemberModal, setShowDeleteMemberModal] = useState(false)
  const [currentRole, setCurrentRole] = useState('')
  const [currentMember, setCurrentMember] = useState(null)
  const [newRoleName, setNewRoleName] = useState('')
  const [newMemberName, setNewMemberName] = useState('')
  const [editMemberRole, setEditMemberRole] = useState('')
  const [editRoleDropdownOpen, setEditRoleDropdownOpen] = useState(false)
  const [editRoleSearch, setEditRoleSearch] = useState('')
  const [deleteTaskSummary, setDeleteTaskSummary] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [reassignTarget, setReassignTarget] = useState('')
  const [reassignMode, setReassignMode] = useState('assign')
  const [openMenuRole, setOpenMenuRole] = useState(null)
  const [openMemberMenu, setOpenMemberMenu] = useState(null)
  // 更多操作菜单的 fixed 定位坐标（菜单 portal 到 body，避免被 overflow 滚动容器裁剪）
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })
  const [toast, setToast] = useState(null)
  const editRoleDropdownRef = useRef(null)
  const editMemberNameRef = useRef(null)

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const groupedByRole = teamMembers.reduce((acc, member) => {
    const role = member.role || '未分组'
    if (!acc[role]) {
      acc[role] = []
    }
    acc[role].push(member)
    return acc
  }, {})

  const checkConflict = (member) => {
    if (!member.tasks || member.tasks.length <= 1) return false
    
    for (let i = 0; i < member.tasks.length; i++) {
      for (let j = i + 1; j < member.tasks.length; j++) {
        const task1 = member.tasks[i]
        const task2 = member.tasks[j]
        if (!task1 || !task2) continue
        const start1 = task1.startPos != null ? task1.startPos : (task1.startDay ?? 0)
        const end1 = task1.endPos != null ? task1.endPos : ((task1.endDay != null ? task1.endDay : task1.startDay) + 1)
        const start2 = task2.startPos != null ? task2.startPos : (task2.startDay ?? 0)
        const end2 = task2.endPos != null ? task2.endPos : ((task2.endDay != null ? task2.endDay : task2.startDay) + 1)
        
        if (start1 < end2 && start2 < end1) {
          return true
        }
      }
    }
    return false
  }

  const handleAddRole = () => {
    if (newRoleName.trim()) {
      onAddRole(newRoleName.trim())
      setNewRoleName('')
      setShowAddRoleModal(false)
    }
  }

  const handleAddMember = () => {
    if (newMemberName.trim()) {
      onAddMember(currentRole, newMemberName.trim())
      setNewMemberName('')
      setShowAddMemberModal(false)
    }
  }

  const handleRenameRole = () => {
    if (newRoleName.trim() && currentRole) {
      onRenameRole(currentRole, newRoleName.trim())
      setNewRoleName('')
      setShowRenameModal(false)
    }
  }

  const handleDeleteRole = () => {
    if (currentRole) {
      onDeleteRole(currentRole)
      setShowDeleteModal(false)
    }
  }

  const handleRenameMember = () => {
    if (newMemberName.trim() && currentMember) {
      onRenameMember(currentRole, currentMember.name, newMemberName.trim(), editMemberRole)
      setNewMemberName('')
      setEditMemberRole('')
      setShowRenameMemberModal(false)
      setCurrentMember(null)
    }
  }

  const handleDeleteMember = async (role, member) => {
    if (member.tasks && member.tasks.length > 0) {
      showToast(`该成员参与${member.tasks.length}个任务，暂时无法删除`)
      return
    }
    setCurrentRole(role)
    setCurrentMember(member)
    setReassignTarget('')
    setReassignMode('assign')
    setShowDeleteMemberModal(true)
    setDeleteLoading(true)
    setDeleteTaskSummary(null)

    try {
      if (projectId && member.name) {
        const summary = await getMemberTaskSummary(projectId, member.name)
        setDeleteTaskSummary(summary)
      }
    } catch (e) {
      console.error('Failed to get member task summary:', e)
    }
    setDeleteLoading(false)
  }

  const confirmDeleteMember = async () => {
    if (!currentMember) return

    if (deleteTaskSummary && deleteTaskSummary.taskList.length > 0 && onReassignResources) {
      if (reassignMode === 'assign' && reassignTarget) {
        const targetMember = teamMembers.find(m => `${m.role}-${m.name}` === reassignTarget)
        if (targetMember) {
          await onReassignResources(currentMember.name, targetMember.name, targetMember.role)
        }
      } else if (reassignMode === 'none') {
        await onReassignResources(currentMember.name, '', '')
      }
    }

    onDeleteMember(currentRole, currentMember.name)
    setShowDeleteMemberModal(false)
    setCurrentMember(null)
    setDeleteTaskSummary(null)
    setReassignTarget('')
    setReassignMode('assign')
  }

  const openAddMemberModal = (role) => {
    setCurrentRole(role)
    setNewMemberName('')
    setShowAddMemberModal(true)
  }

  const openRenameModal = (role) => {
    setCurrentRole(role)
    setNewRoleName(role)
    setShowRenameModal(true)
  }

  // 记录触发按钮位置，供 portal 菜单 fixed 定位使用
  // 视口下方空间不足时向上翻转，并钳制在视口范围内，避免菜单被窗口边缘裁剪
  const openMenuAt = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const estMenuH = 90
    const spaceBelow = window.innerHeight - rect.bottom
    let top = rect.bottom + 4
    if (spaceBelow < estMenuH + 8) {
      top = Math.max(8, rect.top - estMenuH - 4)
    }
    setMenuPos({ top, right: Math.max(8, window.innerWidth - rect.right) })
  }

  const openDeleteModal = (role) => {
    // 角色下只要有任一成员参与任务（任务数 > 0）就不允许删除；
    // 所有成员任务数均为 0（含待分配成员）时允许删除，删除后角色下成员一并删除。
    const roleMembers = groupedByRole[role] || []
    if (roleMembers.some(m => !m.tasks)) {
      showToast('任务数据尚未加载完成，请稍后再试')
      return
    }
    if (roleMembers.some(m => m.tasks.length > 0)) {
      showToast('该角色下有成员正在参与任务，无法删除')
      return
    }
    setCurrentRole(role)
    setShowDeleteModal(true)
  }

  const handleClickOutside = (e) => {
    if (!e.target.closest('.more-actions')) {
      setOpenMenuRole(null)
    }
  }

  useEffect(() => {
    if (!editRoleDropdownOpen) return
    const handler = (e) => {
      if (editRoleDropdownRef.current && !editRoleDropdownRef.current.contains(e.target)) {
        setEditRoleDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [editRoleDropdownOpen])

  return (
    <div
      className="member-list"
      onClick={handleClickOutside}
      onScroll={() => { setOpenMenuRole(null); setOpenMemberMenu(null) }}
    >
      {/* 添加角色入口：仅在传入角色管理回调（排期流程侧栏）时显示；项目主页等只读侧栏不显示 */}
      {(typeof onAddRole === 'function' || typeof onCollapse === 'function') && (
        <div className="member-list-header">
          {typeof onAddRole === 'function' && (
            <button className="add-role-btn" onClick={() => { setNewRoleName(''); setShowAddRoleModal(true); }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加角色
            </button>
          )}
          {typeof onCollapse === 'function' && (
            <button className="member-collapse-btn" onClick={onCollapse} title="收起成员列表">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          )}
        </div>
      )}

      {Object.entries(groupedByRole).map(([role, members]) => (
        <div key={role} className="role-group">
          <div className="role-header">
            <div className="role-title">
              <span className="role-name">{role}</span>
              <span className="role-count">({members.length}人)</span>
            </div>
            <div className="role-actions">
              <button 
                className="action-btn add-member-btn" 
                onClick={() => openAddMemberModal(role)}
                title="添加成员"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <div className="more-actions">
                <button
                  className="action-btn more-btn"
                  title="更多操作"
                  onClick={(e) => {
                    openMenuAt(e)
                    setOpenMenuRole(openMenuRole === role ? null : role)
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="19" cy="12" r="1" />
                    <circle cx="5" cy="12" r="1" />
                  </svg>
                </button>
                {openMenuRole === role && createPortal(
                  <div
                    className="more-actions-menu"
                    style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {typeof onRenameRole === 'function' && (
                      <button className="menu-item" onClick={() => { openRenameModal(role); setOpenMenuRole(null); }}>重命名</button>
                    )}
                    {typeof onDeleteRole === 'function' && (
                      <button className="menu-item delete-item" onClick={() => { openDeleteModal(role); setOpenMenuRole(null); }}>删除</button>
                    )}
                  </div>,
                  document.body
                )}
              </div>
            </div>
          </div>
          <ul className="member-items">
            {members.map((member, idx) => {
              const memberKey = member.name ? `${role}-${member.name}` : `${role}-unassigned-${idx}`
              const isSelected = selectedMember?.name === member.name && selectedMember?.role === member.role
              return (
                <li key={idx} className="member-item-wrapper">
                  <div
                    className={`member-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => onSelectMember && onSelectMember(isSelected ? null : member)}
                  >
                    <div className="member-item-top">
                      <span className={`member-avatar ${!member.name ? 'empty' : ''}`}>
                        {member.name ? member.avatar : '?'}
                      </span>
                      <div className="member-info">
                        <div className="member-name-row">
                          <span className="member-name">{member.name || '待分配'}</span>
                          {showDetails && (
                            <span className={`status-tag ${checkConflict(member) ? 'conflict' : 'normal'}`}>
                              {checkConflict(member) ? '冲突' : '正常'}
                            </span>
                          )}
                        </div>
                        {showDetails && (
                          <div className="member-meta">
                            {/* tasks/totalHours 为 null 表示任务树尚未加载完成（草稿确认等），
                                显示省略号而非误导性的 0 */}
                            <span className="meta-text">任务: {member.tasks ? `${member.tasks.length}个` : '…'}</span>
                            <span className="meta-text">工时: {member.totalHours == null ? '…' : formatHoursByUnit(member.totalHours, timeRuleUnit)}</span>
                          </div>
                        )}
                      </div>
                      <div className="member-actions">
                        <button
                          className="action-btn more-btn"
                          onClick={(e) => {
                            openMenuAt(e)
                            setOpenMemberMenu(openMemberMenu === memberKey ? null : memberKey)
                          }}
                          title="更多操作"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                            <circle cx="5" cy="12" r="1" />
                          </svg>
                        </button>
                        {openMemberMenu === memberKey && createPortal(
                          <div
                            className="member-actions-menu"
                            style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button className="menu-item" onClick={() => { setCurrentRole(role); setCurrentMember(member); setNewMemberName(member.name || ''); setEditMemberRole(role); setShowRenameMemberModal(true); setOpenMemberMenu(null); }} style={typeof onRenameMember !== 'function' ? { display: 'none' } : undefined}>编辑</button>
                            <button className="menu-item delete-item" onClick={() => { handleDeleteMember(role, member); setOpenMemberMenu(null); }} style={typeof onDeleteMember !== 'function' ? { display: 'none' } : undefined}>删除</button>
                          </div>,
                          document.body
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      {showAddRoleModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowAddRoleModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">添加角色</span>
              <button className="modal-close" onClick={() => setShowAddRoleModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                className="modal-input"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="请输入角色名称"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddRole() }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowAddRoleModal(false)}>取消</button>
              <button className="btn-save" onClick={handleAddRole}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showAddMemberModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowAddMemberModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">添加成员</span>
              <button className="modal-close" onClick={() => setShowAddMemberModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <span className="form-label">角色：</span>
                <span className="form-value">{currentRole}</span>
              </div>
              <input
                type="text"
                className="modal-input"
                value={newMemberName}
                onChange={(e) => setNewMemberName(e.target.value)}
                placeholder="请输入成员姓名"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddMember() }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowAddMemberModal(false)}>取消</button>
              <button className="btn-save" onClick={handleAddMember}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowRenameModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">重命名角色</span>
              <button className="modal-close" onClick={() => setShowRenameModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                className="modal-input"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                placeholder="请输入新角色名称"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameRole() }}
              />
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowRenameModal(false)}>取消</button>
              <button className="btn-save" onClick={handleRenameRole}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowDeleteModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="confirm-head">
              <svg className="confirm-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="modal-title">删除角色</span>
            </div>
            <div className="confirm-desc">
              <p>确定要删除角色「{currentRole}」吗？{(groupedByRole[currentRole] || []).length > 0 ? `删除后该角色下的 ${groupedByRole[currentRole].length} 名成员将一起被删除。` : ''}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowDeleteModal(false)}>取消</button>
              <button className="btn-delete" onClick={handleDeleteRole}>删除</button>
            </div>
          </div>
        </div>
      )}

      {showRenameMemberModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowRenameMemberModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">编辑成员</span>
              <button className="modal-close" onClick={() => setShowRenameMemberModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <span className="form-label">角色：</span>
                {/* 待分配成员（姓名为空）不允许修改角色，仅显示当前角色 */}
                {currentMember && !currentMember.name ? (
                  <span className="form-value">{editMemberRole}</span>
                ) : (
                <div className="role-search-wrapper" ref={editRoleDropdownRef}>
                  <div
                    className="role-search-trigger"
                    onClick={() => {
                      setEditRoleDropdownOpen(!editRoleDropdownOpen)
                      setEditRoleSearch('')
                    }}
                  >
                    <span className={editMemberRole ? '' : 'placeholder'}>
                      {editMemberRole || '请选择角色'}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                  {editRoleDropdownOpen && (
                    <div className="role-dropdown">
                      <input
                        type="text"
                        className="role-search-input"
                        placeholder="搜索或添加角色"
                        value={editRoleSearch}
                        onChange={(e) => setEditRoleSearch(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && editRoleSearch.trim()) {
                            const filtered = Object.keys(groupedByRole)
                              .filter(r => r.toLowerCase().includes(editRoleSearch.toLowerCase()))
                            if (filtered.length === 0) {
                              setEditMemberRole(editRoleSearch.trim())
                              setEditRoleDropdownOpen(false)
                              setTimeout(() => editMemberNameRef.current?.focus(), 0)
                            }
                          }
                        }}
                      />
                      <div className="role-list">
                        {Object.keys(groupedByRole)
                          .filter(role => role.toLowerCase().includes(editRoleSearch.toLowerCase()))
                          .map(role => (
                            <div
                              key={role}
                              className={`role-option ${editMemberRole === role ? 'selected' : ''}`}
                              onClick={() => {
                                setEditMemberRole(role)
                                setEditRoleDropdownOpen(false)
                                setTimeout(() => editMemberNameRef.current?.focus(), 0)
                              }}
                            >
                              {role}
                            </div>
                          ))
                        }
                        {Object.keys(groupedByRole)
                          .filter(role => role.toLowerCase().includes(editRoleSearch.toLowerCase()))
                          .length === 0 && editRoleSearch.trim() && (
                            <div
                              className="role-option create-option"
                              onClick={() => {
                                setEditMemberRole(editRoleSearch.trim())
                                setEditRoleDropdownOpen(false)
                                setTimeout(() => editMemberNameRef.current?.focus(), 0)
                              }}
                            >
                              <span className="create-label">创建角色</span>
                              <span className="create-name">{editRoleSearch.trim()}</span>
                            </div>
                          )
                        }
                      </div>
                    </div>
                  )}
                </div>
                )}
              </div>
              <div className="form-row">
                <span className="form-label">成员：</span>
                <input
                  type="text"
                  className="modal-input"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="请输入成员姓名"
                  ref={editMemberNameRef}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRenameMember() }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowRenameMemberModal(false)}>取消</button>
              <button className="btn-save" onClick={handleRenameMember}>确定</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteMemberModal && (
        <div className="modal-overlay centered-modal-overlay" onClick={() => setShowDeleteMemberModal(false)}>
          <div className="modal-content small-modal centered-modal-content" onClick={e => e.stopPropagation()}>
            <div className="confirm-head">
              <svg className="confirm-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="modal-title">删除成员</span>
            </div>
            <div className="confirm-desc">
              {deleteLoading ? (
                <p>正在查询成员任务...</p>
              ) : !currentMember?.name ? (
                <p>确认要删除该成员吗？删除后对应角色「{currentRole}」将一起被删除</p>
              ) : deleteTaskSummary && deleteTaskSummary.taskList.length > 0 ? (
                <p>成员「{currentMember?.name}」负责 <strong>{deleteTaskSummary.taskList.length}</strong> 个任务，共 <strong>{formatHoursByUnit(deleteTaskSummary.totalHours, timeRuleUnit)}</strong> 工时。请选择任务处理方式：</p>
              ) : (
                <p>确定要删除成员「{currentMember?.name}」吗？</p>
              )}
            </div>
            {!deleteLoading && currentMember?.name && deleteTaskSummary && deleteTaskSummary.taskList.length > 0 && (
              <div className="modal-body">
                <div className="reassign-radio-group">
                  <label className="reassign-radio-item">
                    <input
                      type="radio"
                      name="reassignMode"
                      value="assign"
                      checked={reassignMode === 'assign'}
                      onChange={() => setReassignMode('assign')}
                    />
                    <span>分配给其他成员</span>
                  </label>
                  {reassignMode === 'assign' && (
                    <div className="reassign-select-wrapper">
                      <CustomSelect
                        value={reassignTarget}
                        onChange={(value) => setReassignTarget(value)}
                        options={teamMembers
                          .filter(m => m.name !== currentMember?.name)
                          .map(m => ({
                            value: `${m.role}-${m.name}`,
                            role: m.role,
                            name: m.name || '待分配',
                            avatar: m.avatar || '?'
                          }))
                        }
                        placeholder="选择成员"
                      />
                    </div>
                  )}
                  <label className="reassign-radio-item">
                    <input
                      type="radio"
                      name="reassignMode"
                      value="none"
                      checked={reassignMode === 'none'}
                      onChange={() => setReassignMode('none')}
                    />
                    <span>暂不分配</span>
                  </label>
                </div>
              </div>
            )}
            <div className="modal-footer">
              <button className="btn-cancel" onClick={() => setShowDeleteMemberModal(false)}>取消</button>
              <button className="btn-delete" onClick={confirmDeleteMember}>删除</button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="member-list-toast">{toast}</div>
      )}
    </div>
  )
}

export default MemberList