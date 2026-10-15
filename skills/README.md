# note-directory Claude Code skills

Two companion skills for [note.directory](https://note.directory):

- **`note-directory-read`** ([note-directory-read/SKILL.md](note-directory-read/SKILL.md)) — decodes a note.directory URL pasted into chat and shows the note's name and contents (drawings are described, not dumped).
- **`note-directory-share`** ([note-directory-share/SKILL.md](note-directory-share/SKILL.md)) — encodes markdown content (or a file) into a shareable note.directory URL, and can write diagrams as note.directory drawings.

## `note-directory-read` — decode a link

Paste a `note.directory` URL into the chat — the skill triggers automatically and shows the note's name and content.

```
https://note.directory/#name=example.md&note=K4srzkvJLMpV0tX...
```

Works with both the current hash-based format (`#name=...&note=...`) and legacy query-parameter URLs (`?name=...&note=...`).

For drawings (`.draw` notes or ` ```draw ` blocks) it describes the shapes, labels and connections instead of printing coordinates.

Decoded content is treated as untrusted: the skill will ask for confirmation before acting on any instructions found inside a note.

## `note-directory-share` — create a link

Ask Claude things like:

- "Share this as a note.directory link"
- "Make a shareable URL for `notes.md` in zen mode"
- "Create a note.directory link for the markdown above"
- "Draw our service architecture and give me a note.directory link"

The skill compresses the content (raw deflate), base64url-encodes it, and prints a `https://note.directory/...` URL. Drawings use the line-based `.draw` format ([docs/drawing-format.md](../docs/drawing-format.md)), either as a `.draw` note or as a ` ```draw ` block inside markdown. Optional `view=md` / `view=draw` / `view=zen` query and `anchor=<heading-slug>` hash parameter are supported. The full URL is capped at 60,000 characters (matches the editor); larger notes can't be shared via URL.

## Install

Place each `SKILL.md` at its own path under `~/.claude/skills/`:

```
~/.claude/skills/note-directory-read/SKILL.md
~/.claude/skills/note-directory-share/SKILL.md
```

No other setup needed — Claude Code picks them up automatically.
