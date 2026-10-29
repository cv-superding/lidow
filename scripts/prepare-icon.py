"""把用户提供的白底 JPG 图标处理成透明圆角 PNG（应用图标）。

源图：build/icon-source.jpg（1024x1024，圆角半径约 120，外部是白色 JPEG 背景）。
输出：build/icon.png（1024）/ icon-512.png / icon-256.png，圆角外透明。

依赖：python -m pip install pillow
用法：python scripts/prepare-icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
SRC = BUILD / "icon-source.jpg"
RADIUS = 120  # 源图圆角（1024 坐标）
INSET = 2  # 向内收 2px，避开 JPEG 白底产生的浅色描边


def rounded_mask(size: int, radius: int, inset: int) -> Image.Image:
    s = size * 4
    mask = Image.new("L", (s, s), 0)
    draw = ImageDraw.Draw(mask)
    pad = inset * 4
    draw.rounded_rectangle(
        [pad, pad, s - 1 - pad, s - 1 - pad],
        radius=radius * 4,
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"缺少源图：{SRC}")
    im = Image.open(SRC).convert("RGB")
    out = im.convert("RGBA")
    out.putalpha(rounded_mask(im.width, RADIUS, INSET))

    targets = [(1024, "icon.png"), (512, "icon-512.png"), (256, "icon-256.png")]
    for size, name in targets:
        resized = out if size == im.width else out.resize((size, size), Image.LANCZOS)
        path = BUILD / name
        resized.save(path)
        print(f"已生成 {path}（{path.stat().st_size / 1024:.1f} KB）")


if __name__ == "__main__":
    main()
