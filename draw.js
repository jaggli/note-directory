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
  const STROKE = { xs: 1, s: 2, m: 3.5, l: 5, xl: 8 };
  const FONT_SIZE = { xs: 12, s: 16, m: 22, l: 30, xl: 44 };
  // Latin subsets with every weight, declared in index.html
  const FONTS = {
    mono: { family: "Victor Mono", url: "fonts/VictorMono.woff2", css: '"Victor Mono", "SF Mono", Consolas, monospace', adjust: "90.91%" },
    sans: { family: "Source Sans 3", url: "fonts/SourceSans3.woff2", css: '"Source Sans 3", system-ui, sans-serif' },
    serif: { family: "Source Serif 4", url: "fonts/SourceSerif4.woff2", css: '"Source Serif 4", Georgia, serif' },
  };
  const HEADS = ["none", "open", "triangle", "dot", "diamond", "bar"];
  const ENUMS = {
    c: Object.keys(COLOR_VARS),
    s: Object.keys(STROKE),
    f: ["none", "semi", "solid"],
    d: ["solid", "dash", "dot", "none"],
    hs: HEADS,
    he: HEADS,
    ta: ["left", "center", "right"],
    va: ["top", "middle", "bottom"],
    fo: Object.keys(FONTS),
  };
  const DEFAULTS = { c: "text", s: "m", f: "none", d: "solid", hs: "none", he: "open", ta: "center", va: "middle", st: "", fo: "mono", bend: 0, rot: 0, o: 100 };
  // Text is placed by its top-left corner unless aligned otherwise
  const TEXT_DEFAULTS = { ...DEFAULTS, ta: "left", va: "top" };
  const defaultOf = (s, key) => (s.k === "t" ? TEXT_DEFAULTS : DEFAULTS)[key];
  const BOX = new Set(["r", "e", "m", "w"]);
  const POINTS = new Set(["l", "p", "h"]);
  const BOX_ATTRS = ["c", "s", "f", "d", "ta", "va", "st", "fo", "o", "rot", "gr"];
  const ATTRS = {
    r: [...BOX_ATTRS, "rx"],
    e: BOX_ATTRS,
    m: BOX_ATTRS,
    w: ["c", "s", "f", "d", "st", "fo", "o", "ir", "rot", "gr"],
    t: ["c", "s", "ta", "va", "st", "fo", "o", "rot", "gr"],
    l: ["c", "s", "f", "d", "o", "gr"],
    a: ["c", "s", "d", "hs", "he", "st", "fo", "o", "bend", "gr"],
    p: ["c", "s", "th", "tp", "o", "rot", "gr"],
    h: ["c", "s", "o", "rot", "gr"],
  };
  // Caps keep a hostile shared link from freezing the page
  const MAX_LINES = 20000;
  const MAX_POINTS = 200000;
  const MAX_COORD = 1e6;
  // Number attributes that have a range of their own
  const RANGES = { o: [1, 100], rx: [0, MAX_COORD], ir: [0, 99], th: [0, 100], tp: [0, MAX_COORD] };
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
      } else {
        s[key] = num(v);
        const r = RANGES[key];
        if (r && (s[key] < r[0] || s[key] > r[1])) throw `${key} must be ${r[0]}-${r[1]}`;
      }
    }
    if (label !== null) {
      if (POINTS.has(k)) throw "this shape has no label";
      if (label.length > MAX_LABEL) throw "label too long";
      if (label) s.label = label;
    }
    if (k === "w") {
      if (pos.length !== 6) throw "expected: x y width height from to";
      [s.x, s.y, s.w, s.h, s.a0, s.a1] = pos.map(num);
      if (s.a1 <= s.a0 || s.a1 - s.a0 > 360) throw "to must be after from, at most 360 more";
    } else if (BOX.has(k)) {
      if (pos.length !== 4) throw "expected: x y width height";
      [s.x, s.y, s.w, s.h] = pos.map(num);
    }
    if (BOX.has(k) && (s.w < 1 || s.h < 1)) throw "width and height must be positive";
    if (k === "t") {
      if (pos.length !== 2) throw "expected: x y";
      [s.x, s.y] = pos.map(num);
    } else if (k === "l") {
      if (pos.length < 2) throw "expected two or more points";
      s.pts = pos.map((p) => point(p));
    } else if (k === "a") {
      if (pos.length !== 2) throw "expected: start end";
      s.from = parseEnd(pos[0]);
      s.to = parseEnd(pos[1]);
    } else if (!BOX.has(k)) {
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
      if (v === undefined || v === defaultOf(s, key)) continue;
      if (key === "rot" || key === "bend") {
        if (R(v)) attrs.push(key + "=" + R(v));
      } else attrs.push(key + "=" + v);
    }
    // Pens: style first, it would be lost at the end of a long point list
    if (s.k === "p" || s.k === "h") parts.push(...attrs);
    if (BOX.has(s.k)) {
      parts.push(R(s.x), R(s.y), R(s.w), R(s.h));
      if (s.k === "w") parts.push(R(s.a0), R(s.a1));
    } else if (s.k === "t") parts.push(R(s.x), R(s.y));
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
  // `f`: the shape, for its text style (st) and font (fo)
  const fontCss = (size, f) =>
    (f.st?.includes("i") ? "italic " : "") + (f.st?.includes("b") ? "bold " : "") + size + "px " + FONTS[f.fo || "mono"].css;

  function measure(str, size, f) {
    const key = size + (f.st || "") + (f.fo || "") + "|" + str;
    let w = measureCache.get(key);
    if (w === undefined) {
      measureCtx ??= document.createElement("canvas").getContext("2d");
      measureCtx.font = fontCss(size, f);
      w = measureCtx.measureText(str).width;
      if (measureCache.size > 5000) measureCache.clear();
      measureCache.set(key, w);
    }
    return w;
  }

  // Greedy word wrap at spaces; a word wider than the line overflows it
  function wrap(label, size, maxW, f) {
    const out = [];
    for (const para of label.split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? line + " " + word : word;
        if (!line || measure(next, size, f) <= maxW) line = next;
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
    const w = Math.max(size * 0.6, ...lines.map((l) => measure(l, size, s)));
    return { w: Math.ceil(w), h: Math.ceil(lines.length * size * LINE_H), lines, size };
  }

  function labelPad(s) {
    return fontSize(s) * 0.25 + 6;
  }

  // Share of a box's width/height that a label can use
  const LABEL_AREA = { r: [1, 1], e: [0.75, 0.75], m: [0.55, 0.55], w: [0.4, 0.4] };

  function labelWidth(s) {
    return Math.max(fontSize(s), s.w * LABEL_AREA[s.k][0] - labelPad(s) * 2);
  }

  // Point on a wedge's ellipse at `deg` (clockwise from 12 o'clock), `r` of the way out
  function wedgePt(s, deg, r) {
    const a = (deg * Math.PI) / 180;
    return [s.x + (s.w / 2) * (1 + r * Math.sin(a)), s.y + (s.h / 2) * (1 - r * Math.cos(a))];
  }

  // A wedge's label sits halfway across its ring, or in the middle of a whole disc
  function wedgeMid(s) {
    const ir = (s.ir || 0) / 100;
    const r = s.a1 - s.a0 >= 360 && !ir ? 0 : ir ? (1 + ir) / 2 : 0.6;
    return wedgePt(s, (s.a0 + s.a1) / 2, r);
  }

  // Unrotated anchor of a box label: x for the text anchor, y of its top
  function labelPos(s, lineCount) {
    const [aw, ah] = LABEL_AREA[s.k];
    const pad = labelPad(s);
    const total = lineCount * fontSize(s) * LINE_H;
    if (s.k === "w") {
      const [x, y] = wedgeMid(s);
      return { x, y: y - total / 2, anchor: "middle", total };
    }
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const ta = s.ta || "center";
    const va = s.va || "middle";
    return {
      x: ta === "left" ? cx - (s.w * aw) / 2 + pad : ta === "right" ? cx + (s.w * aw) / 2 - pad : cx,
      y: va === "top" ? cy - (s.h * ah) / 2 + pad : va === "bottom" ? cy + (s.h * ah) / 2 - pad - total : cy - total / 2,
      anchor: ta === "left" ? "start" : ta === "right" ? "end" : "middle",
      total,
    };
  }

  // Where a text's anchor (x y) sits across its box
  const ALIGN = { left: 0, center: 0.5, right: 1, top: 0, middle: 0.5, bottom: 1 };

  // A text's anchor for the top-left corner (x, y) of its box
  function textAnchor(s, x, y) {
    const t = textSize(s);
    return [R(x + t.w * ALIGN[s.ta || "left"]), R(y + t.h * ALIGN[s.va || "top"])];
  }

  // Unrotated box of a shape that has one, plus its rotation
  function frame(s) {
    if (BOX.has(s.k)) return { x: s.x, y: s.y, w: s.w, h: s.h, rot: s.rot || 0 };
    if (s.k === "t") {
      const t = textSize(s);
      return { x: s.x - t.w * ALIGN[s.ta || "left"], y: s.y - t.h * ALIGN[s.va || "top"], w: t.w, h: t.h, rot: s.rot || 0 };
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
    if (s.k === "e" || s.k === "w") t = 1 / Math.hypot(lx / hw, ly / hh);
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
    // Thinning strokes swell where the pressure is full, the more the more they thin
    if (s.k === "p") return strokeW(s) * 1.3 * (1 + 0.9 * ((s.th || 0) / 100) ** 2);
    return strokeW(s);
  }

  // A wedge's outline as points, unrotated: outer arc, then inner arc or the centre
  function wedgePts(s) {
    const n = Math.max(2, Math.ceil((s.a1 - s.a0) / 6));
    const arc = (r) => Array.from({ length: n + 1 }, (_, i) => wedgePt(s, s.a0 + ((s.a1 - s.a0) * i) / n, r));
    const ir = (s.ir || 0) / 100;
    return [...arc(1), ...(ir ? arc(ir).reverse() : [wedgePt(s, 0, 0)])];
  }

  function bounds(s, model) {
    if (s.k === "w") {
      const f = frame(s);
      const c = [f.x + f.w / 2, f.y + f.h / 2];
      return ptsBounds(wedgePts(s).map((p) => rotPt(p[0], p[1], c[0], c[1], f.rot)), strokeW(s) / 2);
    }
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
    const lines = wrap(s.label, size, size * 14, s);
    const w = Math.max(...lines.map((l) => measure(l, size, s))) + size * 0.6;
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

  // Even-odd ray casting
  function inPoly(pts, p) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // A line fills once it has an area: three points or more
  const isFilled = (s) => !!s.f && s.f !== "none" && (s.k !== "l" || s.pts.length > 2);

  // 0: miss, 1: hit, 2: inside a hollow shape (picked only if nothing else is)
  function hitShape(s, p, tol, model) {
    const f = frame(s);
    if (s.k === "w") {
      const pts = wedgePts(s);
      const lp = rotPt(p[0], p[1], f.x + f.w / 2, f.y + f.h / 2, -f.rot);
      if (polyDist([...pts, pts[0]], lp) <= tol + strokeW(s) / 2) return 1;
      if (inPoly(pts, lp)) return isFilled(s) || s.label ? 1 : 2;
      return 0;
    }
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
      if (inside) return isFilled(s) || s.label ? 1 : 2;
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
    if (s.k === "l" && isFilled(s)) return polyDist([...s.pts, s.pts[0]], p) <= tol + lineWidth(s) / 2 || inPoly(s.pts, p) ? 1 : 0;
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
        let d = segDist(pts[i], pts[a], pts[b]);
        if (pts[i].length > 2) {
          // Pressure counts too: keep the points where the width changes
          const [ax, ay, ap] = pts[a];
          const [bx, by, bp] = pts[b];
          const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = l2 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * (bx - ax) + (pts[i][1] - ay) * (by - ay)) / l2)) : 0;
          d = Math.max(d, Math.abs(pts[i][2] - (ap + (bp - ap) * t)) * eps * 1.5);
        }
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

  // Pressure stroke: filled outline whose half-width follows the pen pressure.
  // With `th` (thinning, %) pressure narrows it down to almost nothing; with `tp`
  // the ends taper to a point over that length, like perfect-freehand.
  function outlineD(pts, w, { th, tp } = {}) {
    const t = (th ?? -1) / 100;
    const radius =
      t < 0
        ? (p) => (w / 2) * (0.25 + (p[2] / 9) * 1.1)
        : (p) => (w / 2) * (p[2] === undefined ? 1 : (1 + 0.9 * t * t) * (1 - t * (1 - p[2] / 9)));
    const rs = pts.map(radius);
    if (tp) {
      const at = [0];
      for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = at.at(-1);
      const ease = (x) => (x >= 1 ? 1 : x * (2 - x));
      for (let i = 0; i < rs.length; i++) rs[i] = Math.max(0.15, rs[i] * ease(at[i] / tp) * ease((total - at[i]) / tp));
    }
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
    if (s.d === "none") return null;
    if (s.d === "dash") return `${f1(w * 3)} ${f1(w * 2.5)}`;
    if (s.d === "dot") return `0 ${f1(w * 2.5)}`;
    return null;
  }

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  // Colour `a` mixed towards `b` by t (0-1)
  const mix = (a, b, t) => "#" + rgb(a).map((v, i) => Math.round(v * (1 - t) + rgb(b)[i] * t).toString(16).padStart(2, "0")).join("");
  // Outline of solid fills: a shade towards the background
  const darker = (hex) => mix(hex, BG, 0.35);

  // WCAG contrast ratio
  function contrast(a, b) {
    const lum = (hex) => {
      const [r, g, b] = rgb(hex).map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Text in a palette colour, moved towards the theme's text colour until it reads on `bg` (pale colours on light themes)
  function readable(hex, bg = BG) {
    for (let t = 0; t < 1; t += 0.1) {
      const c = mix(hex, COLORS.text, t);
      if (contrast(c, bg) >= 4.5) return c;
    }
    return COLORS.text;
  }

  function labelColor(s) {
    const color = COLORS[s.c || "text"];
    const o = (s.o ?? 100) / 100;
    if (!BOX.has(s.k) || !isFilled(s)) return readable(color);
    // The fill as drawn: semi is 20 %, and opacity fades it further
    const fill = mix(BG, color, (s.f === "semi" ? 0.2 : 1) * o);
    if (s.f === "semi") return readable(color, fill);
    // The theme's own colours where they read; mid-tone fills need pure white or black
    const best = (cs) => cs.reduce((a, b) => (contrast(b, fill) > contrast(a, fill) ? b : a));
    const own = best([BG, COLORS.text]);
    return contrast(own, fill) >= 4.5 ? own : best(["#ffffff", "#000000"]);
  }

  // `f`: the shape, for its text style and font
  function textLines(g, lines, size, x, y, anchor, color, f) {
    const st = f.st || "";
    const t = el("text", {
      x,
      "font-size": size,
      "font-family": FONTS[f.fo || "mono"].css,
      "font-weight": st.includes("b") ? "bold" : null,
      "font-style": st.includes("i") ? "italic" : null,
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
        const w = measure(line, size, f);
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
    // Opacity fades the shape; its label stays readable on top
    const body = s.o ? el("g", { opacity: s.o / 100 }, g) : g;
    // Filled shapes: a solid fill gets an outline a shade darker; d=none drops it (never on an unfilled shape)
    const noOutline = s.d === "none" && isFilled(s);
    const fill = {
      ...stroke,
      stroke: noOutline ? "none" : s.f === "solid" ? darker(color) : color,
      fill: isFilled(s) ? color : "none",
      "fill-opacity": s.f === "semi" ? 0.2 : null,
    };
    if (BOX.has(s.k)) {
      const { x, y, w, h } = s;
      const cx = x + w / 2;
      const cy = y + h / 2;
      if (s.rot) g.setAttribute("transform", `rotate(${s.rot} ${f1(cx)} ${f1(cy)})`);
      if (s.k === "r")
        el("rect", { ...fill, x, y, width: w, height: h, rx: f1(s.rx === undefined ? Math.min(8, w / 4, h / 4) : Math.min(s.rx, w / 2, h / 2)) }, body);
      else if (s.k === "e") el("ellipse", { ...fill, cx, cy, rx: w / 2, ry: h / 2 }, body);
      else if (s.k === "w") el("path", { ...fill, d: wedgeD(s), "fill-rule": "evenodd" }, body);
      else el("polygon", { ...fill, points: `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}` }, body);
      if (s.label && !hideLabel) {
        const size = fontSize(s);
        const lines = wrap(s.label, size, labelWidth(s), s);
        const lp = labelPos(s, lines.length);
        textLines(g, lines, size, f1(lp.x), lp.y, lp.anchor, labelColor(s), s);
      }
    } else if (s.k === "t") {
      if (hideLabel) return g;
      const t = textSize(s);
      const f = frame(s);
      if (s.rot) g.setAttribute("transform", `rotate(${s.rot} ${f1(f.x + t.w / 2)} ${f1(f.y + t.h / 2)})`);
      // Lines line up on the side the text is anchored to
      const ta = s.ta || "left";
      textLines(body, t.lines, t.size, f1(f.x + f.w * ALIGN[ta]), f.y, ta === "left" ? "start" : ta === "right" ? "end" : "middle", readable(color), s);
    } else if (s.k === "l") {
      el("path", { ...(isFilled(s) ? fill : stroke), d: "M" + s.pts.map(P).join("L") + (isFilled(s) ? "Z" : "") }, body);
    } else if (s.k === "a") {
      const geo = arrowGeom(s, model);
      const { p0, p1, ctrl } = geo;
      el("path", { ...stroke, d: ctrl ? `M${P(p0)}Q${P(ctrl)} ${P(p1)}` : `M${P(p0)}L${P(p1)}` }, body);
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
        if (kind === "open") el("path", { ...solid, d: `M${P(at(size, half))}L${P(tip)}L${P(at(size, -half))}` }, body);
        else if (kind === "triangle") el("path", { ...filled, d: `M${P(tip)}L${P(at(size, half))}L${P(at(size, -half))}Z` }, body);
        else if (kind === "diamond")
          el("path", { ...filled, d: `M${P(tip)}L${P(at(size * 0.7, half * 0.8))}L${P(at(size * 1.4, 0))}L${P(at(size * 0.7, -half * 0.8))}Z` }, body);
        else if (kind === "dot") el("circle", { ...filled, cx: f1(tip[0]), cy: f1(tip[1]), r: f1(Math.max(2.5, sw * 1.3)) }, body);
        else if (kind === "bar") el("path", { ...solid, d: `M${P(at(0, half * 1.2))}L${P(at(0, -half * 1.2))}` }, body);
      };
      head(s.he || "open", p1, ctrl || p0);
      head(s.hs || "none", p0, ctrl || p1);
      if (s.label && !hideLabel) {
        const b = arrowLabelBox(s, geo);
        el("rect", { x: f1(b.x), y: f1(b.y), width: f1(b.w), height: f1(b.h), rx: 4, fill: BG }, g);
        textLines(g, b.lines, b.size, f1(geo.mid[0]), b.y + b.size * 0.1, "middle", readable(color), s);
      }
    } else if (s.k === "h") {
      rotateStroke(g, s);
      el("path", { ...stroke, "stroke-dasharray": null, "stroke-width": lineWidth(s), "stroke-opacity": 0.35, d: smoothD(s.pts) }, body);
    } else if (s.pts[0].length > 2 || s.th !== undefined || s.tp) {
      rotateStroke(g, s);
      el("path", { fill: color, d: outlineD(s.pts, strokeW(s) * 1.3, s) }, body);
    } else {
      // A plain stroke goes straight through its points, so its corners stay where they were drawn
      rotateStroke(g, s);
      const d = s.pts.length === 1 ? smoothD(s.pts) : "M" + s.pts.map(P).join("L");
      el("path", { ...stroke, "stroke-dasharray": null, "stroke-width": lineWidth(s), d }, body);
    }
    return g;
  }

  // Real arcs; a whole ring is two half arcs per circle, its hole cut by evenodd
  function wedgeD(s) {
    const rx = s.w / 2;
    const ry = s.h / 2;
    const ir = (s.ir || 0) / 100;
    const sweep = s.a1 - s.a0;
    const arc = (r, from, to) => {
      const big = Math.abs(to - from) > 180 ? 1 : 0;
      const dir = to > from ? 1 : 0;
      return `A${f1(rx * r)} ${f1(ry * r)} 0 ${big} ${dir} ${P(wedgePt(s, to, r))}`;
    };
    const ring = (r) => `M${P(wedgePt(s, 0, r))}${arc(r, 0, 180)}${arc(r, 180, 360)}Z`;
    if (sweep >= 360) return ring(1) + (ir ? ring(ir) : "");
    const outer = `M${P(wedgePt(s, s.a0, 1))}${arc(1, s.a0, s.a1)}`;
    if (!ir) return outer + `L${P(wedgePt(s, 0, 0))}Z`;
    return outer + `L${P(wedgePt(s, s.a1, ir))}${arc(ir, s.a1, s.a0)}Z`;
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
    if (opts.css) el("style", {}, svg).textContent = opts.css;
    if (opts.background)
      el("rect", { x: f1(b.x - pad), y: f1(b.y - pad), width: w, height: h, fill: BG }, svg);
    for (const s of model.shapes) if (s.k !== "raw") svg.appendChild(renderShape(s, model));
    return svg;
  }

  // Text is measured with the page's fonts: have them all loaded first
  let fontsLoading = null;
  const fontsReady = () =>
    (fontsLoading ??= Promise.all(Object.values(FONTS).map((f) => document.fonts?.load(`16px "${f.family}"`))).then(
      () => measureCache.clear(),
      () => {},
    ));

  const usedFonts = (content) => new Set(parse(content).shapes.filter((s) => s.label).map((s) => s.fo || "mono"));

  // @font-face rules with the fonts (mono/sans/serif) as data URLs, so a file renders the same anywhere
  const fontUrls = {};
  async function fontFaces(fonts) {
    const css = [];
    for (const fo of fonts) {
      fontUrls[fo] ??= fetch(FONTS[fo].url)
        .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
        .then((b) => new Promise((ok, fail) => {
          const r = new FileReader();
          r.onload = () => ok(r.result);
          r.onerror = fail;
          r.readAsDataURL(b);
        }))
        // Offline and not cached: the file falls back to a system font, and the next export retries
        .catch(() => delete fontUrls[fo]);
      const url = await fontUrls[fo];
      if (typeof url === "string")
        css.push(`@font-face{font-family:"${FONTS[fo].family}";src:url(${url}) format("woff2");font-weight:100 900${FONTS[fo].adjust ? ";size-adjust:" + FONTS[fo].adjust : ""}}`);
    }
    return css.join("");
  }

  async function exportSvg(content) {
    await fontsReady();
    return renderStatic(content, { background: true, css: await fontFaces(usedFonts(content)) });
  }

  async function svgString(content) {
    return new XMLSerializer().serializeToString(await exportSvg(content));
  }

  async function pngBlob(content) {
    const svg = await exportSvg(content);
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

  // Chrome icons, 16×16 stroke paths
  const ICONS = {
    select: '<path d="M3.5 2.5l9 4.5-4 1.2-1.6 4z"/>',
    hand: '<path d="M5.5 8V3.8a1 1 0 0 1 2 0v3.7M7.5 7V2.8a1 1 0 0 1 2 0V7M9.5 7V3.8a1 1 0 0 1 2 0v5.7A4.5 4.5 0 0 1 7 14h-.3a4 4 0 0 1-3.2-1.7L2.3 9.8a1 1 0 0 1 1.5-1.2L5.5 10"/>',
    pen: '<path d="M2.5 12c2-3 3.5-7 5.5-7s1 6 3 6 2.5-3 2.5-3"/>',
    highlight: '<path d="M9.5 2.5l4 4L8 12H5V9zM3 14h5"/>',
    eraser: '<path d="M9 2.5l4.5 4.5-6.5 6.5H4.5l-2-2a1 1 0 0 1 0-1.4zM6 6l4.5 4.5M7 13.5h6.5"/>',
    rect: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/>',
    ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>',
    diamond: '<path d="M8 2l6 6-6 6-6-6z"/>',
    wedge: '<path d="M8 8V2.5A5.5 5.5 0 1 1 2.5 8z"/>',
    line: '<path d="M3 13L13 3"/>',
    arrow: '<path d="M3 13L13 3M7 3h6v6"/>',
    text: '<path d="M3.5 4.5V3h9v1.5M8 3v10M6 13h4"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    fit: '<path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/><rect x="5.5" y="5.5" width="5" height="5" rx="1"/>',
    grid: '<g fill="currentColor" stroke="none"><circle cx="4" cy="4" r="1"/><circle cx="8" cy="4" r="1"/><circle cx="12" cy="4" r="1"/><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="12" cy="12" r="1"/></g>',
    undo: '<path d="M5.5 4L2.5 7l3 3M2.5 7h7a3.5 3.5 0 0 1 0 7H7"/>',
    redo: '<path d="M10.5 4l3 3-3 3M13.5 7h-7a3.5 3.5 0 0 0 0 7H9"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
    group: '<path d="M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.5l5.5 3 5.5-3"/>',
    ungroup: '<path d="M8 1.5l5.5 3-5.5 3-5.5-3zM2.5 10.5l5.5 3 5.5-3"/>',
    chev: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2"/>',
    alert: '<path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.2"/>',
    style: '<g stroke="none"><circle cx="5" cy="5" r="2.3" style="fill:var(--red)"/><circle cx="11" cy="5" r="2.3" style="fill:var(--green)"/><circle cx="5" cy="11" r="2.3" style="fill:var(--blue)"/><circle cx="11" cy="11" r="2.3" style="fill:var(--yellow)"/></g>',
  };
  const icon = (name) => `<svg class="draw-ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  // Shortcuts are written PC-style; Macs get the symbols
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const kbd = (s) =>
    MAC ? s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧").replace(/^Del$/, "⌫") : s;
  // Dock: [id, label, key]; null separates groups
  const TOOLS = [
    ["select", "Select", "V"],
    ["hand", "Hand", "H"],
    null,
    ["pen", "Draw", "D"],
    ["highlight", "Highlighter", "Shift+D"],
    ["eraser", "Eraser", "E"],
    null,
    ["rect", "Rectangle", "R"],
    ["ellipse", "Ellipse", "O"],
    ["diamond", "Diamond", "M"],
    ["wedge", "Wedge", "W"],
    ["line", "Line", "L"],
    ["arrow", "Arrow", "A"],
    ["text", "Text", "T"],
  ];
  const TOOL_LABEL = Object.fromEntries(TOOLS.filter(Boolean).map(([id, label]) => [id, label]));
  const KIND_LABEL = { r: "Rectangle", e: "Ellipse", m: "Diamond", w: "Wedge", l: "Line", a: "Arrow", t: "Text", p: "Drawing", h: "Highlight" };
  const PINNED_TOOLS = new Set(["select", "hand"]);
  const TOOL_KEYS = { v: "select", h: "hand", d: "pen", D: "highlight", e: "eraser", r: "rect", o: "ellipse", m: "diamond", w: "wedge", l: "line", a: "arrow", t: "text" };
  const TOOL_KIND = { rect: "r", ellipse: "e", diamond: "m", wedge: "w", line: "l", arrow: "a", text: "t", pen: "p", highlight: "h" };
  const STYLE_KEY = "notepad_draw_style";
  // How the pen draws: an even line; a marker, bold with width from pressure (a stylus's,
  // or simulated from speed) that never thins to a hairline; a brush pen, all the way thin
  // with pointed ends
  const PEN_MODES = [["even", "Pen"], ["pressure", "Sharpie"], ["taper", "Brush pen"]];
  // Right-click menu: [action, label, shortcut]; null is a separator. The first four are the Arrange menu.
  const MENU = [
    ["front", "Bring to front", "Alt+Shift+↑"],
    ["forward", "Bring forward", "Alt+↑"],
    ["backward", "Send backward", "Alt+↓"],
    ["back", "Send to back", "Alt+Shift+↓"],
    null,
    ["dup", "Duplicate", "Ctrl+D"],
    ["group", "Group", "Ctrl+G"],
    ["ungroup", "Ungroup", "Ctrl+Shift+G"],
    null,
    ["del", "Delete", "Del"],
  ];
  const ZMIN = 0.1;
  const ZMAX = 8;

  const CSS = `
.draw-host svg.draw-svg{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;user-select:none;-webkit-user-select:none}
.draw-ui{font:var(--n-body);color:var(--n-text)}
.draw-ui button{-webkit-tap-highlight-color:transparent;font:inherit;color:var(--n-text-2);background:none;border:0;margin:0;padding:0;cursor:pointer;border-radius:var(--n-r-md);display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:none}
.draw-ui button:hover{color:var(--n-text);background:var(--n-hover)}
.draw-ui button:focus-visible{outline:2px solid var(--n-accent);outline-offset:1px}
.draw-ic{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.draw-panel{position:absolute;background:var(--n-raised);box-shadow:var(--n-shadow-1);border-radius:var(--n-r-lg)}
.draw-sep{width:1px;height:20px;margin:0 4px;flex:none;background:var(--n-line-strong)}
.draw-tools{left:50%;bottom:14px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:4px;border-radius:calc(var(--n-r-md) + 4px);max-width:calc(100% - 16px);overflow-x:auto;scrollbar-width:none}
.draw-ui .draw-tools button{width:32px;height:32px}
.draw-ui .draw-tools button.active,.draw-ui .draw-toolgrid button.active{background:var(--n-accent);color:var(--n-on-accent)}
.draw-ui .draw-tools .draw-tool-more,.draw-ui .draw-tools .draw-undo,.draw-toolgrid{display:none}
@media (pointer:coarse){.draw-ui .draw-tools .draw-undo{display:flex}}
.draw-zoom{left:14px;bottom:14px;display:flex;align-items:center;gap:1px;padding:3px;border-radius:calc(var(--n-r-md) + 3px);box-shadow:var(--n-shadow-0)}
.draw-ui .draw-zoom button{width:24px;height:24px;border-radius:var(--n-r-md)}
.draw-ui .draw-zoom .draw-pct{width:auto;min-width:46px;font:var(--n-label);font-feature-settings:"tnum"}
.draw-zoom .draw-ic{width:14px;height:14px}
.draw-zoom .draw-sep{height:16px;margin:0 3px}
.draw-ui .draw-zoom button.active{background:var(--n-pressed);color:var(--n-text)}
.draw-style{top:14px;right:14px;width:216px;display:none;flex-direction:column;gap:12px;padding:10px 12px 12px;border-radius:var(--n-r-xl);max-height:calc(100% - 90px);overflow:auto;box-sizing:border-box}
.draw-style.visible{display:flex}
.draw-style-head{display:flex;align-items:center;justify-content:space-between;margin-right:-4px;font:var(--n-title);color:var(--n-text)}
.draw-ui .draw-style-head button{width:22px;height:22px}
.draw-style h5{margin:0 0 6px;font:var(--n-label);color:var(--n-text-3)}
.draw-swatches{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;justify-items:center}
.draw-ui .draw-swatches button{width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 1px rgb(0 0 0/15%)}
.draw-ui .draw-swatches button.active{box-shadow:0 0 0 2px var(--n-raised),0 0 0 3.5px var(--n-accent)}
.draw-seg{display:flex;gap:2px;padding:2px;border-radius:var(--n-r-md);background:var(--n-field);box-shadow:inset 0 0 0 1px var(--n-line)}
.draw-seg+.draw-seg{margin-top:6px}
.draw-ui .draw-seg button{flex:1;min-width:0;height:22px;border-radius:var(--n-r-sm);font:var(--n-body-strong)}
.draw-ui .draw-seg button:hover{background:none}
.draw-ui .draw-seg button:disabled{opacity:.35;cursor:default}
.draw-status{position:absolute;top:14px;left:50%;transform:translateX(-50%);max-width:calc(100% - 28px);padding:5px 10px;border-radius:var(--n-r-lg);background:var(--n-raised);color:var(--n-text-2);box-shadow:0 0 0 1px var(--n-line);font:var(--n-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;display:none}
.draw-status.visible{display:block}
.draw-ui .draw-seg button.active{background:var(--n-raised);color:var(--n-text);box-shadow:0 0 0 1px var(--n-line-strong),0 1px 2px rgb(0 0 0/15%)}
.draw-seg svg{width:24px;height:12px}
.draw-actions{display:flex;align-items:center;gap:2px;padding-top:10px;border-top:1px solid var(--n-line)}
.draw-ui .draw-actions button{height:22px;min-width:22px;font:var(--n-label)}
.draw-ui .draw-actions .draw-arrange-btn{padding:0 4px 0 7px}
.draw-actions .draw-ic{width:14px;height:14px}
.draw-ui .draw-actions .draw-del{margin-left:auto;color:var(--n-danger)}
.draw-ui .draw-style-open{top:14px;right:14px;width:32px;height:32px;display:none;border-radius:var(--n-r-lg)}
.draw-ui .draw-style-open.visible{display:flex}
.draw-pop{display:none;flex-direction:column;min-width:200px;padding:4px;z-index:6}
.draw-pop.visible{display:flex}
.draw-ui .draw-pop button{justify-content:space-between;gap:16px;height:26px;padding:0 8px;color:var(--n-text);white-space:nowrap}
.draw-ui .draw-pop button:hover,.draw-ui .draw-pop button:focus-visible{background:var(--n-accent);color:var(--n-on-accent);outline:none}
.draw-ui .draw-pop .draw-danger{color:var(--n-danger)}
.draw-ui .draw-pop .draw-danger:hover,.draw-ui .draw-pop .draw-danger:focus-visible{background:var(--n-danger);color:var(--n-on-accent)}
.draw-ui .draw-pop button:disabled{opacity:.4;pointer-events:none}
.draw-pop kbd{font:var(--n-caption);font-feature-settings:"tnum";color:var(--n-text-3)}
.draw-pop button:hover kbd,.draw-pop button:focus-visible kbd{color:inherit}
.draw-pop hr{border:0;height:1px;margin:4px 8px;background:var(--n-line)}
.draw-ui .draw-badge{position:absolute;top:14px;left:14px;max-width:calc(100% - 28px);height:30px;padding:0 10px;gap:8px;display:none;border-radius:var(--n-r-lg);background:var(--n-warning-soft);color:var(--n-warning);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--n-warning) 35%,transparent);font:var(--n-body-strong)}
.draw-ui .draw-badge.visible{display:inline-flex}
.draw-ui .draw-badge:hover{color:var(--n-warning);background:color-mix(in srgb,var(--n-warning) 22%,transparent)}
.draw-badge span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.draw-hint{position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:none;color:var(--n-text-3);text-align:center;padding:0 24px}
.draw-hint.visible{display:flex}
.draw-hint>div{display:grid;gap:12px;justify-items:center}
.draw-hint p{margin:0}
.draw-keys{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 16px;font:var(--n-caption)}
.draw-keys kbd{font:var(--n-caption);padding:1px 5px;margin-right:6px;border-radius:var(--n-r-sm);box-shadow:inset 0 0 0 1px var(--n-line-strong)}
.draw-hint .coarse{display:none}
@media (pointer:coarse){.draw-hint .fine{display:none}.draw-hint .coarse{display:block}}
.draw-text{position:absolute;display:none;background:transparent;border:none;outline:none;resize:none;overflow:hidden;padding:0;margin:0;font-family:${FONTS.mono.css};line-height:${LINE_H};transform-origin:center;white-space:pre;caret-color:var(--blue)}
.draw-text.wrap{white-space:pre-wrap;text-align:center;word-break:break-word}
.draw-readonly .draw-tools,.draw-readonly .draw-style,.draw-readonly .draw-edit{display:none!important}
/* Phones: a bottom sheet with finger-sized targets */
@container (min-width:601px) and (max-width:880px){.draw-zoom{bottom:auto;top:14px}.draw-ui .draw-badge{top:56px}}
@container (max-width:600px){
.draw-ui .draw-tools .draw-tool-extra:not(.active){display:none}
.draw-ui .draw-tools .draw-tool-more,.draw-ui .draw-tools .draw-undo{display:flex}
.draw-ui .draw-tools button{width:44px;height:44px}
.draw-tools .draw-ic{width:20px;height:20px}
.draw-zoom{bottom:auto;top:8px;left:8px}
.draw-ui .draw-zoom button{width:36px;height:36px}
.draw-ui .draw-badge{top:56px;left:8px;max-width:calc(100% - 16px)}
.draw-ui .draw-style-open{top:8px;right:8px;width:42px;height:42px}
.draw-toolgrid.visible{display:grid;grid-template-columns:repeat(3,76px);gap:6px;padding:8px;left:50%;transform:translateX(-50%);bottom:76px;border-radius:var(--n-r-xl);z-index:6}
.draw-ui .draw-toolgrid button{height:68px;flex-direction:column;gap:6px;font:var(--n-label)}
.draw-toolgrid .draw-ic{width:22px;height:22px}
.draw-style{top:auto;bottom:76px;left:8px;right:8px;width:auto;max-height:50%;padding:10px 14px 14px;gap:14px}
.draw-style-head{font-size:15px;margin-right:-10px}
.draw-ui .draw-style-head button{width:40px;height:40px}
.draw-style h5{font-size:12px}
.draw-swatches{gap:8px}
.draw-ui .draw-swatches button{width:32px;height:32px}
.draw-ui .draw-seg button{height:40px;font-size:14px}
.draw-seg svg{width:32px;height:16px}
.draw-ui .draw-actions button{height:40px;min-width:40px;font-size:14px}
.draw-actions .draw-ic{width:18px;height:18px}
.draw-ui .draw-pop button{height:40px;font-size:14px}
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
    // Line tool placing points by clicks: { id } of the line being built
    path: null,
    touch: false,
  };

  function loadStyle() {
    const style = { c: "text", s: "m", f: "none", d: "solid", hs: "none", he: "open", ta: "center", va: "middle", st: "", fo: "mono", o: 100, rx: "round" };
    try {
      const saved = JSON.parse(localStorage.getItem(STYLE_KEY) || "{}");
      for (const k in style) if (ENUMS[k]?.includes(saved[k])) style[k] = saved[k];
      if (/^[biu]{0,3}$/.test(saved.st)) style.st = textStyle(saved.st);
      if (Number.isInteger(saved.o) && saved.o >= 1 && saved.o <= 100) style.o = saved.o;
      if (saved.rx === "square") style.rx = "square";
      if (PEN_MODES.some(([m]) => m === saved.pen)) style.pen = saved.pen;
      if (style.f === "none" && style.d === "none") style.d = "solid";
    } catch {}
    return style;
  }

  function saveStyle() {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(E.style));
    } catch {}
  }

  // Style panel icons (28×14) for the pen modes: the bare pen keeps sharp corners, the
  // marker is short and bold, the brush swells and ends in points (drawn by the brush itself)
  function penIcon(mode) {
    const line = 'fill="none" stroke="currentColor"';
    if (mode === "even") return `<path d="M4 10L9.5 4L15 10L20.5 4L24 8" ${line} stroke-width="1.3" stroke-linejoin="miter"/>`;
    if (mode === "pressure") return `<path d="M6.5 9C10 5 14.5 5.5 17 7.5S20.5 7 21.5 5.5" ${line} stroke-width="3.8" stroke-linecap="round"/>`;
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      // Slow through the belly of the swoosh, quick out of it
      pts.push([3.5 + t * 21, 10 - Math.sin(t * Math.PI * 0.9) * 5 + t * 1.5, 9 - Math.round(8 * Math.max(0, t - 0.45) / 0.55)]);
    }
    return `<path d="${outlineD(pts, 2.6, { th: 95, tp: 8 })}" fill="currentColor"/>`;
  }

  // Style panel icons (28×14): a line style
  function dashIcon(d) {
    const a = { solid: "", dash: 'stroke-dasharray="4.5 3.5"', dot: 'stroke-dasharray="0 4" stroke-width="2.2"' }[d];
    return `<path d="M3 7H25" stroke="currentColor" stroke-width="1.5" stroke-linecap="${d === "dash" ? "butt" : "round"}" ${a}/>`;
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
    E.gridRect = el("rect", { class: "draw-grid", width: "100%", height: "100%", fill: "url(#drawGridPattern)" }, svg);
    E.world = el("g", {}, svg);
    E.shapesG = el("g", {}, E.world);
    E.overlay = el("g", {}, svg);
    E.svg = svg;

    const ui = h("div", "draw-ui", host);
    E.ui = ui;
    E.hint = h("div", "draw-hint", ui);
    E.hint.innerHTML =
      '<div class="fine"><div class="draw-keys">' +
      [["D", "Draw"], ["R", "Rectangle"], ["A", "Arrow"], ["T", "Text"]].map(([k, l]) => `<span><kbd>${k}</kbd>${l}</span>`).join("") +
      '</div><p>Double-click to write anywhere</p></div><p class="coarse">Pick a tool below and start drawing</p>';
    E.badge = h("button", "draw-badge", ui);
    E.badge.dataset.draw = "source";
    E.badge.innerHTML = icon("alert");
    E.badgeText = h("span", "", E.badge);
    E.status = h("div", "draw-status", ui);

    // Hover label and shortcut come from the app's tooltip
    const tip = (b, label, key) => {
      b.dataset.tip = label;
      if (key) b.dataset.key = kbd(key);
      b.setAttribute("aria-label", label);
      return b;
    };
    const btn = (parent, draw, label, key, cls, ic = draw.split(":")[1]) => {
      const b = tip(h("button", cls || "", parent), label, key);
      b.dataset.draw = draw;
      b.innerHTML = icon(ic);
      return b;
    };

    E.toolsEl = h("div", "draw-panel draw-tools", ui);
    E.toolBtns = {};
    for (const t of TOOLS) {
      if (!t) {
        // Phones keep select and hand; the second group break goes
        h("span", E.toolsEl.querySelector(".draw-sep") ? "draw-sep draw-tool-extra" : "draw-sep", E.toolsEl);
        continue;
      }
      const [id, label, key] = t;
      E.toolBtns[id] = btn(E.toolsEl, "tool:" + id, label, key, PINNED_TOOLS.has(id) ? "" : "draw-tool-extra", id);
    }
    // Phones: select, hand and the active tool stay, + opens the rest as a 3×3 grid
    E.moreBtn = btn(E.toolsEl, "nav:tools", "More tools", "", "draw-tool-more", "plus");
    h("span", "draw-sep draw-undo", E.toolsEl);
    btn(E.toolsEl, "nav:undo", "Undo", "Ctrl+Z", "draw-undo");
    btn(E.toolsEl, "nav:redo", "Redo", "Ctrl+Shift+Z", "draw-undo");
    E.toolGrid = h("div", "draw-panel draw-toolgrid", ui);
    for (const t of TOOLS) {
      if (!t || PINNED_TOOLS.has(t[0])) continue;
      const b = btn(E.toolGrid, "tool:" + t[0], t[1], "", "", t[0]);
      h("span", "", b, t[1]);
    }

    E.styleEl = h("div", "draw-panel draw-style", ui);
    const head = h("div", "draw-style-head", E.styleEl);
    E.styleTitle = h("span", "", head);
    btn(head, "nav:closestyle", "Close", "", "", "x").setAttribute("aria-label", "Close style panel");
    E.rows = [];
    const row = (label, keys) => {
      const r = h("div", "", E.styleEl);
      h("h5", "", r, label);
      E.rows.push([r, keys]);
      return r;
    };
    E.swatches = h("div", "draw-swatches", row("Colour", ["c"]));
    for (const c of ENUMS.c) {
      const b = tip(h("button", "", E.swatches), c[0].toUpperCase() + c.slice(1));
      b.dataset.draw = "style:c:" + c;
      b.style.background = `var(--draw-${c}, var(--${COLOR_VARS[c]}))`;
    }
    // items: [value, label (text or svg), tooltip, shortcut]
    const seg = (parent, key, items) => {
      const s = h("div", "draw-seg", parent);
      s.dataset.key = key;
      for (const [v, label, title, keys] of items) {
        const svg = label.startsWith("<");
        const b = h("button", "", s, svg ? null : label);
        if (svg) b.innerHTML = `<svg viewBox="0 0 28 14">${label}</svg>`;
        if (title) tip(b, title, keys);
        b.dataset.draw = `style:${key}:${v}`;
      }
      return s;
    };
    const words = (vals, labels) => vals.map((v, i) => [v, labels[i]]);
    const HEAD_NAMES = { none: "None", open: "Arrow", triangle: "Triangle", dot: "Dot", diamond: "Diamond", bar: "Bar" };
    let textRow;
    E.segs = {
      s: seg(row("Stroke", ["s"]), "s", [["xs", "XS", "Extra small"], ["s", "S", "Small"], ["m", "M", "Medium"], ["l", "L", "Large"], ["xl", "XL", "Extra large"]]),
      f: seg(row("Fill", ["f"]), "f", words(ENUMS.f, ["None", "Semi", "Solid"])),
      d: seg(row("Line", ["d"]), "d", [
        ["solid", dashIcon("solid"), "Solid"],
        ["dash", dashIcon("dash"), "Dashed"],
        ["dot", dashIcon("dot"), "Dotted"],
        ["none", "None", "No outline"],
      ]),
      rx: seg(row("Corners", ["rx"]), "rx", [["round", "Round"], ["square", "Square"]]),
      o: seg(row("Opacity", ["o"]), "o", [20, 40, 60, 80, 100].map((v) => [v, String(v), v + " %"])),
      pen: seg(row("Pen", ["pen"]), "pen", PEN_MODES.map(([m, label]) => [m, penIcon(m), label])),
      hs: seg(row("Start", ["hs"]), "hs", HEADS.map((k) => [k, headIcon(k, true), HEAD_NAMES[k]])),
      he: seg(row("End", ["he"]), "he", HEADS.map((k) => [k, headIcon(k, false), HEAD_NAMES[k]])),
      ta: seg((textRow = row("Text", ["ta", "va"])), "ta", words(ENUMS.ta, ["Left", "Centre", "Right"])),
      va: seg(textRow, "va", words(ENUMS.va, ["Top", "Middle", "Bottom"])),
      fo: seg(row("Font", ["fo"]), "fo", words(ENUMS.fo, ["Mono", "Sans", "Serif"])),
      st: seg(row("Style", ["st"]), "st", [
        ["b", "B", "Bold", "Ctrl+B"],
        ["i", "I", "Italic", "Ctrl+I"],
        ["u", "U", "Underline", "Ctrl+U"],
      ]),
    };
    for (const b of E.segs.fo.children) b.style.fontFamily = FONTS[b.dataset.draw.split(":")[2]].css;
    const [bold, italic, underline] = E.segs.st.children;
    bold.style.fontWeight = "bold";
    italic.style.fontStyle = "italic";
    underline.style.textDecoration = "underline";
    E.actionsEl = h("div", "draw-actions", E.styleEl);
    btn(E.actionsEl, "act:dup", "Duplicate", "Ctrl+D", "", "copy");
    btn(E.actionsEl, "act:group", "Group", "Ctrl+G", "", "group");
    btn(E.actionsEl, "act:ungroup", "Ungroup", "Ctrl+Shift+G", "", "ungroup");
    const arrange = btn(E.actionsEl, "nav:arrange", "Arrange", "", "draw-arrange-btn", "chev");
    arrange.prepend("Arrange");
    arrange.setAttribute("aria-haspopup", "menu");
    delete arrange.dataset.tip;
    btn(E.actionsEl, "act:del", "Delete", "Del", "draw-del", "trash");

    const menu = (cls, items) => {
      const m = h("div", "draw-panel draw-pop " + cls, ui);
      m.setAttribute("role", "menu");
      for (const item of items) {
        if (!item) {
          h("hr", "", m);
          continue;
        }
        const [act, label, keys] = item;
        const b = h("button", act === "del" ? "draw-danger" : "", m);
        b.dataset.draw = "act:" + act;
        b.setAttribute("role", "menuitem");
        h("span", "", b, label);
        h("kbd", "", b, kbd(keys));
      }
      return m;
    };
    E.menu = menu("draw-menu", MENU);
    E.arrange = menu("draw-arrange", MENU.slice(0, 4));

    E.styleOpenBtn = btn(ui, "nav:openstyle", "Show style panel", "", "draw-panel draw-edit draw-style-open", "style");
    const zoom = h("div", "draw-panel draw-zoom", ui);
    btn(zoom, "nav:out", "Zoom out", "", "", "minus");
    E.zoomBtn = tip(h("button", "draw-pct", zoom, "100%"), "Zoom to 100%", "Shift+0");
    E.zoomBtn.dataset.draw = "nav:reset";
    btn(zoom, "nav:in", "Zoom in", "", "", "plus");
    btn(zoom, "nav:fit", "Fit", "Shift+1", "", "fit");
    h("span", "draw-sep draw-edit", zoom);
    E.gridBtn = btn(zoom, "nav:grid", "Grid", "Ctrl+'", "draw-edit");

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
    E.ta.addEventListener("input", liveText);
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
    fontsReady().then(() => {
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
    if (!view || lost()) fit(true);
    applyCamera();
    renderAll();
    if (!opts.noFocus) host.focus({ preventScroll: true });
  }

  function unmount() {
    if (!E.mounted) return;
    closeMenu();
    finishTextEdit();
    if (E.op) cancelOp();
    finishPath();
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
    E.path = null;
    load(content);
    // Replaced content (another tab, a shared link) may lie outside the old view
    if (lost()) fit(true);
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

  // Nothing of the drawing is in view
  function lost() {
    const b = contentBounds(E.model);
    if (!b) return false;
    const [vw, vh] = viewSize();
    const c = E.cam;
    return b.x > c.x + vw / c.z || b.x + b.w < c.x || b.y > c.y + vh / c.z || b.y + b.h < c.y;
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
    const resizable = sel.length > 1;
    if (r && sel.length === r.shapes.size && sel.every((s) => r.shapes.has(s))) return { ...r.f, resizable };
    return { ...unionBounds(sel.map((s) => bounds(s, E.model))), rot: 0, resizable };
  }

  // Lines and free arrows have no rotation of their own but turn as a whole
  const turnable = (s) => s.k === "l" || (s.k === "a" && typeof s.from !== "string" && typeof s.to !== "string");

  function keepSelRot(f) {
    E.selRot = f && { shapes: new Set(selected()), f };
  }

  function polygon(pts, attrs) {
    return el("polygon", { points: pts.map((p) => P(toScreen(p))).join(" "), fill: "none", stroke: ACCENT, ...attrs }, E.overlay);
  }

  function outlineOf(s, attrs, rot = 0) {
    const f = frame(s);
    if (f) return polygon(corners(f), attrs);
    if (!rot) return polygon(corners({ ...bounds(s, E.model), rot: 0 }), attrs);
    // Box lines and arrows along the turned selection
    const pts = (s.k === "a" ? arrowPts(arrowGeom(s, E.model)) : s.pts).map((p) => rotPt(p[0], p[1], 0, 0, -rot));
    const b = ptsBounds(pts, s.k === "a" ? strokeW(s) * 3 : lineWidth(s) / 2);
    return polygon(corners({ ...b, rot: 0 }).map((p) => rotPt(p[0], p[1], 0, 0, rot)), attrs);
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
    if (E.path) {
      // Where clicking closes the shape
      const s = E.model.byId.get(E.path.id);
      if (s && s.pts.length > 3) {
        const [x, y] = toScreen(s.pts[0]);
        el("circle", { cx: f1(x), cy: f1(y), r: E.touch ? 8 : 6, fill: BG, stroke: ACCENT, "stroke-width": 2 }, E.overlay);
      }
      return;
    }
    if (E.readonly || (op && !["move", "resize", "rotate", "marquee", "point", "bend", "wedge"].includes(op.type))) return;
    const sel = selected();
    if (!sel.length) return;
    const f = selFrame(sel);
    if (sel.length > 1) for (const s of sel) outlineOf(s, { "stroke-width": 1, "stroke-opacity": 0.5 }, f.rot);
    const one = sel.length === 1 ? sel[0] : null;
    if (one && (one.k === "l" || one.k === "a")) {
      if (one.k === "l") {
        polygon(one.pts, { "stroke-width": 1, "stroke-opacity": 0 });
        // A closed shape's last point is its first
        const n = closedPath(one) ? one.pts.length - 1 : one.pts.length;
        one.pts.slice(0, n).forEach((p, i) => handle("point", p, { idx: i }, true));
      } else {
        const g = arrowGeom(one, E.model);
        handle("point", g.p0, { idx: 0 }, true);
        handle("point", g.p1, { idx: 1 }, true);
        handle("bend", g.mid, {}, true);
      }
      if (!turnable(one)) return;
    }
    polygon(corners(f), { "stroke-width": 1, "stroke-opacity": one && !frame(one) ? 0.5 : 1 });
    if (one?.k === "w") wedgeHandles(one);
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

  // What the panel offers for a shape, or for the tool's next one: label settings once there is
  // a label, free text only aligns horizontally (vertically it would only move its anchor), and
  // a two-point line has nothing to fill
  const LABEL_KEYS = ["ta", "va", "fo", "st"];
  function panelAttrs(s) {
    let a = ATTRS[s.k];
    if (s.k === "t") a = a.filter((k) => k !== "va");
    else if (!s.label) a = a.filter((k) => !LABEL_KEYS.includes(k));
    if (s.k === "l" && s.pts && s.pts.length < 3) a = a.filter((k) => k !== "f");
    return a;
  }

  // A shape's value as the panel shows it
  function styleValue(s, key) {
    if (key === "o") return s.o ?? 100;
    if (key === "rx") return s.rx === undefined ? "round" : s.rx === 0 ? "square" : null;
    return s[key] ?? defaultOf(s, key);
  }

  // The change a panel value makes to a shape
  function stylePatch(s, key, v) {
    if (key === "o") return { o: v === 100 ? undefined : v };
    if (key === "s" && s.k === "p" && s.th !== undefined) return { s: v, ...penLook(penOf(s), v) };
    if (key === "rx") return { rx: v === "square" ? 0 : undefined };
    // Free text keeps its place: the anchor moves to the new side of the same box
    if (key === "ta" && s.k === "t") {
      const f = frame(s);
      return { ta: v, x: R(f.x + f.w * ALIGN[v]) };
    }
    return { [key]: v };
  }

  // Values shared by the selection (or the tool), per style key
  function styleState() {
    const sel = selected();
    const items = sel.length ? sel : TOOL_KIND[E.tool] ? [{ k: TOOL_KIND[E.tool] }] : [];
    const out = {};
    for (const key of ["c", "s", "f", "d", "rx", "o", "ta", "va", "fo", "st", "hs", "he"]) {
      const has = items.filter((s) => panelAttrs(s).includes(key));
      if (!has.length) continue;
      if (!sel.length) {
        out[key] = E.style[key];
        continue;
      }
      if (key === "st") {
        const texts = sel.filter((s) => ATTRS[s.k].includes("st"));
        out.st = ["b", "i", "u"].filter((f) => texts.every((s) => (s.st || "").includes(f))).join("");
        continue;
      }
      const vals = new Set(has.map((s) => styleValue(s, key)));
      out[key] = vals.size === 1 ? [...vals][0] : null;
    }
    if (!sel.length && E.tool === "pen") out.pen = penMode();
    else if (sel.length && sel.every((s) => s.k === "p")) {
      const modes = new Set(sel.map(penOf));
      out.pen = modes.size === 1 ? [...modes][0] : null;
    }
    // No outline only where everything selected can be filled
    const fillable = items.length > 0 && items.every((s) => panelAttrs(s).includes("f"));
    return { out, sel, fillable };
  }

  function renderUI() {
    if (!E.mounted) return;
    for (const [id, b] of Object.entries(E.toolBtns)) b.classList.toggle("active", id === E.tool);
    for (const b of E.toolGrid.children) b.classList.toggle("active", b.dataset.draw === "tool:" + E.tool);
    const { out, sel, fillable } = styleState();
    const wanted = !E.readonly && Object.keys(out).length > 0;
    const show = wanted && !E.styleClosed;
    E.styleEl.classList.toggle("visible", show);
    E.styleOpenBtn.classList.toggle("visible", wanted && !!E.styleClosed);
    if (!show || !sel.length) E.arrange.classList.remove("visible");
    if (show) {
      E.styleTitle.textContent =
        sel.length > 1 ? `${sel.length} shapes` : sel.length ? KIND_LABEL[sel[0].k] : TOOL_LABEL[E.tool];
      for (const [row, keys] of E.rows) row.style.display = keys.some((k) => k in out) ? "" : "none";
      for (const b of E.swatches.children) b.classList.toggle("active", b.dataset.draw === "style:c:" + out.c);
      for (const [key, row] of Object.entries(E.segs)) {
        row.style.display = key in out ? "" : "none";
        for (const b of row.children)
          b.classList.toggle(
            "active",
            key === "st" ? (out.st || "").includes(b.dataset.draw.slice(-1)) : b.dataset.draw === `style:${key}:${out[key]}`,
          );
      }
      // No outline: only for fillable shapes, and never together with no fill
      const noLine = E.segs.d.querySelector('[data-draw="style:d:none"]');
      noLine.style.display = fillable ? "" : "none";
      noLine.disabled = out.f === "none";
      E.segs.f.querySelector('[data-draw="style:f:none"]').disabled = out.d === "none";
      E.actionsEl.style.display = sel.length ? "" : "none";
      const grouped = sel.some((s) => s.gr);
      const groupBtn = E.actionsEl.querySelector('[data-draw="act:group"]');
      groupBtn.style.display = sel.length > 1 && !(grouped && new Set(sel.map((s) => s.gr)).size === 1) ? "" : "none";
      E.actionsEl.querySelector('[data-draw="act:ungroup"]').style.display = grouped ? "" : "none";
    }
    const tip = statusText(sel);
    E.status.textContent = tip;
    E.status.classList.toggle("visible", !!tip);
    E.gridBtn.classList.toggle("active", E.model.grid);
    const empty = !E.model.shapes.some((s) => s.k !== "raw");
    E.hint.classList.toggle("visible", empty && !E.readonly && !E.op);
    const errs = E.model.errors;
    E.badge.classList.toggle("visible", errs.length > 0);
    E.badge.dataset.tip = errs.map((e) => `Line ${e.line}: ${e.msg}`).slice(0, 10).join("\n");
    if (errs.length)
      E.badgeText.textContent = E.model.locked
        ? "Read-only · " + errs[errs.length - 1].msg
        : `${errs.length} line${errs.length > 1 ? "s" : ""} can't be drawn · Open source`;
    updateCursor();
  }

  // How to use what's at hand, for the gestures nothing else shows
  function statusText(sel) {
    if (E.readonly || E.editing) return "";
    const [click, dbl] = E.touch ? ["Tap", "Double-tap"] : ["Click", "Double-click"];
    if (E.path) return `${click} to add points · ${click.toLowerCase()} the first point to close · ${E.touch ? "double-tap" : "Enter"} to finish`;
    if (E.tool === "line") return `Drag for a straight line, or ${click.toLowerCase()} to place points`;
    const one = sel.length === 1 && E.tool === "select" ? sel[0] : null;
    if (one?.k === "l") return `${dbl} the line to add a point, a point to remove it`;
    if (one?.k === "w") return "Drag the round handles to resize the slice or open a hole";
    return "";
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
    finishPath();
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
    if (key === "pen") return setPen(v);
    if (key === "o") v = Number(v);
    E.style[key] = v;
    // A shape always keeps a fill or an outline
    if (key === "f" && v === "none" && E.style.d === "none") E.style.d = "solid";
    saveStyle();
    let changed = false;
    for (const s of selected()) {
      if (!panelAttrs(s).includes(key) || styleValue(s, key) === v) continue;
      const n = { ...s, ...stylePatch(s, key, v) };
      if (key === "d" && v === "none" && !isFilled(n)) continue;
      if (key === "f" && !isFilled(n) && n.d === "none") delete n.d;
      replaceShape(n);
      changed = true;
    }
    const path = E.path && E.model.byId.get(E.path.id);
    if (path && key !== "f" && panelAttrs(path).includes(key)) {
      replaceShape({ ...path, ...stylePatch(path, key, key === "d" && v === "none" ? undefined : v) });
      changed = true;
    }
    if (changed) {
      renderShapes();
      renderOverlay();
      commit();
    }
    renderUI();
  }

  function setPen(mode) {
    E.style.pen = mode;
    saveStyle();
    const strokes = selected().filter((s) => s.k === "p" && penOf(s) !== mode);
    for (const s of strokes) replaceShape({ ...s, ...penPatch(s, mode) });
    if (strokes.length) {
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
    if (b !== E.moreBtn && a !== "arrange") closeMenu();
    if (kind === "tool") setTool(a);
    else if (kind === "style") setStyle(a, v);
    else if (kind === "source") E.opts.onSource?.(E.model.errors[0]?.line || 1);
    else if (kind === "act")
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
    else if (kind === "nav")
      ({
        in: () => zoomBy(1.25),
        out: () => zoomBy(0.8),
        reset: () => zoomBy(1 / E.cam.z),
        fit: () => fit(),
        grid: toggleGrid,
        tools: () => E.toolGrid.classList.toggle("visible"),
        arrange: () => openArrange(b),
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
      if (s.k === "t") [n.x, n.y] = textAnchor(s, n.x, n.y);
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
    E.arrange?.classList.remove("visible");
    E.toolGrid?.classList.remove("visible");
  }

  // Below the Arrange button, or above it when there's no room (phone sheet)
  function openArrange(btn) {
    const m = E.arrange;
    if (m.classList.contains("visible")) return closeMenu();
    m.classList.add("visible");
    const r = btn.getBoundingClientRect();
    const host = E.host.getBoundingClientRect();
    const [vw, vh] = viewSize();
    let top = r.bottom - host.top + 4;
    if (top + m.offsetHeight > vh - 4) top = r.top - host.top - m.offsetHeight - 4;
    m.style.left = Math.max(4, Math.min(r.left - host.left, vw - m.offsetWidth - 4)) + "px";
    m.style.top = Math.max(4, top) + "px";
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
    if (E.path) return pathClick(e, sp, w, dbl);

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
      const real = e.pointerType === "pen";
      const mode = tool === "pen" ? penMode() : real ? "pressure" : "even";
      const pressure = mode !== "even";
      // A brush touches down at half pressure; a marker pools a little ink first
      const op = { type: "pen", raw: [], pressure, real, mode, highlight: tool === "highlight", sim: mode === "pressure" ? 1 : 0.5, before: E.model.shapes.slice() };
      const p = pressure ? [...w, inkPressure(op, real ? pressureOf(e) : 1 + op.sim * 8)] : w;
      op.raw.push(p);
      const s = { k: TOOL_KIND[tool], id: newId(), pts: [p], c: E.style.c, s: E.style.s, o: opacity() };
      if (tool === "pen") Object.assign(s, penLook(mode, E.style.s));
      startOp({ ...op, id: s.id });
      addShape(s);
      renderShapes();
      return;
    }
    const start = snapPt(w);
    if (tool === "line" || tool === "arrow") {
      const id = newId();
      const s =
        tool === "line"
          ? { k: "l", id, pts: [start, start], c: E.style.c, s: E.style.s, d: lineDash(), o: opacity() }
          : { k: "a", id, from: bindAt(w, id) || start, to: start, c: E.style.c, s: E.style.s, d: lineDash(), hs: E.style.hs, he: E.style.he, st: E.style.st || undefined, fo: E.style.fo, o: opacity() };
      startOp({ type: "line", id, start: sp, before: E.model.shapes.slice() });
      addShape(s);
      renderShapes();
      return;
    }
    const k = TOOL_KIND[tool];
    const s = { k, id: newId(), x: R(start[0]), y: R(start[1]), w: 1, h: 1, c: E.style.c, s: E.style.s, f: E.style.f, d: E.style.d, ta: E.style.ta, va: E.style.va, st: E.style.st || undefined, fo: E.style.fo, o: opacity() };
    if (k === "r" && E.style.rx === "square") s.rx = 0;
    // A wedge starts as a pie with a quarter out, so it reads as one
    if (k === "w") Object.assign(s, { a0: 0, a1: 270 });
    startOp({ type: "box", id: s.id, origin: start, start: sp, before: E.model.shapes.slice() });
    addShape(s);
    renderShapes();
  }

  const opacity = () => (E.style.o === 100 ? undefined : E.style.o);
  // Until one is picked: pressure for a stylus, even for mouse and touch
  const penMode = () => E.style.pen || (E.sawPen ? "pressure" : "even");

  // Without a stylus, faster is thinner: pressure eases towards what the speed
  // suggests, like perfect-freehand. `d`: screen pixels moved since the last point
  function simulatePressure(op, d) {
    // A brush answers sooner than a marker
    op.sim += (1 - Math.min(1, d / (op.mode === "taper" ? 12 : 14)) - op.sim) * 0.3;
    return Math.max(1, Math.min(9, Math.round(1 + op.sim * 8)));
  }

  // A marker never runs dry: its pressure stays in the upper two thirds, so it's bold and never a hairline
  const inkPressure = (op, p) => Math.round(op.mode === "pressure" ? 3 + ((p - 1) * 3) / 4 : p);

  // How far a pen mode goes grows with the stroke size: subtle at XS, extreme at XL
  const THIN = { xs: 25, s: 45, m: 65, l: 80, xl: 92 };
  const BRUSH_THIN = { xs: 50, s: 70, m: 85, l: 93, xl: 98 };
  const penLook = (mode, size = "m") => ({
    th: mode === "even" ? undefined : (mode === "taper" ? BRUSH_THIN : THIN)[size],
    tp: mode === "taper" ? R(STROKE[size] * 26) : undefined,
  });
  const penOf = (s) => (s.tp ? "taper" : s.th !== undefined || s.pts[0].length > 2 ? "pressure" : "even");

  // A drawn stroke switched to another mode; even drops its pressure
  function penPatch(s, mode) {
    const look = penLook(mode, s.s);
    return mode === "even" ? { ...look, pts: s.pts.map((p) => p.slice(0, 2)) } : look;
  }

  // Lines and arrows have nothing to fill, so they always keep their stroke
  const lineDash = () => (E.style.d === "none" ? undefined : E.style.d);

  function pressureOf(e) {
    return Math.min(9, Math.max(1, Math.round((e.pressure || 0.5) * 9)));
  }

  function downSelect(e, sp, w, dbl) {
    const hd = handleAt(sp);
    const one = selected()[0];
    if (hd && dbl && hd.kind === "point" && one?.k === "l") return removePoint(one, hd.idx);
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
    if (hit.k === "l") return insertPoint(hit, w);
    if (hit.k === "t" || hit.k === "a" || BOX.has(hit.k)) startTextEdit(hit);
  }

  function startOp(op) {
    E.op = op;
    updateCursor();
  }

  function startMove(sp, w) {
    const ids = new Set(E.sel);
    const sel = selected();
    const turned = selFrame(sel).rot ? selFrame(sel) : null;
    const orig = sel.map((s) => unbindLoose(s, ids));
    const b = unionBounds(orig.map(geomBounds));
    startOp({ type: "move", start: w, startScreen: sp, orig, b, turned, moved: false, before: E.model.shapes.slice() });
  }

  function startHandle(hd, w) {
    const sel = selected();
    const before = E.model.shapes.slice();
    if (hd.kind === "point") return startOp({ type: "point", id: sel[0].id, idx: hd.idx, before });
    if (hd.kind === "bend") return startOp({ type: "bend", id: sel[0].id, before });
    if (hd.kind === "wedge") return startOp({ type: "wedge", id: sel[0].id, part: hd.part, before });
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
    if (!op && E.path) return pathPreview(e, toWorld(...sp));
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
        op.tail = p;
        const last = op.raw[op.raw.length - 1];
        // Ink strokes are streamlined for smoother curves, the highlighter a little;
        // the plain pen keeps every move, corners included
        const k = op.mode !== "even" ? 0.4 : op.highlight ? 0.7 : 1;
        const q = [last[0] + (p[0] - last[0]) * k, last[1] + (p[1] - last[1]) * k];
        const d = Math.hypot(q[0] - last[0], q[1] - last[1]) * E.cam.z;
        if (d < 1) continue;
        op.raw.push(op.pressure ? [...q, inkPressure(op, op.real ? pressureOf(ev) : simulatePressure(op, d))] : q);
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
    if (op.type === "wedge") return wedgeTo(e, w);
  }

  function hoverCursor(sp) {
    if (E.readonly || E.space || E.tool !== "select") return;
    const hd = handleAt(sp);
    let c = "default";
    if (hd?.kind === "rotate") c = "grab";
    else if (hd?.kind === "point" || hd?.kind === "bend" || hd?.kind === "wedge") c = "pointer";
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
      if (op.idx === 0 && closedPath(s)) pts[pts.length - 1] = pts[0];
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
      const baseRot = op.orig.length === 1 ? op.f.rot : 0;
      delta = Math.round((baseRot + delta) / 15) * 15 - baseRot;
    }
    const fn = (p) => rotPt(p[0], p[1], op.c[0], op.c[1], delta);
    for (const s of op.orig) replaceShape(mapShape(s, fn, delta));
    keepSelRot({ ...op.f, rot: (((op.f.rot + delta) % 360) + 360) % 360 });
    renderShapes();
    renderOverlay();
  }

  // ── Paths: the line tool placing points one click at a time ──

  const closedPath = (s) => s.pts.length > 3 && s.pts[0][0] === s.pts.at(-1)[0] && s.pts[0][1] === s.pts.at(-1)[1];

  // The last point of a path being built follows the pointer
  function pathPoint(e, w, placed) {
    return (e.shiftKey ? angleSnap(placed.at(-1), w) : snapPt(w)).map(R);
  }

  function pathPreview(e, w) {
    const s = E.model.byId.get(E.path.id);
    const placed = s.pts.slice(0, -1);
    replaceShape({ ...s, pts: [...placed, pathPoint(e, w, placed)] });
    renderShapes();
  }

  function pathClick(e, sp, w, dbl) {
    const s = E.model.byId.get(E.path.id);
    const placed = s.pts.slice(0, -1);
    if (dbl) return finishPath();
    const first = toScreen(placed[0]);
    if (placed.length > 2 && Math.hypot(first[0] - sp[0], first[1] - sp[1]) <= (E.touch ? 16 : 9)) return finishPath(true);
    const p = pathPoint(e, w, placed);
    replaceShape({ ...s, pts: [...placed, p, p] });
    renderShapes();
    renderOverlay();
    renderUI();
  }

  // Closing it gives the shape the fill picked for the tool
  function finishPath(close) {
    const path = E.path;
    if (!path) return;
    E.path = null;
    const s = E.model.byId.get(path.id);
    if (!s) return;
    const pts = s.pts.slice(0, -1).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    if (close) pts.push(pts[0]);
    if (pts.length < 2) {
      removeShapes([s.id]);
      renderAll();
      return;
    }
    const n = { ...s, pts };
    if (close && E.style.f !== "none") Object.assign(n, { f: E.style.f, d: E.style.d === "none" ? "none" : n.d });
    replaceShape(n);
    E.sel = new Set([s.id]);
    E.tool = "select";
    renderAll();
    commit();
  }

  function popPathPoint() {
    const s = E.model.byId.get(E.path.id);
    const placed = s.pts.slice(0, -1);
    if (placed.length < 2) {
      E.path = null;
      removeShapes([s.id]);
    } else replaceShape({ ...s, pts: [...placed.slice(0, -1), s.pts.at(-1)] });
    renderAll();
  }

  // Double-click on a line: a new point where the pointer is, on the nearest segment
  function insertPoint(s, w) {
    let best = 1;
    for (let i = 1, d = Infinity; i < s.pts.length; i++) {
      const di = segDist(w, s.pts[i - 1], s.pts[i]);
      if (di < d) [d, best] = [di, i];
    }
    const pts = s.pts.slice();
    pts.splice(best, 0, snapPt(w).map(R));
    replaceShape({ ...s, pts });
    selectIds([s.id]);
    renderShapes();
    commit();
  }

  function removePoint(s, idx) {
    const closed = closedPath(s);
    // Keep at least a line, or a triangle once closed
    if (s.pts.length - 1 < (closed ? 4 : 2)) return;
    const pts = s.pts.slice();
    pts.splice(idx, 1);
    if (closed && idx === 0) pts[pts.length - 1] = pts[0];
    replaceShape({ ...s, pts });
    renderShapes();
    renderOverlay();
    renderUI();
    commit();
  }

  // ── Wedges: handles for both edges and the hole ──

  function wedgeHandles(s) {
    const c = [s.x + s.w / 2, s.y + s.h / 2];
    const at = (deg, r) => rotPt(...wedgePt(s, deg, r), c[0], c[1], s.rot || 0);
    const ir = (s.ir || 0) / 100;
    const edge = ir ? (1 + ir) / 2 : 0.75;
    // On the hole's edge, at the tip while there's no hole
    handle("wedge", at((s.a0 + s.a1) / 2, ir), { part: "ir" }, true);
    handle("wedge", at(s.a0, edge), { part: "a0" }, true);
    handle("wedge", at(s.a1, edge), { part: "a1" }, true);
  }

  function wedgeTo(e, w) {
    const op = E.op;
    const s = E.model.byId.get(op.id);
    const c = [s.x + s.w / 2, s.y + s.h / 2];
    const [lx, ly] = rotPt(w[0], w[1], c[0], c[1], -(s.rot || 0));
    // Position on the unit circle the ellipse is stretched from
    const nx = (lx - c[0]) / Math.max(s.w / 2, 1);
    const ny = (ly - c[1]) / Math.max(s.h / 2, 1);
    if (op.part === "ir") {
      const mid = (((s.a0 + s.a1) / 2) * Math.PI) / 180;
      let ir = Math.round(Math.min(0.95, Math.max(0, nx * Math.sin(mid) - ny * Math.cos(mid))) * 100);
      if (e.shiftKey) ir = Math.round(ir / 10) * 10;
      replaceShape({ ...s, ir: ir < 2 ? undefined : ir });
    } else {
      const raw = (Math.atan2(nx, -ny) * 180) / Math.PI;
      const deg = e.shiftKey ? Math.round(raw / 15) * 15 : Math.round(raw);
      const mod = (v) => ((v % 360) + 360) % 360;
      let { a0, a1 } = s;
      if (op.part === "a0") a0 = a1 - (mod(a1 - deg) || 360);
      else a1 = a0 + (mod(deg - a0) || 360);
      // Start within one turn, so the numbers stay readable
      const turn = Math.floor(a0 / 360) * 360;
      replaceShape({ ...s, a0: a0 - turn, a1: a1 - turn });
    }
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
      // Streamlining trails the pointer: end where it stopped
      const last = op.raw.at(-1);
      if (op.tail && Math.hypot(op.tail[0] - last[0], op.tail[1] - last[1]) * E.cam.z >= 1)
        op.raw.push(last.length > 2 ? [...op.tail, last[2]] : op.tail);
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
        const [w, hh] = s.k === "r" ? [160, 100] : s.k === "e" ? [140, 100] : s.k === "w" ? [140, 140] : [140, 120];
        replaceShape({ ...s, x: R(op.origin[0] - w / 2), y: R(op.origin[1] - hh / 2), w, h: hh });
      }
      E.sel = new Set([op.id]);
      E.tool = "select";
    } else if (op.type === "line") {
      if (!op.moved && E.model.byId.get(op.id).k === "l") {
        // A click instead of a drag: place points one click at a time
        E.path = { id: op.id };
        changed = false;
      } else if (!op.moved) {
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
    if (E.path && !E.op && (k === "Escape" || k === "Enter" || k === "Backspace" || k === "Delete")) {
      k === "Escape" || k === "Enter" ? finishPath() : popPathPoint();
      return done();
    }
    if (k === "Escape") {
      if (E.menu.classList.contains("visible") || E.arrange.classList.contains("visible")) closeMenu();
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
      const s = { k: "t", id: newId(), x: 0, y: 0, c: E.style.c, s: E.style.s, st: E.style.st || undefined, fo: E.style.fo, o: opacity(), label };
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
    const s = { k: "t", id: newId(), x: 0, y: 0, c: E.style.c, s: E.style.s, st: E.style.st || undefined, fo: E.style.fo, o: opacity() };
    const size = fontSize(s);
    const p = snapPt([w[0], w[1] - (size * LINE_H) / 2]);
    s.x = R(p[0]);
    s.y = R(p[1]);
    addShape(s);
    E.tool = "select";
    E.sel = new Set([s.id]);
    startTextEdit(s);
  }

  // Where a rotated text's top-left corner is drawn
  function textCorner(s) {
    const f = frame(s);
    return rotPt(f.x, f.y, f.x + f.w / 2, f.y + f.h / 2, s.rot);
  }

  function startTextEdit(s) {
    if (E.readonly) return;
    E.editing = { id: s.id, corner: s.k === "t" && s.rot ? textCorner(s) : null };
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
    let origin = "";
    if (s.k === "t") {
      // Extra width keeps the caret visible; turn around the text's own centre like the render
      const f = frame({ ...s, label: text });
      // Extra width on the side the text grows to
      const grow = size * (1 - ALIGN[s.ta || "left"]);
      w = f.w + size;
      hh = f.h;
      cx = f.x - (size - grow) + w / 2;
      cy = f.y + hh / 2;
      origin = `${f1((f.w / 2 + size - grow) * z)}px ${f1((hh / 2) * z)}px`;
    } else if (s.k === "a") {
      const g = arrowGeom(s, E.model);
      const lines = wrap(text || " ", size, size * 14, s);
      w = Math.max(size * 2, ...lines.map((l) => measure(l, size, s))) + size * 0.6;
      hh = lines.length * lineH;
      [cx, cy] = g.mid;
      rot = 0;
    } else {
      w = labelWidth(s);
      const lp = labelPos(s, wrap(text || " ", size, w, s).length);
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
      fontFamily: FONTS[s.fo || "mono"].css,
      fontWeight: s.st?.includes("b") ? "bold" : "",
      fontStyle: s.st?.includes("i") ? "italic" : "",
      textDecoration: s.st?.includes("u") ? "underline" : "",
      color: labelColor(s),
      transform: rot ? `rotate(${rot}deg)` : "",
      transformOrigin: origin,
      textAlign: s.k === "t" ? s.ta || "left" : s.k === "w" ? "center" : BOX.has(s.k) ? s.ta || "center" : "center",
      // Arrow labels sit on the line: keep it out from under the text
      background: s.k === "a" ? BG : "",
      borderRadius: s.k === "a" ? "4px" : "",
    });
  }

  // Grow a box around its centre until its label fits
  function fitLabel(n) {
    if (!BOX.has(n.k) || n.k === "w" || !n.label) return n;
    const size = fontSize(n);
    const [aw, ah] = LABEL_AREA[n.k];
    const word = Math.max(...n.label.split(/\s+/).map((w) => measure(w, size, n)));
    const needW = R((word + labelPad(n) * 2) / aw);
    if (needW > n.w) {
      n.x = R(n.x - (needW - n.w) / 2);
      n.w = needW;
    }
    const lines = wrap(n.label, size, labelWidth(n), n).length;
    const needH = R((lines * size * LINE_H + labelPad(n) * 2) / ah);
    if (needH > n.h) {
      n.y = R(n.y - (needH - n.h) / 2);
      n.h = needH;
    }
    return n;
  }

  // Typing updates the model (committed on finish) so outline and box follow
  function liveText() {
    const s = E.editing && E.model.byId.get(E.editing.id);
    if (!s) return;
    const n = fitLabel({ ...s, label: E.ta.value });
    // Rotated text turns around its centre, which moves as it grows: keep the drawn corner in place
    const corner = E.editing.corner;
    if (corner) {
      const t = textSize(n);
      const [ox, oy] = rotPt(-t.w / 2, -t.h / 2, 0, 0, n.rot);
      [n.x, n.y] = textAnchor(n, corner[0] - t.w / 2 - ox, corner[1] - t.h / 2 - oy);
    }
    replaceShape(n);
    renderShapes();
    renderOverlay();
    renderUI();
    placeText();
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
        replaceShape(fitLabel(n));
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
    fontsReady,
    usedFonts,
    fontFaces,
    setTheme: () => {
      readTheme();
      // Cached shapes carry the old colours
      E.cache.clear();
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
