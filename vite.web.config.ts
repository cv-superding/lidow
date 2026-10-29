import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/** Docker/Web 版浏览器前端：复用 renderer 的纯净模式组件与设计系统 */
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    target: 'es2022'
  }
})
