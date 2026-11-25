"""Build the bundled Swarm Sort image set from Caltech 101 (CC BY 4.0).

Dev-only script (the dataset output is committed, so users never run this).
Usage: python3 scripts/prepare_dataset.py /path/to/101_ObjectCategories
Needs Pillow. Picks images evenly across categories, resizes the shortest edge
to 256 px (bicubic) and center-crops 224x224 to match MobileNetV3's preprocessing.
"""
import json, os, sys
from PIL import Image

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'swarmsort')
TARGET = 1000
# Skip the clutter class, the human-face classes (no people in a privacy-first demo),
# and the two trademarked cartoon characters.
SKIP = {'BACKGROUND_Google', 'Faces', 'Faces_easy', 'garfield', 'snoopy'}

cats = sorted(c for c in os.listdir(SRC) if c not in SKIP and os.path.isdir(os.path.join(SRC, c)))
files = {c: sorted(f for f in os.listdir(os.path.join(SRC, c)) if f.endswith('.jpg')) for c in cats}
picked = []
per = TARGET // len(cats)
extra = TARGET - per * len(cats)
for i, c in enumerate(cats):
    n = per + (1 if i < extra else 0)
    fs = files[c]
    step = len(fs) / n
    picked += [(c, fs[int(k * step)]) for k in range(n)]

os.makedirs(os.path.join(OUT, 'images'), exist_ok=True)
items = []
for idx, (c, f) in enumerate(picked):
    im = Image.open(os.path.join(SRC, c, f)).convert('RGB')
    w, h = im.size
    s = 256 / min(w, h)
    im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    im = im.crop((l, t, l + 224, t + 224))
    name = f'{idx:04d}.jpg'
    im.save(os.path.join(OUT, 'images', name), quality=85, optimize=True)
    items.append({'file': name, 'category': c, 'source': f'101_ObjectCategories/{c}/{f}'})

manifest = {
    'name': 'Swarm Sort image set',
    'count': len(items),
    'size': [224, 224],
    'source': 'Caltech 101 (Li, Andreeto, Ranzato, Perona, 2022), https://doi.org/10.22002/D1.20086',
    'license': 'CC BY 4.0, https://creativecommons.org/licenses/by/4.0/',
    'changes': 'Subset of 1000 images across 97 categories; resized (shortest edge 256) and center-cropped to 224x224; re-encoded as JPEG q85.',
    'items': items,
}
with open(os.path.join(OUT, 'manifest.json'), 'w') as fh:
    json.dump(manifest, fh, indent=1)
print(len(items), 'images,', len(cats), 'categories')
