# Reading — View Mode, Zen Mode & Markdown Rendering

## Markdown Rendering Pipeline

`renderMarkdown(text)` converts markdown source to HTML. It applies transformations in a strict order to prevent XSS while preserving semantics.

### Step 1: XSS Prevention

All HTML entities are escaped first (`&`, `<`, `>`, `"`). This prevents raw HTML injection. Only `<details>` and `<summary>` are selectively re-enabled at the end (attributes stripped for safety).

### Step 2: Parsing Order

Transformations are applied in this sequence:

````
1.  Fenced code blocks        ```lang ... ```       → <pre><code>...</code></pre>
2.  Inline code               `code`                → <code>code</code>
3.  Headings (H6→H1)          ## Title              → <h2 id="slug">...</h2>
4.  Horizontal rules           ---                   → <hr>
5.  Blockquotes               > text                → <blockquote>text</blockquote>
6.  Lists (ul/ol/nested)      - item / 1. item      → <ul><li>...</li></ul>
7.  Tables                    | col | col |          → <table>...</table>
8.  Links                     [text](url)            → <a href="url">text</a>
9.  Bold + Italic combos      ***text***             → <strong><em>text</em></strong>
10. Bold                      **text** / __text__    → <strong>text</strong>
11. Italic                    *text* / _text_        → <em>text</em>
12. Strikethrough             ~~text~~               → <del>text</del>
13. Paragraphs                loose text             → <p>text</p>
````

### Step 3: Restore Placeholders

Code blocks and inline code are extracted early (replaced with `\x00CB`/`\x00IC` placeholders) to protect their contents from further parsing. After all transformations, placeholders are restored with the rendered HTML.

### Step 4: Re-enable Safe HTML

Only `<details>` and `<summary>` tags are unescaped from their escaped forms. All attributes are stripped.

---

## Fenced Code Blocks

### Syntax Highlighting

Code blocks with a language hint are syntax-highlighted using the same highlighting engine as the editor:

````
```javascript
const x = 42;
```
````

**Language resolution:**

```
language hint → langAliases → langRules/htmlExts → highlightCode()
```

`langAliases` normalizes common names:

| Alias            | Maps to |
| ---------------- | ------- |
| javascript       | js      |
| typescript       | ts      |
| python           | py      |
| rust             | rs      |
| bash, shell, zsh | sh      |
| yml              | yaml    |

If highlighting rules exist for the language, `highlightCode(code, "file." + ext)` is called. Otherwise, the code is HTML-escaped and shown as plain text.

### Copy Button

Each code block includes a copy-to-clipboard button:

```html
<pre>
  <button class="code-copy-btn">copy</button>
  <code>{highlighted content}</code>
</pre>
```

**Behavior:**

1. Button is hidden by default (opacity: 0)
2. Appears on `<pre>` hover (opacity: 1, top-right corner)
3. Click copies `code.textContent` via `navigator.clipboard.writeText()`
4. Button text changes to "copied" for 2 seconds
5. Toast notification: "copied to clipboard"

---

## Headings & Anchors

### Slug Generation

Every heading gets a unique `id` attribute for anchor linking:

```
## My Heading Title

→ <h2 id="my-heading-title">
    <a class="heading-anchor" href="#my-heading-title">#</a>
    My Heading Title
  </h2>
```

Slug generation:

1. Strip HTML tags and entities from heading text
2. Convert to lowercase
3. Remove non-word characters (except hyphens)
4. Replace spaces with hyphens
5. Track slug counts — duplicates get `-1`, `-2` suffixes

### Anchor Link UI

The `#` anchor link is hidden by default (positioned absolutely at `left: -24px`, `opacity: 0`). It appears on heading hover.

### Anchor Click Behavior

Clicking a heading anchor:

1. Updates the URL hash via `history.replaceState()` (no page reload)
2. Scrolls the heading into view with `scrollIntoView({ behavior: "smooth" })`
3. Copies the full URL (with `#fragment`) to clipboard
4. Shows a toast notification

### In-Page Anchor Navigation

Links starting with `#` (e.g., `[see below](#section)`) are intercepted:

1. Finds the target element in `mdPreview` by selector
2. Smooth-scrolls to it
3. Updates the URL hash

### Scroll-to-Anchor on Page Load

If the URL has a `#fragment` when the page loads in view/zen mode, the target heading is scrolled into view after rendering.

---

## Task Checkboxes

### Rendering

Task list items are detected during list parsing:

```markdown
- [x] completed task
- [ ] pending task
  - [ ] subtask
```

```html
<li class="task-item checked" data-task="0">
  <input type="checkbox" checked data-task="0" />
  <span>completed task</span>
</li>
<li class="task-item" data-task="1">
  <input type="checkbox" data-task="1" />
  <span>pending task</span>
</li>
```

Task items use flexbox layout — the checkbox stays top-aligned while multiline text wraps with proper indentation.

### Interactive Toggling

Checkboxes in view and zen mode are fully interactive. `attachCheckboxHandler()` sets a click handler on `mdPreview`.

**Click flow:**

```
click on checkbox or task-item li
  → parseTasks(note.content)               find all tasks in source
  → determine clicked task index           from data-task attribute
  → toggle checked state
  → collect descendants                    all nested tasks (deeper indent)
  → setTasks(content, indices, state)      update [ ]/[x] in markdown source
  → cascadeUp(content, index)             auto-check/uncheck parents
  → note.content = updated                 persist in memory
  → editor.value = note.content            sync editor textarea
  → saveState()                            write to localStorage
  → updateHighlight()                      sync highlight layer
  → re-render preview                      show updated checkboxes
```

### Cascade Behavior

**Down:** Toggling a parent automatically checks/unchecks all nested subtasks (determined by indentation level).

**Up:** After toggling, the system checks siblings at the same indent level under the parent:

- If **all siblings** are now checked → parent is auto-checked
- If **any sibling** is unchecked → parent is auto-unchecked
- Cascading propagates recursively up the tree

---

## View Mode

### Activation

`switchMdTab("view")` or clicking the "view" tab:

```
switchMdTab("view")
  → set mdViewActive = true
  → render: mdPreview.innerHTML = renderMarkdown(note.content)
  → attachCheckboxHandler()
  → hide: gutter, editorArea, emptyState, btnReplace, btnWrap, cursorPos, btnVim
  → show: mdPreview (add class "visible")
  → remove zen-mode class
  → scroll preview to match editor cursor position
  → updateMdViewUrl()                     set ?view=md in URL
```

### Tab Bar

The tab bar (`edit | view | zen`) is only visible for markdown files (`.md` extension) or ephemeral zen notes. `updateMdTabBar()` auto-switches to edit if a non-markdown file is selected while view is active.

### Scroll Position Sync

When switching between edit and view:

- **Edit → View:** calculates cursor position as a ratio of total lines, scrolls preview to the corresponding position
- **View → Edit:** remembers scroll ratio, scrolls editor to match

### URL Parameter

View mode sets `?view=md` in the URL via `history.replaceState()`. On page load, `checkMdViewParam()` reads this parameter and automatically enters view mode if present.

---

## Zen Mode

### Activation

`switchMdTab("zen")` or clicking the "zen" tab:

```
switchMdTab("zen")
  → set zenModeActive = true, mdViewActive = true
  → render: mdPreview.innerHTML = <div class="zen-wrap">${renderMarkdown(content)}</div>
  → attachCheckboxHandler()
  → hide: gutter, editorArea, emptyState
  → show: mdPreview (add class "visible")
  → add zen-mode class to app element
  → show zenMenuContainer
```

### Visual Differences from View Mode

Zen mode strips all application chrome:

| Element        | View Mode  | Zen Mode                        |
| -------------- | ---------- | ------------------------------- |
| Sidebar        | Visible    | Hidden                          |
| Sidebar resize | Visible    | Hidden                          |
| Status bar     | Visible    | Hidden                          |
| Tab bar        | Visible    | Hidden                          |
| Find & replace | Visible    | Hidden                          |
| Content width  | Full width | max-width: 800px, centered      |
| Bottom padding | None       | 40vh (scroll space via ::after) |
| Menu           | None       | Floating === button (top-left)  |

### Zen Menu

A floating menu button (`===`) appears at top-left with opacity 0.4, full opacity on hover:

- **share:** copies the current URL to clipboard (without `#fragment`)
- **edit:** exits zen mode, switches to edit tab

The menu auto-closes on clicks outside the menu container.

---

## Ephemeral Notes

When a note is loaded from a URL with `?view=zen`, it is treated as **ephemeral** — it exists only in memory and is not persisted to localStorage or Google Drive.

### State

```
zenFromUrl = true                          note came from a URL
zenEphemeralNote = { name, content }       stored in memory only
```

### Rendering

When `zenModeActive && zenFromUrl && zenEphemeralNote`:

- Preview renders from `zenEphemeralNote.content` instead of the active note
- URL updates are skipped (no re-compression needed)
- The note is not part of `state.notes`

### Persisting an Ephemeral Note

`persistZenNote()` is called when exiting zen mode (clicking "edit" or pressing `e`):

```
persistZenNote()
  → if note with same name exists:
      same content → activate existing note
      different content → create numbered copy (note1.md, note2.md, ...)
  → if new name → create new note
  → clear zenFromUrl and zenEphemeralNote flags
```

After persisting, the note appears in the sidebar and is saved to localStorage like any other note.

### Use Case

Ephemeral notes enable **shareable read-only links**. A user can share a zen URL containing compressed note content. The recipient sees the note in zen mode without it being saved to their storage — unless they choose to exit zen mode, which persists it.

---

## Links

### URL Whitelist

For security, only these URL schemes are allowed in markdown links:

- `http://` and `https://`
- `mailto:`
- Fragment links (`#anchor`)
- Relative paths (no colon in URL)

All links get `rel="noopener noreferrer"` and a `title` attribute with the URL.

### External Link Behavior

Links in view/zen mode open normally (no special interception). Fragment links (`#anchor`) are intercepted for smooth in-page scrolling.

### Inter-Note Link Navigation

Relative links (e.g., `[see todo](todo.md)`) are matched against existing notes by name. Clicking one:

1. Pushes the current note onto browser history (`pushState`)
2. Switches to the target note
3. Browser back/forward buttons navigate between notes visited this way

---

## Tables

Pipe-delimited tables are rendered with standard HTML table markup:

```markdown
| Header 1 | Header 2 |
| -------- | -------- |
| Cell 1   | Cell 2   |
```

The separator row (`| --- | --- |`) determines column count. Header cells use `<th>`, body cells use `<td>`.

### Column Alignment

The separator row supports alignment markers using colons:

```markdown
| Left   |  Right | Center |
| :----- | -----: | :----: |
| text   |   text |  text  |
```

| Separator | Alignment | CSS class |
| --------- | --------- | --------- |
| `:---`    | Left      | (default) |
| `---:`    | Right     | `.align-right` |
| `:---:`   | Center    | `.align-center` |
| `---`     | Left      | (default) |

Alignment is applied as CSS classes on both `<th>` and `<td>` elements. The formatter (`formatMarkdown`) also respects alignment — right-aligned cells are right-padded, centered cells are center-padded in the source.

---

## Keyboard Shortcuts

### In View Mode

| Key | Action             |
| --- | ------------------ |
| e   | Switch to edit tab |

### In Zen Mode

| Key | Action                                                    |
| --- | --------------------------------------------------------- |
| e   | Exit zen mode (persists ephemeral note, switches to edit) |

Both shortcuts require: no modifier keys (Ctrl/Cmd/Alt), focus not in an input/textarea element.
