// Charts (.chart): a few setting lines plus data (a table note or inline rows),
// laid out as a drawing that draw.js renders. Only styling is editable.
// window.Chart; loaded on demand after draw.js.
(() => {
  "use strict";

  const TYPES = [
    ["column", "Column"],
    ["bar", "Bar"],
    ["line", "Line"],
    ["area", "Area"],
    ["pie", "Pie"],
    ["donut", "Donut"],
    ["stacked-column", "Stacked column"],
    ["stacked-bar", "Stacked bar"],
  ];
  // The first five stay apart in every theme (docs/drawing-format.md)
  const PALETTE = ["blue", "peach", "green", "pink", "yellow", "mauve", "teal", "red", "sky", "lavender"];
  const COLORS = ["text", "grey", "red", "peach", "yellow", "green", "teal", "sky", "blue", "lavender", "mauve", "pink"];
  const SIZES = [["xs", "Hairline"], ["s", "Thin"], ["m", "Medium"], ["l", "Thick"], ["xl", "Heavy"]];
  const DEFAULTS = {
    type: "column", data: "", x: "", y: [], title: "", colors: [], stroke: "m",
    background: "none", border: "none", legend: "auto", labels: "off", grid: "on",
    ymin: "auto", ymax: "auto", xlabel: "", ylabel: "", range: "", size: "640 400",
  };
  const KEYS = Object.keys(DEFAULTS);
  const LISTS = new Set(["y", "colors"]);

  // ── Format ──

  const tokens = (s) =>
    [...s.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] != null ? m[1].replace(/\\(.)/g, "$1") : m[2]));
  const quote = (v) => (/^[^\s"\\]+$/.test(v) ? v : '"' + v.replace(/[\\"]/g, "\\$&") + '"');
  // A bare `data` line: the rest of the file is the rows (CSV)
  const inlineAt = (lines) => lines.findIndex((l) => /^\s*data\s*$/.test(l));

  function parse(text) {
    const spec = { ...DEFAULTS, y: [], colors: [], inline: null, errors: [] };
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#")) continue;
      const [key, ...vals] = tokens(line);
      if (key === "chart") {
        if (+vals[0] > 1) spec.errors.push("made by a newer version");
        continue;
      }
      if (key === "data" && !vals.length) {
        spec.inline = lines.slice(i + 1).join("\n");
        break;
      }
      if (!KEYS.includes(key)) spec.errors.push(`line ${i + 1}: unknown setting “${key}”`);
      else spec[key] = LISTS.has(key) ? vals : vals.join(" ");
    }
    if (!TYPES.some(([t]) => t === spec.type)) {
      spec.errors.push(`unknown type “${spec.type}”`);
      spec.type = "column";
    }
    return spec;
  }

  // One setting changed; a default removes its line. Comments and order stay.
  function set(text, key, value) {
    const lines = (text || "chart 1").split("\n");
    const first = /^\s*chart\b/.test(lines[0]) ? 1 : 0;
    const end = inlineAt(lines) < 0 ? lines.length : inlineAt(lines);
    const at = lines.slice(0, end).findIndex((l) => tokens(l.trim())[0] === key);
    const def = DEFAULTS[key];
    // Arrays are several values: series, colours, a size
    const isDef = Array.isArray(value) ? !value.length || value.join(" ") === def : value == null || value === "" || value === def;
    const line = isDef ? null : key + " " + (Array.isArray(value) ? value.map(quote).join(" ") : quote(String(value)));
    if (at >= 0) {
      if (line == null) lines.splice(at, 1);
      else lines[at] = line;
    } else if (line != null) {
      let pos = end;
      while (pos > first && !lines[pos - 1].trim()) pos--;
      lines.splice(pos, 0, line);
    }
    return lines.join("\n");
  }

  // Data from a table note (`ref`), or inline `rows` (CSV text) when ref is null
  function setData(text, ref, rows = "") {
    let lines = (text || "chart 1").split("\n");
    const at = inlineAt(lines);
    if (at >= 0) lines = lines.slice(0, at);
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    let out = set(lines.join("\n"), "data", ref || "");
    if (!ref) out += "\ndata\n" + rows.replace(/\n+$/, "") + "\n";
    return out;
  }

  // ── Data ──

  function num(v) {
    let s = String(v ?? "").trim().replace(/[\s$€£¥%]/g, "").replace(/^\((.*)\)$/, "-$1");
    if (!s) return null;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
    else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d*,\d+$/.test(s)) s = s.replace(",", ".");
    const n = Number(s);
    return s && Number.isFinite(n) ? n : null;
  }

  const letters = (c) => (c >= 26 ? letters(Math.floor(c / 26) - 1) : "") + String.fromCharCode(65 + (c % 26));
  const colIndex = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

  // "B2:D9" (data rows from 1, as the grid numbers them) or "B:D": 0-based, rows null for all
  function parseRange(s) {
    const m = /^([A-Z]+)(\d*):([A-Z]+)(\d*)$/i.exec(String(s || "").trim());
    if (!m) return null;
    const [c1, c2] = [colIndex(m[1]), colIndex(m[3])].sort((a, b) => a - b);
    const rows = m[2] && m[4] ? [+m[2] - 1, +m[4] - 1].sort((a, b) => a - b) : null;
    return { c1, c2, r1: rows?.[0] ?? null, r2: rows?.[1] ?? null };
  }

  // {cols, rows, range} from CSV text; without a header row the columns are A, B, …
  function table(text, sep = ",", header = true, range = "") {
    const all = window.csvParse(text || "", sep);
    const head = header && all.length ? all[0] : null;
    const rg = parseRange(range);
    let rows = header ? all.slice(1) : all;
    if (rg && rg.r1 != null) rows = rows.filter((_, i) => i >= rg.r1 && i <= rg.r2);
    rows = rows.filter((r) => r.some((c) => c.trim()));
    const w = Math.max(head?.length || 0, ...rows.map((r) => r.length));
    const cols = head ? head.map((c, i) => c.trim() || letters(i)) : [];
    for (let c = cols.length; c < w; c++) cols.push(letters(c));
    return { cols, rows, range: rg };
  }

  const numeric = (t, c) => {
    const vals = t.rows.map((r) => r[c]).filter((v) => v != null && String(v).trim());
    return vals.length > 0 && vals.filter((v) => num(v) != null).length >= vals.length / 2;
  };

  // The columns the chart uses: x (categories) and the series
  // (a range: its number columns; its first column is the categories unless it holds numbers)
  function columns(spec, t) {
    const rg = t.range;
    const inRange = (c) => !rg || (c >= rg.c1 && c <= rg.c2);
    let x = t.cols.indexOf(spec.x);
    if (x < 0) x = rg && !numeric(t, rg.c1) ? rg.c1 : 0;
    let y = spec.y.map((n) => t.cols.indexOf(n)).filter((c) => c >= 0 && c !== x);
    if (!y.length) y = t.cols.map((_, c) => c).filter((c) => c !== x && inRange(c) && numeric(t, c));
    if (/pie|donut/.test(spec.type)) y = y.slice(0, 1);
    return { x, y };
  }

  // ── Layout: the chart as drawing lines ──

  const PAD = 20;
  // Chart size in drawing units: `size W H`
  function dims(spec) {
    const m = /^(\d+)\s+(\d+)$/.exec(spec.size || "");
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    return m ? [cl(+m[1], 240, 2400), cl(+m[2], 160, 1600)] : [640, 400];
  }
  const CH = 6.6; // about one 12px sans character

  const fmtNum = (v) =>
    new Intl.NumberFormat(undefined, {
      maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2,
      notation: Math.abs(v) >= 1e6 ? "compact" : "standard",
    }).format(v);

  function ticks(lo, hi) {
    const raw = (hi - lo) / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999);
    const out = [];
    const end = Math.ceil(hi / step - 1e-9) * step;
    for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);

  function layout(spec, t) {
    const [W, H] = dims(spec);
    const out = ["draw 1"];
    let n = 0;
    const R = Math.round;
    const label = (s) => ' "' + String(s).replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n") + '"';
    const add = (line, text) => out.push(line.replace("#", "c" + ++n) + (text != null ? label(text) : ""));
    const text = (x, y, s, attrs = "") => add(`t # ${R(x)} ${R(y)} fo=sans ${/\bs=/.test(attrs) ? "" : "s=xs "}${attrs}`, s);
    const pts = (p) => p.map(([x, y]) => `${R(x)},${R(y)}`).join(" ");
    const color = (i) => spec.colors[i] || PALETTE[i % PALETTE.length];

    if (spec.background !== "none") add(`r # 0 0 ${W} ${H} c=${spec.background} f=semi d=none`);
    // Always there: every chart has the same frame, so the same size
    add(`r # 0 0 ${W} ${H} ` + (spec.border !== "none" ? `c=${spec.border} s=s` : "c=grey f=semi d=none o=1"));
    let top = PAD;
    if (spec.title) {
      text(W / 2, top, spec.title, "s=s st=b ta=center c=text");
      top += 30;
    }
    const message = (m) => (text(W / 2, (top + H) / 2, m, "ta=center va=middle c=grey"), out.join("\n") + "\n");
    if (!t) return message("No data");
    const { x, y } = columns(spec, t);
    if (!t.rows.length || !y.length) return message(t.rows.length ? "No number columns to chart" : "No data rows");

    const cats = t.rows.map((r) => String(r[x] ?? ""));
    const series = y.map((c) => ({ name: t.cols[c], vals: t.rows.map((r) => num(r[c])) }));
    const round = /pie|donut/.test(spec.type);
    const labels = spec.labels === "on";

    // Legend: series, or slices for pies
    const items = round ? cats : series.map((s) => s.name);
    if (spec.legend === "on" || (spec.legend === "auto" && (round || items.length > 1))) {
      const rows = [[]];
      let w = 0;
      for (let i = 0; i < items.length; i++) {
        const iw = 18 + clip(items[i], 24).length * CH + 16;
        if (w + iw > W - 2 * PAD && rows.at(-1).length) rows.push([]), (w = 0);
        rows.at(-1).push([i, iw]);
        w += iw;
      }
      for (const row of rows) {
        let lx = (W - row.reduce((a, [, iw]) => a + iw, 0) + 16) / 2;
        for (const [i, iw] of row) {
          add(`r # ${R(lx)} ${top + 2} 12 12 c=${color(i)} f=solid d=none rx=2`);
          text(lx + 18, top + 8, clip(items[i], 24), "va=middle c=text");
          lx += iw;
        }
        top += 22;
      }
      top += 6;
    }

    if (round) {
      const vals = series[0].vals.map((v) => (v > 0 ? v : 0));
      const total = vals.reduce((a, b) => a + b, 0);
      if (!total) return message("No positive values");
      const size = Math.min(W - 2 * PAD, H - PAD - top);
      const bx = (W - size) / 2;
      let cum = 0;
      vals.forEach((v, i) => {
        if (!v) return;
        const from = R((cum / total) * 360);
        const to = R(((cum += v) / total) * 360);
        if (to === from) return;
        const pct = Math.round((v / total) * 100) + "%";
        add(
          `w # ${R(bx)} ${R(top)} ${R(size)} ${R(size)} ${from} ${to} c=${color(i)} f=solid d=none fo=sans s=s` +
            (spec.type === "donut" ? " ir=55" : ""),
          labels && to - from >= 12 ? pct : null,
        );
      });
      return out.join("\n") + "\n";
    }

    const horiz = /bar/.test(spec.type);
    const stacked = spec.type.startsWith("stacked");
    let lo = Infinity;
    let hi = -Infinity;
    cats.forEach((_, i) => {
      if (stacked) {
        let p = 0;
        let m = 0;
        for (const s of series) if (s.vals[i] != null) s.vals[i] > 0 ? (p += s.vals[i]) : (m += s.vals[i]);
        lo = Math.min(lo, m);
        hi = Math.max(hi, p);
      } else
        for (const s of series)
          if (s.vals[i] != null) (lo = Math.min(lo, s.vals[i])), (hi = Math.max(hi, s.vals[i]));
    });
    if (lo === Infinity) return message("No numbers in the series");
    if (spec.type !== "line") (lo = Math.min(lo, 0)), (hi = Math.max(hi, 0));
    if (lo === hi) hi = lo + 1;
    let tk = ticks(lo, hi);
    lo = num(spec.ymin) ?? tk[0];
    hi = num(spec.ymax) ?? tk.at(-1);
    if (hi <= lo) hi = lo + 1;
    tk = ticks(lo, hi).filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);

    const valW = Math.max(...tk.map((v) => fmtNum(v).length)) * CH + 8;
    const catW = Math.min(160, Math.max(...cats.map((c) => c.length)) * CH + 8);
    const sideLabel = horiz ? spec.xlabel : spec.ylabel;
    const footLabel = horiz ? spec.ylabel : spec.xlabel;
    const left = PAD + (sideLabel ? 22 : 0) + (horiz ? catW : valW);
    const right = W - PAD - (horiz ? valW / 2 : 0);
    const bottom = H - PAD - 18 - (footLabel ? 22 : 0);
    const plotTop = top + 6;
    if (sideLabel) text(PAD + 8, (plotTop + bottom) / 2, sideLabel, "ta=center va=middle rot=-90 c=grey");
    if (footLabel) text((left + right) / 2, H - PAD, footLabel, "ta=center va=bottom c=grey");

    // Value axis: position of v along it
    const span = horiz ? right - left : bottom - plotTop;
    const pos = (v) => {
      const k = (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo);
      return horiz ? left + k * span : bottom - k * span;
    };
    for (const v of tk) {
      const p = pos(v);
      if (spec.grid !== "off")
        add(`l # ${horiz ? pts([[p, plotTop], [p, bottom]]) : pts([[left, p], [right, p]])} c=grey s=xs o=35`);
      if (horiz) text(p, bottom + 6, fmtNum(v), "ta=center c=grey");
      else text(left - 6, p, fmtNum(v), "ta=right va=middle c=grey");
    }
    const zero = pos(0);
    add(`l # ${horiz ? pts([[zero, plotTop], [zero, bottom]]) : pts([[left, zero], [right, zero]])} c=grey s=xs`);

    // Category axis
    const band = (horiz ? bottom - plotTop : right - left) / cats.length;
    const mid = (i) => (horiz ? plotTop : left) + band * (i + 0.5);
    const every = horiz ? Math.ceil(16 / band) : Math.ceil((Math.max(...cats.map((c) => c.length)) * CH + 8) / band);
    const room = horiz ? Math.floor((catW - 8) / CH) : Math.floor((band * Math.max(1, every)) / CH);
    cats.forEach((c, i) => {
      if (i % Math.max(1, every)) return;
      if (horiz) text(left - 6, mid(i), clip(c, room), "ta=right va=middle c=grey");
      else text(mid(i), bottom + 6, clip(c, room), "ta=center c=grey");
    });

    const valueLabel = (v, at, from) => {
      if (!labels) return;
      const neg = v < 0;
      if (horiz) text(at + (neg ? -4 : 4), from, fmtNum(v), `ta=${neg ? "right" : "left"} va=middle c=text`);
      else text(from, at + (neg ? 4 : -4), fmtNum(v), `ta=center va=${neg ? "top" : "bottom"} c=text`);
    };
    const bar = (i, a, b, at, w) => {
      const [p, q] = [Math.min(a, b), Math.max(a, b)];
      const len = Math.max(1, q - p);
      add(horiz ? `r # ${R(p)} ${R(at)} ${R(len)} ${R(w)} c=${color(i)} f=solid d=none rx=2` : `r # ${R(at)} ${R(p)} ${R(w)} ${R(len)} c=${color(i)} f=solid d=none rx=2`);
    };

    if (spec.type === "column" || spec.type === "bar") {
      const group = band * 0.72;
      const bw = group / series.length;
      series.forEach((s, si) =>
        s.vals.forEach((v, i) => {
          if (v == null) return;
          const at = mid(i) - group / 2 + si * bw;
          bar(si, zero, pos(v), at + (series.length > 1 ? 1 : 0), bw - (series.length > 1 ? 2 : 0));
          valueLabel(v, pos(v), at + bw / 2);
        }),
      );
    } else if (stacked) {
      const bw = band * 0.6;
      cats.forEach((_, i) => {
        let p = 0;
        let m = 0;
        series.forEach((s, si) => {
          const v = s.vals[i];
          if (!v) return;
          const from = v > 0 ? p : m;
          const to = from + v;
          v > 0 ? (p = to) : (m = to);
          bar(si, pos(from), pos(to), mid(i) - bw / 2, bw);
        });
        if (labels) valueLabel(p || m, pos(p || m), mid(i));
      });
    } else {
      const sw = spec.stroke;
      const r = { xs: 2, s: 2.5, m: 3, l: 4, xl: 5 }[sw] || 3;
      series.forEach((s, si) => {
        const p = s.vals.map((v, i) => (v == null ? null : [mid(i), pos(v)])).filter(Boolean);
        if (!p.length) return;
        if (spec.type === "area" && p.length > 1)
          add(`l # ${pts([...p, [p.at(-1)[0], zero], [p[0][0], zero]])} c=${color(si)} f=semi d=none`);
        if (p.length > 1) add(`l # ${pts(p)} c=${color(si)}` + (sw !== "m" ? ` s=${sw}` : ""));
        if (cats.length <= 30 || p.length === 1)
          for (const [px, py] of p) add(`e # ${R(px - r)} ${R(py - r)} ${R(2 * r)} ${R(2 * r)} c=${color(si)} f=solid d=none`);
        s.vals.forEach((v, i) => v != null && valueLabel(v, pos(v), mid(i)));
      });
    }
    return out.join("\n") + "\n";
  }

  // The drawing text for chart `text`; data(ref) → {text, sep, header} or {error}
  function compile(text, data) {
    const spec = parse(text);
    let t = null;
    let error = spec.errors[0] || "";
    if (spec.inline != null) t = table(spec.inline, ",", true, spec.range);
    else if (spec.data) {
      const d = data(spec.data);
      if (d.error) error = d.error;
      else t = table(d.text, d.sep, d.header, spec.range);
    } else error ||= "no data: pick a table or add rows";
    if (spec.range && !parseRange(spec.range)) error ||= `range “${spec.range}” isn't like B2:D9 or B:D`;
    return { draw: layout(spec, t), spec, table: t, error };
  }

  // ── Editor: the chart and its settings ──

  const E = { mounted: false };

  const CSS = `
.chart-host{display:none;flex:1;min-width:0;min-height:0;background:var(--bg);color:var(--n-text);font:var(--n-body)}
.chart-host.visible{display:flex}
.chart-view{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:8px;padding:24px;overflow:auto}
.chart-frame{position:relative;max-width:100%}
.chart-canvas svg{display:block;max-width:100%;height:auto}
.chart-rz{position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;border-radius:3px;background:var(--n-raised);box-shadow:inset 0 0 0 1.5px var(--n-text-3);cursor:nwse-resize;touch-action:none;opacity:0;transition:opacity .12s}
.chart-frame:hover .chart-rz,.chart-rz.dragging{opacity:1}
.chart-host.readonly .chart-rz{display:none}
.chart-size-tip{position:absolute;right:12px;bottom:12px;padding:2px 6px;border-radius:var(--n-r-sm);background:var(--n-inverse);color:var(--n-inverse-text);font:var(--n-caption);pointer-events:none}
.chart-msg{color:var(--n-warning);font:var(--n-label)}
.chart-msg:empty{display:none}
.chart-panel{width:288px;flex:none;overflow-y:auto;border-left:1px solid var(--n-line);padding:16px 16px 28px;display:flex;flex-direction:column;gap:22px}
.chart-host.readonly .chart-panel{display:none}
.chart-panel section{display:flex;flex-direction:column;gap:8px}
.chart-panel h3{margin:0 0 2px;font:var(--n-caption);color:var(--n-text-3);text-transform:uppercase;letter-spacing:.06em}
.chart-types{display:grid;grid-template-columns:1fr 1fr;gap:4px}
.chart-types button{height:28px;border:0;border-radius:var(--n-r-md);background:var(--n-field);color:var(--n-text);font:var(--n-label);cursor:pointer}
.chart-types button:hover{background:var(--n-hover)}
.chart-types button[aria-pressed=true]{background:var(--n-accent);color:var(--n-on-accent)}
.chart-row{display:grid;grid-template-columns:88px 1fr;align-items:center;gap:10px}
.chart-row>span:first-child{color:var(--n-text-2);font:var(--n-label)}
.chart-panel input[type=text],.chart-panel input[type=number],.chart-panel select{min-width:0;width:100%;height:28px;box-sizing:border-box;border:1px solid var(--n-line);border-radius:var(--n-r-md);background:var(--n-field);color:var(--n-text);font:var(--n-label);padding:0 8px}
.chart-pair{display:flex;align-items:center;gap:6px;color:var(--n-text-3);font:var(--n-label)}
.chart-series{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.chart-check{display:flex;align-items:center;gap:10px;min-height:28px;font:var(--n-label);cursor:pointer}
.chart-check>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chart-check select{width:96px;flex:none;height:26px}
.chart-swatch{width:12px;height:12px;border-radius:3px;flex:none}
.chart-hint{color:var(--n-text-3);font:var(--n-label)}
@media (max-width:700px){.chart-host{flex-direction:column}.chart-panel{width:auto;border-left:0;border-top:1px solid var(--n-line);max-height:45%}}
`;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const colorOpts = (cur, none) =>
    (none ? opt("none", "None", cur) : "") + COLORS.map((c) => opt(c, c[0].toUpperCase() + c.slice(1), cur)).join("");

  function build(host) {
    if (!document.getElementById("chartStyles")) {
      const st = document.createElement("style");
      st.id = "chartStyles";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    E.host = host;
    host.innerHTML = `<div class="chart-view"><div class="chart-frame"><div class="chart-canvas"></div><div class="chart-rz" title="Drag to resize" aria-hidden="true"></div></div><div class="chart-msg" role="status"></div></div><div class="chart-panel" aria-label="Chart settings"></div>`;
    E.canvas = host.querySelector(".chart-canvas");
    host.querySelector(".chart-rz").addEventListener("pointerdown", onResize);
    E.msg = host.querySelector(".chart-msg");
    E.panel = host.querySelector(".chart-panel");
    E.panel.addEventListener("click", onPanelClick);
    E.panel.addEventListener("change", onPanelChange);
    E.panel.addEventListener("input", onPanelInput);
  }

  function mount(host, opts) {
    if (E.host !== host) build(host);
    E.opts = opts;
    E.mounted = true;
    host.classList.toggle("readonly", !!opts.readonly);
    E.text = null;
    update(opts.content, true);
  }

  function unmount() {
    E.mounted = false;
  }

  function update(content, force) {
    if (!E.mounted || (!force && content === E.text)) return;
    E.text = content;
    render();
    // Typing in a field: leave the panel alone, it is already right
    if (!E.panel.contains(document.activeElement) || force) panel();
  }

  function render(text = E.text) {
    const c = compile(text, E.opts.data);
    E.compiled = c;
    E.canvas.replaceChildren(window.Draw.renderStatic(c.draw));
    E.msg.textContent = c.error;
  }

  function panel() {
    const { spec, table: t } = E.compiled;
    const round = /pie|donut/.test(spec.type);
    const cols = t ? columns(spec, t) : { x: 0, y: [] };
    const tables = E.opts.tables?.() || [];
    if (spec.data && !tables.some((x) => x.ref === spec.data)) tables.unshift({ ref: spec.data, label: spec.data });
    const cur = spec.inline != null ? "" : spec.data;
    const a = document.activeElement;
    const refocus = E.panel.contains(a)
      ? ["k", "y", "color", "type", "size"].map((d) => (a.dataset[d] != null ? `[data-${d}="${a.dataset[d]}"]` : null)).find(Boolean)
      : null;
    E.panel.innerHTML =
      `<section><h3>Type</h3><div class="chart-types">${TYPES.map(
        ([v, l]) => `<button type="button" data-type="${v}" aria-pressed="${v === spec.type}">${l}</button>`,
      ).join("")}</div></section>` +
      `<section><h3>Data</h3>` +
      `<label class="chart-row"><span>Table</span><select data-k="data">${tables
        .map((x) => opt(x.ref, x.label, cur))
        .join("")}${opt("", "Rows in this chart", cur)}</select></label>` +
      (spec.inline != null ? `<div class="chart-hint">Edit the rows in Source, after the <code>data</code> line.</div>` : "") +
      `<label class="chart-row"><span>Range</span><input type="text" data-k="range" value="${esc(spec.range)}" placeholder="whole table" spellcheck="false" /></label>` +
      (t && t.cols.length
        ? `<label class="chart-row"><span>${round ? "Slices" : "Categories"}</span><select data-k="x">${t.cols
            .map((c, i) => opt(String(i), c, String(cols.x)))
            .join("")}</select></label>` +
          `<div class="chart-series" role="group" aria-label="${round ? "Values" : "Series"}">${t.cols
            .map((c, i) => {
              if (i === cols.x) return "";
              const k = cols.y.indexOf(i);
              const color = spec.colors[k] || PALETTE[k % PALETTE.length];
              return `<label class="chart-check"><input type="${round ? "radio" : "checkbox"}" name="chart-y" data-y="${i}"${k >= 0 ? " checked" : ""} /><span>${esc(c)}</span>${
                k >= 0 && !round
                  ? `<i class="chart-swatch" style="background:var(--${color})"></i><select data-color="${k}" aria-label="Colour of ${esc(c)}">${colorOpts(color)}</select>`
                  : ""
              }</label>`;
            })
            .join("")}</div>`
        : "") +
      `</section>` +
      `<section><h3>Labels</h3>` +
      `<label class="chart-row"><span>Title</span><input type="text" data-k="title" value="${esc(spec.title)}" /></label>` +
      (round
        ? ""
        : `<label class="chart-row"><span>X axis</span><input type="text" data-k="xlabel" value="${esc(spec.xlabel)}" placeholder="none" /></label>` +
          `<label class="chart-row"><span>Y axis</span><input type="text" data-k="ylabel" value="${esc(spec.ylabel)}" placeholder="none" /></label>` +
          `<label class="chart-row"><span>Min</span><input type="text" inputmode="decimal" data-k="ymin" value="${esc(spec.ymin === "auto" ? "" : spec.ymin)}" placeholder="auto" /></label>` +
          `<label class="chart-row"><span>Max</span><input type="text" inputmode="decimal" data-k="ymax" value="${esc(spec.ymax === "auto" ? "" : spec.ymax)}" placeholder="auto" /></label>`) +
      `<label class="chart-row"><span>Legend</span><select data-k="legend">${opt("auto", "Auto", spec.legend)}${opt("on", "Show", spec.legend)}${opt("off", "Hide", spec.legend)}</select></label>` +
      `<label class="chart-check"><input type="checkbox" data-k="labels"${spec.labels === "on" ? " checked" : ""} /><span>Show values</span></label>` +
      (round ? "" : `<label class="chart-check"><input type="checkbox" data-k="grid"${spec.grid !== "off" ? " checked" : ""} /><span>Gridlines</span></label>`) +
      `</section>` +
      `<section><h3>Style</h3>` +
      `<div class="chart-row"><span>Size</span><span class="chart-pair"><input type="number" min="240" max="2400" step="10" data-size="w" value="${dims(spec)[0]}" aria-label="Width" />×<input type="number" min="160" max="1600" step="10" data-size="h" value="${dims(spec)[1]}" aria-label="Height" /></span></div>` +
      (/line|area/.test(spec.type)
        ? `<label class="chart-row"><span>Line</span><select data-k="stroke">${SIZES.map(([v, l]) => opt(v, l, spec.stroke)).join("")}</select></label>`
        : "") +
      `<label class="chart-row"><span>Background</span><select data-k="background">${colorOpts(spec.background, true)}</select></label>` +
      `<label class="chart-row"><span>Border</span><select data-k="border">${colorOpts(spec.border, true)}</select></label>` +
      `</section>`;
    if (refocus) E.panel.querySelector(refocus)?.focus();
  }

  // Dragging the corner: the chart's size in drawing units, kept on release
  function onResize(e) {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const svg = E.canvas.querySelector("svg");
    const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width || 1;
    const [w0, h0] = dims(E.compiled.spec);
    const tip = document.createElement("div");
    tip.className = "chart-size-tip";
    E.host.querySelector(".chart-view").append(tip);
    let size = null;
    const move = (ev) => {
      const snap = (v) => Math.round(v / 10) * 10;
      const w = Math.max(240, Math.min(2400, snap(w0 + (ev.clientX - e.clientX) / scale)));
      const h = Math.max(160, Math.min(1600, snap(h0 + (ev.clientY - e.clientY) / scale)));
      size = [w, h];
      tip.textContent = `${w} × ${h}`;
      render(set(E.text, "size", size.map(String)));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.classList.remove("dragging");
      tip.remove();
      if (size) commit(set(E.text, "size", size.map(String)));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  }

  function commit(text) {
    if (text === E.text) return;
    E.opts.onCommit(text);
    update(text, true);
  }

  function onPanelClick(e) {
    const b = e.target.closest("[data-type]");
    if (b) commit(set(E.text, "type", b.dataset.type));
  }

  // Text fields redraw as you type and commit on change
  function onPanelInput(e) {
    const k = e.target.dataset.k;
    if (e.target.type !== "text" || !k) return;
    render(set(E.text, k, e.target.value.trim()));
  }

  function onPanelChange(e) {
    const el = e.target;
    const { spec, table: t } = E.compiled;
    const k = el.dataset.k;
    if (k === "data") {
      if (el.value) return commit(setData(E.text, el.value));
      // To inline rows: a copy of the table's data
      const line = (r) => r.map((f) => (/[",\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f)).join(",");
      const rows = t ? [t.cols, ...t.rows].map(line).join("\n") : "label,value\nA,1";
      return commit(setData(E.text, null, rows));
    }
    if (k === "x") return commit(set(set(E.text, "x", t.cols[+el.value]), "y", spec.y.filter((n) => n !== t.cols[+el.value])));
    if (el.dataset.y != null) {
      const cols = columns(spec, t);
      const i = +el.dataset.y;
      const y = el.type === "radio" ? [i] : el.checked ? [...cols.y, i].sort((a, b) => a - b) : cols.y.filter((c) => c !== i);
      return commit(set(E.text, "y", y.map((c) => t.cols[c])));
    }
    if (el.dataset.color != null) {
      const n = columns(spec, t).y.length;
      const colors = Array.from({ length: n }, (_, i) => spec.colors[i] || PALETTE[i % PALETTE.length]);
      colors[+el.dataset.color] = el.value;
      // Defaults at the end are left out
      while (colors.length && colors.at(-1) === PALETTE[(colors.length - 1) % PALETTE.length]) colors.pop();
      return commit(set(E.text, "colors", colors));
    }
    if (el.dataset.size) {
      const [w, h] = [...E.panel.querySelectorAll("[data-size]")].map((i) => Math.round(+i.value) || 0);
      return commit(set(E.text, "size", [String(Math.max(240, Math.min(2400, w))), String(Math.max(160, Math.min(1600, h)))]));
    }
    if (el.type === "checkbox") return commit(set(E.text, k, el.checked ? "on" : "off"));
    if (k === "ymin" || k === "ymax") return commit(set(E.text, k, num(el.value) == null ? "" : el.value.trim()));
    if (k) commit(set(E.text, k, el.value.trim()));
  }

  window.Chart = {
    parse,
    set,
    setData,
    table,
    compile,
    mount,
    unmount,
    update,
    isMounted: () => E.mounted,
    TYPES,
    _state: E,
  };
})();
