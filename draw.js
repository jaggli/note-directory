// Drawing notes (.draw): line-based text format, SVG renderer, canvas editor.
// Loaded on demand by app.js and exposed as window.Draw.
"use strict";
(() => {
  const NS = "http://www.w3.org/2000/svg";

  // ═══════════════════════════════════════════════════
  //  Format
  // ═══════════════════════════════════════════════════

  const VERSION = 1;
  // Palette names → the page's theme variables; hex values are read per theme
  const COLOR_VARS = {
    text: "text",
    grey: "overlay2",
    red: "red",
    peach: "peach",
    yellow: "yellow",
    green: "green",
    teal: "teal",
    sky: "sky",
    blue: "blue",
    lavender: "lavender",
    mauve: "mauve",
    pink: "pink",
  };
  const COLORS = {};
  let BG, ACCENT;
  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue("--" + name).trim();
    // A theme can set --draw-<colour> to differ from its UI colour
    for (const [c, name] of Object.entries(COLOR_VARS)) COLORS[c] = v("draw-" + c) || v(name);
    BG = v("bg");
    ACCENT = v("blue");
  }
  readTheme();
  const STROKE = { s: 2, m: 3.5, l: 5, xl: 8 };
  const FONT_SIZE = { s: 16, m: 22, l: 30, xl: 44 };
  const HEADS = ["none", "open", "triangle", "dot", "diamond", "bar"];
  const ENUMS = {
    c: Object.keys(COLOR_VARS),
    s: Object.keys(STROKE),
    f: ["none", "semi", "solid"],
    d: ["solid", "dash", "dot"],
    hs: HEADS,
    he: HEADS,
    ta: ["left", "center", "right"],
    va: ["top", "middle", "bottom"],
  };
  const DEFAULTS = { c: "text", s: "m", f: "none", d: "solid", hs: "none", he: "open", ta: "center", va: "middle", st: "", bend: 0, rot: 0 };
  const BOX = new Set(["r", "e", "m"]);
  const POINTS = new Set(["l", "p", "h"]);
  const BOX_ATTRS = ["c", "s", "f", "d", "ta", "va", "st", "rot", "gr"];
  const ATTRS = {
    r: BOX_ATTRS,
    e: BOX_ATTRS,
    m: BOX_ATTRS,
    t: ["c", "s", "st", "rot", "gr"],
    l: ["c", "s", "d", "gr"],
    a: ["c", "s", "d", "hs", "he", "st", "bend", "gr"],
    p: ["c", "s", "rot", "gr"],
    h: ["c", "s", "rot", "gr"],
  };
  // Caps keep a hostile shared link from freezing the page
  const MAX_LINES = 20000;
  const MAX_POINTS = 200000;
  const MAX_COORD = 1e6;
  const MAX_LABEL = 5000;
  const ID_RE = /^[A-Za-z0-9_-]{1,16}$/;
  const NUM_RE = /^-?\d{1,9}(\.\d+)?$/;

  const textStyle = (v) => ["b", "i", "u"].filter((c) => v.includes(c)).join("");

  const bindable = (s) => !!s && (BOX.has(s.k) || s.k === "t");

  function num(tok) {
    if (!NUM_RE.test(tok)) throw "not a number: " + tok;
    const n = Math.round(Number(tok));
    if (Math.abs(n) > MAX_COORD) throw "number out of range: " + tok;
    return n;
  }

  function point(tok, withPressure) {
    const parts = tok.split(",");
    if (parts.length !== 2 && !(withPressure && parts.length === 3))
      throw "not a point: " + tok;
    return parts.map(num);
  }

  // Splits on whitespace; the "quoted label" (\" \\ \n escapes) comes after
  // the values, only key=value attributes may follow it
  function tokenize(line) {
    const tokens = [];
    let label = null;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === " " || ch === "\t") {
        i++;
      } else if (ch === '"') {
        if (label !== null) throw "only one label per line";
        let s = "";
        for (i++; i < line.length && line[i] !== '"'; i++) {
          if (line[i] === "\\" && i + 1 < line.length) {
            const n = line[++i];
            s += n === "n" ? "\n" : n;
          } else s += line[i];
        }
        if (i >= line.length) throw "missing closing quote";
        i++;
        label = s;
      } else {
        let j = i;
        while (j < line.length && line[j] !== " " && line[j] !== "\t") j++;
        const tok = line.slice(i, j);
        if (label !== null && !tok.includes("=")) throw "the label must come after the values";
        tokens.push(tok);
        i = j;
      }
    }
    return { tokens, label };
  }

  function parseEnd(tok) {
    if (tok.includes(",")) return point(tok);
    if (!ID_RE.test(tok)) throw "not a point or shape id: " + tok;
    return tok;
  }

  function parseShape(tokens, label) {
    const [k, id, ...rest] = tokens;
    if (!ATTRS[k]) throw "unknown shape: " + k;
    if (!id || !ID_RE.test(id)) throw "missing or invalid id";
    const pos = [];
    const s = { k, id };
    for (const t of rest) {
      const eq = t.indexOf("=");
      if (eq === -1) {
        pos.push(t);
        continue;
      }
      const key = t.slice(0, eq);
      const v = t.slice(eq + 1);
      if (!ATTRS[k].includes(key)) throw `unknown attribute ${key} for ${k}`;
      if (ENUMS[key]) {
        if (!ENUMS[key].includes(v)) throw `invalid ${key}=${v}`;
        s[key] = v;
      } else if (key === "gr") {
        if (!ID_RE.test(v)) throw "invalid group id";
        s.gr = v;
      } else if (key === "st") {
        // Text style: any of b(old) i(talic) u(nderline), stored in that order
        if (!/^[biu]{1,3}$/.test(v) || new Set(v).size !== v.length) throw `invalid st=${v}`;
        s.st = textStyle(v);
      } else s[key] = num(v);
    }
    if (label !== null) {
      if (POINTS.has(k)) throw "this shape has no label";
      if (label.length > MAX_LABEL) throw "label too long";
      if (label) s.label = label;
    }
    if (BOX.has(k)) {
      if (pos.length !== 4) throw "expected: x y width height";
      [s.x, s.y, s.w, s.h] = pos.map(num);
      if (s.w < 1 || s.h < 1) throw "width and height must be positive";
    } else if (k === "t") {
      if (pos.length !== 2) throw "expected: x y";
      [s.x, s.y] = pos.map(num);
    } else if (k === "l") {
      if (pos.length < 2) throw "expected two or more points";
      s.pts = pos.map((p) => point(p));
    } else if (k === "a") {
      if (pos.length !== 2) throw "expected: start end";
      s.from = parseEnd(pos[0]);
      s.to = parseEnd(pos[1]);
    } else {
      // Pen: first point absolute, then deltas; optional pressure 1-9
      if (!pos.length) throw "expected points";
      const pressure = pos[0].split(",").length === 3;
      let x = 0;
      let y = 0;
      s.pts = pos.map((tok, i) => {
        const v = point(tok, true);
        if ((v.length === 3) !== pressure) throw "mixed points with and without pressure";
        if (pressure && (v[2] < 1 || v[2] > 9)) throw "pressure must be 1-9";
        x = i ? x + v[0] : v[0];
        y = i ? y + v[1] : v[1];
        if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) throw "point out of range";
        return pressure ? [x, y, v[2]] : [x, y];
      });
    }
    if (s.rot) s.rot = ((s.rot % 360) + 360) % 360;
    return s;
  }

  function parse(src) {
    const model = {
      shapes: [],
      byId: new Map(),
      grid: false,
      errors: [],
      locked: false,
    };
    const text = String(src ?? "");
    if (!text.trim()) return model;
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length > MAX_LINES) {
      model.locked = true;
      model.errors.push({ line: MAX_LINES + 1, msg: "too many lines to edit as a drawing" });
      lines.length = MAX_LINES;
    }
    let points = 0;
    let header = false;
    const sources = new Map();
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line[0] === "#") return model.shapes.push({ k: "raw", text: raw });
      try {
        const { tokens, label } = tokenize(line);
        if (tokens[0] === "draw" && !header) {
          if (tokens.length !== 2 || label !== null) throw "expected: draw 1";
          header = true;
          if (num(tokens[1]) > VERSION) {
            model.locked = true;
            throw "made with a newer version of note";
          }
          return;
        }
        if (tokens[0] === "grid") {
          if (tokens.length !== 2 || label !== null || !/^(on|off)$/.test(tokens[1]))
            throw "expected: grid on|off";
          model.grid = tokens[1] === "on";
          return;
        }
        const s = parseShape(tokens, label);
        if (model.byId.has(s.id)) throw "duplicate id: " + s.id;
        if (s.pts && (points += s.pts.length) > MAX_POINTS) {
          model.locked = true;
          throw "too many points to edit as a drawing";
        }
        model.shapes.push(s);
        model.byId.set(s.id, s);
        sources.set(s, [i, raw]);
      } catch (msg) {
        if (typeof msg !== "string") throw msg;
        model.errors.push({ line: i + 1, msg });
        model.shapes.push({ k: "raw", text: raw });
      }
    });
    // Arrows may point at shapes further down: resolve once all are known
    model.shapes = model.shapes.map((s) => {
      if (s.k !== "a") return s;
      for (const end of [s.from, s.to]) {
        if (typeof end === "string" && !bindable(model.byId.get(end))) {
          const [i, raw] = sources.get(s);
          model.errors.push({ line: i + 1, msg: "arrow points at unknown shape: " + end });
          model.byId.delete(s.id);
          return { k: "raw", text: raw };
        }
      }
      return s;
    });
    model.errors.sort((a, b) => a.line - b.line);
    return model;
  }

  const quote = (s) =>
    '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  const R = Math.round;

  function shapeLine(s) {
    if (s.k === "raw") return s.text;
    const parts = [s.k, s.id];
    const attrs = [];
    for (const key of ATTRS[s.k]) {
      const v = s[key];
      if (v === undefined || v === DEFAULTS[key]) continue;
      if (key === "rot" || key === "bend") {
        if (R(v)) attrs.push(key + "=" + R(v));
      } else attrs.push(key + "=" + v);
    }
    // Pens: style first, it would be lost at the end of a long point list
    if (s.k === "p" || s.k === "h") parts.push(...attrs);
    if (BOX.has(s.k)) parts.push(R(s.x), R(s.y), R(s.w), R(s.h));
    else if (s.k === "t") parts.push(R(s.x), R(s.y));
    else if (s.k === "l") for (const p of s.pts) parts.push(R(p[0]) + "," + R(p[1]));
    else if (s.k === "a")
      for (const e of [s.from, s.to])
        parts.push(typeof e === "string" ? e : R(e[0]) + "," + R(e[1]));
    else {
      let px = 0;
      let py = 0;
      s.pts.forEach((p, i) => {
        const x = R(p[0]);
        const y = R(p[1]);
        let tok = i ? x - px + "," + (y - py) : x + "," + y;
        if (p.length > 2) tok += "," + p[2];
        parts.push(tok);
        px = x;
        py = y;
      });
    }
    if (s.k !== "p" && s.k !== "h") parts.push(...attrs);
    if (s.label) parts.push(quote(s.label));
    return parts.join(" ");
  }

  function serialize(model) {
    const body = model.shapes.map(shapeLine);
    if (!model.grid && body.every((l) => !l.trim())) return "";
    return ["draw " + VERSION, ...(model.grid ? ["grid on"] : []), ...body].join("\n") + "\n";
  }

  // ═══════════════════════════════════════════════════
  //  Geometry
  // ═══════════════════════════════════════════════════

  const FONT = '"Victor Mono", "SF Mono", Consolas, monospace';
  const LINE_H = 1.3;
  const GRID = 20;

  function rotPt(x, y, cx, cy, deg) {
    if (!deg) return [x, y];
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  let measureCtx = null;
  const measureCache = new Map();
  const fontCss = (size, st = "") =>
    (st.includes("i") ? "italic " : "") + (st.includes("b") ? "bold " : "") + size + "px " + FONT;

  function measure(str, size, st = "") {
    const key = size + st + "|" + str;
    let w = measureCache.get(key);
    if (w === undefined) {
      measureCtx ??= document.createElement("canvas").getContext("2d");
      measureCtx.font = fontCss(size, st);
      w = measureCtx.measureText(str).width;
      if (measureCache.size > 5000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  }

  // Greedy word wrap at spaces; a word wider than the line overflows it
  function wrap(label, size, maxW, st) {
    const out = [];
    for (const para of label.split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? line + " " + word : word;
        if (!line || measure(next, size, st) <= maxW) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  const fontSize = (s) => FONT_SIZE[s.s || "m"];
  const strokeW = (s) => STROKE[s.s || "m"];

  function textSize(s) {
    const size = fontSize(s);
    const lines = (s.label || "").split("\n");
    const w = Math.max(size * 0.6, ...lines.map((l) => measure(l, size, s.st)));
    return { w: Math.ceil(w), h: Math.ceil(lines.length * size * LINE_H), lines, size };
  }

  function labelPad(s) {
    return fontSize(s) * 0.25 + 6;
  }

  // Share of a box's width/height that a label can use
  const LABEL_AREA = { r: [1, 1], e: [0.75, 0.75], m: [0.55, 0.55] };

  function labelWidth(s) {
    return Math.max(fontSize(s), s.w * LABEL_AREA[s.k][0] - labelPad(s) * 2);
  }

  // Unrotated anchor of a box label: x for the text anchor, y of its top
  function labelPos(s, lineCount) {
    const [aw, ah] = LABEL_AREA[s.k];
    const pad = labelPad(s);
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const total = lineCount * fontSize(s) * LINE_H;
    const ta = s.ta || "center";
    const va = s.va || "middle";
    return {
      x: ta === "left" ? cx - (s.w * aw) / 2 + pad : ta === "right" ? cx + (s.w * aw) / 2 - pad : cx,
      y: va === "top" ? cy - (s.h * ah) / 2 + pad : va === "bottom" ? cy + (s.h * ah) / 2 - pad - total : cy - total / 2,
      anchor: ta === "left" ? "start" : ta === "right" ? "end" : "middle",
      total,
    };
  }

  // Unrotated box of a shape that has one, plus its rotation
  function frame(s) {
    if (BOX.has(s.k)) return { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot || 0 };
    if (s.k === "t") {
      const t = textSize(s);
      return { x: s.x, y: s.y, w: t.w, h: t.h, rot: s.rot || 0 };
    }
    // Strokes keep their points upright and rotate around their centre
    if (s.k === "p" || s.k === "h") return { ...ptsBounds(s.pts, lineWidth(s) / 2), rot: s.rot || 0 };
    return null;
  }

  // Points as drawn, rotation applied
  function worldPts(s) {
    if (!s.rot) return s.pts;
    const f = frame(s);
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    return s.pts.map((p) => rotPt(p[0], p[1], cx, cy, s.rot));
  }

  function corners(f) {
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    return [
      [f.x, f.y],
      [f.x + f.w, f.y],
      [f.x + f.w, f.y + f.h],
      [f.x, f.y + f.h],
    ].map(([x, y]) => rotPt(x, y, cx, cy, f.rot));
  }

  function ptsBounds(pts, pad = 0) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const p of pts) {
      if (p[0] < x1) x1 = p[0];
      if (p[1] < y1) y1 = p[1];
      if (p[0] > x2) x2 = p[0];
      if (p[1] > y2) y2 = p[1];
    }
    return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
  }

  function anchor(end, model) {
    if (typeof end !== "string") return { c: end };
    const s = model.byId.get(end);
    if (!s) return { c: [0, 0] };
    const f = frame(s);
    return { s, f, c: [f.x + f.w / 2, f.y + f.h / 2] };
  }

  // Where a ray from the shape's centre towards `to` leaves its outline
  function edgePoint(a, to, gap) {
    const { s, f, c } = a;
    let dx = to[0] - c[0];
    let dy = to[1] - c[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return c;
    dx /= len;
    dy /= len;
    const [lx, ly] = rotPt(dx, dy, 0, 0, -f.rot);
    const hw = Math.max(f.w / 2, 0.5);
    const hh = Math.max(f.h / 2, 0.5);
    let t;
    if (s.k === "e") t = 1 / Math.hypot(lx / hw, ly / hh);
    else if (s.k === "m") t = 1 / (Math.abs(lx) / hw + Math.abs(ly) / hh);
    else
      t = Math.min(
        Math.abs(lx) > 1e-9 ? hw / Math.abs(lx) : Infinity,
        Math.abs(ly) > 1e-9 ? hh / Math.abs(ly) : Infinity,
      );
    t = Math.min(t + gap, len);
    return [c[0] + dx * t, c[1] + dy * t];
  }

  // p0/p1: visible ends, ctrl: quadratic control (null when straight),
  // mid: point halfway along, base/normal: the centre-to-centre chord
  function arrowGeom(a, model) {
    const A = anchor(a.from, model);
    const B = anchor(a.to, model);
    const [ax, ay] = A.c;
    const [bx, by] = B.c;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const n = [-(by - ay) / len, (bx - ax) / len];
    const base = [(ax + bx) / 2, (ay + by) / 2];
    const bend = a.bend || 0;
    // The curve's midpoint sits `bend` off the chord: control = base + 2·bend·n
    const ctrl = bend ? [base[0] + n[0] * bend * 2, base[1] + n[1] * bend * 2] : null;
    const gap = strokeW(a) + 3;
    const p0 = A.s ? edgePoint(A, ctrl || B.c, gap) : A.c;
    const p1 = B.s ? edgePoint(B, ctrl || A.c, gap) : B.c;
    const mid = ctrl
      ? [(p0[0] + 2 * ctrl[0] + p1[0]) / 4, (p0[1] + 2 * ctrl[1] + p1[1]) / 4]
      : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    return { p0, p1, ctrl, mid, base, n };
  }

  function arrowPts(g) {
    if (!g.ctrl) return [g.p0, g.p1];
    const out = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const u = 1 - t;
      out.push([
        u * u * g.p0[0] + 2 * u * t * g.ctrl[0] + t * t * g.p1[0],
        u * u * g.p0[1] + 2 * u * t * g.ctrl[1] + t * t * g.p1[1],
      ]);
    }
    return out;
  }

  function lineWidth(s) {
    if (s.k === "h") return strokeW(s) * 4.5;
    if (s.k === "p") return strokeW(s) * 1.3;
    return strokeW(s);
  }

  function bounds(s, model) {
    const f = frame(s);
    if (f) return ptsBounds(corners(f), BOX.has(s.k) ? strokeW(s) / 2 : 0);

    if (s.k === "a") {
      const g = arrowGeom(s, model);
      const b = ptsBounds(arrowPts(g), strokeW(s) * 3);
      if (!s.label) return b;
      const lb = arrowLabelBox(s, g);
      return ptsBounds([
        [b.x, b.y],
        [b.x + b.w, b.y + b.h],
        [lb.x, lb.y],
        [lb.x + lb.w, lb.y + lb.h],
      ]);
    }
    return ptsBounds(s.pts, lineWidth(s) / 2);
  }

  // Bounds of the geometry itself, without stroke width: what grid snapping
  // aligns, so outlines are centred on grid lines
  function geomBounds(s) {
    if (BOX.has(s.k) || s.k === "t") return ptsBounds(corners(frame(s)));
    if (s.k === "a") return ptsBounds(arrowPts(arrowGeom(s, E.model)));
    return ptsBounds(worldPts(s));
  }

  function unionBounds(list) {
    if (!list.length) return null;
    const pts = [];
    for (const b of list) pts.push([b.x, b.y], [b.x + b.w, b.y + b.h]);
    return ptsBounds(pts);
  }

  function contentBounds(model) {
    return unionBounds(model.shapes.filter((s) => s.k !== "raw").map((s) => bounds(s, model)));
  }

  function arrowLabelBox(s, g) {
    const size = fontSize(s);
    const lines = wrap(s.label, size, size * 14, s.st);
    const w = Math.max(...lines.map((l) => measure(l, size, s.st))) + size * 0.6;
    const h = lines.length * size * LINE_H + size * 0.2;
    return { x: g.mid[0] - w / 2, y: g.mid[1] - h / 2, w, h, lines, size };
  }

  function segDist(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  function polyDist(pts, p) {
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i]));
    return d;
  }

  // 0: miss, 1: hit, 2: inside a hollow shape (picked only if nothing else is)
  function hitShape(s, p, tol, model) {
    const f = frame(s);
    if (f && POINTS.has(s.k)) {
      p = rotPt(p[0], p[1], f.x + f.w / 2, f.y + f.h / 2, -f.rot);
    } else if (f) {
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const [lx, ly] = rotPt(p[0], p[1], cx, cy, -f.rot);
      const x = Math.abs(lx - cx);
      const y = Math.abs(ly - cy);
      const hw = f.w / 2;
      const hh = f.h / 2;
      if (s.k === "t") return x <= hw + tol && y <= hh + tol ? 1 : 0;
      const t = tol + strokeW(s) / 2;
      let inside;
      let edge;
      if (s.k === "r") {
        inside = x <= hw && y <= hh;
        edge = x <= hw + t && y <= hh + t && !(x < hw - t && y < hh - t);
      } else if (s.k === "e") {
        const r = Math.hypot(x / Math.max(hw, 0.5), y / Math.max(hh, 0.5));
        inside = r <= 1;
        edge = Math.abs(r - 1) * Math.min(hw, hh) <= t;
      } else {
        const r = x / Math.max(hw, 0.5) + y / Math.max(hh, 0.5);
        inside = r <= 1;
        edge = (Math.abs(r - 1) * hw * hh) / Math.hypot(hw, hh) <= t;
      }
      if (edge) return 1;
      if (inside) return (s.f && s.f !== "none") || s.label ? 1 : 2;
      return 0;
    }
    if (s.k === "a") {
      const g = arrowGeom(s, model);
      if (polyDist(arrowPts(g), p) <= tol + strokeW(s)) return 1;
      if (s.label) {
        const b = arrowLabelBox(s, g);
        if (p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h) return 1;
      }
      return 0;
    }
    const b = ptsBounds(s.pts, lineWidth(s) / 2 + tol);
    if (p[0] < b.x || p[1] < b.y || p[0] > b.x + b.w || p[1] > b.y + b.h) return 0;
    return polyDist(s.pts, p) <= tol + lineWidth(s) / 2 ? 1 : 0;
  }

  // Ramer–Douglas–Peucker
  function simplify(pts, eps) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let max = 0;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDist(pts[i], pts[a], pts[b]);
        if (d > max) {
          max = d;
          idx = i;
        }
      }
      if (max > eps) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ═══════════════════════════════════════════════════
  //  Rendering
  // ═══════════════════════════════════════════════════

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  const f1 = (n) => Math.round(n * 10) / 10;
  const P = (p) => f1(p[0]) + " " + f1(p[1]);

  // Quadratic segments through the midpoints: smooth and passes near every point
  function smoothD(pts) {
    if (pts.length === 1) return `M${P(pts[0])}l0.01 0`;
    let d = "M" + P(pts[0]);
    for (let i = 1; i < pts.length - 1; i++) {
      const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
      d += `Q${P(pts[i])} ${P(m)}`;
    }
    return d + "L" + P(pts[pts.length - 1]);
  }

  function qThrough(pts) {
    let d = "";
    for (let i = 1; i < pts.length - 1; i++) {
      const m = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
      d += `Q${P(pts[i])} ${P(m)}`;
    }
    return d + "L" + P(pts[pts.length - 1]);
  }

  // Pressure stroke: filled outline whose half-width follows the pen pressure
  function outlineD(pts, w) {
    const radius = (p) => (w / 2) * (0.25 + (p[2] / 9) * 1.1);
    const rs = pts.map(radius);
    // Smooth the radii so pressure noise doesn't make the outline wobble
    for (let i = 1; i < rs.length - 1; i++) rs[i] = (rs[i - 1] + rs[i] * 2 + rs[i + 1]) / 4;
    if (pts.length === 1) {
      const r = rs[0];
      const [x, y] = pts[0];
      return `M${f1(x - r)} ${f1(y)}a${f1(r)} ${f1(r)} 0 1 0 ${f1(r * 2)} 0a${f1(r)} ${f1(r)} 0 1 0 ${f1(-r * 2)} 0Z`;
    }
    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const r = rs[i];
      left.push([pts[i][0] - ty * r, pts[i][1] + tx * r]);
      right.push([pts[i][0] + ty * r, pts[i][1] - tx * r]);
    }
    const rEnd = f1(rs[rs.length - 1]);
    const rStart = f1(rs[0]);
    right.reverse();
    return (
      "M" + P(left[0]) + qThrough(left) +
      `A${rEnd} ${rEnd} 0 0 0 ${P(right[0])}` +
      qThrough(right) +
      `A${rStart} ${rStart} 0 0 0 ${P(left[0])}Z`
    );
  }

  function dashArray(s) {
    const w = strokeW(s);
    if (s.d === "dash") return `${f1(w * 3)} ${f1(w * 2.5)}`;
    if (s.d === "dot") return `0 ${f1(w * 2.5)}`;
    return null;
  }

  // Mix a palette colour towards the background: outline of solid fills
  function darker(hex, t = 0.35) {
    const c = (h, i) => parseInt(h.slice(i, i + 2), 16);
    return "#" + [1, 3, 5].map((i) => Math.round(c(hex, i) * (1 - t) + c(BG, i) * t).toString(16).padStart(2, "0")).join("");
  }

  function labelColor(s) {
    return BOX.has(s.k) && s.f === "solid" ? BG : COLORS[s.c || "text"];
  }

  function textLines(g, lines, size, x, y, anchor, color, st = "") {
    const t = el("text", {
      x,
      "font-size": size,
      "font-family": FONT,
      "font-weight": st.includes("b") ? "bold" : null,
      "font-style": st.includes("i") ? "italic" : null,
      // Only the regular weight is bundled: a thin outline makes bold read
      stroke: st.includes("b") ? color : null,
      "stroke-width": st.includes("b") ? f1(size * 0.045) : null,
      "stroke-linejoin": st.includes("b") ? "round" : null,
      "text-anchor": anchor,
      fill: color,
      style: "white-space:pre",
    }, g);
    lines.forEach((line, i) => {
      const cy = y + (i + 0.5) * size * LINE_H;
      const span = el("tspan", { x, y: f1(cy), "dominant-baseline": "central" }, t);
      span.textContent = line || " ";
      // Drawn, not text-decoration: Safari ignores that in SVG
      if (st.includes("u") && line.trim()) {
        const w = measure(line, size, st);
        const x0 = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : +x;
        const uy = f1(cy + size * 0.45);
        el("path", { d: `M${f1(x0)} ${uy}H${f1(x0 + w)}`, stroke: color, "stroke-width": f1(Math.max(1, size * 0.07)) }, g);
      }
    });
    return t;
  }

  function renderShape(s, model, hideLabel) {
    const g = el("g", { "data-id": s.id });
    const color = COLORS[s.c || "text"];
    const sw = strokeW(s);
    const stroke = {
      stroke: color,
      "stroke-width": sw,
      "stroke-dasharray": dashArray(s),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      fill: "none",
    };
    if (BOX.has(s.k)) {
      const { x, y, w, h } = s;
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (s.rot) g.setAttribute("transform", `rotate(${s.rot} ${f1(cx)} ${f1(cy)})`);
      const a = {
        ...stroke,
        stroke: s.f === "solid" ? darker(color) : color,
        fill: s.f === "semi" || s.f === "solid" ? color : "none",
        "fill-opacity": s.f === "semi" ? 0.2 : null,
      };
      if (s.k === "r")
        el("rect", { ...a, x, y, width: w, height: h, rx: f1(Math.min(8, w / 4, h / 4)) }, g);
      else if (s.k === "e") el("ellipse", { ...a, cx, cy, rx: w / 2, ry: h / 2 }, g);
      else el("polygon", { ...a, points: `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}` }, g);
      if (s.label && !hideLabel) {
        const size = fontSize(s);
        const lines = wrap(s.label, size, labelWidth(s), s.st);
        const lp = labelPos(s, lines.length);
        textLines(g, lines, size, f1(lp.x), lp.y, lp.anchor, labelColor(s), s.st);
      }
    } else if (s.k === "t") {
      if (hideLabel) return g;
      const t = textSize(s);
      if (s.rot) g.setAttribute("transform", `rotate(${s.rot} ${f1(s.x + t.w / 2)} ${f1(s.y + t.h / 2)})`);
      textLines(g, t.lines, t.size, s.x, s.y, "start", color, s.st);
    } else if (s.k === "l") {
      el("path", { ...stroke, d: "M" + s.pts.map(P).join("L") }, g);
    } else if (s.k === "a") {
      const geo = arrowGeom(s, model);
      const { p0, p1, ctrl } = geo;
      el("path", { ...stroke, d: ctrl ? `M${P(p0)}Q${P(ctrl)} ${P(p1)}` : `M${P(p0)}L${P(p1)}` }, g);
      const head = (kind, tip, from) => {
        const dx = tip[0] - from[0];
        const dy = tip[1] - from[1];
        const len = Math.hypot(dx, dy);
        if (kind === "none" || len < 1e-6) return;
        const size = Math.min(6 + sw * 3, len * 0.6);
        const ux = dx / len;
        const uy = dy / len;
        const at = (back, side) => [tip[0] - ux * back - uy * side, tip[1] - uy * back + ux * side];
        const solid = { ...stroke, "stroke-dasharray": null };
        const filled = { ...solid, fill: color };
        const half = size * Math.tan((28 * Math.PI) / 180);
        if (kind === "open") el("path", { ...solid, d: `M${P(at(size, half))}L${P(tip)}L${P(at(size, -half))}` }, g);
        else if (kind === "triangle") el("path", { ...filled, d: `M${P(tip)}L${P(at(size, half))}L${P(at(size, -half))}Z` }, g);
        else if (kind === "diamond")
          el("path", { ...filled, d: `M${P(tip)}L${P(at(size * 0.7, half * 0.8))}L${P(at(size * 1.4, 0))}L${P(at(size * 0.7, -half * 0.8))}Z` }, g);
        else if (kind === "dot") el("circle", { ...filled, cx: f1(tip[0]), cy: f1(tip[1]), r: f1(Math.max(2.5, sw * 1.3)) }, g);
        else if (kind === "bar") el("path", { ...solid, d: `M${P(at(0, half * 1.2))}L${P(at(0, -half * 1.2))}` }, g);
      };
      head(s.he || "open", p1, ctrl || p0);
      head(s.hs || "none", p0, ctrl || p1);
      if (s.label && !hideLabel) {
        const b = arrowLabelBox(s, geo);
        el("rect", { x: f1(b.x), y: f1(b.y), width: f1(b.w), height: f1(b.h), rx: 4, fill: BG }, g);
        textLines(g, b.lines, b.size, f1(geo.mid[0]), b.y + b.size * 0.1, "middle", color, s.st);
      }
    } else if (s.k === "h") {
      rotateStroke(g, s);
      el("path", { ...stroke, "stroke-dasharray": null, "stroke-width": lineWidth(s), "stroke-opacity": 0.35, d: smoothD(s.pts) }, g);
    } else if (s.pts[0].length > 2) {
      rotateStroke(g, s);
      el("path", { fill: color, d: outlineD(s.pts, lineWidth(s)) }, g);
    } else {
      rotateStroke(g, s);
      el("path", { ...stroke, "stroke-dasharray": null, "stroke-width": lineWidth(s), d: smoothD(s.pts) }, g);
    }
    return g;
  }

  function rotateStroke(g, s) {
    if (!s.rot) return;
    const f = frame(s);
    g.setAttribute("transform", `rotate(${s.rot} ${f1(f.x + f.w / 2)} ${f1(f.y + f.h / 2)})`);
  }

  // Standalone SVG of a whole drawing (embeds, export)
  function renderStatic(content, opts = {}) {
    const model = parse(content);
    const pad = opts.pad ?? 16;
    const b = contentBounds(model) || { x: 0, y: 0, w: 1, h: 1 };
    const w = Math.ceil(b.w + pad * 2);
    const h = Math.ceil(b.h + pad * 2);
    const svg = el("svg", {
      xmlns: NS,
      viewBox: `${f1(b.x - pad)} ${f1(b.y - pad)} ${w} ${h}`,
      width: w,
      height: h,
      role: "img",
    });
    if (opts.background)
      el("rect", { x: f1(b.x - pad), y: f1(b.y - pad), width: w, height: h, fill: BG }, svg);
    for (const s of model.shapes) if (s.k !== "raw") svg.appendChild(renderShape(s, model));
    return svg;
  }

  function svgString(content) {
    return new XMLSerializer().serializeToString(renderStatic(content, { background: true }));
  }

  async function pngBlob(content) {
    const svg = renderStatic(content, { background: true });
    const w = +svg.getAttribute("width");
    const h = +svg.getAttribute("height");
    // Canvas size limits: scale down very large drawings
    const scale = Math.min(2, 8000 / Math.max(w, h));
    const img = new Image();
    img.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png export failed"))), "image/png"),
    );
  }

  // ═══════════════════════════════════════════════════
  //  Editor
  // ═══════════════════════════════════════════════════

  const ICONS = {
    select: '<path d="M6 3v14l3.6-3.4 2.4 5.4 2.2-1-2.4-5.3H17z"/>',
    hand: '<path d="M8 11V5.5a1.3 1.3 0 0 1 2.6 0V10m0-5.5a1.3 1.3 0 0 1 2.6 0V10m0-4a1.3 1.3 0 0 1 2.6 0v4.5m0-2a1.3 1.3 0 0 1 2.6 0V13c0 3.6-2.6 6-6 6-2.6 0-4-1.2-5.4-3.4l-2-3.2a1.3 1.3 0 0 1 2.2-1.4L8 13"/>',
    pen: '<path d="M3 16c2-4 4-9 6-8s-2 7 1 7 4-8 7-9"/>',
    highlight: '<path d="M12.5 4.5l4 4-7 7H5.5v-4z M4 19h14"/>',
    eraser: '<path d="M9 18h9M4.5 13.5l7-7a1.5 1.5 0 0 1 2 0l3 3a1.5 1.5 0 0 1 0 2L11 17.5H8z"/>',
    rect: '<rect x="3.5" y="5.5" width="15" height="11" rx="1.5"/>',
    ellipse: '<ellipse cx="11" cy="11" rx="8" ry="6"/>',
    diamond: '<path d="M11 3l8 8-8 8-8-8z"/>',
    line: '<path d="M4 18L18 4"/>',
    arrow: '<path d="M4 18L18 4M10 4h8v8"/>',
    text: '<path d="M5 5h12M11 5v13M8.5 18h5"/>',
  };
  const TOOLS = [
    ["select", "select", "v"],
    ["hand", "hand", "h"],
    ["pen", "draw", "d"],
    ["highlight", "highlighter", "shift+d"],
    ["eraser", "eraser", "e"],
    ["rect", "rectangle", "r"],
    ["ellipse", "ellipse", "o"],
    ["diamond", "diamond", "m"],
    ["line", "line", "l"],
    ["arrow", "arrow", "a"],
    ["text", "text", "t"],
  ];
  const PINNED_TOOLS = new Set(["select", "hand"]);
  const TOOL_KEYS = { v: "select", h: "hand", d: "pen", D: "highlight", e: "eraser", r: "rect", o: "ellipse", m: "diamond", l: "line", a: "arrow", t: "text" };
  const TOOL_KIND = { rect: "r", ellipse: "e", diamond: "m", line: "l", arrow: "a", text: "t", pen: "p", highlight: "h" };
  const STYLE_KEY = "notepad_draw_style";
  // Right-click menu: [action, label, shortcut]; null is a separator
  const MENU = [
    ["front", "bring to front", "alt+shift+↑"],
    ["forward", "bring forward", "alt+↑"],
    ["backward", "send backward", "alt+↓"],
    ["back", "send to back", "alt+shift+↓"],
    null,
    ["dup", "duplicate", "ctrl+d"],
    ["group", "group", "ctrl+g"],
    ["ungroup", "ungroup", "ctrl+shift+g"],
    null,
    ["del", "delete", "del"],
  ];
  const ZMIN = 0.1;
  const ZMAX = 8;

  const CSS = `
.draw-host svg.draw-svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none;-webkit-user-select:none}
.draw-ui button{-webkit-tap-highlight-color:transparent;font-family:var(--font);color:var(--subtext);background:none;border:none;cursor:pointer;border-radius:6px}
.draw-ui button:hover{color:var(--text);background:var(--overlay)}
.draw-panel{position:absolute;background:var(--sidebar);border:1px solid var(--border);border-radius:8px;padding:4px}
.draw-tools{left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:2px;max-width:calc(100% - 16px);overflow-x:auto;scrollbar-width:none}
.draw-tools button{width:36px;height:36px;flex:none;display:flex;align-items:center;justify-content:center}
.draw-tools button.active{background:var(--blue);color:var(--bg)}
.draw-tools svg,.draw-toolgrid svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.draw-ui .draw-tools .draw-tool-more,.draw-toolgrid{display:none}
.draw-style{top:8px;right:8px;width:176px;display:none;flex-direction:column;gap:6px;padding:8px;max-height:calc(100% - 80px);overflow:auto}
.draw-style.visible{display:flex}
.draw-swatches{display:grid;grid-template-columns:repeat(6,1fr);gap:2px}
.draw-swatches button{height:26px;display:flex;align-items:center;justify-content:center}
.draw-swatches span{width:14px;height:14px;border-radius:50%;display:block}
.draw-swatches button.active{background:var(--overlay);box-shadow:inset 0 0 0 1px var(--subtext)}
.draw-seg{display:flex;gap:2px}
.draw-seg button{flex:1;min-width:0;height:26px;font-size:12px;padding:0 2px;display:flex;align-items:center;justify-content:center}
.draw-seg svg{max-width:100%;height:auto}
.draw-seg button.active{background:var(--overlay);color:var(--text);box-shadow:inset 0 0 0 1px var(--subtext)}
.draw-actions{display:flex;flex-wrap:wrap;gap:2px;border-top:1px solid var(--border);padding-top:6px}
.draw-actions button{font-size:12px;padding:4px 6px}
.draw-menu{display:none;flex-direction:column;min-width:210px;z-index:5}
.draw-menu.visible{display:flex}
.draw-ui .draw-menu button{display:flex;justify-content:space-between;gap:16px;text-align:left;font-size:13px;padding:6px 10px;border-radius:4px}
.draw-ui .draw-menu button:disabled{opacity:.35;pointer-events:none}
.draw-menu kbd{color:var(--gutter);font-family:var(--font);font-size:11px}
.draw-menu hr{border:none;border-top:1px solid var(--border);margin:4px 0}
.draw-nav{left:8px;top:8px;display:flex;gap:2px;align-items:center}
.draw-nav button{font-size:13px;height:28px;min-width:28px;padding:0 6px;display:flex;align-items:center;justify-content:center}
.draw-nav button.active{color:var(--blue)}
.draw-nav .draw-sep{width:1px;height:16px;background:var(--border);margin:0 2px}
.draw-ui .draw-badge{position:absolute;top:50px;left:8px;font-size:12px;color:var(--yellow);background:var(--sidebar);border:1px solid var(--border);border-radius:6px;padding:4px 8px;display:none;cursor:pointer}
.draw-ui .draw-badge.visible{display:block}
.draw-ui .draw-badge:hover{color:var(--yellow);background:var(--overlay)}
.draw-hint{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;color:var(--gutter);font-size:14px;text-align:center;padding:0 24px;line-height:1.8}
.draw-hint.visible{display:flex}
.draw-text{position:absolute;display:none;background:transparent;border:none;outline:none;resize:none;overflow:hidden;padding:0;margin:0;font-family:${FONT};line-height:${LINE_H};transform-origin:center;white-space:pre;caret-color:var(--blue)}
.draw-text.wrap{white-space:pre-wrap;text-align:center;word-break:break-word}
.draw-readonly .draw-tools,.draw-readonly .draw-style,.draw-readonly .draw-edit{display:none!important}
.draw-style-head{display:flex;align-items:center;justify-content:space-between;margin:-4px -4px 0 0;color:var(--gutter);font-size:12px}
.draw-ui .draw-style-head button{width:24px;height:24px;font-size:16px;line-height:1}
.draw-nav .draw-style-open{display:none}
.draw-nav .draw-style-open.visible{display:flex}
/* Phones: a bottom sheet with finger-sized targets */
@container (max-width:600px){
.draw-ui .draw-tools .draw-tool-extra{display:none}
.draw-ui .draw-tools .draw-tool-more{display:flex}
.draw-ui .draw-tools button{width:52px;height:48px}
.draw-tools button.active{background:var(--blue);color:var(--bg)}
.draw-toolgrid.visible{display:grid;grid-template-columns:repeat(3,76px);gap:6px;padding:8px;left:50%;transform:translateX(-50%);z-index:6;border-radius:12px;bottom:80px;box-shadow:0 -4px 16px rgba(0,0,0,.3)}
.draw-ui .draw-toolgrid button{height:68px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:11px}
.draw-toolgrid svg{width:26px;height:26px}
.draw-ui .draw-toolgrid button.active{background:var(--blue);color:var(--bg)}
.draw-style{top:auto;bottom:80px;left:8px;right:8px;width:auto;max-height:50%;padding:8px 12px 12px;gap:8px;border-radius:12px;box-shadow:0 -4px 16px rgba(0,0,0,.3)}
.draw-style-head{font-size:14px;margin:0 -6px 0 0}
.draw-ui .draw-style-head button{width:40px;height:40px;font-size:22px}
.draw-swatches{gap:4px}
.draw-swatches button{height:44px}
.draw-swatches span{width:24px;height:24px}
.draw-seg{gap:4px}
.draw-seg button{height:44px;font-size:15px}
.draw-seg svg{width:32px}
.draw-actions{gap:4px;padding-top:8px}
.draw-ui .draw-actions button{flex:1 1 30%;height:44px;font-size:14px}
.draw-ui .draw-nav button{height:36px;min-width:36px}
}`;

  const E = {
    host: null,
    mounted: false,
    model: parse(""),
    text: "",
    opts: {},
    readonly: false,
    cam: { x: 0, y: 0, z: 1 },
    views: new Map(),
    tool: "select",
    style: loadStyle(),
    sel: new Set(),
    focusGroup: null,
    op: null,
    pointers: new Map(),
    sawPen: false,
    space: false,
    editing: null,
    pending: null,
    erasing: new Set(),
    bindTarget: null,
    lastDown: null,
    handles: [],
    cache: new Map(),
    index: new Map(),
    fontEpoch: 0,
    touch: false,
  };

  function loadStyle() {
    const style = { c: "text", s: "m", f: "none", d: "solid", hs: "none", he: "open", ta: "center", va: "middle", st: "" };
    try {
      const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || "{}");
      for (const k in style) if (ENUMS[k]?.includes(saved[k])) style[k] = saved[k];
      if (/^[biu]{0,3}$/.test(saved.st)) style.st = textStyle(saved.st);
    } catch {}
    return style;
  }

  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(E.style));
    } catch {}
  }

  // Style panel icons (28×14): an arrow end, text alignment
  function headIcon(kind, start) {
    const t = start ? (x) => 28 - x : (x) => x;
    const line = `<path d="M${t(3)} 7H${t(23)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;
    const tip = t(24);
    const back = t(18);
    const fill = 'fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"';
    const stroke = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
    const heads = {
      none: "",
      open: `<path d="M${back} 3L${tip} 7L${back} 11" ${stroke}/>`,
      triangle: `<path d="M${tip} 7L${back} 3.5L${back} 10.5Z" ${fill}/>`,
      dot: `<circle cx="${t(22)}" cy="7" r="2.6" ${fill}/>`,
      diamond: `<path d="M${tip} 7L${t(20.5)} 4L${t(17)} 7L${t(20.5)} 10Z" ${fill}/>`,
      bar: `<path d="M${tip} 2.5V11.5" ${stroke}/>`,
    };
    return line + heads[kind];
  }

  function alignIcon(d, box) {
    return (
      (box ? '<rect x="4" y="0.75" width="20" height="12.5" rx="2" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1"/>' : "") +
      `<path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
    );
  }

  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function build(host) {
    if (!document.getElementById("drawStyles")) {
      const st = document.createElement("style");
      st.id = "drawStyles";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    E.host = host;
    host.tabIndex = 0;
    host.replaceChildren();
    const svg = el("svg", { class: "draw-svg" }, host);
    const defs = el("defs", {}, svg);
    E.pattern = el("pattern", { id: "drawGridPattern", patternUnits: "userSpaceOnUse", width: GRID, height: GRID }, defs);
    E.patternDot = el("circle", { cx: 1, cy: 1, r: 1, style: "fill: var(--surface1)" }, E.pattern);
    E.gridRect = el("rect", { width: "100%", height: "100%", fill: "url(#drawGridPattern)" }, svg);
    E.world = el("g", {}, svg);
    E.shapesG = el("g", {}, E.world);
    E.overlay = el("g", {}, svg);
    E.svg = svg;

    const ui = h("div", "draw-ui", host);
    E.ui = ui;
    E.hint = h("div", "draw-hint", ui);
    E.badge = h("button", "draw-badge", ui);
    E.badge.dataset.draw = "source";

    E.toolsEl = h("div", "draw-panel draw-tools", ui);
    E.toolBtns = {};
    for (const [id, label, key] of TOOLS) {
      const b = h("button", "", E.toolsEl);
      b.dataset.draw = "tool:" + id;
      b.title = `${label} (${key})`;
      b.setAttribute("aria-label", label);
      b.innerHTML = `<svg viewBox="0 0 22 22">${ICONS[id]}</svg>`;
      if (!PINNED_TOOLS.has(id)) b.classList.add("draw-tool-extra");
      E.toolBtns[id] = b;
    }
    // Phones: select and hand stay, + opens the other tools as a 3×3 grid
    E.moreBtn = h("button", "draw-tool-more", E.toolsEl);
    E.moreBtn.dataset.draw = "nav:tools";
    E.moreBtn.setAttribute("aria-label", "More tools");
    E.toolGrid = h("div", "draw-panel draw-toolgrid", ui);
    for (const [id, label] of TOOLS) {
      if (PINNED_TOOLS.has(id)) continue;
      const b = h("button", "", E.toolGrid);
      b.dataset.draw = "tool:" + id;
      b.setAttribute("aria-label", label);
      b.innerHTML = `<svg viewBox="0 0 22 22">${ICONS[id]}</svg><span>${label}</span>`;
    }

    E.styleEl = h("div", "draw-panel draw-style", ui);
    const head = h("div", "draw-style-head", E.styleEl);
    h("span", "", head, "style");
    const close = h("button", "", head, "×");
    close.dataset.draw = "nav:closestyle";
    close.title = "close";
    close.setAttribute("aria-label", "Close style panel");
    E.swatches = h("div", "draw-swatches", E.styleEl);
    for (const c of ENUMS.c) {
      const b = h("button", "", E.swatches);
      b.dataset.draw = "style:c:" + c;
      b.title = c;
      b.setAttribute("aria-label", "color " + c);
      h("span", "", b).style.background = `var(--draw-${c}, var(--${COLOR_VARS[c]}))`;
    }
    const seg = (key, items) => {
      const row = h("div", "draw-seg", E.styleEl);
      row.dataset.key = key;
      for (const [v, label, title] of items) {
        const b = h("button", "", row, label.startsWith("<") ? null : label);
        if (label.startsWith("<")) b.innerHTML = `<svg viewBox="0 0 28 14" width="28" height="14">${label}</svg>`;
        b.dataset.draw = `style:${key}:${v}`;
        b.title = title;
        b.setAttribute("aria-label", title);
      }
      return row;
    };
    E.segs = {
      s: seg("s", [["s", "s", "small"], ["m", "m", "medium"], ["l", "l", "large"], ["xl", "xl", "extra large"]]),
      f: seg("f", [
        ["none", '<rect x="8" y="2" width="12" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>', "no fill"],
        ["semi", '<rect x="8" y="2" width="12" height="10" rx="2" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.5"/>', "light fill"],
        ["solid", '<rect x="8" y="2" width="12" height="10" rx="2" fill="currentColor" stroke="currentColor" stroke-width="1.5"/>', "solid fill"],
      ]),
      d: seg("d", [
        ["solid", '<path d="M3 7h22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>', "solid line"],
        ["dash", '<path d="M3 7h22" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>', "dashed line"],
        ["dot", '<path d="M3 7h22" stroke="currentColor" stroke-width="2.5" stroke-dasharray="0 5" stroke-linecap="round"/>', "dotted line"],
      ]),
      hs: seg("hs", HEADS.map((k) => [k, headIcon(k, true), "start: " + k])),
      he: seg("he", HEADS.map((k) => [k, headIcon(k, false), "end: " + k])),
      ta: seg("ta", [
        ["left", alignIcon("M4 3h16M4 7h10M4 11h13"), "align left"],
        ["center", alignIcon("M6 3h16M9 7h10M7.5 11h13"), "align center"],
        ["right", alignIcon("M8 3h16M14 7h10M11 11h13"), "align right"],
      ]),
      va: seg("va", [
        ["top", alignIcon("M5 1.5h18M9 5h10M9 8h10", true), "align top"],
        ["middle", alignIcon("M9 5.5h10M9 8.5h10", true), "align middle"],
        ["bottom", alignIcon("M9 6h10M9 9h10M5 12.5h18", true), "align bottom"],
      ]),
      st: seg("st", [
        ["b", "B", "bold (ctrl+b)"],
        ["i", "I", "italic (ctrl+i)"],
        ["u", "U", "underline (ctrl+u)"],
      ]),
    };
    const [bold, italic, underline] = E.segs.st.children;
    bold.style.fontWeight = "bold";
    italic.style.fontStyle = "italic";
    underline.style.textDecoration = "underline";
    E.actionsEl = h("div", "draw-actions", E.styleEl);
    for (const [act, label, title] of [
      ["dup", "dup", "duplicate (ctrl+d)"],
      ["del", "del", "delete (del)"],
      ["front", "front", "bring to front (alt+shift+↑ or shift+])"],
      ["forward", "fwd", "bring forward (alt+↑ or ])"],
      ["backward", "bwd", "send backward (alt+↓ or [)"],
      ["back", "back", "send to back (alt+shift+↓ or shift+[)"],
      ["group", "group", "group (ctrl+g)"],
      ["ungroup", "ungroup", "ungroup (ctrl+shift+g)"],
    ]) {
      const b = h("button", "", E.actionsEl, label);
      b.dataset.draw = "act:" + act;
      b.title = title;
    }

    E.menu = h("div", "draw-panel draw-menu", ui);
    E.menu.setAttribute("role", "menu");
    for (const item of MENU) {
      if (!item) {
        h("hr", "", E.menu);
        continue;
      }
      const [act, label, keys] = item;
      const b = h("button", "", E.menu, label);
      b.dataset.draw = "act:" + act;
      b.setAttribute("role", "menuitem");
      h("kbd", "", b, keys);
    }

    const nav = h("div", "draw-panel draw-nav", ui);
    const navBtn = (act, label, title, cls) => {
      const b = h("button", cls || "", nav, label);
      b.dataset.draw = "nav:" + act;
      b.title = title;
      b.setAttribute("aria-label", title);
      return b;
    };
    navBtn("out", "−", "zoom out (-)");
    E.zoomBtn = navBtn("reset", "100%", "reset zoom (shift+0)");
    navBtn("in", "+", "zoom in (+)");
    navBtn("fit", "fit", "zoom to fit (shift+1)");
    E.styleOpenBtn = navBtn("openstyle", "", "show style panel", "draw-edit draw-style-open");
    E.styleOpenBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="5" cy="5" r="2.3" fill="#f38ba8"/><circle cx="11" cy="5" r="2.3" fill="#a6e3a1"/><circle cx="5" cy="11" r="2.3" fill="#89b4fa"/><circle cx="11" cy="11" r="2.3" fill="#f9e2af"/></svg>';
    E.gridBtn = navBtn("grid", "", "toggle grid (ctrl+')", "draw-edit");
    E.gridBtn.innerHTML =
      '<svg viewBox="0 0 14 14" width="14" height="14" fill="currentColor">' +
      [2, 7, 12].flatMap((y) => [2, 7, 12].map((x) => `<circle cx="${x}" cy="${y}" r="1.4"/>`)).join("") +
      "</svg>";
    h("span", "draw-sep draw-edit", nav);
    navBtn("undo", "↶", "undo (ctrl+z)", "draw-edit");
    navBtn("redo", "↷", "redo (ctrl+shift+z)", "draw-edit");

    E.ta = h("textarea", "draw-text", host);
    E.ta.spellcheck = false;
    E.ta.setAttribute("aria-label", "Shape text");

    ui.addEventListener("click", onUiClick);
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("lostpointercapture", onUp);
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("contextmenu", onContextMenu);
    // Safari trackpad pinch
    let gestureZ = 1;
    host.addEventListener("gesturestart", (e) => {
      e.preventDefault();
      gestureZ = E.cam.z;
    });
    host.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, gestureZ * e.scale);
    });
    host.addEventListener("keydown", onKey);
    window.addEventListener("keyup", (e) => {
      if (e.key === " " && E.space) {
        E.space = false;
        updateCursor();
      }
    });
    window.addEventListener("blur", () => (E.space = false));
    document.addEventListener("copy", (e) => onClipboard(e, "copy"));
    document.addEventListener("cut", (e) => onClipboard(e, "cut"));
    document.addEventListener("paste", (e) => onClipboard(e, "paste"));
    E.ta.addEventListener("input", placeText);
    E.ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        finishTextEdit();
        E.host.focus({ preventScroll: true });
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && ["b", "i", "u"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        toggleTextStyle(e.key.toLowerCase());
      }
    });
    E.ta.addEventListener("blur", () => finishTextEdit());
    new ResizeObserver(() => E.mounted && applyCamera()).observe(host);
    document.fonts?.load(`16px ${FONT}`).then(() => {
      measureCache.clear();
      E.fontEpoch++;
      if (E.mounted) renderAll();
    });
  }

  // ── Mount / content ──

  function mount(host, opts) {
    if (E.host !== host) build(host);
    if (E.mounted) unmount();
    E.opts = opts;
    E.key = opts.key;
    E.mounted = true;
    E.sel = new Set();
    E.focusGroup = null;
    E.pending = null;
    load(opts.content);
    // Read-only (zen) always shows the whole drawing
    const view = !E.readonly && E.views.get(E.key);
    if (view) E.cam = { ...view };
    else fit(true);
    applyCamera();
    renderAll();
    if (!opts.noFocus) host.focus({ preventScroll: true });
  }

  function unmount() {
    if (!E.mounted) return;
    closeMenu();
    finishTextEdit();
    if (E.op) cancelOp();
    E.views.set(E.key, { ...E.cam });
    E.pointers.clear();
    E.mounted = false;
  }

  function load(content) {
    E.text = content;
    E.model = parse(content);
    E.readonly = !!E.opts.readonly || E.model.locked;
    E.host.classList.toggle("draw-readonly", E.readonly);
    rebuildIndex();
    for (const id of [...E.sel]) if (!E.model.byId.has(id)) E.sel.delete(id);
    E.cache.clear();
    E.shapesG.replaceChildren();
  }

  // Content changed outside the canvas (undo, other tab, Drive, source tab)
  function update(content) {
    if (!E.mounted || content === E.text) return;
    if (E.op || E.editing) {
      E.pending = content;
      return;
    }
    load(content);
    renderAll();
  }

  // Our edit replaces any outside change that arrived during it
  function commit() {
    if (E.readonly) return;
    const text = serialize(E.model);
    if (text === E.text) return;
    E.pending = null;
    E.text = text;
    E.opts.onCommit?.(text);
  }

  function rebuildIndex() {
    E.index = new Map();
    E.model.byId = new Map();
    E.model.shapes.forEach((s, i) => {
      if (s.k === "raw") return;
      E.index.set(s.id, i);
      E.model.byId.set(s.id, s);
    });
  }

  function replaceShape(s) {
    const i = E.index.get(s.id);
    if (i === undefined) return;
    E.model.shapes[i] = s;
    E.model.byId.set(s.id, s);
  }

  function addShape(s) {
    E.model.shapes.push(s);
    E.index.set(s.id, E.model.shapes.length - 1);
    E.model.byId.set(s.id, s);
  }

  function newId() {
    let id;
    do id = Math.random().toString(36).slice(2, 6);
    while (E.model.byId.has(id) || /^\d/.test(id));
    return id;
  }

  // Removing shapes frees the arrows bound to them at their current ends
  function removeShapes(ids) {
    const gone = new Set(ids);
    const m = E.model;
    m.shapes = m.shapes
      .filter((s) => s.k === "raw" || !gone.has(s.id))
      .map((s) => {
        if (s.k !== "a" || !(gone.has(s.from) || gone.has(s.to))) return s;
        const g = arrowGeom(s, m);
        return {
          ...s,
          from: gone.has(s.from) ? g.p0.map(R) : s.from,
          to: gone.has(s.to) ? g.p1.map(R) : s.to,
        };
      });
    for (const id of gone) E.sel.delete(id);
    rebuildIndex();
  }

  // ── Camera ──

  function viewSize() {
    const r = E.host.getBoundingClientRect();
    return [r.width || 1, r.height || 1];
  }

  function toWorld(sx, sy) {
    return [sx / E.cam.z + E.cam.x, sy / E.cam.z + E.cam.y];
  }

  function toScreen(p) {
    return [(p[0] - E.cam.x) * E.cam.z, (p[1] - E.cam.y) * E.cam.z];
  }

  function screenPt(e) {
    const r = E.svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function applyCamera() {
    const { x, y, z } = E.cam;
    E.world.setAttribute("transform", `matrix(${z} 0 0 ${z} ${-x * z} ${-y * z})`);
    let step = GRID * z;
    while (step < 10) step *= 5;
    E.pattern.setAttribute("width", step);
    E.pattern.setAttribute("height", step);
    // The dot is drawn at (1,1) inside its tile: shift it onto the grid point
    E.pattern.setAttribute("x", f1(-x * z - 1));
    E.pattern.setAttribute("y", f1(-y * z - 1));
    E.gridRect.style.display = E.model.grid ? "" : "none";
    E.zoomBtn.textContent = Math.round(z * 100) + "%";
    renderOverlay();
    placeText();
  }

  function zoomAt(sx, sy, z) {
    z = Math.min(ZMAX, Math.max(ZMIN, z));
    const [wx, wy] = toWorld(sx, sy);
    E.cam = { x: wx - sx / z, y: wy - sy / z, z };
    applyCamera();
  }

  function zoomBy(f) {
    const [w, h] = viewSize();
    zoomAt(w / 2, h / 2, E.cam.z * f);
  }

  function fit(silent) {
    const [vw, vh] = viewSize();
    const b = contentBounds(E.model);
    if (!b) {
      E.cam = { x: -vw / 2, y: -vh / 2, z: 1 };
    } else {
      const pad = Math.min(64, vw / 8);
      const z = Math.min(1, Math.max(ZMIN, Math.min((vw - pad * 2) / b.w, (vh - pad * 2) / b.h)));
      E.cam = { x: b.x + b.w / 2 - vw / 2 / z, y: b.y + b.h / 2 - vh / 2 / z, z };
    }
    if (!silent) applyCamera();
  }

  // ── Render ──

  function renderAll() {
    renderShapes();
    applyCamera();
    renderUI();
  }

  function renderShapes() {
    const layer = E.shapesG;
    const m = E.model;
    const seen = new Set();
    let node = layer.firstChild;
    for (const s of m.shapes) {
      if (s.k === "raw") continue;
      seen.add(s.id);
      const deps = s.k === "a" ? [m.byId.get(s.from), m.byId.get(s.to)] : null;
      const hide = E.editing?.id === s.id;
      let c = E.cache.get(s.id);
      if (
        !c ||
        c.s !== s ||
        c.hide !== hide ||
        c.epoch !== E.fontEpoch ||
        (deps && (c.deps[0] !== deps[0] || c.deps[1] !== deps[1]))
      ) {
        const g = renderShape(s, m, hide);
        if (c) {
          if (c.g === node) node = node.nextSibling;
          c.g.remove();
        }
        c = { s, g, deps, hide, epoch: E.fontEpoch };
        E.cache.set(s.id, c);
      }
      c.g.style.opacity = E.erasing.has(s.id) ? 0.25 : "";
      if (c.g === node) node = node.nextSibling;
      else layer.insertBefore(c.g, node);
    }
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    for (const id of E.cache.keys()) if (!seen.has(id)) E.cache.delete(id);
  }

  function selected() {
    return [...E.sel].map((id) => E.model.byId.get(id)).filter(Boolean);
  }

  function selFrame(sel) {
    if (sel.length === 1) {
      const f = frame(sel[0]);
      if (f) return { ...f, resizable: sel[0].k !== "t" };
    }
    // A turned multi-selection keeps its turned box while the shapes are
    // exactly those it was turned (or then moved) as
    const r = E.selRot;
    if (r && sel.length === r.shapes.size && sel.every((s) => r.shapes.has(s))) return { ...r.f, resizable: true };
    return { ...unionBounds(sel.map((s) => bounds(s, E.model))), rot: 0, resizable: true };
  }

  function keepSelRot(f) {
    E.selRot = f && E.sel.size > 1 ? { shapes: new Set(selected()), f } : null;
  }

  function polygon(pts, attrs) {
    return el("polygon", { points: pts.map((p) => P(toScreen(p))).join(" "), fill: "none", stroke: ACCENT, ...attrs }, E.overlay);
  }

  function outlineOf(s, attrs) {
    const f = frame(s);
    if (f) return polygon(corners(f), attrs);
    const b = bounds(s, E.model);
    return polygon(corners({ ...b, rot: 0 }), attrs);
  }

  function handle(kind, p, data, round) {
    const [x, y] = toScreen(p);
    const r = E.touch ? 6 : 4.5;
    if (round) el("circle", { cx: f1(x), cy: f1(y), r, fill: BG, stroke: ACCENT, "stroke-width": 1.5 }, E.overlay);
    else el("rect", { x: f1(x - r), y: f1(y - r), width: r * 2, height: r * 2, rx: 1.5, fill: BG, stroke: ACCENT, "stroke-width": 1.5 }, E.overlay);
    E.handles.push({ kind, x, y, ...data });
  }

  function renderOverlay() {
    E.overlay.replaceChildren();
    E.handles = [];
    if (!E.mounted) return;
    const op = E.op;
    if (op?.type === "marquee" && op.rect) {
      const r = op.rect;
      polygon(corners({ ...r, rot: 0 }), { fill: ACCENT, "fill-opacity": 0.08, "stroke-width": 1 });
    }
    if (E.bindTarget) {
      const t = E.model.byId.get(E.bindTarget);
      if (t) outlineOf(t, { "stroke-width": 2 });
    }
    if (E.readonly || (op && !["move", "resize", "rotate", "marquee", "point", "bend"].includes(op.type))) return;
    const sel = selected();
    if (!sel.length) return;
    if (sel.length > 1) for (const s of sel) outlineOf(s, { "stroke-width": 1, "stroke-opacity": 0.5 });
    const one = sel.length === 1 ? sel[0] : null;
    if (one && (one.k === "l" || one.k === "a")) {
      if (one.k === "l") {
        polygon(one.pts, { "stroke-width": 1, "stroke-opacity": 0 });
        one.pts.forEach((p, i) => handle("point", p, { idx: i }, true));
      } else {
        const g = arrowGeom(one, E.model);
        handle("point", g.p0, { idx: 0 }, true);
        handle("point", g.p1, { idx: 1 }, true);
        handle("bend", g.mid, {}, true);
      }
      return;
    }
    const f = selFrame(sel);
    polygon(corners(f), { "stroke-width": 1 });
    if (op && op.type !== "resize" && op.type !== "rotate") return;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    const z = E.cam.z;
    if (f.resizable) {
      const small = f.w * z < 24 || f.h * z < 24;
      for (const [hx, hy] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
        if (small && (hx === 0 || hy === 0)) continue;
        handle("resize", rotPt(cx + (hx * f.w) / 2, cy + (hy * f.h) / 2, cx, cy, f.rot), { hx, hy });
      }
    }
    const top = rotPt(cx, f.y, cx, cy, f.rot);
    const rh = rotPt(cx, f.y - 24 / z, cx, cy, f.rot);
    el("line", { x1: f1(toScreen(top)[0]), y1: f1(toScreen(top)[1]), x2: f1(toScreen(rh)[0]), y2: f1(toScreen(rh)[1]), stroke: ACCENT, "stroke-width": 1 }, E.overlay);
    handle("rotate", rh, {}, true);
  }

  // Values shared by the selection (or the tool), per style key
  function styleState() {
    const sel = selected();
    const kinds = sel.length ? sel.map((s) => s.k) : TOOL_KIND[E.tool] ? [TOOL_KIND[E.tool]] : [];
    const out = {};
    for (const key of ["c", "s", "f", "d", "ta", "va", "st", "hs", "he"]) {
      const relevant = kinds.some((k) => ATTRS[k].includes(key));
      if (!relevant) continue;
      if (!sel.length) {
        out[key] = E.style[key];
        continue;
      }
      if (key === "st") {
        const texts = sel.filter((s) => ATTRS[s.k].includes("st"));
        out.st = ["b", "i", "u"].filter((f) => texts.every((s) => (s.st || "").includes(f))).join("");
        continue;
      }
      const vals = new Set(sel.filter((s) => ATTRS[s.k].includes(key)).map((s) => s[key] ?? DEFAULTS[key]));
      out[key] = vals.size === 1 ? [...vals][0] : null;
    }
    return { out, sel, kinds };
  }

  function renderUI() {
    if (!E.mounted) return;
    for (const [id, b] of Object.entries(E.toolBtns)) b.classList.toggle("active", id === E.tool);
    for (const b of E.toolGrid.children) b.classList.toggle("active", b.dataset.draw === "tool:" + E.tool);
    const extra = !PINNED_TOOLS.has(E.tool);
    E.moreBtn.classList.toggle("active", extra);
    E.moreBtn.innerHTML = `<svg viewBox="0 0 22 22">${extra ? ICONS[E.tool] : '<path d="M11 4v14M4 11h14"/>'}</svg>`;
    const { out, sel } = styleState();
    const wanted = !E.readonly && Object.keys(out).length > 0;
    const show = wanted && !E.styleClosed;
    E.styleEl.classList.toggle("visible", show);
    E.styleOpenBtn.classList.toggle("visible", wanted && !!E.styleClosed);
    if (show) {
      E.swatches.style.display = "c" in out ? "" : "none";
      for (const b of E.swatches.children) b.classList.toggle("active", b.dataset.draw === "style:c:" + out.c);
      for (const [key, row] of Object.entries(E.segs)) {
        row.style.display = key in out ? "" : "none";
        for (const b of row.children)
          b.classList.toggle(
            "active",
            key === "st" ? (out.st || "").includes(b.dataset.draw.slice(-1)) : b.dataset.draw === `style:${key}:${out[key]}`,
          );
      }
      E.actionsEl.style.display = sel.length ? "" : "none";
      const grouped = sel.some((s) => s.gr);
      const groupBtn = E.actionsEl.querySelector('[data-draw="act:group"]');
      groupBtn.style.display = sel.length > 1 && !(grouped && new Set(sel.map((s) => s.gr)).size === 1) ? "" : "none";
      E.actionsEl.querySelector('[data-draw="act:ungroup"]').style.display = grouped ? "" : "none";
    }
    E.gridBtn.classList.toggle("active", E.model.grid);
    const empty = !E.model.shapes.some((s) => s.k !== "raw");
    E.hint.classList.toggle("visible", empty && !E.readonly && !E.op);
    E.hint.textContent = window.matchMedia("(pointer: coarse)").matches
      ? "pick a tool below and start drawing"
      : "d draw · r rectangle · a arrow · t text\ndouble-click to write anywhere";
    E.hint.style.whiteSpace = "pre-line";
    const errs = E.model.errors;
    E.badge.classList.toggle("visible", errs.length > 0);
    E.badge.title = errs.length ? errs.map((e) => `line ${e.line}: ${e.msg}`).slice(0, 10).join("\n") : "";
    if (errs.length)
      E.badge.textContent = E.model.locked
        ? "read-only: " + errs[errs.length - 1].msg
        : `${errs.length} line${errs.length > 1 ? "s" : ""} can't be drawn · fix in source`;
    updateCursor();
  }

  function updateCursor() {
    if (!E.svg) return;
    let c = "default";
    if (E.readonly || E.space || E.tool === "hand") c = E.op?.type === "pan" ? "grabbing" : "grab";
    else if (E.tool !== "select") c = "crosshair";
    E.svg.style.cursor = c;
  }

  // ── Tools, styles, actions ──

  function setTool(tool) {
    finishTextEdit();
    E.tool = tool;
    if (tool !== "select") {
      E.sel.clear();
      E.focusGroup = null;
    }
    renderOverlay();
    renderUI();
  }

  // b / i / u switch on for all selected texts, or off if all have it
  function toggleTextStyle(flag) {
    const texts = selected().filter((s) => ATTRS[s.k].includes("st"));
    const on = texts.length ? !texts.every((s) => (s.st || "").includes(flag)) : !E.style.st.includes(flag);
    const apply = (st) => textStyle(on ? st + flag : st.replace(flag, ""));
    E.style.st = apply(E.style.st);
    saveStyle();
    for (const s of texts) {
      const n = { ...s, st: apply(s.st || "") };
      if (!n.st) delete n.st;
      replaceShape(n);
    }
    if (texts.length) {
      renderShapes();
      renderOverlay();
      placeText();
      commit();
    }
    renderUI();
  }

  function setStyle(key, v) {
    if (key === "st") return toggleTextStyle(v);
    E.style[key] = v;
    saveStyle();
    let changed = false;
    for (const s of selected()) {
      if (!ATTRS[s.k].includes(key) || (s[key] ?? DEFAULTS[key]) === v) continue;
      replaceShape({ ...s, [key]: v });
      changed = true;
    }
    if (changed) {
      renderShapes();
      renderOverlay();
      commit();
    }
    renderUI();
  }

  function selectIds(ids) {
    E.sel = new Set(ids);
    renderOverlay();
    renderUI();
  }

  function groupIds(s) {
    if (!s.gr || E.focusGroup === s.gr) return [s.id];
    return E.model.shapes.filter((o) => o.gr === s.gr).map((o) => o.id);
  }

  function expandGroups(ids) {
    const out = new Set(ids);
    const groups = new Set();
    for (const id of ids) {
      const s = E.model.byId.get(id);
      if (s?.gr && s.gr !== E.focusGroup) groups.add(s.gr);
    }
    if (groups.size) for (const s of E.model.shapes) if (groups.has(s.gr)) out.add(s.id);
    return out;
  }

  function deleteSelection() {
    if (!E.sel.size) return;
    removeShapes([...E.sel]);
    E.sel.clear();
    renderAll();
    commit();
  }

  // Copies of shapes with fresh ids; bindings and groups follow the copies
  function cloneShapes(list, dx, dy) {
    const ids = new Map();
    const groups = new Map();
    for (const s of list) ids.set(s.id, newIdExcluding(ids));
    const src = new Set(list.map((s) => s.id));
    return list.map((s) => {
      let c = translate(s, dx, dy);
      c.id = ids.get(s.id);
      if (s.gr) {
        if (!groups.has(s.gr)) groups.set(s.gr, "g" + newIdExcluding(ids));
        c.gr = groups.get(s.gr);
      }
      if (c.k === "a") {
        const g = arrowGeom(s, E.model);
        const end = (e, moved, p) =>
          typeof e !== "string" ? moved : src.has(e) ? ids.get(e) : [R(p[0] + dx), R(p[1] + dy)];
        c = { ...c, from: end(s.from, c.from, g.p0), to: end(s.to, c.to, g.p1) };
      }
      return c;
    });
  }

  function newIdExcluding(taken) {
    let id;
    const used = new Set(taken.values());
    do id = newId();
    while (used.has(id));
    return id;
  }

  function insertShapes(list) {
    for (const s of list) addShape(s);
    E.sel = new Set(list.map((s) => s.id));
    E.focusGroup = null;
    renderAll();
    commit();
  }

  function duplicate() {
    const sel = selected();
    if (!sel.length) return;
    const d = E.model.grid ? GRID : 16;
    insertShapes(cloneShapes(sel, d, d));
  }

  // Restack shapes only; comment and blank lines keep their place
  function reorder(mode) {
    const m = E.model;
    if (!E.sel.size) return;
    const slots = [];
    m.shapes.forEach((s, i) => s.k !== "raw" && slots.push(i));
    let order = slots.map((i) => m.shapes[i]);
    const isSel = (s) => E.sel.has(s.id);
    if (mode === "front") order = [...order.filter((s) => !isSel(s)), ...order.filter(isSel)];
    else if (mode === "back") order = [...order.filter(isSel), ...order.filter((s) => !isSel(s))];
    else {
      // One step past the neighbouring unselected shape
      const up = mode === "forward";
      for (let i = up ? order.length - 2 : 1; i >= 0 && i < order.length; i += up ? -1 : 1) {
        const j = up ? i + 1 : i - 1;
        if (isSel(order[i]) && !isSel(order[j])) [order[i], order[j]] = [order[j], order[i]];
      }
    }
    if (order.every((s, i) => s === m.shapes[slots[i]])) return;
    m.shapes = m.shapes.slice();
    slots.forEach((slot, i) => (m.shapes[slot] = order[i]));
    rebuildIndex();
    renderShapes();
    commit();
  }

  function group() {
    const sel = selected();
    if (sel.length < 2) return;
    const gr = "g" + newId();
    for (const s of sel) replaceShape({ ...s, gr });
    E.focusGroup = null;
    renderAll();
    commit();
  }

  function ungroup() {
    const sel = selected();
    for (const s of sel) {
      if (!s.gr) continue;
      const { gr, ...rest } = s;
      replaceShape(rest);
    }
    E.focusGroup = null;
    renderAll();
    commit();
  }

  function toggleGrid() {
    E.model.grid = !E.model.grid;
    applyCamera();
    renderUI();
    commit();
  }

  function nudge(dx, dy) {
    const sel = selected();
    if (!sel.length) return;
    const ids = new Set(sel.map((s) => s.id));
    for (const s of sel) replaceShape(translate(unbindLoose(s, ids), dx, dy));
    renderShapes();
    renderOverlay();
    commit();
  }

  function onUiClick(e) {
    const b = e.target.closest("[data-draw]");
    if (!b || !E.mounted) return;
    const [kind, a, v] = b.dataset.draw.split(":");
    if (kind === "tool") {
      closeMenu();
      setTool(a);
    }
    else if (kind === "style") setStyle(a, v);
    else if (kind === "source") E.opts.onSource?.(E.model.errors[0]?.line || 1);
    else if (kind === "act") {
      closeMenu();
      ({
        dup: duplicate,
        del: deleteSelection,
        front: () => reorder("front"),
        forward: () => reorder("forward"),
        backward: () => reorder("backward"),
        back: () => reorder("back"),
        group,
        ungroup,
      })[a]();
    }
    else if (kind === "nav")
      ({
        in: () => zoomBy(1.25),
        out: () => zoomBy(0.8),
        reset: () => zoomBy(1 / E.cam.z),
        fit: () => fit(),
        grid: toggleGrid,
        tools: () => E.toolGrid.classList.toggle("visible"),
        closestyle: () => ((E.styleClosed = true), renderUI()),
        openstyle: () => ((E.styleClosed = false), renderUI()),
        undo: () => E.opts.onUndo?.(),
        redo: () => E.opts.onRedo?.(),
      })[a]();
    // Keep keyboard shortcuts working after a toolbar click
    if (!E.editing) E.host.focus({ preventScroll: true });
  }

  // ── Shape transforms ──

  function translate(s, dx, dy) {
    if (!dx && !dy) return { ...s };
    if (BOX.has(s.k) || s.k === "t") return { ...s, x: R(s.x + dx), y: R(s.y + dy) };
    if (s.k === "a") {
      const mv = (e) => (typeof e === "string" ? e : [R(e[0] + dx), R(e[1] + dy)]);
      return { ...s, from: mv(s.from), to: mv(s.to) };
    }
    return { ...s, pts: s.pts.map((p) => (p.length > 2 ? [R(p[0] + dx), R(p[1] + dy), p[2]] : [R(p[0] + dx), R(p[1] + dy)])) };
  }

  // An arrow moved without the shapes it's bound to lets go of them
  function unbindLoose(s, ids) {
    if (s.k !== "a") return s;
    const looseFrom = typeof s.from === "string" && !ids.has(s.from);
    const looseTo = typeof s.to === "string" && !ids.has(s.to);
    if (!looseFrom && !looseTo) return s;
    const g = arrowGeom(s, E.model);
    return { ...s, from: looseFrom ? g.p0.map(R) : s.from, to: looseTo ? g.p1.map(R) : s.to };
  }

  // Apply a point map to a shape; `rotDelta` is added to rotated boxes
  function mapShape(s, fn, rotDelta, scale) {
    if (BOX.has(s.k) || s.k === "t") {
      const f = frame(s);
      const c = fn([f.x + f.w / 2, f.y + f.h / 2]);
      let w = f.w;
      let hh = f.h;
      if (BOX.has(s.k) && scale) {
        // A box turned near 90° stretches along the other axis
        const r = (s.rot || 0) % 180;
        const swap = r > 45 && r < 135;
        w = Math.max(1, Math.abs(f.w * (swap ? scale[1] : scale[0])));
        hh = Math.max(1, Math.abs(f.h * (swap ? scale[0] : scale[1])));
      }
      const n = { ...s, x: R(c[0] - w / 2), y: R(c[1] - hh / 2) };
      if (BOX.has(s.k)) {
        n.w = R(w);
        n.h = R(hh);
      }
      if (rotDelta) n.rot = R((((s.rot || 0) + rotDelta) % 360 + 360) % 360);
      return n;
    }
    if (s.k === "a") {
      const mv = (e) => (typeof e === "string" ? e : fn(e).map(R));
      const n = { ...s, from: mv(s.from), to: mv(s.to) };
      if (scale && s.bend) n.bend = R(s.bend * Math.sqrt(Math.abs(scale[0] * scale[1])) * Math.sign(scale[0] * scale[1]));
      return n;
    }
    // Strokes: map the drawn points, then store them upright around the
    // new centre with the new rotation. Lines just take the mapped points.
    const f = frame(s);
    const r = s.rot || 0;
    const c = f ? [f.x + f.w / 2, f.y + f.h / 2] : [0, 0];
    const nr = f ? ((((r + (rotDelta || 0)) % 360) + 360) % 360) : 0;
    const nc = fn(c);
    const n = {
      ...s,
      pts: s.pts.map((p) => {
        const q = fn(rotPt(p[0], p[1], c[0], c[1], r));
        const l = rotPt(q[0], q[1], nc[0], nc[1], -nr);
        return p.length > 2 ? [R(l[0]), R(l[1]), p[2]] : [R(l[0]), R(l[1])];
      }),
    };
    if (f) n.rot = R(nr) % 360;
    if (!n.rot) delete n.rot;
    return n;
  }

  const snap = (v) => (E.model.grid ? Math.round(v / GRID) * GRID : v);
  const snapPt = (p) => [snap(p[0]), snap(p[1])];

  // ── Hit testing ──

  function tolerance() {
    return (E.touch ? 12 : 6) / E.cam.z;
  }

  function hitTest(p, filter) {
    const tol = tolerance();
    let hollow = null;
    let hollowArea = Infinity;
    const shapes = E.model.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.k === "raw" || (filter && !filter(s))) continue;
      const hit = hitShape(s, p, tol, E.model);
      if (hit === 1) return s;
      if (hit === 2) {
        const area = s.w * s.h;
        if (area < hollowArea) {
          hollow = s;
          hollowArea = area;
        }
      }
    }
    return hollow;
  }

  function handleAt(sp) {
    const r = E.touch ? 16 : 9;
    for (let i = E.handles.length - 1; i >= 0; i--) {
      const hd = E.handles[i];
      if (Math.hypot(hd.x - sp[0], hd.y - sp[1]) <= r) return hd;
    }
    return null;
  }

  function bindAt(p, self, other) {
    const s = hitTest(p, (s) => bindable(s) && s.id !== self);
    return s && s.id !== other ? s.id : null;
  }

  // ── Pointer input ──

  // Right click: act on the shape under the pointer (selecting it first)
  function onContextMenu(e) {
    e.preventDefault();
    if (!E.mounted || E.readonly || E.op) return;
    const sp = screenPt(e);
    const hit = hitTest(toWorld(...sp));
    if (hit && !E.sel.has(hit.id)) selectIds(groupIds(hit));
    else if (!hit) selectIds([]);
    const sel = selected();
    const grouped = sel.some((s) => s.gr);
    const sameGroup = grouped && new Set(sel.map((s) => s.gr)).size === 1 && sel.every((s) => s.gr);
    const enabled = {
      group: sel.length > 1 && !sameGroup,
      ungroup: grouped,
    };
    for (const b of E.menu.querySelectorAll("button")) {
      const act = b.dataset.draw.slice(4);
      b.disabled = !sel.length || enabled[act] === false;
    }
    const m = E.menu;
    m.classList.add("visible");
    const [vw, vh] = viewSize();
    m.style.left = Math.max(4, Math.min(sp[0], vw - m.offsetWidth - 4)) + "px";
    m.style.top = Math.max(4, Math.min(sp[1], vh - m.offsetHeight - 4)) + "px";
    m.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }

  function closeMenu() {
    E.menu?.classList.remove("visible");
    E.toolGrid?.classList.remove("visible");
  }

  function onDown(e) {
    if (!E.mounted) return;
    closeMenu();
    // No compatibility mouse events: their default focus handling would
    // steal focus from a label editor opened by this press
    e.preventDefault();
    if (E.editing) finishTextEdit();
    E.host.focus({ preventScroll: true });
    E.touch = e.pointerType === "touch";
    if (e.pointerType === "pen") E.sawPen = true;
    const sp = screenPt(e);
    E.pointers.set(e.pointerId, sp);
    try {
      E.svg.setPointerCapture(e.pointerId);
    } catch {}
    if (E.pointers.size === 2) {
      // Second finger: whatever the first one started becomes a pinch
      if (E.op && E.op.type !== "pinch") cancelOp();
      startPinch();
      return;
    }
    if (E.pointers.size > 2 || E.op) return;
    const w = toWorld(...sp);
    const now = performance.now();
    const last = E.lastDown;
    const dbl = !!last && now - last.t < 350 && Math.hypot(last.x - sp[0], last.y - sp[1]) < 12;
    E.lastDown = dbl ? null : { t: now, x: sp[0], y: sp[1] };

    // Palm rejection: once a pen was used, fingers only pan
    const pan =
      e.button === 1 ||
      E.space ||
      E.tool === "hand" ||
      E.readonly ||
      (E.touch && E.sawPen);
    if (pan) return startOp({ type: "pan", start: sp, cam: { ...E.cam } });
    if (e.button !== 0) return;

    const tool = E.tool;
    if (tool === "select") return downSelect(e, sp, w, dbl);
    if (tool === "eraser") {
      startOp({ type: "erase", last: w, before: E.model.shapes.slice() });
      eraseAt(w);
      return;
    }
    if (tool === "text") {
      const hit = hitTest(w, (s) => s.k === "t");
      if (hit) return startTextEdit(hit);
      return createText(w);
    }
    if (tool === "pen" || tool === "highlight") {
      const pressure = e.pointerType === "pen";
      const p = pressure ? [...w, pressureOf(e)] : w;
      const s = { k: TOOL_KIND[tool], id: newId(), pts: [p], c: E.style.c, s: E.style.s };
      startOp({ type: "pen", id: s.id, raw: [p], pressure, before: E.model.shapes.slice() });
      addShape(s);
      renderShapes();
      return;
    }
    const start = snapPt(w);
    if (tool === "line" || tool === "arrow") {
      const id = newId();
      const s =
        tool === "line"
          ? { k: "l", id, pts: [start, start], c: E.style.c, s: E.style.s, d: E.style.d }
          : { k: "a", id, from: bindAt(w, id) || start, to: start, c: E.style.c, s: E.style.s, d: E.style.d, hs: E.style.hs, he: E.style.he, st: E.style.st || undefined };
      startOp({ type: "line", id, start: sp, before: E.model.shapes.slice() });
      addShape(s);
      renderShapes();
      return;
    }
    const k = TOOL_KIND[tool];
    const s = { k, id: newId(), x: R(start[0]), y: R(start[1]), w: 1, h: 1, c: E.style.c, s: E.style.s, f: E.style.f, d: E.style.d, ta: E.style.ta, va: E.style.va, st: E.style.st || undefined };
    startOp({ type: "box", id: s.id, origin: start, start: sp, before: E.model.shapes.slice() });
    addShape(s);
    renderShapes();
  }

  function pressureOf(e) {
    return Math.min(9, Math.max(1, Math.round((e.pressure || 0.5) * 9)));
  }

  function downSelect(e, sp, w, dbl) {
    const hd = handleAt(sp);
    if (hd && !dbl) return startHandle(hd, w);
    const hit = hitTest(w);
    if (dbl) return onDouble(hit, w);
    if (hit) {
      const ids = groupIds(hit);
      if (e.shiftKey) {
        const all = ids.every((id) => E.sel.has(id));
        for (const id of ids) all ? E.sel.delete(id) : E.sel.add(id);
      } else if (!E.sel.has(hit.id)) {
        if (hit.gr !== E.focusGroup) E.focusGroup = null;
        E.sel = new Set(ids);
      }
      renderOverlay();
      renderUI();
      if (!E.sel.has(hit.id)) return;
      return startMove(sp, w);
    }
    if (!e.shiftKey) {
      E.sel.clear();
      E.focusGroup = null;
    }
    startOp({ type: "marquee", start: w, base: new Set(E.sel) });
    renderOverlay();
    renderUI();
  }

  function onDouble(hit, w) {
    if (!hit) return createText(w);
    if (hit.gr && E.focusGroup !== hit.gr) {
      E.focusGroup = hit.gr;
      return selectIds([hit.id]);
    }
    if (hit.k === "t" || hit.k === "a" || BOX.has(hit.k)) startTextEdit(hit);
  }

  function startOp(op) {
    E.op = op;
    updateCursor();
  }

  function startMove(sp, w) {
    const ids = new Set(E.sel);
    const sel = selected();
    const turned = sel.length > 1 && selFrame(sel).rot ? selFrame(sel) : null;
    const orig = sel.map((s) => unbindLoose(s, ids));
    const b = unionBounds(orig.map(geomBounds));
    startOp({ type: "move", start: w, startScreen: sp, orig, b, turned, moved: false, before: E.model.shapes.slice() });
  }

  function startHandle(hd, w) {
    const sel = selected();
    const before = E.model.shapes.slice();
    if (hd.kind === "point") return startOp({ type: "point", id: sel[0].id, idx: hd.idx, before });
    if (hd.kind === "bend") return startOp({ type: "bend", id: sel[0].id, before });
    const f = selFrame(sel);
    const c = [f.x + f.w / 2, f.y + f.h / 2];
    const ids = new Set(E.sel);
    const orig = sel.map((s) => unbindLoose(s, ids));
    if (hd.kind === "rotate")
      return startOp({ type: "rotate", f, c, orig, a0: Math.atan2(w[1] - c[1], w[0] - c[0]), before });
    startOp({ type: "resize", f, c, hx: hd.hx, hy: hd.hy, orig, before });
  }

  function startPinch() {
    const [a, b] = [...E.pointers.values()];
    E.op = {
      type: "pinch",
      d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
      m0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      cam: { ...E.cam },
      t0: performance.now(),
      moved: false,
    };
    E.op.w0 = [E.op.m0[0] / E.cam.z + E.cam.x, E.op.m0[1] / E.cam.z + E.cam.y];
  }

  function onMove(e) {
    if (!E.mounted) return;
    const sp = screenPt(e);
    if (E.pointers.has(e.pointerId)) E.pointers.set(e.pointerId, sp);
    const op = E.op;
    if (!op) return hoverCursor(sp);
    if (op.type === "pinch") {
      if (E.pointers.size < 2) return;
      const [a, b] = [...E.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.abs(d - op.d0) > 10 || Math.hypot(m[0] - op.m0[0], m[1] - op.m0[1]) > 10) op.moved = true;
      const z = Math.min(ZMAX, Math.max(ZMIN, (op.cam.z * d) / op.d0));
      E.cam = { x: op.w0[0] - m[0] / z, y: op.w0[1] - m[1] / z, z };
      applyCamera();
      return;
    }
    if (op.type === "pan") {
      E.cam = { ...op.cam, x: op.cam.x - (sp[0] - op.start[0]) / op.cam.z, y: op.cam.y - (sp[1] - op.start[1]) / op.cam.z };
      applyCamera();
      return;
    }
    const w = toWorld(...sp);
    if (op.type === "pen") {
      const events = e.getCoalescedEvents?.() || [e];
      for (const ev of events.length ? events : [e]) {
        const p = toWorld(...screenPt(ev));
        const last = op.raw[op.raw.length - 1];
        // Light streamlining takes the jitter out of the hand
        const q = [last[0] + (p[0] - last[0]) * 0.7, last[1] + (p[1] - last[1]) * 0.7];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) * E.cam.z < 1) continue;
        op.raw.push(op.pressure ? [...q, pressureOf(ev)] : q);
      }
      replaceShape({ ...E.model.byId.get(op.id), pts: op.raw.slice() });
      renderShapes();
      return;
    }
    if (op.type === "erase") {
      const steps = Math.ceil((Math.hypot(w[0] - op.last[0], w[1] - op.last[1]) * E.cam.z) / 4);
      for (let i = 1; i <= steps; i++)
        eraseAt([op.last[0] + ((w[0] - op.last[0]) * i) / steps, op.last[1] + ((w[1] - op.last[1]) * i) / steps]);
      op.last = w;
      return;
    }
    if (op.type === "marquee") {
      const r = ptsBounds([op.start, w]);
      op.rect = r;
      const ids = new Set(op.base);
      for (const s of E.model.shapes) if (s.k !== "raw" && inRect(s, r)) ids.add(s.id);
      E.sel = expandGroups(ids);
      renderOverlay();
      return;
    }
    if (op.type === "move") return moveTo(e, sp, w);
    if (op.type === "box") return boxTo(e, sp, w);
    if (op.type === "line") return lineTo(e, sp, w);
    if (op.type === "point") return pointTo(e, w);
    if (op.type === "bend") {
      const s = E.model.byId.get(op.id);
      const g = arrowGeom({ ...s, bend: 0 }, E.model);
      const bend = R((w[0] - g.base[0]) * g.n[0] + (w[1] - g.base[1]) * g.n[1]);
      replaceShape({ ...s, bend: Math.abs(bend) < 3 ? 0 : bend });
      renderShapes();
      renderOverlay();
      return;
    }
    if (op.type === "rotate") return rotateTo(e, w);
    if (op.type === "resize") return resizeTo(e, w);
  }

  function hoverCursor(sp) {
    if (E.readonly || E.space || E.tool !== "select") return;
    const hd = handleAt(sp);
    let c = "default";
    if (hd?.kind === "rotate") c = "grab";
    else if (hd?.kind === "point" || hd?.kind === "bend") c = "pointer";
    else if (hd) {
      const f = selFrame(selected());
      const a = (((Math.atan2(hd.hy, hd.hx) * 180) / Math.PI + f.rot) % 180 + 180) % 180;
      c = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][Math.round(a / 45) % 4];
    } else if (hitTest(toWorld(...sp))) c = "move";
    E.svg.style.cursor = c;
  }

  function inRect(s, r) {
    const inside = (p) => p[0] >= r.x && p[0] <= r.x + r.w && p[1] >= r.y && p[1] <= r.y + r.h;
    if (POINTS.has(s.k)) {
      const pts = worldPts(s);
      if (pts.some(inside)) return true;
      // Long straight segments: sample along them
      for (let i = 1; i < pts.length; i++)
        for (let t = 0.1; t < 1; t += 0.1)
          if (inside([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]))
            return true;
      return false;
    }
    const b = bounds(s, E.model);
    return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
  }

  function moveTo(e, sp, w) {
    const op = E.op;
    if (!op.moved && Math.hypot(sp[0] - op.startScreen[0], sp[1] - op.startScreen[1]) < 3) return;
    op.moved = true;
    let dx = w[0] - op.start[0];
    let dy = w[1] - op.start[1];
    if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
    if (E.model.grid) {
      dx = snap(op.b.x + dx) - op.b.x;
      dy = snap(op.b.y + dy) - op.b.y;
    }
    for (const s of op.orig) replaceShape(translate(s, dx, dy));
    if (op.turned) keepSelRot({ ...op.turned, x: op.turned.x + dx, y: op.turned.y + dy });
    renderShapes();
    renderOverlay();
  }

  function boxTo(e, sp, w) {
    const op = E.op;
    if (Math.hypot(sp[0] - op.start[0], sp[1] - op.start[1]) > 3) op.moved = true;
    const [ox, oy] = op.origin;
    let [x, y] = snapPt(w);
    let dw = x - ox;
    let dh = y - oy;
    if (e.shiftKey) {
      const m = Math.max(Math.abs(dw), Math.abs(dh));
      dw = Math.sign(dw || 1) * m;
      dh = Math.sign(dh || 1) * m;
    }
    replaceShape({
      ...E.model.byId.get(op.id),
      x: R(Math.min(ox, ox + dw)),
      y: R(Math.min(oy, oy + dh)),
      w: Math.max(1, R(Math.abs(dw))),
      h: Math.max(1, R(Math.abs(dh))),
    });
    renderShapes();
  }

  function angleSnap(from, p) {
    const a = Math.atan2(p[1] - from[1], p[0] - from[0]);
    const s = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
    return [from[0] + Math.cos(s) * d, from[1] + Math.sin(s) * d];
  }

  function lineTo(e, sp, w) {
    const op = E.op;
    if (Math.hypot(sp[0] - op.start[0], sp[1] - op.start[1]) > 3) op.moved = true;
    const s = E.model.byId.get(op.id);
    if (s.k === "l") {
      const p = e.shiftKey ? angleSnap(s.pts[0], w) : snapPt(w);
      replaceShape({ ...s, pts: [s.pts[0], p.map(R)] });
    } else {
      const fromId = typeof s.from === "string" ? s.from : null;
      const target = bindAt(w, s.id, fromId);
      E.bindTarget = target;
      const fromPt = fromId ? anchor(fromId, E.model).c : s.from;
      const p = target || (e.shiftKey ? angleSnap(fromPt, w) : snapPt(w)).map(R);
      replaceShape({ ...s, to: p });
      renderOverlay();
    }
    renderShapes();
  }

  function pointTo(e, w) {
    const op = E.op;
    const s = E.model.byId.get(op.id);
    if (s.k === "l") {
      const pts = s.pts.slice();
      const other = pts[op.idx === 0 ? 1 : op.idx - 1];
      pts[op.idx] = (e.shiftKey && other ? angleSnap(other, w) : snapPt(w)).map(R);
      replaceShape({ ...s, pts });
    } else {
      const key = op.idx === 0 ? "from" : "to";
      const other = s[op.idx === 0 ? "to" : "from"];
      const target = bindAt(w, s.id, typeof other === "string" ? other : null);
      E.bindTarget = target;
      replaceShape({ ...s, [key]: target || snapPt(w).map(R) });
    }
    renderShapes();
    renderOverlay();
  }

  function rotateTo(e, w) {
    const op = E.op;
    let delta = ((Math.atan2(w[1] - op.c[1], w[0] - op.c[0]) - op.a0) * 180) / Math.PI;
    if (e.shiftKey) {
      // Snap the resulting angle (single shape) or the turn itself to 15°
      const baseRot = op.orig.length === 1 ? op.orig[0].rot || 0 : 0;
      delta = Math.round((baseRot + delta) / 15) * 15 - baseRot;
    }
    const fn = (p) => rotPt(p[0], p[1], op.c[0], op.c[1], delta);
    for (const s of op.orig) replaceShape(mapShape(s, fn, delta));
    keepSelRot({ ...op.f, rot: (((op.f.rot + delta) % 360) + 360) % 360 });
    renderShapes();
    renderOverlay();
  }

  function resizeTo(e, w) {
    const op = E.op;
    const { f, c, hx, hy } = op;
    let p = f.rot ? w : snapPt(w);
    const [lx, ly] = rotPt(p[0], p[1], c[0], c[1], -f.rot).map((v, i) => v - c[i]);
    const ax = (-hx * f.w) / 2;
    const ay = (-hy * f.h) / 2;
    let sx = hx ? (lx - ax) / (hx * f.w) : 1;
    let sy = hy ? (ly - ay) / (hy * f.h) : 1;
    if (e.shiftKey) {
      // Keep proportions
      if (hx && hy) {
        const m = Math.max(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * m;
        sy = Math.sign(sy || 1) * m;
      } else if (hx) sy = Math.abs(sx);
      else sx = Math.abs(sy);
    }
    const minX = 1 / Math.max(f.w, 1);
    const minY = 1 / Math.max(f.h, 1);
    if (Math.abs(sx) < minX) sx = Math.sign(sx || 1) * minX;
    if (Math.abs(sy) < minY) sy = Math.sign(sy || 1) * minY;
    // Local point → scaled about the anchor → back to world
    const fn = (q) => {
      const [qx, qy] = rotPt(q[0], q[1], c[0], c[1], -f.rot);
      const nx = ax + (qx - c[0] - ax) * sx;
      const ny = ay + (qy - c[1] - ay) * sy;
      return rotPt(c[0] + nx, c[1] + ny, c[0], c[1], f.rot);
    };
    for (const s of op.orig) replaceShape(mapShape(s, fn, 0, [sx, sy]));
    renderShapes();
    renderOverlay();
  }

  function eraseAt(p) {
    const s = hitTest(p, (s) => !E.erasing.has(s.id));
    if (!s || hitShape(s, p, tolerance(), E.model) !== 1) return;
    E.erasing.add(s.id);
    renderShapes();
  }

  function onUp(e) {
    if (!E.pointers.has(e.pointerId)) return;
    E.pointers.delete(e.pointerId);
    const op = E.op;
    if (!op) return;
    if (op.type === "pinch") {
      if (E.pointers.size) return;
      E.op = null;
      // Two-finger tap: undo
      if (!op.moved && performance.now() - op.t0 < 300) E.opts.onUndo?.();
      return;
    }
    if (E.pointers.size) return;
    E.op = null;
    E.bindTarget = null;
    let changed = true;
    if (op.type === "pan" || op.type === "marquee") changed = false;
    else if (op.type === "move") changed = op.moved;
    else if (op.type === "pen") {
      const eps = Math.max(0.3, 0.6 / E.cam.z);
      let pts = simplify(op.raw, eps).map((p) => (p.length > 2 ? [R(p[0]), R(p[1]), p[2]] : [R(p[0]), R(p[1])]));
      pts = pts.filter((p, i) => !i || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
      replaceShape({ ...E.model.byId.get(op.id), pts });
    } else if (op.type === "erase") {
      changed = E.erasing.size > 0;
      if (changed) removeShapes([...E.erasing]);
      E.erasing.clear();
    } else if (op.type === "box") {
      const s = E.model.byId.get(op.id);
      if (!op.moved) {
        const [w, hh] = s.k === "r" ? [160, 100] : s.k === "e" ? [140, 100] : [140, 120];
        replaceShape({ ...s, x: R(op.origin[0] - w / 2), y: R(op.origin[1] - hh / 2), w, h: hh });
      }
      E.sel = new Set([op.id]);
      E.tool = "select";
    } else if (op.type === "line") {
      if (!op.moved) {
        removeShapes([op.id]);
        changed = false;
      } else {
        E.sel = new Set([op.id]);
        E.tool = "select";
      }
    }
    renderAll();
    if (changed) commit();
    if (E.pending) update(E.pending);
  }

  // Undo whatever the gesture did so far
  function cancelOp() {
    const op = E.op;
    if (!op) return;
    E.op = null;
    E.bindTarget = null;
    E.erasing.clear();
    if (op.before) {
      E.model.shapes = op.before;
      rebuildIndex();
      for (const id of [...E.sel]) if (!E.model.byId.has(id)) E.sel.delete(id);
    }
    if (op.cam) E.cam = op.cam;
    renderAll();
  }

  function onWheel(e) {
    if (!E.mounted) return;
    e.preventDefault();
    const sp = screenPt(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      const d = Math.max(-25, Math.min(25, e.deltaY * unit));
      zoomAt(sp[0], sp[1], E.cam.z * Math.exp(-d * 0.01));
      return;
    }
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
    E.cam = { ...E.cam, x: E.cam.x + dx / E.cam.z, y: E.cam.y + dy / E.cam.z };
    applyCamera();
  }

  // ── Keyboard ──

  function onKey(e) {
    if (!E.mounted || e.target === E.ta) return;
    if (e.target.closest?.("input, textarea, select")) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.shiftKey && e.code === "Digit1") return done(), fit();
    if (e.shiftKey && e.code === "Digit0") return done(), zoomBy(1 / E.cam.z);
    if (!e.altKey && (k === "=" || k === "+")) return done(), zoomBy(1.25);
    if (!e.altKey && k === "-") return done(), zoomBy(0.8);
    if (k === " " && !mod) {
      if (!e.repeat) {
        E.space = true;
        updateCursor();
      }
      return done();
    }
    if (E.readonly) return;
    if (k === "Escape") {
      if (E.menu.classList.contains("visible")) closeMenu();
      else if (E.op) cancelOp();
      else if (E.focusGroup) {
        const s = selected()[0];
        E.focusGroup = null;
        selectIds(s ? groupIds(s) : []);
      } else if (E.sel.size) selectIds([]);
      else if (E.tool !== "select") setTool("select");
      else return;
      return done();
    }
    if (E.op) return;
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === "a" && !e.shiftKey) selectIds(E.model.shapes.filter((s) => s.k !== "raw").map((s) => s.id));
      else if (lk === "d" && !e.shiftKey) duplicate();
      else if (lk === "g") e.shiftKey ? ungroup() : group();
      else if (e.code === "Quote") toggleGrid();
      else if (["b", "i", "u"].includes(lk) && !e.shiftKey) toggleTextStyle(lk);
      else return;
      return done();
    }
    if (e.altKey) {
      // Alt+↑/↓ restack, like moving lines in the text editor
      if (k === "ArrowUp") reorder(e.shiftKey ? "front" : "forward");
      else if (k === "ArrowDown") reorder(e.shiftKey ? "back" : "backward");
      else return;
      return done();
    }
    const step = e.shiftKey ? 10 : E.model.grid ? GRID : 1;
    if (k === "Delete" || k === "Backspace") deleteSelection();
    else if (k === "Enter") {
      const sel = selected();
      if (sel.length !== 1 || POINTS.has(sel[0].k)) return;
      startTextEdit(sel[0]);
    } else if (k === "ArrowLeft") nudge(-step, 0);
    else if (k === "ArrowRight") nudge(step, 0);
    else if (k === "ArrowUp") nudge(0, -step);
    else if (k === "ArrowDown") nudge(0, step);
    else if (e.code === "BracketRight") reorder(e.shiftKey ? "front" : "forward");
    else if (e.code === "BracketLeft") reorder(e.shiftKey ? "back" : "backward");
    else if (TOOL_KEYS[k] && !(e.shiftKey && k !== "D")) setTool(TOOL_KEYS[k]);
    else return;
    done();
  }

  // ── Clipboard: shapes travel as drawing text ──

  function onClipboard(e, kind) {
    if (!E.mounted || E.editing || !E.host.contains(document.activeElement)) return;
    if (document.activeElement.closest("input, textarea")) return;
    if (kind === "paste") {
      if (E.readonly) return;
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      pasteText(text);
      return;
    }
    const sel = selected();
    if (!sel.length) return;
    e.preventDefault();
    const ids = new Set(sel.map((s) => s.id));
    const lines = E.model.shapes.filter((s) => s.k !== "raw" && ids.has(s.id)).map((s) => shapeLine(unbindLoose(s, ids)));
    e.clipboardData.setData("text/plain", ["draw " + VERSION, ...lines].join("\n") + "\n");
    if (kind === "cut" && !E.readonly) deleteSelection();
  }

  function pasteText(text) {
    const m = parse(text);
    const shapes = m.shapes.filter((s) => s.k !== "raw");
    const [vw, vh] = viewSize();
    const center = toWorld(vw / 2, vh / 2);
    if (!shapes.length || !/^\s*draw\s/.test(text)) {
      const label = text.slice(0, MAX_LABEL).replace(/\r/g, "");
      const s = { k: "t", id: newId(), x: 0, y: 0, c: E.style.c, s: E.style.s, st: E.style.st || undefined, label };
      const t = textSize(s);
      insertShapes([{ ...s, x: R(center[0] - t.w / 2), y: R(center[1] - t.h / 2) }]);
      return;
    }
    // Same drawing: offset so the copy is visible; elsewhere: into view
    let dx = 0;
    let dy = 0;
    const b = contentBounds(m);
    const view = { x: E.cam.x, y: E.cam.y, w: vw / E.cam.z, h: vh / E.cam.z };
    const visible = b.x < view.x + view.w && b.x + b.w > view.x && b.y < view.y + view.h && b.y + b.h > view.y;
    if (!visible) {
      dx = R(center[0] - (b.x + b.w / 2));
      dy = R(center[1] - (b.y + b.h / 2));
    } else if (shapes.some((s) => E.model.byId.has(s.id))) dx = dy = E.model.grid ? GRID : 16;
    // Bindings resolve against the pasted model, not ours
    const saved = E.model;
    E.model = { ...m, byId: new Map([...saved.byId, ...m.byId]) };
    const clones = cloneShapes(shapes, dx, dy);
    E.model = saved;
    insertShapes(clones);
  }

  // ── Text editing ──

  function createText(w) {
    const s = { k: "t", id: newId(), x: 0, y: 0, c: E.style.c, s: E.style.s, st: E.style.st || undefined };
    const size = fontSize(s);
    const p = snapPt([w[0], w[1] - (size * LINE_H) / 2]);
    s.x = R(p[0]);
    s.y = R(p[1]);
    addShape(s);
    E.tool = "select";
    E.sel = new Set([s.id]);
    startTextEdit(s);
  }

  function startTextEdit(s) {
    if (E.readonly) return;
    E.editing = { id: s.id };
    E.sel = new Set([s.id]);
    const ta = E.ta;
    ta.value = s.label || "";
    ta.classList.toggle("wrap", s.k !== "t");
    ta.style.display = "block";
    renderShapes();
    renderOverlay();
    renderUI();
    placeText();
    ta.focus({ preventScroll: true });
    ta.select();
  }

  function placeText() {
    const ed = E.editing;
    if (!ed) return;
    const s = E.model.byId.get(ed.id);
    if (!s) return;
    const ta = E.ta;
    const z = E.cam.z;
    const size = fontSize(s);
    const text = ta.value;
    const lineH = size * LINE_H;
    let cx;
    let cy;
    let w;
    let hh;
    let rot = s.rot || 0;
    if (s.k === "t") {
      const lines = text.split("\n");
      const tw = Math.max(size, ...lines.map((l) => measure(l, size, s.st)));
      w = tw + size;
      hh = lines.length * lineH;
      cx = s.x + w / 2;
      cy = s.y + hh / 2;
    } else if (s.k === "a") {
      const g = arrowGeom(s, E.model);
      const lines = wrap(text || " ", size, size * 14, s.st);
      w = Math.max(size * 2, ...lines.map((l) => measure(l, size, s.st))) + size * 0.6;
      hh = lines.length * lineH;
      [cx, cy] = g.mid;
      rot = 0;
    } else {
      w = labelWidth(s);
      const lp = labelPos(s, wrap(text || " ", size, w, s.st).length);
      hh = lp.total;
      const left = lp.anchor === "start" ? lp.x : lp.anchor === "end" ? lp.x - w : lp.x - w / 2;
      // The editor turns around its own centre, the shape around its centre
      [cx, cy] = rotPt(left + w / 2, lp.y + hh / 2, s.x + s.w / 2, s.y + s.h / 2, rot);
    }
    const [sx, sy] = toScreen([cx, cy]);
    Object.assign(ta.style, {
      left: f1(sx - (w * z) / 2) + "px",
      top: f1(sy - (hh * z) / 2) + "px",
      width: f1(w * z) + "px",
      height: f1(hh * z) + "px",
      fontSize: size * z + "px",
      fontWeight: s.st?.includes("b") ? "bold" : "",
      webkitTextStroke: s.st?.includes("b") ? f1(size * z * 0.045) + "px " + labelColor(s) : "",
      fontStyle: s.st?.includes("i") ? "italic" : "",
      textDecoration: s.st?.includes("u") ? "underline" : "",
      color: labelColor(s),
      transform: rot ? `rotate(${rot}deg)` : "",
      textAlign: s.k === "t" ? "left" : BOX.has(s.k) ? s.ta || "center" : "center",
      // Arrow labels sit on the line: keep it out from under the text
      background: s.k === "a" ? BG : "",
      borderRadius: s.k === "a" ? "4px" : "",
    });
  }

  function finishTextEdit() {
    const ed = E.editing;
    if (!ed) return;
    E.editing = null;
    const ta = E.ta;
    ta.style.display = "none";
    const s = E.model.byId.get(ed.id);
    if (s) {
      const label = ta.value.replace(/\s+$/, "").slice(0, MAX_LABEL);
      if (s.k === "t" && !label.trim()) removeShapes([s.id]);
      else {
        const n = { ...s, label };
        if (!label) delete n.label;
        if (BOX.has(s.k) && label) {
          // Grow the shape around its centre until the label fits
          const size = fontSize(n);
          const [aw, ah] = LABEL_AREA[n.k];
          const word = Math.max(...label.split(/\s+/).map((w) => measure(w, size, n.st)));
          const needW = R((word + labelPad(n) * 2) / aw);
          if (needW > n.w) {
            n.x = R(n.x - (needW - n.w) / 2);
            n.w = needW;
          }
          const lines = wrap(label, size, labelWidth(n), n.st).length;
          const needH = R((lines * size * LINE_H + labelPad(n) * 2) / ah);
          if (needH > n.h) {
            n.y = R(n.y - (needH - n.h) / 2);
            n.h = needH;
          }
        }
        replaceShape(n);
      }
    }
    renderAll();
    commit();
    if (E.pending) update(E.pending);
  }

  // Select a shape and bring it into view (search results)
  function reveal(id) {
    const s = E.mounted && E.model.byId.get(id);
    if (!s) return;
    const b = bounds(s, E.model);
    const [vw, vh] = viewSize();
    E.cam = { ...E.cam, x: b.x + b.w / 2 - vw / 2 / E.cam.z, y: b.y + b.h / 2 - vh / 2 / E.cam.z };
    E.tool = "select";
    E.focusGroup = null;
    selectIds(groupIds(s));
    applyCamera();
    E.host.focus({ preventScroll: true });
  }

  window.Draw = {
    reveal,
    parse,
    serialize,
    renderStatic,
    svgString,
    pngBlob,
    setTheme: () => {
      readTheme();
      if (E.mounted) renderAll();
    },
    mount,
    unmount,
    update,
    isMounted: () => E.mounted,
    // For tests
    _state: E,
  };
})();
