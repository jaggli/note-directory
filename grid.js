// CSV/TSV notes: the format, import cleanup and a virtualized grid editor
// (window.Grid). Loaded on demand, like draw.js. No libraries.
(() => {
  "use strict";

  // ── Format: RFC 4180 with LF, quoting only fields that need it ──

  function parse(text, sep) {
    const rows = [];
    if (!text) return rows;
    const n = text.length;
    let row = [];
    let i = 0;
    const end = (from) => {
      let e = from;
      while (e < n) {
        const ch = text[e];
        if (ch === sep || ch === "\n" || ch === "\r") break;
        e++;
      }
      return e;
    };
    for (;;) {
      let f = "";
      if (text[i] === '"') {
        let j = i + 1;
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) {
            f += text.slice(j);
            i = n;
            break;
          }
          f += text.slice(j, k);
          if (text[k + 1] === '"') {
            f += '"';
            j = k + 2;
          } else {
            i = k + 1;
            break;
          }
        }
        // Stray text after the closing quote stays part of the field
        const e = end(i);
        f += text.slice(i, e);
        i = e;
      } else {
        const e = end(i);
        f = text.slice(i, e);
        i = e;
      }
      row.push(f);
      if (i >= n) {
        rows.push(row);
        break;
      }
      if (text[i] === sep) {
        i++;
        continue;
      }
      i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
      rows.push(row);
      row = [];
      if (i >= n) break;
    }
    return rows;
  }

  function width(rows) {
    let w = 0;
    for (const r of rows) if (r.length > w) w = r.length;
    return w;
  }

  function quote(f, sep) {
    return f.includes(sep) || /["\r\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f;
  }

  // Rows are padded to the widest one
  function serialize(rows, sep, eol = "\n") {
    const w = width(rows);
    let out = "";
    for (const r of rows) {
      const cells = [];
      for (let c = 0; c < w; c++) cells.push(quote(r[c] ?? "", sep));
      out += cells.join(sep) + eol;
    }
    return out;
  }

  // ── Import: encoding, separator, line endings ──

  const SEP_NAMES = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };
  // Ties go to the earlier one: "1,5;2,3" is semicolons with decimal commas
  const SEPS = ["\t", ";", ",", "|"];

  // The separator that splits the most lines into the same number of fields
  function detect(text) {
    let sample = text.slice(0, 65536);
    if (sample.length < text.length) sample = sample.slice(0, sample.lastIndexOf("\n") + 1) || sample;
    let best = null;
    let bestScore = 0;
    for (const sep of SEPS) {
      const rows = parse(sample, sep)
        .slice(0, 200)
        .filter((r) => r.length > 1 || r[0] !== "");
      if (!rows.length) continue;
      const counts = new Map();
      for (const r of rows) counts.set(r.length, (counts.get(r.length) || 0) + 1);
      let mode = 1;
      let hits = 0;
      for (const [k, v] of counts) if (v > hits || (v === hits && k > mode)) [mode, hits] = [k, v];
      if (mode < 2) continue;
      const score = hits / rows.length;
      if (score > bestScore) [best, bestScore] = [sep, score];
    }
    return best;
  }

  // BOM, else strict UTF-8, else Windows-1252 (what Excel writes in Europe)
  function decode(buf) {
    const b = new Uint8Array(buf);
    let enc = "utf-8";
    if (b[0] === 0xff && b[1] === 0xfe) enc = "utf-16le";
    else if (b[0] === 0xfe && b[1] === 0xff) enc = "utf-16be";
    else if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) {
      try {
        return { text: new TextDecoder("utf-8", { fatal: true }).decode(b), encoding: "utf-8" };
      } catch {
        enc = "windows-1252";
      }
    }
    return { text: new TextDecoder(enc).decode(b), encoding: enc };
  }

  // Any dialect in, ours out; `notes` says what was converted
  function normalize(text, sep) {
    const notes = [];
    let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    let from;
    const hint = src.match(/^sep=(.)\r?\n/i);
    if (hint) {
      from = hint[1];
      src = src.slice(hint[0].length);
    } else from = detect(src) || sep;
    if (from !== sep) notes.push((SEP_NAMES[from] || JSON.stringify(from)) + "-separated");
    if (src.includes("\r")) notes.push(src.includes("\r\n") ? "CRLF line endings" : "CR line endings");
    const rows = parse(src, from).map((r) => r.map((f) => f.replace(/\r\n?/g, "\n")));
    return { text: serialize(rows, sep), notes };
  }

  // Excel opens a file in its own list separator, which follows the decimal one
  function excel(text, sep) {
    const list = sep === "\t" ? "\t" : (1.5).toLocaleString().includes(",") ? ";" : ",";
    return "﻿" + serialize(parse(text, sep), list, "\r\n");
  }

  // ── Editor ──

  const RH = 26; // row height
  const MIN_W = 48;
  const MAX_W = 280;

  const CSS = `
.grid-host{flex-direction:column;font:var(--n-body);color:var(--n-text)}
.grid-host.visible{display:flex}
.grid-bar{display:flex;align-items:center;gap:4px;padding:6px 10px;border-bottom:1px solid var(--n-line);flex:none;overflow-x:auto;scrollbar-width:none}
.grid-host.readonly .grid-bar{display:none}
.grid-bar button,.grid-pop button{font:var(--n-body-strong);color:var(--n-text-2);background:none;border:0;margin:0;padding:0 8px;height:26px;border-radius:var(--n-r-md);display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;flex:none;-webkit-tap-highlight-color:transparent}
.grid-bar button:hover{color:var(--n-text);background:var(--n-hover)}
.grid-bar button[aria-pressed=true]{color:var(--n-text);background:var(--n-pressed)}
.grid-bar button:focus-visible,.grid-pop button:focus-visible{outline:2px solid var(--n-accent);outline-offset:1px}
.grid-size{margin-left:auto;padding-left:12px;font:var(--n-caption);color:var(--n-text-3);white-space:nowrap;font-feature-settings:"tnum"}
.grid-scroll{flex:1;overflow:auto;position:relative;outline:none;overscroll-behavior:contain}
.grid-inner{position:relative;min-width:100%}
.grid-head{position:sticky;top:0;z-index:2}
.grid-body{position:absolute;left:0;right:0}
.grid-row{display:grid;grid-template-columns:var(--gt);height:${RH}px}
.grid-cell{box-sizing:border-box;padding:0 8px;line-height:${RH - 1}px;white-space:pre;overflow:hidden;text-overflow:ellipsis;border-right:1px solid var(--n-line);border-bottom:1px solid var(--n-line);background:var(--bg);cursor:default;user-select:none;-webkit-user-select:none}
.grid-cell.num{text-align:right;font-feature-settings:"tnum"}
.grid-cell.gn,.grid-cell.gl{position:sticky;left:0;z-index:1;text-align:right;color:var(--n-text-3);font:var(--n-caption);line-height:${RH - 1}px;background:var(--n-raised);cursor:default;font-feature-settings:"tnum"}
.grid-cell.gl{position:static;text-align:center}
.grid-cell.hdr{font:var(--n-body-strong);line-height:${RH - 1}px;background:var(--n-raised)}
.grid-cell.on{color:var(--n-text);background:color-mix(in srgb,var(--n-accent) 14%,var(--n-raised))}
.grid-cell.sel{background:color-mix(in srgb,var(--n-accent) 14%,var(--bg))}
.grid-cell.hdr.sel{background:color-mix(in srgb,var(--n-accent) 14%,var(--n-raised))}
.grid-cell.act{box-shadow:inset 0 0 0 2px var(--n-accent)}
.grid-cell mark{background:color-mix(in srgb,var(--blue) 25%,transparent);color:inherit;border-radius:2px}
.grid-cell mark.cur{background:var(--blue);color:var(--bg)}
.grid-edit{position:absolute;z-index:3;display:none;box-sizing:border-box;margin:0;padding:3px 7px;border:0;outline:none;resize:none;overflow:hidden;font:var(--n-body);line-height:19px;color:var(--n-text);background:var(--bg);box-shadow:0 0 0 2px var(--n-accent),var(--n-shadow-1);white-space:pre-wrap;word-break:break-word}
.grid-edit.visible{display:block}
.grid-pop{position:absolute;z-index:6;display:none;flex-direction:column;min-width:190px;padding:4px;background:var(--n-raised);box-shadow:var(--n-shadow-1);border-radius:var(--n-r-lg)}
.grid-pop.visible{display:flex}
.grid-pop button{justify-content:flex-start;color:var(--n-text)}
.grid-pop button:hover{background:var(--n-accent);color:var(--n-on-accent)}
.grid-pop .danger{color:var(--n-danger)}
.grid-pop .danger:hover{background:var(--n-danger);color:var(--n-on-accent)}
.grid-pop hr{border:0;height:1px;margin:4px 8px;background:var(--n-line)}
`;

  const E = {
    host: null,
    mounted: false,
    rows: [[""]],
    cols: 1,
    text: "",
    w: [],
    x: [],
    act: { r: 0, c: 0 },
    anc: { r: 0, c: 0 },
    editing: null,
    pending: null,
    find: null,
  };

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const show = (s) => esc(s).replace(/\n/g, "↵");
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const NUM = /^[-+]?[\d.,' ]*\d%?$/;
  const findRe = (q) => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

  function letters(c) {
    let s = "";
    for (c++; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
    return s;
  }

  const cell = (r, c) => E.rows[r]?.[c] ?? "";
  const d0 = () => (E.header && E.rows.length > 0 ? 1 : 0);
  const headH = () => RH * (1 + d0());

  function range() {
    return {
      r1: Math.min(E.act.r, E.anc.r),
      r2: Math.max(E.act.r, E.anc.r),
      c1: Math.min(E.act.c, E.anc.c),
      c2: Math.max(E.act.c, E.anc.c),
    };
  }

  function build(host) {
    if (!document.getElementById("gridStyles")) {
      const st = document.createElement("style");
      st.id = "gridStyles";
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    E.host = host;
    host.innerHTML = `
<div class="grid-bar">
  <button data-g="header" aria-pressed="true">Header row</button>
  <button data-g="insert" aria-haspopup="menu">Insert<svg class="icon sm"><use href="#i-chev-down"/></svg></button>
  <button data-g="delete" aria-haspopup="menu">Delete<svg class="icon sm"><use href="#i-chev-down"/></svg></button>
  <span class="grid-size"></span>
</div>
<div class="grid-scroll" tabindex="0" role="grid" aria-label="Table">
  <div class="grid-inner"><div class="grid-head"></div><div class="grid-body"></div>
  <textarea class="grid-edit" spellcheck="false" aria-label="Cell"></textarea></div>
</div>
<div class="grid-pop" role="menu"></div>`;
    E.bar = host.querySelector(".grid-bar");
    E.scroll = host.querySelector(".grid-scroll");
    E.inner = host.querySelector(".grid-inner");
    E.head = host.querySelector(".grid-head");
    E.body = host.querySelector(".grid-body");
    E.ta = host.querySelector(".grid-edit");
    E.pop = host.querySelector(".grid-pop");
    E.size = host.querySelector(".grid-size");

    let raf = 0;
    E.scroll.addEventListener("scroll", () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          paintBody();
          placeEditor();
        });
    });
    new ResizeObserver(() => E.mounted && paintBody()).observe(E.scroll);
    E.bar.addEventListener("click", onBar);
    E.pop.addEventListener("click", onPop);
    E.scroll.addEventListener("pointerdown", onDown);
    E.scroll.addEventListener("contextmenu", onContextMenu);
    E.scroll.addEventListener("keydown", onKey);
    E.scroll.addEventListener("copy", (e) => onClipboard(e, "copy"));
    E.scroll.addEventListener("cut", (e) => onClipboard(e, "cut"));
    E.scroll.addEventListener("paste", (e) => onClipboard(e, "paste"));
    E.ta.addEventListener("keydown", onEditKey);
    E.ta.addEventListener("input", sizeEditor);
    E.ta.addEventListener("blur", () => finishEdit(true, false));
    document.addEventListener("pointerdown", (e) => {
      if (E.pop.classList.contains("visible") && !E.pop.contains(e.target) && !e.target.closest?.(".grid-bar [aria-haspopup]")) closePop();
    });
  }

  function mount(host, opts) {
    if (E.host !== host) build(host);
    const reset = E.key !== opts.key || !E.mounted;
    E.opts = opts;
    E.key = opts.key;
    E.sep = opts.sep;
    E.readonly = !!opts.readonly;
    E.header = opts.header !== false;
    E.mounted = true;
    host.classList.toggle("readonly", E.readonly);
    setContent(opts.content, reset);
    if (!E.readonly && !matchMedia("(pointer:coarse)").matches) E.scroll.focus({ preventScroll: true });
  }

  function unmount() {
    if (!E.mounted) return;
    finishEdit(true, false);
    closePop();
    E.mounted = false;
    E.body.innerHTML = "";
    E.head.innerHTML = "";
    E.find = null;
  }

  // Outside changes (undo, source tab, other tabs) wait for a cell edit to end
  function update(content) {
    if (!E.mounted) return;
    if (E.editing) {
      E.pending = content;
      return;
    }
    if (content !== E.text) setContent(content, false);
  }

  function setContent(text, reset) {
    E.text = text;
    const rows = parse(text, E.sep);
    E.rows = rows.length ? rows : [[""]];
    E.cols = Math.max(1, width(E.rows));
    if (reset) {
      E.act = { r: 0, c: 0 };
      E.anc = { r: 0, c: 0 };
      E.scroll.scrollTop = 0;
      E.scroll.scrollLeft = 0;
    } else clampSel();
    layout();
  }

  function clampSel() {
    const R = E.rows.length - 1;
    const C = E.cols - 1;
    E.act = { r: clamp(E.act.r, 0, R), c: clamp(E.act.c, 0, C) };
    E.anc = { r: clamp(E.anc.r, 0, R), c: clamp(E.anc.c, 0, C) };
  }

  let measureCtx = null;
  function measure() {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(E.scroll);
    measureCtx.font = `500 12.5px ${cs.fontFamily}`;
    const tw = (s) => measureCtx.measureText(s.length > 60 ? s.slice(0, 60) : s).width;
    const w = new Array(E.cols).fill(MIN_W);
    const n = Math.min(E.rows.length, 300);
    for (let r = 0; r < n; r++) {
      const row = E.rows[r];
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (!v) continue;
        const x = tw(v.split("\n")[0]) + 20;
        if (x > w[c]) w[c] = x;
      }
    }
    E.w = w.map((x) => Math.ceil(Math.min(MAX_W, x)));
    E.gut = Math.max(36, Math.ceil(tw(String(E.rows.length)) + 18));
    E.x = [];
    let x = E.gut;
    for (const cw of E.w) {
      E.x.push(x);
      x += cw;
    }
    E.totalW = x;
  }

  function layout() {
    measure();
    E.inner.style.setProperty("--gt", `${E.gut}px ${E.w.map((w) => w + "px").join(" ")}`);
    E.inner.style.width = E.totalW + "px";
    E.inner.style.height = headH() + (E.rows.length - d0()) * RH + "px";
    E.bar.querySelector("[data-g=header]").setAttribute("aria-pressed", E.header);
    paint();
  }

  function paint() {
    paintHead();
    paintBody();
    const n = E.rows.length - d0();
    E.size.textContent = `${n.toLocaleString()} ${n === 1 ? "row" : "rows"} × ${E.cols} ${E.cols === 1 ? "column" : "columns"}`;
  }

  function cellHtml(v, r, c, cls) {
    const { r1, r2, c1, c2 } = range();
    if (r >= r1 && r <= r2 && c >= c1 && c <= c2) {
      if (r1 !== r2 || c1 !== c2) cls += " sel";
      if (r === E.act.r && c === E.act.c) cls += " act";
    }
    if (v && !cls.includes("hdr") && NUM.test(v)) cls += " num";
    let html = show(v);
    if (E.find && v) {
      let i = 0;
      let pos = 0;
      html = "";
      for (const m of v.matchAll(E.find.re)) {
        const cur = E.find.cur && E.find.cur.r === r && E.find.cur.c === c && E.find.cur.i === i;
        html += show(v.slice(pos, m.index)) + `<mark${cur ? ' class="cur"' : ""}>${show(m[0])}</mark>`;
        pos = m.index + m[0].length;
        i++;
      }
      html += show(v.slice(pos));
    }
    return `<div class="grid-cell${cls}" data-c="${c}">${html}</div>`;
  }

  function rowHtml(r, cls) {
    const { r1, r2 } = range();
    const on = r >= r1 && r <= r2 ? " on" : "";
    const label = cls ? "" : String(r - d0() + 1);
    let html = `<div class="grid-row" data-r="${r}"><div class="grid-cell gn${on}">${label}</div>`;
    const row = E.rows[r];
    for (let c = 0; c < E.cols; c++) html += cellHtml(row[c] ?? "", r, c, cls);
    return html + "</div>";
  }

  function paintHead() {
    const { c1, c2 } = range();
    let html = `<div class="grid-row" data-r="-1"><div class="grid-cell gn"></div>`;
    for (let c = 0; c < E.cols; c++)
      html += `<div class="grid-cell gl${c >= c1 && c <= c2 ? " on" : ""}" data-c="${c}">${letters(c)}</div>`;
    html += "</div>";
    if (d0()) html += rowHtml(0, " hdr");
    E.head.innerHTML = html;
  }

  function paintBody() {
    if (!E.mounted) return;
    const top = E.scroll.scrollTop;
    const h = E.scroll.clientHeight || 600;
    const n = E.rows.length - d0();
    const first = Math.max(0, Math.floor(top / RH) - 6);
    const last = Math.min(n, Math.ceil((top + h) / RH) + 6);
    E.body.style.top = headH() + first * RH + "px";
    let html = "";
    for (let i = first; i < last; i++) html += rowHtml(i + d0(), "");
    E.body.innerHTML = html;
  }

  function rowTop(r) {
    if (d0() && r === 0) return E.scroll.scrollTop + RH;
    return headH() + (r - d0()) * RH;
  }

  function reveal(r, c) {
    const s = E.scroll;
    if (!(d0() && r === 0)) {
      const y = rowTop(r);
      if (y < s.scrollTop + headH()) s.scrollTop = y - headH();
      else if (y + RH > s.scrollTop + s.clientHeight) s.scrollTop = y + RH - s.clientHeight;
    }
    const x = E.x[c];
    if (x === undefined) return;
    if (x < s.scrollLeft + E.gut) s.scrollLeft = x - E.gut;
    else if (x + E.w[c] > s.scrollLeft + s.clientWidth) s.scrollLeft = x + E.w[c] - s.clientWidth;
  }

  function select(act, anc = act, scroll = true) {
    E.act = act;
    E.anc = anc;
    clampSel();
    if (scroll) reveal(E.act.r, E.act.c);
    paint();
  }

  function move(dr, dc, extend, jump) {
    let { r, c } = E.act;
    if (jump) {
      if (dr) r = dr < 0 ? 0 : E.rows.length - 1;
      if (dc) c = dc < 0 ? 0 : E.cols - 1;
    } else {
      r += dr;
      c += dc;
    }
    select({ r, c }, extend ? E.anc : { r, c });
  }

  // ── Changes ──

  function commit(rows) {
    const text = rows.length ? serialize(rows, E.sep) : "";
    E.text = text;
    E.rows = rows.length ? rows : [[""]];
    E.cols = Math.max(1, width(E.rows));
    clampSel();
    layout();
    E.opts.onCommit?.(text);
  }

  // A copy padded to the full width, safe to change
  const grid = () => E.rows.map((r) => {
    const o = r.slice();
    while (o.length < E.cols) o.push("");
    return o;
  });

  function setCells(changes) {
    const rows = grid();
    for (const [r, c, v] of changes) {
      while (rows.length <= r) rows.push([]);
      while (rows[r].length <= c) rows[r].push("");
      rows[r][c] = v;
    }
    commit(rows);
  }

  // The new rows or columns end up selected
  function insertRows(at, n = 1) {
    if (E.readonly) return;
    const rows = grid();
    rows.splice(at, 0, ...Array.from({ length: n }, () => new Array(E.cols).fill("")));
    E.anc = { r: at, c: E.act.c };
    E.act = { r: at + n - 1, c: E.act.c };
    commit(rows);
    reveal(at, E.act.c);
  }

  function insertCol(at, n = 1) {
    if (E.readonly) return;
    const rows = grid();
    for (const r of rows) r.splice(at, 0, ...new Array(n).fill(""));
    E.anc = { r: E.act.r, c: at };
    E.act = { r: E.act.r, c: at + n - 1 };
    commit(rows);
    reveal(E.act.r, at);
  }

  function deleteRows() {
    if (E.readonly) return;
    const { r1, r2 } = range();
    const rows = grid();
    rows.splice(r1, r2 - r1 + 1);
    E.act = E.anc = { r: r1, c: E.act.c };
    commit(rows);
  }

  function deleteCols() {
    if (E.readonly) return;
    const { c1, c2 } = range();
    let rows = grid();
    for (const r of rows) r.splice(c1, c2 - c1 + 1);
    if (!rows[0]?.length) rows = [];
    E.act = E.anc = { r: E.act.r, c: c1 };
    commit(rows);
  }

  function clearRange() {
    if (E.readonly) return;
    const { r1, r2, c1, c2 } = range();
    const ch = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (cell(r, c)) ch.push([r, c, ""]);
    if (ch.length) setCells(ch);
  }

  function rangeTsv() {
    const { r1, r2, c1, c2 } = range();
    const out = [];
    for (let r = r1; r <= r2; r++) {
      const row = [];
      for (let c = c1; c <= c2; c++) row.push(cell(r, c));
      out.push(row);
    }
    return serialize(out, "\t").replace(/\n$/, "");
  }

  // Spreadsheets copy TSV; one value pasted over a range fills it
  function paste(text) {
    if (E.readonly) return;
    const clip = parse(text.replace(/\r?\n$/, ""), "\t").map((r) => r.map((f) => f.replace(/\r\n?/g, "\n")));
    if (!clip.length) return;
    const { r1, r2, c1, c2 } = range();
    const ch = [];
    if (clip.length === 1 && clip[0].length === 1) {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ch.push([r, c, clip[0][0]]);
    } else {
      clip.forEach((row, i) => row.forEach((v, j) => ch.push([r1 + i, c1 + j, v])));
      E.anc = { r: r1, c: c1 };
      E.act = { r: r1 + clip.length - 1, c: c1 + width(clip) - 1 };
    }
    setCells(ch);
  }

  // ── Cell editor ──

  function startEdit(initial) {
    if (E.readonly || !E.mounted) return;
    closePop();
    const { r, c } = E.act;
    E.anc = E.act;
    reveal(r, c);
    paint();
    E.editing = { r, c };
    E.ta.value = initial ?? cell(r, c);
    E.ta.classList.add("visible");
    placeEditor();
    E.ta.focus({ preventScroll: true });
    E.ta.setSelectionRange(E.ta.value.length, E.ta.value.length);
  }

  function placeEditor() {
    if (!E.editing) return;
    const { r, c } = E.editing;
    E.ta.style.top = rowTop(r) + "px";
    E.ta.style.left = E.x[c] + "px";
    E.ta.style.minWidth = Math.max(E.w[c], 120) + "px";
    E.ta.style.maxWidth = Math.max(E.w[c], 420) + "px";
    sizeEditor();
  }

  function sizeEditor() {
    E.ta.style.height = RH + "px";
    E.ta.style.width = E.ta.style.minWidth;
    const fit = Math.min(E.ta.scrollWidth + 2, parseFloat(E.ta.style.maxWidth));
    E.ta.style.width = fit + "px";
    E.ta.style.height = Math.max(RH, E.ta.scrollHeight) + "px";
  }

  function finishEdit(save, focus = true) {
    if (!E.editing) return;
    const { r, c } = E.editing;
    E.editing = null;
    E.ta.classList.remove("visible");
    const v = E.ta.value;
    const changed = save && v !== cell(r, c);
    const pending = E.pending;
    E.pending = null;
    // A change made here wins over one that came in meanwhile
    if (changed) setCells([[r, c, v]]);
    else if (pending !== null && pending !== E.text) setContent(pending, false);
    if (focus) E.scroll.focus({ preventScroll: true });
  }

  function onEditKey(e) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    // App shortcuts (find, palette, views) still work while typing
    if (mod && !["z", "y", "a", "c", "v", "x"].includes(k.toLowerCase())) return;
    e.stopPropagation();
    if (e.isComposing) return;
    if (k === "Enter" && (e.altKey || e.shiftKey)) {
      e.preventDefault();
      E.ta.setRangeText("\n", E.ta.selectionStart, E.ta.selectionEnd, "end");
      sizeEditor();
    } else if (k === "Enter") {
      e.preventDefault();
      const { r, c } = E.editing;
      finishEdit(true);
      select({ r: r + 1, c });
    } else if (k === "Tab") {
      e.preventDefault();
      const { r, c } = E.editing;
      finishEdit(true);
      select({ r, c: c + (e.shiftKey ? -1 : 1) });
    } else if (k === "Escape") {
      e.preventDefault();
      finishEdit(false);
    }
  }

  // ── Input ──

  function cellAt(t) {
    const el = t.closest?.(".grid-cell");
    const rowEl = el?.parentElement;
    if (!el || !rowEl?.dataset.r) return null;
    const r = +rowEl.dataset.r;
    const c = el.dataset.c === undefined ? -1 : +el.dataset.c;
    if (r === -1) return { kind: c === -1 ? "all" : "col", r, c };
    if (c === -1) return { kind: "row", r, c };
    return { kind: "cell", r, c };
  }

  function selectHit(hit, extend) {
    const last = { r: E.rows.length - 1, c: E.cols - 1 };
    // Whole rows and columns: the active cell is their first one, and nothing scrolls
    if (hit.kind === "all") return select({ r: 0, c: 0 }, last, false);
    if (hit.kind === "col") return select({ r: 0, c: hit.c }, { r: last.r, c: extend ? E.anc.c : hit.c }, false);
    if (hit.kind === "row") return select({ r: hit.r, c: 0 }, { r: extend ? E.anc.r : hit.r, c: last.c }, false);
    select({ r: hit.r, c: hit.c }, extend ? E.anc : { r: hit.r, c: hit.c });
  }

  function onDown(e) {
    if (e.target === E.ta || e.button > 0) return;
    const hit = cellAt(e.target);
    if (!hit) return;
    if (E.editing) finishEdit(true, false);
    // Touch scrolls: a tap selects, a tap on the selected cell edits
    if (e.pointerType === "touch") {
      const x0 = e.clientX;
      const y0 = e.clientY;
      E.scroll.addEventListener(
        "pointerup",
        (u) => {
          if (Math.hypot(u.clientX - x0, u.clientY - y0) > 8) return;
          const again = hit.kind === "cell" && E.act.r === hit.r && E.act.c === hit.c && E.anc.r === hit.r && E.anc.c === hit.c;
          if (again) startEdit();
          else selectHit(hit, false);
        },
        { once: true },
      );
      return;
    }
    e.preventDefault();
    E.scroll.focus({ preventScroll: true });
    // Cells are repainted on select, so double clicks are counted here
    const now = performance.now();
    const twice = hit.kind === "cell" && E.lastDown && now - E.lastDown.t < 400 && E.lastDown.r === hit.r && E.lastDown.c === hit.c;
    E.lastDown = twice ? null : { t: now, r: hit.r, c: hit.c };
    selectHit(hit, e.shiftKey);
    if (twice) return startEdit();
    const onMove = (m) => {
      const h = cellAt(document.elementFromPoint(m.clientX, m.clientY) || E.scroll);
      if (!h || h.r < 0 && hit.kind !== "col") return;
      if (hit.kind === "cell" && h.kind === "cell" && (h.r !== E.act.r || h.c !== E.act.c)) select({ r: h.r, c: h.c }, E.anc);
      else if (hit.kind === "row" && h.r >= 0 && h.r !== E.act.r) select({ r: h.r, c: 0 }, E.anc, false);
      else if (hit.kind === "col" && h.c >= 0 && h.c !== E.act.c) select({ r: 0, c: h.c }, E.anc, false);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onKey(e) {
    if (!E.mounted || e.target === E.ta || e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;
    const lk = k.toLowerCase();
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) return done(), move(...arrows[k], e.shiftKey, mod);
    if (mod && !e.altKey && lk === "a") return done(), selectHit({ kind: "all" });
    if (k === "Escape" && E.pop.classList.contains("visible")) return done(), closePop();
    if (k === "Escape" && (E.act.r !== E.anc.r || E.act.c !== E.anc.c)) return done(), select(E.act);
    if (k === "Tab") return done(), move(0, e.shiftKey ? -1 : 1);
    if (k === "Home" || k === "End") return done(), move(mod ? (k === "Home" ? -1 : 1) : 0, k === "Home" ? -1 : 1, e.shiftKey, true);
    if (k === "PageUp" || k === "PageDown") {
      const page = Math.max(1, Math.floor(E.scroll.clientHeight / RH) - 2);
      return done(), move(k === "PageUp" ? -page : page, 0, e.shiftKey);
    }
    if (E.readonly) return;
    if (mod && !e.altKey && lk === "z") return done(), e.shiftKey ? E.opts.onRedo?.() : E.opts.onUndo?.();
    if (mod && !e.altKey && lk === "y") return done(), E.opts.onRedo?.();
    if (k === "Enter" || k === "F2") return done(), startEdit();
    if (k === "Delete" || k === "Backspace") {
      done();
      // ⌘⌫ removes whole selected rows or columns; anything else is cleared
      const { r1, r2, c1, c2 } = range();
      if (mod && c1 === 0 && c2 === E.cols - 1) return deleteRows();
      if (mod && r1 === 0 && r2 === E.rows.length - 1) return deleteCols();
      return clearRange();
    }
    if (k.length === 1 && !mod && !e.altKey) return done(), startEdit(k);
  }

  function onClipboard(e, kind) {
    if (e.target === E.ta || !E.mounted) return;
    e.preventDefault();
    if (kind === "paste") return paste(e.clipboardData.getData("text/plain"));
    e.clipboardData.setData("text/plain", rangeTsv());
    if (kind === "cut") clearRange();
  }

  // ── Menus ──

  function popItems(pre = "") {
    const { r1, r2, c1, c2 } = range();
    const nr = r2 - r1 + 1;
    const nc = c2 - c1 + 1;
    const b = (g, label, cls = "") => `<button role="menuitem" data-g="${g}" class="${cls}">${label}</button>`;
    return {
      insert: [
        ["row-above", "row above"], ["row-below", "row below"], ["row-above-10", "10 rows above"], ["row-below-10", "10 rows below"], 0,
        ["col-left", "column left"], ["col-right", "column right"], ["col-left-10", "10 columns left"], ["col-right-10", "10 columns right"],
      ]
        .map((it) => (it ? b(it[0], pre ? pre + it[1] : it[1][0].toUpperCase() + it[1].slice(1)) : "<hr>"))
        .join(""),
      delete:
        b("del-rows", nr === 1 ? "Delete row" : `Delete ${nr} rows`, "danger") +
        b("del-cols", nc === 1 ? "Delete column" : `Delete ${nc} columns`, "danger") +
        "<hr>" + b("clear", "Clear cells"),
    };
  }

  function openPop(html, x, y) {
    E.pop.innerHTML = html;
    E.pop.classList.add("visible");
    const hr = E.host.getBoundingClientRect();
    const pw = E.pop.offsetWidth;
    const ph = E.pop.offsetHeight;
    E.pop.style.left = clamp(x - hr.left, 4, hr.width - pw - 4) + "px";
    E.pop.style.top = clamp(y - hr.top, 4, hr.height - ph - 4) + "px";
    E.pop.querySelector("button")?.focus({ preventScroll: true });
  }

  function closePop() {
    E.pop?.classList.remove("visible");
  }

  function onBar(e) {
    const b = e.target.closest("button");
    if (!b || E.readonly) return;
    const g = b.dataset.g;
    if (g === "header") {
      E.header = !E.header;
      E.opts.onHeader?.(E.header);
      layout();
      return;
    }
    if (E.pop.classList.contains("visible") && E.pop.dataset.from === g) return closePop();
    const r = b.getBoundingClientRect();
    E.pop.dataset.from = g;
    openPop(popItems()[g], r.left, r.bottom + 4);
  }

  function onContextMenu(e) {
    const hit = cellAt(e.target);
    if (!hit || E.readonly) return;
    e.preventDefault();
    const { r1, r2, c1, c2 } = range();
    const inside = hit.kind === "cell" ? hit.r >= r1 && hit.r <= r2 && hit.c >= c1 && hit.c <= c2 : false;
    if (!inside) selectHit(hit, false);
    const items = popItems("Insert ");
    E.pop.dataset.from = "";
    openPop(items.insert + "<hr>" + items.delete, e.clientX, e.clientY);
  }

  function onPop(e) {
    const b = e.target.closest("button");
    if (!b) return;
    closePop();
    const { r1, r2, c1, c2 } = range();
    const act = {
      "row-above": () => insertRows(r1),
      "row-below": () => insertRows(r2 + 1),
      "col-left": () => insertCol(c1),
      "col-right": () => insertCol(c2 + 1),
      "row-above-10": () => insertRows(r1, 10),
      "row-below-10": () => insertRows(r2 + 1, 10),
      "col-left-10": () => insertCol(c1, 10),
      "col-right-10": () => insertCol(c2 + 1, 10),
      "del-rows": deleteRows,
      "del-cols": deleteCols,
      clear: clearRange,
    }[b.dataset.g];
    act?.();
    E.scroll.focus({ preventScroll: true });
  }

  // ── Find (driven by the app's find bar) ──

  function find(query) {
    const re = findRe(query);
    const out = [];
    E.rows.forEach((row, r) =>
      row.forEach((v, c) => {
        let i = 0;
        if (v) for (const _ of v.matchAll(re)) out.push({ r, c, i: i++ });
      }),
    );
    return out;
  }

  // `cur` null clears; with `go` the match becomes the selected cell
  function showFind(query, cur, go) {
    if (!E.mounted) return;
    E.find = query && cur ? { re: findRe(query), cur } : null;
    if (go && cur) select({ r: cur.r, c: cur.c });
    else paint();
  }

  // A text offset in the source → its row (quoted newlines included)
  function revealOffset(offset) {
    const pre = E.text.slice(0, offset);
    const n = parse(pre, E.sep).length;
    select({ r: !pre || pre.endsWith("\n") ? n : n - 1, c: 0 });
  }

  window.Grid = {
    parse,
    serialize,
    detect,
    decode,
    normalize,
    excel,
    mount,
    unmount,
    update,
    find,
    showFind,
    revealOffset,
    active: () => ({ ...E.act }),
    isMounted: () => E.mounted,
    _state: E,
  };
})();
