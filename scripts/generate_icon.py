# Generate the Pluto's Terminals app icon source PNG.
# Output: src-tauri/icons/source.png (1024x1024)
# Then run: cargo tauri icon src-tauri/icons/source.png
# Design language: dark rounded square + white chevron prompt + magenta cursor block.
# Magenta is Pluto's brand mark color (matches the corner-bug + wordmark dot from media/brand/).

from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

SIZE = 1024
RADIUS = 230  # rounded-square radius (Apple-ish proportions)

BG = (10, 10, 10, 255)            # #0a0a0a — matches app PAGE_BG
CHEVRON = (230, 230, 230, 255)    # near-white, soft enough at small sizes
PLUTO_MAGENTA = (255, 0, 128, 255)  # Pluto signature color (matches corner-bug, wordmark dot)
TRAY_DOT_DIM = (60, 60, 60, 255)  # the two non-magenta terminal-chrome dots


def rounded_square(size, radius, color):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=color)
    return img


def main():
    canvas = rounded_square(SIZE, RADIUS, BG)
    draw = ImageDraw.Draw(canvas)

    # ── terminal-window chrome at the top ───────────────────────────
    # 3 dots, one magenta (left, signature), two dim grays. Read at small sizes
    # as "terminal window," which is what this app is.
    dot_y = 130
    dot_r = 38
    spacing = 110
    # Pluto-magenta dot — far left, signature position
    cx = 200
    draw.ellipse((cx - dot_r, dot_y - dot_r, cx + dot_r, dot_y + dot_r), fill=PLUTO_MAGENTA)
    # Dim dots — the "minimize" / "maximize" of the metaphor
    for i in (1, 2):
        cx2 = 200 + i * spacing
        draw.ellipse((cx2 - dot_r, dot_y - dot_r, cx2 + dot_r, dot_y + dot_r), fill=TRAY_DOT_DIM)

    # ── chevron ">" — drawn as two thick strokes forming a clean V on its side ─
    # Centered horizontally a bit to the left of mid; cursor sits to the right.
    cx_chev = 380
    cy_chev = 580
    chev_size = 200          # half-height of the chevron
    chev_width = 70          # stroke width
    chev_open = 180          # how far the chevron "opens"

    # Top stroke of >:  ( cx - chev_open/2 , cy - chev_size ) → ( cx + chev_open/2 , cy )
    # Bottom stroke of >: ( cx - chev_open/2 , cy + chev_size ) → ( cx + chev_open/2 , cy )
    top_start = (cx_chev - chev_open // 2, cy_chev - chev_size)
    middle = (cx_chev + chev_open // 2, cy_chev)
    bottom_start = (cx_chev - chev_open // 2, cy_chev + chev_size)
    draw.line([top_start, middle], fill=CHEVRON, width=chev_width, joint="curve")
    draw.line([middle, bottom_start], fill=CHEVRON, width=chev_width, joint="curve")

    # ── magenta cursor block (the "_" of >_, but as a solid block — terminal idiom) ─
    # Sits to the right of the chevron, slightly lower than chevron's vertical center.
    cur_x = cx_chev + chev_open // 2 + 90
    cur_y = cy_chev + 30
    cur_w = 280
    cur_h = 100
    cur_radius = 14
    draw.rounded_rectangle(
        (cur_x, cur_y, cur_x + cur_w, cur_y + cur_h),
        radius=cur_radius,
        fill=PLUTO_MAGENTA,
    )

    # ── soft inner glow around the rounded rect for depth ──────────────
    # Subtle — most app icons have this; helps avoid the icon looking flat
    # at smaller sizes.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.rounded_rectangle((4, 4, SIZE - 5, SIZE - 5), radius=RADIUS - 4, outline=(40, 40, 40, 255), width=4)
    glow = glow.filter(ImageFilter.GaussianBlur(radius=4))
    canvas = Image.alpha_composite(canvas, glow)

    # ── save ───────────────────────────────────────────────────────────
    out_path = Path(__file__).parent.parent / "src-tauri" / "icons" / "source.png"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, "PNG")
    print(f"Wrote {out_path} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
