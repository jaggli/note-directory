// Doc shell: navigation, page loading, theme, and the shared screen parts
// (data-part="…") that screens are composed from.

const GROUPS = [
  { pages: [["brief", "Redesign brief"], ["parity", "Parity check"]] },
  {
    title: "Foundations",
    pages: [["color", "Color and themes"], ["type", "Typography"], ["shape", "Space, shape, motion"], ["icons", "Icons"]],
  },
  {
    title: "Components",
    pages: [
      ["buttons", "Buttons and keys"],
      ["controls", "Fields and controls"],
      ["sidebar", "Sidebar and rows"],
      ["bars", "Title bar and status bar"],
      ["menus", "Menus"],
      ["search", "Palette and find"],
      ["feedback", "Toasts, banners, dialogs"],
      ["drawing", "Drawing tools"],
      ["mobile-parts", "Phone parts"],
    ],
  },
  {
    title: "Screens",
    pages: [
      ["s-editor", "Writing markdown"],
      ["s-preview", "Preview and zen"],
      ["s-drawing", "Drawing"],
      ["s-search", "Search and commands"],
      ["s-share", "Sharing"],
      ["s-open-link", "Opening a shared link"],
      ["s-delete", "Delete and undo"],
      ["s-import", "Import"],
      ["s-sync", "Sync and storage"],
      ["s-settings", "Settings"],
      ["s-first-run", "First run and empty"],
      ["s-phone", "Phone"],
    ],
  },
  { title: "Current app", pages: [["current", "Screenshots today"]] },
];

const $ = (s, el = document) => el.querySelector(s);
const ic = (id, cls = "") => `<svg class="n-icon ${cls}"><use href="#i-${id}"/></svg>`;
const kbd = (k) => `<span class="n-kbd">${k}</span>`;

const NOTES = [
  ["todo.md", "2m", true],
  ["release-notes.md", "now"],
  ["architecture.draw", "1h"],
  ["deploy.sh", "3h"],
  ["meeting-2026-10-14.md", "5d"],
  ["config.yaml", "1w"],
  ["ideas.md", "2w"],
  ["scratch.txt", "1mo"],
  ["help.md", "1mo"],
];

const kind = (name) => {
  const ext = name.split(".").pop();
  if (ext === "md") return ["md", "note"];
  if (ext === "draw") return ["draw", "file-draw"];
  if (ext === "txt") return ["", "note"];
  return ["code", "file-code"];
};
const splitName = (name) => {
  const i = name.lastIndexOf(".");
  return [name.slice(0, i), name.slice(i)];
};

const row = (name, meta, pinned, o = {}) => {
  const [k, icon] = kind(name);
  const [base, ext] = splitName(name);
  const cls = [o.active && "active", o.hover && "hover", o.removed && "removed"].filter(Boolean).join(" ");
  const label = o.rename
    ? `<input value="${o.renameValue ?? name}" />`
    : `<span class="name">${base}<span class="ext">${ext}</span></span>`;
  const badge = o.badge ? `<span class="n-badge warning">${o.badge}</span>` : "";
  return `<div class="n-row ${cls}">${ic(icon, "kind " + k)}${label}${badge}
    ${o.rename ? "" : `<span class="meta">${meta}</span>
    <span class="acts"><button class="n-btn ghost sm icon" title="${pinned ? "Unpin" : "Pin"}">${ic(pinned ? "pin-on" : "pin", "sm")}</button><button class="n-btn ghost sm icon" title="More">${ic("more", "sm")}</button></span>`}</div>`;
};

const FOOT = {
  ok: `<div class="n-sync"><span class="n-dot ok"></span><span class="grow">Synced to Google Drive</span><span>2m ago</span></div>`,
  busy: `<div class="n-sync"><span class="n-dot busy"></span><span class="grow">Syncing…</span></div>`,
  fail: `<div class="n-sync"><span class="n-dot fail"></span><span class="grow"><b>Sync paused</b> · sign-in expired</span><button class="n-btn sm">Reconnect</button></div>`,
  local: `<div class="n-sync">${ic("lock", "sm")}<span class="grow">Only in this browser</span><button class="n-btn ghost sm">Back up…</button></div>`,
  storage: `<div class="n-sync"><span class="n-dot ok"></span><span class="grow">Synced to Google Drive</span><span>just now</span></div>
    <div class="n-storage"><div class="n-sync" style="min-height:0"><span class="grow">Browser storage</span><span>3.6 of 5 MB</span></div><div class="n-meter warn"><i style="width:72%"></i></div></div>`,
};

const PARTS = {
  sidebar(d) {
    const notes = d.notes ? JSON.parse(d.notes) : NOTES;
    const rows = (list) =>
      list
        .map(([n, m, p, extra = {}]) =>
          row(n, m, p, {
            active: n === d.active,
            hover: n === d.hover,
            rename: n === d.rename,
            renameValue: d.renameValue,
            removed: n === d.removed,
            ...extra,
          }),
        )
        .join("");
    const pinned = notes.filter((n) => n[2]);
    const rest = notes.filter((n) => !n[2]);
    return `<aside class="n-sidebar">
      <div class="n-side-head">
        <button class="n-brand"><img src="../img/favicon-32x32.png" alt=""/>note${ic("chev-down")}</button>
        <span class="grow"></span>
        <span class="n-split"><button class="n-btn ghost icon" title="New note  ⌃N">${ic("plus")}</button><button class="n-btn ghost" title="New note or drawing">${ic("chev-down", "sm")}</button></span>
      </div>
      <div class="n-side-search"><div class="n-field">${ic("search", "sm")}<input placeholder="Search" readonly />${kbd("⌘P")}</div></div>
      <div class="n-list">
        ${pinned.length ? `<div class="n-section-label">Pinned</div>${rows(pinned)}<div class="n-section-label">Notes</div>` : ""}
        ${rows(rest)}
      </div>
      <div class="n-side-foot">${FOOT[d.foot || "ok"]}</div>
    </aside>`;
  },

  titlebar(d) {
    const [base, ext] = splitName(d.name || "release-notes.md");
    const isDraw = ext === ".draw";
    const isMd = ext === ".md";
    const view = d.view || (isDraw ? "canvas" : "edit");
    const seg = isMd
      ? `<div class="n-seg"><button aria-pressed="${view === "edit"}">${ic("code", "sm")}Edit</button><button aria-pressed="${view === "preview"}">${ic("eye", "sm")}Preview</button></div>`
      : isDraw
        ? `<div class="n-seg"><button aria-pressed="${view === "canvas"}">${ic("file-draw", "sm")}Canvas</button><button aria-pressed="${view === "source"}">${ic("code", "sm")}Source</button></div>`
        : `<span class="grow"></span>`;
    const name = d.rename
      ? `<span class="n-crumb"><input value="${base}${ext}" /></span>`
      : `<button class="n-crumb"><span class="name">${base}<span class="ext">${ext}</span></span><span class="state">${d.state ?? "Saved"}</span></button>`;
    return `<header class="n-titlebar">
      ${d.side === "closed" ? `<button class="n-btn ghost icon" title="Show sidebar  ⌘\\">${ic("sidebar")}</button>` : ""}
      ${name}
      ${seg}
      ${isMd || isDraw ? `<button class="n-btn ghost icon" title="Zen: read without the chrome">${ic("zen")}</button>` : ""}
      <button class="n-btn ${d.share === "open" ? "primary" : ""}">${ic("share", "sm")}Share</button>
      <button class="n-btn ghost icon" title="Note actions">${ic("more")}</button>
    </header>`;
  },

  status(d) {
    const k = d.kind || "md";
    const wrap = `<button class="n-status-item" aria-pressed="${d.wrap !== "off"}">${ic("wrap", "sm")}Wrap</button>`;
    const vimOn = d.vim && d.vim !== "off";
    const vim = vimOn
      ? `<button class="n-status-item" aria-pressed="true"><span class="n-vim ${d.vim}">${d.vim.split(" ")[0].toUpperCase()}</span>Vim</button>`
      : `<button class="n-status-item" aria-pressed="false">Vim</button>`;
    if (k === "preview")
      return `<footer class="n-status"><span class="n-status-item">Markdown</span><span class="n-status-item">412 words · 2 min read</span><span class="grow"></span><span class="n-status-item">Press ${kbd("E")} to edit</span></footer>`;
    if (k === "draw")
      return `<footer class="n-status"><span class="n-status-item">Drawing</span><span class="n-status-item">${d.info || "14 shapes"}</span><span class="grow"></span><button class="n-status-item" aria-pressed="true">${ic("grid", "sm")}Grid</button></footer>`;
    const lang = { md: "Markdown", code: "Shell", text: "Plain text" }[k];
    return `<footer class="n-status"><span class="n-status-item">${lang}</span><span class="n-status-item">${d.pos || "Ln 9, Col 24"}</span>${d.sel ? `<span class="n-status-item">${d.sel}</span>` : ""}<span class="grow"></span>${wrap}${vim}</footer>`;
  },

  editor(d) {
    const L = [
      `<span class="h-h"># Release 4.2</span>`,
      ``,
      `Ships <span class="h-b">**Thursday**</span>. Owner: @mira`,
      ``,
      `<span class="h-h">## Checklist</span>`,
      ``,
      `<span class="h-mark">- [x]</span> Freeze <span class="h-str">\`main\`</span>`,
      `<span class="h-mark">- [x]</span> Changelog draft`,
      `<span class="h-mark">- [ ]</span> Smoke test on staging`,
      `  <span class="h-mark">- [ ]</span> Checkout flow`,
      `  <span class="h-mark">- [ ]</span> Search`,
      `<span class="h-mark">- [ ]</span> Announce in #releases`,
      ``,
      `<span class="h-h">## Notes</span>`,
      ``,
      `Rollback plan lives in <span class="h-link">[deploy.sh](deploy.sh)</span>.`,
      `See the <span class="h-link">[architecture](architecture.draw)</span> drawing.`,
      ``,
      `<span class="h-cmt">\`\`\`sh</span>`,
      `./deploy.sh --env prod --tag <span class="h-str">v4.2.0</span>`,
      `<span class="h-cmt">\`\`\`</span>`,
      ``,
      `<span class="h-mark">&gt;</span> Search index rebuild takes ~12 min.`,
      ``,
      `<span class="h-h">## Rollout</span>`,
      ``,
      `<span class="h-num">1.</span> Canary at <span class="h-num">5%</span> for one hour`,
      `<span class="h-num">2.</span> Watch error rate on the dashboard`,
      `<span class="h-num">3.</span> Full rollout`,
    ];
    const cur = +(d.cur || 9);
    if (d.caret !== "none") L[cur - 1] = L[cur - 1].replace("staging", d.vim ? 'stagin<span class="vimblock">g</span>' : 'staging<span class="caret"></span>');
    if (d.find) L.forEach((l, i) => (L[i] = l.replace(/(Search|search)/g, '<span class="occ">$1</span>')));
    const gutter = L.map((_, i) => (i + 1 === cur ? `<b>${i + 1}</b>` : i + 1)).join("\n");
    const text = L.map((l, i) => (i + 1 === cur ? `<span class="cur">${l || " "}</span>` : l)).join("\n");
    return `<div class="n-editor"><div class="gutter" style="white-space:pre">${gutter}</div><div class="text">${text}</div></div>`;
  },

  canvas(d) {
    const box = (x, y, w, h, label, c, fill) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill ? `color-mix(in srgb, var(--p-${c}) 16%, transparent)` : "none"}" stroke="var(--p-${c})" stroke-width="2"/>
       <text x="${x + w / 2}" y="${y + h / 2 + 5}" text-anchor="middle" fill="var(--p-text)" font-family="var(--n-mono)" font-size="15">${label}</text>`;
    const arrow = (x1, y1, x2, y2, dash) =>
      `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="var(--p-subtext)" stroke-width="2" fill="none" ${dash ? 'stroke-dasharray="6 6"' : ""} marker-end="url(#ah)"/>`;
    return `<svg viewBox="0 0 900 520" style="position:absolute;inset:0;width:100%;height:100%">
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--p-subtext)"/></marker></defs>
      ${box(110, 90, 190, 70, "Browser tab", "blue", true)}
      ${box(110, 300, 190, 70, "IndexedDB", "green", true)}
      ${box(470, 90, 190, 70, "Worker", "mauve", d.sel)}
      ${box(470, 300, 190, 70, "Google Drive", "peach", d.sel)}
      ${arrow(205, 160, 205, 296)}
      ${arrow(300, 125, 466, 125)}
      ${arrow(565, 160, 565, 296, true)}
      <text x="383" y="112" text-anchor="middle" fill="var(--p-subtext)" font-family="var(--n-mono)" font-size="12">sign-in</text>
      <text x="575" y="235" fill="var(--p-subtext)" font-family="var(--n-mono)" font-size="12">tokens only</text>
      <path d="M690 400 q40 -60 90 -10 t70 -20" stroke="var(--p-yellow)" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="700" y="440" fill="var(--p-yellow)" font-family="var(--n-mono)" font-size="14">notes never pass here</text>
      ${d.sel ? `<rect x="462" y="82" width="206" height="296" fill="none" stroke="var(--p-blue)" stroke-width="1.5"/>
        ${[[462, 82], [668, 82], [462, 378], [668, 378]].map(([x, y]) => `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="var(--p-bg)" stroke="var(--p-blue)" stroke-width="1.5"/>`).join("")}` : ""}
    </svg>`;
  },

  preview() {
    return `<div class="n-preview"><div class="prose">
      <h1>Release 4.2</h1>
      <p>Ships <b>Thursday</b>. Owner: @mira</p>
      <h2>Checklist</h2>
      <ul>
        <li class="task done"><span class="n-check" aria-checked="true"></span><span>Freeze <code>main</code></span></li>
        <li class="task done"><span class="n-check" aria-checked="true"></span><span>Changelog draft</span></li>
        <li class="task"><span class="n-check"></span><span>Smoke test on staging</span></li>
        <li class="task" style="margin-left:2px"><span class="n-check"></span><span>Checkout flow</span></li>
        <li class="task"><span class="n-check"></span><span>Announce in #releases</span></li>
      </ul>
      <h2>Notes</h2>
      <p>Rollback plan lives in <a href="#">deploy.sh</a>. See the <a href="#">architecture</a> drawing.</p>
      <pre><span class="h-cmt">1</span>  ./deploy.sh --env prod --tag <span class="h-str">v4.2.0</span></pre>
    </div></div>`;
  },
};

function renderParts(root) {
  root.querySelectorAll("[data-part]").forEach((el) => {
    el.outerHTML = PARTS[el.dataset.part](el.dataset);
  });
  // <i data-i="plus" class="sm"> is shorthand for a sprite icon
  root.querySelectorAll("i[data-i]").forEach((el) => {
    el.outerHTML = ic(el.dataset.i, el.className).replace("<svg ", `<svg style="${el.getAttribute("style") || ""}" `);
  });
}

// Every themed specimen follows the picker; data-fixed keeps its own theme
function applyTheme(root = document) {
  const t = $("#themeSelect").value;
  document.documentElement.dataset.theme = t;
  root.querySelectorAll(".doc-page [data-theme]:not([data-fixed])").forEach((el) => (el.dataset.theme = t));
}

function applyCompare(page) {
  page.querySelectorAll(".twin").forEach((w) => w.replaceWith(w.firstElementChild));
  if (!$("#compare").checked) return;
  const other = $("#themeSelect").value === "latte" ? "mocha" : "latte";
  page.querySelectorAll(".frame, .board").forEach((el) => {
    if (el.closest(".twin") || el.closest(".frames") || el.dataset.single !== undefined) return;
    const clone = el.cloneNode(true);
    clone.querySelectorAll("[data-theme]").forEach((n) => ((n.dataset.theme = other), (n.dataset.fixed = "")));
    if (clone.dataset.theme) ((clone.dataset.theme = other), (clone.dataset.fixed = ""));
    if (clone.classList.contains("board")) ((clone.dataset.theme = other), (clone.dataset.fixed = ""));
    const twin = document.createElement("div");
    twin.className = "twin";
    el.replaceWith(twin);
    twin.append(el, clone);
  });
  page.classList.add("compare-on");
}

// Frames are drawn at real size and zoomed down to fit their column
function fitFrames() {
  document.querySelectorAll(".frame:not(.phone) > .n").forEach((n) => {
    const w = parseFloat(getComputedStyle(n).getPropertyValue("--w"));
    const avail = n.parentElement.clientWidth;
    n.style.zoom = Math.min(1, avail / w);
  });
}

async function show(id) {
  const all = GROUPS.flatMap((g) => g.pages.map((p) => [...p, g.title]));
  const entry = all.find((p) => p[0] === id) || all[0];
  document.querySelectorAll(".doc-nav a").forEach((a) => a.classList.toggle("on", a.hash === "#" + entry[0]));
  $("#crumb").textContent = [entry[2], entry[1]].filter(Boolean).join(" › ");
  const page = $("#page");
  const res = await fetch(`pages/${entry[0]}.html`);
  page.innerHTML = res.ok ? await res.text() : `<p class="prose">Missing page: ${entry[0]}</p>`;
  renderParts(page);
  page.querySelectorAll(".board:not([data-theme])").forEach((b) => (b.dataset.theme = ""));
  applyTheme();
  applyCompare(page);
  page.scrollTop = 0;
  requestAnimationFrame(fitFrames);
}

$("#navGroups").innerHTML = GROUPS.map(
  (g) =>
    `<div class="doc-group">${g.title ? `<h6>${g.title}</h6>` : ""}${g.pages.map(([id, t]) => `<a href="#${id}">${t}</a>`).join("")}</div>`,
).join("");

try {
  $("#themeSelect").value = localStorage.getItem("ds-theme") || "mocha";
  $("#compare").checked = localStorage.getItem("ds-compare") === "1";
} catch {}
$("#themeSelect").addEventListener("change", () => {
  try { localStorage.setItem("ds-theme", $("#themeSelect").value); } catch {}
  show(location.hash.slice(1));
});
$("#compare").addEventListener("change", () => {
  try { localStorage.setItem("ds-compare", $("#compare").checked ? "1" : "0"); } catch {}
  show(location.hash.slice(1));
});
addEventListener("hashchange", () => show(location.hash.slice(1)));
addEventListener("resize", fitFrames);
applyTheme();
show(location.hash.slice(1));
