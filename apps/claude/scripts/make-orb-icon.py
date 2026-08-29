#!/usr/bin/env python3
"""Generate the transparent glossy-orb app icon (matches the widget HUD)."""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 2048            # supersampled working size
OUT = 1024
FILL = 0.60         # liquid fill fraction (visual reference: 60% 已用)

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))

def vgrad(size, top, bot):
    w, h = size
    g = Image.new("RGB", (1, h))
    for y in range(h):
        g.putpixel((0, y), lerp(top, bot, y / (h - 1)))
    return g.resize((w, h))

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

margin = int(S * 0.055)
box = (margin, margin, S - margin, S - margin)
d = box[2] - box[0]

# --- circular mask ---
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).ellipse(box, fill=255)

# --- soft outer shadow (still transparent background) ---
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
soff = int(S * 0.018)
sd.ellipse((box[0], box[1] + soff, box[2], box[3] + soff), fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(int(S * 0.03)))
img = Image.alpha_composite(img, shadow)

# --- body: dark charcoal sphere ---
body = vgrad((S, S), (86, 88, 92), (30, 31, 34)).convert("RGBA")

# --- green liquid in the lower FILL portion ---
liquid = vgrad((S, S), (120, 199, 140), (58, 148, 92)).convert("RGBA")
lmask = Image.new("L", (S, S), 0)
ld = ImageDraw.Draw(lmask)
water_y = int(box[1] + d * (1 - FILL))
ld.rectangle((0, water_y, S, S), fill=255)
body.paste(liquid, (0, 0), lmask)

# meniscus highlight line
ml = ImageDraw.Draw(body)
ml.rectangle((0, water_y - int(S*0.006), S, water_y + int(S*0.006)),
             fill=(200, 240, 210, 255))

sphere = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sphere.paste(body, (0, 0), mask)

# --- inner rim shading for volume ---
rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(rim)
rd.ellipse(box, outline=(255, 255, 255, 60), width=int(S * 0.012))
rd.ellipse((box[0]+int(S*0.02), box[1]+int(S*0.02), box[2]-int(S*0.02), box[3]-int(S*0.02)),
           outline=(0, 0, 0, 90), width=int(S * 0.02))
rim = rim.filter(ImageFilter.GaussianBlur(int(S * 0.006)))
sphere = Image.alpha_composite(sphere, rim)

# --- glossy top highlight ---
gloss = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(gloss)
gx0, gy0 = box[0] + int(d * 0.16), box[1] + int(d * 0.06)
gx1, gy1 = box[0] + int(d * 0.84), box[1] + int(d * 0.46)
gd.ellipse((gx0, gy0, gx1, gy1), fill=(255, 255, 255, 120))
gloss = gloss.filter(ImageFilter.GaussianBlur(int(S * 0.03)))
gmask = mask.point(lambda p: p)
gloss.putalpha(Image.composite(gloss.getchannel("A"), Image.new("L", (S, S), 0), mask))
sphere = Image.alpha_composite(sphere, gloss)

# small bright spec
spec = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(spec).ellipse(
    (box[0] + int(d*0.24), box[1] + int(d*0.12),
     box[0] + int(d*0.42), box[1] + int(d*0.24)), fill=(255, 255, 255, 210))
spec = spec.filter(ImageFilter.GaussianBlur(int(S * 0.012)))
sphere = Image.alpha_composite(sphere, spec)

# --- text ---
def font(path_list, size):
    for p in path_list:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

f_pct = font(["/System/Library/Fonts/Supplemental/Arial Black.ttf",
              "/System/Library/Fonts/Helvetica.ttc"], int(S * 0.24))
f_lbl = font(["/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/System/Library/Fonts/STHeiti Medium.ttc"], int(S * 0.085))

td = ImageDraw.Draw(sphere)
cx = S // 2
pct_y = int(S * 0.44)
lbl_y = int(S * 0.60)
for dx, dy, col in [(0, int(S*0.006), (0, 0, 0, 110)), (0, 0, (255, 255, 255, 255))]:
    td.text((cx + dx, pct_y + dy), "60%", font=f_pct, fill=col, anchor="mm")
td.text((cx, lbl_y), "已用", font=f_lbl, fill=(240, 255, 245, 235), anchor="mm")

out = sphere.resize((OUT, OUT), Image.LANCZOS)
dst = os.path.join(os.path.dirname(__file__), "..", "assets")
out.save(os.path.join(dst, "app-icon.png"))
out.resize((256, 256), Image.LANCZOS).save(os.path.join(dst, "app-icon-256.png"))
out.resize((16, 16), Image.LANCZOS).save(os.path.join(dst, "app-icon-tray-16.png"))
print("wrote assets/app-icon.png (+256, +tray-16)")
