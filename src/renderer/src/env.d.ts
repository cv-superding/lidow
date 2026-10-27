/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { LidowBridge } from '@shared/global'

// webview 自定义元素（模块增强，而非环境声明——环境声明会覆盖 react 全部类型）
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        partition?: string
        preload?: string
        allowpopups?: string | boolean
        src?: string
      }
    }
  }
}

declare global {
  namespace Electron {
    interface WebviewTag extends HTMLElement {
      getWebContentsId(): number
      loadURL(url: string): void
      stop(): void
      reload(): void
      goBack(): void
      canGoBack(): boolean
    }
  }
  interface Window {
    lidow: LidowBridge
  }
}

export {}
