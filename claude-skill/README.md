# note-directory skill

Automatically decodes and displays [note.directory](https://note.directory) URLs.

## Usage

Paste a `note.directory` URL into the chat — the skill triggers automatically and shows the note's name and content.

```
https://note.directory/#name=example.md&note=K4srzkvJLMpV0tX...
```

Works with both the current hash-based format (`#name=...&note=...`) and legacy query-parameter URLs (`?name=...&note=...`).

## Install

Place the `SKILL.md` file at:

```
~/.claude/skills/note-directory/SKILL.md
```

No other setup needed — Claude Code picks it up automatically.
