import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppShell } from './components/AppShell'
import './styles.css'

/**
 * 顶层错误边界：任何渲染异常都不应该把整棵 React 树卸载成白屏。
 * 之前 highlight.js 对未知语言（```lidow 工具块）抛错就是把窗口变成全白。
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[lidow] 渲染异常（已降级显示，未白屏）:', error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm font-medium">界面渲染出错</div>
        <div className="max-w-[560px] text-xs break-words opacity-70">{error.message}</div>
        <button
          className="mt-1 rounded-lg px-3 py-1.5 text-xs"
          style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)' }}
          onClick={() => this.setState({ error: null })}
        >
          重试渲染
        </button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  </StrictMode>
)
