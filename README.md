# note — minimal text editor

[https://note.directory](https://note.directory)

A private, local-first text editor that runs entirely in
your browser. No data is collected, transmitted, or stored
on any server. No signup, no backend, no dependencies.
Just open the page and start typing.

Built as a single `index.html` file with vanilla JS and
CSS (~9900 lines). Your notes are stored in `localStorage`
by default. Optionally, sign in with Google to sync notes
across devices via Google Drive.

## How it works

- **Single file**: The entire app is one self-contained
  HTML file (~9900 lines). No build step, no bundler,
  no framework.
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
  the app. The Google library is lazy-loaded only when
  you initiate sync.
- **Offline**: Works fully offline. The only external
  asset is the Victor Mono font file served alongside
  the HTML.

<details>
<summary><strong>Features</strong></summary>

- Syntax highlighting for 12 languages
  (JS, TS, Python, Rust, Go, CSS/SCSS, HTML/XML,
  JSON, YAML, TOML, Markdown, Shell/Bash)
- Fuzzy search across all notes
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
- Indent/dedent selection with Tab/Shift+Tab
- Move lines up/down with Alt+Arrow keys
- Undo/redo with per-note history
- Browser back/forward for note and tab switches
- Delete confirmation dialog
- Built-in help page (accessible from file menu)
- Mobile-optimized UI with touch-friendly controls

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
| Ctrl+P / Ctrl+F | Search all notes                               |
| Ctrl+H          | Find & replace                                 |
| Ctrl+S          | Format (`.md` only) + save + sync              |
| Ctrl+Shift+D    | Delete note                                    |
| Ctrl+Shift+F    | Format markdown                                |
| Ctrl+Shift+M    | Toggle vim mode                                |
| Ctrl+Z          | Undo                                           |
| Ctrl+Shift+Z    | Redo                                           |
| Tab             | Insert 2 spaces / indent selection             |
| Shift+Tab       | Dedent selection                               |
| Alt+↑ / Alt+↓   | Move line up / down                            |
| e               | Switch from view/zen to edit tab               |
| Escape          | Close search / sidebar / find bar / exit zen   |

When vim mode is active, standard vim keybindings take
precedence in the editor. The shortcuts above still work
in input fields (search, find & replace).

</details>

## Claude Code skills

Two companion Claude Code skills let you decode and create `note.directory` links from chat: `note-directory-read` and `note-directory-share`.

See [skills/README.md](skills/README.md) for usage and install instructions.

## Tech

- **Theme**: [Catppuccin Mocha](https://catppuccin.com)
- **Font**: [Victor Mono](https://github.com/rubjo/victor-mono)
  by Rune Bjørnerås (served locally)
- **Compression**: deflate-raw via `CompressionStream` /
  `DecompressionStream` APIs for URL sharing
- **Zip**: Custom minimal zip builder (no library)
  for multi-note download
- **Google Drive**: OAuth 2.0 via Google Identity
  Services (lazy-loaded). Drive API calls use plain
  `fetch` — no `gapi` client library needed

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

Thanks to [Rune Bjørnerås](https://github.com/rubjo) for
creating [Victor Mono](https://github.com/rubjo/victor-mono),
the fantastic font used throughout the editor.
