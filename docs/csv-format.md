# Tables (`.csv`, `.tsv`)

A table is a plain-text note. `.csv` and `.tsv` notes open on the **Table**
tab, a grid editor; **Source** shows the text, where vim, find & replace and
everything else work as on any note. The grid lives in `grid.js`, loaded on
demand (`loadGrid()`) like `draw.js`.

## Our dialect

What the grid writes, and what it expects to read:

| | `.csv` | `.tsv` |
| --- | --- | --- |
| Separator | `,` | tab |
| Quoting | `"…"` only when a field holds the separator, `"`, or a newline; `"` doubled | same |
| Line endings | LF, also after the last row | same |
| Encoding | UTF-8, no BOM | same |
| Rows | padded to the widest row | same |

LF rather than RFC 4180's CRLF: the textarea turns CRLF into LF anyway.

The grid reads only this dialect. Text in another one, pasted into Source,
shows as it parses (often one column). Converting happens on import.

## Import

Dropped or picked `.csv`/`.tsv` files (and those in a plain zip) are converted
to our dialect, keeping their name. The toast says what was converted.

- **Encoding**: a UTF-8 or UTF-16 BOM decides; otherwise strict UTF-8, else
  Windows-1252 (Excel's CSV in Western Europe). Zip entries are read as UTF-8.
- **Separator**: an Excel `sep=;` first line, else the one of `,` `;` tab `|`
  that splits the most lines into the same number of fields (at least two).
  Ties go to tab, then `;`, so `1,5;2,3` is semicolons with decimal commas.
  No separator found: the file is one column.
- **Line endings**: CRLF and CR become LF, also inside quoted fields.

Notes from the app's own zip export are not converted.

## Grid

- Virtualized: only the rows on screen are in the DOM; columns are sized from
  the first 300 rows.
- **Header row** (toolbar) shows row 1 as a sticky header. It is on by
  default; turning it off is stored on the note (`csvHeader: false`) on this
  device, like pins.
- Click, Shift+click, drag, or arrows (Shift extends, ⌘ jumps to the edge)
  select. Click a column letter or row number to select it, the corner for all.
- Enter, F2, a double click or typing edits a cell. Enter / Tab commit and move,
  Shift+Enter or ⌥Enter adds a line break, Esc cancels.
- Drag a column letter's right edge to resize it, double-click it to fit the
  longest value. Widths are forgotten when the note closes.
- A selection of several cells shows Sum, Average and Count in the toolbar
  (`1'234.5`, `1.234,5`, `1,234` and `12%` count as numbers; the header row
  doesn't count).
- ⌘D fills the selection down from its top row (one row: from the row above),
  ⌘R right from its left column.
- Undo and redo select the cells they change.
- **Sort** (the arrow on a column letter: ascending, descending, off; or
  right-click) and **Filter rows** (toolbar: rows containing the text, in any
  column) only change the view. The header row stays on top; without it every
  row sorts. Numbers sort by value, then text naturally (`a2` before `a10`),
  empty cells last. Row numbers stay the file's.
- Edits in a sorted or filtered view go to the rows shown and don't re-sort
  them; inserted rows stay where they were put. Outside changes (undo, Source)
  apply the sort and filter again.
- **Save sort** (toolbar, while sorted) writes the order into the file for every
  row, filtered out or not. One undo step.
- Sort and filter are forgotten when the note closes. Zen shows no toolbar;
  its column arrows still sort.
- Delete clears the selection; ⌘⌫ removes it when whole rows or columns are
  selected. ⌘C / ⌘X copy TSV, ⌘V pastes TSV (what
  spreadsheets put on the clipboard); one value pasted over a range fills it.
- **Insert ▾ / Delete ▾** (toolbar, or right-click): 1 or 10 rows above/below,
  1 or 10 columns left/right (the new ones end up selected), delete the
  selected rows or columns.
- Every finished edit is one undo step and saves through the normal note path,
  like the canvas (`drawCommit`).
- ⌘F finds in cells, including rows off screen; replace goes to Source.
  Palette line hits select their row.
- Zen shows the grid read-only.

## In markdown

A ```` ```csv ```` or ```` ```tsv ```` code block renders as a table in the
preview, zen and HTML export: same parser, first row as the header
(```` ```csv noheader ```` for none), numbers right-aligned, line breaks kept.
In the open note's preview the block has an **Edit** button: the full grid in
a full-window overlay (see [drawing.md](drawing.md#editing-inline-blocks)).

`![caption](data.csv)` embeds a table note: its current content, its own
header setting, and a caption linking to it. Missing or locked notes show
"table not found" / "encrypted". At most 1000 rows are shown, then "N more
rows". The parser (`csvParse`) lives in `app.js` for this; `grid.js` uses it.

## Download

**Download** gives the note as stored. **Download for Excel** adds a UTF-8 BOM,
CRLF and Excel's list separator for the browser's locale (`;` where the
decimal separator is a comma).
