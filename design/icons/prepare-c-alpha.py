#!/usr/bin/env python3
"""Extract the approved C tile; requires Pillow only, never used during installation."""
from hashlib import sha256
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
source = root / 'archive/three-floors-colors-v1/C-white-sky.png'
expected = '78fa59d6dc73470ea9b29ceafc642938fab6885f58c11cc73c86f666bfec7942'
if sha256(source.read_bytes()).hexdigest() != expected:
    raise SystemExit('This extraction is calibrated only for the archived, approved C original.')

original = Image.open(source).convert('RGB')
width, height = original.size
pixels = original.load()
boundary = []
for y in range(height):
    # The cyan rim separates the tile from the neutral exterior and its shadow.
    xs = [x for x in range(width) if pixels[x, y][2] - pixels[x, y][0] > 20
          and pixels[x, y][2] - pixels[x, y][1] > 2]
    if xs:
        for x in (xs[0] - 0.5, xs[-1] + 0.5):
            boundary.extend(((x, y - 0.5), (x, y + 0.5)))

def cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

def half_hull(points):
    result = []
    for point in points:
        while len(result) >= 2 and cross(result[-2], result[-1], point) <= 0:
            result.pop()
        result.append(point)
    return result[:-1]

points = sorted(set(boundary))
hull = half_hull(points) + half_hull(reversed(points))
scale = 4
mask = Image.new('L', (width * scale, height * scale), 0)
ImageDraw.Draw(mask).polygon([(round(x * scale), round(y * scale)) for x, y in hull], fill=255)
mask = mask.resize(original.size, Image.Resampling.LANCZOS)
output = original.convert('RGBA')
output.putalpha(mask)
destination = root / 'production/C-white-sky-transparent-source.png'
destination.parent.mkdir(parents=True, exist_ok=True)
output.save(destination, optimize=True)
print(f'Wrote {destination.relative_to(root)}: {output.size}, alpha {mask.getextrema()}')
