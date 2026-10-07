import { useState } from 'react'

const initialTeamMembers = [
  { id: 1, role: '项目经理', name: '张三', avatar: 'Z', taskCount: 5 },
  { id: 2, role: '前端开发', name: '李四', avatar: 'L', taskCount: 8 },
  { id: 3, role: '前端开发', name: '王五', avatar: 'W', taskCount: 6 },
  { id: 4, role: '后端开发', name: '赵六', avatar: 'Z', taskCount: 10 },
  { id: 5, role: 'UI设计', name: '钱七', avatar: 'Q', taskCount: 3 },
  { id: 6, role: '测试工程师', name: '', avatar: '', taskCount: 0 },
]

function TeamMembers({ onClose }) {
  const [members, setMembers] = useState(initialTeamMembers)
  const [editingId, setEditingId] = useState(null)
  const [editingData, setEditingData] = useState({ role: '', name: '' })
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormData, setAddFormData] = useState({ role: '', name: '' })

  const handleEdit = (member) => {
    setEditingId(member.id)
    setEditingData({ role: member.role, name: member.name })
  }

  const handleSaveEdit = (id) => {
    setMembers(prev => prev.map(m => {
      if (m.id === id) {
        const newAvatar = editingData.name ? editingData.name.charAt(0).toUpperCase() : ''
        return { ...m, ...editingData, avatar: newAvatar }
      }
      return m
    }))
    setEditingId(null)
    setEditingData({ role: '', name: '' })
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingData({ role: '', name: '' })
  }

  const handleDelete = (id) => {
    setMembers(prev => prev.filter(m => m.id !== id))
  }

  const handleAdd = () => {
    const newAvatar = addFormData.name ? addFormData.name.charAt(0).toUpperCase() : ''
    const newMember = {
      id: Date.now(),
      role: addFormData.role,
      name: addFormData.name,
      avatar: newAvatar,
      taskCount: 0
    }
    setMembers(prev => [...prev, newMember])
    setShowAddForm(false)
    setAddFormData({ role: '', name: '' })
  }

  const handleInputChange = (e, isAddForm = false) => {
    const { name, value } = e.target
    if (isAddForm) {
      setAddFormData(prev => ({ ...prev, [name]: value }))
    } else {
      setEditingData(prev => ({ ...prev, [name]: value }))
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content team-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>团队成员</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {showAddForm && (
            <div className="add-form">
              <div className="form-row">
                <label>角色名称</label>
                <input
                  type="text"
                  name="role"
                  value={addFormData.role}
                  onChange={(e) => handleInputChange(e, true)}
                  placeholder="请输入角色名称"
                />
              </div>
              <div className="form-row">
                <label>成员姓名</label>
                <input
                  type="text"
                  name="name"
                  value={addFormData.name}
                  onChange={(e) => handleInputChange(e, true)}
                  placeholder="请输入成员姓名（可选）"
                />
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" onClick={handleAdd}>添加</button>
                <button className="btn btn-secondary" onClick={() => setShowAddForm(false)}>取消</button>
              </div>
            </div>
          )}
          <div className="team-table-container">
            <table className="team-table">
              <thead>
                <tr>
                  <th>角色名称</th>
                  <th>成员姓名</th>
                  <th>任务数量</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>
                      {editingId === member.id ? (
                        <input
                          type="text"
                          name="role"
                          value={editingData.role}
                          onChange={(e) => handleInputChange(e)}
                          className="edit-input"
                        />
                      ) : (
                        member.role
                      )}
                    </td>
                    <td>
                      {editingId === member.id ? (
                        <input
                          type="text"
                          name="name"
                          value={editingData.name}
                          onChange={(e) => handleInputChange(e)}
                          className="edit-input"
                          placeholder="待分配"
                        />
                      ) : (
                        <div className="member-info">
                          <span className={`avatar ${!member.name ? 'empty-avatar' : ''}`}>
                            {member.name ? member.avatar : '?'}
                          </span>
                          <span className={`member-name ${!member.name ? 'empty-name' : ''}`}>
                            {member.name || '待分配'}
                          </span>
                        </div>
                      )}
                    </td>
                    <td>{member.taskCount} 个</td>
                    <td>
                      {editingId === member.id ? (
                        <div className="action-buttons">
                          <button className="btn btn-sm btn-primary" onClick={() => handleSaveEdit(member.id)}>保存</button>
                          <button className="btn btn-sm btn-secondary" onClick={handleCancelEdit}>取消</button>
                        </div>
                      ) : (
                        <div className="action-buttons">
                          <button className="btn btn-sm btn-edit" onClick={() => handleEdit(member)}>编辑</button>
                          <button className="btn btn-sm btn-delete" onClick={() => handleDelete(member.id)}>删除</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="add-role-btn" onClick={() => setShowAddForm(true)}>
            + 添加角色
          </button>
        </div>
      </div>
    </div>
  )
}

export default TeamMembers