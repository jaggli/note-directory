# Google Drive Sync

Notes sync through a single JSON file (`note-app-data.json`) in the user's
hidden `appDataFolder`. Scope: `drive.appdata` only.

## UI States

| State            | Dot                    | Animation    | Label         | Menu                       |
| ---------------- | ---------------------- | ------------ | ------------- | -------------------------- |
| Disconnected     | —                      | —            | _(hidden)_    | "enable google drive"      |
| Connected (idle) | Green                  | None         | `sync`        | sync now · disconnect      |
| Syncing          | Green                  | Blinking LED | `syncing`     | —                          |
| Sync success     | Green ✔ → Green ● (2s) | None         | `sync`        | sync now · disconnect      |
| Sync failed      | Red                    | None         | `sync failed` | reconnect                  |

---

## One sync operation

Every sync — first connect, autosave, Ctrl+S, `:w`, tab resume, page load — runs
the same `runSync()`:

```
syncNow()                          coalesces: a call during a running sync
  → navigator.locks "note-drive-sync"   schedules exactly one follow-up run;
    → runSync()                         the Web Lock serializes tabs
        list files (oldest first)
        download all of them        duplicates from racing devices are combined
        merge other tabs' localStorage writes
        three-way merge with Drive  (see below)
        save + render
        if Drive lacks something:
          re-check file version     changed since download → merge again (≤3×)
          upload to oldest file
          delete duplicate files
        store sync base             fingerprints of what was uploaded
```

There is no blind upload: autosave is a full download → merge → upload.
Drive v3 has no conditional writes, so the version re-check narrows (but cannot
close) the window for a concurrent write between check and upload.

### Merge rules

Each device stores a **sync base** (`notepad_gdrive_base`): a fingerprint of
every note (name + content + pinned) as of its last successful sync. That is
the common ancestor that tells which side changed a note.

| Situation                                   | Result                                         |
| ------------------------------------------- | ---------------------------------------------- |
| Same on both sides                          | unchanged                                      |
| Only one side changed since the base        | that side wins                                 |
| Both changed                                | newer kept, other added as `name (conflict).ext` |
| Deleted on one side, unchanged on the other | deleted                                        |
| Deleted on one side, edited on the other    | edit survives (as a new note id)               |
| No sync history (first sync after upgrade)  | newest `updatedAt` wins (previous behaviour)   |

When the remote version wins, the local note is updated in place and gets an
`updatedAt` strictly newer than before, so other tabs' merge-on-write adopt it
even if the other device's clock is behind.

Remote data is validated (`parseDrivePayload`): notes without string
`id`/`name`/`content` are dropped.

---

## Triggers

| Trigger                      | Call                          | May open popup |
| ---------------------------- | ----------------------------- | -------------- |
| "enable google drive" / "reconnect" / "sync now" / Ctrl+S | `driveSync()` | yes (user gesture) |
| Typing (after 300ms save)    | `scheduleDriveUpload(false)` → 30s debounce | no |
| Create/delete/rename/`:w`    | `scheduleDriveUpload(true)`   | no             |
| Tab hidden with pending edits | `syncNow()`                  | no             |
| Tab visible / focus (5s debounce) | `onTabResume()` → `syncNow()` | no         |
| Page load (connected)        | `syncNow()`                   | no             |

Only the **leader tab** (the last focused/visible one) syncs; a tab opened in
the background does not claim leadership until it is focused. Local saves are
not tied to leadership — every tab writes localStorage (merge-on-write).

---

## Auth

- `gdriveAuth()` — interactive popup. Only called from `driveSync()`, i.e.
  from a click or key handler. Has `error_callback`, so a closed or blocked
  popup rejects instead of hanging.
- `silentTokenRefresh()` — `prompt: ""`, never shows UI, 10s timeout. Used by
  `gdriveFetch()` when the token is missing/expired, on 401 (one retry), and by
  the refresh timer 5 min before expiry.
- If silent refresh fails, the sync fails and the UI shows "sync failed".
  Recovery is always user-initiated (reconnect, Ctrl+S).
- GIS is preloaded on page load when the user is connected, so a reconnect
  click can open the popup immediately.

---

## Sign out

```
driveSignOut()
  → syncEpoch++                      in-flight syncs abort at their next step
                                     and cannot re-mark the app as connected
  → revoke token (loads GIS if needed)
  → clear token and connected flag     (sync base is kept for reconnects)
  → hide sync UI
```

Other tabs see `notepad_gdrive_connected` removed (storage event) and sign out
locally. Likewise, a connect or token refresh in one tab is adopted by the
others. Local notes are **not** deleted.

---

## Timing Constants

| Constant               | Value               | Purpose                       |
| ---------------------- | ------------------- | ----------------------------- |
| Token refresh offset   | 5 min before expiry | Pre-emptive silent refresh    |
| Autosave debounce      | 300ms               | Batch rapid keystrokes        |
| Drive upload debounce  | 30s                 | Batch multiple saves          |
| Silent refresh timeout | 10s                 | Prevent hanging promise       |
| Blink minimum time     | 900ms               | One full animation cycle      |
| Tab resume debounce    | 5s                  | Prevent double-fire           |
| Checkmark duration     | 2s                  | ✔ shown before reverting to ● |
| Version-check retries  | 3                   | Concurrent writers            |

---

## Storage Keys

| Key                        | Content                        | Lifecycle                                |
| -------------------------- | ------------------------------ | ---------------------------------------- |
| `notepad_gdrive_token`     | `{token, expiry}`              | Set on auth, cleared on expiry/sign-out  |
| `notepad_gdrive_connected` | `"true"`                       | Set on connect, cleared on sign-out      |
| `notepad_gdrive_base`      | `{notes: {id: crc32}, syncedAt}` | Per device; written after each sync    |

---

## Data Synced to Drive

```json
{
  "notes": [{ "id", "name", "content", "updatedAt", "pinned"? }],
  "activeId": "…",
  "deletedIds": ["id1", "id2"],
  "deletedAt": { "id1": 1760000000000 },
  "settings": { "wrap": "true", "vim": "false", "sidebarWidth": "350" }
}
```

Settings are per device: remote settings are applied only when this device has
none yet (first connect).

Tombstones (`deletedIds` + `deletedAt`) expire after 6 months
(`pruneTombstones`, applied at every merge so tabs and devices agree). A
device that stays offline longer can bring a deleted note back. Tombstones
from older app versions have no `deletedAt`; they get one on first load and
expire 6 months later.
