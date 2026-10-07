import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension, markInputRule } from '@tiptap/core'
import { marked } from 'marked'
import './MarkdownEditor.css'

// ===== Markdown 即时渲染编辑器（Tiptap / ProseMirror 实现）=====
// 替代原 VditorEditor（Vditor IR 模式）。Vditor IR 的渲染链路是「输入 → Lute 全量重排
// DOM → wbr 恢复光标」，行内标记闭合的即时渲染必须靠事后插入不可见终止符等 hack，
// 光标极易脱节（丢光标 / 跳行首 / IME 组合锚定错位）。
// Tiptap 的做法（与 markdown_note 项目 RichTextEditor 同一套实现）：
//   · **粗体** / *斜体* / ~~删除线~~ 是 markInputRule——敲下闭合标记的瞬间，
//     ProseMirror 就地删除标记字符、给文本加 mark，光标自然落在加粗文字后面；
//   · 光标全权由 ProseMirror 管理，无任何事后 DOM 干预；输入法组合输入期间
//     输入规则不触发，IME 安全；
//   · value/onChange 契约与 VditorEditor 完全一致：markdown 字符串进出。
const Markdown = Extension.create({
  name: 'markdown',
  addInputRules() {
    return [
      // **粗体** —— 不要求前面是空白，兼容「这里是**粗体**」
      markInputRule({
        find: /\*\*([^*]+)\*\*$/,
        type: this.editor.schema.marks.bold,
      }),
      // *斜体* —— 负向先行断言避免把加粗结尾的「*」圈进 fullMatch（连续输入时丢字）
      markInputRule({
        find: /(?<!\*)\*([^*]+)\*$/,
        type: this.editor.schema.marks.italic,
      }),
      // ~~删除线~~
      markInputRule({
        find: /~~([^~]+)~~$/,
        type: this.editor.schema.marks.strike,
      }),
    ]
  },
})

// ===== Tiptap 文档 → Markdown 序列化（与 markdown_note 的 markdownSerializer 同思路，裁剪到描述编辑所需）=====
const inlineToMarkdown = (node) => {
  let out = ''
  const walk = (n) => {
    n.content?.forEach((child) => {
      if (child.isText) {
        let segment = child.text || ''
        child.marks.forEach((mark) => {
          if (mark.type.name === 'bold') segment = `**${segment}**`
          else if (mark.type.name === 'italic') segment = `*${segment}*`
          else if (mark.type.name === 'strike') segment = `~~${segment}~~`
          else if (mark.type.name === 'code') segment = `\`${segment}\``
          else if (mark.type.name === 'link') segment = `[${segment}](${mark.attrs.href || ''})`
        })
        out += segment
      } else if (child.type.name === 'hardBreak') {
        out += '\n'
      } else if (child.content) {
        walk(child)
      }
    })
  }
  walk(node)
  return out
}

export const generateMarkdown = (editor) => {
  let markdown = ''
  editor.state.doc.forEach((node) => {
    if (node.type.name === 'heading') {
      markdown += `${'#'.repeat(node.attrs.level || 1)} ${node.textContent}\n\n`
    } else if (node.type.name === 'paragraph') {
      markdown += `${inlineToMarkdown(node)}\n\n`
    } else if (node.type.name === 'bulletList') {
      node.content.forEach((item) => {
        if (item.type.name === 'listItem') markdown += `- ${inlineToMarkdown(item)}\n`
      })
      markdown += '\n'
    } else if (node.type.name === 'orderedList') {
      let index = 1
      node.content.forEach((item) => {
        if (item.type.name === 'listItem') {
          markdown += `${index}. ${inlineToMarkdown(item)}\n`
          index++
        }
      })
      markdown += '\n'
    } else if (node.type.name === 'blockquote') {
      markdown += `> ${inlineToMarkdown(node)}\n\n`
    } else if (node.type.name === 'codeBlock') {
      markdown += `\`\`\`${node.attrs.language || ''}\n${node.textContent}\n\`\`\`\n\n`
    } else if (node.type.name === 'horizontalRule') {
      markdown += `---\n\n`
    }
  })
  return markdown.trim()
}

// markdown → Tiptap content HTML。breaks: 单个 \n 渲染为 <br>，\n\n 仍是真段落，
// 与序列化端（hardBreak → \n）往返稳定。
const toContentHtml = (value) => (value ? marked.parse(value, { breaks: true }) : '')

const MarkdownEditor = ({ value = '', onChange, height = 280, placeholder = '请输入内容', autoFocus = false }) => {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const rootRef = useRef(null)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Markdown,
      Placeholder.configure({ placeholder: placeholder || '请输入内容' }),
    ],
    content: toContentHtml(value),
    onUpdate: ({ editor }) => {
      onChangeRef.current?.(generateMarkdown(editor))
    },
    editorProps: {
      attributes: {
        class: 'md-editor-content',
      },
    },
  })

  // autoFocus：编辑器就绪后把光标移入内容末尾，并把滚动容器滚到末尾，确保长内容下光标可见
  useEffect(() => {
    if (!autoFocus || !editor) return
    const t = setTimeout(() => {
      editor.commands.focus('end')
      const root = rootRef.current
      if (root) {
        // 滚动容器：EditorContent 包装 div（有包装时）或 ProseMirror 自身（无包装时）
        const sc = root.firstElementChild || root
        sc.scrollTop = sc.scrollHeight
      }
    }, 80)
    return () => clearTimeout(t)
  }, [autoFocus, editor])

  // 外部 value 变化时同步进编辑器。编辑器自身输入触发的 onChange 输出与本函数的
  // 序列化结果一致，比较后跳过，不会打断光标；仅外部真正改值（如打开别的任务）
  // 时才 setContent。
  useEffect(() => {
    if (!editor) return
    const current = generateMarkdown(editor)
    if ((value || '') === current) return
    editor.commands.setContent(toContentHtml(value))
  }, [value, editor])

  return (
    <div className="md-editor" style={{ height }} ref={rootRef}>
      <EditorContent editor={editor} />
    </div>
  )
}

export default MarkdownEditor
