#!/usr/bin/env python3
"""Draw the JellyfinFlix app icon (512x423, Samsung TV size): dark tile, white "J", red "F", red bar."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 512, 423
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=56, fill=(16, 16, 20, 255))
font = None
for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']:
    if os.path.exists(p):
        font = ImageFont.truetype(p, 250)
        break
red = (229, 9, 20, 255)
d.text((112, 70), 'J', font=font, fill=(244, 244, 246, 255))
d.text((262, 70), 'F', font=font, fill=red)
d.rounded_rectangle([110, 340, 402, 362], radius=11, fill=red)
img.save(os.path.join(os.path.dirname(__file__), 'icon.png'))
print('icon.png written')
