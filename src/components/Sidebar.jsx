import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { initDefaultData, getProjects, createProject, updateRecord, deleteProjectFully, clearProjectPlanData } from '../utils/db'
// 二维码：替换 src/assets 下同名图片文件即可（png/jpg 均可，同步改 import 路径）
import qrOfficialAccount from '../assets/qr-official-account.jpg'
import qrDeveloper from '../assets/qr-developer.png'

// 更多操作图标（横向三点），悬停项目名称时显示在右侧
const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="5" cy="12" r="1.6"/>
    <circle cx="12" cy="12" r="1.6"/>
    <circle cx="19" cy="12" r="1.6"/>
  </svg>
)

// 新建项目图标（加号）
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/>
    <line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
)

// 侧边栏（开源核心版）：logo + 项目模块 + 底部用户区。
// 官方版经 createApp 注入扩展点：
// - extraNavItems: 侧栏固定菜单插槽（官方版渲染 工作台/日历/专注 等菜单项）
// - extraUserMenuItems: 底部用户菜单追加项 [{ label, onClick }]（如 产品官网/关于我们）
function Sidebar({ collapsed = false, onToggleCollapse, extraNavItems = null, extraUserMenuItems = [] }) {
  const navigate = useNavigate()
  const location = useLocation()
  // 当前用户（本地默认用户：名称 + uuid）
  const [userInfo, setUserInfo] = useState(null)
  // 项目列表（侧边栏项目模块）
  const [projects, setProjects] = useState([])
  // 展开更多操作菜单的项目
  const [openMenuProjectId, setOpenMenuProjectId] = useState(null)
  // 正在重命名的项目
  const [editingProjectId, setEditingProjectId] = useState(null)
  const [editName, setEditName] = useState('')
  const renameInputRef = useRef(null)
  // 待删除项目（二次确认弹窗）
  const [pendingDeleteProject, setPendingDeleteProject] = useState(null)
  // 待清空进度计划的项目（二次确认弹窗）
  const [pendingClearPlanProject, setPendingClearPlanProject] = useState(null)
  // 底部用户区箭头菜单展开状态 / 清除数据二次确认弹窗
  const [openUserMenu, setOpenUserMenu] = useState(false)
  const [pendingClearData, setPendingClearData] = useState(false)
  // 「关于我们」弹窗（产品公众号二维码 + 开发者微信二维码）
  const [showAboutModal, setShowAboutModal] = useState(false)

  // 加载当前用户与项目列表：挂载时、路由变化时、以及项目数据变化事件时刷新
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { adminUser } = await initDefaultData()
        if (!cancelled) setUserInfo({ name: adminUser.name, uuid: adminUser.local_ulid })
      } catch (e) {
        console.error('加载用户信息失败:', e)
      }
      try {
        const list = await getProjects()
        if (!cancelled) setProjects(list)
      } catch (e) {
        console.error('加载项目列表失败:', e)
      }
    })()
    return () => { cancelled = true }
  }, [location.pathname])

  // 项目数据在其他页面（项目列表/项目主页）发生增删改时，通过该事件刷新侧边栏
  useEffect(() => {
    const handler = () => {
      getProjects().then(list => setProjects(list)).catch(() => {})
    }
    window.addEventListener('pmflow:projects-changed', handler)
    return () => window.removeEventListener('pmflow:projects-changed', handler)
  }, [])

  // 重命名输入框自动聚焦
  useEffect(() => {
    if (editingProjectId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [editingProjectId])

  // 点击其他区域关闭更多操作菜单 / 用户菜单
  useEffect(() => {
    if (!openMenuProjectId && !openUserMenu) return
    const handler = () => { setOpenMenuProjectId(null); setOpenUserMenu(false) }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [openMenuProjectId, openUserMenu])

  // 新建项目：与项目列表「新建项目」一致，创建后进入任务排期流程的 WBS 分解页面
  const handleAddProject = async () => {
    try {
      const project = await createProject('未命名项目', '', 'SINGLE')
      window.open(`/wbs?projectId=${project.project_ulid}`, '_blank')
      const list = await getProjects()
      setProjects(list)
    } catch (e) {
      console.error('创建项目失败:', e)
      alert('创建项目失败，请重试')
    }
  }

  // 保存项目重命名
  const handleRenameSave = async () => {
    const project = projects.find(p => p.project_ulid === editingProjectId)
    const newName = editName.trim()
    if (project && newName && newName !== project.name) {
      try {
        await updateRecord('projects', { ...project, name: newName })
        setProjects(prev => prev.map(p =>
          p.project_ulid === project.project_ulid ? { ...p, name: newName } : p
        ))
        window.dispatchEvent(new Event('pmflow:projects-changed'))
      } catch (e) {
        console.error('修改项目名称失败:', e)
      }
    }
    setEditingProjectId(null)
  }

  // 确认删除项目
  const handleDeleteConfirm = async () => {
    if (!pendingDeleteProject) return
    const deletedId = pendingDeleteProject.project_ulid
    try {
      await deleteProjectFully(deletedId)
      setProjects(prev => prev.filter(p => p.project_ulid !== deletedId))
      window.dispatchEvent(new Event('pmflow:projects-changed'))
      // 若当前正处于被删除项目的页面，跳回项目列表
      if (location.pathname === `/project/${deletedId}`) {
        navigate('/projects')
      }
    } catch (e) {
      console.error('删除项目失败:', e)
      alert('删除项目失败，请重试')
    }
    setPendingDeleteProject(null)
  }

  // 确认清空项目进度计划：删除该项目的计划版本、任务及完成情况数据，保留项目本身与成员
  const handleClearPlanConfirm = async () => {
    if (!pendingClearPlanProject) return
    const targetId = pendingClearPlanProject.project_ulid
    try {
      await clearProjectPlanData(targetId)
      window.dispatchEvent(new Event('pmflow:projects-changed'))
      // 通知项目主页重载数据并展示「清空成功」提示
      window.dispatchEvent(new CustomEvent('pmflow:project-data-cleared', { detail: { projectId: targetId } }))
    } catch (e) {
      console.error('清空项目进度计划失败:', e)
      alert('清空项目数据失败，请重试')
    }
    setPendingClearPlanProject(null)
  }

  // 确认清除本地数据：删除当前本地用户的全部项目及其计划数据
  const handleClearDataConfirm = async () => {
    try {
      const list = await getProjects()
      for (const p of list) {
        await deleteProjectFully(p.project_ulid)
      }
      setProjects([])
      setOpenUserMenu(false)
      window.dispatchEvent(new Event('pmflow:projects-changed'))
      // 若当前正处于某项目页面，跳回项目列表
      if (location.pathname.startsWith('/project/')) {
        navigate('/projects')
      }
    } catch (e) {
      console.error('清除本地数据失败:', e)
      alert('清除数据失败，请重试')
    }
    setPendingClearData(false)
  }

  return (
    <>
      <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <div className="sidebar-header">
          {/* logo 区：产品名 + 本地存储提示语，整体在顶栏高度内垂直居中 */}
          {/* logo 区：小 logo + 产品名同一行，垂直居中，点击跳项目列表 */}
          <div className="sidebar-logo-block">
            <img className="sidebar-logo-img" src="/logo.svg" alt="千羽PM logo" onClick={() => navigate('/projects')} />
            <span className="sidebar-logo" onClick={() => navigate('/projects')}>千羽PM</span>
          </div>
          {/* 收起/展开左侧菜单：状态由 App 管理，收起后整栏隐藏，展开按钮内嵌在顶部导航条 */}
          <button
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title="收起菜单"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
        </div>

      {/* 侧栏固定菜单插槽：开源核心无固定菜单；官方版经 createApp 注入
          renderSidebarNavItems（工作台/日历/专注 等菜单项渲染在此处） */}
      {extraNavItems}

      {/* 项目模块：固定菜单下方，展示全部项目，支持滚动 */}
      <div className="sidebar-projects">
        <div className="sidebar-projects-label">
          <span
            className={`sidebar-projects-title ${location.pathname === '/projects' ? 'active' : ''}`}
            title="查看项目列表"
            onClick={() => navigate('/projects')}
          >项目（{projects.length}）</span>
          <button className="sidebar-projects-add" title="添加项目" onClick={handleAddProject}>
            <PlusIcon />
          </button>
        </div>
        <div className="sidebar-projects-list">
          {projects.map(p => {
            const isActive = location.pathname === `/project/${p.project_ulid}`
            return (
              <div
                key={p.project_ulid}
                className={`sidebar-project-item ${isActive ? 'active' : ''} ${openMenuProjectId === p.project_ulid ? 'menu-open' : ''}`}
              >
                {editingProjectId === p.project_ulid ? (
                  <input
                    ref={renameInputRef}
                    className="sidebar-project-rename-input"
                    value={editName}
                    maxLength={50}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameSave()
                      else if (e.key === 'Escape') setEditingProjectId(null)
                    }}
                    onBlur={handleRenameSave}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <button
                      className={`sidebar-project-name ${isActive ? 'active' : ''}`}
                      title={p.name}
                      onClick={() => navigate(`/project/${p.project_ulid}`)}
                    >
                      {p.name || '未命名项目'}
                    </button>
                  <button
                    className="sidebar-project-more"
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuProjectId(v => v === p.project_ulid ? null : p.project_ulid)
                    }}
                  >
                    <MoreIcon />
                  </button>
                  {openMenuProjectId === p.project_ulid && (
                    <div className="member-actions-menu sidebar-project-menu" onClick={(e) => e.stopPropagation()}>
                      <button className="menu-item" onClick={() => {
                        setEditName(p.name || '')
                        setEditingProjectId(p.project_ulid)
                        setOpenMenuProjectId(null)
                      }}>修改项目名称</button>
                      <button className="menu-item" onClick={() => {
                        setOpenMenuProjectId(null)
                        // 进入任务排期流程的 WBS 分解页面（新标签页，与项目列表新建项目行为一致）
                        window.open(`/wbs?projectId=${p.project_ulid}`, '_blank')
                      }}>修改进度计划</button>
                      <button className="menu-item" onClick={() => {
                        setOpenMenuProjectId(null)
                        setPendingClearPlanProject(p)
                      }}>清空项目数据</button>
                      <button className="menu-item delete-item" onClick={() => {
                        setOpenMenuProjectId(null)
                        setPendingDeleteProject(p)
                      }}>删除项目</button>
                    </div>
                  )}
                </>
              )}
              </div>
            )
          })}
          {projects.length === 0 && (
            <div className="sidebar-projects-empty">暂无项目</div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="user-profile">
          <div className="user-avatar">
            {/* 内联 SVG 头像（本地绘制，无外部请求，替代原 DiceBear 在线头像） */}
            <svg className="user-avatar-svg" viewBox="0 0 36 36" width="100%" height="100%" role="img" aria-label="用户头像">
              <rect width="36" height="36" fill="#8b5cf6" />
              <circle cx="18" cy="13.5" r="6.5" fill="#ffffff" opacity="0.95" />
              <path d="M5 36 C5 27.7 10.8 22.5 18 22.5 C25.2 22.5 31 27.7 31 36 Z" fill="#ffffff" opacity="0.95" />
            </svg>
          </div>
          <div className="user-info">
            <div className="user-name-row">
              <span className="user-name">{userInfo?.name || 'admin'}</span>
            </div>
            <span className="user-motto">本地用户</span>
          </div>
          {/* 点击箭头展开用户菜单（清除数据 / 产品官网），展开时箭头翻转朝上 */}
          <button
            className={`user-arrow ${openUserMenu ? 'open' : ''}`}
            title="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              setOpenUserMenu(v => !v)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          {openUserMenu && (
            <div className="member-actions-menu sidebar-user-menu" onClick={(e) => e.stopPropagation()}>
              <button className="menu-item" onClick={() => {
                setOpenUserMenu(false)
                setPendingClearData(true)
              }}>清除数据</button>
              {/* 内置：产品官网 / 关于我们（开源核心与官方版共用） */}
              <button className="menu-item" onClick={() => {
                setOpenUserMenu(false)
                window.open('https://www.qianyupm.top/', '_blank')
              }}>产品官网</button>
              <button className="menu-item" onClick={() => {
                setOpenUserMenu(false)
                setShowAboutModal(true)
              }}>关于我们</button>
              {/* 官方版经 createApp 注入的追加用户菜单项 */}
              {extraUserMenuItems.map((item, i) => (
                <button key={i} className="menu-item" onClick={(e) => {
                  e.stopPropagation()
                  setOpenUserMenu(false)
                  item.onClick && item.onClick(e)
                }}>{item.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 删除项目二次确认弹窗（复用二次确认弹窗组件样式）。
          用 portal 挂到 body：侧边栏自身是 z-index:100 的层叠上下文，
          弹窗若渲染在内部会被外部同层级(如项目主页顶栏)元素盖住遮罩 */}
      {pendingDeleteProject && createPortal(
        <div className="time-rule-confirm-overlay" onClick={() => setPendingDeleteProject(null)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">
              确定要删除项目「{pendingDeleteProject.name || '未命名项目'}」吗？删除后该项目的全部计划数据将无法恢复。
            </p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => setPendingDeleteProject(null)}>取消</button>
              <button className="btn-save" onClick={handleDeleteConfirm}>确认删除</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 清空项目进度计划二次确认弹窗（复用同一弹窗样式，portal 到 body） */}
      {pendingClearPlanProject && createPortal(
        <div className="time-rule-confirm-overlay" onClick={() => setPendingClearPlanProject(null)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">
              是否确认清空项目「{pendingClearPlanProject.name || '未命名项目'}」的进度计划数据？清空后将删除该项目的全部计划版本、任务及完成情况数据，且无法恢复。
            </p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => setPendingClearPlanProject(null)}>取消</button>
              <button className="btn-save" onClick={handleClearPlanConfirm}>确认清空</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 清除本地数据二次确认弹窗（复用同一弹窗样式，portal 到 body） */}
      {pendingClearData && createPortal(
        <div className="time-rule-confirm-overlay" onClick={() => setPendingClearData(false)}>
          <div className="time-rule-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <p className="time-rule-confirm-text">
              是否确认清除本地项目数据？清除后将删除全部项目及其计划数据，且无法恢复。
            </p>
            <div className="time-rule-confirm-actions">
              <button className="btn-cancel" onClick={() => setPendingClearData(false)}>取消</button>
              <button className="btn-save" onClick={handleClearDataConfirm}>确认清除</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 关于我们弹窗：产品公众号二维码 + 开发者微信二维码（portal 到 body） */}
      {showAboutModal && createPortal(
        <div className="time-rule-confirm-overlay" onClick={() => setShowAboutModal(false)}>
          <div className="about-modal" onClick={(e) => e.stopPropagation()}>
            <div className="about-title">关于我们</div>
            <p className="about-desc">
              千羽 - 轻量级在线项目排期工具<br />
              官网：<a href="https://www.qianyupm.top" target="_blank" rel="noopener noreferrer">www.qianyupm.top</a>
            </p>
            <div className="about-qr-row">
              <div className="about-qr-item">
                <img src={qrOfficialAccount} alt="微信公众号二维码" />
                <span>微信公众号</span>
              </div>
              <div className="about-qr-item">
                <img src={qrDeveloper} alt="开发者微信二维码" />
                <span>开发者微信</span>
              </div>
            </div>
            <p className="about-tip">扫码关注公众号，或添加开发者微信交流</p>
          </div>
        </div>,
        document.body
      )}
      </aside>
    </>
  )
}

export default Sidebar
