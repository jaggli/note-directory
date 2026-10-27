# Import & Export

## Export

**Trigger:** **note ▾ › Export all as ZIP**, or Settings › Sync and backup.

Creates a standard ZIP file (DEFLATE-compressed) containing:

1. **All note files** — one file per note, using the note's filename and content
2. **Drawing renders** — for each non-empty `.draw` note an SVG image named
   `<name>.draw.svg`, so drawings can be looked at without the app (skipped
   if a note already has that name)
3. **`.note.directory`** — a JSON metadata file with note IDs and timestamps

The ZIP is a valid archive that can be opened by any zip tool (Finder, Explorer, 7-Zip, etc.). Users can unpack it to get their raw text files.

### Dragging a note out

In Chromium browsers a sidebar row dragged out of the window drops a copy as a
file (`DownloadURL`): the note's text, or a PNG for drawings. The PNG is made
on hover, since the drag needs the file at once. Locked encrypted notes refuse
the drop with "Unlock it first". Other browsers, and the installed app (Chrome
ignores DownloadURL in app windows), keep plain reordering.

### `.note.directory` format

```json
{
  "notes": [
    {
      "id": "m1abc2def",
      "name": "todo.md",
      "updatedAt": 1711234567890
    }
  ],
  "renders": ["sketch.draw.svg"]
}
```

| Field       | Type   | Description                      |
| ----------- | ------ | -------------------------------- |
| `id`        | string | Unique note identifier (base36)  |
| `name`      | string | Filename including extension     |
| `updatedAt` | number | Last modification timestamp (ms) |
| `renders`   | array  | Drawing renders in the zip; import skips them |

**Privacy:** Only `id`, `name`, and `updatedAt` are exported. The following are intentionally excluded:

- User settings (word wrap, vim mode, sidebar width)
- Pin state
- Deleted note IDs
- Google Drive sync tokens or connection state
- Any other user-specific or device-specific data

### Compression

Uses the browser's native `CompressionStream('deflate-raw')` API. All entries are DEFLATE-compressed (ZIP method 8). Text content typically compresses 60-80%.

---

## Import via Drag-and-Drop

Drop files anywhere, or pick them with **note ▾ › Import files…** (also in
the **+ ▾** menu, Settings and the palette). Everything is read first
(`importFiles()`); then one dialog lists every name clash. Two types are
supported:

### ZIP files

Detected by `.zip` extension or `application/zip` MIME type. The ZIP reader handles both DEFLATE (method 8) and STORE (method 0) entries, so re-zipped folders from OS tools work fine.

**With `.note.directory` (app export):**

| Scenario                            | Behavior                                   |
| ----------------------------------- | ------------------------------------------ |
| Same ID + same or older `updatedAt` | Skip silently (local is current)           |
| Same ID + newer `updatedAt`         | Auto-update local note                     |
| Same filename, different ID         | A row in the import dialog                 |
| New file (no match)                 | Create note with original ID and timestamp |

**Without `.note.directory` (plain zip):**

| Scenario        | Behavior                |
| --------------- | ----------------------- |
| Filename exists | A row in the import dialog |
| New file        | Create note with new ID |

### Individual text files

Any file with a text MIME type or a recognized text extension (~80 extensions supported: `.js`, `.py`, `.md`, `.draw`, `.json`, `.yaml`, `.toml`, `.rs`, `.go`, etc.) can be dropped directly. A dropped `.draw` file opens on the drawing canvas.

| Scenario        | Behavior                      |
| --------------- | ----------------------------- |
| Filename exists | A row in the import dialog    |
| New file        | Create note                   |

---

## Import dialog

Every filename collision (zip or plain file; different ID or no metadata)
is one row in a single dialog, with the same three words used everywhere:

| Option        | Effect                                                      |
| ------------- | ----------------------------------------------------------- |
| **Replace**   | Replace the existing note's content (undoable with ⌘Z there) |
| **Keep both** | Import with a numbered suffix (`todo1.md`, `todo2.md`, ...) |
| **Skip**      | Don't import this file                                      |

The default is Replace when the incoming copy is newer (known from the
export's metadata), otherwise Keep both. **Same for all** applies a choice
to every row. New files and skipped ones (binary, unsupported, no space)
are listed too. Cancel, Escape or the scrim import nothing. Without
clashes there is no dialog — a toast says what was imported or skipped.

---

## URL Sharing

Notes can be shared via URL using zlib compression in the URL hash fragment. The note content is embedded directly in the link (no server). Size limit is ~60KB.

When opening a shared URL:

- If a note with the same filename exists and content is identical → activate it
- Otherwise the note is shown, not saved, under a banner: **Shared with you ·
  Save to my notes / Dismiss**, or for a name clash **Show mine · Keep both ·
  Replace mine**. The first edit or ticked task saves it too.

---

## Security

### ZIP reader hardening

| Protection                        | Limit                         |
| --------------------------------- | ----------------------------- |
| Max entries per zip               | 500                           |
| Max uncompressed size per entry   | 10 MB                         |
| Max total uncompressed size       | 50 MB                         |
| Path traversal (`../`)            | Rejected                      |
| Directory components in filenames | Stripped (only basename kept) |
| Unsupported compression methods   | Silently skipped              |
| Malformed/truncated headers       | Error modal shown             |

### Content validation

- **Binary detection:** Files with null bytes (`\x00`) in the first 8KB are skipped
- **Filename sanitization:** Control characters stripped, length capped at 255, leading dots removed
- **Metadata validation:** `.note.directory` must have valid structure (object with `notes` array, each entry with string `id`, string `name`, number `updatedAt`). Invalid metadata causes fallback to plain-zip import — no errors thrown
- **Storage limits:** Each file checked against the storage quota before import

### What's safe by design

- **XSS via content:** Editor uses `<textarea>` (inherently safe). Markdown preview HTML-escapes all content before rendering
- **XSS via filenames:** Note names are set via `textContent` or `input.value` (safe DOM APIs)
- **Prototype pollution:** `JSON.parse` output is only accessed by specific field names, never spread or assigned to prototypes
