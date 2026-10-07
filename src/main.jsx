import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { createApp } from './index.js'

// 开源核心入口：不带任何扩展配置，技术用户看到的就是纯项目排期工具
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>{createApp()}</BrowserRouter>
  </StrictMode>,
)
