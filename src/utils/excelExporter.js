// 进度计划 Excel（.xlsx）导出器（ExcelJS，支持单元格样式）
// - 任务描述列加宽，行高按内容行数计算并封顶（约4行），避免长描述把行撑得特别高
// - 所有单元格顶端对齐 + 自动换行（长描述从格子顶部开始显示）
// - 署名列「千羽-轻量级在线项目排期工具」，网址只在第一行数据行显示一次
import ExcelJS from 'exceljs'

const COL_WIDTHS = {
  code: 10,
  name: 26,
  taskType: 10,
  totalHours: 12,
  resources: 28,
  durationDays: 12,
  predecessors: 14,
  deliverables: 24,
  // 任务描述列大幅加宽，减少换行数
  description: 60,
  startDate: 12,
  startHour: 11,
  endDate: 12,
  endHour: 11,
  tool: 26,
  level: 14
}

export const generateExcel = async (data, filename) => {
  const projectName = data.length > 0 ? data[0].projectName || '进度计划' : '进度计划'
  const finalFilename = (filename || `${projectName}进度计划.xlsx`).replace(/\.csv$/i, '.xlsx')
  const maxLevel = data.reduce((max, item) => Math.max(max, (item.ancestors || []).length + 1), 1)
  const idToCode = new Map(data.map(item => [item.id || item.code, item.code]))
  const headers = [
    { key: 'code', label: '任务编号' },
    { key: 'name', label: '任务名称' },
    { key: 'taskType', label: '任务类型' },
    { key: 'totalHours', label: '任务总工时(h)' },
    { key: 'resources', label: '资源需求' },
    { key: 'durationDays', label: '任务总工期(天)' },
    { key: 'predecessors', label: '前置任务' },
    { key: 'deliverables', label: '可交付成果' },
    { key: 'description', label: '任务描述' },
    { key: 'startDate', label: '开始日期' },
    { key: 'startHour', label: '开始时间(h)' },
    { key: 'endDate', label: '结束日期' },
    { key: 'endHour', label: '结束时间(h)' },
  ]
  for (let i = 1; i <= maxLevel; i++) {
    headers.push({ key: `level${i}`, label: `${i}级任务` })
  }
  // 工具署名列固定在最后一列：列头 = 产品名，网址只在第一行数据行显示一次
  headers.push({ key: 'tool', label: '千羽-轻量级在线项目排期工具' })

  const rows = data.map(item => {
    const ancestors = item.ancestors || []
    const predCodes = (item.predecessors || []).map(id => idToCode.get(id) || id)
    const row = {
      code: item.code,
      name: item.name,
      taskType: item.taskType || '-',
      totalHours: item.totalHours.toFixed(1),
      resources: item.resources?.map(r => `${r.role}${r.name ? `(${r.name})` : ''}: ${r.hours}h`).join('; ') || '-',
      durationDays: item.durationDays != null ? item.durationDays.toFixed(1) : '-',
      predecessors: predCodes.join('; ') || '-',
      deliverables: (item.deliverables || []).join('; ') || '-',
      description: item.description || '-',
      startDate: formatDate(item.startDate),
      startHour: item.startHour != null ? String(item.startHour) : '0',
      endDate: formatDate(item.endDate),
      endHour: item.endHour != null ? String(item.endHour) : '0',
      tool: null,
    }
    for (let i = 0; i < maxLevel; i++) {
      row[`level${i + 1}`] = i < ancestors.length ? ancestors[i] : ''
    }
    return row
  })
  if (rows.length > 0) rows[0].tool = 'www.qianyupm.top'

  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('进度计划')

  // 列宽：描述列 60，其余按内容类型设定
  ws.columns = headers.map(h => ({
    width: COL_WIDTHS[h.key] ?? (h.key.startsWith('level') ? COL_WIDTHS.level : 12)
  }))

  // 表头行
  const headerRow = ws.addRow(headers.map(h => h.label))
  headerRow.font = { bold: true }
  headerRow.height = 18
  headerRow.alignment = { vertical: 'middle' }

  // 行高：按长文本列（描述为主）换行行数估算，封顶 4 行；文字顶端对齐
  const LINE_HEIGHT_PT = 14
  const MAX_LINES = 4
  const dispWidth = (s) => {
    // 中文/全角按 2 个单位估算
    let w = 0
    for (const ch of String(s || '')) w += ch.charCodeAt(0) > 255 ? 2 : 1
    return w
  }
  const linesOf = (text, colW) => {
    if (!text || text === '-') return 1
    return String(text).split('\n').reduce((sum, seg) => sum + Math.max(1, Math.ceil(dispWidth(seg) / Math.max(1, colW - 2))), 0)
  }
  for (const row of rows) {
    const values = headers.map(h => row[h.key] == null ? '' : String(row[h.key]))
    const added = ws.addRow(values)
    const need = headers.reduce((max, h) => {
      const w = COL_WIDTHS[h.key] ?? (h.key.startsWith('level') ? COL_WIDTHS.level : 12)
      return Math.max(max, linesOf(row[h.key], w))
    }, 1)
    added.height = Math.min(need, MAX_LINES) * LINE_HEIGHT_PT + 2
    // 每个单元格：顶端对齐 + 自动换行（长描述从格子顶部开始显示，超高部分封顶裁剪）
    added.eachCell(cell => {
      cell.alignment = { vertical: 'top', wrapText: true }
    })
  }

  // 下载
  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = finalFilename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

const formatDate = (dateStr) => {
  if (!dateStr) return '-'
  try {
    const date = new Date(dateStr)
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  } catch {
    return '-'
  }
}
