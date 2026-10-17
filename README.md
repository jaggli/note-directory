# note — minimal editor

[https://note.directory](https://note.directory)

A private, local-first editor for text and drawings that
runs entirely in your browser. No data is collected, transmitted, or stored
on any server. No signup, no backend, no dependencies, no BS.
Just open the page and start typing.

Built as `index.html` + `app.js` (+ `draw.js` for
drawings) with vanilla JS and CSS (~12k lines). Your notes are stored in `localStorage`
by default. Optionally, sign in with Google to sync notes
across devices via Google Drive.

## How it works

- **Three files**: `index.html` (markup + CSS), `app.js`
  and `draw.js` (the drawing canvas, loaded only when a
  drawing is opened). No build step, no bundler, no
  framework. Scripts are external so the CSP can forbid
  inline scripts.
- **Drawings are text**: a `.draw` note is one line per
  shape, so it saves, syncs, shares by URL, searches and
  exports exactly like any other note (see
  [docs/drawing-format.md](docs/drawing-format.md)).
- **Local storage**: Notes are persisted in your
  browser's `localStorage` (5MB limit). A storage meter
  appears when usage exceeds 200kB.
- **Cross-tab sync**: Open the editor in multiple tabs —
  changes to notes, sidebar width, word wrap, vim mode,
  and pin state sync instantly via `storage` events.
- **URL sharing**: Notes can be shared via URL using
  deflate-raw compression encoded in hash parameters.
  The shared note is embedded in the link itself — no
  server involved (~60kB URL limit). Sensitive data
  (name, content) stays in the hash fragment, never
  sent to servers.
- **Google Drive sync**: Optionally sign in with Google
  to sync notes across devices. Files are stored in your
  Google Drive's hidden app folder — no storage cost to
  the app. Sign-in goes through a tiny Cloudflare Worker
  (`worker.js`) that keeps Google's refresh token in an
  encrypted HttpOnly cookie, so access tokens renew
  without pop-ups. Notes never pass through it.
- **Works offline**: After the first visit a service
  worker caches the app, so it opens and edits without a
  network (Drive sync aside). Installable as a PWA.

<details>
<summary><strong>Features</strong></summary>

- Syntax highlighting for 12 languages
  (JS, TS, Python, Rust, Go, CSS/SCSS, HTML/XML,
  JSON, YAML, TOML, Markdown, Shell/Bash)
- Search: Ctrl+F finds lines in the current note, Ctrl+P
  fuzzy-searches all notes (switch with a checkbox or the
  other shortcut)
- Find & replace within a note
- Drag-and-drop file import
- Drag to reorder notes in sidebar
- Pin notes to keep them at the top
- Export all notes as a ZIP (includes metadata for re-import)
- Import notes by dropping ZIP or text files onto the editor
- Google Drive sync with per-file conflict resolution
- Vim mode (toggle in status bar, desktop only)
- Word wrap toggle with wrap-aware line numbers
- Current line highlighting
- Markdown preview with edit/view/zen tabs for `.md` files
- Inter-note linking (`[label](other.md)`) with browser
  back/forward navigation between notes
- Heading anchors in preview (hover to reveal `#` link,
  click to copy shareable URL with anchor)
- Clickable anchor links (`[link](#heading)`) scroll
  to the target heading in preview
- Code block copy button (hover to reveal, click to copy)
- Line numbers in code blocks, except ` ```text `,
  ` ```txt ` and ` ```plain `
- Lists continue on Enter (`-`, `+`, `*`, `1.`, `- [ ]`);
  Enter on an empty item ends the list
- Download a markdown note as standalone HTML (menu,
  or the download button in zen), styled like zen and
  free of scripts
- Syntax-highlighted fenced code blocks in preview
  (when a language tag is specified)
- Tables with column alignment (left, center, right)
- Horizontal rules
- `<details>`/`<summary>` collapsible sections
- Interactive task checkboxes with cascading
  parent/child toggling
- Markdown formatter (`:fmt` or Ctrl+Shift+F) for
  consistent heading, list, table, and whitespace style
- Zen mode for distraction-free reading
- Cursor position memory (persisted per note across
  sessions and mode switches)
- Cursor position (line/column) and vim mode indicator in status bar
- Indent/dedent selection with Tab/Shift+Tab; at the start of a markdown list item they change its nesting level
- Move lines up/down with Alt+Arrow keys
- Undo/redo with per-note history
- Browser back/forward for note and tab switches
- Delete confirmation dialog
- Built-in help page (accessible from the menu)
- Mobile-optimized UI with touch-friendly controls

</details>

<details>
<summary><strong>Drawings</strong></summary>

Pick **drawing** from the ▾ next to + (or `:draw` in vim).
Drawings open on a canvas; **file → source** shows the
text behind them and **zen** shows them read-only.

- Tools: select, hand, pen (pressure-sensitive with a
  stylus), highlighter, eraser, rectangle, ellipse,
  diamond, line, arrow, text
- Move, resize and rotate (shift: keep proportions, 15°
  steps); marquee and shift-click selection
- Arrows attach to shapes and follow them; drag the middle
  handle to curve them; labels on arrows
- Text inside shapes (double-click), free text anywhere
- 12 colours, 4 sizes, fill (none / light / solid), solid /
  dashed / dotted lines, label alignment in boxes (left /
  center / right, top / middle / bottom), arrowheads per
  end (open, triangle, dot, diamond, bar), bold / italic /
  underline for any text
- Group / ungroup, duplicate, copy & paste (as drawing
  text), bring forward / backward / to front / to back
  (keys, right-click menu, style panel), nudge with arrows
- Toggleable grid with snapping, stored in the drawing
- Pan and zoom with mouse, trackpad, keyboard or two
  fingers; zoom to fit
- Undo/redo per gesture, shared with the note history
- Copy as PNG, download as SVG; "export all" adds an SVG
  of every drawing
- Embed in markdown: `![label](sketch.draw)` or a fenced
  ` ```draw ` block (travels with a shared link)
- Search finds the text in drawings

| Key                   | Action                              |
| --------------------- | ----------------------------------- |
| v h d e               | select, hand, draw, eraser          |
| Shift+D               | highlighter                         |
| r o m l a t           | rectangle, ellipse, diamond, line, arrow, text |
| Enter / double-click  | write in the selected shape         |
| Delete                | delete selection                    |
| Ctrl+D / Ctrl+G       | duplicate / group (Shift: ungroup)  |
| Alt+↓ / Alt+↑ or [ / ] | backward / forward (Shift: to back / front) |
| Right-click           | menu: stacking, duplicate, group, delete |
| Arrows                | nudge (Shift: 10)                   |
| Space+drag / scroll   | pan                                 |
| Ctrl+scroll / + / -   | zoom                                |
| Shift+1 / Shift+0     | zoom to fit / 100%                  |
| Ctrl+'                | toggle grid                         |
| Ctrl+B / I / U        | bold / italic / underline (also while typing) |

</details>

<details>
<summary><strong>Vim mode</strong></summary>

Toggle vim mode via the `vim` button in the toolbar
(desktop only, hidden on touch devices). The setting
persists in localStorage and syncs via Google Drive.

Supported modes: **Normal**, **Insert**, **Visual**,
**Visual Line**, and **Command** (`:` prompt).

Features include:
- Modal editing with block cursor in normal mode
- Motions: `h` `j` `k` `l` `w` `b` `e` `0` `$` `^`
  `gg` `G` `{` `}` `_` `f`/`F`/`t`/`T` with `;` `,` repeat
- Operators: `d` `c` `y` with motions and text objects
  (`iw` `aw` `i"` `a(` etc.)
- Line operations: `dd` `cc` `yy` `>>` `<<` `J` `p` `P`
- Visual selection with `v`, visual line with `V`
- Dot repeat (`.`) for most editing commands
- Search with `/` (forward) and `?` (backward), `n`/`N`
  to navigate matches, `*`/`#` to search word under cursor
- Command mode (`:`) with `:set wrap`, `:set nowrap`,
  `:new`, `:e <name>`, `:view` (markdown preview),
  `:fmt` (format markdown), `:mddemo` (demo file),
  `:help`, `:<number>` (jump to line),
  `:%s/find/replace/g` (opens find & replace)
- Count prefixes (e.g. `3dw`, `5j`, `2>>`)

</details>

<details>
<summary><strong>Keyboard shortcuts</strong></summary>

| Shortcut        | Action                                         |
| --------------- | ---------------------------------------------- |
| Ctrl+N          | New note                                       |
| Ctrl+F          | Search the current note (line by line)         |
| Ctrl+P          | Search all notes                               |
| Ctrl+H          | Find & replace                                 |
| Ctrl+S          | Format (`.md` only) + save + sync              |
| Ctrl+Shift+D    | Delete note                                    |
| Ctrl+Shift+F    | Format markdown                                |
| Ctrl+Shift+M    | Toggle vim mode                                |
| Ctrl+Z          | Undo                                           |
| Ctrl+Shift+Z    | Redo                                           |
| Tab             | Insert 2 spaces / indent selection or list item |
| Shift+Tab       | Dedent selection or list item                   |
| Alt+↑ / Alt+↓   | Move line up / down                            |
| e               | Switch from view/zen to edit tab               |
| Escape          | Close search / sidebar / find bar / exit zen   |

When vim mode is active, standard vim keybindings take
precedence in the editor. The shortcuts above still work
in input fields (search, find & replace).

</details>

## For LLMs

[`llms.txt`](https://note.directory/llms.txt) explains the link
format and the drawing format, so any LLM can read and
create note.directory links.

## Claude Code skills

Two companion Claude Code skills let you decode and create `note.directory` links from chat: `note-directory-read` and `note-directory-share`.

See [skills/README.md](skills/README.md) for usage and install instructions.

## Who's Using It

- [serge.ai](https://www.serge.ai/) by [superstellar.io](https://www.superstellar.io/)
- [snyps.io](https://snyps.io/) by [veanu.ch](https://www.veanu.ch/)

## Tech

- **Theme**: [Catppuccin Mocha](https://catppuccin.com)
- **Font**: [Victor Mono](https://github.com/rubjo/victor-mono)
  by Rune Bjørnerås (served locally, SIL OFL 1.1 — see
  `victor-mono/OFL.txt`)
- **Compression**: deflate-raw via `CompressionStream` /
  `DecompressionStream` APIs for URL sharing
- **Drawing**: hand-written SVG canvas (no libraries);
  pressure strokes are filled outlines, input is smoothed
  and simplified (Ramer–Douglas–Peucker) before saving
- **Zip**: Custom minimal zip builder (no library)
  for multi-note download
- **Google Drive**: OAuth 2.0 via Google Identity
  Services (lazy-loaded). Drive API calls use plain
  `fetch` — no `gapi` client library needed

## Tests

The app itself has no dependencies; Playwright is only
used for browser tests (they serve the repo with
`python3 -m http.server`):

```sh
npm install
npx playwright install chromium
npm test
```

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Thanks to [Rune Bjørnerås](https://github.com/rubjo) for
creating [Victor Mono](https://github.com/rubjo/victor-mono),
the fantastic font used throughout the editor.
