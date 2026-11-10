# Folders

A folder is part of a note's name: `projects/q3/plan.md` is `plan.md` in
`q3` in `projects`. Folders nest without a limit. Because they live in names,
storage, other tabs, Drive sync and the ZIP export need nothing new.

| Helper | |
| --- | --- |
| `dirOf(name)` | `"projects/q3/"`, or `""` at the top level |
| `baseOf(name)` | `"plan.md"` |
| `parentOf(dir)` | `"projects/"` |
| `cleanPath(p)` | drops `.`, empty parts, `..` above the top; `\` → `/` |
| `resolveRef(from, ref)` | a link in note `from` → the name it means (`/x.md` starts at the top) |
| `relRef(dir, name)` | the shortest link from a folder to a note (`../data.csv`) |

## Empty and closed folders

A folder exists while a note is in it. Folders made with **New folder**, and
folders whose last note moved out or was deleted, are kept in
`localStorage["notepad_folders"]` (`kept`), with the closed ones (`closed`).
That is this browser only: an empty folder has no note to sync. Deleting a
folder removes it from both.

## Sidebar

Pinned notes on top (with their folder, muted), then the tree: folders first
(natural order), then the folder's notes in your order. Click a folder to open
or close it; double-click or **Rename** to rename it.

- Drag a note onto a folder: it moves in. Onto a note: it moves into that note's
  folder, before it. Onto empty space in the list: to the top level.
- Drag a folder onto a folder or a note in one: it moves there, with everything
  in it. Not into itself, not onto a folder of the same name.
- Renaming a note edits its file name; typing `sub/x.md` moves it relative to
  its folder, `/x.md` to the top level.
- Folder menu (⋯, right-click, long press): New note / drawing / table / folder
  in it, Rename, Search in folder, Export as ZIP, Delete.
- **Delete** removes the folder and everything in it, with one Undo.

## Links

Markdown links and embeds (`[x](plan.md)`, `![](data.csv)`, `![](arch.draw)`)
are relative to the note they're in. Old links to top-level notes keep working
because top-level notes resolve the same way.

Moving or renaming notes or folders rewrites links, in every markdown note,
that point to the moved notes, and the moved notes' own links. Links in code
fences and to web addresses are left alone. Unlocked encrypted notes are rewritten and re-encrypted; locked ones are left as they are.
Each rewritten note gets an undo step.

**Backlinks**: a note's menu lists the markdown notes that link to or embed it
(**Used in**). Deleting such a note says where it was used.

## Search, ZIP, sharing

- **Search in folder** opens the palette limited to that folder (Tab or
  Backspace widens it again).
- **Export all as ZIP** keeps folders; a folder's **Export as ZIP** holds that
  folder. Importing a ZIP keeps its folders (`__MACOSX`, `.DS_Store` and folder
  entries are skipped; `..` can't climb out).
- Share links and downloads carry the file name only; a shared note opens at
  the top level.
