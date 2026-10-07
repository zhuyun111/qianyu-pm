// 进度计划 Word（.docx）导出器
// 用 docx 库生成真正的 OOXML 文档：双分节 —— 第一节竖版 A4（正文三模块），第二节横版 A4（附件：任务明细表）。
// 分节 / 横向 / 另起一页均为文档原生属性，Word / WPS 均正确识别，不依赖 HTML 伪装。
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, AlignmentType, VerticalAlign, ImageRun, PageOrientation,
  BorderStyle, ShadingType, TableLayoutType, Footer, ExternalHyperlink,
} from 'docx'
import { isNonWorkDay } from './holidays.js'

const DAY = 86400000
const toTs = (s) => new Date(`${s}T00:00:00`).getTime()
const hex = (c) => (c || '').replace('#', '')
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const PAGE_MARGIN = { top: 1134, right: 1134, bottom: 1134, left: 1134 } // 2cm
const PORTRAIT_CONTENT = 11906 - 1134 * 2   // 9638 twips
const LANDSCAPE_CONTENT = 16838 - 1134 * 2  // 14570 twips

const border = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' }
const tableBorders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }

// ===== 基础构件 =====
const heading = (text) => new Paragraph({
  spacing: { before: 260, after: 120 },
  children: [new TextRun({ text, bold: true, size: 28, color: '1F2937' })],
})

const cell = (text, { width, bold = false, fill = null, size = 21, color = '1F2937' } = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
  verticalAlign: VerticalAlign.CENTER,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  children: [new Paragraph({ children: [new TextRun({ text: String(text), bold, size, color })] })],
})

const makeTable = (columnWidths, rows) => new Table({
  width: { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
  columnWidths,
  layout: TableLayoutType.FIXED,
  borders: tableBorders,
  rows,
})

const headerRow = (labels, widths) => new TableRow({
  tableHeader: true,
  children: labels.map((t, i) => cell(t, { width: widths[i], bold: true, fill: 'F3F4F6', size: 20 })),
})

// 页脚：工具名 + 网址（可点击），每个分节共用
const siteFooter = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({ text: '千羽-轻量级在线项目排期工具　', size: 18, color: '9CA3AF' }),
      new ExternalHyperlink({
        link: 'https://www.qianyupm.top',
        children: [new TextRun({ text: 'www.qianyupm.top', size: 18, color: '2563EB', underline: {} })],
      }),
    ],
  })],
})

// ===== 甘特图 SVG（圆角胶囊条 + 行分隔线；里程碑标注在父级一级任务行上，一级里程碑独立成行） =====
export function buildGanttSvg(groups, weekCols, colOf, themeColors) {
  const padX = 8
  // 甘特图总宽 = 文档竖版内容宽（9638 twips = 481.9pt），时间轴宽度随名称列伸缩
  const totalW = 9638 / 20
  const colCount = Math.max(1, weekCols.length)
  const headerH = 26
  const rowH = 30
  const barH = 14
  const rows = groups.filter(g => g.start && g.end).sort((a, b) => a.start.localeCompare(b.start))
  // 名称列宽按最长任务名动态计算（CJK 字符 ≈ 字号宽，ASCII ≈ 0.55 倍），上限 240 防止长名挤掉时间轴
  const textW = (s) => String(s).split('').reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 11 : 6), 0)
  const nameColW = Math.min(240, Math.max(80, ...rows.map(g => textW(g.name) + 16)))
  const timelineW = totalW - padX * 2 - nameColW
  const colW = timelineW / colCount
  const H = headerH + rows.length * rowH + 12
  const gridTop = headerH
  const gridBottom = H - 8
  const colorOf = (code) => {
    const firstLevel = parseInt((code || '1').split('.')[0], 10) || 1
    return themeColors[(firstLevel - 1) % themeColors.length].solid
  }
  const parts = []
  parts.push(`<rect x="0" y="0" width="${totalW}" height="${H}" fill="#ffffff"/>`)
  // 行分隔线：每行任务之间一条浅灰横线（含首尾边界）
  for (let i = 0; i <= rows.length; i++) {
    const y = headerH + i * rowH
    parts.push(`<line x1="${padX}" y1="${y}" x2="${totalW - padX}" y2="${y}" stroke="#F3F4F6" stroke-width="1"/>`)
  }
  // 周网格线 + 列头
  for (let i = 0; i <= colCount; i++) {
    const x = padX + nameColW + i * colW
    parts.push(`<line x1="${x}" y1="${gridTop}" x2="${x}" y2="${gridBottom}" stroke="#E5E7EB" stroke-width="1"/>`)
  }
  weekCols.forEach((w, i) => {
    parts.push(`<text x="${(padX + nameColW + (i + 0.5) * colW).toFixed(1)}" y="17" font-size="9" fill="#6B7280" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif">${esc(w)}</text>`)
  })
  // 任务行：名称 + 圆角条；行内的里程碑用红菱形标注在对应日期位置
  rows.forEach((g, idx) => {
    const cy = headerH + idx * rowH + rowH / 2
    parts.push(`<text x="${padX}" y="${(cy + 4).toFixed(1)}" font-size="11" fill="#1F2937" font-family="PingFang SC, Microsoft YaHei, sans-serif">${esc(g.name)}</text>`)
    if (!g.pureMilestone) {
      const c0 = colOf(g.start)
      const c1 = colOf(g.end)
      const bx = padX + nameColW + c0 * colW + 3
      const bw = Math.max(8, (c1 - c0 + 1) * colW - 6)
      parts.push(`<rect x="${bx.toFixed(1)}" y="${(cy - barH / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${colorOf(g.code)}"/>`)
    }
    ;(g.ms || []).forEach(m => {
      if (!m.startDate) return
      const cx = padX + nameColW + colOf(m.startDate) * colW + colW / 2
      parts.push(`<path d="M ${cx.toFixed(1)} ${(cy - 5.5).toFixed(1)} L ${(cx + 5.5).toFixed(1)} ${cy.toFixed(1)} L ${cx.toFixed(1)} ${(cy + 5.5).toFixed(1)} L ${(cx - 5.5).toFixed(1)} ${cy.toFixed(1)} Z" fill="#EF4444"/>`)
    })
  })
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${H}" viewBox="0 0 ${totalW} ${H}">${parts.join('')}</svg>`, width: totalW, height: H }
}

// 浏览器端：SVG 字符串 → PNG（2x 渲染保证清晰度）。Node 环境不可用，由调用方注入。
export async function svgToPng(svg, w, h, scale = 2) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = w * scale
    canvas.height = h * scale
    const ctx = canvas.getContext('2d')
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0, w, h)
    const pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'))
    return new Uint8Array(await pngBlob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ===== 主入口：data = scheduleExportData（叶子任务数组） =====
export async function buildScheduleDocxBlob(data, opts = {}) {
  const themeColors = opts.themeColors || [{ solid: '#7eb8f0' }]
  const renderGanttImage = opts.renderGanttImage || null
  const projectName = data.length > 0 ? data[0].projectName || '进度计划' : '进度计划'

  // ---- 统计 ----
  const taskCount = data.length
  const totalHours = data.reduce((s, t) => s + (t.totalHours || 0), 0)
  // 成员数按「角色-姓名」去重；待分配成员（无姓名）按角色各计 1 人
  const memberKeys = new Set()
  data.forEach(t => (t.resources || []).forEach(r => {
    memberKeys.add(r.name ? `${r.role}-${r.name}` : `${r.role}__待分配__`)
  }))
  let periodStart = null
  let periodEnd = null
  data.forEach(t => {
    if (t.startDate && (!periodStart || t.startDate < periodStart)) periodStart = t.startDate
    if (t.endDate && (!periodEnd || t.endDate > periodEnd)) periodEnd = t.endDate
  })
  const periodDays = periodStart && periodEnd ? Math.round((toTs(periodEnd) - toTs(periodStart)) / DAY) + 1 : null
  // 工作日天数：周期内排除周末/法定节假日（调休上班日计为工作日）
  let workDays = null
  if (periodStart && periodEnd) {
    workDays = 0
    for (let ts = toTs(periodStart); ts <= toTs(periodEnd); ts += DAY) {
      const d = new Date(ts)
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (!isNonWorkDay(ymd)) workDays++
    }
  }

  // ---- 一级任务分组（甘特）+ 里程碑归属 ----
  // 里程碑不再单独占一行：非一级里程碑以红菱形标注在其父级一级任务的行上；
  // 一级里程碑（无上级任务）才独立成行（pureMilestone）。
  const groups = new Map()
  data.forEach(t => {
    const isMs = t.taskType === '里程碑'
    if (isMs && (!t.ancestors || t.ancestors.length === 0)) {
      if (!groups.has(t.name)) groups.set(t.name, { name: t.name, start: null, end: null, code: t.code || '', pureMilestone: true, ms: [] })
      const g = groups.get(t.name)
      g.pureMilestone = true
      if (t.startDate) {
        g.ms.push(t)
        if (!g.start || t.startDate < g.start) g.start = t.startDate
        if (!g.end || t.startDate > g.end) g.end = t.startDate
      }
      return
    }
    const top = (t.ancestors && t.ancestors.length > 0) ? t.ancestors[0] : t.name
    if (!groups.has(top)) groups.set(top, { name: top, start: null, end: null, code: t.code || '', pureMilestone: false, ms: [] })
    const g = groups.get(top)
    if (isMs && t.startDate) g.ms.push(t)
    if (t.startDate && (!g.start || t.startDate < g.start)) g.start = t.startDate
    if (t.endDate && (!g.end || t.endDate > g.end)) g.end = t.endDate
  })
  const milestones = data
    .filter(t => t.taskType === '里程碑' && t.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))

  // ---- 甘特图（周分列）----
  let ganttImageRun = null
  if (periodStart && periodEnd) {
    const colCount = Math.max(1, Math.ceil((toTs(periodEnd) - toTs(periodStart)) / DAY / 7))
    const weekCols = Array.from({ length: colCount }, (_, i) => {
      const d = new Date(toTs(periodStart) + i * 7 * DAY)
      return `${d.getMonth() + 1}/${d.getDate()}`
    })
    const colOf = (dateStr) => Math.min(colCount - 1, Math.max(0, Math.floor((toTs(dateStr) - toTs(periodStart)) / DAY / 7)))
    const { svg, width, height } = buildGanttSvg([...groups.values()], weekCols, colOf, themeColors)
    if (renderGanttImage) {
      const png = await renderGanttImage(svg, width, height)
      if (png) {
        // ImageRun transformation 单位是像素（1px = 0.75pt），SVG 尺寸单位是 pt，需换算才能占满内容宽
        ganttImageRun = new ImageRun({
          type: 'png',
          data: png,
          transformation: { width: Math.round(width / 0.75), height: Math.round(height / 0.75) },
        })
      }
    }
  }

  // ---- 资源清单 ----
  const roleMap = new Map()
  data.forEach(t => (t.resources || []).forEach(r => {
    if (!roleMap.has(r.role)) roleMap.set(r.role, new Map())
    const members = roleMap.get(r.role)
    const key = r.name || '待分配'
    members.set(key, (members.get(key) || 0) + (r.hours || 0))
  }))
  const resourceRows = [...roleMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([role, members]) =>
    [...members.entries()].sort((a, b) => b[1] - a[1]).map(([name, hours]) => [role, name, `${Math.round(hours * 10) / 10}h`, name === '待分配'])
  )

  // ---- 任务明细（附件，横版）----
  const maxLevel = data.reduce((max, item) => Math.max(max, (item.ancestors || []).length + 1), 1)
  const idToCode = new Map(data.map(item => [item.id || item.code, item.code]))
  const detailHeaders = ['任务编号', '任务名称', '任务类型', '任务总工时(h)', '资源需求', '任务总工期(天)', '前置任务', '可交付成果', '任务描述', '开始时间', '结束时间']
  for (let i = 1; i <= maxLevel; i++) detailHeaders.push(`${i}级任务`)
  const levelColW = Math.floor((LANDSCAPE_CONTENT - 12670) / Math.max(1, maxLevel))
  const detailWidths = [700, 1600, 650, 650, 2200, 650, 900, 1700, 2000, 810, 810]
  for (let i = 0; i < maxLevel; i++) detailWidths.push(levelColW)
  const detailRows = data.map(item => {
    const ancestors = item.ancestors || []
    const predCodes = (item.predecessors || []).map(id => idToCode.get(id) || id)
    // 工期（天）：与项目主页一致 —— 优先自定义工期，否则 = 单人最大工时 ÷ 每日投入工时(8) 向上取整，整数天
    const maxResHours = Math.max(0, ...(item.resources || []).map(r => r.hours || 0))
    const durationDays = (item.customDurationDays !== undefined && item.customDurationDays !== null)
      ? item.customDurationDays
      : (maxResHours > 0 ? Math.ceil(maxResHours / 8) : 0)
    const durationText = item.taskType === '里程碑' ? '—' : String(durationDays)
    const row = [
      item.code, item.name, item.taskType || '-', (item.totalHours || 0).toFixed(1),
      item.resources?.map(r => `${r.role}${r.name ? `(${r.name})` : ''}: ${r.hours}h`).join('; ') || '-',
      durationText,
      predCodes.join('; ') || '-',
      (item.deliverables || []).join('; ') || '-',
      item.description || '-',
      item.startDate || '-', item.endDate || '-',
    ]
    for (let i = 0; i < maxLevel; i++) row.push(i < ancestors.length ? ancestors[i] : '')
    return row
  })

  // ===== 第一节：竖版 A4 正文 =====
  const portraitChildren = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: `${projectName} — 项目进度计划`, bold: true, size: 36, color: '1F2937' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({ text: `计划版本：${opts.versionLabel || '—'}`, size: 20, color: '6B7280' }),
        new TextRun({ text: `　　版本状态：${opts.versionStatus || '—'}`, size: 20, color: '6B7280' }),
      ],
    }),
    heading('一、项目总体进度规划'),
    // 逐行字段（不用表格）：每行「字段名：值」
    ...[
      ['项目任务数量', `${taskCount} 个`],
      ['项目周期', periodStart && periodEnd ? `${periodStart} ~ ${periodEnd}` : '暂无排期'],
      ['项目总工期', periodDays != null ? `${periodDays} 天（自然日）/ ${workDays} 天（工作日）` : '—'],
      ['项目总工时', `${Math.round(totalHours * 10) / 10}h`],
      ['参与成员数量', `${memberKeys.size} 人`],
    ].map(([label, value]) => new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({ text: `${label}：`, bold: true, size: 21, color: '1F2937' }),
        new TextRun({ text: String(value), size: 21, color: '1F2937' }),
      ],
    })),
    heading('二、项目关键节点'),
  ]
  if (ganttImageRun) {
    portraitChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 120 },
      children: [ganttImageRun],
    }))
  } else {
    portraitChildren.push(new Paragraph({ children: [new TextRun({ text: '暂无排期数据', size: 21, color: '9CA3AF' })] }))
  }
  portraitChildren.push(
    new Paragraph({
      spacing: { before: 120, after: 80 },
      children: [new TextRun({ text: `里程碑（${milestones.length} 个）`, bold: true, size: 22, color: '1F2937' })],
    })
  )
  if (milestones.length > 0) {
    portraitChildren.push(makeTable(
      [Math.floor(PORTRAIT_CONTENT * 0.6), PORTRAIT_CONTENT - Math.floor(PORTRAIT_CONTENT * 0.6)],
      [
        headerRow(['里程碑', '日期'], [Math.floor(PORTRAIT_CONTENT * 0.6), PORTRAIT_CONTENT - Math.floor(PORTRAIT_CONTENT * 0.6)]),
        ...milestones.map(m => new TableRow({
          children: [m.name, m.startDate].map((t, i) => cell(t, { width: i === 0 ? Math.floor(PORTRAIT_CONTENT * 0.6) : PORTRAIT_CONTENT - Math.floor(PORTRAIT_CONTENT * 0.6) })),
        })),
      ]
    ))
  } else {
    portraitChildren.push(new Paragraph({ children: [new TextRun({ text: '暂无里程碑', size: 21, color: '9CA3AF' })] }))
  }
  portraitChildren.push(heading('三、项目所需资源清单'))
  if (resourceRows.length > 0) {
    const third = Math.floor(PORTRAIT_CONTENT / 3)
    portraitChildren.push(makeTable(
      [third, third, PORTRAIT_CONTENT - third * 2],
      [
        headerRow(['角色', '成员', '投入工时'], [third, third, PORTRAIT_CONTENT - third * 2]),
        ...resourceRows.map(r => new TableRow({
          children: r.slice(0, 3).map((t, i) => cell(t, {
            width: i < 2 ? third : PORTRAIT_CONTENT - third * 2,
            // 待分配成员名标红
            color: i === 1 && r[3] ? 'EF4444' : '1F2937',
          })),
        })),
      ]
    ))
  } else {
    portraitChildren.push(new Paragraph({ children: [new TextRun({ text: '暂无资源数据', size: 21, color: '9CA3AF' })] }))
  }

  // ===== 第二节：横版 A4 附件（自动另起一页） =====
  const landscapeChildren = [
    heading('附件：任务明细表'),
    makeTable(
      detailWidths,
      [
        headerRow(detailHeaders, detailWidths),
        ...detailRows.map(r => new TableRow({
          children: r.map((t, i) => cell(t, { width: detailWidths[i], size: 18 })),
        })),
      ]
    ),
  ]

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: { ascii: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei', hAnsi: 'Microsoft YaHei' },
            size: 21,
            color: '1F2937',
          },
        },
      },
    },
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 }, margin: PAGE_MARGIN } },
        footers: { default: siteFooter() },
        children: portraitChildren,
      },
      {
        // docx 库在 landscape 时会自动互换宽高，这里按竖版尺寸传入
        properties: { page: { size: { width: 11906, height: 16838, orientation: PageOrientation.LANDSCAPE }, margin: PAGE_MARGIN } },
        footers: { default: siteFooter() },
        children: landscapeChildren,
      },
    ],
  })
  return Packer.toBlob(doc)
}
