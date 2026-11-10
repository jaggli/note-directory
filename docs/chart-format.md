# Chart Format (`.chart`, version 1)

A chart is a plain-text note: a few setting lines and its data. `chart.js`
lays it out as a drawing (see [drawing-format.md](drawing-format.md)) and
`draw.js` renders that, so charts follow the theme, export as PNG/SVG and
embed in markdown like drawings. Shapes aren't editable; the settings are.

```
chart 1
type column
title "Visits by month"
data visits.csv
x month
y web app
colors blue peach
```

or with the rows in the file — a bare `data` line, then CSV to the end:

```
chart 1
type pie
data
browser,share
Firefox,30
Chrome,55
Safari,15
```

## Settings

One per line: the key, then its value. Values with spaces go in quotes
(`"North region"`, escapes `\"` `\\`). Defaults are left out when the app
writes a file; unknown lines are reported and kept.

| Key          | Values                                                        | Default |
| ------------ | ------------------------------------------------------------- | ------- |
| `type`       | `column bar line area pie donut stacked-column stacked-bar`  | `column` |
| `data`       | a table note (`.csv`/`.tsv`), relative to the chart; bare: inline rows follow | — |
| `range`      | part of the table: `B1:D9` (data rows numbered as in the grid, from 1) or `B:D` (every row) | whole table |
| `x`          | the column with the categories (pie: the slices)             | the range's first column if it isn't numbers, else the table's first |
| `y`          | the series columns                                           | every number column in the range but `x` |
| `title`      | text above the chart                                          | none |
| `colors`     | palette names, one per series (pie: per slice)                | `blue peach green pink yellow …` |
| `size`       | width and height in drawing units, 240–2400 × 160–1600         | `640 400` |
| `stroke`     | line and area thickness: `xs s m l xl`                        | `m` |
| `background` | `none` or a palette colour (a soft tint)                      | `none` |
| `border`     | `none` or a palette colour                                    | `none` |
| `legend`     | `auto` (more than one series, and pies), `on`, `off`          | `auto` |
| `labels`     | values on bars, points and slices: `on`, `off`                | `off` |
| `grid`       | gridlines: `on`, `off`                                        | `on` |
| `ymin` `ymax`| value axis bounds, a number or `auto`                         | `auto` |
| `xlabel` `ylabel` | axis titles: `x` is the categories, `y` the values (also on bar charts, where they swap sides) | none |

Pies and donuts use the first series. Column, bar and area charts always
include zero; line charts fit the data. Numbers in cells may carry thousands
separators, a decimal comma, currency signs, `%` or accounting parentheses.

The table's own **Header row** setting applies: without one the columns are
called A, B, C…

## In the app

- **Chart | Source**: the chart with a settings panel (type, table, columns
  and colours, labels, axes, style). Every change rewrites only its line, as
  one undo step. Text fields redraw as you type and save on Enter or leaving.
- **Add chart** in a table's toolbar, or **Create chart from range** in its
  right-click menu, makes `name.chart` next to it with the selection as
  `range` (one cell: the whole table). Sorted or filtered, the range runs from
  the selection's first to its last row in the file.
- Drag the chart's bottom-right corner to resize it (snaps to 10), or type
  the size in Style.
- **New chart** (New menus, palette, folder menu) starts with sample rows.
- Moving or renaming the table rewrites `data`; the table's menu lists the
  chart under **Used in**.
- Copy as PNG and Download as SVG work as for drawings.

## In markdown

`![](sales.chart)` embeds a chart note. A ```` ```chart ```` block holds one
inline (no `chart 1` line needed); its `data` refs resolve from the markdown
note and follow moves too. In the preview the block's **Edit** button opens
the chart editor in a full-window overlay.

A shared link carries one note: a chart whose data is another note shows
"table not found" there. Inline rows travel with it.
