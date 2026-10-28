/**
 * Lidow 应用图标生成器（零依赖、零外部 API）：
 * 蓝紫渐变圆角方 + 白色几何「L」+ Agent 思考点。
 * 4x 超采样抗锯齿 → 512/256 两档 PNG（手写 PNG 编码：IHDR/IDAT/IEND + CRC32）。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'build')

// ---------- 几何 ----------
const S = 2048 // 4x 超采样（512 基准）
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const lerp = (a, b, t) => a + (b - a) * t

/** 圆角矩形 SDF */
function roundedBox(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}

// 品牌色：#5b8cff → #7c5bff 对角渐变
const A = [0x5b / 255, 0x8c / 255, 1.0]
const B = [0x7c / 255, 0x5b / 255, 1.0]

const rgb = new Float64Array(S * S * 3)
const alpha = new Float64Array(S * S)

for (let py = 0; py < S; py++) {
  for (let px = 0; px < S; px++) {
    const x = (px + 0.5) / 4 // 512 基准坐标
    const y = (py + 0.5) / 4
    const idx = (py * S + px) * 3

    // 背景：圆角方（外边距 8，圆角 104）
    const dBg = roundedBox(x, y, 256, 256, 248, 248, 104)
    const cov = clamp(0.5 - dBg, 0, 1)
    if (cov <= 0) continue

    const t = clamp((x + y) / 512, 0, 1)
    let r = lerp(A[0], B[0], t)
    let g = lerp(A[1], B[1], t)
    let b = lerp(A[2], B[2], t)

    // 前景：几何「L」（竖杆 + 底座，圆角 22）+ Agent 思考点
    const dBar = roundedBox(x, y, 190, 266, 56, 182, 22)
    const dFoot = roundedBox(x, y, 296, 398, 148, 50, 22)
    const dDot = Math.hypot(x - 396, y - 148) - 33
    const dFg = Math.min(dBar, dFoot, dDot)
    const fg = clamp(0.5 - dFg, 0, 1)
    if (fg > 0) {
      r = lerp(r, 1, fg)
      g = lerp(g, 1, fg)
      b = lerp(b, 1, fg)
    }

    rgb[idx] = r
    rgb[idx + 1] = g
    rgb[idx + 2] = b
    alpha[py * S + px] = cov
  }
}

/** 盒式降采样到指定尺寸（直通 alpha） */
function downsample(target) {
  const step = S / target
  const out = Buffer.alloc(target * target * 4)
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const si = ((y * step + sy) | 0) * S + ((x * step + sx) | 0)
          const ci = si * 3
          const av = alpha[si]
          r += rgb[ci] * av
          g += rgb[ci + 1] * av
          b += rgb[ci + 2] * av
          a += av
          n++
        }
      }
      const oi = (y * target + x) * 4
      if (a > 0) {
        out[oi] = Math.round((r / a) * 255)
        out[oi + 1] = Math.round((g / a) * 255)
        out[oi + 2] = Math.round((b / a) * 255)
      }
      out[oi + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

// ---------- PNG 编码（手工实现） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

mkdirSync(OUT, { recursive: true })
for (const size of [512, 256]) {
  const png = encodePNG(size, size, downsample(size))
  const file = join(OUT, size === 512 ? 'icon.png' : `icon-${size}.png`)
  writeFileSync(file, png)
  console.log(`已生成 ${file}（${(png.length / 1024).toFixed(1)} KB）`)
}
