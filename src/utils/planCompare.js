// 版本内容签名与两棵树的内容比对（纯数据，不依赖会话状态）。
// 供 App（幽灵草稿检测 / 排期数据回环短路）与 WbsBreakdown（initialData 回环短路）共用。

// 版本内容签名：与 comparePlanToVersion 同字段口径（名称/日期/工时/状态/工期/前置/资源/类型/自定义工期）。
// 注意：描述（desc）与可交付成果（deliv）属于「任务内容层」，跨版本存储、不触发版本变更，
// 因此不参与版本内容对比（只改这两者应判定为「无修改」）。
// includeContent=true 时额外纳入 desc/deliv —— 用于内存树回环短路（App handlePlanningTreeChange /
// WbsBreakdown initialData 回环）：这些字段的修改必须能穿透短路，否则切换页面后内容层修改会回退。
// 按 code 键控。用于两个版本之间的纯数据对比（不依赖会话状态）
export const versionContentSignature = (nodes, includeContent = false) => {
  const map = {}
  const walk = (ns) => {
    (ns || []).forEach(n => {
      const res = (n.resources || []).map(r => `${r.role}|${r.name}|${r.hours}`).sort().join(';')
      map[n.code] = {
        name: n.name || '',
        start: n.start_date || null,
        end: n.end_date || null,
        hours: n.hours ?? 0,
        status: n.status || '',
        duration: n.duration || '',
        pred: (n.predecessors || []).slice().sort().join(','),
        res,
        type: n.taskType || '',
        custom: n.customDurationDays ?? null
      }
      if (includeContent) {
        map[n.code].desc = n.description || ''
        map[n.code].deliv = JSON.stringify(n.deliverables ?? '')
      }
      if (n.children && n.children.length) walk(n.children)
    })
  }
  walk(nodes)
  return map
}

// 两棵版本树的任务内容是否完全一致（不比对排期规则——规则以版本为权威，进入流程时会对齐）。
// includeContent=true 时连内容层字段一起比对（内存回环短路用；幽灵草稿检测保持 false 口径）
export const planContentEqual = (treeA, treeB, includeContent = false) => {
  const a = versionContentSignature(treeA, includeContent)
  const b = versionContentSignature(treeB, includeContent)
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.join(',') !== kb.join(',')) return false
  return ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}
