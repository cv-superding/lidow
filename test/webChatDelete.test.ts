import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { deleteDeepSeekChat } from '../src/main/bridge/webChatDelete'

const CHAT_ID = '509c6152-0b8e-4c51-9d22-23d2f1978150'
const CHAT_URL = `https://chat.deepseek.com/a/chat/s/${CHAT_ID}`

type WebContentsLike = Parameters<typeof deleteDeepSeekChat>[0]

function setup(): { wc: WebContentsLike; deleted: () => boolean } {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="row">
        <a href="${CHAT_URL}" id="chat">Read pelican bike file</a>
        <button aria-label="更多">...</button>
      </div>
    </body></html>`,
    { url: CHAT_URL, runScripts: 'dangerously', pretendToBeVisual: true }
  )
  const w = dom.window
  // jsdom 没有布局：给脚本一个可见的元素盒
  w.Element.prototype.getBoundingClientRect = () =>
    ({
      width: 10,
      height: 10,
      top: 0,
      left: 0,
      right: 10,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }) as DOMRect
  w.getComputedStyle = (() => ({ display: 'block', visibility: 'visible' })) as unknown as typeof w.getComputedStyle

  let deleted = false
  w.document.querySelector('button[aria-label="更多"]')!.addEventListener('click', () => {
    const item = w.document.createElement('button')
    item.setAttribute('role', 'menuitem')
    item.textContent = '删除'
    item.addEventListener('click', () => {
      const confirm = w.document.createElement('button')
      confirm.textContent = '删除'
      confirm.addEventListener('click', () => {
        deleted = true
        w.document.querySelector('#row')?.remove()
      })
      w.document.body.appendChild(confirm)
    })
    w.document.body.appendChild(item)
  })

  const wc = {
    isDestroyed: () => false,
    executeJavaScript: async (code: string) => w.eval(code)
  } as unknown as WebContentsLike
  return { wc, deleted: () => deleted }
}

describe('deleteDeepSeekChat', () => {
  it('按 chat id 定位侧边栏行并完成删除确认', async () => {
    const { wc, deleted } = setup()
    const res = await deleteDeepSeekChat(wc, CHAT_URL, 'Read pelican bike file')
    expect(res.ok).toBe(true)
    expect(deleted()).toBe(true)
  })

  it('URL 不是 DeepSeek 对话时直接拒绝', async () => {
    const { wc } = setup()
    const res = await deleteDeepSeekChat(wc, 'https://example.com/a/chat/s/509c6152', 'x')
    expect(res.ok).toBe(false)
  })
})
