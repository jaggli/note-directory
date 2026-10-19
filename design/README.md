# note — design system

Tokens, components and screens for note's UI, in all five themes. Dev-only:
listed in `.assetsignore`, so it is never deployed.

```sh
python3 -m http.server 4173   # from the repo root → http://localhost:4173/design/
```

| File | Holds |
| --- | --- |
| `tokens.css` | Theme palettes (`--p-*`) and the semantic tokens the UI reads (`--n-*`) |
| `ui.css` | One `n-` class per component — the same classes the app uses |
| `pages/` | One HTML file per page; screens are composed from `data-part` placeholders |
| `doc.js` | Navigation, theme picker, and the shared screen parts |
| `current/` | Screenshots of the app before the redesign |

Start at **Redesign brief**. To try a UI change, edit `ui.css`, check the
screens with **Latte beside it** on, then port it to `index.html`.
