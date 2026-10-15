# Drawing Format (`.draw`, version 1)

A drawing is a plain-text note: one line per shape, in drawing order (later
lines are drawn on top). The canvas reads and writes this text; the source
view (file → source), vim, find & replace, Drive sync and URL sharing all work on it like on
any other note.

```
draw 1
grid on
# comments and blank lines are kept
r api 0 0 160 80 c=blue f=semi "API"
e db 320 -10 140 100 c=green "Database"
a q api db "query"
p s1 c=peach 40,160 6,3 8,1 9,-2
```

## Lines

| Line                     | Meaning                                       |
| ------------------------ | --------------------------------------------- |
| `draw 1`                 | Header with the format version                |
| `grid on` / `grid off`   | Grid shown and snapping on (default: off)     |
| `# …`, blank             | Kept as they are                              |
| `<kind> <id> …`          | A shape (see below)                           |

A line is: kind, id, values, `key=value` attributes, then an optional
`"label"` at the very end. Attributes may appear anywhere after the id.

Ids are 1–16 characters of `A-Z a-z 0-9 _ -`, unique within the drawing.
Coordinates are integers in canvas units; y grows downwards.

## Shapes

| Kind | Shape       | Values                          | Label | Attributes            |
| ---- | ----------- | ------------------------------- | ----- | --------------------- |
| `r`  | rectangle   | `x y width height`              | yes   | c s f d ta va st rot gr |
| `e`  | ellipse     | `x y width height`              | yes   | c s f d ta va st rot gr |
| `m`  | diamond     | `x y width height`              | yes   | c s f d ta va st rot gr |
| `t`  | text        | `x y` (top-left)                | yes   | c s st rot gr         |
| `l`  | line        | two or more points `x,y`        | no    | c s d gr              |
| `a`  | arrow       | `start end`, each `x,y` or a shape id | yes | c s d hs he st bend gr |
| `p`  | pen stroke  | points, see below               | no    | c s rot gr            |
| `h`  | highlighter | points, see below               | no    | c s rot gr            |

**Arrows** given a shape id start/end at that shape's outline and follow it
when it moves. Only `r e m t` shapes can be targets.

**Pen and highlighter points:** the first point is absolute, every following
one is relative to the previous (`10,20 3,4 -2,5` = (10,20) (13,24) (11,29)).
Pen points may carry a pressure from 1 to 9 as a third value (`10,20,5`);
then every point has one. Strokes are stored simplified.

## Attributes

| Key    | Values                                                                 | Default |
| ------ | ---------------------------------------------------------------------- | ------- |
| `c`    | `text grey red peach yellow green teal sky blue lavender mauve pink`   | `text`  |
| `s`    | size: `s m l xl` (stroke width and font size)                           | `m`     |
| `f`    | fill: `none semi solid` (solid: outline a shade darker, label dark)    | `none`  |
| `d`    | dash: `solid dash dot`                                                 | `solid` |
| `hs`   | arrowhead at the start: `none open triangle dot diamond bar`            | `none`  |
| `he`   | arrowhead at the end: same values                                      | `open`  |
| `ta`   | label alignment in a box: `left center right`                          | `center` |
| `va`   | label alignment in a box: `top middle bottom`                          | `middle` |
| `st`   | text style, any of `b` bold, `i` italic, `u` underline (e.g. `st=bu`)   | —       |
| `bend` | arrow curve: how far its middle sits off the straight line (integer)   | `0`     |
| `rot`  | rotation in degrees, clockwise around the shape's centre (strokes: the centre of their points, which are stored upright) | `0` |
| `gr`   | group id: shapes with the same `gr` select and move together           | —       |

Colours are names from the Catppuccin Mocha palette, never raw CSS values.
Defaults are left out when the app writes a file.

## Labels

`"…"` at the end of the line. Escapes: `\"`, `\\`, `\n` (line break).
Labels wrap inside their shape at spaces; text shapes only break at `\n`.

## Errors and limits

- A line that can't be read is **kept as it is** and reported ("N lines can't be drawn · fix
  in source", with each problem in its tooltip); the rest of the drawing still works.
- An arrow pointing at an unknown id is reported the same way.
- Over 20,000 lines or 200,000 points, or a header newer than `draw 1`:
  the drawing opens **read-only** so nothing is lost by re-saving.
- Numbers are capped at ±1,000,000, labels at 5,000 characters.

## Embedding in markdown

```markdown
![architecture](arch.draw)
```

shows the note `arch.draw` (clicking it opens the drawing). That only works
where the note exists, so a shared markdown link can carry the drawing inline
instead:

````markdown
```draw
draw 1
r a 0 0 120 60 "inline"
```
````

## Versioning

The header version only changes when a version 1 reader would misread a file.
New optional attributes or shape kinds keep version 1: older readers report
those lines as ignored and keep them untouched.
