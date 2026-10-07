import React from 'react'

// 执行状态小图标（甘特/表格任务名前的占位圆点、日历任务条右侧）：
// 圆底描边风格统一（默认 13×13，viewBox 24）——
//   已完成 = 绿底对勾 / 已延误 = 红底感叹号 / 进行中 = 蓝底播放三角
// 未开始（not_started）不渲染图标，调用方自行回退为灰色圆点占位符
const STYLES = {
  completed: { bg: '#DCFCE7', stroke: '#16A34A', label: '已完成' },
  delayed: { bg: '#FEE2E2', stroke: '#DC2626', label: '已延误' },
  in_progress: { bg: '#DBEAFE', stroke: '#2563EB', label: '进行中' }
}

export default function ExecStatusDot({ status, size = 13, style }) {
  const s = STYLES[status]
  if (!s) return null
  return (
    <svg
      className="collapse-placeholder status-dot"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      title={s.label}
      style={{ flexShrink: 0, ...style }}
    >
      <circle cx="12" cy="12" r="10" fill={s.bg} stroke={s.stroke} strokeWidth="1.5" />
      {status === 'completed' && (
        <path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke={s.stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {status === 'delayed' && (
        <>
          <line x1="12" y1="7" x2="12" y2="13" stroke={s.stroke} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="12" cy="16.5" r="1.3" fill={s.stroke} />
        </>
      )}
      {status === 'in_progress' && (
        <polygon points="10,8.5 16.5,12 10,15.5" fill={s.stroke} />
      )}
    </svg>
  )
}
