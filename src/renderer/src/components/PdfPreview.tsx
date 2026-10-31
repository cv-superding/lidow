import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
// @ts-expect-error worker 包没有独立类型声明，这里只要它的 WorkerMessageHandler
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.js'

// Electron 的 file:// 页面无法创建 Worker/blob worker；把 worker 模块挂到全局，
// PDF.js 会退回主线程 LoopbackPort 渲染（本地预览足够快，且不再白屏）。
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 内置 PDF 预览：Electron 自带的 PDF 查看器在 iframe 里会白屏，改用 PDF.js 渲染到 canvas */
export function PdfPreview({
  dataUrl,
  onOpenSystem
}: {
  dataUrl: string
  onOpenSystem: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    host.innerHTML = ''
    setLoading(true)
    setError('')

    const task = pdfjs.getDocument({ data: dataUrlBytes(dataUrl) })
    void task.promise
      .then(async (doc) => {
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled || !hostRef.current) return
          const page = await doc.getPage(i)
          const base = page.getViewport({ scale: 1 })
          const available = Math.max(320, (hostRef.current.clientWidth || 760) - 8)
          const scale = Math.min(2, available / base.width)
          const viewport = page.getViewport({ scale })
          const outputScale = Math.min(2, window.devicePixelRatio || 1)
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width * outputScale)
          canvas.height = Math.floor(viewport.height * outputScale)
          canvas.style.width = '100%'
          canvas.style.maxWidth = `${Math.floor(viewport.width)}px`
          canvas.style.height = 'auto'
          canvas.style.display = 'block'
          canvas.style.background = '#fff'
          canvas.style.boxShadow = '0 2px 14px rgba(16,24,40,.12)'
          canvas.style.borderRadius = '4px'
          hostRef.current.appendChild(canvas)
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          await page.render({
            canvasContext: ctx,
            viewport,
            ...(outputScale !== 1
              ? { transform: [outputScale, 0, 0, outputScale, 0, 0] }
              : {})
          }).promise
        }
        if (!cancelled) setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })

    return () => {
      cancelled = true
      void task.destroy().catch(() => undefined)
    }
  }, [dataUrl])

  return (
    <div className="relative flex min-h-[240px] flex-col items-center gap-3 py-2">
      {loading && !error && (
        <div className="flex h-[240px] items-center justify-center text-[12px]" style={{ color: 'var(--text-hint)' }}>
          正在渲染 PDF…
        </div>
      )}
      {error && (
        <div className="flex h-[240px] flex-col items-center justify-center gap-3 text-center text-[12px]" style={{ color: 'var(--text-hint)' }}>
          <div>PDF 预览失败：{error}</div>
          <button className="btn btn-sm btn-outline" onClick={onOpenSystem}>
            在系统中查看
          </button>
        </div>
      )}
      <div ref={hostRef} className="flex w-full flex-col items-center gap-3" />
    </div>
  )
}
