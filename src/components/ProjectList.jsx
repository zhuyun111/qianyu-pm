import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProjects, createProject, getProjectMembers, getTasksByProject, getTaskResourcesByProject, getExecStatusByProject } from '../utils/db'

// 项目类型 → 卡片图标底色（与主题紫色系区分，按类型区分色相）
const TYPE_META = {
  SINGLE: { label: '个人项目', color: '#8b5cf6', bg: '#f0ebf9' },
  MULTI: { label: '团队项目', color: '#0ea5e9', bg: '#e6f4fb' },
  EXTERNAL: { label: '外部项目', color: '#f59e0b', bg: '#fdf4e2' }
}

function ProjectList() {
  const [projects, setProjects] = useState([])
  const [searchText, setSearchText] = useState('')
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    setLoading(true)
    try {
      const data = await getProjects()
      // 每个项目补充：团队人数 / 总工时 / 项目周期 / 整体完成进度
      const enriched = await Promise.all(data.map(async p => {
        try {
          const [members, tasks, resources, execRows] = await Promise.all([
            getProjectMembers(p.project_ulid),
            getTasksByProject(p.project_ulid),
            getTaskResourcesByProject(p.project_ulid),
            getExecStatusByProject(p.project_ulid)
          ])
          const totalHours = resources.reduce((s, r) => s + (r.hours || 0), 0)
          const starts = tasks.map(t => t.start_date).filter(Boolean)
          const ends = tasks.map(t => t.end_date).filter(Boolean)
          const startDate = starts.length ? starts.reduce((a, b) => a < b ? a : b) : null
          const endDate = ends.length ? ends.reduce((a, b) => a > b ? a : b) : null
          // 整体进度：叶子任务（无子任务）中，已完成任务的工时 / 全部叶子任务工时
          const parentIds = new Set(tasks.map(t => t.parent_task_ulid).filter(Boolean))
          const leafById = new Map()
          for (const t of tasks) {
            if (!parentIds.has(t.task_ulid)) {
              leafById.set(t.task_ulid, t.original_task_id || t.task_ulid)
            }
          }
          const execMap = new Map((execRows || []).map(r => [r.original_task_id, r.exec_status]))
          let doneHours = 0, leafHours = 0
          for (const r of resources) {
            if (!leafById.has(r.task_ulid)) continue
            const h = r.hours || 0
            leafHours += h
            if (execMap.get(leafById.get(r.task_ulid)) === 'completed') doneHours += h
          }
          const progress = leafHours > 0 ? Math.round(doneHours / leafHours * 100) : 0
          return { ...p, memberCount: members.length, totalHours, startDate, endDate, progress }
        } catch (e) {
          console.error('Failed to load project stats:', e)
          return { ...p, memberCount: 0, totalHours: 0, startDate: null, endDate: null, progress: 0 }
        }
      }))
      setProjects(enriched)
    } catch (error) {
      console.error('Failed to load projects:', error)
      setProjects([])
    }
    setLoading(false)
  }

  // 点击「新建项目」直接创建（默认名称，进入排期页后可在顶部改名）并进入该项目的任务排期页面
  async function handleCreateProject() {
    try {
      const project = await createProject('未命名项目', '', 'SINGLE')
      // 通知侧边栏项目模块刷新
      window.dispatchEvent(new Event('pmflow:projects-changed'))
      // 新标签页打开任务排期流程的 WBS 分解页面
      window.open(`/wbs?projectId=${project.project_ulid}`, '_blank')
      loadProjects()
    } catch (error) {
      console.error('Failed to create project:', error)
      alert('创建项目失败，请重试')
    }
  }

  const getTypeLabel = (type) => {
    const labels = {
      'SINGLE': '个人项目',
      'MULTI': '团队项目',
      'EXTERNAL': '外部项目'
    }
    return labels[type] || type
  }

  const formatHours = (h) => {
    const n = Number(h) || 0
    return (Number.isInteger(n) ? n : Math.round(n * 10) / 10) + 'h'
  }

  const handleViewProject = (projectUlid) => {
    navigate(`/project/${projectUlid}`)
  }

  const filtered = projects.filter(p => {
    if (!searchText.trim()) return true
    const kw = searchText.trim().toLowerCase()
    return (p.name || '').toLowerCase().includes(kw) ||
      (p.description || '').toLowerCase().includes(kw) ||
      getTypeLabel(p.type).toLowerCase().includes(kw)
  })

  return (
    <div className="project-list-page">
      <div className="pl-toolbar">
        <div className="pl-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            placeholder="搜索项目名称 / 描述 / 类型..."
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
          {searchText && (
            <button className="pl-search-clear" onClick={() => setSearchText('')} title="清空">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          )}
        </div>
        <button className="pl-create-btn" onClick={handleCreateProject}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          新建项目
        </button>
      </div>

      {loading ? (
        <div className="pl-empty">
          <div className="pl-empty-text">加载中...</div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pl-empty">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <div className="pl-empty-text">
            {projects.length === 0 ? '暂无项目，点击右上角「新建项目」创建' : '没有匹配的项目，换个关键词试试'}
          </div>
        </div>
      ) : (
        <div className="pl-grid">
          {filtered.map(project => {
            const meta = TYPE_META[project.type] || TYPE_META.SINGLE
            return (
              <div key={project.project_ulid} className="pl-card" onClick={() => handleViewProject(project.project_ulid)}>
                <div className="pl-card-top">
                  <div className="pl-card-icon" style={{ background: meta.bg, color: meta.color }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                    </svg>
                  </div>
                  <span className="pl-card-type" style={{ background: meta.bg, color: meta.color }} title="任务整体进度（已完成叶子任务工时 / 叶子任务总工时）">{project.progress || 0}%</span>
                </div>
                <div className="pl-card-name" title={project.name}>{project.name}</div>
                <div className="pl-card-stats">
                  <span className="pl-card-stat" title="团队人数">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                      <circle cx="9" cy="7" r="4"/>
                      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                    </svg>
                    {project.memberCount || 0}人
                  </span>
                  <span className="pl-card-stat" title="总工时">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {formatHours(project.totalHours)}
                  </span>
                </div>
                <div className="pl-card-bottom">
                  <span className="pl-card-period" title="项目周期">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                      <line x1="16" y1="2" x2="16" y2="6"/>
                      <line x1="8" y1="2" x2="8" y2="6"/>
                      <line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                    {(project.startDate || project.endDate) ? `${project.startDate || '?'} ~ ${project.endDate || '?'}` : '暂无排期'}
                  </span>
                  <span className="pl-card-enter">
                    进入项目
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

    </div>
  )
}

export default ProjectList
