const DB_NAME = 'PMflowDB'
// v7→v8：v7 升级期间 task_content 建表代码曾缺失（外部覆盖），部分浏览器已升到 v7
// 但没有该对象仓库；再提一版强制触发 upgrade 补建（创建块内有 contains 守卫，幂等安全）
const DB_VERSION = 8

function generateULID() {
  const timestamp = Date.now().toString(36).padStart(6, '0')
  const random = Math.random().toString(36).substring(2, 15)
  return timestamp + random
}

let dbInstance = null

export async function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance && dbInstance.version >= DB_VERSION) {
      resolve(dbInstance)
      return
    }

    if (dbInstance) {
      dbInstance.close()
      dbInstance = null
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(request.error)
    }

    request.onsuccess = async () => {
      dbInstance = request.result
      await runDeltaMigration().catch(e => console.error('delta migration error', e))
      await repairVersionData().catch(e => console.error('version repair error', e))
      await repairMissingProjectUlid().catch(e => console.error('project_ulid repair error', e))
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      try {
        const db = event.target.result

        if (!db.objectStoreNames.contains('local_users')) {
          const userStore = db.createObjectStore('local_users', { keyPath: 'local_ulid' })
          userStore.createIndex('name', 'name', { unique: false })
        }

        if (!db.objectStoreNames.contains('workspaces')) {
          const workspaceStore = db.createObjectStore('workspaces', { keyPath: 'workspace_ulid' })
          workspaceStore.createIndex('name', 'name', { unique: false })
          workspaceStore.createIndex('type', 'type', { unique: false })
        }

        if (!db.objectStoreNames.contains('projects')) {
          const projectStore = db.createObjectStore('projects', { keyPath: 'project_ulid' })
          projectStore.createIndex('workspace_ulid', 'workspace_ulid', { unique: false })
          projectStore.createIndex('name', 'name', { unique: false })
          projectStore.createIndex('created_by', 'created_by', { unique: false })
        }

        if (!db.objectStoreNames.contains('project_members')) {
          const memberStore = db.createObjectStore('project_members', { keyPath: 'member_ulid' })
          memberStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          memberStore.createIndex('workspace_ulid', 'workspace_ulid', { unique: false })
          memberStore.createIndex('user_ulid', 'user_ulid', { unique: false })
        }

        if (!db.objectStoreNames.contains('tasks')) {
          const taskStore = db.createObjectStore('tasks', { keyPath: 'task_ulid' })
          taskStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          taskStore.createIndex('workspace_ulid', 'workspace_ulid', { unique: false })
          taskStore.createIndex('parent_task_ulid', 'parent_task_ulid', { unique: false })
          taskStore.createIndex('status', 'status', { unique: false })
        }

        if (!db.objectStoreNames.contains('task_resources')) {
          const resourceStore = db.createObjectStore('task_resources', { keyPath: 'task_resource_ulid' })
          resourceStore.createIndex('task_ulid', 'task_ulid', { unique: false })
          resourceStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          resourceStore.createIndex('workspace_ulid', 'workspace_ulid', { unique: false })
          resourceStore.createIndex('member_ulid', 'member_ulid', { unique: false })
          resourceStore.createIndex('name', 'name', { unique: false })
          resourceStore.createIndex('role', 'role', { unique: false })
        }

        if (!db.objectStoreNames.contains('project_versions')) {
          const versionStore = db.createObjectStore('project_versions', { keyPath: 'version_ulid' })
          versionStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          versionStore.createIndex('created_at', 'created_at', { unique: false })
        }

        if (db.objectStoreNames.contains('tasks')) {
          const existingTx = event.target.transaction
          const taskStore = existingTx.objectStore('tasks')
          if (!taskStore.indexNames.contains('version_ulid')) {
            taskStore.createIndex('version_ulid', 'version_ulid', { unique: false })
          }
          if (!taskStore.indexNames.contains('change_type')) {
            taskStore.createIndex('change_type', 'change_type', { unique: false })
          }
          if (!taskStore.indexNames.contains('original_task_id')) {
            taskStore.createIndex('original_task_id', 'original_task_id', { unique: false })
          }
        }

        // 任务执行状态：只存用户手动设置的状态（in_progress / completed），
        // 未开始/已延误由前端按「当前时间 vs 计划开始时间」推导，不落库。
        // 关联键 original_task_id = 跨版本逻辑任务身份（有效逻辑 ID，见 resolveTaskIdentity 注释）。
        if (!db.objectStoreNames.contains('task_execution_status')) {
          const execStore = db.createObjectStore('task_execution_status', { keyPath: 'exec_status_ulid' })
          execStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          execStore.createIndex('original_task_id', 'original_task_id', { unique: false })
        }

        // 任务动态：每次提交写一条记录（取代挂在 tasks 行上的 dynamics 数组），
        // 同样按 original_task_id 关联，跨版本延续。
        if (!db.objectStoreNames.contains('task_dynamics')) {
          const dynStore = db.createObjectStore('task_dynamics', { keyPath: 'dynamic_ulid' })
          dynStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          dynStore.createIndex('original_task_id', 'original_task_id', { unique: false })
          dynStore.createIndex('created_at', 'created_at', { unique: false })
        }

        // 任务内容层：任务描述 + 可交付成果。执行层内容，按 original_task_id 跨版本存储，
        // 不参与进度计划版本增量（仅修改这两个字段不触发版本变更/发布）。
        if (!db.objectStoreNames.contains('task_content')) {
          const contentStore = db.createObjectStore('task_content', { keyPath: 'content_ulid' })
          contentStore.createIndex('project_ulid', 'project_ulid', { unique: false })
          contentStore.createIndex('original_task_id', 'original_task_id', { unique: false })
        }
      } catch (error) {
        console.error('Database upgrade error:', error)
        reject(error)
      }
    }
  })
}

export async function addRecord(storeName, record) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.add(record)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getRecord(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly')
    const store = transaction.objectStore(storeName)
    const request = store.get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getAllRecords(storeName) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly')
    const store = transaction.objectStore(storeName)
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getRecordsByIndex(storeName, indexName, value) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readonly')
    const store = transaction.objectStore(storeName)
    const index = store.index(indexName)
    const request = index.getAll(value)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function updateRecord(storeName, record) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.put(record)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function deleteRecord(storeName, key) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.delete(key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

export async function initDefaultData() {
  const users = await getAllRecords('local_users')
  
  if (users.length === 0) {
    const adminUser = {
      local_ulid: generateULID(),
      name: 'admin',
      avatar: 'A'
    }
    await addRecord('local_users', adminUser)
    
    const personalWorkspace = {
      workspace_ulid: generateULID(),
      name: '我的个人空间',
      type: 'PERSONAL'
    }
    await addRecord('workspaces', personalWorkspace)
    
    return { adminUser, personalWorkspace }
  }
  
  const adminUser = users.find(u => u.name === 'admin') || users[0]
  const workspaces = await getAllRecords('workspaces')
  const personalWorkspace = workspaces.find(w => w.type === 'PERSONAL') || workspaces[0]
  
  return { adminUser, personalWorkspace }
}

export async function createProject(name, description, type = 'SINGLE') {
  const { adminUser, personalWorkspace } = await initDefaultData()
  
  const project = {
    project_ulid: generateULID(),
    workspace_ulid: personalWorkspace.workspace_ulid,
    name,
    description,
    type,
    created_by: adminUser.local_ulid,
    created_at: new Date().toISOString()
  }
  
  await addRecord('projects', project)
  
  const ownerMember = {
    member_ulid: generateULID(),
    project_ulid: project.project_ulid,
    workspace_ulid: personalWorkspace.workspace_ulid,
    user_ulid: adminUser.local_ulid,
    display_name: adminUser.name,
    role: 'OWNER',
    job_role: '项目经理'
  }
  
  await addRecord('project_members', ownerMember)
  
  return project
}

export async function getProjects() {
  return getAllRecords('projects')
}

export async function getProjectById(projectUlid) {
  return getRecord('projects', projectUlid)
}

export async function getProjectMembers(projectUlid) {
  return getRecordsByIndex('project_members', 'project_ulid', projectUlid)
}

export async function addProjectMember(memberData) {
  const member = {
    member_ulid: generateULID(),
    ...memberData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  await addRecord('project_members', member)
  return member
}

export async function updateProjectMember(memberData) {
  const existing = await getRecord('project_members', memberData.member_ulid)
  const member = {
    ...existing,
    ...memberData,
    updated_at: new Date().toISOString()
  }
  await updateRecord('project_members', member)
  return member
}

export async function deleteProjectMember(memberUlid) {
  await deleteRecord('project_members', memberUlid)
}

export async function getTasksByProject(projectUlid) {
  return getRecordsByIndex('tasks', 'project_ulid', projectUlid)
}

export async function getTaskById(taskUlid) {
  return getRecord('tasks', taskUlid)
}

export function hoursToUnitValue(hours, unit) {
  if (unit === '分钟') return hours * 60
  if (unit === '天') return hours / 8
  return hours
}

export function unitValueToHours(value, unit) {
  if (unit === '分钟') return value / 60
  if (unit === '天') return value * 8
  return value
}

export function ceilToStep(value, step) {
  return Math.ceil(value / step) * step
}

export async function persistTaskResources(projectUlid, workspaceUlid, taskId, resources = []) {
  await deleteTaskResourcesByTask(taskId)
  for (const resource of resources) {
    const resourceData = {
      task_ulid: taskId,
      project_ulid: projectUlid,
      workspace_ulid: workspaceUlid,
      member_ulid: resource.member_ulid || null,
      role: resource.role || '',
      name: resource.name || '',
      avatar: resource.avatar || '',
      hours: resource.hours || 0
    }
    if (resource.task_resource_ulid) {
      await updateTaskResource({ ...resourceData, task_resource_ulid: resource.task_resource_ulid })
    } else {
      await createTaskResource(resourceData)
    }
  }
}

async function loadTasksWithResources(tasks) {
  tasks.sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }))

  const resourcesByTask = new Map()
  for (const task of tasks) {
    const resources = await getTaskResourcesByTask(task.task_ulid)
    resourcesByTask.set(task.task_ulid, resources.map(r => ({
      task_resource_ulid: r.task_resource_ulid,
      member_ulid: r.member_ulid,
      role: r.role,
      name: r.name,
      avatar: r.avatar,
      hours: r.hours
    })))
  }

  const taskMap = new Map()
  const rootTasks = []

  tasks.forEach(task => {
    const node = {
      id: task.task_ulid,
      task_ulid: task.task_ulid,
      code: task.code || '',
      name: task.name || '',
      duration: task.duration || '0h 0min',
      resources: resourcesByTask.get(task.task_ulid) || [],
      status: task.status || 'pending',
      collapsed: task.collapsed || false,
      predecessors: task.predecessors || [],
      start_date: task.start_date,
      end_date: task.end_date,
      hours: task.hours || 0,
      description: task.description || '',
      deliverables: task.deliverables || [],
      priority: task.priority || 'medium',
      customDurationDays: task.custom_duration_days != null ? task.custom_duration_days : undefined,
      taskType: task.task_type || null,
      start_hour: task.start_hour != null ? task.start_hour : null,
      end_hour: task.end_hour != null ? task.end_hour : null,
      skip_holidays: task.skip_holidays == null ? null : !!task.skip_holidays,
      children: []
    }
    taskMap.set(task.task_ulid, node)
    if (!task.parent_task_ulid) {
      rootTasks.push(node)
    }
  })

  // 净化前置任务：剔除自引用与指向已删除/无效任务的引用（兼容历史脏数据）
  const validIds = new Set(tasks.map(t => t.task_ulid))
  for (const task of tasks) {
    if (Array.isArray(task.predecessors) && task.predecessors.length > 0) {
      const cleaned = task.predecessors.filter(p => p !== task.task_ulid && validIds.has(p))
      if (cleaned.length !== task.predecessors.length) task.predecessors = cleaned
    }
  }

  tasks.forEach(task => {
    if (task.parent_task_ulid && taskMap.has(task.parent_task_ulid)) {
      const parent = taskMap.get(task.parent_task_ulid)
      const child = taskMap.get(task.task_ulid)
      if (child) parent.children.push(child)
    }
  })

  return rootTasks
}

export async function getProjectWbsTree(projectUlid) {
  const tasks = await getTasksByProject(projectUlid)
  return loadTasksWithResources(tasks)
}

// ============ 版本增量（delta）模型 ============
// 任务表按「版本」存储变更行：change_type = CREATED / UPDATED / DELETED，
// original_task_id 指向该任务在基线中的原始任务 ID（用于跨版本匹配/回放）。
// version_ulid 即「关联版本」字段。任意版本的进度计划都可由 版本号 + 任务表回放还原，
// 且只保存相对上一版的增量，避免冗余存储、保留完整历史。

function taskDataChanged(a, b) {
  // 任务描述 / 可交付成果属于「任务内容层」（task_content 表，跨版本跟随任务身份），
  // 不属于计划字段：仅这两个字段变化时不产生增量行 → 发布时走「无需发布」拦截
  const fields = ['name', 'duration', 'status', 'collapsed', 'start_date', 'end_date', 'hours', 'priority', 'custom_duration_days', 'task_type', 'start_hour', 'end_hour', 'skip_holidays']
  for (const f of fields) {
    if ((a[f] ?? null) !== (b[f] ?? null)) return true
  }
  const pa = (a.predecessors || []).slice().sort().join(',')
  const pb = (b.predecessors || []).slice().sort().join(',')
  if (pa !== pb) return true
  const ra = (a.resources || []).map(r => `${r.role}|${r.name}|${r.hours}`).sort().join(';')
  const rb = (b.resources || []).map(r => `${r.role}|${r.name}|${r.hours}`).sort().join(';')
  if (ra !== rb) return true
  return false
}

// 重建「截至某一版本（不含该版本本身）」的任务计划，用于保存时计算增量差异。
// 返回 code -> { original_task_id, ...字段, parentOriginal, resources }
export async function reconstructPlan(projectUlid, excludeVersionUlid = null) {
  const versions = await getVersionsByProject(projectUlid)
  const allTasks = await getTasksByProject(projectUlid)
  // 新模型判定：存在 original_task_id 或非 CREATED 的变更行
  const hasNewModel = allTasks.some(t => t.original_task_id || (t.change_type && t.change_type !== 'CREATED'))
  const byVersion = new Map()
  for (const t of allTasks) {
    if (!byVersion.has(t.version_ulid)) byVersion.set(t.version_ulid, [])
    byVersion.get(t.version_ulid).push(t)
  }
  const ordered = versions
    .filter(v => !(excludeVersionUlid && v.version_ulid === excludeVersionUlid))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  const map = new Map()
  if (hasNewModel) {
    for (const v of ordered) {
      for (const r of (byVersion.get(v.version_ulid) || [])) {
        const orig = r.original_task_id || r.original_task_ulid || r.task_ulid
        if (r.change_type === 'DELETED') { map.delete(orig); continue }
        const res = await getTaskResourcesByTask(r.task_ulid)
        map.set(orig, {
          original_task_id: orig, rowTaskUlid: r.task_ulid,
          code: r.code, name: r.name, duration: r.duration, status: r.status, collapsed: r.collapsed,
          predecessors: r.predecessors || [], start_date: r.start_date, end_date: r.end_date, hours: r.hours,
          description: r.description, deliverables: r.deliverables || [], priority: r.priority,
          custom_duration_days: r.custom_duration_days, task_type: r.task_type,
          start_hour: r.start_hour, end_hour: r.end_hour,
          skip_holidays: r.skip_holidays == null ? null : !!r.skip_holidays,
          parentOriginal: r.parent_task_ulid || null,
          resources: res.map(x => ({ role: x.role, name: x.name, hours: x.hours }))
        })
      }
    }
  } else {
    // 旧模型（历史数据）：每个版本是完整快照，以 ordered 中最新版本作为当前计划
    const latestV = ordered[ordered.length - 1]
    if (latestV) {
      for (const r of (byVersion.get(latestV.version_ulid) || [])) {
        const orig = r.task_ulid
        const res = await getTaskResourcesByTask(r.task_ulid)
        map.set(orig, {
          original_task_id: orig, rowTaskUlid: r.task_ulid,
          code: r.code, name: r.name, duration: r.duration, status: r.status, collapsed: r.collapsed,
          predecessors: r.predecessors || [], start_date: r.start_date, end_date: r.end_date, hours: r.hours,
          description: r.description, deliverables: r.deliverables || [], priority: r.priority,
          custom_duration_days: r.custom_duration_days, task_type: r.task_type,
          start_hour: r.start_hour, end_hour: r.end_hour,
          skip_holidays: r.skip_holidays == null ? null : !!r.skip_holidays,
          parentOriginal: r.parent_task_ulid || null,
          resources: res.map(x => ({ role: x.role, name: x.name, hours: x.hours }))
        })
      }
    }
  }
  const plan = {}
  for (const entry of map.values()) plan[entry.code] = entry
  return plan
}

// 按版本回放，还原该版本的完整 WBS 树（含资源）
export async function getProjectWbsTreeByVersion(versionUlid) {
  const version = await getRecord('project_versions', versionUlid)
  if (!version) return []
  const projectUlid = version.project_ulid
  const allTasks = await getTasksByProject(projectUlid)
  const hasNewModel = allTasks.some(t => t.original_task_id || (t.change_type && t.change_type !== 'CREATED'))

  if (!hasNewModel) {
    // 旧模型：直接返回该版本完整快照
    const rows = allTasks.filter(t => t.version_ulid === versionUlid)
    return loadTasksWithResources(rows)
  }

  const versions = await getVersionsByProject(projectUlid)
  const targetIdx = versions.findIndex(v => v.version_ulid === versionUlid)
  if (targetIdx < 0) return []
  const included = versions.slice(0, targetIdx + 1).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  const byVersion = new Map()
  for (const t of allTasks) {
    if (!byVersion.has(t.version_ulid)) byVersion.set(t.version_ulid, [])
    byVersion.get(t.version_ulid).push(t)
  }
  const map = new Map() // original_task_id -> 节点 + 行 task_ulid
  for (const v of included) {
    for (const r of (byVersion.get(v.version_ulid) || [])) {
      const orig = r.original_task_id || r.original_task_ulid || r.task_ulid
      if (r.change_type === 'DELETED') { map.delete(orig); continue }
      map.set(orig, {
        original_task_id: orig,
        code: r.code, name: r.name, duration: r.duration, status: r.status, collapsed: r.collapsed,
        predecessors: r.predecessors || [], start_date: r.start_date, end_date: r.end_date, hours: r.hours,
        description: r.description, deliverables: r.deliverables || [], priority: r.priority,
        custom_duration_days: r.custom_duration_days != null ? r.custom_duration_days : undefined,
        task_type: r.task_type || null, start_hour: r.start_hour != null ? r.start_hour : null,
        end_hour: r.end_hour != null ? r.end_hour : null,
        skip_holidays: r.skip_holidays == null ? null : !!r.skip_holidays,
        parent_task_ulid: r.parent_task_ulid || null,
        rowTaskUlid: r.task_ulid
      })
    }
  }
  // 加载资源（按行 task_ulid）
  const resourcesByOrig = new Map()
  for (const entry of map.values()) {
    const res = await getTaskResourcesByTask(entry.rowTaskUlid)
    resourcesByOrig.set(entry.original_task_id, res.map(r => ({
      task_resource_ulid: r.task_resource_ulid, member_ulid: r.member_ulid,
      role: r.role, name: r.name, avatar: r.avatar, hours: r.hours
    })))
  }
  const nodes = []
  for (const entry of map.values()) {
    nodes.push({
      id: entry.original_task_id, task_ulid: entry.original_task_id,
      code: entry.code, name: entry.name, duration: entry.duration,
      resources: resourcesByOrig.get(entry.original_task_id) || [],
      status: entry.status, collapsed: entry.collapsed, predecessors: entry.predecessors,
      start_date: entry.start_date, end_date: entry.end_date, hours: entry.hours,
      description: entry.description, deliverables: entry.deliverables, priority: entry.priority,
      customDurationDays: entry.custom_duration_days, taskType: entry.task_type,
      start_hour: entry.start_hour, end_hour: entry.end_hour,
      skip_holidays: entry.skip_holidays == null ? null : !!entry.skip_holidays,
      parent_task_ulid: entry.parent_task_ulid, children: []
    })
  }
  // 按 WBS 编码数值顺序排序（如 1.1 → 1.2 → 1.10），保证根节点与兄弟节点顺序正确
  nodes.sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }))
  // 净化前置任务：剔除自引用与指向已删除/无效任务的引用（兼容历史脏数据）
  const validIds = new Set(nodes.map(n => n.task_ulid))
  for (const n of nodes) {
    if (Array.isArray(n.predecessors) && n.predecessors.length > 0) {
      const cleaned = n.predecessors.filter(p => p !== n.task_ulid && validIds.has(p))
      if (cleaned.length !== n.predecessors.length) n.predecessors = cleaned
    }
  }
  const taskMap = new Map()
  const rootTasks = []
  nodes.forEach(n => { taskMap.set(n.task_ulid, n); if (!n.parent_task_ulid) rootTasks.push(n) })
  nodes.forEach(n => {
    if (n.parent_task_ulid && taskMap.has(n.parent_task_ulid)) taskMap.get(n.parent_task_ulid).children.push(n)
  })
  return rootTasks
}

// 还原「最新版本」的 WBS 树（用于编辑/种子加载）
export async function getLatestPlanTree(projectUlid) {
  const versions = await getVersionsByProject(projectUlid)
  if (versions.length === 0) return []
  const latest = versions[versions.length - 1]
  return getProjectWbsTreeByVersion(latest.version_ulid)
}

// 删除「指定版本」的全部变更行（仅影响该版本，不动其他版本历史）
export async function deleteTasksByVersion(versionUlid) {
  const tasks = await getTasksByVersion(versionUlid)
  for (const t of tasks) {
    await deleteTaskResourcesByTask(t.task_ulid)
    await deleteRecord('tasks', t.task_ulid)
  }
}

// 清除「草稿版本」的任务行（用于排期流程选择「不加载草稿」时丢弃草稿数据）。
// 资源行是「单一正本」设计：同一逻辑任务的资源行只有一份，task_ulid 指向最新版本的行。
// 若直接 deleteTasksByVersion，会把正本资源一并删除，导致已发布版本的回放丢失资源/工期/工时。
// 因此这里先把挂在该版本行上的资源行重新指回基线（不含该版本）对应任务的最新行；
// 草稿中新建任务（基线中不存在）的资源随任务一起删除。
export async function clearDraftVersionRows(projectUlid, versionUlid) {
  const baseline = await reconstructPlan(projectUlid, versionUlid)
  const baselineRowByOrig = new Map()
  for (const entry of Object.values(baseline)) {
    if (entry.original_task_id && entry.rowTaskUlid) baselineRowByOrig.set(entry.original_task_id, entry.rowTaskUlid)
  }
  const rows = await getTasksByVersion(versionUlid)
  for (const t of rows) {
    const resources = await getTaskResourcesByTask(t.task_ulid)
    const orig = t.original_task_id || t.original_task_ulid || t.task_ulid
    const baselineRow = baselineRowByOrig.get(orig)
    for (const r of resources) {
      if (baselineRow) {
        await updateRecord('task_resources', { ...r, task_ulid: baselineRow })
      } else {
        await deleteRecord('task_resources', r.task_resource_ulid)
      }
    }
    await deleteRecord('tasks', t.task_ulid)
  }
}

export async function createTask(taskData) {
  const task = {
    task_ulid: generateULID(),
    ...taskData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  await addRecord('tasks', task)
  return task
}

export async function updateTask(taskData) {
  const existing = await getRecord('tasks', taskData.task_ulid)
  const task = {
    ...existing,
    ...taskData,
    updated_at: new Date().toISOString()
  }
  await updateRecord('tasks', task)
  return task
}

export async function deleteTask(taskUlid) {
  await deleteRecord('tasks', taskUlid)
}

export async function deleteTasksByProject(projectUlid) {
  const tasks = await getTasksByProject(projectUlid)
  for (const task of tasks) {
    await deleteRecord('tasks', task.task_ulid)
    await deleteTaskResourcesByTask(task.task_ulid)
  }
}

// ============ 任务执行状态 / 任务动态（按逻辑任务跨版本存储） ============
// 有效逻辑 ID 口径与版本回放一致：original_task_id || original_task_ulid || task_ulid。
// 主应用树节点的 id/task_ulid 已是回放后的有效逻辑 ID，可直接作为本表关联键。

// 惰性回填：为缺失 original_task_id 的任务行补写 original_task_id = task_ulid。
// 幂等且无行为变化（回放对缺失字段的回退值本来就是 task_ulid），让旧数据逐步收敛到新模型。
export async function ensureOriginalTaskIds(projectUlid) {
  try {
    const tasks = await getTasksByProject(projectUlid)
    const missing = tasks.filter(t => !t.original_task_id)
    for (const t of missing) {
      await updateRecord('tasks', { ...t, original_task_id: t.task_ulid, updated_at: t.updated_at })
    }
    return missing.length
  } catch (e) {
    console.error('ensureOriginalTaskIds error', e)
    return 0
  }
}

export async function getExecStatusByProject(projectUlid) {
  return getRecordsByIndex('task_execution_status', 'project_ulid', projectUlid)
}

// 导出 HTML 用：为执行状态/进度 Map 追加「行 task_ulid → 手动值」别名键。
// Map 本身按 original_task_id（逻辑任务身份）存储；若导出树节点只携带行 task_ulid
// （如草稿期新建、尚未回填有效逻辑 ID 的节点），查找会落空导致导出页进度/状态显示为 0，
// 与项目主页（树节点 id = 回放后的 original_task_id，可命中）不一致。别名键保证两种身份都能命中。
export async function aliasExecStatusMapsByTaskRow(projectUlid, execStatusMap, progressMap) {
  try {
    const tasks = await getTasksByProject(projectUlid)
    for (const t of tasks || []) {
      const orig = t.original_task_id
      if (!orig || String(orig) === String(t.task_ulid)) continue
      if (execStatusMap && execStatusMap.has(String(orig)) && !execStatusMap.has(String(t.task_ulid))) {
        execStatusMap.set(String(t.task_ulid), execStatusMap.get(String(orig)))
      }
      if (progressMap && progressMap.has(String(orig)) && !progressMap.has(String(t.task_ulid))) {
        progressMap.set(String(t.task_ulid), progressMap.get(String(orig)))
      }
    }
  } catch (e) {
    console.error('aliasExecStatusMapsByTaskRow error', e)
  }
}

// 合并写入某任务执行状态行：patch 为 { exec_status } 或 { progress } 之一（或二者），
// 保留另一字段；exec_status 与 progress 都为空时才删除该行。
// 自愈：拖动进度条时 onChange 高频触发，历史并发竞态可能为同一任务落下多行重复记录；
// 这里以 updated_at 最新的行为基准合并写入，并删除其余重复行，避免「会话内显示新值、
// 刷新后被旧重复行按迭代顺序覆盖回旧值」的回退现象。
async function upsertExecRow(projectUlid, originalTaskId, patch) {
  const existing = await getRecordsByIndex('task_execution_status', 'original_task_id', originalTaskId)
  const rows = (existing || [])
    .filter(r => r.project_ulid === projectUlid)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  const row = rows[0] || null
  const merged = {
    ...(row || {}),
    ...patch,
    project_ulid: projectUlid,
    original_task_id: originalTaskId,
    updated_at: new Date().toISOString()
  }
  const hasStatus = !!(merged.exec_status)
  const hasProgress = merged.progress !== null && merged.progress !== undefined
  if (!hasStatus && !hasProgress) {
    for (const r of rows) await deleteRecord('task_execution_status', r.exec_status_ulid)
    return null
  }
  if (row) {
    await updateRecord('task_execution_status', merged)
  } else {
    merged.exec_status_ulid = generateULID()
    await addRecord('task_execution_status', merged)
  }
  // 删除除基准行外的重复行（旧值行），防止刷新装载时按主键顺序覆盖新值
  for (const dup of rows.slice(1)) {
    await deleteRecord('task_execution_status', dup.exec_status_ulid)
  }
  return merged
}

// 手动设置执行状态（in_progress / completed）；exec_status 传 null 表示清除手动状态（恢复自动判定）。
// 清除时若本行仍保存有完成进度，则保留 progress 字段。
export async function setTaskExecStatus(projectUlid, originalTaskId, execStatus) {
  return upsertExecRow(projectUlid, originalTaskId, { exec_status: execStatus })
}

// 手动设置完成进度（0-100 整数）；progress 传 null 表示清除。
// 清除时若本行仍保存有手动状态，则保留 exec_status 字段。
export async function setTaskProgress(projectUlid, originalTaskId, progress) {
  return upsertExecRow(projectUlid, originalTaskId, { progress })
}

// 一次性合并写入手动状态与完成进度（状态↔进度联动时用，单次落库）
export async function setTaskExecStatusAndProgress(projectUlid, originalTaskId, execStatus, progress) {
  return upsertExecRow(projectUlid, originalTaskId, { exec_status: execStatus, progress })
}

// ============ 任务内容层（任务描述 / 可交付成果，按逻辑任务跨版本存储） ============
// 描述与可交付成果属于执行层内容：跟随 original_task_id 存储于独立表，不参与版本
// 增量对比（仅改这两个字段不触发进度计划版本变更，发布时走「无需发布」拦截）。
// 读取侧用 applyTaskContentOverlay 把最新内容覆盖到回放出的任务树上。

export async function getTaskContentByProject(projectUlid) {
  return getRecordsByIndex('task_content', 'project_ulid', projectUlid)
}

// 合并写入任务内容行：patch 为 { description } 或 { deliverables } 之一（或二者），
// 行上未出现的字段保持原值（首次只编辑过成果的行不会覆盖描述）。同一任务并发竞态
// 可能留下重复行，与 upsertExecRow 同款自愈：以 updated_at 最新行为基准合并并清重。
export async function upsertTaskContent(projectUlid, originalTaskId, patch) {
  if (!projectUlid || !originalTaskId) return null
  const fields = {}
  if (patch && patch.description !== undefined) fields.description = patch.description
  if (patch && patch.deliverables !== undefined) fields.deliverables = patch.deliverables
  if (Object.keys(fields).length === 0) return null
  const existing = await getRecordsByIndex('task_content', 'original_task_id', originalTaskId)
  const rows = (existing || [])
    .filter(r => r.project_ulid === projectUlid)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
  const row = rows[0] || null
  const merged = {
    ...(row || {}),
    ...fields,
    project_ulid: projectUlid,
    original_task_id: originalTaskId,
    updated_at: new Date().toISOString()
  }
  if (row) {
    await updateRecord('task_content', merged)
  } else {
    merged.content_ulid = generateULID()
    await addRecord('task_content', merged)
  }
  for (const dup of rows.slice(1)) {
    await deleteRecord('task_content', dup.content_ulid)
  }
  return merged
}

// 把内容层覆盖应用到任务树（原地修改）：命中 original_task_id 的节点按行内实际
// 存在的字段覆盖 description / deliverables，行上没有的字段保持树原值。
export function applyTaskContentOverlay(nodes, contentRows) {
  if (!Array.isArray(nodes) || !contentRows || contentRows.length === 0) return nodes
  const map = new Map()
  for (const r of contentRows) {
    if (!r || !r.original_task_id) continue
    const prev = map.get(r.original_task_id)
    if (!prev || String(prev.updated_at || '') < String(r.updated_at || '')) map.set(r.original_task_id, r)
  }
  if (map.size === 0) return nodes
  const walk = (list) => {
    for (const n of list || []) {
      const row = map.get(n.id) || map.get(n.task_ulid)
      if (row) {
        if ('description' in row) n.description = row.description
        if ('deliverables' in row) n.deliverables = row.deliverables || []
      }
      if (n.children && n.children.length) walk(n.children)
    }
  }
  walk(nodes)
  return nodes
}

export async function getTaskDynamicsByProject(projectUlid) {
  const rows = await getRecordsByIndex('task_dynamics', 'project_ulid', projectUlid)
  return (rows || []).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
}

// 新增一条任务动态记录（每次提交写一条）
// type: 'manual' 用户手动添加（弹窗展示）；'auto' 状态/进度联动自动生成（落库留痕但弹窗不展示）
export async function addTaskDynamicRecord(projectUlid, originalTaskId, text, type = 'manual') {
  const record = {
    dynamic_ulid: generateULID(),
    project_ulid: projectUlid,
    original_task_id: originalTaskId,
    text,
    type,
    created_at: new Date().toISOString()
  }
  await addRecord('task_dynamics', record)
  return record
}

export async function deleteTaskDynamicsByProject(projectUlid) {
  const rows = await getTaskDynamicsByProject(projectUlid)
  for (const r of rows) await deleteRecord('task_dynamics', r.dynamic_ulid)
}

export async function deleteExecStatusByProject(projectUlid) {
  const rows = await getExecStatusByProject(projectUlid)
  for (const r of rows) await deleteRecord('task_execution_status', r.exec_status_ulid)
}

export async function getTaskResourcesByTask(taskUlid) {
  return getRecordsByIndex('task_resources', 'task_ulid', taskUlid)
}

export async function getTaskResourcesByProject(projectUlid) {
  return getRecordsByIndex('task_resources', 'project_ulid', projectUlid)
}

export async function getTaskResourcesByMemberName(name) {
  return getRecordsByIndex('task_resources', 'name', name)
}

export async function getTaskResourcesByRole(role) {
  return getRecordsByIndex('task_resources', 'role', role)
}

export async function createTaskResource(resourceData) {
  const resource = {
    task_resource_ulid: generateULID(),
    ...resourceData,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  await addRecord('task_resources', resource)
  return resource
}

export async function updateTaskResource(resourceData) {
  const existing = await getRecord('task_resources', resourceData.task_resource_ulid)
  const resource = {
    ...existing,
    ...resourceData,
    updated_at: new Date().toISOString()
  }
  await updateRecord('task_resources', resource)
  return resource
}

export async function deleteTaskResource(taskResourceUlid) {
  await deleteRecord('task_resources', taskResourceUlid)
}

export async function deleteTaskResourcesByTask(taskUlid) {
  const resources = await getTaskResourcesByTask(taskUlid)
  for (const resource of resources) {
    await deleteRecord('task_resources', resource.task_resource_ulid)
  }
}

export async function deleteUnassignedResourcesByRole(projectUlid, role) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const unassigned = resources.filter(r => !r.name && r.role === role)
  for (const r of unassigned) {
    await deleteRecord('task_resources', r.task_resource_ulid)
  }
  return unassigned.length
}

export async function renameMemberResources(projectUlid, oldMemberName, newMemberName, newAvatar, oldRole, newRole) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const memberResources = resources.filter(r => {
    if (oldMemberName) {
      return r.name === oldMemberName
    }
    // 待分配占位：按角色匹配
    return !r.name && r.role === oldRole
  })
  for (const r of memberResources) {
    await updateTaskResource({
      task_resource_ulid: r.task_resource_ulid,
      name: newMemberName,
      avatar: newAvatar,
      role: newRole || r.role
    })
  }
  return memberResources.length
}

// 重命名角色：批量更新该项目下任务资源的角色名（成员表由调用方处理）
export async function renameRoleInResources(projectUlid, oldRole, newRole) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const matched = resources.filter(r => r.role === oldRole)
  for (const r of matched) {
    await updateTaskResource({ task_resource_ulid: r.task_resource_ulid, role: newRole })
  }
  return matched.length
}

export async function deleteTaskResourcesByProject(projectUlid) {
  const resources = await getTaskResourcesByProject(projectUlid)
  for (const resource of resources) {
    await deleteRecord('task_resources', resource.task_resource_ulid)
  }
}

export async function getMemberTotalHours(memberName) {
  const resources = await getTaskResourcesByMemberName(memberName)
  return resources.reduce((total, r) => total + (r.hours || 0), 0)
}

export async function getMemberHoursByProject(memberName) {
  const resources = await getTaskResourcesByMemberName(memberName)
  const result = {}
  resources.forEach(r => {
    if (!result[r.project_ulid]) {
      result[r.project_ulid] = 0
    }
    result[r.project_ulid] += r.hours || 0
  })
  return result
}

export async function getMemberTaskSummary(projectUlid, memberName) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const tasks = await getTasksByProject(projectUlid)
  const taskMap = new Map(tasks.map(t => [t.task_ulid, t]))

  const taskResourceMap = new Map()
  resources.forEach(r => {
    if (r.name !== memberName) return
    if (!taskMap.has(r.task_ulid)) return
    if (!taskResourceMap.has(r.task_ulid)) {
      taskResourceMap.set(r.task_ulid, {
        task_ulid: r.task_ulid,
        hours: 0,
        resource_ulids: []
      })
    }
    const entry = taskResourceMap.get(r.task_ulid)
    entry.hours += r.hours || 0
    entry.resource_ulids.push(r.task_resource_ulid)
  })

  const taskList = []
  let totalHours = 0

  taskResourceMap.forEach((entry, taskUlid) => {
    const task = taskMap.get(taskUlid)
    taskList.push({
      task_ulid: taskUlid,
      task_name: task?.name || '(未命名任务)',
      task_code: task?.code || '',
      hours: entry.hours,
      resource_ulids: entry.resource_ulids
    })
    totalHours += entry.hours
  })

  return { taskList, totalHours, resourceCount: taskList.length }
}

export async function reassignMemberResources(projectUlid, oldMemberName, newMemberName, newRole) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const memberResources = resources.filter(r => r.name === oldMemberName)

  const processedTaskUids = new Set()

  for (const r of memberResources) {
    if (processedTaskUids.has(r.task_ulid)) {
      await deleteTaskResource(r.task_resource_ulid)
      continue
    }
    processedTaskUids.add(r.task_ulid)

    const existing = resources.find(er =>
      er.task_ulid === r.task_ulid &&
      er.name === newMemberName &&
      er.role === (newRole || r.role) &&
      er.task_resource_ulid !== r.task_resource_ulid
    )

    if (existing) {
      const totalHours = memberResources
        .filter(mr => mr.task_ulid === r.task_ulid)
        .reduce((sum, mr) => sum + (mr.hours || 0), 0)
      await updateTaskResource({
        task_resource_ulid: existing.task_resource_ulid,
        hours: (existing.hours || 0) + totalHours
      })
      const dups = memberResources.filter(mr => mr.task_ulid === r.task_ulid)
      for (const dup of dups) {
        await deleteTaskResource(dup.task_resource_ulid)
      }
    } else {
      const totalHours = memberResources
        .filter(mr => mr.task_ulid === r.task_ulid)
        .reduce((sum, mr) => sum + (mr.hours || 0), 0)
      await updateTaskResource({
        task_resource_ulid: r.task_resource_ulid,
        name: newMemberName,
        role: newRole || r.role,
        hours: totalHours
      })
      const dups = memberResources.filter(mr => mr.task_ulid === r.task_ulid && mr.task_resource_ulid !== r.task_resource_ulid)
      for (const dup of dups) {
        await deleteTaskResource(dup.task_resource_ulid)
      }
    }
  }
  return memberResources.length
}

export async function unassignMemberResources(projectUlid, oldMemberName) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const memberResources = resources.filter(r => r.name === oldMemberName)

  const processedTaskUids = new Set()

  for (const r of memberResources) {
    if (processedTaskUids.has(r.task_ulid)) {
      await deleteTaskResource(r.task_resource_ulid)
      continue
    }
    processedTaskUids.add(r.task_ulid)

    const totalHours = memberResources
      .filter(mr => mr.task_ulid === r.task_ulid)
      .reduce((sum, mr) => sum + (mr.hours || 0), 0)

    const existing = resources.find(er =>
      er.task_ulid === r.task_ulid &&
      er.role === r.role &&
      !er.name &&
      er.task_resource_ulid !== r.task_resource_ulid
    )

    if (existing) {
      await updateTaskResource({
        task_resource_ulid: existing.task_resource_ulid,
        hours: (existing.hours || 0) + totalHours
      })
      const dups = memberResources.filter(mr => mr.task_ulid === r.task_ulid)
      for (const dup of dups) {
        await deleteTaskResource(dup.task_resource_ulid)
      }
    } else {
      await updateTaskResource({
        task_resource_ulid: r.task_resource_ulid,
        name: '',
        avatar: '',
        hours: totalHours
      })
      const dups = memberResources.filter(mr => mr.task_ulid === r.task_ulid && mr.task_resource_ulid !== r.task_resource_ulid)
      for (const dup of dups) {
        await deleteTaskResource(dup.task_resource_ulid)
      }
    }
  }
  return memberResources.length
}

export async function getMemberStats(projectUlid) {
  const resources = await getTaskResourcesByProject(projectUlid)
  const tasks = await getTasksByProject(projectUlid)
  const taskMap = new Map(tasks.map(t => [t.task_ulid, t]))

  const stats = {}

  resources.forEach(r => {
    if (!taskMap.has(r.task_ulid)) return

    if (!r.name) {
      // 待分配资源，按角色统计
      const key = r.role || '未分组'
      if (!stats[key]) {
        stats[key] = {
          name: '',
          role: r.role || '未分组',
          taskCount: 0,
          totalHours: 0,
          taskUids: new Set()
        }
      }
      stats[key].totalHours += r.hours || 0
      stats[key].taskUids.add(r.task_ulid)
      return
    }

    const key = `${r.role || '未分组'}-${r.name}`
    if (!stats[key]) {
      stats[key] = {
        name: r.name,
        role: r.role || '未分组',
        taskCount: 0,
        totalHours: 0,
        taskUids: new Set()
      }
    }
    stats[key].totalHours += r.hours || 0
    stats[key].taskUids.add(r.task_ulid)
  })

  Object.values(stats).forEach(s => {
    s.taskCount = s.taskUids.size
    delete s.taskUids
  })

  return stats
}

export async function clearProjectTaskData(projectUlid) {
  const tasks = await getTasksByProject(projectUlid)
  const resources = await getTaskResourcesByProject(projectUlid)

  for (const r of resources) {
    await deleteTaskResource(r.task_resource_ulid)
  }
  for (const t of tasks) {
    await deleteRecord('tasks', t.task_ulid)
  }

  const members = await getProjectMembers(projectUlid)
  for (const m of members) {
    if (m.role !== 'OWNER') {
      await deleteProjectMember(m.member_ulid)
    }
  }

  return { tasksDeleted: tasks.length, resourcesDeleted: resources.length, membersDeleted: members.filter(m => m.role !== 'OWNER').length }
}

// 删除整个项目：任务、资源、版本、成员、执行状态、动态及项目记录本身
export async function deleteProjectFully(projectUlid) {
  const resources = await getTaskResourcesByProject(projectUlid)
  for (const r of resources) {
    await deleteRecord('task_resources', r.task_resource_ulid)
  }

  const tasks = await getTasksByProject(projectUlid)
  for (const t of tasks) {
    await deleteRecord('tasks', t.task_ulid)
  }

  const versions = await getVersionsByProject(projectUlid)
  for (const v of versions) {
    await deleteRecord('project_versions', v.version_ulid)
  }

  const members = await getProjectMembers(projectUlid)
  for (const m of members) {
    await deleteRecord('project_members', m.member_ulid)
  }

  await deleteExecStatusByProject(projectUlid)
  await deleteTaskDynamicsByProject(projectUlid)

  await deleteRecord('projects', projectUlid)
}

// 清空项目的进度计划数据：保留项目本身与成员，删除计划版本、任务、任务资源、完成情况（执行状态）及任务动态
export async function clearProjectPlanData(projectUlid) {
  const resources = await getTaskResourcesByProject(projectUlid)
  for (const r of resources) {
    await deleteRecord('task_resources', r.task_resource_ulid)
  }

  const tasks = await getTasksByProject(projectUlid)
  for (const t of tasks) {
    await deleteRecord('tasks', t.task_ulid)
  }

  const versions = await getVersionsByProject(projectUlid)
  for (const v of versions) {
    await deleteRecord('project_versions', v.version_ulid)
  }

  await deleteExecStatusByProject(projectUlid)
  await deleteTaskDynamicsByProject(projectUlid)

  return { versionsDeleted: versions.length, tasksDeleted: tasks.length, resourcesDeleted: resources.length }
}

export async function getVersionsByProject(projectUlid) {
  const versions = await getRecordsByIndex('project_versions', 'project_ulid', projectUlid)
  versions.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  return versions
}

export async function getLatestVersion(projectUlid) {
  const versions = await getVersionsByProject(projectUlid)
  return versions.length > 0 ? versions[versions.length - 1] : null
}

export async function getDraftVersion(projectUlid) {
  const versions = await getVersionsByProject(projectUlid)
  const drafts = versions.filter(v => v.is_draft === 1 || v.is_draft === true)
  return drafts.length > 0 ? drafts[drafts.length - 1] : null
}

export async function getVersionById(versionUlid) {
  return getRecord('project_versions', versionUlid)
}

export async function createVersion(versionData) {
  const version = {
    version_ulid: generateULID(),
    ...versionData,
    created_at: new Date().toISOString()
  }
  await addRecord('project_versions', version)
  return version
}

export async function updateVersion(versionData) {
  const existing = await getRecord('project_versions', versionData.version_ulid)
  const version = {
    ...existing,
    ...versionData,
    updated_at: new Date().toISOString()
  }
  await updateRecord('project_versions', version)
  return version
}

export async function getTasksByVersion(versionUlid) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['tasks'], 'readonly')
    const store = transaction.objectStore('tasks')
    const index = store.index('version_ulid')
    const request = index.getAll(versionUlid)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveVersionSnapshot(projectUlid, workspaceUlid, versionUlid, treeData) {
  // 增量模型：不再删除项目全部任务，仅删除「本版本」的旧变更行，并写入相对当前计划的增量。
  // 1) 重建当前已保存计划（排除本版本）作为对比基线
  const priorPlan = await reconstructPlan(projectUlid, versionUlid)

  // 2) 拍平新树：code -> { node, parentCode }
  const flat = {}
  const walk = (nodes, parentCode = null) => {
    for (const n of (nodes || [])) {
      flat[n.code] = { node: n, parentCode }
      if (n.children && n.children.length) walk(n.children, n.code)
    }
  }
  walk(treeData)

  // 3) 分配 original_task_id：新建任务给新 id；已存在任务沿用基线原始 id。
  // 优先使用节点自带的稳定 id（从版本回放加载的树中 id/task_ulid 即 original_task_id），
  // 其次按 code 匹配基线。这样删除中间任务后 renumberTree 重排编号（4.2→4.1、4.3→4.2）
  // 不会导致身份错位——若仅按 code 匹配，会把幸存任务误判为「改名」、把真正该删的任务漏掉。
  const prevByOrig = new Map(Object.values(priorPlan).map(p => [p.original_task_id, p]))
  const priorOrigIds = new Set(prevByOrig.keys())
  const usedOrigIds = new Set()
  for (const code of Object.keys(flat)) {
    const nodeId = flat[code].node.task_ulid || flat[code].node.id
    if (nodeId && priorOrigIds.has(nodeId) && !usedOrigIds.has(nodeId)) {
      flat[code].originalTaskId = nodeId
    } else if (priorPlan[code]) {
      flat[code].originalTaskId = priorPlan[code].original_task_id
    } else {
      flat[code].originalTaskId = generateULID()
    }
    usedOrigIds.add(flat[code].originalTaskId)
  }
  // 本版本所有合法 original_task_id 集合，用于净化前置任务引用（避免自引用/悬空引用写入）
  const validOriginalIds = new Set(Object.values(flat).map(f => f.originalTaskId))
  // 前置任务引用换算表：WBS 树节点的前置引用是节点本地 id（task_ulid/id），
  // 快照里统一存 original_task_id —— 新建项目首次发布时两者完全不同，
  // 若不换算直接过滤，所有前置依赖会被当作悬空引用剔除（发布后依赖丢失）。
  const nodeIdToOriginal = new Map()
  for (const code of Object.keys(flat)) {
    const { node, originalTaskId } = flat[code]
    if (node.task_ulid) nodeIdToOriginal.set(node.task_ulid, originalTaskId)
    if (node.id) nodeIdToOriginal.set(node.id, originalTaskId)
  }
  const mapPredecessors = (node, originalTaskId) =>
    (node.predecessors || [])
      .map(p => nodeIdToOriginal.get(p) || p)
      .filter(p => p && p !== originalTaskId && validOriginalIds.has(p))

  // 4) 计算增量（CREATED / UPDATED / DELETED），未变更则跳过以减少冗余
  const deltas = []
  for (const code of Object.keys(flat)) {
    const { node, parentCode, originalTaskId } = flat[code]
    // 变更对比基线按 original_task_id 查找（而非 code），与身份分配逻辑保持一致
    const prev = prevByOrig.get(originalTaskId)
    const parentOriginal = parentCode ? (flat[parentCode].originalTaskId) : null
    const data = {
      project_ulid: projectUlid,
      code: node.code, name: node.name || '', duration: node.duration || '0h 0min',
      status: node.status || 'pending', collapsed: node.collapsed || false,
      predecessors: mapPredecessors(node, originalTaskId), start_date: node.start_date, end_date: node.end_date,
      hours: node.hours || 0, description: node.description || '', deliverables: node.deliverables || [],
      priority: node.priority || 'medium',
      custom_duration_days: node.customDurationDays != null ? node.customDurationDays : null,
      task_type: node.taskType || null,
      start_hour: node.start_hour != null ? node.start_hour : null,
      end_hour: node.end_hour != null ? node.end_hour : null,
      skip_holidays: node.skip_holidays == null ? null : !!node.skip_holidays,
      parent_task_ulid: parentOriginal, version_ulid: versionUlid,
      original_task_id: originalTaskId, resources: node.resources || []
    }
    if (!prev) {
      deltas.push({ ...data, change_type: 'CREATED' })
    } else if (taskDataChanged(prev, data)) {
      deltas.push({ ...data, change_type: 'UPDATED' })
    }
    // 未变更：不写入（减少冗余存储）
  }
  // 删除：基线中存在但新树中没有的任务（按 original_task_id 判定，不依赖 code，
  // 避免 renumberTree 重排编号后误删/漏删）。
  // 注意：DELETED 行必须带 project_ulid —— getTasksByProject 按 project_ulid 索引查询，
  // 若缺失该字段，删除标记永远无法被回放读到，已删任务会「复活」并造成同名任务重复显示。
  const newOrigIds = new Set(Object.values(flat).map(f => f.originalTaskId))
  for (const prev of Object.values(priorPlan)) {
    if (!newOrigIds.has(prev.original_task_id)) {
      deltas.push({
        project_ulid: projectUlid,
        code: prev.code, name: prev.name, version_ulid: versionUlid,
        original_task_id: prev.original_task_id, change_type: 'DELETED',
        parent_task_ulid: prev.parentOriginal || null
      })
    }
  }

  // 5) 删除本版本旧行，写入增量行（含资源）
  await deleteTasksByVersion(versionUlid)
  for (const d of deltas) {
    const rowTaskUlid = generateULID()
    const row = { task_ulid: rowTaskUlid, ...d }
    await updateRecord('tasks', row)
    if (d.change_type !== 'DELETED' && d.resources && d.resources.length > 0) {
      for (const r of d.resources) {
        await updateRecord('task_resources', {
          task_resource_ulid: r.task_resource_ulid || generateULID(),
          task_ulid: rowTaskUlid, project_ulid: projectUlid, workspace_ulid: workspaceUlid,
          member_ulid: r.member_ulid || null, role: r.role || '', name: r.name || '',
          avatar: r.avatar || '', hours: r.hours || 0
        })
      }
    }
  }
}

// 一次性迁移：把「旧模型（每个版本存一份完整快照）」的历史数据转换为增量（delta）模型，
// 使跨版本回放能正确还原每个版本。按项目隔离、逐项目 try/catch，失败不影响其它项目。
// 仅首次运行（localStorage 标记），之后跳过。
async function runDeltaMigration() {
  try {
    if (localStorage.getItem('pmflow_delta_migrated') === '1') return
    const projects = await getAllRecords('projects')
    for (const p of projects) {
      try {
        const versions = await getVersionsByProject(p.project_ulid)
        const allTasks = await getTasksByProject(p.project_ulid)
        if (versions.length === 0 || allTasks.length === 0) continue
        const hasNewModel = allTasks.some(t => t.original_task_id || (t.change_type && t.change_type !== 'CREATED'))
        if (hasNewModel) continue
        const byVersion = new Map()
        for (const t of allTasks) {
          if (!byVersion.has(t.version_ulid)) byVersion.set(t.version_ulid, [])
          byVersion.get(t.version_ulid).push(t)
        }
        const ordered = versions.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
        // 预先确定每个 code 的稳定 original_task_id（取首次出现的版本中的 task_ulid）
        const stableId = {}
        for (const v of ordered) {
          for (const t of (byVersion.get(v.version_ulid) || [])) {
            if (!stableId[t.code]) stableId[t.code] = t.task_ulid
          }
        }
        // 旧模型每个版本存的是各自独立的 task_ulid，需把 parent_task_ulid 重映射为稳定的 original_task_id
        const oldUlidToStable = {}
        for (const t of allTasks) oldUlidToStable[t.task_ulid] = stableId[t.code]
        let prevPlan = {}
        for (const v of ordered) {
          const rows = byVersion.get(v.version_ulid) || []
          const resByTask = {}
          for (const t of rows) resByTask[t.task_ulid] = await getTaskResourcesByTask(t.task_ulid)
          const thisPlan = {}
          for (const t of rows) {
            const orig = stableId[t.code]
            thisPlan[t.code] = { ...t, original_task_id: orig }
          }
          const newRows = []
          if (v === ordered[0]) {
            for (const t of rows) {
              const preds = (t.predecessors || [])
                .map(p => oldUlidToStable[p] || p)
                .filter(p => p !== stableId[t.code]) // 剔除自引用（重映射后可能变为自身稳定 id）
              newRows.push({ ...t, original_task_id: t.task_ulid, change_type: 'CREATED', parent_task_ulid: oldUlidToStable[t.parent_task_ulid] || null, predecessors: preds })
            }
          } else {
            for (const code of Object.keys(thisPlan)) {
              const t = thisPlan[code]
              t.parent_task_ulid = oldUlidToStable[t.parent_task_ulid] || null
              t.predecessors = (t.predecessors || []).map(p => oldUlidToStable[p] || p).filter(p => p !== t.original_task_id)
              if (!prevPlan[code]) {
                t.change_type = 'CREATED'
              } else if (taskDataChanged(prevPlan[code], t)) {
                t.change_type = 'UPDATED'
                t.original_task_id = prevPlan[code].original_task_id
              } else {
                continue
              }
              newRows.push(t)
            }
            for (const code of Object.keys(prevPlan)) {
              if (!thisPlan[code]) {
                const pt = prevPlan[code]
                newRows.push({
                  task_ulid: generateULID(), code: pt.code, name: pt.name,
                  version_ulid: v.version_ulid, original_task_id: pt.original_task_id,
                  change_type: 'DELETED', parent_task_ulid: oldUlidToStable[pt.parent_task_ulid] || null
                })
              }
            }
          }
          await deleteTasksByVersion(v.version_ulid)
          for (const nr of newRows) {
            const isDeleted = nr.change_type === 'DELETED'
            const newUlid = isDeleted ? nr.task_ulid : generateULID()
            const row = { ...nr, task_ulid: newUlid, project_ulid: p.project_ulid }
            await updateRecord('tasks', row)
            if (!isDeleted) {
              const srcUlid = thisPlan[nr.code] ? thisPlan[nr.code].task_ulid : null
              const res = srcUlid ? (resByTask[srcUlid] || []) : []
              for (const r of res) {
                await updateRecord('task_resources', {
                  ...r, task_resource_ulid: r.task_resource_ulid || generateULID(), task_ulid: newUlid
                })
              }
            }
          }
          prevPlan = thisPlan
        }
        console.log('[迁移] 项目', p.project_ulid, '已转换为增量版本模型')
      } catch (e) {
        console.error('[迁移] 项目', p.project_ulid, '转换失败:', e)
      }
    }
    localStorage.setItem('pmflow_delta_migrated', '1')
  } catch (e) {
    console.error('[迁移] 整体失败:', e)
  }
}

// 一次性修复：为已损坏的版本数据兜底。
// 1) 任务行缺少 project_ulid（增量模型某次保存未写入）——从所属版本的 project_versions 反查补齐，
//    否则 getTasksByProject 返回空，导致整棵进度计划树坍塌、工时/工期显示为 0。
// 2) parent_task_ulid 仍指向旧版本各自的 task_ulid（未映射到稳定 original_task_id）——重映射，避免子任务成为孤儿被丢弃。
// 仅首次运行（独立 localStorage 标记），之后跳过。
async function repairVersionData() {
  try {
    if (localStorage.getItem('pmflow_version_repair_v3') === '1') return
    const allTasks = await getAllRecords('tasks')
    if (allTasks.length === 0) { localStorage.setItem('pmflow_version_repair_v3', '1'); return }
    const allVersions = await getAllRecords('project_versions')
    const versionProject = new Map(allVersions.map(v => [v.version_ulid, v.project_ulid]))

    const byVersion = new Map()
    for (const t of allTasks) {
      if (!byVersion.has(t.version_ulid)) byVersion.set(t.version_ulid, [])
      byVersion.get(t.version_ulid).push(t)
    }
    const ordered = allVersions.slice().sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    // 每个 code 对应的规范化 original_task_id（优先用 original_task_id，旧全快照无此字段时退化为 task_ulid）
    const stableId = {}
    for (const v of ordered) {
      for (const t of (byVersion.get(v.version_ulid) || [])) {
        if (!stableId[t.code]) stableId[t.code] = t.original_task_id || t.task_ulid
      }
    }
    // 旧模型每版本独立的 task_ulid -> 规范化 original_task_id
    const oldUlidToStable = {}
    for (const t of allTasks) oldUlidToStable[t.task_ulid] = stableId[t.code] || t.original_task_id || t.task_ulid
    // 所有规范化 id 集合，用于剔除无效引用
    const validIds = new Set(allTasks.map(t => t.original_task_id || t.task_ulid))

    let repaired = 0
    // 逐版本处理：为每个版本构建「同父、按 code 排序」的兄弟序列，
    // 以便把自引用修复为「上一个兄弟」（匹配用户设置的顺序依赖，如 1.2 的前置任务是 1.1）。
    for (const [versionUlid, rows] of byVersion.entries()) {
      const rowInfo = rows.map(t => ({
        t,
        ownId: t.original_task_id || t.task_ulid,
        parentStable: oldUlidToStable[t.parent_task_ulid] || t.parent_task_ulid || null
      }))
      const siblingsByParent = new Map()
      for (const r of rowInfo) {
        if (!siblingsByParent.has(r.parentStable)) siblingsByParent.set(r.parentStable, [])
        siblingsByParent.get(r.parentStable).push(r)
      }
      for (const list of siblingsByParent.values()) {
        list.sort((a, b) => (a.t.code || '').localeCompare(b.t.code || '', undefined, { numeric: true }))
      }
      const prevSiblingId = (r) => {
        const list = siblingsByParent.get(r.parentStable) || []
        const idx = list.findIndex(x => x.t === r.t)
        return idx > 0 ? list[idx - 1].ownId : null
      }

      for (const r of rowInfo) {
        const t = r.t
        let changed = false
        const ownId = r.ownId
        const proj = versionProject.get(t.version_ulid)
        if (proj && t.project_ulid !== proj) { t.project_ulid = proj; changed = true }
        if (t.parent_task_ulid && oldUlidToStable[t.parent_task_ulid] && oldUlidToStable[t.parent_task_ulid] !== t.parent_task_ulid) {
          t.parent_task_ulid = oldUlidToStable[t.parent_task_ulid]
          changed = true
        }
        // 前置任务：旧 task_ulid 先映射到规范化 original_task_id，再剔除无效引用；
        // 自引用（任务依赖自身）必为脏数据，修复为「上一个兄弟」，否则丢弃。
        if (Array.isArray(t.predecessors) && t.predecessors.length > 0) {
          const mapped = []
          let predChanged = false
          for (const p of t.predecessors) {
            const m = oldUlidToStable[p] || p
            if (m === ownId) {
              const ps = prevSiblingId(r)
              if (ps && ps !== ownId && validIds.has(ps) && !mapped.includes(ps)) mapped.push(ps)
              predChanged = true
              continue
            }
            if (!validIds.has(m)) { predChanged = true; continue }
            if (!mapped.includes(m)) mapped.push(m)
            else predChanged = true
          }
          if (predChanged || mapped.length !== t.predecessors.length) {
            t.predecessors = mapped
            changed = true
          }
        }
        if (changed) { await updateRecord('tasks', t); repaired++ }
      }
    }
    localStorage.setItem('pmflow_version_repair_v3', '1')
    if (repaired > 0) console.log(`[修复] 版本数据已修复 ${repaired} 行（补齐 project_ulid / 重映射 parent 与前置任务 / 自引用修复为上一兄弟）`)
  } catch (e) {
    console.error('[修复] 版本数据修复失败:', e)
  }
}

// 一次性修复（v4）：补齐任务行缺失的 project_ulid。
// 增量模型曾在写入 DELETED 变更行时遗漏 project_ulid，导致这些行无法被
// getTasksByProject（按 project_ulid 索引）查到——回放时「删除」从不生效，
// 已删任务复活，并叠加编号重排的改名效应出现同名任务重复显示。
// 这里从所属版本反查 project_ulid 补齐，使存量草稿的删除标记重新生效。
async function repairMissingProjectUlid() {
  try {
    if (localStorage.getItem('pmflow_version_repair_v4') === '1') return
    const allTasks = await getAllRecords('tasks')
    if (allTasks.length === 0) { localStorage.setItem('pmflow_version_repair_v4', '1'); return }
    const allVersions = await getAllRecords('project_versions')
    const versionProject = new Map(allVersions.map(v => [v.version_ulid, v.project_ulid]))
    let repaired = 0
    for (const t of allTasks) {
      const proj = versionProject.get(t.version_ulid)
      if (!t.project_ulid && proj) {
        await updateRecord('tasks', { ...t, project_ulid: proj })
        repaired++
      }
    }
    localStorage.setItem('pmflow_version_repair_v4', '1')
    if (repaired > 0) console.log(`[修复v4] 补齐 ${repaired} 行缺失的 project_ulid（历史 DELETED 变更行恢复生效）`)
  } catch (e) {
    console.error('[修复v4] project_ulid 补齐失败:', e)
  }
}

export { generateULID }