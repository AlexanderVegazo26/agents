#!/usr/bin/env python3
"""Motion-graphics renderer for /videoedit. Runs INSIDE the bubblewrap sandbox (no network, only the job's
work dir writable): it reads `plan.json`, draws each card as an animated sequence and writes, per card,

    g/<id>/a_%04d.png   RGBA  the glass tint, highlight, shadow and text ("art")
    g/<id>/m_%04d.png   gray  the panel shape (alpha-merged onto a blurred copy of the real video by ffmpeg,
                              which is what makes it glass)
    g/<id>.json         {"x","y","w","h","frames"}  where the frames go in the video

Why two layers: the blur behind a glass panel has to be of the actual video, which only ffmpeg has. The
mask says where the glass is (and fades/scales with it); the art is drawn over it.

Text in the plan is untrusted (it comes from a transcript or a model): it is only ever drawn as pixels.
Standard library + pycairo + Pillow + numpy; no other input is read. Run: python3 -I video_graphics.py plan.json
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import cairo
import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = 40_000_000  # refuse decompression bombs in user-supplied images

THEMES = {
    "aurora": {"a": (0.43, 0.91, 0.98), "b": (0.65, 0.55, 0.98), "ink": (1, 1, 1), "dark": (0.04, 0.06, 0.12)},
    "sunset": {"a": (1.00, 0.72, 0.35), "b": (0.98, 0.35, 0.55), "ink": (1, 1, 1), "dark": (0.10, 0.05, 0.08)},
    "mint": {"a": (0.45, 0.98, 0.72), "b": (0.30, 0.75, 0.95), "ink": (1, 1, 1), "dark": (0.03, 0.09, 0.09)},
}
FONT = {"black": "Lato Black", "bold": "Lato", "semi": "Lato Semibold", "medium": "Lato Medium", "regular": "Lato"}
MAX_CARDS = 12
MAX_FRAMES = 300


# ------------------------------------------------------------------ easing
def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def out_cubic(x):
    x = clamp(x)
    return 1 - (1 - x) ** 3


def in_cubic(x):
    return clamp(x) ** 3


def out_back(x, k=1.5):
    x = clamp(x)
    return 1 + (k + 1) * (x - 1) ** 3 + k * (x - 1) ** 2


def lerp(a, b, t):
    return a + (b - a) * t


# ------------------------------------------------------------------ text helpers
def set_font(ctx, weight: str, size: float):
    ctx.select_font_face(FONT[weight], cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if weight in ("bold", "black") else cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(size)


def text_w(ctx, s: str) -> float:
    return ctx.text_extents(s).x_advance


def wrap(ctx, text: str, weight: str, size: float, max_w: float, max_lines: int) -> tuple[list[str], float]:
    """Greedy word wrap that shrinks the font (down to 70%) until it fits max_lines; the last line gets an
    ellipsis if it still does not. Returns (lines, size used)."""
    words = text.split()
    for shrink in (1.0, 0.92, 0.84, 0.77, 0.70):
        sz = size * shrink
        set_font(ctx, weight, sz)
        lines, cur = [], ""
        for w in words:
            trial = (cur + " " + w).strip()
            if text_w(ctx, trial) <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)
        if len(lines) <= max_lines and all(text_w(ctx, l) <= max_w * 1.001 for l in lines):
            return lines, sz
    lines = lines[:max_lines]
    while lines and text_w(ctx, lines[-1] + "…") > max_w and len(lines[-1]) > 1:
        lines[-1] = lines[-1][:-1].rstrip()
    if lines:
        lines[-1] += "…"
    return lines, sz


def clean(s, n: int) -> str:
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(s or ""))
    return re.sub(r"\s+", " ", s).strip()[:n]


def rrect(ctx, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi / 2, 0)
    ctx.arc(x + w - r, y + h - r, r, 0, math.pi / 2)
    ctx.arc(x + r, y + h - r, r, math.pi / 2, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, 3 * math.pi / 2)
    ctx.close_path()


# ------------------------------------------------------------------ layout
class Card:
    """One card: its measured layout plus draw(art/mask, t)."""

    def __init__(self, spec: dict, W: int, H: int, theme: dict):
        self.spec, self.W, self.H, self.th = spec, W, H, theme
        self.type = spec["type"]
        self.dur = float(spec["dur"])
        self.s = min(W, H) / 1080.0 if W < H else H / 1080.0
        s = self.s
        vertical = H > W
        self.pad = int(56 * s)                                   # room around the panel for the shadow
        probe = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 8, 8))
        self.title = clean(spec.get("title"), 90)
        self.body = clean(spec.get("body"), 170)
        self.value = clean(spec.get("value"), 14)
        self.n = int(spec["n"]) if str(spec.get("n", "")).isdigit() else 0
        self.img = None
        if self.type == "title":
            pw = (0.86 if vertical else 0.56) * W
            self._measure(probe, pw, title=(84, "black", 3), body=(40, "medium", 3), pad_x=64, pad_y=64, bar=True)
            self.px, self.py = (W - self.pw) / 2, H * (0.40 if vertical else 0.34)
            self.slide = (0, 0)
        elif self.type == "lower":
            pw = (0.66 if vertical else 0.34) * W
            self._measure(probe, pw, title=(46, "bold", 1), body=(31, "medium", 2), pad_x=44, pad_y=30, accent_bar=True, shrink_w=True)
            self.px, self.py = 56 * s, H * (0.60 if vertical else 0.70)
            self.slide = (-1, 0)
        elif self.type == "stat":
            pw = (0.80 if vertical else 0.38) * W
            self._measure(probe, pw, title=(0, "bold", 0), body=(40, "medium", 2), pad_x=52, pad_y=44, stat=True)
            self.px, self.py = (W - self.pw) / 2, H * (0.10 if vertical else 0.09)
            self.slide = (0, 1)
        elif self.type == "image":
            pw = (0.78 if vertical else 0.34) * W
            self._measure_image(probe, pw, spec)
            self.px, self.py = (W - self.pw) / 2, H * (0.09 if vertical else 0.08)
            self.slide = (0, 1)
        else:  # keypoint
            pw = (0.88 if vertical else 0.40) * W
            self._measure(probe, pw, title=(52, "bold", 2), body=(35, "regular", 3), pad_x=40, pad_y=36, badge=self.n > 0)
            self.px, self.py = (W - self.pw) / 2, H * (0.10 if vertical else 0.09)
            self.slide = (0, 1)
        self.px, self.py = int(self.px), int(self.py)
        # bbox in video coordinates (clamped to the frame)
        bx, by = self.px - self.pad, self.py - self.pad
        bw, bh = int(self.pw) + 2 * self.pad, int(self.ph) + 2 * self.pad
        self.bx, self.by = max(0, bx), max(0, by)
        self.bw, self.bh = min(W - self.bx, bw + (bx - self.bx)), min(H - self.by, bh + (by - self.by))
        self.bw -= self.bw % 2
        self.bh -= self.bh % 2

    def _measure(self, ctx, pw, title, body, pad_x, pad_y, badge=False, bar=False, accent_bar=False, stat=False, shrink_w=False):
        s = self.s
        self.pad_x, self.pad_y = pad_x * s, pad_y * s
        inner = pw - 2 * self.pad_x - (84 * s if badge else 0) - (22 * s if accent_bar else 0)
        self.badge, self.bar, self.accent_bar, self.stat = badge, bar, accent_bar, stat
        self.t_lines, self.t_size, self.t_w = [], 0, "bold"
        self.b_lines, self.b_size, self.b_w = [], 0, "regular"
        h = 0.0
        if stat and self.value:
            self.v_size = 150 * s
            set_font(ctx, "black", self.v_size)
            while text_w(ctx, self.value) > inner and self.v_size > 60 * s:
                self.v_size *= 0.92
                set_font(ctx, "black", self.v_size)
            h += self.v_size * 0.92
        if title[0] and self.title:
            self.t_w = title[1]
            self.t_lines, self.t_size = wrap(ctx, self.title, title[1], title[0] * s, inner, title[2])
            h += len(self.t_lines) * self.t_size * 1.16
        if body[0] and self.body:
            self.b_w = body[1]
            self.b_lines, self.b_size = wrap(ctx, self.body, body[1], body[0] * s, inner, body[2])
            h += (14 * s if (self.t_lines or stat) else 0) + len(self.b_lines) * self.b_size * 1.28
        if bar:
            h += 26 * s
        self.ph = max(h + 2 * self.pad_y, 150 * s)
        widest = 0.0   # each group is measured in ITS OWN font, or a hugging panel clips its longest line
        if self.t_lines:
            set_font(ctx, self.t_w, self.t_size)
            widest = max(widest, *(text_w(ctx, l) for l in self.t_lines))
        if self.b_lines:
            set_font(ctx, self.b_w, self.b_size)
            widest = max(widest, *(text_w(ctx, l) for l in self.b_lines))
        if stat and self.value:
            set_font(ctx, "black", self.v_size)
            widest = max(widest, text_w(ctx, self.value))
        if shrink_w:  # lower third hugs its text
            self.pw = min(pw, widest + 2 * self.pad_x + 22 * s)
        else:
            self.pw = pw

    def _measure_image(self, ctx, pw, spec):
        s = self.s
        self.pad_x = self.pad_y = 18 * s
        self.badge = self.bar = self.accent_bar = self.stat = False
        self.pw = pw
        self.t_lines, self.b_lines = [], []
        path = spec.get("img")
        im = Image.open(path).convert("RGB") if path else None
        self.img = im
        iw = pw - 2 * self.pad_x
        ih = iw * 0.62 if im is None else min(iw * 0.78, iw * im.height / im.width)
        self.img_box = (iw, ih)
        cap_h = 0
        if self.title:
            self.t_w = "semi"
            self.t_lines, self.t_size = wrap(ctx, self.title, "semi", 36 * s, iw - 12 * s, 2)
            cap_h = len(self.t_lines) * self.t_size * 1.2 + 18 * s
        self.ph = ih + cap_h + 2 * self.pad_y

    # -------------------------------------------------------------- animation
    def state(self, t: float):
        tin, tout = 0.55, 0.40
        pin = out_back(t / tin)
        fin = out_cubic(t / 0.34)
        q = clamp((t - (self.dur - tout)) / tout)
        alpha = fin * (1 - in_cubic(q))
        scale = lerp(0.90, 1.0, pin) * lerp(1.0, 0.97, q)
        dy = (1 - clamp(pin, 0, 1.15)) * 44 * self.s * (1 if self.slide[1] >= 0 else -1) + q * 16 * self.s
        dx = (1 - out_cubic(t / 0.6)) * 220 * self.s * self.slide[0] if self.slide[0] else 0.0
        return alpha, scale, dx, dy

    # -------------------------------------------------------------- drawing
    def _panel_path(self, ctx):
        rrect(ctx, self.px - self.bx, self.py - self.by, self.pw, self.ph, 30 * self.s)

    def render(self, t: float) -> tuple[Image.Image, Image.Image]:
        alpha, scale, dx, dy = self.state(t)
        size = (self.bw, self.bh)
        # ---- mask
        ms = cairo.ImageSurface(cairo.FORMAT_ARGB32, *size)
        mc = cairo.Context(ms)
        self._xform(mc, scale, dx, dy)
        self._panel_path(mc)
        mc.set_source_rgba(1, 1, 1, 1)
        mc.fill()
        m = np.frombuffer(ms.get_data(), dtype=np.uint8).reshape(self.bh, self.bw, 4)[..., 3].astype(np.float32) / 255.0
        mask = Image.fromarray((m * alpha * 255 + 0.5).astype(np.uint8), "L")
        # ---- art: shadow (blurred), tint, rim light, content
        surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, *size)
        ctx = cairo.Context(surf)
        sh = cairo.ImageSurface(cairo.FORMAT_ARGB32, *size)
        sc = cairo.Context(sh)
        self._xform(sc, scale, dx, dy + 10 * self.s)
        self._panel_path(sc)
        sc.set_source_rgba(0, 0, 0, 0.55)
        sc.fill()
        shadow = Image.frombuffer("RGBA", size, bytes(sh.get_data()), "raw", "BGRa", 0, 1).filter(ImageFilter.GaussianBlur(20 * self.s))
        sa = np.asarray(shadow, dtype=np.float32)
        # remove the shadow under the glass itself (the mask area), so the blurred video stays bright
        sa[..., 3] *= (1 - m) * 0.9 * alpha
        # the shadow is pure black, so premultiplied BGRA bytes equal straight RGBA bytes here
        ctx.set_source_surface(cairo.ImageSurface.create_for_data(bytearray(sa.astype(np.uint8).tobytes()), cairo.FORMAT_ARGB32, *size, self.bw * 4), 0, 0)
        ctx.paint()
        ctx.push_group()
        self._xform(ctx, scale, dx, dy)
        self._glass(ctx)
        self._content(ctx, t)
        ctx.pop_group_to_source()
        ctx.paint_with_alpha(alpha)
        art = Image.frombuffer("RGBA", size, bytes(surf.get_data()), "raw", "BGRa", 0, 1)
        return art, mask

    def _xform(self, ctx, scale, dx, dy):
        cx, cy = self.px - self.bx + self.pw / 2, self.py - self.by + self.ph / 2
        ctx.translate(cx + dx, cy + dy)
        ctx.scale(scale, scale)
        ctx.translate(-cx, -cy)

    def _glass(self, ctx):
        s, th = self.s, self.th
        x, y, w, h = self.px - self.bx, self.py - self.by, self.pw, self.ph
        # dark base so white text stays legible on a bright video, then a white sheen that reads as glass
        self._panel_path(ctx)
        d = th["dark"]
        ctx.set_source_rgba(d[0], d[1], d[2], 0.30)
        ctx.fill()
        g = cairo.LinearGradient(x, y, x + w * 0.35, y + h)
        g.add_color_stop_rgba(0, 1, 1, 1, 0.22)
        g.add_color_stop_rgba(0.55, 1, 1, 1, 0.07)
        g.add_color_stop_rgba(1, 1, 1, 1, 0.12)
        self._panel_path(ctx)
        ctx.set_source(g)
        ctx.fill()
        # rim light: bright on the top-left edge, fading to the bottom-right
        rim = cairo.LinearGradient(x, y, x + w, y + h)
        rim.add_color_stop_rgba(0, 1, 1, 1, 0.75)
        rim.add_color_stop_rgba(0.45, 1, 1, 1, 0.16)
        rim.add_color_stop_rgba(1, 1, 1, 1, 0.34)
        rrect(ctx, x + 0.75 * s, y + 0.75 * s, w - 1.5 * s, h - 1.5 * s, 29.5 * s)
        ctx.set_line_width(max(1.6, 1.8 * s))
        ctx.set_source(rim)
        ctx.stroke()

    def _accent(self, x0, y0, x1, y1):
        g = cairo.LinearGradient(x0, y0, x1, y1)
        a, b = self.th["a"], self.th["b"]
        g.add_color_stop_rgb(0, *a)
        g.add_color_stop_rgb(1, *b)
        return g

    def _content(self, ctx, t: float):
        s = self.s
        x, y, w, h = self.px - self.bx, self.py - self.by, self.pw, self.ph
        ink = self.th["ink"]
        cx = x + self.pad_x
        cy = y + self.pad_y
        if self.type == "image":
            self._content_image(ctx, t, x, y)
            return

        def reveal(delay):  # staggered fade + rise of each text block
            k = out_cubic((t - delay) / 0.38)
            return k, (1 - k) * 14 * s

        if self.accent_bar:
            k = out_cubic(t / 0.5)
            ctx.set_source(self._accent(x, y, x, y + h))
            rrect(ctx, x + 26 * s, y + 26 * s, 6 * s, (h - 52 * s) * k, 3 * s)
            ctx.fill()
            cx += 22 * s
        if self.badge:
            r = 31 * s
            bx, by = cx + r, cy + r + 2 * s
            ctx.arc(bx, by, r, 0, 2 * math.pi)
            ctx.set_source(self._accent(bx - r, by - r, bx + r, by + r))
            ctx.fill()
            set_font(ctx, "black", 34 * s)
            label = str(self.n)
            ex = ctx.text_extents(label)
            ctx.set_source_rgba(0.05, 0.07, 0.14, 1)
            ctx.move_to(bx - ex.x_advance / 2, by + ex.height / 2 - 1 * s)
            ctx.show_text(label)
            cx += 84 * s
        ty = cy
        if self.stat and self.value:
            k, off = reveal(0.08)
            set_font(ctx, "black", self.v_size)
            asc = self.v_size * 0.82
            ctx.move_to(cx, ty + asc + off)
            ctx.text_path(self.value)
            ctx.set_source(self._accent(cx, ty, cx + text_w(ctx, self.value), ty + asc))
            ctx.save()
            ctx.clip_preserve()
            ctx.paint_with_alpha(k)
            ctx.restore()
            ctx.new_path()
            ty += self.v_size * 0.92
        if self.t_lines:
            k, off = reveal(0.10)
            set_font(ctx, self.t_w, self.t_size)
            for i, line in enumerate(self.t_lines):
                ctx.move_to(cx, ty + self.t_size * (1.0 + 1.16 * i) - self.t_size * 0.18 + off)
                ctx.set_source_rgba(ink[0], ink[1], ink[2], k)
                ctx.show_text(line)
            ty += len(self.t_lines) * self.t_size * 1.16
        if self.b_lines:
            ty += 14 * s if (self.t_lines or self.stat) else 0
            k, off = reveal(0.20)
            set_font(ctx, self.b_w, self.b_size)
            for i, line in enumerate(self.b_lines):
                ctx.move_to(cx, ty + self.b_size * (1.0 + 1.28 * i) - self.b_size * 0.20 + off)
                ctx.set_source_rgba(ink[0], ink[1], ink[2], 0.80 * k)
                ctx.show_text(line)
        if self.bar:
            k = out_cubic((t - 0.25) / 0.7)
            by = y + h - self.pad_y - 8 * s
            ctx.set_source(self._accent(cx, by, cx + 160 * s, by))
            rrect(ctx, cx, by, 160 * s * k, 7 * s, 3.5 * s)
            ctx.fill()

    def _content_image(self, ctx, t, x, y):
        s = self.s
        iw, ih = self.img_box
        ix, iy = x + self.pad_x, y + self.pad_y
        ctx.save()
        rrect(ctx, ix, iy, iw, ih, 20 * s)
        ctx.clip()
        if self.img is not None:
            zoom = 1.0 + 0.10 * clamp(t / self.dur)                       # slow Ken Burns push-in
            im = self.img
            scale = max(iw / im.width, ih / im.height) * zoom
            nw, nh = max(1, int(im.width * scale)), max(1, int(im.height * scale))
            r = im.resize((nw, nh), Image.LANCZOS)
            r = r.crop(((nw - int(iw)) // 2, (nh - int(ih)) // 2, (nw - int(iw)) // 2 + int(iw), (nh - int(ih)) // 2 + int(ih)))
            a = np.asarray(r.convert("RGBA"), dtype=np.uint8)[..., [2, 1, 0, 3]].copy()
            surf = cairo.ImageSurface.create_for_data(bytearray(a.tobytes()), cairo.FORMAT_ARGB32, a.shape[1], a.shape[0], a.shape[1] * 4)
            ctx.set_source_surface(surf, ix, iy)
            ctx.paint_with_alpha(out_cubic(t / 0.4))
        ctx.restore()
        if self.t_lines:
            k = out_cubic((t - 0.2) / 0.4)
            set_font(ctx, "semi", self.t_size)
            ty = iy + ih + 18 * s
            for i, line in enumerate(self.t_lines):
                ctx.move_to(ix + 6 * s, ty + self.t_size * (1.0 + 1.2 * i) - self.t_size * 0.2)
                ctx.set_source_rgba(1, 1, 1, 0.92 * k)
                ctx.show_text(line)


# ------------------------------------------------------------------ driver
def main(plan_path: str) -> int:
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    W, H, fps = int(plan["W"]), int(plan["H"]), float(plan["fps"])
    if not (64 <= W <= 4096 and 64 <= H <= 4096 and 1 <= fps <= 120):
        raise SystemExit("bad frame size or fps")
    theme = THEMES.get(plan.get("theme"), THEMES["aurora"])
    out = Path("g")
    out.mkdir(exist_ok=True)
    cards = plan["cards"][:MAX_CARDS]
    for spec in cards:
        cid = str(spec["id"])
        if not re.fullmatch(r"c[0-9]{1,3}", cid):
            raise SystemExit(f"bad card id {cid!r}")
        spec["dur"] = clamp(float(spec["dur"]), 1.0, 8.0)
        card = Card(spec, W, H, theme)
        frames = min(MAX_FRAMES, int(round(card.dur * fps)))
        d = out / cid
        d.mkdir(exist_ok=True)
        for i in range(frames):
            # the last frame must be the END of the animation (fully faded out), or the card pops off the screen
            art, mask = card.render(card.dur * i / max(1, frames - 1))
            art.save(d / f"a_{i:04d}.png", compress_level=1)
            mask.save(d / f"m_{i:04d}.png", compress_level=1)
        (out / f"{cid}.json").write_text(json.dumps({"x": card.bx, "y": card.by, "w": card.bw, "h": card.bh, "frames": frames}), encoding="utf-8")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    sys.exit(main(sys.argv[1]))
