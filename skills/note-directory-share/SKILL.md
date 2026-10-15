---
name: note-directory-share
description: Encode markdown content or a drawing into a shareable https://note.directory URL. The content is raw-deflate compressed and base64url-encoded into the URL hash fragment. USE WHEN the user asks to share, create a link for, or generate a note.directory URL from text/markdown/a file, or to share a diagram or drawing as a note.directory link.
---

## When to use this skill

Use when the user asks to:
- "Share this as a note.directory link"
- "Create a note.directory URL for ..."
- "Make a shareable link for this markdown"
- Generate a `https://note.directory/...` URL from given content or a file
- Share a diagram, sketch or architecture drawing as a note.directory link

If the content is not yet provided, ask for the markdown text (or a file path) and a filename before encoding.

## URL format

```
https://note.directory/?view=md|zen#name=<filename>&note=<compressed>&anchor=<heading-slug>
```

- `name` (hash) — note filename, URI-encoded (e.g. `my%20note.md`)
- `note` (hash) — content: raw-deflate compressed, then base64url-encoded (RFC 4648, no padding)
- `anchor` (hash, optional) — heading slug to scroll to on load
- `view` (query, optional) — `md` for markdown preview, `draw` for a drawing's canvas, `zen` for distraction-free reading

Sensitive values (`name`, `note`) live in the hash fragment so they are never sent to a server.

## How to encode

Use the Bash tool. Node's `-e` argument is single-quoted (no shell escaping needed), and the note content is fed in via a quoted heredoc on stdin so the user's text is preserved literally (no `$` expansion, no backtick execution).

Substitute `<FILENAME>` and optionally `<VIEW>` (`md`, `draw` or `zen`) and `<ANCHOR>` (heading slug). Leave the optional ones empty (`""`) if unused.

```bash
node -e '
const name = "<FILENAME>";
const view = "<VIEW>";
const anchor = "<ANCHOR>";
const text = require("fs").readFileSync(0, "utf-8");
const zlib = require("zlib");
const compressed = zlib.deflateRawSync(Buffer.from(text, "utf-8"))
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
const query = view ? "?view=" + view : "";
const hashParts = [
  "name=" + encodeURIComponent(name),
  "note=" + encodeURIComponent(compressed),
];
if (anchor) hashParts.push("anchor=" + encodeURIComponent(anchor));
const url = "https://note.directory/" + query + "#" + hashParts.join("&");
if (url.length > 60000) {
  console.error("ERROR: URL exceeds 60000 char limit (" + url.length + ").");
  process.exit(1);
}
console.log(url);
' <<"NOTE_EOF"
<NOTE_CONTENT_HERE>
NOTE_EOF
```

If the user supplies a file path, replace the heredoc with `< /path/to/file.md` instead.


## Drawings

note also has drawings: notes named `*.draw` whose content is a small line-based format. Use this to share diagrams (architecture sketches, flows, simple maps). Open them with `view=draw` (editable canvas) or `view=zen` (read-only).

```
draw 1
r web 0 0 160 70 c=blue f=semi "Web app"
r api 260 0 160 70 c=mauve f=semi "API"
e db 520 -10 150 90 c=green "Postgres"
a a1 web api "REST"
a a2 api db "SQL" d=dash
t note 0 120 c=grey "deployed on k8s"
```

- Line: `<kind> <id> <values> [key=value…] ["label"]`; ids are unique, `A-Z a-z 0-9 _ -`.
- `r` rectangle, `e` ellipse, `m` diamond: `x y width height`, label is drawn inside (`ta=left|center|right`, `va=top|middle|bottom`; default centred).
- `t` text: `x y` (top-left). `l` line: `x,y x,y …`.
- `a` arrow: `start end`, each `x,y` or the id of an `r/e/m/t` shape — ids attach the arrow to the shape's edge. `bend=<n>` curves it; `hs=` / `he=` set the start / end head: `none open triangle dot diamond bar` (default: none at the start, open at the end).
- `p` pen / `h` highlighter: first point absolute, then deltas — rarely useful to write by hand.
- `c=` `text grey red peach yellow green teal sky blue lavender mauve pink` · `s=` `s m l xl` · `f=` `none semi solid` · `d=` `solid dash dot` · `st=` text style, any of `b i u` (bold, italic, underline; e.g. `st=b`) · `rot=<deg>` · `gr=<group id>`.
- Integer coordinates, y grows downwards. Size `m` text is ~13px per character, so make boxes wide enough (≈ 13 × characters + 40) or let labels wrap at spaces. Leave ~100 units between shapes for arrows, more for a labelled arrow (≈ 13 × label characters + 80).
- Labels escape `\"`, `\\` and use `\n` for a line break.
- Full spec: https://github.com/jaggli/note-directory/blob/main/docs/drawing-format.md

A drawing can also go **inside a markdown note** as a fenced block, so a shared `.md` link carries it:

````markdown
## Architecture

```draw
draw 1
r a 0 0 140 60 "client"
r b 240 0 140 60 "server"
a c a b
```
````

(`![label](name.draw)` also embeds, but only works where that drawing note already exists — prefer the fenced block for links.)

## Output

Print the resulting URL to the user. Mention if `view=md`, `view=draw` or `view=zen` was applied, and call out any defaulted filename.

## Limits

The full URL must stay under **60,000 characters** (matches the editor's `URL_MAX_LENGTH`). For typical markdown this allows ~40–50kB of text after compression. If the script exits with the limit error, tell the user the note is too large to share via URL and suggest splitting it.
