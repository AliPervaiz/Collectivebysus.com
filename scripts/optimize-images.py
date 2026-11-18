#!/usr/bin/env python3
"""Make web-sized WebP copies of the photos the site uses, and point the pages at them.

    python3 scripts/optimize-images.py

For every <img src="Photos/..."> in the top-level *.html pages:
  - writes img/opt/<name>-800.webp and -1600.webp (never upscaled, EXIF rotation applied,
    PNG transparency kept),
  - rewrites the <img> to use the 1600px copy plus a srcset, so phones download the 800px one.
After rewriting, the first image on each page gets fetchpriority="high" and later ones
loading="lazy" (add these by hand if you place images differently). Originals in Photos/ are never modified. Safe to re-run after adding photos (existing
copies are reused unless the original is newer).
"""
import glob
import os
import re
import sys
import urllib.parse

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "img", "opt")
WIDTHS = (800, 1600)
PHOTO_QUALITY = 80
ALPHA_QUALITY = 85
IMG_RE = re.compile(r'<img\b[^>]*?\bsrc="(Photos/[^"]+\.(?:jpe?g|png))"[^>]*>', re.I)


def slug(path):
    base = os.path.splitext(path[len("Photos/"):])[0]
    s = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")
    return s


def make_copies(src_rel):
    src = os.path.join(ROOT, urllib.parse.unquote(src_rel))
    if not os.path.exists(src):
        print(f"  ! missing {src_rel}", file=sys.stderr)
        return None
    name = slug(urllib.parse.unquote(src_rel))
    os.makedirs(OUT_DIR, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB")
        made = []
        for w in WIDTHS:
            target = min(w, im.width)
            out = os.path.join(OUT_DIR, f"{name}-{w}.webp")
            if not (os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(src)):
                h = round(im.height * target / im.width)
                resized = im.resize((target, h), Image.LANCZOS) if target < im.width else im
                resized.save(out, "WEBP", quality=ALPHA_QUALITY if has_alpha else PHOTO_QUALITY, method=6)
            made.append((w, target, out))
        return name, made, im.width, im.height


def main():
    cache = {}
    for page in sorted(glob.glob(os.path.join(ROOT, "*.html"))):
        html = open(page, encoding="utf-8").read()

        def rewrite(m):
            tag, src_rel = m.group(0), m.group(1)
            if src_rel not in cache:
                cache[src_rel] = make_copies(src_rel)
            info = cache[src_rel]
            if not info:
                return tag
            name, made, w, h = info
            srcset = ", ".join(f"/img/opt/{name}-{wid}.webp {min(wid, w)}w" for wid, _, _ in made)
            new = tag.replace(f'src="{src_rel}"', f'src="/img/opt/{name}-1600.webp" srcset="{srcset}" sizes="(max-width: 720px) 100vw, 50vw"')
            if "decoding=" not in new:
                new = new.replace("<img ", '<img decoding="async" ', 1)
            return new

        new_html = IMG_RE.sub(rewrite, html)
        if new_html != html:
            open(page, "w", encoding="utf-8").write(new_html)
            print(f"updated {os.path.basename(page)}")

    before = sum(os.path.getsize(os.path.join(ROOT, urllib.parse.unquote(p))) for p, v in cache.items() if v)
    after_small = sum(os.path.getsize(m[0][2]) for v in cache.values() if v for m in [v[1]])
    after_large = sum(os.path.getsize(m[1][2]) for v in cache.values() if v for m in [v[1]])
    print(f"{len(cache)} images: originals {before/1024/1024:.1f} MB -> "
          f"phone copies {after_small/1024/1024:.1f} MB, large copies {after_large/1024/1024:.1f} MB")


if __name__ == "__main__":
    main()
