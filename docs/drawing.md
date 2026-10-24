# Drawing — Canvas Editor & Integration

Drawings are notes named `*.draw`. Their content is the text format described
in [drawing-format.md](drawing-format.md); everything below is about how the
canvas edits it and plugs into the rest of the app.

## Files

| File       | Role                                                           |
| ---------- | -------------------------------------------------------------- |
| `draw.js`  | Format, geometry, SVG renderer, canvas editor (`window.Draw`)  |
| `app.js`   | Note type, tabs, commit/undo, embeds, search, export           |
| `index.html` | `#drawHost` container, split button, canvas host CSS         |

`draw.js` is **loaded on demand** (`loadDraw()`) the first time a drawing,
an embed or a drawing export is needed, and cached by the service worker
for offline use. It injects its own UI styles. No libraries.

## Note Type & Tabs

- `isDrawFile(name)` — extension `.draw`. `hasViewTab(name)` covers `.md`
  and `.draw`: both get the tab bar.
- The view switch reads **Canvas | Source** for drawings (**Edit | Preview**
  for markdown); Canvas is the second tab (`view`), Source the edit tab,
  shown first by CSS (`.seg.is-draw`). Zen is a separate button.
  `mdViewActive` is true on the canvas; `drawActive()` means "editable
  canvas is showing".
- `render()` opens the draw tab whenever the active note **changes** to a
  drawing, so drawings always open on the canvas. Browser back/forward
  restores the tab that was in the history entry.
- URL query: `?view=draw` (canvas), `?view=zen` (read-only canvas).
- Renaming between `.md` and `.draw` re-opens the matching second tab.

## Creating

| Where                         | Action                     |
| ----------------------------- | -------------------------- |
| Sidebar `+` / status `new`    | text note (unchanged)      |
| `▾` next to them              | menu: text / drawing       |
| Mobile menu, empty state      | "new drawing"              |
| Vim                           | `:draw`                    |

New drawings are named `drawingN.draw` and start empty (`""`): an empty
note needs no delete confirmation, and the header is written with the
first shape.

## Editing Model

The canvas keeps a parsed model (`Draw.parse`) and writes text back
(`Draw.serialize`) **once per finished gesture** (a stroke, a drag, a
style change, a label edit):

```
gesture ends → serialize → onCommit(text)
  → drawCommit(): pushHistory(previous) · note.content = text
    · editor.value = text · scheduleSave() · scheduleUrlUpdate()
```

So one gesture is one undo step, and saving, Drive sync, cross-tab sync and
URL updates are the same as for typing.

- **Undo/redo** use the note's normal history. On the canvas they skip vim's
  buffer logic (the canvas writes `note.content` directly) and then call
  `Draw.update(content)`.
- **Outside changes** (undo, source tab, another tab, Drive) reach the
  canvas through `render()` → `Draw.update()`. During a gesture or label
  edit they are held back and applied afterwards; if the gesture changed
  the drawing, the gesture wins (last writer, like typing).
- Lines the canvas can't read stay in the model as raw lines and are
  written back unchanged.

## Canvas

SVG, one `<g>` per shape, re-rendered only when the shape object changes
(shapes are replaced, never mutated); arrows also re-render when a shape
they're bound to changes. Selection handles live in a separate screen-space
layer so they keep their size at any zoom.

Rotation is stored, not baked in, for boxes, text and pen/highlighter
strokes (`rot=`), so a turned shape keeps a turned selection box and
resizes along its own axes. Lines and free arrow ends are turned point by
point. A turned multi-selection keeps its turned box while the selection
stays the same and is only moved; resizing it returns to an upright box.

| Input                         | Result                                   |
| ----------------------------- | ---------------------------------------- |
| Drag with a tool              | Create; box/line/arrow/text return to select |
| Click with box tool           | Default-size shape (a wedge: a ¾ pie)    |
| Click with line tool          | Path: each click adds a point; click the first point to close (takes the fill), Enter / Esc / double-click finishes, Backspace removes the last point |
| Double-click a line / a point | Add a point there / remove the point     |
| Drag a wedge's round handles  | Edges: start / end angle (shift: 15°); middle: the hole |
| Double-click shape / empty    | Edit label / new text                    |
| Double-click grouped shape    | Select just that member                  |
| Drag empty space              | Marquee select (shift adds)              |
| Space+drag, middle drag, hand | Pan                                      |
| Wheel / ctrl+wheel            | Pan / zoom at pointer                    |
| Two fingers                   | Pan + pinch zoom; quick tap = undo       |
| Pen (stylus) input            | Pressure strokes; fingers then only pan  |
| Draw tool's Pen row           | Even / Pressure / Tapered (see below)    |
| Right-click                   | Menu: stacking, duplicate, group, delete; selects the shape under the pointer first |

Keys only act while the canvas has focus (it takes focus on mount and
after toolbar clicks): tools `v h d D e r o m w l a t`, `Delete`, `Enter`
(edit label), arrows (nudge; shift ×10, grid steps when the grid is on),
`Alt+↑/↓` or `[ ]` one step forward/backward (shift: to front/back),
ctrl+a/d/g, ctrl+b/i/u (text style, also while typing), ctrl+shift+g, ctrl+'
(grid), shift+1 (fit), shift+0 (100%), `+`/`-`, `Escape` (cancel gesture,
leave group, deselect, back to select tool). `e` is the eraser here, not
"switch to edit".

Stacking moves shapes past their unselected neighbours; comment and
blank lines stay where they are in the file.

Copy/cut put the selected shapes on the clipboard **as drawing text**;
pasting drawing text adds the shapes with fresh ids (bindings and groups
follow), pasting other text creates a text shape.

## Read-only & Zen

Zen (`?view=zen`, or the zen tab) mounts the canvas read-only and always
fits the drawing: pan and zoom only. Shared zen links stay ephemeral, as
for markdown. Drawings that are too large or from a newer format version
are read-only everywhere, with a badge saying why.

## Embeds in Markdown

`renderMarkdown()` turns `![alt](name.draw)` and fenced ```` ```draw ````
blocks into `<span class="draw-embed">` placeholders (the inline source in
`data-draw`, already HTML-escaped by step 1 of the pipeline).
`setPreviewHtml()` → `hydrateDrawEmbeds()` loads `draw.js` and fills them
with `Draw.renderStatic()` SVGs built with DOM APIs — labels are text nodes,
never HTML. Referenced embeds are clickable and open the drawing.

## Style Panel

Every attribute of the format has a control, shown only where it does
something (`panelAttrs()`):

- **Fill** for boxes, wedges and lines of three or more points (and the line
  tool, for the shapes it closes). **Line → None** only for fillable shapes,
  and never together with no fill, so a shape can't turn invisible.
- **Corners** (round / square) for rectangles; **Opacity** for everything.
- **Pen** for the draw tool and selected strokes: *Pen* (even width and
  bare: every move kept, drawn straight from point to point, so corners stay),
  *Sharpie* (a marker: width from pressure — a stylus's, or simulated from
  speed for mouse and touch, faster is thinner — kept in the upper two thirds so
  it's bold and never a hairline, starting with a little pooled ink), or
  *Brush pen* (pressure all the way down, ends narrowing to a point). Sharpie
  sets `th` (thinning), Brush pen also `tp` (taper length), both from the
  stroke size: subtle at XS, extreme at XL, and they follow a size change.
  Both are streamlined more than Pen. Strokes without `th` keep the classic
  pressure look. Until a mode is picked: Sharpie for a stylus, Pen otherwise.
- **Text, Font, Style** once a shape has a label (always for text). Free text
  aligns left / centre / right only, and keeps its place when realigned.
- Wedge angles and hole are edited with handles on the shape, path points by
  dragging and double-clicking. A hint at the top of the canvas explains
  these gestures while they apply (line tool, a path being built, a selected
  line or wedge).

## Search, Export, Import

- **Search** indexes only labels (`drawSearchLines()`), not coordinates.
- **⋯ menu** on a drawing: *Copy as PNG* (clipboard, falls back to a
  download) and *Download as SVG*. Exports use the dark background and embed
  the fonts their text uses as data URLs (`fontFaces()`), so a file looks the
  same anywhere and the PNG (an SVG drawn as an image, which can't load web
  fonts) gets them too.
- **Export all** adds `name.draw.svg` next to each drawing and lists them in
  `.note.directory` → `renders`; importing that zip skips them.

## Storage Keys

| Key                  | Content                                   |
| -------------------- | ----------------------------------------- |
| `notepad_draw_style` | Last used colour/size/fill/dash/alignment/font/arrowheads |

The camera per drawing is kept in memory for the session only.
