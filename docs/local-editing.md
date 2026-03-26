# Local Editing — Architecture & Flows

## Editor Architecture

The editor uses a **grid-based overlay** system. Three elements are stacked in the same CSS grid cell (`grid-area: 1 / 1 / 2 / 2`):

```
┌──────────┬─────────────────────────────────────┬────────┐
│          │  highlight-layer  (z-index: 0)      │        │
│  gutter  │  ─ opaque background, colored spans │ occur- │
│          │  ─ pointer-events: none             │ rence  │
│  (line   │                                     │ track  │
│  numbers)│  occurrence-overlay (z-index: 0)    │ (z: 4) │
│          │  ─ absolutely-positioned highlights │        │
│          │  ─ pointer-events: none             │ 8px    │
│          │  ─ transform-synced to scroll       │ wide   │
│          │                                     │        │
│          │  textarea  (z-index: 1)             │        │
│          │  ─ transparent text & background    │        │
│          │  ─ receives all input               │        │
│          │  ─ caret-color: visible             │        │
│          │  ─ ::selection visible (rgba blue)  │        │
└──────────┴─────────────────────────────────────┴────────┘
```

The user types in the textarea (transparent text), but sees syntax-highlighted text rendered in the `<pre>` layer behind it. The occurrence overlay sits between the highlight layer and textarea, rendering in-text highlights for selected text occurrences. The textarea's `::selection` pseudo-element shows through because the textarea is on top.

**Scroll sync:** The textarea's `scroll` event synchronizes all layers:

```
editor.scroll → gutter.scrollTop = editor.scrollTop
              → highlightLayer.scrollTop = editor.scrollTop
              → highlightLayer.scrollLeft = editor.scrollLeft
              → syncOccurrenceScroll()  (transform-based)
```

---

## localStorage Handling

### Storage Keys

| Key                        | Content                | Purpose                                |
| -------------------------- | ---------------------- | -------------------------------------- |
| `notepad_data`             | Full state JSON        | Notes, activeId, deletedIds            |
| `notepad_wrap`             | `"true"` / `"false"`   | Word wrap toggle                       |
| `notepad_vim`              | `"true"` / `"false"`   | Vim mode toggle                        |
| `notepad_sidebar_width`    | Pixel value            | Sidebar width                          |
| `notepad_swap_<noteId>`    | `{content, timestamp}` | Vim unsaved buffer                     |
| `notepad_tab_leader`       | Tab ID string          | Current leader tab                     |
| `notepad_gdrive_token`     | `{token, expiry}`      | OAuth token (see google-drive-flow.md) |
| `notepad_gdrive_connected` | `"true"`               | Drive sync opted in                    |

### State Structure

```json
{
  "notes": [
    {
      "id": "m1abc2def",
      "name": "todo.md",
      "content": "...",
      "updatedAt": 1711234567890,
      "pinned": true,
      "cursorPos": 42
    }
  ],
  "activeId": "m1abc2def",
  "deletedIds": ["old-id-1", "old-id-2"]
}
```

### Save Flow

```
saveState()
  → if (!isTabLeader) return          only the active tab writes
  → localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  → updateStorageUsage()              refresh the storage meter UI
```

### Storage Quota

- **Limit:** 5 MB (`STORAGE_LIMIT = 5 * 1024 * 1024`)
- **Calculation:** iterates all localStorage keys, sums `(key.length + value.length) * 2` (UTF-16)
- **Checked before:** note creation, file import, drag-and-drop
- **On overflow:** modal displayed, operation cancelled

---

## Debounced Saves

Editing triggers a chain of debounced operations:

```
editor "input" event
  ├─ note.content = editor.value          immediate (in-memory)
  ├─ scheduleHighlight()                  30ms  → updateHighlight()
  ├─ scheduleSave()                       300ms → saveState() → scheduleDriveUpload()
  ├─ scheduleHistorySnapshot()            400ms → pushHistory()
  └─ scheduleUrlUpdate()                  500ms → updateUrl()
```

| Operation               | Debounce | Function                    | Purpose                     |
| ----------------------- | -------- | --------------------------- | --------------------------- |
| Syntax highlight        | 30ms     | `scheduleHighlight()`       | Re-render highlight layer   |
| Persist to localStorage | 300ms    | `scheduleSave()`            | Batch rapid keystrokes      |
| Undo history snapshot   | 400ms    | `scheduleHistorySnapshot()` | Group edits into undo steps |
| URL update              | 500ms    | `scheduleUrlUpdate()`       | Compress content into URL   |
| Cursor position save    | 1000ms   | `cursorSaveTimeout`         | Persist cursor pos to state |
| Drive upload            | 30s      | `scheduleDriveUpload()`     | Batch multiple saves        |

### Flush on Tab Close

```
window "beforeunload"
  → if (isTabLeader && saveTimeout)
    → clearTimeout(saveTimeout)
    → saveState()                          force immediate persist
```

---

## URL Handling

Note content is compressed into the URL so bookmarks and shared links contain the full note.

### Compression

Uses the browser's native `CompressionStream("deflate-raw")`:

```
compress(text)   → string → deflate-raw → base64
decompress(b64)  → base64 → inflate-raw → string
```

### URL Format

```
/note/?view=md#name=todo.md&note=<compressed>&anchor=heading-slug
```

Sensitive data (`name`, `note`) lives in the hash fragment, which is never sent to servers — keeping document content out of access logs.

| Location | Parameter | Required | Values         | Purpose                                           |
| -------- | --------- | -------- | -------------- | ------------------------------------------------- |
| Query    | `view`    | No       | `md`, `zen`    | Markdown preview or zen mode                      |
| Hash     | `name`    | Yes      | Note filename  | Identifies the note                               |
| Hash     | `note`    | No       | Base64 deflate | Compressed content (dropped if URL > 60000 chars) |
| Hash     | `anchor`  | No       | Heading slug   | Scroll target for heading anchors                 |

### Update Flow

```
scheduleUrlUpdate()                      500ms debounce
  → updateUrl()
    → compress(note.content)             async
    → if URL > URL_MAX_LENGTH (60000):
        drop "note" param, hide share button
    → history.replaceState(...)          no page reload, preserves noteId in state
```

### Browser History (Back/Forward)

Note switching and tab switching create history entries. Content (`note=`) and anchor (`anchor=`) changes use `replaceState` and do not affect browser history.

| Action                      | History API    | Creates history entry? |
| --------------------------- | -------------- | ---------------------- |
| Switch note (sidebar/`:e`)  | `pushState`    | Yes                    |
| Inter-note link click       | `pushState`    | Yes                    |
| Tab switch (edit/view/zen)  | `pushState`    | Yes                    |
| Exit zen (menu/Esc/`e` key) | `pushState`    | Yes                    |
| Content edit (typing)       | `replaceState` | No                     |
| Anchor click / in-page `#`  | `replaceState` | No                     |

History state stores `{ noteId, tab }` where `tab` is `"edit"`, `"view"`, or `"zen"`.

On `popstate` (back/forward), the handler:

1. Reads `noteId` and `tab` from `history.state` if available
2. Falls back to looking up the note by `name=` in the hash (derives tab from `?view=` param)
3. Last resort: decompresses from URL via `loadFromUrl()`

### Load Flow (page load)

```
loadFromUrl()
  → read "note" and "name" from URL params
  → if no "note" param → return false
  → decompress(noteData)
  → if view=zen → store as ephemeral (not persisted)
  → if note exists with same name:
      same content → activate it
      different → modal: "update" or "new file"
  → otherwise → create new note
```

---

## Syntax Highlighting

### Language Detection

File extension determines the highlight rules:

```
getExtension(name)  →  langRules[ext]  →  tokenize(code, rules)  →  buildHTML()
```

Supported: js/jsx/ts/tsx, py, rb, go, rs, java, c/cpp, css, json, yaml, sql, toml.
HTML/XML/SVG use a dedicated `highlightHTML()` parser.

### Highlight Pipeline

```
updateHighlight()
  → highlightCode(editor.value, note.name)
    → if HTML ext:  highlightHTML(code)
    → if rules exist: tokenize(code, rules) → buildHTML(code, tokens)
    → else: escapeHTML(code)
  → highlightLayer.innerHTML = result
```

Each language defines rules as `[regex, cssClass]` pairs. `tokenize()` finds all regex matches, sorts by position, removes overlaps, and `buildHTML()` wraps matched ranges in `<span class="hl-*">` elements.

### When Highlighting Runs

- On every keystroke (30ms debounce)
- On note switch (`renderEditor()` → `updateHighlight()`)
- On switching from view/zen back to edit (`switchMdTab("edit")`)

---

## Keyboard Shortcuts

### Editing

| Shortcut      | Action                                                  |
| ------------- | ------------------------------------------------------- |
| Tab           | Insert 2 spaces (no selection) or indent selected lines |
| Shift+Tab     | Dedent selected lines                                   |
| Alt+↑ / Alt+↓ | Move selected line(s) up/down                           |
| Ctrl+Z        | Undo                                                    |
| Ctrl+Shift+Z  | Redo                                                    |

### Navigation & Actions

| Shortcut        | Action                                            |
| --------------- | ------------------------------------------------- |
| Ctrl+N          | New note (Ctrl only, not Cmd — avoids new window) |
| Ctrl+P / Ctrl+F | Open note search                                  |
| Ctrl+H          | Open find & replace                               |
| Ctrl+S          | See [Ctrl+S behavior](#ctrls-behavior) below      |
| Ctrl+Shift+D    | Delete current note                               |
| Ctrl+Shift+F    | Format markdown (`.md` files only)                |
| Ctrl+Shift+M    | Toggle vim mode                                   |
| Escape          | Close search / find-replace / sidebar             |

### Markdown View

| Shortcut | Action                           |
| -------- | -------------------------------- |
| e        | Switch from view/zen to edit tab |

### Ctrl+S Behavior

Ctrl/Cmd+S always suppresses the browser save dialog. Beyond that, behavior depends on context:

| Context                        | Action                                     |
| ------------------------------ | ------------------------------------------ |
| Edit mode, non-vim, `.md` file | Format markdown → save → update URL → sync |
| Edit mode, non-vim, other file | Save → update URL → sync                   |
| View tab (markdown preview)    | Save → update URL → sync (no formatting)   |
| Vim mode (any file)            | Nothing (use `:w` to save)                 |
| Zen mode                       | Nothing                                    |

"Save" = `saveState()` (localStorage). "Sync" = `driveSync()` (only if connected to Google Drive). "Update URL" = `scheduleUrlUpdate()` (compress content into URL hash).

### Vim Mode

When vim is enabled, all keys are intercepted by `vimHandleKeydown()` in normal/visual mode. In insert mode, standard shortcuts (Tab, Ctrl+Z, etc.) work normally. Vim-specific shortcuts:

| Shortcut        | Action                      |
| --------------- | --------------------------- |
| Ctrl+D / Ctrl+U | Half-page scroll down/up    |
| Ctrl+R          | Redo                        |
| `:w`            | Write buffer to storage     |
| `:wq`           | Write and exit vim          |
| `:q!`           | Discard buffer and exit vim |
| `:fmt`          | Format markdown             |
| `:mddemo`       | Open markdown features demo |

---

## Vim Mode

### How It Works

Vim mode makes the textarea `readOnly`. All keystrokes go through `vimHandleKeydown()` which programmatically manipulates the textarea content and cursor position.

```
toggleVim()
  → if dirty buffer: vimWriteBuffer()     auto-save on exit
  → vimState.enabled = !vimState.enabled
  → localStorage.setItem(VIM_KEY, ...)
  → if enabling: editor.readOnly = true
  → if disabling: editor.readOnly = false
```

### Buffer vs Saved Content

In normal editing, `editor.value` and `note.content` are always in sync. In vim mode, they can diverge:

|              | `editor.value` (buffer) | `note.content` (saved) |
| ------------ | ----------------------- | ---------------------- |
| After typing | Updated by vim handler  | Unchanged              |
| After `:w`   | Unchanged               | `= editor.value`       |
| After `:q!`  | `= note.content`        | Unchanged              |

### Swap Files

Vim stores unsaved buffers in localStorage as swap files:

```
saveSwap(noteId, content)  → localStorage["notepad_swap_<id>"] = { content, timestamp }
loadSwap(noteId)           → read and parse swap file
deleteSwap(noteId)         → remove swap file
```

On page load, if a swap file exists with different content from the saved note:

- **Vim enabled:** load swap into buffer, mark dirty
- **Vim disabled:** apply swap to note, save, clean up

---

## Cross-Tab Sync

### Tab Leadership

Only the most recently focused tab is allowed to write to localStorage and sync to Google Drive. This prevents two tabs from overwriting each other's edits.

```
Tab A (editing)                    Tab B (opened)
  │                                  │
  │  claimLeadership() ◄─────────────┤  init() → claimLeadership()
  │                                  │
  │  storage event: TAB_LEADER_KEY   │
  │  e.newValue !== tabId            │
  │  → revokeLeadership()            │  isTabLeader = true
  │  isTabLeader = false             │  (can save)
  │  (stops saving)                  │
  │                                  │
  ├──── user returns ────►           │
  │  focus event                     │
  │  → reclaimLeadership()           │
  │    → pullStateFromStorage()      │  storage event → revokeLeadership()
  │    → claimLeadership()           │
  │    → saveState()                 │
```

### What's Guarded

These operations are no-ops when `isTabLeader === false`:

- `saveState()` — won't write to localStorage
- `scheduleSave()` — won't schedule a save
- `scheduleDriveUpload()` — won't schedule Drive push
- `driveSyncQuiet()` — won't pull from Drive
- `drivePushQuiet()` — won't push to Drive
- `scheduleTokenRefresh()` — won't refresh OAuth token

### pullStateFromStorage()

When a non-leader tab regains focus, it merges localStorage state with any in-memory edits:

```
pullStateFromStorage()
  → read state from localStorage
  → for each note in storage:
      if local version has newer updatedAt → keep local
      otherwise → use storage version
  → keep any notes that exist locally but not in storage
  → render()
```

### Settings Sync

Wrap, vim, and sidebar width changes propagate to all tabs immediately via `storage` events, regardless of leadership. These are lightweight UI settings that don't conflict.

---

## Find & Replace

### Match Computation

```
updateFindMatches()
  → case-insensitive indexOf scan of editor.value
  → stores array of { start, end } positions
  → finds nearest match to cursor position
  → calls selectFindMatch()
```

### Scrolling to Match

```
selectFindMatch(focusEditor)
  → editor.setSelectionRange(start, end)
  → editor.focus()                       ensure selection takes effect
  → compute line number from match position
  → scroll editor to center match in viewport
  → sync gutter + highlight layer scroll
  → if !focusEditor: return focus to find input
```

### Replace

- **Replace current:** uses `document.execCommand("insertText")` to preserve undo history
- **Replace all:** direct string replacement via `editor.value = result`
- After replace: `updateFindMatches()` re-scans to update match list

---

## Markdown Formatter

`formatMarkdown(text)` normalizes markdown source structure. It operates on raw text (not rendered HTML) and is line-based with state tracking for code blocks.

### Trigger

| Method         | Context                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| `:fmt`         | Vim command bar                                                               |
| `Ctrl+Shift+F` | Any mode (vim or normal)                                                      |
| `Ctrl+S`       | Edit mode, non-vim, `.md` files only (see [Ctrl+S behavior](#ctrls-behavior)) |

`:fmt` and `Ctrl+Shift+F` only run on `.md` files (toast shown otherwise). `Ctrl+S` silently skips formatting for non-markdown files and proceeds with save/sync. `Ctrl+S` does nothing in vim mode or zen mode.

### What Gets Formatted

| Construct           | Rule                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| Headings            | Single space after `#`, blank line before/after                                        |
| Lists (ul)          | Normalize marker to `-`, 2-space indent multiples                                      |
| Lists (ol)          | Preserve numbering, normalize indent                                                   |
| Task lists          | Normalize `- [ ]` / `- [x]` spacing                                                    |
| Tables              | Align columns to equal width, pad cells respecting `:---` / `---:` / `:---:` alignment |
| Blockquotes         | Normalize to `> ` (single space)                                                       |
| Horizontal rules    | Normalize to `---`                                                                     |
| Blank lines         | Collapse consecutive blanks to 1                                                       |
| Trailing whitespace | Stripped from all non-code lines                                                       |

### What's NOT Touched

- **Code blocks** — everything between ` ``` ` fences passes through unchanged (content and fences)
- **`<details>`/`<summary>` tags** — each tag is placed on its own line; markdown content between them is formatted normally
- **Inline formatting** — bold, italic, links, inline code left as-is

### Undo Integration

- `pushHistory()` is called before formatting so `Ctrl+Z` / `u` restores the original
- In vim mode: sets `bufferDirty = true` and saves swap file

---

## Selection Occurrence Highlights

When the user selects text (2+ characters, non-whitespace) in either normal or vim visual mode, occurrences are highlighted in two ways:

1. **In-text highlights** — subtle glowing outlines appear around each matching occurrence directly in the editor
2. **Scrollbar markers** — small markers on the right edge of the editor show where all occurrences exist in the document

The current selection itself is excluded from in-text highlights (only other occurrences are highlighted). At least 2 total occurrences must exist for any highlights to appear.

### How It Works

```
updateOccurrenceMarkers()
  → read editor.selectionStart / selectionEnd
  → if selection < 2 chars or whitespace-only → clear all
  → if same query as last time → skip (cached)
  → case-insensitive indexOf scan
  → if < 2 occurrences → clear all
  → build line-start index for fast line/col lookup (binary search)
  → for each occurrence:
      → compute line number via binary search on lineStarts
      → scrollbar marker: map line to vertical position in track
      → in-text highlight (skip current selection):
          compute column from lineStarts, position absolutely using
          charWidth × col (x) and lineHeight × line (y)
  → render into occurrenceTrack and occurrenceOverlay
```

### Character Width Measurement

`getOccurrenceCharWidth()` measures a single character width by inserting a hidden `<span>` with the editor's font and measuring its `getBoundingClientRect().width`. The result is cached for the session.

### DOM Structure

The occurrence overlay is a child of `.editor-area`, stacked in the same grid cell as the highlight layer and textarea. It uses CSS `transform` to stay in sync with editor scroll position. The occurrence track is a sibling positioned on the right edge:

```html
<div class="editor-wrap">
  <div class="gutter">...</div>
  <div class="editor-area">
    <pre class="highlight-layer">...</pre>
    <div class="occurrence-overlay" id="occurrenceOverlay">
      <div class="occurrence-highlight" style="top:31px;left:48px;width:56px;height:19px"></div>
    </div>
    <textarea class="editor">...</textarea>
  </div>
  <div class="occurrence-track" id="occurrenceTrack">
    <div class="occurrence-marker" style="top:42px"></div>
    <div class="occurrence-marker" style="top:185px"></div>
  </div>
</div>
```

### Scroll Sync

`syncOccurrenceScroll()` applies a CSS `transform: translate(-scrollLeft, -scrollTop)` to the overlay, keeping in-text highlights aligned as the user scrolls. Called from the editor's `scroll` event handler alongside gutter and highlight layer sync.

### Clearing

`clearOccurrenceHighlights()` immediately empties both the overlay and track, resets `lastOccurrenceQuery`, and cancels any pending debounced update. Called on:

- **`mousedown`** — clears instantly when the user clicks (before a new selection is made)
- **Cursor movement keys** — arrow keys, Home, End, PageUp, PageDown clear highlights immediately via a `keydown` listener
- **`renderEditor()`** — clears on note switch
- **`input`** — clears overlay and resets cache so markers recalculate after content changes

### Event Triggers

- **`updateCursorPos()`** → `scheduleOccurrenceUpdate()` (debounced 30ms) — fires on `keyup`, `select`, `click`
- **`mouseup`** → `scheduleOccurrenceUpdate()` — catches drag selections

### Caching

`lastOccurrenceQuery` stores the last selected text. If the selection hasn't changed, the scan is skipped. Reset on content changes (`input` event), cursor movement, mousedown, and note switches (`renderEditor`).

### Styling

| Element              | Style                                                    |
| -------------------- | -------------------------------------------------------- |
| `.occurrence-marker` | 8px wide, 3px tall, `var(--blue)` at 0.7 opacity        |
| `.occurrence-highlight` | `box-shadow: 0 0 0 1px rgba(208,225,253,0.35)`, subtle blue background at 0.15 opacity, 2px border-radius |
