# Google Drive Sync — User Flows

## UI States

| State            | Dot                    | Animation    | Label         | Menu                       |
| ---------------- | ---------------------- | ------------ | ------------- | -------------------------- |
| Disconnected     | —                      | —            | _(hidden)_    | "sync google drive" button |
| Connected (idle) | Green                  | None         | `sync`        | sync now · disconnect      |
| Syncing          | Green                  | Blinking LED | `syncing`     | —                          |
| Sync success     | Green ✔ → Green ● (2s) | None         | `sync`        | sync now · disconnect      |
| Sync failed      | Red                    | None         | `sync failed` | reconnect                  |

---

## 1. First-Time Connection

**Trigger:** User clicks "sync google drive" button.

```
driveSync()
  → closeAllMenus()
  → setSyncDotSyncing(true)          label = "syncing", dot blinks
  → gdriveAuth()                     interactive OAuth popup
    → persistToken()                 store token + expiry in localStorage
    → scheduleTokenRefresh()         timer 5 min before expiry
    → showSyncConnected()
  → fetch remote state from Drive
  → merge local ↔ remote (timestamp wins)
  → gdriveUploadState()              push merged state
  → gdriveConnected = true
  → localStorage("notepad_gdrive_connected", "true")
  → setSyncResult(true)              dot = ✔ (2s → ●)
```

**Merge strategy:** newer `updatedAt` wins. Same content → keep local. Remote-only notes added unless their ID is in `deletedIds`.

---

## 2. Autosave (typing in editor)

**Trigger:** Editor `input` event (non-vim mode).

```
scheduleSave()                       300ms debounce
  → saveState()                      write to localStorage
  → scheduleDriveUpload(false)       30s debounce
    → drivePushQuiet()               upload to Drive
      → setSyncDotSyncing(true)      dot blinks
      → gdriveUploadState()
      → setSyncResult(true)          dot = ✔ (2s → ●)
```

**Note:** 30s defensive wait batches rapid keystrokes into one upload.

---

## 3. Ctrl+S

**Trigger:** Ctrl/Cmd+S keydown.

| Context                        | Action                                              |
| ------------------------------ | --------------------------------------------------- |
| Edit mode, non-vim, `.md` file | Format markdown → save → update URL → `driveSync()` |
| Edit mode, non-vim, other file | Save → update URL → `driveSync()`                   |
| View tab (markdown preview)    | Save → update URL → `driveSync()` (no formatting)   |
| Vim mode (any file)            | Nothing — suppresses browser save only. Use `:w`    |
| Zen mode                       | Nothing — suppresses browser save only              |

`driveSync()` performs a full sync (same as first-time connection, minus auth if token is valid).

---

## 4. Vim `:w` / `:wq`

**Trigger:** User types `:w` or `:wq` in vim command bar.

```
vimWriteBuffer()
  → note.content = editor.value
  → saveState()
  → scheduleDriveUpload(true)        immediate push (no 30s wait)
    → drivePushQuiet()
  → vimState.bufferDirty = false

:wq also calls toggleVim() to exit vim mode.
```

---

## 5. File Switching

**Trigger:** User clicks a different note in the sidebar.

- **Vim mode:** blocks switch if buffer is dirty ("No write since last change")
- **Non-vim:** previous note's autosave debounce timer still runs; upload happens via the 30s `scheduleDriveUpload` timer

No immediate drive push on file switch in non-vim mode.

---

## 6. Token Refresh (background timer)

**Trigger:** Timer fires 5 minutes before token expiry.

```
scheduleTokenRefresh()
  → setTimeout(async () => {
      silentTokenRefresh()           requestAccessToken({ prompt: "" })
        → persistToken()             update token + expiry
        → scheduleTokenRefresh()     re-schedule for next expiry
    }, tokenExpiry - 5min)

On failure:
  → clearToken()
  → showSyncFailed()                red dot, "sync failed", "reconnect" menu
```

Silent refresh uses `prompt: ""` — no popup. If Google's session cookie is still valid, it works transparently. If not, it fails and shows the red dot. Recovery happens on next tab resume (see below).

---

## 7. Tab Resume (returning to backgrounded tab)

**Trigger:** `visibilitychange` (tab visible) or `focus` event.

```
onTabResume()
  → debounce (5s minimum between checks)
  → reset stuck blinking state (syncDotCount = 0)

  if token expired:
    → try silentTokenRefresh()       no popup
    → catch: try gdriveAuth()        interactive popup (user is back, ok to prompt)
    → catch: showSyncFailed()        red dot
    → on success: showSyncConnected() + driveSyncQuiet()

  if token valid:
    → driveSyncQuiet()               pull remote changes
```

This is the main recovery path. Browsers throttle/freeze timers in background tabs, so the scheduled token refresh may never fire. Tab resume detects this and re-authenticates.

---

## 8. Page Load — Valid Token

**Trigger:** Page load, `restoreToken()` returns `"ok"`.

```
gdriveConnected = true
showSyncConnected()                  green dot, "sync"
scheduleTokenRefresh()               schedule next refresh
...
if (gdriveConnected && gdriveToken)
  → driveSyncQuiet()                 pull remote changes
```

---

## 9. Page Load — Expired Token

**Trigger:** Page load, `restoreToken()` returns `"expired"`.

Token can be expired because:

- Token in localStorage has passed its expiry
- Token was cleared, but `notepad_gdrive_connected` flag is still `"true"`

```
gdriveConnected = true
showSyncFailed()                     red dot immediately (don't block init)

Background (non-blocking):
  → try silentTokenRefresh()
  → on success: showSyncConnected() + driveSyncQuiet()
  → on failure: stay in sync failed (no interactive popup)

User must re-auth manually via Ctrl+S or sync menu.
This avoids competing auth popups if the user initiates
sync themselves while a background popup is pending.
```

---

## 10. Sign Out

**Trigger:** User clicks "disconnect" in sync menu.

```
driveSignOut()
  → google.accounts.oauth2.revoke()  revoke token on Google's servers
  → clearToken()                     delete from localStorage
  → gdriveConnected = false
  → localStorage.removeItem("notepad_gdrive_connected")
  → clear all timers
  → hideSyncConnected()              hide sync UI, show "sync google drive" button
```

Local notes are **not** deleted — they remain in the browser.

---

## Error Recovery Paths

### gdriveFetch() — 401 handling

Every Drive API call goes through `gdriveFetch()` which:

1. Checks if token is expired before the request → calls `gdriveAuth()` if so
2. On 401 response → clears token, calls `gdriveAuth()`, retries once
3. If retry fails → throws error to caller

### Stuck blinking dot

`onTabResume()` always resets `syncDotCount = 0` and removes the `syncing` class, preventing stuck blinks from backgrounded tabs.

### Multiple concurrent syncs

`syncDotCount` tracks nested sync operations. The dot only stops blinking when all syncs complete, with a 900ms minimum visible time.

`gdriveUploading` flag prevents concurrent uploads — calls to `drivePushQuiet()` while an upload is in flight are silently dropped.

### No competing auth popups

Init and tab resume only attempt `silentTokenRefresh()` (no popup). If silent refresh fails, the app stays in "sync failed" — it does **not** open an interactive auth popup in the background. This prevents a race where a background popup's `clearToken()` wipes a token that the user just obtained via Ctrl+S or the sync menu.

Recovery from "sync failed" is always user-initiated: Ctrl+S (edit or view mode, non-vim), sync menu → "reconnect", or `:w` (vim mode).

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
| Blink animation cycle  | 0.9s                | LED effect                    |

---

## Storage Keys

| Key                        | Content           | Lifecycle                                        |
| -------------------------- | ----------------- | ------------------------------------------------ |
| `notepad_gdrive_token`     | `{token, expiry}` | Set on auth, cleared on expiry/signout           |
| `notepad_gdrive_connected` | `"true"`          | Set on first successful sync, cleared on signout |

`notepad_gdrive_connected` survives token expiry — ensures the app remembers the user opted into sync even if the token is gone.

---

## Data Synced to Drive

Single JSON file (`note-app-data.json`) in `appDataFolder`:

```json
{
  "notes": [...],
  "deletedIds": ["id1", "id2", ...],
  "settings": {
    "wrap": "true/false",
    "vim": "true/false",
    "sidebarWidth": "number"
  }
}
```

Settings: Google Drive is the source of truth (remote overwrites local on pull).
Notes: timestamp-based merge (newer wins per note).
Deletions: `deletedIds` is a union of both local and remote deleted IDs. Notes whose ID appears in `deletedIds` are never re-added from the other side.

---

## 11. Note Deletion & Sync

**Trigger:** User deletes a note via sidebar or Ctrl+Shift+D.

```
confirmDelete(id)
  → state.deletedIds.push(id)           record deletion
  → state.notes.splice(idx, 1)          remove from local
  → saveState()                          persist to localStorage
  → scheduleDriveUpload(true)            immediate push to Drive
```

The `deletedIds` array is included in the Drive payload. During merge (both `driveSync` and `driveSyncQuiet`):

1. Remote `deletedIds` and local `deletedIds` are unioned
2. Local notes whose ID is in remote `deletedIds` are removed
3. Remote notes whose ID is in local `deletedIds` are skipped

This prevents deleted notes from reappearing when syncing across devices or after a race between deletion and sync.
