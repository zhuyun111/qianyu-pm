import { marked } from 'marked'

// 任务描述 Markdown 渲染：GFM + 换行转 <br>
// 移除 script / 内联事件 / javascript: 协议，防止内容导出后带入风险代码
marked.setOptions({ gfm: true, breaks: true })

export const renderMarkdownHtml = (src) => {
  if (!src) return ''
  return marked
    .parse(src)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
}
