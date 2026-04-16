---
name: note-directory-share
description: Encode markdown content into a shareable https://note.directory URL. The content is raw-deflate compressed and base64url-encoded into the URL hash fragment. USE WHEN the user asks to share, create a link for, or generate a note.directory URL from text/markdown/a file.
---

## When to use this skill

Use when the user asks to:
- "Share this as a note.directory link"
- "Create a note.directory URL for ..."
- "Make a shareable link for this markdown"
- Generate a `https://note.directory/...` URL from given content or a file

If the content is not yet provided, ask for the markdown text (or a file path) and a filename before encoding.

## URL format

```
https://note.directory/?view=md|zen#name=<filename>&note=<compressed>&anchor=<heading-slug>
```

- `name` (hash) — note filename, URI-encoded (e.g. `my%20note.md`)
- `note` (hash) — content: raw-deflate compressed, then base64url-encoded (RFC 4648, no padding)
- `anchor` (hash, optional) — heading slug to scroll to on load
- `view` (query, optional) — `md` for markdown preview, `zen` for distraction-free reading

Sensitive values (`name`, `note`) live in the hash fragment so they are never sent to a server.

## How to encode

Use the Bash tool. Node's `-e` argument is single-quoted (no shell escaping needed), and the note content is fed in via a quoted heredoc on stdin so the user's text is preserved literally (no `$` expansion, no backtick execution).

Substitute `<FILENAME>` and optionally `<VIEW>` (`md` or `zen`) and `<ANCHOR>` (heading slug). Leave the optional ones empty (`""`) if unused.

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

## Output

Print the resulting URL to the user. Mention if `view=md` or `view=zen` was applied, and call out any defaulted filename.

## Limits

The full URL must stay under **60,000 characters** (matches the editor's `URL_MAX_LENGTH`). For typical markdown this allows ~40–50kB of text after compression. If the script exits with the limit error, tell the user the note is too large to share via URL and suggest splitting it.
