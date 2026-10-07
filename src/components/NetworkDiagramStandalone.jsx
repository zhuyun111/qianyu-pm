import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import ReactFlow, {
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  Handle,
  Position,
} from 'reactflow'
import 'reactflow/dist/style.css'
import TaskDetailPopup from './TaskDetailPopup'
import PlanningHeaderStats from './PlanningHeaderStats'
import MemberList from './MemberList'
import { getProjectById, updateRecord, upsertTaskContent } from '../utils/db'
import { buildLeaves, computeCriticalPath, calcCustomDurationExceeded, computeEndFromDuration, autoDurationDaysOf, findTaskPath, findTaskParent } from '../utils/schedule'

const NODE_HEIGHT = 50
const NODE_HEIGHT_COMPACT = 26

const updateNodeResources = (nodes, id, updater) => {
  return (nodes || []).map(node => {
    if (node.id === id) {
      return { ...node, resources: updater(node.resources || []) }
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeResources(node.children, id, updater) }
    }
    return node
  })
}

const updateNodeFields = (nodes, id, patch) => {
  return (nodes || []).map(node => {
    if (node.id === id) {
      return { ...node, ...patch }
    }
    if (node.children && node.children.length > 0) {
      return { ...node, children: updateNodeFields(node.children, id, patch) }
    }
    return node
  })
}

const findNodeInTree = (nodes, id) => {
  for (const node of (nodes || [])) {
    if (node.id === id) return node
    const found = findNodeInTree(node.children || [], id)
    if (found) return found
  }
  return null
}

const CustomNode = ({ data }) => {
  const isStartEnd = data.code === 'START' || data.code === 'END'
  const startEndLabel = data.code === 'START' ? '开始' : data.code === 'END' ? '结束' : null
  const ancestorPath = (data.ancestors || []).join(' / ')
  const showName = data.showName !== false
  const isCritical = data.isCritical
  const [hovered, setHovered] = useState(false)
  const [tipPos, setTipPos] = useState({ x: 0, y: 0 })
  const nodeRef = useRef(null)

  const isCompleted = data.status === 'completed'
  const badgeStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: isStartEnd ? '#F3F4F6' : (isCompleted ? '#DCFCE7' : (isCritical ? '#F3E8FF' : '#EEF2FF')),
    border: `1.5px solid ${isStartEnd ? '#D1D5DB' : (isCompleted ? '#4ADE80' : (isCritical ? '#8B5CF6' : '#818CF8'))}`,
    borderRadius: '20px',
    padding: isStartEnd ? '4px 14px' : (showName ? '4px 12px' : '3px 10px'),
    fontSize: isStartEnd ? '12px' : (showName ? '13px' : '11px'),
    fontWeight: 700,
    color: isStartEnd ? '#6B7280' : (isCompleted ? '#16A34A' : (isCritical ? '#7C3AED' : '#4F46E5')),
    whiteSpace: 'nowrap',
    cursor: isStartEnd ? 'default' : 'pointer',
  }

  const hoverTitle = showName ? undefined : (ancestorPath ? `${ancestorPath} / ${data.name}` : data.name)

  const handleStyle = { width: 6, height: 6, background: '#CBD5E1', border: '1.5px solid white', cursor: 'crosshair', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }
  const handleStyleLarge = { width: 8, height: 8, background: '#CBD5E1', border: '2px solid white', cursor: 'crosshair', opacity: hovered ? 1 : 0, transition: 'opacity 0.15s' }

  const handleClick = (e) => {
    e.stopPropagation()
    // 已完成任务锁定，点击不打开任务详情设置弹窗
    if (!isStartEnd && data.onNodeClick && !isCompleted) {
      data.onNodeClick(data)
    }
  }

  const handleMouseEnter = () => {
    if (!hoverTitle || !nodeRef.current) return
    const rect = nodeRef.current.getBoundingClientRect()
    setTipPos({ x: rect.left + rect.width / 2, y: rect.top })
    setHovered(true)
  }

  const handleMouseLeave = () => setHovered(false)

  if (isStartEnd) {
    return (
      <div
        style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        <div style={badgeStyle}>{startEndLabel}</div>
        <Handle type="source" position={Position.Right} style={handleStyle} />
      </div>
    )
  }

  if (!showName) {
    return (
      <>
        <div ref={nodeRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} onClick={handleClick} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
          <Handle type="target" position={Position.Left} style={handleStyle} />
          <div style={{ ...badgeStyle, gap: '3px' }}>
            {data.code}
            {data.taskType === '里程碑' && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
                <line x1="4" y1="22" x2="4" y2="15"/>
              </svg>
            )}
          </div>
          <Handle type="source" position={Position.Right} style={handleStyle} />
        </div>
        {hovered && hoverTitle && createPortal(
          <div className="network-node-tooltip" style={{ position: 'fixed', left: tipPos.x, top: tipPos.y - 8, transform: 'translateX(-50%) translateY(-100%)' }}>
            {ancestorPath && <div style={{ color: '#6B7280', fontSize: '11px' }}>{ancestorPath}</div>}
            <div style={{ fontWeight: 600, color: '#1F2937' }}>{data.name}</div>
          </div>,
          document.body
        )}
      </>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: isCompleted ? '#F0FDF4' : (isCritical ? '#FAF5FF' : 'white'),
        border: `1.5px solid ${isCompleted ? '#4ADE80' : (isCritical ? '#A78BFA' : '#E2E8F0')}`,
        borderRadius: '8px',
        padding: '8px 14px',
        boxShadow: isCompleted ? '0 1px 6px rgba(34,197,94,0.2)' : (isCritical ? '0 1px 6px rgba(139,92,246,0.2)' : '0 1px 3px rgba(0,0,0,0.06)'),
        cursor: 'pointer',
      }}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={handleStyleLarge}
      />
      <div style={{ ...badgeStyle, gap: '3px' }}>
        {data.code}
        {data.taskType === '里程碑' && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
            <line x1="4" y1="22" x2="4" y2="15"/>
          </svg>
        )}
      </div>
        <div style={{ minWidth: 0 }}>
          {ancestorPath && (
            <div style={{ fontSize: '11px', color: '#9CA3AF', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '150px' }}>
              {ancestorPath}
            </div>
          )}
          <div style={{ fontSize: '12px', color: isCompleted ? '#9CA3AF' : '#1F2937', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '150px' }}>
            {data.name}
          </div>
        </div>
      <Handle
        type="source"
        position={Position.Right}
        style={handleStyleLarge}
      />
    </div>
  )
}

const nodeTypes = { custom: CustomNode }

const findNodeById = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findNodeById(node.children, id)
      if (found) return found
    }
  }
  return null
}

const getLeafDescendantIds = (tree, nodeId) => {
  const node = findNodeById(tree, nodeId)
  if (!node) return []
  if (!node.children || node.children.length === 0) return [node.id]
  let ids = []
  for (const child of node.children) {
    ids = ids.concat(getLeafDescendantIds(tree, child.id))
  }
  return ids
}

const getLayoutedElements = (nodes, edges, showName) => {
  if (nodes.length === 0) return { nodes: [], edges: [] }

  const COL_GAP = showName ? 280 : 90
  const ROW_GAP = showName ? 30 : 12
  const MARGIN = 40
  const nodeH = showName ? NODE_HEIGHT : NODE_HEIGHT_COMPACT

  const childMap = {}
  const parentMap = {}
  for (const e of edges) {
    if (!childMap[e.source]) childMap[e.source] = []
    childMap[e.source].push(e.target)
    if (!parentMap[e.target]) parentMap[e.target] = []
    parentMap[e.target].push(e.source)
  }

  const nodeIds = new Set(nodes.map(n => n.id))

  const layerOf = {}
  const inDeg = {}
  for (const id of nodeIds) {
    const preds = (parentMap[id] || []).filter(p => nodeIds.has(p))
    inDeg[id] = preds.length
  }

  const queue = []
  for (const id of nodeIds) {
    if (inDeg[id] === 0) {
      layerOf[id] = 0
      queue.push(id)
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()
    for (const ch of (childMap[cur] || [])) {
      if (!nodeIds.has(ch)) continue
      const newLayer = layerOf[cur] + 1
      if (layerOf[ch] === undefined || layerOf[ch] < newLayer) {
        layerOf[ch] = newLayer
      }
      inDeg[ch]--
      if (inDeg[ch] === 0) {
        queue.push(ch)
      }
    }
  }

  for (const id of nodeIds) {
    if (layerOf[id] === undefined) layerOf[id] = 0
  }

  const columns = {}
  for (const [id, layer] of Object.entries(layerOf)) {
    if (!columns[layer]) columns[layer] = []
    columns[layer].push(id)
  }

  const sortedLayers = Object.keys(columns).map(Number).sort((a, b) => a - b)

  const colX = {}
  sortedLayers.forEach((layer, i) => {
    colX[layer] = MARGIN + i * COL_GAP
  })

  const yPositions = {}

  let anchorLayer = sortedLayers[0]
  let anchorCount = 0
  for (const layer of sortedLayers) {
    const c = (columns[layer] || []).length
    if (c > anchorCount) { anchorCount = c; anchorLayer = layer }
  }

  const anchorIdx = sortedLayers.indexOf(anchorLayer)
  const anchorIds = columns[anchorLayer] || []
  let cy = 0
  for (const id of anchorIds) {
    yPositions[id] = cy + nodeH / 2
    cy += nodeH + ROW_GAP
  }

  for (let i = anchorIdx - 1; i >= 0; i--) {
    const ids = columns[sortedLayers[i]] || []
    for (const id of ids) {
      const ch = (childMap[id] || []).filter(c => nodeIds.has(c) && yPositions[c] !== undefined)
      if (ch.length > 0) {
        const ys = ch.map(c => yPositions[c])
        yPositions[id] = (Math.min(...ys) + Math.max(...ys)) / 2
      } else {
        yPositions[id] = cy + nodeH / 2
        cy += nodeH + ROW_GAP
      }
    }
  }

  cy = yPositions[anchorIds[anchorIds.length - 1]] + nodeH + ROW_GAP
  for (let i = anchorIdx + 1; i < sortedLayers.length; i++) {
    const ids = columns[sortedLayers[i]] || []
    for (const id of ids) {
      const pa = (parentMap[id] || []).filter(p => nodeIds.has(p) && yPositions[p] !== undefined)
      if (pa.length > 0) {
        const ys = pa.map(p => yPositions[p])
        yPositions[id] = (Math.min(...ys) + Math.max(...ys)) / 2
      } else {
        yPositions[id] = cy + nodeH / 2
        cy += nodeH + ROW_GAP
      }
    }
  }

  for (const layer of sortedLayers) {
    const ids = (columns[layer] || []).slice().sort((a, b) => yPositions[a] - yPositions[b])
    if (ids.length <= 1) continue
    for (let iter = 0; iter < 6; iter++) {
      for (let i = 1; i < ids.length; i++) {
        const minY = yPositions[ids[i - 1]] + nodeH + ROW_GAP
        if (yPositions[ids[i]] < minY) yPositions[ids[i]] = minY
      }
      for (let i = ids.length - 2; i >= 0; i--) {
        const maxY = yPositions[ids[i + 1]] - nodeH - ROW_GAP
        if (yPositions[ids[i]] > maxY) yPositions[ids[i]] = maxY
      }
    }
  }

  const layoutedNodes = nodes.map((node) => ({
    ...node,
    position: {
      x: colX[layerOf[node.id]] ?? 0,
      y: MARGIN + yPositions[node.id],
    },
  }))

  return { nodes: layoutedNodes, edges }
}

const NetworkDiagramStandalone = ({ wbsTreeData, predecessorsSyncRef, onTreeDataChange, teamMembers = [], onShowTeamModal, onAddMember, onAddRole, isMemberListExpanded = true, setIsMemberListExpanded, timeRuleUnit = '小时', timeRuleValue = 0.5, dailyInputHours = 8, startDate, endDate, onOpenPeriodModal, onApplyTimeRule, onApplyDailyInput, onAiAssistant, projectId: projectIdProp, statusOf, skipHolidays = false, scheduleDateMap = null }) => {
  const wrapperRef = useRef(null)
  const location = useLocation()
  const projectId = projectIdProp || location.state?.projectId || new URLSearchParams(location.search).get('projectId')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [rfInstance, setRfInstance] = useState(null)
  const initialLayoutDone = useRef(false)
  const [showNodeName, setShowNodeName] = useState(true)
  const [selectedNode, setSelectedNode] = useState(null)
  const [localTreeData, setLocalTreeData] = useState(wbsTreeData || [])
  const [projectDeliverablesCatalog, setProjectDeliverablesCatalog] = useState([])

  // 网络图始终消费 App 共享的实时任务数据 wbsTreeData（与 WBS、甘特图共用同一数据源，
  // 不再独立读库回退），本地维护可编辑副本并随 wbsTreeData 同步，保证三视图一致。
  useEffect(() => {
    // 网络图始终消费 App 共享的实时任务数据 wbsTreeData（与 WBS、甘特图共用同一数据源），
    // 本地维护可编辑副本并随 wbsTreeData 同步，保证三视图一致。
    setLocalTreeData(wbsTreeData || [])
  }, [wbsTreeData])

  // 加载项目的可交付成果目录
  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    getProjectById(projectId)
      .then(project => {
        if (!cancelled && project && Array.isArray(project.deliverables_catalog)) {
          setProjectDeliverablesCatalog(project.deliverables_catalog)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [projectId])

  // 成员任务数量/工时统计：与 WBS 同口径，直接从当前内存任务树聚合（key=role-name /
  // 待分配用 role，taskCount=去重任务数）。AI 助理应用的任务树尚未落库，DB 聚合会
  // 永远为 0；内存聚合对发布版/草稿同样成立，且随树变更实时更新
  const memberStats = useMemo(() => {
    const stats = {}
    const walk = (nodes) => {
      for (const node of nodes || []) {
        for (const r of (node.resources || [])) {
          const key = r.name ? `${r.role || '未分组'}-${r.name}` : (r.role || '未分组')
          if (!stats[key]) stats[key] = { taskCount: 0, totalHours: 0, taskUids: new Set() }
          stats[key].totalHours += r.hours || 0
          stats[key].taskUids.add(node.task_ulid || node.id)
        }
        if (node.children && node.children.length > 0) walk(node.children)
      }
    }
    walk(localTreeData)
    Object.values(stats).forEach(s => { s.taskCount = s.taskUids.size; delete s.taskUids })
    return stats
  }, [localTreeData])

  // 富化成员对象（key 口径与 WBS 一致：有名字用 role-name，无名（待分配）用 role）
  // wbsTreeData == null 表示 App 种子加载尚未完成（草稿确认弹窗等待中），
  // 此时统计传 null，MemberList 显示省略号而非误导性的 0
  const treeReady = wbsTreeData != null
  const enrichedTeamMembers = teamMembers.map(member => {
    if (!treeReady) return { ...member, tasks: null, totalHours: null }
    const key = member.name ? `${member.role}-${member.name}` : member.role
    const stats = memberStats[key]
    return {
      ...member,
      tasks: stats ? new Array(stats.taskCount).fill(null) : (member.tasks || []),
      totalHours: stats ? stats.totalHours : (member.totalHours || 0)
    }
  })

  const treeData = localTreeData

  const hasTasks = treeData && treeData.length > 0

  const handleNodeClick = useCallback((nodeData) => {
    setSelectedNode(nodeData)
  }, [])

  // 详情弹窗的节点从任务树实时解析：树变更（改工时/工期/日期）后弹窗立即显示最新值，
  // 避免停留在点击时刻的快照
  const selectedNodeLive = useMemo(() => {
    if (!selectedNode) return null
    return findNodeInTree(treeData, selectedNode.id) || selectedNode
  }, [selectedNode, treeData])

  const applyTreeChange = useCallback((taskId, patch) => {
    if (!treeData) return null
    const newTree = updateNodeFields(treeData, taskId, patch)
    setLocalTreeData(newTree)
    if (onTreeDataChange) onTreeDataChange(newTree)
    return newTree
  }, [treeData, onTreeDataChange])

  // 任务级跳过节假日口径：任务设置了 skip_holidays 用任务值，否则回落到项目全局设置。
  // 结束时间推算（computeEndFromDuration）统一按此口径执行
  const effSkipOf = (task) => (task && task.skip_holidays != null) ? !!task.skip_holidays : !!skipHolidays

  const handleUpdateTaskResources = useCallback((taskId, resourceIndex, updater) => {
    if (!treeData) return
    const newTree = updateNodeResources(treeData, taskId, updater)
    setLocalTreeData(newTree)
    if (onTreeDataChange) onTreeDataChange(newTree)
  }, [treeData, onTreeDataChange])

  const handleResourceMemberChange = useCallback((taskId, resourceIndex, selectedValue) => {
    const member = teamMembers.find(m => `${m.role}-${m.name}` === selectedValue)
    handleUpdateTaskResources(taskId, resourceIndex, (resources) =>
      resources.map((r, i) => (i === resourceIndex
        ? { ...r, role: member?.role || '', name: member?.name || '', avatar: member?.avatar || '' }
        : r))
    )
  }, [teamMembers, handleUpdateTaskResources])

  const handleResourceHoursChange = useCallback((taskId, resourceIndex, hours) => {
    if (!treeData) return
    const task = findNodeInTree(treeData, taskId)
    const newResources = (task?.resources || []).map((r, i) =>
      i === resourceIndex ? { ...r, hours } : r
    )
    // 自定义工期：工时换算天数超过自定义工期时，清除自定义转为自动计算
    const exceeded = calcCustomDurationExceeded(task, newResources, dailyInputHours, 'max')
    const patch = { resources: newResources }
    if (exceeded != null) patch.customDurationDays = undefined
    // 无自定义工期（或刚被清除）时，工时变化联动重算结束日期（保持开始日期不变）
    if (task?.start_date && (task.customDurationDays == null || exceeded != null)) {
      const autoDays = autoDurationDaysOf({ ...task, resources: newResources }, dailyInputHours)
      if (autoDays) patch.end_date = computeEndFromDuration(task.start_date, autoDays, effSkipOf(task))
    }
    applyTreeChange(taskId, patch)
  }, [treeData, applyTreeChange, dailyInputHours, skipHolidays])

  const handleDeleteTaskResource = useCallback((taskId, resourceIndex) => {
    handleUpdateTaskResources(taskId, resourceIndex, (resources) =>
      resources.filter((_, i) => i !== resourceIndex)
    )
  }, [handleUpdateTaskResources])

  const handleAddTaskResource = useCallback((taskId, member) => {
    if (!member) return
    handleUpdateTaskResources(taskId, -1, (resources) => [
      ...resources,
      { role: member.role || '', name: member.name || '', avatar: member.avatar || '', hours: 0 }
    ])
  }, [handleUpdateTaskResources])

  const handleUpdateTaskDuration = useCallback((taskId, days) => {
    if (!treeData) return
    const task = findNodeInTree(treeData, taskId)
    const patch = { customDurationDays: days }
    // 工期变化联动重算结束日期（保持开始日期不变）
    if (task?.start_date) patch.end_date = computeEndFromDuration(task.start_date, days, effSkipOf(task))
    applyTreeChange(taskId, patch)
  }, [treeData, applyTreeChange, skipHolidays])

  const handleAutoCalcDuration = useCallback((taskId) => {
    if (!treeData) return
    const task = findNodeInTree(treeData, taskId)
    const patch = { customDurationDays: null }
    // 恢复自动计算后按工时推算的工期重算结束日期
    if (task?.start_date) {
      const autoDays = autoDurationDaysOf(task, dailyInputHours)
      if (autoDays) patch.end_date = computeEndFromDuration(task.start_date, autoDays, effSkipOf(task))
    }
    applyTreeChange(taskId, patch)
  }, [treeData, applyTreeChange, dailyInputHours, skipHolidays])

  const handleUpdateTaskDates = useCallback((taskId, startDate, endDate) => {
    applyTreeChange(taskId, {
      start_date: startDate || null,
      end_date: endDate || null,
    })
  }, [applyTreeChange])

  // 弹窗开始/结束时间的小时设置（结束时 end_hour 为只读展示，一般不会触发）
  const handleUpdateTaskHours = useCallback((taskId, which, val) => {
    applyTreeChange(taskId, which === 'start' ? { start_hour: val } : { end_hour: val })
  }, [applyTreeChange])

  // 切换任务级跳过节假日规则后，按开始日期+工期重新推算结束日期
  const handleUpdateTaskSkipHolidays = useCallback((taskId, flag) => {
    if (!treeData) return
    const task = findNodeInTree(treeData, taskId)
    const patch = { skip_holidays: flag }
    if (task?.start_date) {
      const days = task.customDurationDays > 0 ? task.customDurationDays : (autoDurationDaysOf(task, dailyInputHours) || 0)
      if (days > 0) patch.end_date = computeEndFromDuration(task.start_date, days, flag)
    }
    applyTreeChange(taskId, patch)
  }, [treeData, applyTreeChange, dailyInputHours])

  const handleUpdateTaskDeliverables = useCallback((taskId, deliverables) => {
    // 同步写入任务内容层（跨版本存储，不触发计划版本变更）
    if (projectId) upsertTaskContent(projectId, taskId, { deliverables }).catch(e => console.error('upsertTaskContent failed:', e))
    applyTreeChange(taskId, { deliverables })
  }, [applyTreeChange, projectId])

  const handleUpdateTaskDescription = useCallback((taskId, description) => {
    // 同步写入任务内容层（跨版本存储，不触发计划版本变更）
    if (projectId) upsertTaskContent(projectId, taskId, { description }).catch(e => console.error('upsertTaskContent failed:', e))
    applyTreeChange(taskId, { description })
  }, [applyTreeChange, projectId])

  const mergedDeliverablesCatalog = useMemo(() => {
    const fromTree = []
    const collect = (nodes) => {
      (nodes || []).forEach(n => {
        (n.deliverables || []).forEach(d => { if (d) fromTree.push(d) })
        if (n.children && n.children.length > 0) collect(n.children)
      })
    }
    collect(treeData)
    return Array.from(new Set([...(projectDeliverablesCatalog || []), ...fromTree]))
  }, [treeData, projectDeliverablesCatalog])

  const handleAddDeliverableToCatalog = useCallback((name) => {
    const clean = (name || '').trim()
    if (!clean) return
    setProjectDeliverablesCatalog(prev => {
      if (prev.includes(clean)) return prev
      const next = [...prev, clean]
      // 持久化到 IndexedDB
      if (projectId) {
        getProjectById(projectId).then(project => {
          if (project) {
            updateRecord('projects', { ...project, deliverables_catalog: next })
          }
        }).catch(() => {})
      }
      return next
    })
  }, [projectId])

  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
    if (!treeData || treeData.length === 0) return { nodes: [], edges: [] }

    const leaves = buildLeaves(treeData, 8)
    const { criticalTaskIds, criticalEdgeKeys } = computeCriticalPath(leaves)

    const allNodes = []
    const allEdges = []

    const collectLeaves = (tree, ancestors = []) => {
      for (const node of tree) {
        if (!node.children || node.children.length === 0) {
          // 从 resources 动态计算工时（和 WBS 保持一致）
          const computedHours = (node.resources || []).reduce((sum, r) => sum + (r.hours || 0), 0)
          const maxResourceHours = Math.max(0, ...(node.resources || []).map(r => r.hours || 0))
          const calculatedDays = maxResourceHours > 0 && dailyInputHours > 0
            ? Math.ceil(maxResourceHours / dailyInputHours)
            : 1
          const durationDays = (node.customDurationDays != null && node.customDurationDays > 0)
            ? node.customDurationDays
            : calculatedDays

          // 从 resources 动态计算任务类型（和 WBS 的 getTaskTypeInfo 保持一致）
          const isCustomDuration = node.customDurationDays !== undefined
          let computedTaskType = '等待'
          if (node.taskType === '里程碑') {
            computedTaskType = '里程碑'
          } else if (maxResourceHours !== 0 && !isCustomDuration) {
            computedTaskType = '执行'
          } else if (maxResourceHours !== 0 && isCustomDuration) {
            computedTaskType = '跟进'
          }

          allNodes.push({
            id: node.id,
            type: 'custom',
            data: {
              id: node.id,
              code: node.code,
              name: node.name,
              ancestors,
              showName: true,
              onNodeClick: handleNodeClick,
              duration: node.duration,
              durationDays,
              customDurationDays: node.customDurationDays,
              resources: node.resources || [],
              predecessors: node.predecessors || [],
              description: node.description,
              deliverables: node.deliverables || [],
              status: statusOf ? statusOf(node) : (node.status || 'pending'),
              hours: computedHours,
              totalHours: computedHours,
              start_date: node.start_date,
              end_date: node.end_date,
              start_hour: node.start_hour,
              end_hour: node.end_hour,
              taskType: computedTaskType,
              isCritical: criticalTaskIds.has(node.id),
            },
            position: { x: 0, y: 0 },
          })
        }
        if (node.children) collectLeaves(node.children, [...ancestors, node.name])
      }
    }

    collectLeaves(treeData)

    const leafIds = new Set(allNodes.map(n => n.id))

    for (const node of allNodes) {
      const orig = findNodeById(treeData, node.id)
      if (!orig?.predecessors) continue
      for (const predId of orig.predecessors) {
        if (predId === node.id) continue
        if (leafIds.has(predId)) {
          const isCriticalEdge = criticalEdgeKeys.has(`${predId}-${node.id}`)
          allEdges.push({
            id: `e${predId}-${node.id}`,
            source: predId,
            target: node.id,
            type: 'straight',
            style: {
              stroke: isCriticalEdge ? '#8B5CF6' : '#94A3B8',
              strokeWidth: isCriticalEdge ? 2.5 : 1.5,
            },
          })
        } else {
          for (const leafId of getLeafDescendantIds(treeData, predId)) {
            if (leafIds.has(leafId) && leafId !== node.id) {
              const isCriticalEdge = criticalEdgeKeys.has(`${leafId}-${node.id}`)
              allEdges.push({
                id: `e${leafId}-${node.id}`,
                source: leafId,
                target: node.id,
                type: 'straight',
                style: {
                  stroke: isCriticalEdge ? '#8B5CF6' : '#94A3B8',
                  strokeWidth: isCriticalEdge ? 2.5 : 1.5,
                },
              })
            }
          }
        }
      }
    }

    const hasPred = new Set(allEdges.map(e => e.target))
    const hasOut = new Set(allEdges.map(e => e.source))

    for (const node of allNodes) {
      if (!hasPred.has(node.id)) {
        allEdges.push({
          id: `estart-${node.id}`,
          source: '__start__',
          target: node.id,
          type: 'straight',
          style: { stroke: '#94A3B8', strokeWidth: 1.5 },
        })
      }
      if (!hasOut.has(node.id)) {
        allEdges.push({
          id: `e${node.id}-end`,
          source: node.id,
          target: '__end__',
          type: 'straight',
          style: { stroke: '#94A3B8', strokeWidth: 1.5 },
        })
      }
    }

    allNodes.unshift({
      id: '__start__',
      type: 'custom',
      data: { code: 'START', name: '开始' },
      position: { x: 0, y: 0 },
    })

    allNodes.push({
      id: '__end__',
      type: 'custom',
      data: { code: 'END', name: '结束' },
      position: { x: 0, y: 0 },
    })

    return getLayoutedElements(allNodes, allEdges, showNodeName)
  }, [treeData, showNodeName, handleNodeClick])

  useEffect(() => {
    setNodes(layoutedNodes)
    setEdges(layoutedEdges)
    initialLayoutDone.current = true
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges])

  const lastEdgesSigRef = useRef('')

  useEffect(() => {
    if (!initialLayoutDone.current || edges.length === 0) return

    const sig = edges
      .filter(e => e.source !== '__start__' && e.target !== '__end__')
      .map(e => `${e.source}|${e.target}`)
      .sort()
      .join(',')
    if (sig === lastEdgesSigRef.current) return
    lastEdgesSigRef.current = sig
  }, [edges])

  const onInit = useCallback((instance) => {
    setRfInstance(instance)
    instance.fitView({ padding: 0.2 })
  }, [])

  const handleRelayout = useCallback(() => {
    if (!rfInstance) return
    const curEdges = rfInstance.getEdges()
    const curNodes = rfInstance.getNodes()

    if (onTreeDataChange && treeData && treeData.length > 0) {
      const predMap = {}
      for (const edge of curEdges) {
        if (edge.source === '__start__' || edge.target === '__end__') continue
        if (!predMap[edge.target]) predMap[edge.target] = []
        predMap[edge.target].push(edge.source)
      }
      const applyPreds = (nodes) => nodes.map(node => ({
        ...node,
        predecessors: predMap[node.id] || [],
        children: node.children ? applyPreds(node.children) : [],
      }))
      onTreeDataChange(applyPreds(treeData))
    }

    const { nodes: reNodes } = getLayoutedElements(curNodes, curEdges, showNodeName)
    setNodes(reNodes)
    setEdges(curEdges)
    setTimeout(() => rfInstance.fitView({ padding: 0.2 }), 50)
  }, [rfInstance, setNodes, setEdges, showNodeName, onTreeDataChange, treeData])

  useEffect(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, showName: showNodeName } })))
    setTimeout(() => rfInstance?.fitView({ padding: 0.3 }), 80)
  }, [showNodeName, setNodes, rfInstance])

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge({
        ...params,
        type: 'straight',
        style: { stroke: '#94A3B8', strokeWidth: 1.5 },
      }, eds))
    },
    [setEdges]
  )

  const onEdgeDoubleClick = useCallback(
    (event, edge) => {
      setEdges((eds) => eds.filter((e) => e.id !== edge.id))
    },
    [setEdges]
  )

  const onEdgeClick = useCallback(
    (event, edge) => {
      setEdges((eds) =>
        eds.map((e) => ({
          ...e,
          style: e.id === edge.id
            ? { stroke: '#3B82F6', strokeWidth: 2.5, cursor: 'pointer' }
            : { stroke: '#94A3B8', strokeWidth: 1.5 },
        }))
      )
    },
    [setEdges]
  )

  const onPaneClick = useCallback(
    () => {
      setEdges((eds) =>
        eds.map((e) => ({ ...e, style: { stroke: '#94A3B8', strokeWidth: 1.5 } }))
      )
    },
    [setEdges]
  )

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 已完成任务的依赖连线不允许通过 Delete 删除
        const protectedIds = new Set(nodes.filter(n => n.data?.status === 'completed').map(n => n.id))
        setEdges((eds) => {
          const selected = eds.filter((e) => e.selected)
          if (selected.length === 0) return eds
          return eds.filter((e) => !e.selected || protectedIds.has(e.source) || protectedIds.has(e.target))
        })
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [setEdges, nodes])

  // 顶部导航第二行（团队人数/工时粒度/每日投入）：渲染到 App content-header 的槽位
  const [headerStatsSlot, setHeaderStatsSlot] = useState(null)
  useEffect(() => {
    setHeaderStatsSlot(document.getElementById('planning-header-stats-slot'))
  }, [])
  const headerStatsPortal = headerStatsSlot ? createPortal(
    <PlanningHeaderStats
      teamMembers={teamMembers}
      isMemberListExpanded={isMemberListExpanded}
      onToggleMemberList={setIsMemberListExpanded}
      timeRuleUnit={timeRuleUnit}
      timeRuleValue={timeRuleValue}
      dailyInputHours={dailyInputHours}
      onApplyTimeRule={onApplyTimeRule}
      onApplyDailyInput={onApplyDailyInput}
    />,
    headerStatsSlot
  ) : null

  if (!hasTasks) {
    return (
      <div className="page-container">
      {headerStatsPortal}
      <div className="page-content" style={{ display: 'flex', alignItems: 'stretch' }}>
          {isMemberListExpanded && (
            <div className="wbs-left">
              <MemberList
                teamMembers={enrichedTeamMembers}
                showDetails={true}
                projectId={projectId}
                timeRuleUnit={timeRuleUnit}
                onCollapse={() => setIsMemberListExpanded(false)}
                onAddRole={onAddRole}
                onAddMember={onAddMember}
              />
            </div>
          )}
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div className="wbs-empty-state">
              <div className="empty-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <p className="empty-text">暂无任务</p>
              <p className="empty-text" style={{ fontSize: '13px', color: '#9CA3AF', marginTop: '4px' }}>请先进行任务分解</p>
            </div>
          </div>
      </div>
      </div>
    )
  }

  return (
    <div className="page-container">
      {headerStatsPortal}
      <div className="page-content" style={{ display: 'flex' }}>
        {isMemberListExpanded && (
          <div className="wbs-left">
            <MemberList
              teamMembers={enrichedTeamMembers}
              showDetails={true}
              projectId={projectId}
              timeRuleUnit={timeRuleUnit}
              onCollapse={() => setIsMemberListExpanded(false)}
              onAddRole={onAddRole}
              onAddMember={onAddMember}
            />
          </div>
        )}
        {/* 右侧列：上方工具条 + 网络图画布（成员面板展开时整体右移） */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 网络图上方工具条：重新布局 / 任务名称显隐 */}
        <div className="network-top-toolbar">
          <button
            type="button"
            onClick={handleRelayout}
            className="gantt-settings-btn"
            title="重新布局"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            重新布局
          </button>
          <button
            type="button"
            onClick={() => setShowNodeName((v) => !v)}
            className="gantt-settings-btn"
            title={showNodeName ? '隐藏任务名称，仅显示编号' : '显示任务名称'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {showNodeName ? (
                <>
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </>
              ) : (
                <>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </>
              )}
            </svg>
            任务名称
          </button>
        </div>
        <div ref={wrapperRef} className="reactflow-wrapper" style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={onInit}
          onEdgeClick={onEdgeClick}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onPaneClick={onPaneClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodeTypes={nodeTypes}
          connectionLineStyle={{ stroke: '#94A3B8', strokeWidth: 1.5 }}
          deleteKeyCode={['Delete', 'Backspace']}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
        </div>
        </div>
      </div>

      {selectedNodeLive && (() => {
        // 排期页计算的日期不回写任务树：节点没有 start_date/end_date 时用排期结果映射兜底
        const detailDates = scheduleDateMap?.[selectedNodeLive.id] || {}
        // 与 WBS 弹窗同能力：祖先链（路径行）+ 父节点（返回上一级）
        const detailPath = findTaskPath(treeData, selectedNodeLive.id) || []
        const detailParent = findTaskParent(treeData, selectedNodeLive.id)
        return (
        <TaskDetailPopup
          task={{
            ...selectedNodeLive,
            ancestors: detailPath,
            totalHours: selectedNodeLive.hours != null ? selectedNodeLive.hours : selectedNodeLive.totalHours,
            start_date: selectedNodeLive.start_date || detailDates.startDate || null,
            end_date: selectedNodeLive.end_date || detailDates.endDate || null,
            start_hour: selectedNodeLive.start_hour ?? detailDates.startHour ?? null,
            end_hour: selectedNodeLive.end_hour ?? detailDates.endHour ?? null,
            skip_holidays: selectedNodeLive.skip_holidays != null ? !!selectedNodeLive.skip_holidays : null,
          }}
          scheduleStartDate={selectedNodeLive.start_date || detailDates.startDate || null}
          scheduleEndDate={selectedNodeLive.end_date || detailDates.endDate || null}
          onBackToParent={detailParent ? () => setSelectedNode(detailParent) : null}
          execStatus={statusOf ? (statusOf(selectedNodeLive) || undefined) : undefined}
          onClose={() => setSelectedNode(null)}
          teamMembers={teamMembers}
          timeRuleUnit={timeRuleUnit}
          timeRuleValue={timeRuleValue}
          scheduleDateMap={scheduleDateMap}
          onResourceMemberChange={handleResourceMemberChange}
          onResourceHoursChange={handleResourceHoursChange}
          onResourceDelete={handleDeleteTaskResource}
          onAddResource={handleAddTaskResource}
          dailyInputHours={dailyInputHours}
          onUpdateDuration={handleUpdateTaskDuration}
          onAutoCalcDuration={handleAutoCalcDuration}
          onUpdateDates={handleUpdateTaskDates}
          onUpdateHours={handleUpdateTaskHours}
          onUpdateSkipHolidays={handleUpdateTaskSkipHolidays}
          onUpdateDeliverables={handleUpdateTaskDeliverables}
          onUpdateDescription={handleUpdateTaskDescription}
          deliverablesCatalog={mergedDeliverablesCatalog}
          onAddDeliverableToCatalog={handleAddDeliverableToCatalog}
        />
        )
      })()}
    </div>
  )
}

export default NetworkDiagramStandalone
