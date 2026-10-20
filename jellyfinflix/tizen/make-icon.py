#!/usr/bin/env python3
"""Draw the JellyfinFlix app icon (512x423, Samsung TV size): white tile, tall condensed wordmark
"JELLYFIN" in near-black + "FLIX" in red, gently curved like a cinema marquee.
Font: Anton (SIL Open Font Licence, see fonts/OFL.txt)."""
from PIL import Image, ImageDraw, ImageFont
import os

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 512, 423
INK, RED = (20, 20, 22, 255), (229, 9, 20, 255)
font = ImageFont.truetype(os.path.join(HERE, 'fonts', 'Anton-Regular.ttf'), 132)

# 1) draw the flat wordmark on a wide transparent strip
parts = [('JELLYFIN', INK), ('FLIX', RED)]
widths = [font.getbbox(t)[2] - font.getbbox(t)[0] for t, _ in parts]
gap = 4
strip_w, strip_h = sum(widths) + gap + 20, 190
strip = Image.new('RGBA', (strip_w, strip_h), (0, 0, 0, 0))
d = ImageDraw.Draw(strip)
x = 10
for (t, c), w in zip(parts, widths):
    d.text((x - font.getbbox(t)[0], 18), t, font=font, fill=c)
    x += w + gap

# 2) squeeze to fit the tile width, then bend: the middle rises and the ends grow taller (marquee curve)
target_w = W - 56
strip = strip.resize((target_w, int(strip_h * 0.95)), Image.LANCZOS)
sw, sh = strip.size
curved = Image.new('RGBA', (sw, sh + 60), (0, 0, 0, 0))
for cx in range(sw):
    t = (cx / (sw - 1)) * 2 - 1            # -1 .. 1 across the word
    lift = int(22 * (1 - t * t))           # middle rises 22 px
    scale = 1 + 0.10 * t * t               # ends 10 % taller
    col = strip.crop((cx, 0, cx + 1, sh)).resize((1, int(sh * scale)), Image.LANCZOS)
    curved.paste(col, (cx, 40 - lift - int((sh * scale - sh) / 2)), col)

# 3) white rounded tile, wordmark centred, short red bar underneath
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
tile = ImageDraw.Draw(img)
tile.rounded_rectangle([0, 0, W - 1, H - 1], radius=56, fill=(255, 255, 255, 255))
curved = curved.crop(curved.getbbox())
img.paste(curved, ((W - curved.width) // 2, (H - curved.height) // 2 - 6), curved)
tile.rounded_rectangle([W // 2 - 90, H - 74, W // 2 + 90, H - 64], radius=5, fill=RED)
img.save(os.path.join(HERE, 'icon.png'))
print('icon.png written')
