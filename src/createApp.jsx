import App from './App.jsx'

// 应用组装入口（开源核心的扩展点）。
// official 版通过传入以下配置注入私有功能，开源版全部使用默认值：
// - extraRoutes: 追加路由数组，元素为 <Route/>（如 工作台/日历/专注 等页面）
// - homePath: 根路由「/」的重定向目标，core 默认项目列表，official 可改工作台
// - renderSidebarNavItems: 侧栏固定菜单插槽，函数或 React 节点，core 下不渲染
// - extraUserMenuItems: 底部用户菜单追加项数组 [{ label, onClick }]
// - renderAiAssistant: AI 助理渲染函数 ({ isOpen, onClose, onApplyWbs, teamMembers }) => <Comp/>
export default function createApp(options = {}) {
  return <App {...options} />
}
