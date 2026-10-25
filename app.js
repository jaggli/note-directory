// Theme before the page is revealed (per browser, synced via Drive settings)
const THEME_KEY = "notepad_theme";
const SYSTEM_THEME_KEY = "notepad_theme_system";
const THEMES = ["mocha", "macchiato", "frappe", "latte", "espresso"];
const lightQuery = matchMedia("(prefers-color-scheme: light)");
// Match system: latte by day, the chosen dark theme by night
function themeToShow() {
  let t = null;
  try {
    t = localStorage.getItem(THEME_KEY);
    if (localStorage.getItem(SYSTEM_THEME_KEY) === "true")
      return lightQuery.matches ? "latte" : t && t !== "latte" ? t : "mocha";
  } catch {}
  return THEMES.includes(t) ? t : THEMES[0];
}
document.documentElement.dataset.theme = themeToShow();

// Clickjacking defense: the page stays hidden (index.html) when framed.
// Hidden elements can't be clicked, so an overlay attack has nothing to hit.
if (window.top === window.self) {
  document.documentElement.style.visibility = "visible";
} else {
  try {
    window.top.location = window.location.href;
  } catch {}
}

// ═══════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.floor(hr / 24);
  if (day < 30) return day + "d ago";
  const mon = Math.floor(day / 30);
  if (mon < 12) return mon + "mo ago";
  return Math.floor(mon / 12) + "y ago";
}

function formatSize(str) {
  const bytes = new Blob([str]).size;
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + "kB";
  return bytes + "B";
}

// ═══════════════════════════════════════════════════
//  ZIP builder (DEFLATE compression)
// ═══════════════════════════════════════════════════

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateBytes(data) {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildZip(files) {
  const enc = new TextEncoder();
  const raw = files.map((f) => ({
    name: enc.encode(f.name),
    data: enc.encode(f.content),
  }));
  const entries = await Promise.all(
    raw.map(async (entry) => {
      const crc = crc32(entry.data);
      const compressed = await deflateBytes(entry.data);
      return {
        name: entry.name,
        data: entry.data,
        compressed,
        crc,
      };
    }),
  );
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const local = new Uint8Array(
      30 + entry.name.length + entry.compressed.length,
    );
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 filename
    lv.setUint16(8, 8, true);
    lv.setUint32(14, entry.crc, true);
    lv.setUint32(18, entry.compressed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    local.set(entry.compressed, 30 + entry.name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + entry.name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); // UTF-8 filename
    cv.setUint16(10, 8, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.compressed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.name.length, true);
    cv.setUint32(42, offset, true);
    central.set(entry.name, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralParts) centralSize += c.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  const result = new Uint8Array(offset + centralSize + 22);
  let pos = 0;
  for (const l of localParts) {
    result.set(l, pos);
    pos += l.length;
  }
  for (const c of centralParts) {
    result.set(c, pos);
    pos += c.length;
  }
  result.set(eocd, pos);
  return result;
}

// ═══════════════════════════════════════════════════
//  ZIP reader
// ═══════════════════════════════════════════════════

const ZIP_MAX_ENTRIES = 500;
const ZIP_MAX_ENTRY_SIZE = 10 * 1024 * 1024;
const ZIP_MAX_TOTAL_SIZE = 50 * 1024 * 1024;

async function readZip(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const len = bytes.length;

  // Find EOCD (scan backwards, max 22 + 65535 comment)
  let eocdPos = -1;
  const scanLimit = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= scanLimit; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("Invalid zip: no EOCD");

  const entryCount = view.getUint16(eocdPos + 8, true);
  const cdOffset = view.getUint32(eocdPos + 16, true);

  if (entryCount > ZIP_MAX_ENTRIES) throw new Error("Zip has too many files");
  if (cdOffset >= len) throw new Error("Invalid zip: bad CD offset");

  // Parse central directory
  const entries = [];
  let pos = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > len) throw new Error("Invalid zip: truncated CD");
    if (view.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Invalid zip: bad CD signature");

    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);

    if (pos + 46 + nameLen > len)
      throw new Error("Invalid zip: truncated name");
    const rawName = new TextDecoder().decode(
      bytes.subarray(pos + 46, pos + 46 + nameLen),
    );

    if (uncompSize > ZIP_MAX_ENTRY_SIZE)
      throw new Error("Zip entry too large: " + rawName);
    totalUncompressed += uncompSize;
    if (totalUncompressed > ZIP_MAX_TOTAL_SIZE)
      throw new Error("Zip total size too large");

    if (method === 0 || method === 8) {
      entries.push({
        rawName,
        method,
        compSize,
        uncompSize,
        localOffset,
      });
    }
    // Skip unsupported compression methods silently

    pos += 46 + nameLen + extraLen + commentLen;
  }

  // Extract data from local file headers
  const results = await Promise.all(
    entries.map(async (entry) => {
      const lh = entry.localOffset;
      if (lh + 30 > len) throw new Error("Invalid zip: bad local header");
      if (view.getUint32(lh, true) !== 0x04034b50)
        throw new Error("Invalid zip: bad local signature");
      const lhNameLen = view.getUint16(lh + 26, true);
      const lhExtraLen = view.getUint16(lh + 28, true);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      if (dataStart + entry.compSize > len)
        throw new Error("Invalid zip: truncated data");
      const compData = bytes.subarray(dataStart, dataStart + entry.compSize);

      let data;
      if (entry.method === 0) {
        data = compData;
      } else {
        const stream = new Blob([compData])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      }

      // macOS resource forks, not files
      if (entry.rawName.startsWith("__MACOSX/")) return null;
      // Only the base name is used (also for Windows "\\" paths)
      const name = entry.rawName.split(/[\\/]/).pop();
      if (!name || name === "." || name === "..") return null;

      return { name, data };
    }),
  );

  return results.filter(Boolean);
}

// ═══════════════════════════════════════════════════
//  DOM References
// ═══════════════════════════════════════════════════

const editor = document.getElementById("editor");
const gutter = document.getElementById("gutter");
const highlightLayer = document.getElementById("highlightLayer");
const editorArea = document.getElementById("editorArea");
const noteList = document.getElementById("noteList");
const cursorPos = document.getElementById("cursorPos");
const btnShare = document.getElementById("btnShare");
const btnWrap = document.getElementById("btnWrap");
const emptyState = document.getElementById("emptyState");
const modalOverlay = document.getElementById("modalOverlay");
const modalText = document.getElementById("modalText");
const modalInput = document.getElementById("modalInput");
const modalCancel = document.getElementById("modalCancel");
const modalConfirm = document.getElementById("modalConfirm");
const sidebar = document.querySelector(".sidebar");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const searchResultsList = document.getElementById("searchResultsList");
const searchCount = document.getElementById("searchCount");
const searchBackdrop = document.getElementById("searchBackdrop");
const dropOverlay = document.getElementById("dropOverlay");
const sidebarResize = document.getElementById("sidebarResize");
const findReplaceBar = document.getElementById("findReplaceBar");
const findInput = document.getElementById("findInput");
const replaceInput = document.getElementById("replaceInput");
const findReplaceCount = document.getElementById("findReplaceCount");
const mdTabs = document.getElementById("mdTabs");
const mdTabEdit = document.getElementById("mdTabEdit");
const mdTabView = document.getElementById("mdTabView");
const mdPreview = document.getElementById("mdPreview");
const mdTabZen = document.getElementById("mdTabZen");
const crumb = document.getElementById("crumb");
const crumbBtn = document.getElementById("crumbBtn");
const crumbName = document.getElementById("crumbName");
const crumbState = document.getElementById("crumbState");
const crumbInput = document.getElementById("crumbInput");
const btnNoteMenu = document.getElementById("btnNoteMenu");
const banner = document.getElementById("banner");
const statusbar = document.getElementById("statusbar");
const statusLang = document.getElementById("statusLang");
const statusSel = document.getElementById("statusSel");
const statusHint = document.getElementById("statusHint");
const vimPill = document.getElementById("vimPill");

// ═══════════════════════════════════════════════════
//  State & Storage
// ═══════════════════════════════════════════════════

const STORAGE_KEY = "notepad_data";
const SIDEBAR_WIDTH_KEY = "notepad_sidebar_width";
const WRAP_KEY = "notepad_wrap";
const VIM_KEY = "notepad_vim";
const SIDEBAR_HIDDEN_KEY = "notepad_sidebar_hidden";
const FORMAT_ON_SAVE_KEY = "notepad_format_on_save";
const SWAP_PREFIX = "notepad_swap_";
const TAB_LEADER_KEY = "notepad_tab_leader";
let state = { notes: [], activeId: null, deletedIds: [], deletedAt: {} };
let saveTimeout = null;
const tabId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let isTabLeader = false;

function claimLeadership() {
  isTabLeader = true;
  localStorage.setItem(TAB_LEADER_KEY, tabId);
}

// Leadership only decides which tab syncs with Drive — every tab saves locally
function revokeLeadership() {
  if (!isTabLeader) return;
  isTabLeader = false;
  try {
    clearTimeout(gdriveSyncTimeout);
    clearTimeout(gdriveRefreshTimer);
  } catch {}
}

// Deletion records ("tombstones") stop deleted notes from coming back via
// another tab or device. They expire after 6 months; a device offline for
// longer could bring a deleted note back. Records from before deletedAt
// existed get their 6 months from now.
const TOMBSTONE_TTL = 183 * 24 * 3600 * 1000;

function pruneTombstones() {
  const now = Date.now();
  state.deletedIds = state.deletedIds.filter((id) => {
    state.deletedAt[id] ??= now;
    if (now - state.deletedAt[id] < TOMBSTONE_TTL) return true;
    delete state.deletedAt[id];
    return false;
  });
}

// Merge another tab's stored state into ours: per note the newer updatedAt
// wins, deletions are unioned. Returns true if our state changed.
function mergeStoredState(stored) {
  if (!stored || !Array.isArray(stored.notes)) return false;
  const deleted = new Set([...state.deletedIds, ...(stored.deletedIds || [])]);
  const storedById = new Map(stored.notes.map((n) => [n.id, n]));
  const localIds = new Set(state.notes.map((n) => n.id));
  let changed = deleted.size !== state.deletedIds.length;
  const notes = stored.notes.filter((n) => !localIds.has(n.id));
  if (notes.length) changed = true;
  for (const local of state.notes) {
    const s = storedById.get(local.id);
    if (s && s.updatedAt > local.updatedAt) {
      // Update in place — UI closures hold references to note objects
      for (const k of Object.keys(local)) delete local[k];
      Object.assign(local, s);
      changed = true;
    }
    notes.push(local);
  }
  state.notes = notes.filter((n) => !deleted.has(n.id));
  state.deletedIds = [...deleted];
  for (const [id, t] of Object.entries(stored.deletedAt || {}))
    state.deletedAt[id] = Math.max(state.deletedAt[id] || 0, t);
  pruneTombstones();
  if (!getActiveNote()) state.activeId = state.notes[0]?.id ?? null;
  return changed;
}

function activeNoteVersion() {
  const note = getActiveNote();
  return note ? note.id + ":" + note.updatedAt : "";
}

// Another tab's saves: the mirror, and its journal while the mirror is off
function mergeFromStorage() {
  if (!stateLoaded) return false;
  let changed = false;
  for (const key of [STORAGE_KEY, PENDING_KEY]) {
    // Parsing a large mirror costs; skip it when nobody wrote since
    if (localStorage.getItem(key) === lastRaw[key]) continue;
    if (mergeStoredState(readStored(key))) changed = true;
  }
  return changed;
}

let _vimPreClickPos = null; // saved cursor pos before mouse click
let vimState = {
  enabled: false,
  mode: "normal",
  clipboard: "",
  clipboardLinewise: false,
  visualAnchor: 0,
  keys: [], // keys of the command being typed (see vimParse)
  lastChange: null, // for dot repeat: { keys, count, insert }
  findChar: null, // for ; and , : { char, kind }
  visualLine: false, // V mode
  visualHead: 0, // moving end of the visual selection
  insertEntry: null, // { key, pos } — how insert mode was entered
  searchDirection: 1, // 1 = forward (/), -1 = backward (?)
  bufferDirty: false, // true when buffer differs from saved content
  desiredCol: null, // sticky column for j/k movement
};

// ── IndexedDB ───────────────────────────────────────
// Notes live in IndexedDB (one record per note, plus a "state" record with
// order, active note and tombstones), which has no 5MB cap. Each save
// commits only the notes that changed, and first writes them to a small
// localStorage journal so a tab closed mid-commit loses nothing.
// localStorage also keeps a mirror of the whole state for as long as it
// fits, written at most every MIRROR_EVERY ms and when the tab is hidden
// or closed: tabs still running an older version keep seeing changes
// through storage events, and an older version would still find every
// note. Loading merges all three — newest note wins, tombstones are
// unioned — which also migrates localStorage-only data without asking.
// No IndexedDB: localStorage only, mirror on every save, as before.
const IDB_NAME = "note-directory";
const PENDING_KEY = "notepad_pending";
const MIRROR_EVERY = 2000;
let idb = null;
let stateLoaded = false;
const idbSnap = new Map(); // id → shallow copy of the note as committed
const idbGone = new Set(); // tombstoned ids already deleted from IndexedDB
let idbMetaWritten = "";
let idbBytes = 0;
let idbFlushing = null;
let idbAgain = false;
let idbFailed = false;
let mirrorOffUntil = 0;
let mirrorAt = 0;
let mirrorTimer = null;
// Last value this tab wrote or merged per key — unchanged means nothing to merge
const lastRaw = {};
let storageQuota = 0;
const notesChannel =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("note-directory")
    : null;

function idbOpen() {
  return new Promise((resolve) => {
    // Some browsers (private modes) never answer — don't hang the app
    const timer = setTimeout(() => resolve(null), 3000);
    const done = (db) => {
      clearTimeout(timer);
      resolve(db);
    };
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch {
      return done(null);
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore("notes", { keyPath: "id" });
      req.result.createObjectStore("meta");
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version upgrading the schema: step aside, mirror only
      db.onversionchange = () => {
        db.close();
        if (idb === db) idb = null;
      };
      db.onclose = () => {
        if (idb === db) idb = null;
      };
      done(db);
    };
    req.onerror = () => done(null);
  });
}

function idbReadAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["notes", "meta"], "readonly");
    const notes = tx.objectStore("notes").getAll();
    const meta = tx.objectStore("meta").get("state");
    tx.oncomplete = () => resolve({ notes: notes.result, meta: meta.result });
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Writes notes unless IndexedDB already holds a newer one (another tab);
// resolves with those newer notes so the caller can adopt them
function idbCommit(db, notes, gone, meta) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["notes", "meta"], "readwrite");
    const store = tx.objectStore("notes");
    const newer = [];
    for (const n of notes) {
      store.get(n.id).onsuccess = (e) => {
        const cur = e.target.result;
        if (cur && cur.updatedAt > n.updatedAt) newer.push(cur);
        else store.put(n);
      };
    }
    for (const id of gone) store.delete(id);
    const metaStore = tx.objectStore("meta");
    metaStore.get("state").onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) {
        // Keep tombstones another tab wrote meanwhile
        const ids = new Set(meta.deletedIds);
        for (const id of cur.deletedIds || []) {
          if (ids.has(id)) continue;
          ids.add(id);
          meta.deletedIds.push(id);
          meta.deletedAt[id] = cur.deletedAt?.[id] ?? Date.now();
        }
      }
      metaStore.put(meta, "state");
    };
    tx.oncomplete = () => resolve(newer);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    lastRaw[key] = raw;
    const s = JSON.parse(raw);
    return s && Array.isArray(s.notes) ? s : null;
  } catch {
    return null;
  }
}

// Returns true if this browser had notes before (not a first visit)
async function loadState() {
  idb = await idbOpen();
  let stored = null;
  if (idb) {
    try {
      const { notes, meta } = await idbReadAll(idb);
      if (meta || notes.length) {
        // Notes in their saved order; any the order doesn't know go first
        const pos = new Map((meta?.order || []).map((id, i) => [id, i]));
        notes.sort((a, b) => (pos.get(a.id) ?? -1) - (pos.get(b.id) ?? -1));
        stored = {
          notes,
          activeId: meta?.activeId ?? null,
          deletedIds: meta?.deletedIds || [],
          deletedAt: meta?.deletedAt || {},
        };
        for (const n of notes) setSnap(n);
        for (const id of stored.deletedIds) idbGone.add(id);
      }
    } catch {
      idb = null;
    }
  }
  const mirror = readStored(STORAGE_KEY);
  const pending = readStored(PENDING_KEY);
  // IndexedDB is committed on every save, so its order and active note
  // are the freshest; the mirror adds what older versions wrote, the
  // journal what a closed tab didn't get to commit
  state = { notes: [], activeId: null, deletedIds: [], deletedAt: {} };
  const base = stored || mirror;
  if (base) {
    state = { ...base };
    state.notes = [...base.notes];
    state.deletedIds = [...(base.deletedIds || [])];
    state.deletedAt = { ...(base.deletedAt || {}) };
  }
  if (stored && mirror) mergeStoredState(mirror);
  if (pending) mergeStoredState(pending);
  pruneTombstones();
  if (!getActiveNote()) state.activeId = state.notes[0]?.id ?? null;
  stateLoaded = true;
  if (idb) {
    navigator.storage
      ?.estimate?.()
      .then((e) => {
        storageQuota = e.quota || 0;
        updateStorageUsage();
      })
      .catch(() => {});
    // Migrates localStorage-only notes, commits a leftover journal
    scheduleIdbFlush();
  }
  return !!(base || pending);
}

// Notes hold strings and numbers only, so a shallow copy is a snapshot,
// and comparing fields finds changes without serializing — an unchanged
// content is the very same string
function setSnap(n) {
  idbBytes +=
    noteBytes(n) - (idbSnap.has(n.id) ? noteBytes(idbSnap.get(n.id)) : 0);
  idbSnap.set(n.id, { ...n });
}

function noteBytes(n) {
  return ((n.content?.length || 0) + (n.name?.length || 0)) * 2 + 100;
}

function noteChanged(n) {
  const s = idbSnap.get(n.id);
  if (!s) return true;
  for (const k in n) if (n[k] !== s[k]) return true;
  for (const k in s) if (!(k in n)) return true;
  return false;
}

function scheduleIdbFlush() {
  if (!idb) return;
  if (idbFlushing) {
    idbAgain = true;
    return;
  }
  idbFlushing = idbFlush().finally(() => {
    idbFlushing = null;
    if (idbAgain) scheduleIdbFlush();
  });
}

async function idbFlush() {
  do {
    idbAgain = false;
    const db = idb;
    if (!db) return;
    // Copies now: the editor may change the notes while this commits
    const dirty = state.notes.filter(noteChanged).map((n) => ({ ...n }));
    const gone = state.deletedIds.filter((id) => !idbGone.has(id));
    const meta = {
      order: state.notes.map((n) => n.id),
      activeId: state.activeId,
      deletedIds: [...state.deletedIds],
      deletedAt: { ...state.deletedAt },
    };
    const metaJson = JSON.stringify(meta);
    if (!dirty.length && !gone.length && metaJson === idbMetaWritten) break;
    let newer;
    try {
      newer = await idbCommit(db, dirty, gone, meta);
    } catch {
      // Disk full or IndexedDB broken: the journal still holds the notes;
      // say so once, retry on the next save
      if (!idbFailed) {
        idbFailed = true;
        showModal(
          "Couldn't save to browser storage. Free up disk space, or export your notes.",
          "ok",
          null,
        );
      }
      return;
    }
    idbFailed = false;
    const skipped = new Set(newer.map((n) => n.id));
    const written = dirty.filter((n) => !skipped.has(n.id));
    for (const n of written) setSnap(n);
    for (const id of gone) {
      idbGone.add(id);
      if (idbSnap.has(id)) {
        idbBytes -= noteBytes(idbSnap.get(id));
        idbSnap.delete(id);
      }
    }
    idbMetaWritten = metaJson;
    notesChannel?.postMessage({
      notes: written,
      deletedIds: meta.deletedIds,
      deletedAt: meta.deletedAt,
    });
    // Another tab committed a newer version meanwhile: adopt it
    if (newer.length) {
      for (const n of newer) setSnap(n);
      adoptStored({
        notes: newer,
        deletedIds: meta.deletedIds,
        deletedAt: meta.deletedAt,
      });
    }
  } while (idbAgain);
  // Everything committed: the journal has done its job
  if (!idbAgain && !state.notes.some(noteChanged)) {
    try {
      localStorage.removeItem(PENDING_KEY);
      lastRaw[PENDING_KEY] = null;
    } catch {}
  }
}

// Merge notes from another tab and repaint what changed
function adoptStored(stored) {
  const before = activeNoteVersion();
  if (!mergeStoredState(stored)) return;
  if (activeNoteVersion() !== before) {
    render();
    // The open note was deleted or changed — a stale URL would bring it back
    updateUrl();
  } else renderNoteList();
}

notesChannel?.addEventListener("message", (e) => {
  if (!stateLoaded) return;
  const msg = e.data;
  if (!msg || !Array.isArray(msg.notes)) return;
  // Already committed by the sender — no need to write them again
  for (const n of msg.notes) {
    const mine = state.notes.find((m) => m.id === n.id);
    if (!mine || mine.updatedAt <= n.updatedAt) setSnap(n);
  }
  adoptStored(msg);
});

// Notes not yet in IndexedDB, plus tombstones, where a closing tab can
// write them synchronously
function writePending() {
  try {
    const raw = JSON.stringify({
      notes: state.notes.filter(noteChanged),
      activeId: state.activeId,
      deletedIds: state.deletedIds,
      deletedAt: state.deletedAt,
    });
    localStorage.setItem(PENDING_KEY, raw);
    lastRaw[PENDING_KEY] = raw;
  } catch {}
}

// The whole state for older versions; dropped while it doesn't fit (a stale
// mirror would only shadow newer notes) and retried once a minute
function writeMirror() {
  clearTimeout(mirrorTimer);
  mirrorTimer = null;
  if (!stateLoaded || (idb && Date.now() < mirrorOffUntil)) return;
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, raw);
    lastRaw[STORAGE_KEY] = raw;
    mirrorAt = Date.now();
    mirrorOffUntil = 0;
  } catch (e) {
    if (!idb) {
      showModal(
        "Storage full. Delete some notes to free up space.",
        "ok",
        null,
      );
    } else {
      mirrorOffUntil = Date.now() + 60000;
      try {
        localStorage.removeItem(STORAGE_KEY);
        lastRaw[STORAGE_KEY] = null;
      } catch {}
    }
  }
}

// A mirror write that's still waiting happens now (tab hidden or closing)
function flushMirror() {
  if (mirrorTimer) writeMirror();
}

function wouldExceedStorage(extraBytes) {
  if (idb) return storageQuota > 0 && idbBytes + extraBytes > storageQuota;
  return getStorageUsed() + extraBytes > STORAGE_LIMIT;
}

function getStorageUsed() {
  if (idb) return idbBytes;
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += key.length + localStorage.getItem(key).length;
  }
  return total * 2;
}

function saveState() {
  if (!stateLoaded) return;
  mergeFromStorage();
  if (!idb) {
    writeMirror();
  } else {
    writePending();
    const wait = mirrorAt + MIRROR_EVERY - Date.now();
    if (wait <= 0) writeMirror();
    else if (!mirrorTimer) mirrorTimer = setTimeout(writeMirror, wait);
    scheduleIdbFlush();
  }
  updateStorageUsage();
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveState();
    scheduleDriveUpload(false);
  }, 300);
}

function swapKey(noteId) {
  return SWAP_PREFIX + noteId;
}

function saveSwap(noteId, content) {
  try {
    localStorage.setItem(
      swapKey(noteId),
      JSON.stringify({ content, timestamp: Date.now() }),
    );
  } catch {}
}

// Swap (vim crash recovery) writes the whole buffer — not on every key
let swapTimeout = null;
function scheduleSwap(noteId) {
  clearTimeout(swapTimeout);
  swapTimeout = setTimeout(() => saveSwap(noteId, editor.value), 300);
}

function loadSwap(noteId) {
  try {
    const raw = localStorage.getItem(swapKey(noteId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function deleteSwap(noteId) {
  clearTimeout(swapTimeout);
  localStorage.removeItem(swapKey(noteId));
}

// A note opened from a link stays out of the list until it is saved
let sharedNote = null;

function getActiveNote() {
  return (
    sharedNote || state.notes.find((n) => n.id === state.activeId) || null
  );
}

function sortNotes() {
  // Pinned first, then unpinned. Preserve relative order within each group.
  const pinned = state.notes.filter((n) => n.pinned);
  const unpinned = state.notes.filter((n) => !n.pinned);
  state.notes = pinned.concat(unpinned);
}

// ═══════════════════════════════════════════════════
//  Compression & URL Sync
// ═══════════════════════════════════════════════════

let urlTimeout = null;

// Streams come from a Response, not Blob.stream(): WebKit reads blobs via a
// blob: URL, which fails (uncaught) while the page unloads
async function compress(text) {
  const stream = new Response(text).body.pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function decompress(b64) {
  const binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Response(bytes).body.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return await new Response(stream).text();
}

function parseHashParams(hash) {
  const str = (hash || "").replace(/^#/, "");
  if (!str) return new Map();
  const map = new Map();
  // Malformed escapes (e.g. "#%") must not throw and abort init
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  for (const part of str.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      map.set(decode(part), "");
    } else {
      map.set(decode(part.slice(0, eq)), decode(part.slice(eq + 1)));
    }
  }
  return map;
}

function buildHash(map) {
  const parts = [];
  for (const [k, v] of map) {
    if (v === "" || v == null) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return parts.length ? "#" + parts.join("&") : "";
}

const URL_MAX_LENGTH = 60000;

let urlSeq = 0;

async function updateUrl() {
  if (zenModeActive && zenFromUrl && zenEphemeralNote) return;
  // Compression is async: a slower call for a previous note must not
  // overwrite the URL of the current one
  const seq = ++urlSeq;
  const note = getActiveNote();
  if (!note) {
    history.replaceState(null, "", location.pathname);
    return;
  }
  try {
    const compressed = await compress(note.content);
    if (seq !== urlSeq) return;
    const queryParams = new URLSearchParams();
    if (viewQuery()) queryParams.set("view", viewQuery());
    const queryStr = queryParams.toString();
    const query = queryStr ? "?" + queryStr : "";

    // A plain text= link is replaced by the compressed form
    const hashMap =
      plainTextParam(location.hash)?.params ?? parseHashParams(location.hash);
    hashMap.set("name", note.name);
    hashMap.set("note", compressed);
    hashMap.set("ts", String(note.updatedAt));
    const full = location.pathname + query + buildHash(hashMap);
    if (full.length > URL_MAX_LENGTH) {
      // Too long — drop note content from URL (Share explains why)
      hashMap.delete("note");
      hashMap.delete("ts");
      history.replaceState(
        { noteId: note.id, tab: currentTab() },
        "",
        location.pathname + query + buildHash(hashMap),
      );
    } else {
      history.replaceState({ noteId: note.id, tab: currentTab() }, "", full);
    }
  } catch {}
}

function scheduleUrlUpdate() {
  clearTimeout(urlTimeout);
  urlTimeout = setTimeout(updateUrl, 500);
}

// ═══════════════════════════════════════════════════
//  Modal
// ═══════════════════════════════════════════════════

// Focus trap: keeps Tab cycling within a container
function trapFocus(container, onKey) {
  function handler(e) {
    if (e.key === "Tab") {
      const focusable = container.querySelectorAll(
        'button:not([style*="display: none"]):not([style*="display:none"]), [href], input:not([style*="display: none"]):not([style*="display:none"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const visible = Array.from(focusable).filter(
        (el) => el.offsetParent !== null,
      );
      if (!visible.length) return;
      const first = visible[0];
      const last = visible[visible.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    if (onKey) onKey(e);
  }
  container.addEventListener("keydown", handler);
  return () => container.removeEventListener("keydown", handler);
}

// Modals share one DOM — run them one at a time
let modalQueue = Promise.resolve();
function queueModal(open) {
  const p = modalQueue.then(() => new Promise(open));
  modalQueue = p.catch(() => {});
  return p;
}

function showModal(text, confirmLabel, cancelLabel, danger) {
  return queueModal((resolve) => {
    const previousFocus = document.activeElement;
    modalText.textContent = text;
    modalInput.style.display = "none";
    modalConfirm.textContent = confirmLabel;
    modalCancel.textContent = cancelLabel || "";
    modalCancel.style.display = cancelLabel ? "" : "none";
    modalConfirm.className = danger
      ? "modal-btn modal-btn-danger"
      : "modal-btn primary";
    modalOverlay.classList.add("visible");

    let removeTrap;
    function cleanup() {
      if (removeTrap) removeTrap();
      modalOverlay.classList.remove("visible");
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlay);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    function onConfirm() {
      cleanup();
      resolve(true);
    }
    function onCancel() {
      cleanup();
      resolve(false);
    }
    function onOverlay(e) {
      if (e.target === modalOverlay) {
        cleanup();
        resolve(false);
      }
    }
    function onKey(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }

    removeTrap = trapFocus(modalOverlay, onKey);
    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlay);
    // Focus the appropriate button
    if (cancelLabel) {
      modalCancel.focus();
    } else {
      modalConfirm.focus();
    }
  });
}

function showPromptModal(text, defaultValue, confirmLabel) {
  return queueModal((resolve) => {
    const previousFocus = document.activeElement;
    modalText.textContent = text;
    modalInput.style.display = "block";
    modalInput.value = defaultValue || "";
    modalConfirm.textContent = confirmLabel || "Create";
    modalConfirm.className = "modal-btn primary";
    modalCancel.textContent = "Cancel";
    modalCancel.style.display = "";
    modalOverlay.classList.add("visible");
    modalInput.focus();
    const dot = defaultValue ? defaultValue.lastIndexOf(".") : -1;
    if (dot > 0) {
      modalInput.setSelectionRange(0, dot);
    } else {
      modalInput.select();
    }

    let removeTrap;
    function cleanup() {
      if (removeTrap) removeTrap();
      modalOverlay.classList.remove("visible");
      modalInput.style.display = "none";
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlay);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    function onConfirm() {
      const val = modalInput.value.trim();
      cleanup();
      resolve(val || null);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onOverlay(e) {
      if (e.target === modalOverlay) {
        cleanup();
        resolve(null);
      }
    }
    function onKey(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }

    removeTrap = trapFocus(modalOverlay, onKey);
    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlay);
  });
}

// ═══════════════════════════════════════════════════
//  Undo / Redo
// ═══════════════════════════════════════════════════

const histories = {};
let historyTimeout = null;
let historyNoteId = null;

function getHistory(id) {
  if (!histories[id]) histories[id] = { past: [], future: [] };
  return histories[id];
}

// Full snapshots: cap count and size (a 1MB note × 200 would be 400MB)
const HISTORY_MAX = 200;
const HISTORY_MAX_CHARS = 5e6;

function trimHistory(h) {
  let chars = h.past.reduce((n, e) => n + e.content.length, 0);
  while (
    h.past.length > HISTORY_MAX ||
    (chars > HISTORY_MAX_CHARS && h.past.length > 10)
  )
    chars -= h.past.shift().content.length;
}

function pushHistory(id, content) {
  const h = getHistory(id);
  const lastContent = h.past.length ? h.past[h.past.length - 1].content : null;
  if (content === lastContent) return;
  h.past.push({ content });
  h.future = [];
  trimHistory(h);
}

function scheduleHistorySnapshot() {
  clearTimeout(historyTimeout);
  const note = getActiveNote();
  if (!note) return;
  const id = note.id;
  const content = editor.value;
  historyNoteId = id;
  historyTimeout = setTimeout(() => {
    pushHistory(id, content);
    historyTimeout = null;
  }, 400);
}

function refreshEditor() {
  updateLineNumbers();
  updateCursorPos();
  updateHighlight();
  scheduleUrlUpdate();
}

function findFirstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

function cancelHistorySnapshot() {
  clearTimeout(historyTimeout);
  historyTimeout = null;
}

function undo() {
  const note = getActiveNote();
  if (!note) return;
  cancelHistorySnapshot();
  const h = getHistory(note.id);
  if (!h.past.length) return;
  const oldContent = editor.value;
  // Skip past entries identical to current state (snapshot duplicates)
  while (h.past.length && h.past[h.past.length - 1].content === oldContent) {
    h.past.pop();
  }
  if (!h.past.length) return;
  h.future.push({ content: oldContent });
  const entry = h.past.pop();
  editor.value = entry.content;
  const diffPos = findFirstDiff(oldContent, entry.content);
  editor.selectionStart = editor.selectionEnd = Math.min(
    diffPos,
    entry.content.length,
  );
  // The canvas edits note.content directly, so vim's buffer is not involved
  if (vimState.enabled && !drawActive()) {
    vimState.bufferDirty = entry.content !== note.content;
    // Otherwise a reload would restore the undone edit from the swap
    if (vimState.bufferDirty) saveSwap(note.id, entry.content);
    else deleteSwap(note.id);
  } else {
    note.content = entry.content;
    note.updatedAt = Date.now();
    saveState();
  }
  refreshEditor();
  if (drawActive()) window.Draw?.update(note.content);
}

function redo() {
  const note = getActiveNote();
  if (!note) return;
  cancelHistorySnapshot();
  const h = getHistory(note.id);
  if (!h.future.length) return;
  const oldContent = editor.value;
  h.past.push({ content: oldContent });
  trimHistory(h);
  const entry = h.future.pop();
  editor.value = entry.content;
  const diffPos = findFirstDiff(oldContent, entry.content);
  editor.selectionStart = editor.selectionEnd = Math.min(
    diffPos,
    entry.content.length,
  );
  // The canvas edits note.content directly, so vim's buffer is not involved
  if (vimState.enabled && !drawActive()) {
    vimState.bufferDirty = entry.content !== note.content;
    // Otherwise a reload would restore the undone edit from the swap
    if (vimState.bufferDirty) saveSwap(note.id, entry.content);
    else deleteSwap(note.id);
  } else {
    note.content = entry.content;
    note.updatedAt = Date.now();
    saveState();
  }
  refreshEditor();
  if (drawActive()) window.Draw?.update(note.content);
}

// ═══════════════════════════════════════════════════
//  Syntax Highlighting
// ═══════════════════════════════════════════════════

function getExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function tokenize(code, rules) {
  const tokens = [];
  for (const [regex, cls] of rules) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(code)) !== null) {
      tokens.push({ s: m.index, e: m.index + m[0].length, cls, t: m[0] });
    }
  }
  tokens.sort((a, b) => a.s - b.s);
  const out = [];
  let end = 0;
  for (const t of tokens) {
    if (t.s >= end) {
      out.push(t);
      end = t.e;
    }
  }
  return out;
}

// One HTML string per source line; tokens spanning lines are split so
// no <span> crosses a newline
function buildHTMLLines(code, tokens) {
  const lines = [""];
  const emit = (text, cls) => {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i) lines.push("");
      if (parts[i])
        lines[lines.length - 1] += cls
          ? `<span class="${cls}">${escapeHtml(parts[i])}</span>`
          : escapeHtml(parts[i]);
    }
  };
  let p = 0;
  for (const t of tokens) {
    if (t.s > p) emit(code.substring(p, t.s));
    emit(t.t, t.cls);
    p = t.e;
  }
  if (p < code.length) emit(code.substring(p));
  return lines;
}

// --- Language rules ---

const jsRules = [
  [/\/\/[^\n]*/g, "hl-cmt"],
  [/\/\*[\s\S]*?\*\//g, "hl-cmt"],
  [/`(?:[^`\\]|\\.)*`/g, "hl-str"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/\/(?![\/\*])(?:[^\/\\\n]|\\.)+\/[gimsuy]*/g, "hl-regex"],
  [
    /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b/g,
    "hl-num",
  ],
  [
    /\b(abstract|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|finally|for|from|function|if|implements|import|in|instanceof|interface|let|new|of|package|private|protected|public|return|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/g,
    "hl-kw",
  ],
  [
    /\b(Array|Boolean|Date|Error|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|console|document|window|null|undefined|true|false|NaN|Infinity)\b/g,
    "hl-bi",
  ],
  [/\b[a-zA-Z_$][\w$]*(?=\s*\()/g, "hl-fn"],
  [/\.[a-zA-Z_$][\w$]*/g, "hl-prop"],
  [/[+\-*/%=<>!&|^~?:]+/g, "hl-op"],
  [/[{}()\[\];,.]/g, "hl-punc"],
];

const pyRules = [
  [/#[^\n]*/g, "hl-cmt"],
  [/"""[\s\S]*?"""/g, "hl-str"],
  [/'''[\s\S]*?'''/g, "hl-str"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [
    /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b/g,
    "hl-num",
  ],
  [
    /\b(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/g,
    "hl-kw",
  ],
  [
    /\b(True|False|None|print|len|range|int|str|float|list|dict|set|tuple|type|isinstance|open|input|map|filter|sorted|enumerate|zip|super|self|cls|__init__|__name__|__main__)\b/g,
    "hl-bi",
  ],
  [/\b[a-zA-Z_]\w*(?=\s*\()/g, "hl-fn"],
  [/\.[a-zA-Z_]\w*/g, "hl-prop"],
  [/[+\-*/%=<>!&|^~@:]+/g, "hl-op"],
  [/[{}()\[\];,.]/g, "hl-punc"],
];

const cssRules = [
  [/\/\*[\s\S]*?\*\//g, "hl-cmt"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [
    /\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|s|ms|deg|rad|turn|fr|%)?/g,
    "hl-num",
  ],
  [/#[0-9a-fA-F]{3,8}\b/g, "hl-num"],
  [/@[a-z\-]+/g, "hl-kw"],
  [
    /\b(important|inherit|initial|unset|none|auto|flex|grid|block|inline|relative|absolute|fixed|sticky)\b/g,
    "hl-kw",
  ],
  [/(?<![a-z\-])[a-z\-]+(?=\s*:\s)/g, "hl-fn"],
  [/[{}();:,]/g, "hl-punc"],
];

const htmlBaseRules = [
  [/<!DOCTYPE\b[^>]*/gi, "hl-tag"],
  [/<!--[\s\S]*?-->/g, "hl-cmt"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/<\/?[a-zA-Z][a-zA-Z0-9\-]*/g, "hl-tag"],
  [/\/?>/g, "hl-tag"],
  [/(?<![a-zA-Z\-:])[a-zA-Z\-:]+(?==)/g, "hl-attr"],
  [/&[a-zA-Z]+;|&#\d+;/g, "hl-bi"],
];

const jsonRules = [
  [/"(?:[^"\\]|\\.)*"\s*(?=:)/g, "hl-key"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/\b(?:true|false|null)\b/g, "hl-kw"],
  [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "hl-num"],
  [/[{}()\[\];:,]/g, "hl-punc"],
];

const mdRules = [
  [/^#{1,6}([ \t].*)?$/gm, "hl-h"],
  [/`[^`\n]+`/g, "hl-str"],
  [/```[\s\S]*?```/g, "hl-str"],
  [/\*\*[^*]+\*\*/g, "hl-bold"],
  [/\[([^\]\n]+)\]\([^)\n]+\)/g, "hl-link"],
  [/^(\s*[-*+]|\d+\.)\s/gm, "hl-kw"],
  [/^>\s.*/gm, "hl-cmt"],
];

const shRules = [
  [/#[^\n]*/g, "hl-cmt"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'[^']*'/g, "hl-str"],
  [/\$\{?[a-zA-Z_]\w*\}?/g, "hl-bi"],
  [
    /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|local|export|source|alias|unset|readonly|declare|typeset|eval|exec|set|shift|trap|exit)\b/g,
    "hl-kw",
  ],
  [/\b\d+\b/g, "hl-num"],
  [/[|&;><]+/g, "hl-op"],
];

const goRules = [
  [/\/\/[^\n]*/g, "hl-cmt"],
  [/\/\*[\s\S]*?\*\//g, "hl-cmt"],
  [/`[^`]*`/g, "hl-str"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [
    /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b/g,
    "hl-num",
  ],
  [
    /\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/g,
    "hl-kw",
  ],
  [
    /\b(true|false|nil|iota|append|cap|close|copy|delete|imag|len|make|new|panic|print|println|real|recover|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|complex64|complex128|byte|rune|bool|error)\b/g,
    "hl-bi",
  ],
  [/\b[a-zA-Z_]\w*(?=\s*\()/g, "hl-fn"],
  [/\.[a-zA-Z_]\w*/g, "hl-prop"],
  [/[+\-*/%=<>!&|^:]+/g, "hl-op"],
  [/[{}()\[\];,.]/g, "hl-punc"],
];

const rsRules = [
  [/\/\/[^\n]*/g, "hl-cmt"],
  [/\/\*[\s\S]*?\*\//g, "hl-cmt"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [
    /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b/g,
    "hl-num",
  ],
  [
    /\b(as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield)\b/g,
    "hl-kw",
  ],
  [
    /\b(true|false|Some|None|Ok|Err|Vec|String|Box|Rc|Arc|Option|Result|println!|print!|format!|vec!|panic!|todo!|unimplemented!|assert!|assert_eq!|i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|f32|f64|bool|char|str|usize|isize)\b/g,
    "hl-bi",
  ],
  [/\b[a-zA-Z_]\w*(?=\s*[({])/g, "hl-fn"],
  [/\.[a-zA-Z_]\w*/g, "hl-prop"],
  [/[+\-*/%=<>!&|^~?:]+/g, "hl-op"],
  [/[{}()\[\];,.]/g, "hl-punc"],
];

const sqlRules = [
  [/--[^\n]*/g, "hl-cmt"],
  [/\/\*[\s\S]*?\*\//g, "hl-cmt"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/\b\d+(?:\.\d+)?\b/g, "hl-num"],
  [
    /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|ON|AND|OR|NOT|IN|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|SET|VALUES|INTO|EXISTS|BETWEEN|LIKE|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|CASCADE|IF|REPLACE|TRIGGER|FUNCTION|PROCEDURE|DECLARE|RETURNS|RETURN|WITH|RECURSIVE|EXPLAIN|ANALYZE|ASC|DESC|COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|CONVERT)\b/gi,
    "hl-kw",
  ],
  [/\b(TRUE|FALSE|NULL)\b/gi, "hl-bi"],
  [/[+\-*/%=<>!&|]+/g, "hl-op"],
  [/[{}()\[\];,.]/g, "hl-punc"],
];

const yamlRules = [
  [/#[^\n]*/g, "hl-cmt"],
  [/^[a-zA-Z_][a-zA-Z0-9_\-]*(?=\s*:)/gm, "hl-key"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/\b(true|false|null|yes|no)\b/gi, "hl-kw"],
  [/\b\d+(?:\.\d+)?\b/g, "hl-num"],
];

const tomlRules = [
  [/#[^\n]*/g, "hl-cmt"],
  [/^[ \t]*\[\[?[^\]\n]*\]\]?/gm, "hl-tag"],
  [/^[a-zA-Z_][a-zA-Z0-9_\-]*(?=\s*=)/gm, "hl-key"],
  [/"""[\s\S]*?"""/g, "hl-str"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/\b(true|false)\b/g, "hl-kw"],
  [/\b\d+(?:\.\d+)?\b/g, "hl-num"],
];

const drawRules = [
  [/^[ \t]*#[^\n]*/gm, "hl-cmt"],
  [/"(?:[^"\\\n]|\\.)*"/g, "hl-str"],
  [/^[ \t]*(?:draw|grid|[remtlaph])(?= )/gm, "hl-kw"],
  [/\b[a-z]+(?==)/g, "hl-key"],
  [/-?\b\d+\b/g, "hl-num"],
];

// --- Extension → rules mapping ---

const langRules = {
  draw: drawRules,
  js: jsRules,
  jsx: jsRules,
  ts: jsRules,
  tsx: jsRules,
  mjs: jsRules,
  cjs: jsRules,
  mts: jsRules,
  cts: jsRules,
  py: pyRules,
  pyi: pyRules,
  pyw: pyRules,
  css: cssRules,
  scss: cssRules,
  less: cssRules,
  sass: cssRules,
  json: jsonRules,
  jsonl: jsonRules,
  json5: jsonRules,
  md: mdRules,
  markdown: mdRules,
  sh: shRules,
  bash: shRules,
  zsh: shRules,
  fish: shRules,
  go: goRules,
  rs: rsRules,
  sql: sqlRules,
  yaml: yamlRules,
  yml: yamlRules,
  toml: tomlRules,
};

const htmlExts = new Set(["html", "htm", "xml", "svg", "xsl"]);

function highlightHTML(code) {
  const embedded = [];
  const blockRanges = [];
  const blockRe = /<(style|script)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let bm;
  while ((bm = blockRe.exec(code)) !== null) {
    const tag = bm[1].toLowerCase();
    const innerStart = bm.index + bm[0].indexOf(">") + 1;
    const innerEnd = bm.index + bm[0].lastIndexOf("<");
    blockRanges.push({ s: innerStart, e: innerEnd });
    const innerCode = code.substring(innerStart, innerEnd);
    const rules = tag === "style" ? cssRules : jsRules;
    const innerTokens = tokenize(innerCode, rules);
    for (const t of innerTokens) {
      t.s += innerStart;
      t.e += innerStart;
      embedded.push(t);
    }
  }
  const htmlTokens = tokenize(code, htmlBaseRules).filter((t) => {
    for (const r of blockRanges) {
      if (t.s >= r.s && t.s < r.e) return false;
    }
    return true;
  });
  const all = embedded.concat(htmlTokens);
  all.sort((a, b) => a.s - b.s);
  const merged = [];
  let end = 0;
  for (const t of all) {
    if (t.s >= end) {
      merged.push(t);
      end = t.e;
    }
  }
  return buildHTMLLines(code, merged);
}

// Beyond this, notes are shown unhighlighted to keep typing responsive
const HIGHLIGHT_MAX_CHARS = 300000;

function highlightLines(code, name) {
  const plain = () => code.split("\n").map(escapeHtml);
  try {
    if (code.length > HIGHLIGHT_MAX_CHARS) return plain();
    const ext = getExtension(name);
    if (htmlExts.has(ext)) return highlightHTML(code);
    const rules = langRules[ext];
    return rules ? buildHTMLLines(code, tokenize(code, rules)) : plain();
  } catch (e) {
    console.error("Highlight error:", e);
    return plain();
  }
}

function highlightCode(code, name) {
  return highlightLines(code, name).join("\n");
}

// The textarea's own text is transparent — this layer is what the user
// sees, so it is updated synchronously on every edit. One <div> per line;
// only lines whose HTML changed are replaced, keeping layout work small.
let _hlLines = [];

function updateHighlight() {
  const note = getActiveNote();
  if (!note) {
    highlightLayer.textContent = "";
    _hlLines = [];
    return;
  }
  const lines = highlightLines(editor.value, note.name);
  const old = _hlLines;
  const kids = highlightLayer.children;
  if (kids.length !== old.length) {
    highlightLayer.textContent = ""; // DOM out of step — full render
    old.length = 0;
  }
  const n = Math.min(lines.length, old.length);
  let a = 0;
  while (a < n && lines[a] === old[a]) a++;
  let b = 0;
  while (b < n - a && lines[lines.length - 1 - b] === old[old.length - 1 - b])
    b++;
  for (let i = old.length - b - 1; i >= a; i--) kids[i].remove();
  let html = "";
  for (let i = a; i < lines.length - b; i++)
    html += '<div class="hl-line">' + lines[i] + "\n</div>";
  const before = kids[a] || null;
  if (before) before.insertAdjacentHTML("beforebegin", html);
  else highlightLayer.insertAdjacentHTML("beforeend", html);
  _hlLines = lines;
}

// ═══════════════════════════════════════════════════
//  Rendering
// ═══════════════════════════════════════════════════

let currentLine = 1;

let _gutterLineCount = 0;
let _gutterActive = null;

function updateLineNumbers() {
  const text = editor.value || "";
  const lineCount = Math.max((text.match(/\n/g) || []).length + 1, 1);
  const wrapOn = editorArea.classList.contains("wrap");

  if (!wrapOn) {
    // Rebuild if the line count changed or heights are left from wrap mode
    if (lineCount !== _gutterLineCount || gutter.children[0]?.style.height) {
      _gutterLineCount = lineCount;
      let html = "";
      for (let i = 1; i <= lineCount; i++) {
        html += `<div class="gutter-line${i === currentLine ? " active" : ""}">${i}</div>`;
      }
      gutter.innerHTML = html;
      _gutterActive = gutter.children[currentLine - 1] || null;
    }
    return;
  }

  // Wrap mode: each gutter line is as tall as its rendered line
  syncScrollbarGap(); // content may have just gained or lost a scrollbar
  const rows = highlightLayer.children;
  if (rows.length !== lineCount) updateHighlight();
  const heights = Array.from(rows, (r) => r.offsetHeight);
  if (lineCount !== _gutterLineCount || !gutter.children[0]?.style.height) {
    _gutterLineCount = lineCount;
    let html = "";
    for (let i = 0; i < lineCount; i++)
      html += `<div class="gutter-line${i + 1 === currentLine ? " active" : ""}" style="height:${heights[i]}px">${i + 1}</div>`;
    gutter.innerHTML = html;
    _gutterActive = gutter.children[currentLine - 1] || null;
    return;
  }
  const g = gutter.children;
  for (let i = 0; i < lineCount; i++)
    if (g[i].offsetHeight !== heights[i]) g[i].style.height = heights[i] + "px";
}

// Caret position in content coordinates (padding included, scroll ignored),
// read from the rendered highlight line. Needed in wrap mode, where a line
// can span several rows.
function caretCoords(pos) {
  if (highlightLayer.children.length !== vimLineStarts().length)
    updateHighlight();
  const li = vimLineOf(pos);
  const row = highlightLayer.children[li];
  if (!row) return null;
  const layer = highlightLayer.getBoundingClientRect();
  const at = (r, x) => ({
    top: r.top - layer.top + highlightLayer.scrollTop,
    left: x - layer.left + highlightLayer.scrollLeft,
  });
  // Rect of the character at `col` (a collapsed range is ambiguous at
  // soft-wrap points); every row ends in "\n" so the char exists
  const charRect = (col) => {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && col >= node.nodeValue.length)
      col -= node.nodeValue.length;
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, col);
    range.setEnd(node, col + 1);
    const r = range.getClientRects()[0];
    return r && (r.width || r.height) ? r : null;
  };
  const col = pos - vimLineStart(li);
  const r = charRect(col);
  if (r) return at(r, r.left);
  // Firefox/Safari give no rect for "\n": use the previous char's right edge
  const prev = col > 0 && charRect(col - 1);
  if (prev) return at(prev, prev.right);
  return at(row.getBoundingClientRect(), row.getBoundingClientRect().left);
}

// Update only the active gutter line highlight without rebuilding DOM
function updateGutterActive() {
  const el = gutter.children[currentLine - 1] || null;
  if (el === _gutterActive) return;
  _gutterActive?.classList.remove("active");
  el?.classList.add("active");
  _gutterActive = el;
}

const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB
const storageUsage = document.getElementById("storageUsage");

function updateStorageUsage() {
  const bytes = getStorageUsed();
  // IndexedDB: the browser's quota (often gigabytes) — show only when near
  const limit = idb ? storageQuota : STORAGE_LIMIT;
  const pct = limit ? Math.min((bytes / limit) * 100, 100) : 0;
  if (bytes < 200 * 1024 || (idb && pct < 50)) {
    storageUsage.innerHTML = "";
    storageUsage.removeAttribute("data-tip");
    return;
  }
  const cls = pct >= 90 ? " critical" : pct >= 70 ? " warn" : "";
  const used = sizeLabel(bytes);
  const of = sizeLabel(limit);
  storageUsage.innerHTML = `<div><span>Browser storage</span><span>${used} of ${of}</span></div><div class="meter${cls}"><i style="width:${pct}%"></i></div>`;
  storageUsage.dataset.tip = `${used} of ${of} used by notes in this browser`;
}

function sizeLabel(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " kB";
}

/* Selection occurrence markers */
const occurrenceTrack = document.getElementById("occurrenceTrack");
const occurrenceOverlay = document.getElementById("occurrenceOverlay");
let occurrenceTimeout = null;

function syncOccurrenceScroll() {
  occurrenceOverlay.style.transform =
    "translate(" + -editor.scrollLeft + "px," + -editor.scrollTop + "px)";
}
let lastOccurrenceQuery = "";

// Text node + offset for a buffer position, via the line's highlight row
function highlightNodeAt(pos) {
  const li = vimLineOf(pos);
  const row = highlightLayer.children[li];
  if (!row) return null;
  let off = pos - vimLineStart(li);
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && off > node.nodeValue.length)
    off -= node.nodeValue.length;
  return node ? { node, offset: off } : null;
}

// First/last highlight rows intersecting the viewport (binary search)
function visibleRows() {
  // The layer follows the editor in its (async) scroll event: catch up first
  highlightLayer.scrollTop = editor.scrollTop;
  const rows = highlightLayer.children;
  const view = highlightLayer.getBoundingClientRect();
  const find = (y) => {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return rows.length ? [find(view.top), find(view.bottom)] : [0, -1];
}

function updateOccurrenceMarkers(force) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const text = editor.value || "";
  const selected = text.substring(start, end);

  // Clear if selection is empty, whitespace-only, or too short
  if (!selected || selected.length < 2 || /^\s+$/.test(selected)) {
    if (lastOccurrenceQuery !== "") {
      occurrenceTrack.innerHTML = "";
      occurrenceOverlay.innerHTML = "";
      lastOccurrenceQuery = "";
    }
    return;
  }

  // Outside the editor (e.g. typing in find) its selection isn't painted: the overlay marks it
  const away = document.activeElement !== editor;
  // Skip if same query (scrolling forces a redraw of the visible part)
  const key = selected + "\0" + start + away;
  if (key === lastOccurrenceQuery && !force) return;
  lastOccurrenceQuery = key;

  const matches = findAll(text, selected);
  const trackHeight = occurrenceTrack.clientHeight;
  if (matches.length < (away ? 1 : 2) || !trackHeight) {
    occurrenceTrack.innerHTML = "";
    occurrenceOverlay.innerHTML = "";
    return;
  }

  // Scrollbar track: one marker per pixel row is enough
  const totalLines = vimLastLine() + 1;
  const tops = new Set(
    matches.map((m) =>
      Math.round((vimLineOf(m.start) / totalLines) * trackHeight),
    ),
  );
  let trackHtml = "";
  for (const top of tops)
    trackHtml +=
      '<div class="occurrence-marker" style="top:' + top + 'px"></div>';

  // Text highlights only for matches on screen
  const [first, last] = visibleRows();
  const layerRect = highlightLayer.getBoundingClientRect();
  const range = document.createRange();
  let overlayHtml = "";
  for (const m of matches) {
    const li = vimLineOf(m.start);
    const current = m.start === start;
    if (li < first || li > last || (current && !away)) continue;
    const a = highlightNodeAt(m.start);
    const b = highlightNodeAt(m.end);
    if (!a || !b) continue;
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    for (const rect of range.getClientRects()) {
      overlayHtml +=
        '<div class="occurrence-highlight' +
        (current ? " current" : "") +
        '" style="top:' +
        (rect.top - layerRect.top + highlightLayer.scrollTop) +
        "px;left:" +
        (rect.left - layerRect.left + highlightLayer.scrollLeft) +
        "px;width:" +
        rect.width +
        "px;height:" +
        (rect.height + 1) +
        'px"></div>';
    }
  }

  occurrenceTrack.innerHTML = trackHtml;
  occurrenceOverlay.innerHTML = overlayHtml;
}

function scheduleOccurrenceUpdate() {
  clearTimeout(occurrenceTimeout);
  occurrenceTimeout = setTimeout(updateOccurrenceMarkers, 30);
}

function clearOccurrenceHighlights() {
  occurrenceOverlay.innerHTML = "";
  occurrenceTrack.innerHTML = "";
  lastOccurrenceQuery = "";
  clearTimeout(occurrenceTimeout);
}

// cursorPos is persisted with the next save, or when the tab is hidden
function updateCursorPos() {
  const pos = editor.selectionStart;
  const note = getActiveNote();
  if (note) note.cursorPos = pos;
  const line = vimLineOf(pos) + 1;
  const col = pos - vimLineStart(line - 1) + 1;
  currentLine = line;
  if (!mdViewActive) cursorPos.textContent = "Ln " + line + ", Col " + col;
  const selected = Math.abs(editor.selectionEnd - editor.selectionStart);
  statusSel.textContent = selected ? selected + " selected" : "";
  if (vimState.enabled && typeof vimCursorMoving === "function")
    vimCursorMoving();
  updateVimStatus();
  updateGutterActive();
  if (typeof vimUpdateBlockCursor === "function") vimUpdateBlockCursor();
  scheduleOccurrenceUpdate();
}

function updateEmptyState() {
  const note = getActiveNote();
  emptyState.classList.toggle("visible", !note);
  editor.style.display = note ? "" : "none";
  highlightLayer.style.display = note ? "" : "none";
}

function renderEditor() {
  occurrenceTrack.innerHTML = "";
  occurrenceOverlay.innerHTML = "";
  lastOccurrenceQuery = "";
  const note = getActiveNote();
  if (note) {
    editor.value = note.content;
    editor.disabled = false;
    btnShare.disabled = false;
    // Recover from swap file — unless the note was saved/synced after it
    const swap = loadSwap(note.id);
    if (
      swap &&
      swap.content !== note.content &&
      swap.timestamp > (note.updatedAt || 0)
    ) {
      if (vimState.enabled) {
        // In vim mode: load swap into buffer, mark dirty
        editor.value = swap.content;
        vimState.bufferDirty = true;
      } else {
        // Non-vim mode: swap exists from a previous vim session
        // Apply it, save to storage, and clean up
        note.content = swap.content;
        note.updatedAt = Date.now();
        editor.value = swap.content;
        saveState();
        updateUrl();
        deleteSwap(note.id);
      }
    } else if (swap) {
      // Swap is redundant or outdated — clean up
      deleteSwap(note.id);
    }
    if (note.cursorPos !== undefined) {
      editor.selectionStart = editor.selectionEnd = Math.min(
        note.cursorPos,
        editor.value.length,
      );
    }
  } else {
    editor.value = "";
    editor.disabled = true;
    btnShare.disabled = true;
  }
  updateHighlight();
  updateEmptyState();
}

// Drag reorder state
let dragSrcIdx = null;

function isMobile() {
  return window.innerWidth <= 900;
}

function icon(id, cls = "") {
  return `<svg class="icon ${cls}"><use href="#i-${id}"/></svg>`;
}

// Markdown, drawing, code or plain text: icon and colour everywhere a note is listed
function noteKind(name) {
  if (isDrawFile(name)) return { cls: "draw", icon: "file-draw" };
  if (isMarkdownFile(name)) return { cls: "md", icon: "note" };
  const ext = getExtension(name);
  if (!ext || ext === "txt" || ext === "text" || ext === "log")
    return { cls: "", icon: "note" };
  return { cls: "code", icon: "file-code" };
}

// "release-notes" with a muted ".md"
function nameHtml(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return escapeHtml(name);
  return (
    escapeHtml(name.slice(0, dot)) +
    `<span class="ext">${escapeHtml(name.slice(dot))}</span>`
  );
}

function isConflictCopy(name) {
  return /\(conflict\)\d*(\.[^.]*)?$/.test(name);
}

// "now", "2m", "3h" — the row's short form; the tooltip has the date
function shortTime(ts) {
  const t = relativeTime(ts);
  return t === "just now" ? "now" : t.replace(" ago", "");
}

function noteDetail(note) {
  const when = new Date(note.updatedAt).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    "Edited " + when + (note.content ? " · " + formatSize(note.content) : "")
  );
}

function renderNoteList() {
  noteList.innerHTML = "";
  sortNotes();
  const anyPinned = state.notes.some((n) => n.pinned);
  state.notes.forEach((note, ni) => {
    const prev = state.notes[ni - 1];
    if (anyPinned && (!prev || (prev.pinned && !note.pinned))) {
      const label = document.createElement("div");
      label.className = "list-label";
      label.textContent = note.pinned ? "Pinned" : "Notes";
      noteList.appendChild(label);
    }
    noteList.appendChild(noteRow(note, ni));
  });
}

function noteRow(note, ni) {
  const div = document.createElement("div");
  div.className = "note-item" + (note.id === state.activeId ? " active" : "");
  div.setAttribute("role", "listitem");
  div.draggable = true;
  div.dataset.idx = ni;
  div.dataset.id = note.id;
  const kind = noteKind(note.name);
  const pin = note.pinned ? "Unpin" : "Pin";
  div.innerHTML =
    icon(kind.icon, "kind " + kind.cls) +
    `<span class="note-item-name">${nameHtml(note.name)}</span>` +
    (isConflictCopy(note.name)
      ? '<span class="badge" data-tip="Edited on two devices" data-sub="This copy holds the other version">Conflict</span>'
      : "") +
    (note.pinned ? icon("pin-on", "sm row-pin") : "") +
    `<span class="note-item-time">${shortTime(note.updatedAt)}</span>` +
    `<span class="note-item-acts">` +
    `<button class="btn ghost sm square btn-pin${note.pinned ? " pinned" : ""}" data-tip="${pin}" aria-label="${pin} ${escapeHtml(note.name)}">${icon(note.pinned ? "pin-on" : "pin", "sm")}</button>` +
    `<button class="btn ghost sm square btn-more" data-tip="More actions" aria-label="More actions for ${escapeHtml(note.name)}">${icon("more", "sm")}</button>` +
    `</span>`;
  div.querySelector(".note-item-time").dataset.tip = noteDetail(note);

  div.addEventListener("dragstart", (e) => {
    dragSrcIdx = ni;
    div.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ni.toString());
  });
  div.addEventListener("dragend", () => {
    div.classList.remove("dragging");
    dragSrcIdx = null;
    noteList
      .querySelectorAll(".drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
  });
  div.addEventListener("dragover", (e) => {
    if (dragSrcIdx === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    noteList
      .querySelectorAll(".drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    div.classList.add("drag-over");
  });
  div.addEventListener("dragleave", () => div.classList.remove("drag-over"));
  div.addEventListener("drop", (e) => {
    e.preventDefault();
    div.classList.remove("drag-over");
    const fromIdx = dragSrcIdx;
    if (fromIdx === null || fromIdx === ni) return;
    const [moved] = state.notes.splice(fromIdx, 1);
    state.notes.splice(ni, 0, moved);
    saveState();
    renderNoteList();
  });

  div.addEventListener("click", (e) => {
    if (longPressed) return (longPressed = false);
    if (e.target.closest(".btn-pin")) return togglePin(note.id);
    if (e.target.closest(".btn-more"))
      return openNoteMenu(note, e.target.closest(".btn-more"));
    if (e.target.closest(".note-item-input")) return;
    if (state.activeId !== note.id || sharedNote) switchNote(note.id);
    else if (isMobile()) closeSidebar();
  });
  div.addEventListener("dblclick", (e) => {
    if (!isMobile() && !e.target.closest("button, input")) startRename(note.id);
  });
  div.addEventListener("contextmenu", (e) => {
    if (e.target.closest("input")) return;
    e.preventDefault();
    openNoteMenu(note, null, { x: e.clientX, y: e.clientY });
  });
  onLongPress(div, () => openNoteMenu(note, div));
  return div;
}

// Touch: hold a row for its actions (the click that follows is swallowed)
let longPressed = false;
function onLongPress(el, fn) {
  let timer = null;
  const cancel = () => clearTimeout(timer);
  el.addEventListener(
    "touchstart",
    () => {
      longPressed = false;
      timer = setTimeout(() => {
        longPressed = true;
        fn();
      }, 500);
    },
    { passive: true },
  );
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
}

// Rename in place. Enter or Tab commits, Esc cancels, a taken name is refused.
// Returns an error message, or null once renamed (or unchanged)
function renameNote(note, raw) {
  const name = raw.trim();
  if (!name || name === note.name) return null;
  if (state.notes.some((n) => n !== note && n.name === name))
    return "A note called " + name + " exists";
  note.name = name;
  note.updatedAt = Date.now();
  saveState();
  scheduleDriveUpload(true);
  scheduleUrlUpdate();
  updateHighlight();
  updateTitle();
  updateMdTabBar();
  return null;
}

function editName(input, note, done) {
  input.value = note.name;
  input.classList.remove("error");
  input.focus();
  const dot = note.name.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : note.name.length);
  let finished = false;
  const finish = (commit) => {
    if (finished) return true;
    if (commit) {
      const err = renameNote(note, input.value);
      if (err) {
        input.classList.add("error");
        showTip(input, err);
        return false;
      }
    }
    finished = true;
    hideTip();
    done();
    return true;
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      if (finish(true)) editor.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      editor.focus();
    }
  };
  input.oninput = () => {
    input.classList.remove("error");
    hideTip();
  };
  // Leaving with a taken name keeps the old one
  input.onblur = () => finish(true) || finish(false);
}

// In the list (double-click, row menu)
function startRename(noteId) {
  const note = state.notes.find((n) => n.id === noteId);
  const item = noteList.querySelector(`.note-item[data-id="${noteId}"]`);
  if (!note || !item) return;
  const input = document.createElement("input");
  input.className = "note-item-input";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "Note name");
  item.querySelector(".note-item-name").replaceWith(input);
  item.draggable = false;
  editName(input, note, renderNoteList);
}

// In the title bar (F2, click the name, a new note)
function renameInTitle() {
  const note = getActiveNote();
  if (!note || sharedNote) return;
  crumbBtn.hidden = true;
  crumbInput.hidden = false;
  editName(crumbInput, note, () => {
    crumbInput.hidden = true;
    crumbBtn.hidden = false;
    renderNoteList();
    updateTitleBar();
  });
}

// Refresh timestamps periodically
let timestampInterval = null;
function startTimestampRefresh() {
  clearInterval(timestampInterval);
  timestampInterval = setInterval(() => {
    for (const item of noteList.querySelectorAll(".note-item")) {
      const note = state.notes.find((n) => n.id === item.dataset.id);
      const el = item.querySelector(".note-item-time");
      if (note && el) {
        el.textContent = shortTime(note.updatedAt);
        el.dataset.tip = noteDetail(note);
      }
    }
    updateSyncLine();
  }, 30000);
}

// An installed app's window already shows the app name in front of the title
const installedApp = matchMedia("(display-mode: standalone)").matches;

function updateTitle() {
  const note = getActiveNote();
  const app = "note \u2014 minimal editor";
  document.title = installedApp ? note?.name || "" : note ? note.name + " \u00b7 " + app : app;
}

let lastRenderedId = null;

function render() {
  renderNoteList();
  renderEditor();
  updateLineNumbers();
  updateCursorPos();
  updateTitle();
  updateStorageUsage();
  updateMdTabBar();
  updateBanner();
  updateStatusBar();
  // Drawings open on the canvas; an open canvas follows outside changes
  const note = getActiveNote();
  if ((note?.id ?? null) !== lastRenderedId) {
    lastRenderedId = note?.id ?? null;
    if (note && isDrawFile(note.name) && !zenModeActive) switchMdTab("view");
    // Another note under an open preview (delete, undo, import): show it
    else if (mdViewActive && !zenModeActive)
      switchMdTab(note && hasViewTab(note.name) ? "view" : "edit");
  } else if (drawActive()) {
    window.Draw?.update(note.content);
  }
}

// ═══════════════════════════════════════════════════
//  Markdown Preview
// ═══════════════════════════════════════════════════

let mdViewActive = false;
let zenModeActive = false;
let zenFromUrl = false;
let zenEphemeralNote = null;

function isMarkdownFile(name) {
  if (!name) return false;
  const ext = getExtension(name);
  return ext === "md" || ext === "markdown";
}

// ═══════════════════════════════════════════════════
//  Drawings (.draw — editor lives in draw.js, loaded on demand)
// ═══════════════════════════════════════════════════

const drawHost = document.getElementById("drawHost");

function isDrawFile(name) {
  return !!name && getExtension(name) === "draw";
}

// Notes with a second tab: markdown preview or drawing canvas
function hasViewTab(name) {
  return isMarkdownFile(name) || isDrawFile(name);
}

// The canvas is showing an editable drawing
function drawActive() {
  return mdViewActive && !zenModeActive && isDrawFile(getActiveNote()?.name);
}

let drawLoading = null;
function loadDraw() {
  return (drawLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "draw.js";
    s.onload = resolve;
    s.onerror = () => {
      drawLoading = null;
      reject(new Error("draw.js failed to load"));
    };
    document.head.appendChild(s);
  }));
}

let drawMountSeq = 0;
function showDraw(note, readonly) {
  drawHost.classList.add("visible");
  const seq = ++drawMountSeq;
  loadDraw()
    .then(() => {
      // The tab or note may have changed while the script loaded
      if (seq !== drawMountSeq) return;
      Draw.mount(drawHost, {
        key: note.id || "zen:" + note.name,
        content: note.content,
        readonly,
        onCommit: (content) => drawCommit(note, content),
        onUndo: undo,
        onRedo: redo,
        onSource: (line) => {
          switchMdTab("edit", true);
          const lines = editor.value.split("\n").slice(0, line - 1);
          editor.selectionStart = editor.selectionEnd =
            lines.join("\n").length + (line > 1 ? 1 : 0);
          updateCursorPos();
          ensureCursorScrolloff();
        },
      });
    })
    .catch(() =>
      showToast("Couldn't load the drawing editor", { error: true }),
    );
}

function hideDraw() {
  drawMountSeq++;
  drawHost.classList.remove("visible");
  if (window.Draw) Draw.unmount();
}

// A finished canvas gesture: one undo step, then the usual save path
// `target` is the note object, so a shared drawing saved by its first
// stroke keeps receiving the strokes after it
function drawCommit(target, content) {
  if (target === sharedNote) saveShared(true);
  const note = state.notes.includes(target)
    ? target
    : state.notes.find((n) => n.id === target.id);
  if (!note || note.content === content) return;
  pushHistory(note.id, note.content);
  note.content = content;
  note.updatedAt = Date.now();
  if (note.id === state.activeId) editor.value = content;
  scheduleSave();
  scheduleUrlUpdate();
}

// Search drawings by their text only, not by coordinates
function drawSearchLines(content) {
  return content.split("\n").map((line) => {
    const m = line.match(/"((?:[^"\\]|\\.)*)"\s*$/);
    return m ? m[1].replace(/\\(.)/g, (_, c) => (c === "n" ? " " : c)) : "";
  });
}

// Fill the .draw-embed placeholders renderMarkdown left in the preview
function hydrateDrawEmbeds() {
  const embeds = mdPreview.querySelectorAll(".draw-embed");
  if (!embeds.length) return;
  loadDraw()
    .then(() => Draw.fontsReady())
    .then(() => {
      for (const el of embeds) {
        if (!el.isConnected) continue;
        const ref = el.dataset.ref;
        const note = ref
          ? state.notes.find((n) => n.name === ref) ||
            state.notes.find((n) => n.name.toLowerCase() === ref.toLowerCase())
          : null;
        if (ref && !note) {
          el.textContent = "drawing not found: " + ref;
          el.classList.add("missing");
          continue;
        }
        el.replaceChildren(
          Draw.renderStatic(note ? note.content : el.dataset.draw),
        );
        if (note) el.title = "open " + note.name;
      }
    })
    .catch(() => {});
}

// Query params whose only job is to follow the click
const TRACKING_PARAM =
  /^(utm_.*|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|igshid|li_fat_id|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|oly_anr_id|oly_enc_id|rb_clickid|s_cid|vero_id|srsltid)$/i;

function stripTracking(href) {
  try {
    const url = new URL(href);
    const keys = [...url.searchParams.keys()].filter((k) =>
      TRACKING_PARAM.test(k),
    );
    if (!keys.length) return href;
    keys.forEach((k) => url.searchParams.delete(k));
    return url.href;
  } catch {
    return href;
  }
}

// External links leave in a new tab, sending no referrer and no trackers
function externalizeLinks(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!/^https?:\/\//i.test(href)) return;
    a.setAttribute("href", stripTracking(href));
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    a.referrerPolicy = "no-referrer";
  });
}

function setPreviewHtml(html) {
  mdPreview.innerHTML = html;
  externalizeLinks(mdPreview);
  hydrateDrawEmbeds();
  if (findMatches.length && inPreviewFind()) updateFindMatches(false);
}

// ?view= value for the current tab
function viewQuery() {
  if (zenModeActive) return "zen";
  if (!mdViewActive) return "";
  return isDrawFile(getActiveNote()?.name) ? "draw" : "md";
}

// Markdown source formatter — normalizes structure without touching code blocks.
function formatMarkdown(text) {
  const lines = text.split("\n");
  const out = [];
  let inCode = false;
  let codeFence = "";
  // First pass: normalize lines, track code blocks
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // Code fence toggle
    if (!inCode) {
      const fm = raw.match(/^(`{3,})/);
      if (fm) {
        inCode = true;
        codeFence = fm[1];
        out.push({ type: "code", text: raw });
        continue;
      }
    } else {
      // Check for closing fence
      if (raw.trimEnd() === codeFence) {
        inCode = false;
        codeFence = "";
      }
      out.push({ type: "code", text: raw });
      continue;
    }

    // Details/summary tags — each tag gets its own line, content between is formatted normally
    if (/^<\/?(?:details|summary)/i.test(raw.trim())) {
      out.push({ type: "details-tag", text: raw.trim() });
      continue;
    }

    const trimmed = raw.trimEnd();

    // Blank line
    if (/^\s*$/.test(trimmed)) {
      out.push({ type: "blank", text: "" });
      continue;
    }

    // Heading
    const hm = trimmed.match(/^(#{1,6})[ \t]*(.*?)$/);
    if (hm && hm[2]) {
      out.push({ type: "heading", text: hm[1] + " " + hm[2].trim() });
      continue;
    }

    // Horizontal rule — 3+ of same char (-, *, _) with optional spaces between
    if (/^([-*_])[\s]*\1[\s]*\1[\s*_-]*$/.test(trimmed)) {
      out.push({ type: "hr", text: "---" });
      continue;
    }

    // Task list item
    const tm = raw.match(/^(\s*)-\s*\[([ x])\]\s*(.*)/);
    if (tm) {
      const depth = Math.floor(tm[1].length / 2);
      const indent = "  ".repeat(depth);
      const check = tm[2];
      out.push({
        type: "list",
        text: indent + "- [" + check + "] " + tm[3].trimEnd(),
      });
      continue;
    }

    // Unordered list item
    const um = raw.match(/^(\s*)[-*+]\s+(.*)/);
    if (um) {
      const depth = Math.floor(um[1].length / 2);
      const indent = "  ".repeat(depth);
      out.push({ type: "list", text: indent + "- " + um[2].trimEnd() });
      continue;
    }

    // Ordered list item
    const om = raw.match(/^(\s*)(\d+\.)\s+(.*)/);
    if (om) {
      const depth = Math.floor(om[1].length / 2);
      const indent = "  ".repeat(depth);
      out.push({
        type: "list",
        text: indent + om[2] + " " + om[3].trimEnd(),
      });
      continue;
    }

    // Blockquote
    const bm = trimmed.match(/^>\s?(.*)/);
    if (bm) {
      out.push({ type: "blockquote", text: "> " + bm[1].trim() });
      continue;
    }

    // Table separator
    if (/^\|[-| :]+\|$/.test(trimmed)) {
      out.push({ type: "table-sep", text: trimmed });
      continue;
    }

    // Table row
    if (/^\|.+\|$/.test(trimmed)) {
      out.push({ type: "table", text: trimmed });
      continue;
    }

    // Paragraph / other
    out.push({ type: "text", text: trimmed });
  }

  // Second pass: format tables (align columns)
  for (let i = 0; i < out.length; i++) {
    if (out[i].type !== "table" && out[i].type !== "table-sep") continue;
    // Find table block
    const start = i;
    while (
      i < out.length &&
      (out[i].type === "table" || out[i].type === "table-sep")
    )
      i++;
    const end = i;
    i--;

    // Parse cells
    const rows = [];
    let sepIdx = -1;
    for (let r = start; r < end; r++) {
      const cells = out[r].text
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      rows.push(cells);
      if (out[r].type === "table-sep") sepIdx = r - start;
    }

    if (rows.length === 0) continue;

    // Parse alignment from separator row
    const colCount = Math.max(...rows.map((r) => r.length));
    const aligns = new Array(colCount).fill("left");
    if (sepIdx >= 0) {
      const sepCells = rows[sepIdx];
      for (let c = 0; c < sepCells.length; c++) {
        const s = sepCells[c];
        const left = s.startsWith(":");
        const right = s.endsWith(":");
        if (left && right) aligns[c] = "center";
        else if (right) aligns[c] = "right";
        else aligns[c] = "left";
      }
    }

    // Compute column widths
    const widths = new Array(colCount).fill(3);
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== undefined)
          widths[c] = Math.max(widths[c], row[c].length);
      }
    }

    // Rebuild rows
    for (let r = 0; r < rows.length; r++) {
      const isSep = start + r === start + sepIdx;
      let line = "|";
      for (let c = 0; c < colCount; c++) {
        if (isSep) {
          const dashes = "-".repeat(widths[c]);
          if (aligns[c] === "center") line += " :" + dashes.slice(2) + ": |";
          else if (aligns[c] === "right") line += " " + dashes.slice(1) + ": |";
          else line += " " + dashes + " |";
        } else {
          const cell = rows[r][c] || "";
          if (aligns[c] === "right")
            line += " " + cell.padStart(widths[c]) + " |";
          else if (aligns[c] === "center") {
            const pad = widths[c] - cell.length;
            const left = Math.floor(pad / 2);
            line +=
              " " + " ".repeat(left) + cell + " ".repeat(pad - left) + " |";
          } else line += " " + cell.padEnd(widths[c]) + " |";
        }
      }
      out[start + r].text = line;
    }
  }

  // Third pass: spacing rules
  const result = [];
  const blockTypes = new Set(["heading", "hr"]);

  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const prev = out[i - 1];
    const isTableStart =
      (cur.type === "table" || cur.type === "table-sep") &&
      (!prev || (prev.type !== "table" && prev.type !== "table-sep"));
    const isListStart = cur.type === "list" && (!prev || prev.type !== "list");
    const isCodeStart = cur.type === "code" && (!prev || prev.type !== "code");
    const needsBlankBefore =
      blockTypes.has(cur.type) || isTableStart || isListStart || isCodeStart;

    // Blank line before block elements (if not already blank or first line)
    if (
      needsBlankBefore &&
      result.length > 0 &&
      result[result.length - 1] !== ""
    ) {
      result.push("");
    }

    // Add the line
    result.push(cur.text);

    // Check if we need blank line after
    const next = out[i + 1];
    const isTableEnd =
      (cur.type === "table" || cur.type === "table-sep") &&
      (!next || (next.type !== "table" && next.type !== "table-sep"));
    const isListEnd = cur.type === "list" && (!next || next.type !== "list");
    const isCodeEnd = cur.type === "code" && (!next || next.type !== "code");
    const needsBlankAfter =
      blockTypes.has(cur.type) || isTableEnd || isListEnd || isCodeEnd;

    if (needsBlankAfter && next && next.type !== "blank") {
      result.push("");
    }
  }

  // Collapse multiple blank lines
  const final = [];
  for (let i = 0; i < result.length; i++) {
    if (
      result[i] === "" &&
      final.length > 0 &&
      final[final.length - 1] === ""
    ) {
      continue; // skip consecutive blanks
    }
    final.push(result[i]);
  }

  // Trim trailing blank lines, ensure single trailing newline
  while (final.length > 0 && final[final.length - 1] === "") final.pop();
  return final.join("\n") + "\n";
}

// Secure markdown-to-HTML renderer.
// Strategy: escape ALL HTML first (so no raw tags survive),
// then parse markdown syntax on the escaped text,
// then selectively re-enable <details> and <summary> only.
function renderMarkdown(src) {
  let taskIdx = 0;
  // Step 1: escape everything to prevent XSS
  let text = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // Step 2: parse markdown on the escaped text

  // Language alias map for code blocks
  const langAliases = {
    javascript: "js",
    typescript: "ts",
    python: "py",
    rust: "rs",
    bash: "sh",
    shell: "sh",
    zsh: "sh",
    yml: "yaml",
  };

  // Fenced code blocks (``` ... ```) — stack-based parser to handle nested fences
  const codeBlocks = [];
  {
    const lines = text.split("\n");
    const result = [];
    const fenceStack = []; // stack of backtick strings for nesting
    let lang = "";
    let codeLines = [];

    function flushCodeBlock() {
      const code = codeLines.join("\n");
      const idx = codeBlocks.length;
      // ```draw blocks render as drawings (code is already HTML-escaped)
      if (lang === "draw") {
        codeBlocks.push(`<span class="draw-embed" data-draw="${code}"></span>`);
        result.push("\x00CB" + idx + "\x00");
        return;
      }
      const raw = code
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
      const ext = langAliases[lang] || lang;
      let highlighted;
      if (ext && (langRules[ext] || htmlExts.has(ext))) {
        highlighted = highlightCode(raw, "file." + ext);
      } else {
        highlighted = escapeHtml(raw);
      }
      // Split highlighted HTML at newlines, closing/re-opening spans
      const hLines = [];
      {
        let cur = "";
        const open = []; // stack of open <span> tags
        for (let j = 0; j < highlighted.length; j++) {
          if (highlighted[j] === "\n") {
            for (let k = open.length - 1; k >= 0; k--) cur += "</span>";
            hLines.push(cur);
            cur = "";
            for (const t of open) cur += t;
          } else if (highlighted[j] === "<") {
            const end = highlighted.indexOf(">", j);
            const tag = highlighted.substring(j, end + 1);
            if (tag.startsWith("</")) open.pop();
            else open.push(tag);
            cur += tag;
            j = end;
          } else {
            cur += highlighted[j];
          }
        }
        hLines.push(cur);
      }
      const wrapped = hLines
        .map(
          (l) =>
            '<span class="code-line"><span class="code-ct">' +
            (l || " ") +
            "</span></span>",
        )
        .join("");
      const plain = ["plain", "text", "txt"].includes(lang.toLowerCase());
      codeBlocks.push(
        (plain ? '<pre class="no-ln">' : "<pre>") +
          '<button class="code-copy-btn">copy</button><code>' +
          wrapped +
          "</code></pre>",
      );
      result.push("\x00CB" + idx + "\x00");
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fenceStack.length === 0) {
        // Outside any code block
        const m = line.match(/^(`{3,})(\S*)\s*$/);
        if (m) {
          fenceStack.push(m[1]);
          lang = m[2];
          codeLines = [];
        } else {
          result.push(line);
        }
      } else {
        // Inside a code block — check for closing or nested opening
        const plain = line.match(/^(`{3,})\s*$/);
        if (plain && plain[1] === fenceStack[fenceStack.length - 1]) {
          // Closing fence matches top of stack
          fenceStack.pop();
          if (fenceStack.length === 0) {
            // Outermost block closed — flush
            flushCodeBlock();
            lang = "";
            codeLines = [];
          } else {
            // Inner block closed — keep as content of outer block
            codeLines.push(line);
          }
        } else {
          // Check for nested opening fence (backticks + language tag)
          const nested = line.match(/^(`{3,})(\S+)\s*$/);
          if (nested) {
            fenceStack.push(nested[1]);
          }
          codeLines.push(line);
        }
      }
    }
    // Unclosed fence — flush remaining as a code block
    if (fenceStack.length > 0) {
      flushCodeBlock();
    }
    text = result.join("\n");
  }

  // Backslash escapes (CommonMark) — must run before inline parsing so
  // \` isn't consumed by inline-code matching. Entity-encoded chars
  // (&amp; &lt; &gt; &quot;) are matched in their already-escaped form.
  const escapes = [];
  text = text.replace(
    /\\(&amp;|&lt;|&gt;|&quot;|[!#$%'()*+,\-./:;=?@\[\\\]^_`{|}~])/g,
    (_, ch) => {
      const idx = escapes.length;
      escapes.push(ch);
      return "\x00ES" + idx + "\x00";
    },
  );

  // Inline code (must come before other inline formatting)
  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push("<code>" + code + "</code>");
    return "\x00IC" + idx + "\x00";
  });

  // Headings with anchor links
  const slugCounts = {};
  function makeHeading(level, title) {
    // Strip HTML tags for slug generation
    const plain = title.replace(/<[^>]+>/g, "").replace(/&\w+;/g, "");
    let slug = plain
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");
    if (slugCounts[slug] !== undefined) {
      slugCounts[slug]++;
      slug += "-" + slugCounts[slug];
    } else {
      slugCounts[slug] = 0;
    }
    return (
      "<h" +
      level +
      ' id="' +
      slug +
      '">' +
      '<a class="heading-anchor" href="#' +
      slug +
      '" aria-label="permalink"></a>' +
      title +
      "</h" +
      level +
      ">"
    );
  }
  text = text.replace(/^######[ \t]+(.+)$/gm, (_, t) => makeHeading(6, t));
  text = text.replace(/^#####[ \t]+(.+)$/gm, (_, t) => makeHeading(5, t));
  text = text.replace(/^####[ \t]+(.+)$/gm, (_, t) => makeHeading(4, t));
  text = text.replace(/^###[ \t]+(.+)$/gm, (_, t) => makeHeading(3, t));
  text = text.replace(/^##[ \t]+(.+)$/gm, (_, t) => makeHeading(2, t));
  text = text.replace(/^#[ \t]+(.+)$/gm, (_, t) => makeHeading(1, t));

  // Horizontal rules
  text = text.replace(/^([-*_]){3,}\s*$/gm, "<hr>");

  // Blockquotes (single-level)
  text = text.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  // Merge adjacent blockquotes
  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Lists (unordered, ordered, nested, with continuation lines)
  {
    const listRe = /^(\s*)([-*+]|\d+\.)\s/;
    const lines = text.split("\n");
    let i = 0;

    function parseList(baseIndent) {
      let html = "";
      let listTag = "";
      while (i < lines.length) {
        const m = lines[i].match(listRe);
        if (!m) break;
        const indent = m[1].length;
        if (indent < baseIndent) break;
        if (indent > baseIndent) {
          // Nested list — append to previous <li>
          const nested = parseList(indent);
          html = html.replace(/<\/li>$/, nested + "</li>");
          continue;
        }
        // Determine list type from first item
        const isOrdered = /^\d+\./.test(m[2]);
        if (!listTag) listTag = isOrdered ? "ol" : "ul";

        // Extract item content
        const content = lines[i].replace(listRe, "");
        let itemHtml = "";
        let isTask = false;
        // Check for task list
        const taskChecked = content.match(/^\[x\]\s+(.*)/);
        const taskUnchecked = content.match(/^\[\s\]\s+(.*)/);
        if (taskChecked) {
          isTask = true;
          itemHtml =
            '<input type="checkbox" checked data-task="' +
            taskIdx +
            '"><span>' +
            taskChecked[1];
          taskIdx++;
        } else if (taskUnchecked) {
          isTask = true;
          itemHtml =
            '<input type="checkbox" data-task="' +
            taskIdx +
            '"><span>' +
            taskUnchecked[1];
          taskIdx++;
        } else {
          itemHtml = content;
        }
        let prev = lines[i];
        i++;
        // Fold continuation lines into the item: indented text, or
        // unindented ("lazy") text that doesn't start another block.
        // They join with a space like a paragraph; a line ending in two
        // spaces or a backslash forces a line break.
        while (
          i < lines.length &&
          !listRe.test(lines[i]) &&
          (/^\s+\S/.test(lines[i]) ||
            (/^\S/.test(lines[i]) &&
              !/^(<(h[1-6]|hr|blockquote)|\x00CB|\||&lt;\/?(details|summary))/i.test(
                lines[i],
              )))
        ) {
          const hard = /( {2,}|\\)$/.test(prev);
          if (hard) itemHtml = itemHtml.replace(/( +|\\)$/, "");
          itemHtml += (hard ? "<br>" : " ") + lines[i].trim();
          prev = lines[i];
          i++;
        }
        if (isTask) {
          itemHtml += "</span>";
          html +=
            '<li class="task-item" data-task="' +
            (taskIdx - 1) +
            '">' +
            itemHtml +
            "</li>";
        } else {
          html += "<li>" + itemHtml + "</li>";
        }
      }
      return "<" + listTag + ">" + html + "</" + listTag + ">";
    }

    const outLines = [];
    i = 0;
    while (i < lines.length) {
      if (listRe.test(lines[i])) {
        outLines.push(parseList(lines[i].match(listRe)[1].length));
      } else {
        outLines.push(lines[i]);
        i++;
      }
    }
    text = outLines.join("\n");
  }

  // Tables
  text = text.replace(
    /^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm,
    (_, header, sep, body) => {
      const splitRow = (r) => r.split("|").slice(1, -1);
      // Parse alignment from separator row
      const aligns = splitRow(sep).map((c) => {
        const s = c.trim();
        const left = s.startsWith(":");
        const right = s.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      });
      const alignAttr = (i) => {
        const a = aligns[i];
        if (a === "right") return ' class="align-right"';
        if (a === "center") return ' class="align-center"';
        return "";
      };
      const ths = splitRow(header)
        .map((c, i) => "<th" + alignAttr(i) + ">" + c.trim() + "</th>")
        .join("");
      const rows = body
        .trim()
        .split("\n")
        .map((row) => {
          const tds = splitRow(row)
            .map((c, i) => "<td" + alignAttr(i) + ">" + c.trim() + "</td>")
            .join("");
          return "<tr>" + tds + "</tr>";
        })
        .join("");
      return (
        "<table><thead><tr>" +
        ths +
        "</tr></thead><tbody>" +
        rows +
        "</tbody></table>"
      );
    },
  );

  // Embedded drawings — ![alt](name.draw); held aside so emphasis
  // rules can't reach into the file name
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+\.draw)\)/gi, (_, alt, name) => {
    codeBlocks.push(
      `<span class="draw-embed" data-ref="${name}" role="img" aria-label="${alt || name}"></span>`,
    );
    return "\x00CB" + (codeBlocks.length - 1) + "\x00";
  });

  // Links — [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const cleanUrl = url
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .trim();
    // Only allow http(s), mailto, relative paths, and fragment links
    if (
      /^https?:\/\//i.test(cleanUrl) ||
      /^mailto:/i.test(cleanUrl) ||
      /^#/.test(cleanUrl) ||
      /^(\/|\.\/|\.\.\/)/.test(cleanUrl) ||
      !/[:]/.test(cleanUrl)
    ) {
      return (
        '<a href="' +
        url +
        '" title="' +
        url +
        '" rel="noopener noreferrer">' +
        label +
        "</a>"
      );
    }
    return "[" + label + "](" + url + ")";
  });

  // Bare URLs become links — outside tags and existing links. Held aside
  // so emphasis rules can't reach into them (a_b_c)
  const autoLinks = [];
  text = text
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/)
    .map((part, idx) =>
      idx % 2
        ? part
        : part.replace(/\bhttps?:\/\/[^\s<>"]+/gi, (url) => {
            // Trailing punctuation belongs to the sentence
            const tail = url.match(/(?:[.,;:!?'*_~]|&quot;|\))+$/);
            let end = tail ? tail[0] : "";
            url = url.slice(0, url.length - end.length);
            // Keep a closing paren that balances one in the URL
            while (
              end.startsWith(")") &&
              url.split("(").length > url.split(")").length
            ) {
              url += ")";
              end = end.slice(1);
            }
            autoLinks.push(
              '<a href="' + url + '" rel="noopener noreferrer">' + url + "</a>",
            );
            return "\x00AL" + (autoLinks.length - 1) + "\x00" + end;
          }),
    )
    .join("");

  // Bold & italic: * works inside words, _ doesn't (CommonMark)
  text = text.replace(
    /\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g,
    "<strong><em>$1</em></strong>",
  );
  text = text.replace(
    /\*\*(?!\s)(.+?)(?<!\s)\*\*/g,
    "<strong>$1</strong>",
  );
  text = text.replace(
    /\*(?!\s)(.+?)(?<!\s)\*/g,
    "<em>$1</em>",
  );
  text = text.replace(
    /(?<![a-zA-Z0-9])___(.+?)___(?![a-zA-Z0-9])/g,
    "<strong><em>$1</em></strong>",
  );
  text = text.replace(
    /(?<![a-zA-Z0-9])__(.+?)__(?![a-zA-Z0-9])/g,
    "<strong>$1</strong>",
  );
  text = text.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, "<em>$1</em>");

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Paragraphs: wrap standalone lines that aren't already block elements
  const lines = text.split("\n");
  let result = "";
  let inParagraph = false;
  const blockTag =
    /^<(h[1-6]|ul|ol|li|blockquote|pre|hr|table|thead|tbody|tr|th|td)|^\x00CB/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "") {
      if (inParagraph) {
        result += "</p>\n";
        inParagraph = false;
      } else result += "\n";
    } else if (blockTag.test(trimmed)) {
      if (inParagraph) {
        result += "</p>\n";
        inParagraph = false;
      }
      result += line + "\n";
    } else {
      if (!inParagraph) {
        result += "<p>";
        inParagraph = true;
      } else result += " ";
      result += line;
    }
  }
  if (inParagraph) result += "</p>";

  text = result;

  // Step 3: restore code blocks, inline codes, and backslash escapes
  text = text.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[+idx]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCodes[+idx]);
  text = text.replace(/\x00AL(\d+)\x00/g, (_, idx) => autoLinks[+idx]);
  text = text.replace(/\x00ES(\d+)\x00/g, (_, idx) => escapes[+idx]);

  // Step 4: selectively re-enable <details> and <summary> ONLY
  // These were escaped in step 1. We match the escaped forms exactly.
  // Safety: [^&]{0,200} cannot span past entity boundaries (&gt;, &lt;,
  // &amp;, &quot;) because step 1 escaped ALL & < > " characters.
  // The replacement always emits a bare tag — attributes are stripped
  // unconditionally. The {0,200} length cap prevents ReDoS on
  // pathological input.
  text = text.replace(/&lt;details&gt;/gi, "<details>");
  text = text.replace(/&lt;\/details&gt;/gi, "</details>");
  text = text.replace(/&lt;summary&gt;/gi, "<summary>");
  text = text.replace(/&lt;\/summary&gt;/gi, "</summary>");
  text = text.replace(/&lt;details\s[^&]{0,200}&gt;/gi, "<details>");
  text = text.replace(/&lt;summary\s[^&]{0,200}&gt;/gi, "<summary>");

  // Final href check: placeholders (e.g. "\:") were restored above, so
  // the scheme check in the link pass can be bypassed — re-check here.
  text = text.replace(/<a href="([^"]*)" title="[^"]*"/g, (m, href) =>
    !href.includes("<") && isSafeHref(href) ? m : "<a",
  );

  return text;
}

// Task items exactly as renderMarkdown sees them (outside code fences,
// any list marker), so data-task indices map to the right source line
const TASK_RE = /^(\s*(?:[-*+]|\d+\.)\s)\[(x|\s)\](?=\s)/;

function findTasks(content) {
  const tasks = [];
  const fences = [];
  let prevQuote = false;
  content.split("\n").forEach((line, i) => {
    // Consecutive "> " lines are merged into one blockquote, which
    // leaves the 2nd+ lines unprefixed and parsed as list items
    const quote = !fences.length && line.startsWith(">");
    const continued = quote && prevQuote;
    prevQuote = quote;
    if (!fences.length) {
      const open = line.match(/^(`{3,})\S*\s*$/);
      if (open) return fences.push(open[1]);
      const body = continued ? line.replace(/^>\s?/, "") : line;
      const m = body.match(TASK_RE);
      if (m)
        tasks.push({
          line: i,
          quote: line.length - body.length,
          indent: Math.floor(m[1].match(/^\s*/)[0].length / 2),
          checked: m[2] === "x",
        });
    } else if (line.match(/^(`{3,})\s*$/)?.[1] === fences[fences.length - 1]) {
      fences.pop();
    } else {
      const nested = line.match(/^(`{3,})\S+\s*$/);
      if (nested) fences.push(nested[1]);
    }
  });
  return tasks;
}

function isSafeHref(href) {
  const url = href
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    // Browsers ignore these when parsing the scheme
    .replace(/[\x00-\x20]/g, "");
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
  return !scheme || /^(https?|mailto)$/i.test(scheme[1]);
}

let mdTabsKind = "md";

function updateMdTabBar() {
  const note = getActiveNote();
  const isMd = note && hasViewTab(note.name);
  const isDraw = isDrawFile(note?.name);
  const zenEphemeral = zenModeActive && zenFromUrl && zenEphemeralNote;
  mdTabs.classList.toggle("visible", !!(isMd || zenEphemeral));
  mdTabZen.classList.toggle("visible", !!isMd);
  // Drawings: Canvas | Source
  mdTabs.classList.toggle("is-draw", isDraw);
  mdTabEdit.lastChild.textContent = isDraw ? "Source" : "Edit";
  mdTabView.lastChild.textContent = isDraw ? "Canvas" : "Preview";
  mdTabView
    .querySelector("use")
    .setAttribute("href", isDraw ? "#i-file-draw" : "#i-eye");
  if (!isMd && !zenEphemeral && mdViewActive) {
    switchMdTab("edit");
  } else if (
    mdViewActive &&
    !zenModeActive &&
    mdTabsKind !== (isDraw ? "draw" : "md")
  ) {
    // Renamed between .md and .draw while in the second tab
    switchMdTab("view");
  }
  mdTabsKind = isDraw ? "draw" : "md";
  updateTitleBar();
}

function currentTab() {
  return zenModeActive ? "zen" : mdViewActive ? "view" : "edit";
}

function switchMdTab(tab, pushHistory) {
  // Push current state for browser back/forward when user switches tabs
  if (pushHistory && tab !== currentTab()) {
    const note = getActiveNote();
    history.pushState(
      { noteId: note ? note.id : null, tab: currentTab() },
      "",
      location.href,
    );
  }
  // Preview renders note.content and edit reloads it — save the vim buffer
  // first or unsaved edits vanish
  if (tab !== "edit" && vimState.enabled && vimState.bufferDirty) {
    vimWriteBuffer();
  }
  zenModeActive = tab === "zen";
  mdViewActive = tab === "view" || tab === "zen";
  mdTabEdit.setAttribute("aria-selected", tab === "edit");
  mdTabView.setAttribute("aria-selected", tab !== "edit");
  closeFindReplace(false);

  const appEl = document.querySelector(".app");
  const zenBar = document.getElementById("zenBar");

  // Task checkbox handler shared by view and zen
  function attachCheckboxHandler() {
    let down = null;
    mdPreview.onmousedown = (e) => (down = [e.clientX, e.clientY]);
    mdPreview.onclick = (e) => {
      const li = e.target.closest("li.task-item");
      const input =
        e.target.tagName === "INPUT" && e.target.dataset.task !== undefined
          ? e.target
          : null;
      if (!li && !input) return;
      // Dragging over a task's text selects it, it isn't a click
      if (!input && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      e.preventDefault();

      // In zen mode, persist the note first if ephemeral
      if (zenModeActive && zenFromUrl && zenEphemeralNote) {
        persistZenNote();
      }
      // Ticking a task in a shared note keeps it
      if (sharedNote) saveShared(true);

      const note = getActiveNote();
      if (!note) return;
      const clickedIdx = parseInt((li || input).dataset.task);

      function parseTasks(content) {
        return findTasks(content).map((t, idx) => ({ ...t, idx }));
      }

      function setTasks(content, indices, checked) {
        const lines = content.split("\n");
        findTasks(content).forEach((t, idx) => {
          if (!indices.has(idx)) return;
          const line = lines[t.line];
          lines[t.line] =
            line.slice(0, t.quote) +
            line
              .slice(t.quote)
              .replace(
                TASK_RE,
                (_, prefix) => prefix + (checked ? "[x]" : "[ ]"),
              );
        });
        return lines.join("\n");
      }

      const tasks = parseTasks(note.content);
      const clicked = tasks[clickedIdx];
      if (!clicked) return;
      const newState = !clicked.checked;

      // Collect clicked + all descendant tasks
      const toSet = new Set([clickedIdx]);
      for (let i = clickedIdx + 1; i < tasks.length; i++) {
        if (tasks[i].indent <= clicked.indent) break;
        toSet.add(tasks[i].idx);
      }
      note.content = setTasks(note.content, toSet, newState);

      // Cascade up: auto-check/uncheck parents based on sibling state
      function cascadeUp(content, fromIdx) {
        const items = parseTasks(content);
        const child = items[fromIdx];
        let parentIdx = -1;
        for (let i = fromIdx - 1; i >= 0; i--) {
          if (items[i].indent < child.indent) {
            parentIdx = i;
            break;
          }
        }
        if (parentIdx === -1) return content;
        const parent = items[parentIdx];
        const siblings = [];
        for (let i = parentIdx + 1; i < items.length; i++) {
          if (items[i].indent <= parent.indent) break;
          if (items[i].indent === child.indent) siblings.push(items[i]);
        }
        const allChecked = siblings.every((s) => s.checked);
        if (parent.checked !== allChecked) {
          content = setTasks(content, new Set([parentIdx]), allChecked);
          content = cascadeUp(content, parentIdx);
        }
        return content;
      }
      note.content = cascadeUp(note.content, clickedIdx);

      note.updatedAt = Date.now();
      editor.value = note.content;
      saveState();
      updateUrl();
      scheduleDriveUpload(false);
      const rendered = renderMarkdown(note.content);
      setPreviewHtml(
        zenModeActive ? `<div class="zen-wrap">${rendered}</div>` : rendered,
      );
    };
  }

  // Zen shows the shared note when opened from a link
  const shownNote =
    zenModeActive && zenFromUrl && zenEphemeralNote
      ? zenEphemeralNote
      : getActiveNote();
  const showsDrawing = tab !== "edit" && isDrawFile(shownNote?.name);
  if (!showsDrawing) hideDraw();

  if (zenModeActive) {
    // Hide editor elements, show preview or canvas
    gutter.style.display = "none";
    editorArea.style.display = "none";
    emptyState.style.display = "none";
    if (showsDrawing) {
      mdPreview.classList.remove("visible");
      mdPreview.innerHTML = "";
      showDraw(shownNote, true);
    } else {
      setPreviewHtml(
        `<div class="zen-wrap">${renderMarkdown(shownNote?.content || "")}</div>`,
      );
      attachCheckboxHandler();
      mdPreview.classList.add("visible");
    }
    // Hide all chrome, show zen bar
    appEl.classList.add("zen-mode");
    const zenName =
      (zenFromUrl && zenEphemeralNote
        ? zenEphemeralNote.name
        : getActiveNote()?.name) || "untitled";
    document.getElementById("zenBarFilename").innerHTML = nameHtml(zenName);
    zenBar.style.display = "";
    document.getElementById("zenActions").style.display = "";
    document.getElementById("zenSave").hidden = !(
      zenFromUrl && zenEphemeralNote
    );
    wakeZenBar();
  } else if (tab === "view" && showsDrawing) {
    gutter.style.display = "none";
    editorArea.style.display = "none";
    emptyState.style.display = "none";
    mdPreview.classList.remove("visible");
    mdPreview.innerHTML = "";
    appEl.classList.remove("zen-mode");
    zenBar.style.display = "none";
    document.getElementById("zenActions").style.display = "none";
    showDraw(shownNote, false);
  } else if (tab === "view") {
    const note = getActiveNote();
    if (note) {
      setPreviewHtml(renderMarkdown(note.content));
    }
    attachCheckboxHandler();
    // Remember cursor line ratio before hiding editor
    const cursorLine = editor.value
      .substring(0, editor.selectionStart)
      .split("\n").length;
    const totalLines = editor.value.split("\n").length;
    const cursorRatio =
      totalLines > 1 ? (cursorLine - 1) / (totalLines - 1) : 0;
    // Hide editor elements, show preview
    gutter.style.display = "none";
    editorArea.style.display = "none";
    emptyState.style.display = "none";
    mdPreview.classList.add("visible");
    appEl.classList.remove("zen-mode");
    zenBar.style.display = "none";
    document.getElementById("zenActions").style.display = "none";
    // Scroll preview so cursor area is centered
    requestAnimationFrame(() => {
      const scrollMax = mdPreview.scrollHeight - mdPreview.clientHeight;
      if (scrollMax > 0) {
        const target =
          cursorRatio * mdPreview.scrollHeight - mdPreview.clientHeight / 2;
        mdPreview.scrollTop = Math.max(0, Math.min(target, scrollMax));
      }
    });
  } else {
    // Estimate source line from preview scroll position
    const scrollRatio =
      mdPreview.scrollHeight > mdPreview.clientHeight
        ? mdPreview.scrollTop /
          (mdPreview.scrollHeight - mdPreview.clientHeight)
        : 0;

    // Show editor elements, hide preview
    gutter.style.display = "";
    editorArea.style.display = "";
    mdPreview.classList.remove("visible");
    mdPreview.innerHTML = "";
    appEl.classList.remove("zen-mode");
    zenBar.style.display = "none";
    document.getElementById("zenActions").style.display = "none";
    // Sync editor with in-memory content (e.g. after checkbox toggle)
    const activeNote = getActiveNote();
    if (activeNote) editor.value = activeNote.content;
    updateHighlight();
    updateEmptyState();

    // Clear zen state
    zenFromUrl = false;
    zenEphemeralNote = null;

    // Jump editor to corresponding position
    const lines = editor.value.split("\n");
    const targetLine = Math.min(
      Math.floor(scrollRatio * lines.length),
      lines.length - 1,
    );
    let charOffset = 0;
    for (let i = 0; i < targetLine; i++) charOffset += lines[i].length + 1;
    editor.selectionStart = editor.selectionEnd = charOffset;

    if (vimState.enabled) {
      vimSetMode("normal");
      editor.readOnly = false;
      editor.focus();
      editor.readOnly = true;
    } else {
      editor.focus();
    }

    // Scroll editor to match preview position
    const editorScrollMax = editor.scrollHeight - editor.clientHeight;
    editor.scrollTop = Math.round(scrollRatio * editorScrollMax);
    gutter.scrollTop = editor.scrollTop;
    highlightLayer.scrollTop = editor.scrollTop;
    syncOccurrenceScroll();
    updateCursorPos();
    updateLineNumbers();
  }
  updateStatusBar();
  updateTitleBar();
  updateMdViewUrl();
}

function persistZenNote() {
  if (!(zenFromUrl && zenEphemeralNote)) return getActiveNote();
  const name = zenEphemeralNote.name;
  const content = zenEphemeralNote.content;
  const existing = state.notes.find((n) => n.name === name);
  if (existing) {
    if (existing.content === content) {
      state.activeId = existing.id;
    } else {
      const id = crypto.randomUUID();
      const now = Date.now();
      state.notes.unshift({
        id,
        name: uniqueName(name),
        content,
        updatedAt: now,
      });
      state.activeId = id;
    }
  } else {
    const id = crypto.randomUUID();
    const now = Date.now();
    state.notes.unshift({
      id,
      name,
      content,
      updatedAt: now,
    });
    state.activeId = id;
  }
  zenFromUrl = false;
  zenEphemeralNote = null;
  saveState();
  scheduleDriveUpload(false);
  return getActiveNote();
}

// Leaving a zen link shows the note under the shared banner, not saved
function exitZenMode() {
  if (zenFromUrl && zenEphemeralNote) {
    const { name, content } = zenEphemeralNote;
    zenFromUrl = false;
    zenEphemeralNote = null;
    const existing = state.notes.find((n) => n.name === name);
    if (existing && existing.content === content) state.activeId = existing.id;
    else openShared(name, content, Date.now(), existing);
  }
  const note = getActiveNote();
  const toView = note && hasViewTab(note.name) && (sharedNote || isDrawFile(note.name));
  switchMdTab(toView ? "view" : "edit", true);
  render();
  updateUrl();
}

function zenSave() {
  persistZenNote();
  document.getElementById("zenSave").hidden = true;
  showToast("Saved to your notes", { ic: "check" });
  renderNoteList();
}

// ── Shared links ───────────────────────────────────

function openShared(name, content, ts, existing) {
  sharedNote = {
    id: "shared",
    name,
    content,
    updatedAt: ts || Date.now(),
    clashId: existing?.id ?? null,
  };
}

function sharedClash() {
  return !!sharedNote?.clashId;
}

// Markdown and drawings from a link open for reading
function showSharedView() {
  if (sharedNote && hasViewTab(sharedNote.name) && !mdViewActive)
    switchMdTab("view");
}

// Save to my notes, Keep both, or the first edit: it becomes a real note
function saveShared(fromEdit = false) {
  const n = sharedNote;
  if (!n) return;
  sharedNote = null;
  if (n.clashId || state.notes.some((x) => x.name === n.name))
    n.name = uniqueName(n.name);
  delete n.clashId;
  n.id = crypto.randomUUID();
  n.updatedAt = Date.now();
  state.notes.unshift(n);
  state.activeId = n.id;
  saveState();
  scheduleDriveUpload(true);
  if (fromEdit) {
    renderNoteList();
    updateBanner();
    updateTitleBar();
  } else render();
  updateUrl();
  showToast("Saved to your notes as " + n.name, { ic: "check" });
}

function dismissShared(rerender = true) {
  const clashId = sharedNote?.clashId;
  sharedNote = null;
  if (clashId && rerender) state.activeId = clashId;
  if (!rerender) return;
  render();
  updateUrl();
}

// The copy's text goes into the original (⌘Z there brings it back), the copy goes
function useConflictCopy(copy, original) {
  pushHistory(original.id, original.content);
  original.content = copy.content;
  original.updatedAt = Date.now();
  deleteNote(copy.id);
  state.activeId = original.id;
  saveState();
  render();
  updateUrl();
}

function replaceWithShared() {
  const n = sharedNote;
  const mine = n && state.notes.find((x) => x.id === n.clashId);
  if (!mine) return;
  sharedNote = null;
  pushHistory(mine.id, mine.content);
  mine.content = n.content;
  mine.updatedAt = Date.now();
  state.activeId = mine.id;
  saveState();
  scheduleDriveUpload(true);
  render();
  updateUrl();
  showToast("Replaced your " + mine.name, { action: "Undo", onAction: undo });
}

// The original a "name (conflict).md" copy belongs to
function conflictOriginal(copy) {
  const name = copy.name.replace(/ \(conflict\)\d*(?=(\.[^.]*)?$)/, "");
  return state.notes.find((n) => n.name === name && n !== copy) || null;
}

function updateBanner() {
  const n = sharedNote;
  const active = getActiveNote();
  if (!n && active && isConflictCopy(active.name)) {
    const original = conflictOriginal(active);
    return setBanner(
      "warning",
      "conflict",
      `<b>Edited on two devices</b> <span class="sub">· this is the other version${original ? " of " + escapeHtml(original.name) : ""}</span>`,
      original
        ? [
            ["Open " + original.name, () => switchNote(original.id), "ghost"],
            ["Use this one", () => useConflictCopy(active, original)],
            ["Delete this copy", () => deleteNote(active.id)],
          ]
        : [["Delete this copy", () => deleteNote(active.id)]],
    );
  }
  if (!n) return setBanner(null);
  const name = escapeHtml(n.name);
  if (n.clashId)
    setBanner(
      "warning",
      "alert",
      `<b>You have a different ${name}</b> <span class="sub">· this is the version from the link</span>`,
      [
        ["Show mine", () => dismissShared(), "ghost"],
        ["Keep both", () => saveShared()],
        ["Replace mine", replaceWithShared],
      ],
    );
  else
    setBanner(
      "info",
      "link",
      `<b>Shared with you</b> <span class="sub">· not in your notes yet</span>`,
      [
        ["Dismiss", () => dismissShared(), "ghost"],
        ["Save to my notes", () => saveShared(), "primary"],
      ],
    );
}

// Zen shares what it shows: the shared note itself when opened from a link
function zenShare() {
  if (zenFromUrl && zenEphemeralNote) return copyLink(zenEphemeralNote);
  openShare(actionEl);
}

function updateMdViewUrl() {
  const params = new URLSearchParams();
  if (viewQuery()) params.set("view", viewQuery());
  const queryStr = params.toString();
  const query = queryStr ? "?" + queryStr : "";
  const note = getActiveNote();
  history.replaceState(
    { noteId: note ? note.id : null, tab: currentTab() },
    "",
    location.pathname + query + location.hash,
  );
}

function checkMdViewParam() {
  const params = new URLSearchParams(location.search);
  const viewParam = params.get("view");
  const hashMap = parseHashParams(location.hash);
  const anchor = hashMap.get("anchor");
  if (viewParam === "zen") {
    if (
      zenEphemeralNote ||
      (getActiveNote() && hasViewTab(getActiveNote().name))
    ) {
      switchMdTab("zen");
      if (anchor) {
        requestAnimationFrame(() => {
          const el = mdPreview.querySelector("#" + CSS.escape(anchor));
          if (el) el.scrollIntoView({ behavior: "smooth" });
        });
      }
    }
  } else if (viewParam === "md" || viewParam === "draw") {
    const note = getActiveNote();
    if (note && hasViewTab(note.name)) {
      switchMdTab("view");
      if (anchor) {
        requestAnimationFrame(() => {
          const el = mdPreview.querySelector("#" + CSS.escape(anchor));
          if (el) el.scrollIntoView({ behavior: "smooth" });
        });
      }
    }
  }
}

// Navigate to a note without creating a history entry
function navigateToNote(id, viewMd, skipUrlUpdate) {
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  // Bypass switchNote's "close md view" behavior
  state.activeId = id;
  saveState();
  render();
  if (viewMd) {
    switchMdTab("view");
  } else if (mdViewActive && !isDrawFile(getActiveNote()?.name)) {
    switchMdTab("edit");
  }
  if (!skipUrlUpdate) updateUrl();
  editor.scrollTop = 0;
  gutter.scrollTop = 0;
  highlightLayer.scrollTop = 0;
  highlightLayer.scrollLeft = 0;
  syncOccurrenceScroll();
}

const mdToast = document.getElementById("mdToast");

// Heading anchor click handler
mdPreview.addEventListener("click", (e) => {
  const anchor = e.target.closest(".heading-anchor");
  if (!anchor) return;
  e.preventDefault();
  const slug = anchor.getAttribute("href").slice(1);
  const hashMap = parseHashParams(location.hash);
  hashMap.set("anchor", slug);
  const newHash = buildHash(hashMap);
  history.replaceState(
    history.state,
    "",
    location.pathname + location.search + newHash,
  );
  const heading = anchor.closest("h1,h2,h3,h4,h5,h6");
  if (heading) heading.scrollIntoView({ behavior: "smooth" });
  const fullUrl =
    location.origin + location.pathname + location.search + newHash;
  navigator.clipboard.writeText(fullUrl).then(() => {
    const title = [...(heading?.childNodes || [])]
      .filter((n) => n !== anchor)
      .map((n) => n.textContent)
      .join("")
      .trim();
    showToast("Link to “" + (title || "heading") + "” copied", { ic: "check" });
  });
});

// Code block copy button handler
mdPreview.addEventListener("click", (e) => {
  const btn = e.target.closest(".code-copy-btn");
  if (!btn) return;
  e.preventDefault();
  const pre = btn.closest("pre");
  const cts = pre.querySelectorAll(".code-ct");
  const text = cts.length
    ? Array.from(cts, (c) => c.textContent).join("\n")
    : pre.querySelector("code")?.textContent || "";
  navigator.clipboard.writeText(text).then(() => {
    showToast("Code copied", { ic: "check" });
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 2000);
  });
});

// Intercept clicks on local note links in preview
mdPreview.addEventListener("click", (e) => {
  const a = e.target.closest("a, .draw-embed[data-ref]:not(.missing)");
  if (!a || a.classList.contains("heading-anchor")) return;
  const href = a.getAttribute("href") || a.dataset.ref;
  if (!href) return;
  if (!isSafeHref(href)) return e.preventDefault();
  // Decode escaped HTML entities back to plain text
  const clean = href
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  // Skip external links
  if (/^https?:\/\//i.test(clean) || /^mailto:/i.test(clean)) return;
  // Handle in-page anchor links
  if (/^#/.test(clean)) {
    e.preventDefault();
    const slug = clean.slice(1);
    const el = mdPreview.querySelector("#" + CSS.escape(slug));
    if (el) el.scrollIntoView({ behavior: "smooth" });
    const hashMap = parseHashParams(location.hash);
    hashMap.set("anchor", slug);
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search + buildHash(hashMap),
    );
    return;
  }
  // Try to find a note matching the link
  const target =
    state.notes.find((n) => n.name === clean) ||
    state.notes.find((n) => n.name.toLowerCase() === clean.toLowerCase());
  if (target) {
    e.preventDefault();
    // Push current state before navigating
    history.pushState(
      { noteId: state.activeId, tab: currentTab() },
      "",
      location.href,
    );
    const wantView = hasViewTab(target.name);
    navigateToNote(target.id, wantView);
    // Replace the new entry's URL with the target note's URL
    history.replaceState(
      { noteId: target.id, tab: wantView ? "view" : "edit" },
      "",
      location.href,
    );
  }
});

// Handle browser back/forward
function restoreTab(tab, note) {
  if (!note || !hasViewTab(note.name)) {
    if (mdViewActive || zenModeActive) switchMdTab("edit");
    return;
  }
  const target = tab || "edit";
  if (target !== currentTab()) switchMdTab(target);
}

window.addEventListener("popstate", async (e) => {
  if (e.state && e.state.noteId) {
    const note = state.notes.find((n) => n.id === e.state.noteId);
    if (note) {
      // Navigate without creating history or triggering tab logic
      navigateToNote(note.id, false, true);
      restoreTab(e.state.tab, note);
      const hashMap = parseHashParams(location.hash);
      const anchor = hashMap.get("anchor");
      if (anchor) {
        requestAnimationFrame(() => {
          const el = mdPreview.querySelector("#" + CSS.escape(anchor));
          if (el) el.scrollIntoView({ behavior: "smooth" });
        });
      }
    }
  } else {
    // Fallback: try to find note by name in hash — unless the URL carries
    // the content itself (a newly opened share link): that must be shown
    const hashMap = parseHashParams(location.hash);
    const name = hashMap.get("name");
    if (
      name &&
      !hashMap.get("note") &&
      plainTextParam(location.hash) === null
    ) {
      const note = state.notes.find((n) => n.name === name);
      if (note) {
        const viewParam = new URLSearchParams(location.search).get("view");
        const tab =
          viewParam === "zen"
            ? "zen"
            : viewParam === "md" || viewParam === "draw"
              ? "view"
              : "edit";
        navigateToNote(note.id, false, true);
        restoreTab(tab, note);
        const anchor = hashMap.get("anchor");
        if (anchor) {
          requestAnimationFrame(() => {
            const el = mdPreview.querySelector("#" + CSS.escape(anchor));
            if (el) el.scrollIntoView({ behavior: "smooth" });
          });
        }
        return;
      }
    }
    // Last resort: decompress from URL params
    const loaded = await loadFromUrl();
    if (loaded) {
      render();
      checkMdViewParam();
      showSharedView();
    }
  }
});

// ═══════════════════════════════════════════════════
//  Notes CRUD
// ═══════════════════════════════════════════════════

function nextNoteName(ext = "md") {
  const base = ext === "draw" ? "drawing" : "note";
  let num = 1;
  while (state.notes.some((n) => n.name === `${base}${num}.${ext}`)) num++;
  return `${base}${num}.${ext}`;
}

// "name.md" → "name1.md", "name2.md", … (first free)
function uniqueName(name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let num = 1;
  while (state.notes.some((n) => n.name === `${base}${num}${ext}`)) num++;
  return `${base}${num}${ext}`;
}

async function createNote(name, content, focusName, ext) {
  sharedNote = null;
  const contentStr = content || "";
  const estimatedBytes = (name || "").length * 2 + contentStr.length * 2 + 200;
  if (wouldExceedStorage(estimatedBytes)) {
    showToast("Not enough storage space — delete or export some notes", {
      error: true,
    });
    return null;
  }
  const note = {
    id: crypto.randomUUID(),
    name: name || nextNoteName(ext),
    content: contentStr,
    updatedAt: Date.now(),
  };
  // Notes that arrive with content (help, imports) open at the top —
  // otherwise the caret lands at the end and the preview follows it
  if (contentStr) note.cursorPos = 0;
  state.notes.unshift(note);
  state.activeId = note.id;
  saveState();
  scheduleDriveUpload(true);
  if (mdViewActive) switchMdTab("edit");
  render();
  updateUrl();
  closeSidebar();
  // Its name first: Enter or Tab drops into the text, Esc keeps the default
  if (focusName) renameInTitle();
  else editor.focus();
  return note;
}

// Immediate everywhere, undoable from the toast (or ⌘Z while it shows)
function deleteNote(id) {
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  const note = state.notes[idx];
  const wasActive = state.activeId === id;
  if (wasActive && vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  const undoStack = histories[id];
  deleteSwap(id);
  delete histories[id];
  state.deletedIds.push(id);
  state.deletedAt[id] = Date.now();
  state.notes.splice(idx, 1);
  if (wasActive) {
    state.activeId = state.notes.length
      ? state.notes[Math.min(idx, state.notes.length - 1)].id
      : null;
    vimState.bufferDirty = false;
  }
  saveState();
  scheduleDriveUpload(true);
  render();
  updateUrl();
  showToast("Deleted " + note.name, {
    action: "Undo",
    undo: true,
    // Back under a new id: other tabs and Drive already hold the tombstone
    onAction: () => {
      const back = { ...note, id: crypto.randomUUID() };
      if (undoStack) histories[back.id] = undoStack;
      state.notes.splice(Math.min(idx, state.notes.length), 0, back);
      if (wasActive) state.activeId = back.id;
      saveState();
      scheduleDriveUpload(true);
      render();
      updateUrl();
    },
  });
}

function switchNote(id) {
  if (sharedNote) dismissShared(false);
  if (vimState.enabled && vimState.bufferDirty) {
    vimWriteBuffer();
  }
  // Push current state for browser back/forward navigation
  if (state.activeId && state.activeId !== id) {
    history.pushState(
      { noteId: state.activeId, tab: currentTab() },
      "",
      location.href,
    );
  }
  // Stay in view tab if switching to another markdown file
  const targetNote = state.notes.find((n) => n.id === id);
  if (mdViewActive) {
    const fromMd = isMarkdownFile(getActiveNote()?.name);
    if (targetNote && isMarkdownFile(targetNote.name) && fromMd) {
      setPreviewHtml(renderMarkdown(targetNote.content));
    } else if (!isDrawFile(targetNote?.name)) {
      switchMdTab("edit");
    }
  }
  // Save cursor position of current note before switching
  const prevNote = getActiveNote();
  if (prevNote) prevNote.cursorPos = editor.selectionStart;
  state.activeId = id;
  saveState();
  render();
  updateUrl();
  closeSidebar();
  // Scroll cursor into view (renderEditor restored cursorPos)
  editor.focus();
  requestAnimationFrame(() => {
    gutter.scrollTop = editor.scrollTop;
    highlightLayer.scrollTop = editor.scrollTop;
    highlightLayer.scrollLeft = editor.scrollLeft;
    syncOccurrenceScroll();
  });
  // Reset vim state — always do a full reset (not conditional on mode)
  // to clear any stale pending/count/visualLine state, which can
  // accumulate after a backgrounded tab resumes.
  if (vimState.enabled) {
    if (vimCommandBar.classList.contains("visible")) vimCloseCommandBar();
    _vimPreClickPos = null;
    vimSetMode("normal");
    editor.readOnly = false;
    editor.focus();
    editor.readOnly = true;
    updateCursorPos();
  }
}

// Tapping the status bar must not move focus. Blurring the editor closes
// the mobile keyboard, the page grows into its space, and the click then
// lands on the editor (keyboard back up) instead of the button. Keeping
// focus where it is leaves the keyboard as it was and the layout still.
document
  .querySelector(".statusbar")
  .addEventListener("mousedown", (e) => e.preventDefault());

function toggleSidebar() {
  // Desktop: the sidebar folds away and the title bar gets a button back
  if (!isMobile()) {
    const hidden = document
      .querySelector(".app")
      .classList.toggle("sidebar-hidden");
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden);
    if (hidden) editor.focus();
    return;
  }
  const open = sidebar.classList.toggle("open");
  document.querySelector(".app").classList.toggle("sidebar-open", open);
  // On mobile the list covers the editor: close the keyboard so nothing is
  // typed unseen, and don't pop it up again when the list closes
  if (isMobile()) {
    if (open) editor.blur();
  } else if (!open) editor.focus();
}

function togglePin(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned = !note.pinned;
  note.updatedAt = Date.now();
  saveState();
  renderNoteList();
}

// ═══════════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════════

const MAX_LINES_PER_NOTE = 500;
const MAX_MATCHES_PER_NOTE = 3;
const MAX_RESULTS = 20;
let searchSelectedIdx = -1;
let searchDebounce = null;
let searchPreviousFocus = null;
let searchRemoveTrap = null;

// The palette (⌘P): notes by name and lines in every note; Tab narrows it to
// lines in this note; a leading ">" lists commands instead
let searchScope = "all";
const searchScopeEl = document.getElementById("searchScope");
const NOTE_RESULTS_MAX = 200;

function setSearchScope(scope) {
  searchScope = scope === "note" && getActiveNote() ? "note" : "all";
  const note = searchScope === "note" ? getActiveNote() : null;
  searchScopeEl.hidden = !note;
  if (note)
    searchScopeEl.innerHTML =
      icon(noteKind(note.name).icon, "sm") + nameHtml(note.name);
  searchInput.placeholder = note
    ? "Search this note"
    : "Search notes, or > for commands";
  searchInput.setAttribute("aria-label", searchInput.placeholder);
  document.getElementById("searchHint").textContent = note
    ? "Tab: all notes"
    : "Tab: this note";
  searchNotes(searchInput.value);
}

function openSearch(scope = "all", initial = "") {
  if (!searchResults.classList.contains("visible"))
    searchPreviousFocus = document.activeElement;
  closeAllMenus();
  closeSidebar();
  searchResults.classList.add("visible");
  searchBackdrop.classList.add("visible");
  searchInput.value = typeof initial === "string" ? initial : "";
  lastSearchKey = null;
  setSearchScope(scope);
  searchInput.focus();
  if (searchRemoveTrap) searchRemoveTrap();
  searchRemoveTrap = trapFocus(searchResults);
}

function closeSearch() {
  if (searchRemoveTrap) {
    searchRemoveTrap();
    searchRemoveTrap = null;
  }
  searchResults.classList.remove("visible");
  searchBackdrop.classList.remove("visible");
  searchSelectedIdx = -1;
  if (searchPreviousFocus && searchPreviousFocus.focus)
    searchPreviousFocus.focus();
  searchPreviousFocus = null;
}

function fuzzyMatch(text, query) {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  const indices = [];
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      indices.push(i);
      qi++;
    }
  }
  if (qi < q.length) return null;
  let score = 0;
  for (let i = 0; i < indices.length; i++) {
    if (i > 0 && indices[i] === indices[i - 1] + 1) score += 2;
    score += 1;
    if (indices[i] < 10) score += 1;
  }
  return { indices, score };
}

function exactMatch(text, query) {
  const m = findAll(text, query)[0];
  if (!m) return null;
  const idx = m.start;
  const indices = [];
  for (let i = idx; i < m.end; i++) indices.push(i);
  const score = query.length * 3 + (idx < 10 ? 5 : 0);
  return { indices, score };
}

function matchLine(text, query) {
  return exactMatch(text, query) || fuzzyMatch(text, query);
}

function highlightFuzzy(text, indices) {
  if (!indices || !indices.length) return escapeHtml(text);
  let result = "";
  let groups = [];
  let start = indices[0],
    end = indices[0];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === end + 1) {
      end = indices[i];
    } else {
      groups.push([start, end]);
      start = end = indices[i];
    }
  }
  groups.push([start, end]);
  let last = 0;
  for (const [s, e] of groups) {
    result += escapeHtml(text.slice(last, s));
    result += "<mark>" + escapeHtml(text.slice(s, e + 1)) + "</mark>";
    last = e + 1;
  }
  result += escapeHtml(text.slice(last));
  return result;
}

// The same query in the same scope keeps the list (and the selection)
let lastSearchKey = null;

function searchNotes(query) {
  const key = searchScope + "\n" + query;
  if (key === lastSearchKey) return;
  lastSearchKey = key;
  if (searchScope === "all" && query.trimStart().startsWith(">"))
    return showCommands(query.trimStart().slice(1).trim());
  if (!query.trim()) {
    searchCount.textContent = "";
    searchResultsList.innerHTML = "";
    searchSelectedIdx = -1;
    if (searchScope === "all") showRecent();
    return;
  }
  if (searchScope === "note") return searchActiveNote(query);
  const results = [];
  let contentOnly = 0;
  for (const note of state.notes) {
    const exactName = exactMatch(note.name, query);
    const nameMatch = exactName || fuzzyMatch(note.name, query);
    // Enough content hits: keep looking for name matches only
    if (!nameMatch && contentOnly >= MAX_RESULTS * 2) continue;
    const raw = note.content.split("\n");
    const lines = isDrawFile(note.name) ? drawSearchLines(note.content) : raw;
    const lineLimit = Math.min(lines.length, MAX_LINES_PER_NOTE);
    const lineMatches = [];
    for (let i = 0; i < lineLimit; i++) {
      const m = matchLine(lines[i], query);
      if (m) {
        let offset = 0;
        for (let j = 0; j < i; j++) offset += raw[j].length + 1;
        // Drawing labels sit at the end of their line
        if (lines !== raw)
          offset += raw[i].lastIndexOf('"', raw[i].length - 2) + 1;
        lineMatches.push({
          line: lines[i],
          lineNum: i + 1,
          lineIndices: m.indices,
          score: m.score,
          charOffset: offset + m.indices[0],
        });
      }
    }
    lineMatches.sort((a, b) => b.score - a.score);
    const topLines = lineMatches.slice(0, MAX_MATCHES_PER_NOTE);
    const bestLineScore = topLines.length ? topLines[0].score : 0;
    const nameScore = nameMatch ? nameMatch.score * 4 : 0;
    const totalScore = nameScore + bestLineScore;
    const activeBoost = note.id === state.activeId ? 1000 : 0;
    // Name matches rank first (exact before fuzzy), then content matches
    const tier = exactName ? 2e6 : nameMatch ? 1e6 : 0;

    if (totalScore > 0) {
      results.push({
        note,
        score: tier + activeBoost + totalScore,
        nameMatch,
        lines: topLines,
      });
      if (!nameMatch) contentOnly++;
    }
  }
  results.sort((a, b) => b.score - a.score);
  results.length = Math.min(results.length, MAX_RESULTS);
  showSearchResults(results);
}

// Exact matches only: fuzzy matching on single lines of one file is noise
function searchActiveNote(query) {
  const note = getActiveNote();
  if (!note) return showSearchResults([]);
  const raw = note.content.split("\n");
  const lines = isDrawFile(note.name) ? drawSearchLines(note.content) : raw;
  const hits = [];
  let offset = 0;
  for (let i = 0; i < lines.length && hits.length < NOTE_RESULTS_MAX; i++) {
    const matches = findAll(lines[i], query.trim());
    if (matches.length) {
      const indices = matches.flatMap((m) =>
        Array.from({ length: m.end - m.start }, (_, k) => m.start + k),
      );
      const labelAt =
        lines === raw ? 0 : raw[i].lastIndexOf('"', raw[i].length - 2) + 1;
      hits.push({
        line: lines[i],
        lineNum: i + 1,
        lineIndices: indices,
        charOffset: offset + labelAt + matches[0].start,
        raw: raw[i],
      });
    }
    offset += raw[i].length + 1;
  }
  showNoteResults(note, hits);
}

function searchSnippet(lm) {
  const snippetDiv = document.createElement("div");
  snippetDiv.className = "search-result-snippet";
  const maxLen = 120;
  let snippetText = lm.line;
  let indices = lm.lineIndices;
  if (snippetText.length > maxLen && indices.length) {
    // Center snippet around the first match index
    const firstIdx = indices[0];
    let start = Math.max(0, firstIdx - 30);
    // Snap to a word boundary
    if (start > 0) {
      const sp = snippetText.lastIndexOf(" ", start);
      if (sp > start - 15) start = sp + 1;
    }
    let end = Math.min(snippetText.length, start + maxLen);
    snippetText =
      (start > 0 ? "…" : "") +
      snippetText.slice(start, end) +
      (end < lm.line.length ? "…" : "");
    // Shift indices to match the sliced text
    indices = indices
      .map((i) => i - start + (start > 0 ? 1 : 0))
      .filter((i) => i >= 0 && i < snippetText.length);
  }
  snippetDiv.innerHTML =
    `<span class="ln">${lm.lineNum}</span>` +
    highlightFuzzy(snippetText, indices);
  return snippetDiv;
}

// After jumping to a result: n/N, the find bar and vim search continue from it
function adoptSearchQuery(query) {
  if (!query) return;
  findInput.value = query;
  vimState.searchDirection = 1;
  vimState.lastSearch = {
    pattern: "\\V" + query.replace(/\\/g, "\\\\"),
    ignoreCase: true,
  };
  updateFindMatches();
  if (findMatches.length) selectFindMatch(true);
  updateCursorPos();
}

function searchGroup(label) {
  const div = document.createElement("div");
  div.className = "search-group";
  div.textContent = label;
  searchResultsList.appendChild(div);
}

function searchRow(cls, html, onPick) {
  const div = document.createElement("div");
  div.className = "search-result-item" + (cls ? " " + cls : "");
  div.innerHTML = html;
  div.addEventListener("click", onPick);
  searchResultsList.appendChild(div);
  return div;
}

function noSearchResults(query) {
  const div = document.createElement("div");
  div.className = "search-no-results";
  div.innerHTML = `<span></span>`;
  div.firstChild.textContent =
    searchScope === "note" ? "No matches" : `No notes match “${query.trim()}”`;
  if (searchScope === "all") {
    const name = query.trim().replace(/[\\/:*?"<>|]/g, "");
    const b = document.createElement("button");
    b.className = "btn";
    b.innerHTML = icon("plus", "sm") + "<span></span>";
    b.lastChild.textContent = `New note “${name}.md”`;
    b.addEventListener("click", () => {
      closeSearch();
      searchInput.value = "";
      createNote(uniqueOrSame(name + ".md"));
    });
    div.appendChild(b);
  }
  searchResultsList.appendChild(div);
}

function uniqueOrSame(name) {
  return state.notes.some((n) => n.name === name) ? uniqueName(name) : name;
}

function showNoteResults(note, hits) {
  searchCount.textContent =
    hits.length +
    (hits.length >= NOTE_RESULTS_MAX ? "+" : "") +
    " line" +
    (hits.length !== 1 ? "s" : "");
  searchResultsList.innerHTML = "";
  searchSelectedIdx = -1;
  if (!hits.length) return noSearchResults(searchInput.value);
  hits.forEach((hit) => {
    const div = searchRow("search-result-line", "", () => {
      const query = searchInput.value.trim();
      closeSearch();
      searchInput.value = "";
      // On the canvas: show the shape instead of the source line
      if (drawActive() && window.Draw) {
        Draw.reveal(hit.raw.trim().split(/\s+/)[1]);
        return;
      }
      if (mdViewActive) switchMdTab("edit", true);
      editor.focus();
      editor.setSelectionRange(hit.charOffset, hit.charOffset);
      adoptSearchQuery(query);
      ensureCursorScrolloff();
    });
    div.appendChild(searchSnippet(hit));
  });
  searchSelectedIdx = 0;
  updateSearchSelection();
}

function openSearchResult(note, target, query) {
  // Auto-save dirty vim buffer before switching
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  closeSearch();
  switchNote(note.id);
  searchInput.value = "";
  editor.focus();
  if (target && target.charOffset > 0)
    editor.setSelectionRange(target.charOffset, target.charOffset);
  // Populate find state like vim / search so n/N work
  adoptSearchQuery(query);
}

function noteResultHead(note, nameIndices, aside) {
  const kind = noteKind(note.name);
  const name = nameIndices
    ? highlightFuzzy(note.name, nameIndices)
    : nameHtml(note.name);
  return (
    icon(kind.icon, "kind " + kind.cls) +
    `<span class="search-result-name">${name}</span>` +
    `<span class="search-result-aside">${escapeHtml(aside)}</span>`
  );
}

// Names first, then lines — each under its own label, so you see why
function showSearchResults(results) {
  searchCount.textContent =
    results.length + " result" + (results.length !== 1 ? "s" : "");
  searchResultsList.innerHTML = "";
  searchSelectedIdx = -1;
  if (results.length === 0) return noSearchResults(searchInput.value);
  const query = searchInput.value.trim();
  let group = null;
  for (const r of results) {
    const g = r.nameMatch ? "Notes" : "In notes";
    if (g !== group) searchGroup((group = g));
    const aside = r.nameMatch
      ? shortTime(r.note.updatedAt)
      : r.lines.length + (r.lines.length === 1 ? " line" : " lines");
    const div = searchRow(
      "",
      noteResultHead(r.note, r.nameMatch?.indices, aside),
      () => openSearchResult(r.note, r.lines[0] || null, query),
    );
    for (const lm of r.lines) div.appendChild(searchSnippet(lm));
  }
  searchSelectedIdx = 0;
  updateSearchSelection();
}

// Empty palette: the notes you were just in, so ⌘P ↵ flips back
function showRecent() {
  const recent = state.notes
    .filter((n) => n.id !== state.activeId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  if (!recent.length) return;
  searchGroup("Recent");
  for (const note of recent)
    searchRow("", noteResultHead(note, null, shortTime(note.updatedAt)), () =>
      openSearchResult(note, null, ""),
    );
  searchSelectedIdx = 0;
  updateSearchSelection();
}

const THEME_LABELS = {
  mocha: "Mocha",
  macchiato: "Macchiato",
  frappe: "Frappé",
  latte: "Latte",
  espresso: "Espresso",
};

// Every action has a name here — including the ones only vim could reach
function paletteCommands() {
  const note = getActiveNote();
  const md = note && isMarkdownFile(note.name);
  const draw = note && isDrawFile(note.name);
  const view = note && hasViewTab(note.name);
  const saved = note && !sharedNote;
  return [
    ["note", "New note", "new", () => createNote(undefined, undefined, true)],
    ["file-draw", "New drawing", "", () =>
      createNote(undefined, undefined, true, "draw")],
    ["import", "Import files…", "", openImport],
    ["archive", "Export all as ZIP", "", downloadAll],
    saved && ["pencil", "Rename note", "F2", renameInTitle],
    saved && [note.pinned ? "pin-on" : "pin", note.pinned ? "Unpin note" : "Pin note", "", () => togglePin(note.id)],
    note && ["share", "Share…", "", () => openShare()],
    note && ["link", "Copy link", "", () => copyLink(note)],
    note && ["download", "Download", "", () => downloadNote(note)],
    md && ["download", "Download as HTML", "", () => downloadHtml(note)],
    draw && ["download", "Download as SVG", "", () => drawDownloadSvg(note)],
    draw && ["image", "Copy as PNG", "", () => drawCopyPng(note)],
    md && ["format", "Format markdown", "⌥⇧F", () => formatNote(note)],
    view && [mdViewActive ? "code" : "eye", mdViewActive ? (draw ? "Show source" : "Edit") : draw ? "Show canvas" : "Preview", "⌘E", toggleView],
    view && ["zen", "Zen", "", () => switchMdTab("zen", true)],
    note && ["search", "Find", "⌘F", () => openFindReplace()],
    note && ["search", "Find and replace", "⌘⌥F", () => openFindReplace(true)],
    ["wrap", "Word wrap", "", toggleWrap],
    !touchOnly.matches && ["keyboard", "Vim keys", "⌃⇧M", toggleVim],
    saved && ["trash", "Delete note", "⌘⇧D", () => deleteNote(note.id)],
    ["sidebar", "Show or hide sidebar", "⌘\\", toggleSidebar],
    ["settings", "Settings…", "", () => openSettings()],
    ["contrast", "Theme: match system", "", toggleSystemTheme],
    ...THEMES.map((t) => ["contrast", "Theme: " + THEME_LABELS[t], "", () => setTheme(t)]),
    gdriveConnected
      ? ["cloud", "Sync now", "⌘S", driveSync]
      : ["cloud", "Sync with Google Drive…", "", driveSync],
    ["help", "Help", "", openHelp],
    ["note", "Markdown guide", "", openMdDemo],
  ].filter(Boolean);
}

function showCommands(query) {
  searchResultsList.innerHTML = "";
  searchSelectedIdx = -1;
  let cmds = paletteCommands().map(([ic, label, key, run]) => ({
    ic, label, key, run, m: query ? fuzzyMatch(label, query) : { indices: [], score: 0 },
  }));
  if (query) cmds = cmds.filter((c) => c.m).sort((a, b) => b.m.score - a.m.score);
  searchCount.textContent = cmds.length + (cmds.length === 1 ? " command" : " commands");
  if (!cmds.length) {
    const div = document.createElement("div");
    div.className = "search-no-results";
    div.textContent = "No command matches";
    searchResultsList.appendChild(div);
    return;
  }
  for (const c of cmds)
    searchRow(
      "search-command",
      icon(c.ic) +
        `<span class="search-result-name">${highlightFuzzy(c.label, c.m.indices)}</span>` +
        (c.key ? `<span class="kbd">${escapeHtml(keyLabel(c.key))}</span>` : "<span></span>"),
      () => {
        closeSearch();
        searchInput.value = "";
        c.run();
      },
    );
  searchSelectedIdx = 0;
  updateSearchSelection();
}

function updateSearchSelection() {
  const items = searchResultsList.querySelectorAll(".search-result-item");
  items.forEach((el, i) => {
    el.classList.toggle("selected", i === searchSelectedIdx);
  });
  if (items[searchSelectedIdx]) {
    items[searchSelectedIdx].scrollIntoView({ block: "nearest" });
  }
}

searchBackdrop.addEventListener("click", () => {
  closeSearch();
  searchInput.value = "";
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchDebounce = null;
    searchNotes(searchInput.value);
  }, 120);
});

searchInput.addEventListener("keydown", (e) => {
  const items = searchResultsList.querySelectorAll(".search-result-item");
  // Tab narrows to this note and back; ⌘P widens, ⌘F hands over to find
  if (e.key === "Tab" && !searchInput.value.trimStart().startsWith(">")) {
    e.preventDefault();
    setSearchScope(searchScope === "all" ? "note" : "all");
    return;
  }
  if (e.key === "Backspace" && !searchInput.value && searchScope === "note") {
    e.preventDefault();
    setSearchScope("all");
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "p") {
    e.preventDefault();
    setSearchScope("all");
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    closeSearch();
    searchInput.value = "";
    openFindReplace();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length) {
      searchSelectedIdx = (searchSelectedIdx + 1) % items.length;
      updateSearchSelection();
    }
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length) {
      searchSelectedIdx = (searchSelectedIdx - 1 + items.length) % items.length;
      updateSearchSelection();
    }
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    searchInput.value = "";
    searchInput.blur();
    editor.focus();
  }
  if (e.key === "Enter") {
    e.preventDefault();
    // Typed faster than the debounce: search what is in the box now
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
      searchNotes(searchInput.value);
    }
    const now = searchResultsList.querySelectorAll(".search-result-item");
    const selected = now[searchSelectedIdx] || now[0];
    if (selected) selected.click();
  }
});

// ═══════════════════════════════════════════════════
//  Find & Replace
// ═══════════════════════════════════════════════════

let findMatches = [];
let findMatchIdx = -1;

// Case-insensitive, non-overlapping. Offsets refer to `text` itself —
// toLowerCase() can change string length (e.g. "İ"), so never search a copy.
function findAll(text, query) {
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return Array.from(text.matchAll(re), (m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
}

function isFindMatchSelected() {
  const m = findMatches[findMatchIdx];
  return (
    !!m && editor.selectionStart === m.start && editor.selectionEnd === m.end
  );
}

// The preview finds in its rendered text, painted with the CSS Highlight API;
// replacing (and zen, which has no find bar) goes to the source
function inPreviewFind() {
  return mdViewActive && !zenModeActive && !!window.CSS?.highlights && !isDrawFile(getActiveNote()?.name);
}

// ⌘F finds; ⌘⌥F / Ctrl+H (or the chevron) adds the replace row
function openFindReplace(withReplace = false) {
  if (!getActiveNote()) return;
  if (mdViewActive && (withReplace === true || !inPreviewFind())) switchMdTab("edit", true);
  if (withReplace === true) findReplaceBar.classList.add("replace");
  else if (!findReplaceBar.classList.contains("visible"))
    findReplaceBar.classList.remove("replace");
  if (findReplaceBar.classList.contains("visible")) {
    (withReplace === true ? replaceInput : findInput).focus();
    findInput.select();
    return;
  }
  findReplaceBar.classList.add("visible");
  findInput.value = "";
  replaceInput.value = "";
  setFindCount("");
  findMatches = [];
  findMatchIdx = -1;
  findInput.focus();

  // If there's a selection, pre-fill find input
  const sel = mdViewActive
    ? getSelection().toString()
    : editor.value.substring(editor.selectionStart, editor.selectionEnd);
  if (sel && !sel.includes("\n")) {
    findInput.value = sel;
    updateFindMatches();
  }
}

function closeFindReplace(focus = true) {
  if (!findReplaceBar.classList.contains("visible")) return;
  findReplaceBar.classList.remove("visible");
  findMatches = [];
  findMatchIdx = -1;
  paintPreviewFind();
  setFindCount("");
  if (focus && !mdViewActive) editor.focus();
}

function toggleReplace() {
  if (mdViewActive) {
    const query = findInput.value;
    openFindReplace(true);
    findInput.value = query;
    return updateFindMatches();
  }
  findReplaceBar.classList.toggle("replace");
  (findReplaceBar.classList.contains("replace") ? replaceInput : findInput).focus();
}

function setFindCount(text, none = false) {
  findReplaceCount.textContent = text;
  findReplaceCount.classList.toggle("none", none);
}

// select=false only refreshes offsets (after edits) without moving the cursor
function updateFindMatches(select = true) {
  const query = findInput.value;
  findMatches = [];
  findMatchIdx = -1;
  if (!query) {
    paintPreviewFind();
    setFindCount("");
    return;
  }
  const preview = inPreviewFind();
  findMatches = preview ? previewFindAll(query) : findAll(editor.value, query);
  if (findMatches.length === 0) {
    paintPreviewFind();
    setFindCount("No results", true);
    return;
  }
  if (preview) {
    // Start at the first match on screen
    const top = mdPreview.getBoundingClientRect().top;
    findMatchIdx = Math.max(0, findMatches.findIndex((r) => r.getBoundingClientRect().bottom > top));
    return selectFindMatch();
  }
  // Find nearest match to cursor
  const cursor = editor.selectionStart;
  findMatchIdx = 0;
  for (let i = 0; i < findMatches.length; i++) {
    if (findMatches[i].start >= cursor) {
      findMatchIdx = i;
      break;
    }
  }
  if (select) selectFindMatch();
  else
    setFindCount(
      findMatches.length + (findMatches.length === 1 ? " match" : " matches"),
    );
}

// Ranges over the preview's text nodes; a match may span inline formatting
function previewFindAll(query) {
  const nodes = [];
  let text = "";
  const walker = document.createTreeWalker(mdPreview, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); text += n.nodeValue) nodes.push([n, text.length]);
  let i = 0;
  const at = (pos) => {
    while (i < nodes.length - 1 && nodes[i + 1][1] <= pos) i++;
    return [nodes[i][0], pos - nodes[i][1]];
  };
  return findAll(text, query).map((m) => {
    const r = new Range();
    r.setStart(...at(m.start));
    r.setEnd(...at(m.end));
    return r;
  });
}

function paintPreviewFind() {
  const hl = window.CSS?.highlights;
  if (!hl) return;
  const current = findMatches[findMatchIdx];
  if (!inPreviewFind() || !current) {
    hl.delete("find");
    hl.delete("find-current");
    return;
  }
  hl.set("find", new Highlight(...findMatches.filter((r) => r !== current)));
  hl.set("find-current", new Highlight(current));
}

function selectFindMatch(focusEditor) {
  if (findMatchIdx < 0 || findMatchIdx >= findMatches.length) return;
  const m = findMatches[findMatchIdx];
  if (inPreviewFind()) {
    paintPreviewFind();
    const r = m.getBoundingClientRect();
    const box = mdPreview.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom)
      mdPreview.scrollTop += r.top - box.top - box.height / 2;
    setFindCount(findMatchIdx + 1 + " of " + findMatches.length);
    return;
  }
  editor.setSelectionRange(m.start, m.end);
  // Scroll the match into view by temporarily focusing the editor
  // (focus triggers native caret-scroll), then return focus to find input.
  editor.focus();
  // Compute the line of the match and scroll to it
  const textBefore = editor.value.substring(0, m.start);
  const line = textBefore.split("\n").length - 1;
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
  const targetScroll = line * lineHeight - editor.clientHeight / 2;
  editor.scrollTop = Math.max(0, targetScroll);
  gutter.scrollTop = editor.scrollTop;
  highlightLayer.scrollTop = editor.scrollTop;
  syncOccurrenceScroll();
  if (!focusEditor) findInput.focus();
  setFindCount(findMatchIdx + 1 + " of " + findMatches.length);
}

function findNext() {
  if (!findMatches.length) {
    updateFindMatches();
    return;
  }
  // After edits findMatchIdx points at the first match after the cursor
  if (inPreviewFind() || isFindMatchSelected())
    findMatchIdx = (findMatchIdx + 1) % findMatches.length;
  selectFindMatch(true);
}

function findPrev() {
  if (!findMatches.length) {
    updateFindMatches();
    return;
  }
  findMatchIdx = (findMatchIdx - 1 + findMatches.length) % findMatches.length;
  selectFindMatch(true);
}

// Replaces the current match and moves on to the next
function replaceCurrent() {
  updateFindMatches(false);
  if (!findMatches.length) return;
  if (!isFindMatchSelected()) {
    const cursor = editor.selectionStart;
    findMatchIdx = Math.max(
      0,
      findMatches.findIndex((m) => m.end > cursor),
    );
  }
  const m = findMatches[findMatchIdx];
  const replacement = replaceInput.value;
  const note = getActiveNote();
  if (!note) return;

  // Temporarily lift readOnly for vim mode so the edit goes through
  const wasReadOnly = editor.readOnly;
  editor.readOnly = false;
  editor.setSelectionRange(m.start, m.end);
  editor.focus();
  document.execCommand("insertText", false, replacement);
  editor.readOnly = wasReadOnly;

  if (vimState.enabled) {
    vimState.bufferDirty = true;
    saveSwap(note.id, editor.value);
  } else {
    note.content = editor.value;
    note.updatedAt = Date.now();
    scheduleSave();
  }
  updateHighlight();
  updateLineNumbers();

  updateFindMatches();
  if (findMatches.length) selectFindMatch(true);
}

function replaceAll() {
  const query = findInput.value;
  const replacement = replaceInput.value;
  if (!query) return;
  const note = getActiveNote();
  if (!note) return;

  const text = editor.value;
  const matches = findAll(text, query);
  if (!matches.length) return;
  pushHistory(note.id, text);
  let result = "";
  let pos = 0;
  for (const m of matches) {
    result += text.substring(pos, m.start) + replacement;
    pos = m.end;
  }
  result += text.substring(pos);

  editor.value = result;
  if (vimState.enabled) {
    vimState.bufferDirty = true;
    saveSwap(note.id, editor.value);
  } else {
    note.content = result;
    note.updatedAt = Date.now();
    saveState();
  }
  refreshEditor();
  updateFindMatches();
  showToast("Replaced " + matches.length, {
    action: "Undo",
    onAction: undo,
  });
}

findInput.addEventListener("input", () => updateFindMatches());
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) findPrev();
    else findNext();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeFindReplace();
  }
});
replaceInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    replaceCurrent();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeFindReplace();
  }
});

// ═══════════════════════════════════════════════════
//  Word Wrap
// ═══════════════════════════════════════════════════

function loadWrap() {
  const saved = localStorage.getItem(WRAP_KEY);
  const wrapOn =
    saved === "true" || (saved === null && window.innerWidth <= 900);
  btnWrap.setAttribute("aria-pressed", wrapOn);
  if (wrapOn) {
    editorArea.classList.add("wrap");
    requestAnimationFrame(syncScrollbarGap);
  }
}

function currentTheme() {
  return document.documentElement.dataset.theme || THEMES[0];
}

function followsSystem() {
  return localStorage.getItem(SYSTEM_THEME_KEY) === "true";
}

// Shows `name`, or what Match system picks; ticks follow the stored choice
function applyTheme(name) {
  if (!THEMES.includes(name)) name = THEMES[0];
  if (followsSystem()) name = themeToShow();
  document.documentElement.dataset.theme = name;
  const chosen = localStorage.getItem(THEME_KEY) || THEMES[0];
  for (const b of document.querySelectorAll("[data-action=set-theme]"))
    b.querySelector(".tick").innerHTML =
      b.dataset.value === chosen ? icon("check", "sm") : "";
  document.getElementById("btnSystemTheme").querySelector(".tick").innerHTML =
    followsSystem() ? icon("check", "sm") : "";
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(
    document.documentElement,
  )
    .getPropertyValue("--bg")
    .trim();
  for (const b of document.querySelectorAll("[data-action=set-theme]"))
    b.setAttribute("aria-checked", b.dataset.value === chosen);
  // Drawings are painted with hex colours, so repaint them
  if (window.Draw) {
    Draw.setTheme();
    hydrateDrawEmbeds();
  }
}

function setTheme(value = actionEl.dataset.value) {
  localStorage.setItem(THEME_KEY, value);
  // Picking latte while matching the system would never show a dark theme
  if (followsSystem() && value === "latte")
    localStorage.removeItem(SYSTEM_THEME_KEY);
  applyTheme(value);
}

function toggleSystemTheme() {
  if (followsSystem()) localStorage.removeItem(SYSTEM_THEME_KEY);
  else localStorage.setItem(SYSTEM_THEME_KEY, "true");
  applyTheme(localStorage.getItem(THEME_KEY));
}

lightQuery.addEventListener("change", () => {
  if (followsSystem()) applyTheme(localStorage.getItem(THEME_KEY));
});

function toggleWrap() {
  const isWrap = editorArea.classList.toggle("wrap");
  btnWrap.setAttribute("aria-pressed", isWrap);
  localStorage.setItem(WRAP_KEY, isWrap ? "true" : "false");
  if (isWrap) {
    syncScrollbarGap();
  } else {
    highlightLayer.style.paddingRight = "";
    _lastScrollbarW = "";
  }
  updateLineNumbers();
}

// Compensate highlight layer padding for textarea scrollbar width
let _lastScrollbarW = "";
function syncScrollbarGap() {
  const gap =
    parseFloat(getComputedStyle(editor).paddingRight) +
    editor.offsetWidth -
    editor.clientWidth +
    "px";
  if (gap !== _lastScrollbarW) {
    _lastScrollbarW = gap;
    highlightLayer.style.paddingRight = gap;
  }
}

// Re-measure wrapped line heights when editor resizes
new ResizeObserver(() => {
  if (editorArea.classList.contains("wrap")) {
    syncScrollbarGap();
    updateLineNumbers();
  }
}).observe(editor);

// ═══════════════════════════════════════════════════
//  Vim Mode
// ═══════════════════════════════════════════════════

const btnVim = document.getElementById("btnVim");
const vimCursorEl = document.getElementById("vimCursor");

const _editorCS = getComputedStyle(editor);
let _vimCharWidth = 8.4; // fallback

function vimMeasureCharWidth() {
  const el = document.createElement("pre");
  el.textContent = "XXXXXXXXXX";
  el.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;" +
    "font-family:" +
    getComputedStyle(editor).fontFamily +
    ";" +
    "font-size:" +
    getComputedStyle(editor).fontSize +
    ";" +
    "padding:0;margin:0;border:none;display:inline;box-sizing:content-box;";
  document.body.appendChild(el);
  _vimCharWidth = el.getBoundingClientRect().width / 10;
  document.body.removeChild(el);
}
document.fonts.ready.then(vimMeasureCharWidth);
vimMeasureCharWidth();

let vimCursorMoveTimer = null;
function vimCursorMoving() {
  const cur = document.getElementById("vimCursor");
  if (!cur) return;
  cur.classList.add("moving");
  clearTimeout(vimCursorMoveTimer);
  vimCursorMoveTimer = setTimeout(() => cur.classList.remove("moving"), 150);
}

// Keep the cursor a few lines away from the top/bottom of the visible
// editor area, so typing at the end of a file doesn't park the caret on
// the bottom edge. Vim non-insert mode runs its own scrolloff inside
// vimUpdateBlockCursor, so this only fires when the native textarea
// caret is the active one.
function ensureCursorScrolloff() {
  if (vimState.enabled && vimState.mode !== "insert") return;
  const val = editor.value || "";
  const pos = editor.selectionStart;
  const lineHeight = parseFloat(_editorCS.lineHeight) || 21;
  const padTop = parseFloat(_editorCS.paddingTop) || 10;
  let absTop;

  if (editorArea.classList.contains("wrap")) {
    const c = caretCoords(Math.min(pos, val.length));
    // Snap to the row grid: the glyph box sits inside the line box
    absTop =
      padTop +
      Math.max(0, Math.round(((c?.top ?? padTop) - padTop) / lineHeight)) *
        lineHeight;
  } else {
    const lineIdx = (val.substring(0, pos).match(/\n/g) || []).length;
    absTop = padTop + lineIdx * lineHeight;
  }

  const scrolloff = 5 * lineHeight;
  const viewH = editor.clientHeight;
  if (absTop - scrolloff < editor.scrollTop) {
    editor.scrollTop = Math.max(0, absTop - scrolloff);
  }
  if (absTop + lineHeight + scrolloff > editor.scrollTop + viewH) {
    editor.scrollTop = absTop + lineHeight + scrolloff - viewH;
  }
}

function vimUpdateBlockCursor() {
  if (!vimState.enabled || vimState.mode === "insert") {
    vimCursorEl.style.display = "none";
    editor.style.caretColor = "var(--text)";
    return;
  }
  editor.style.caretColor = "transparent";
  vimCursorEl.style.display = "block";

  // Use saved pre-click position so mouse clicks don't move block cursor
  const pos =
    vimState.mode === "visual"
      ? vimState.visualHead
      : _vimPreClickPos !== null
        ? _vimPreClickPos
        : editor.selectionStart;
  const lineIdx = vimLineOf(pos);
  const col = pos - vimLineStart(lineIdx);

  const cw = _vimCharWidth;
  const lineHeight = parseFloat(_editorCS.lineHeight) || 14 * 1.5;
  const padTop = 10;
  const padLeft = 16;

  let top, left;

  // Absolute cursor position (relative to editor content, not viewport)
  let absTop, absLeft;

  if (editorArea.classList.contains("wrap")) {
    const c = caretCoords(pos);
    const rowIdx = Math.max(
      0,
      Math.round(((c?.top ?? padTop) - padTop) / lineHeight),
    );
    absTop = padTop + rowIdx * lineHeight;
    absLeft = c ? c.left : padLeft;
  } else {
    absTop = padTop + lineIdx * lineHeight;
    absLeft = padLeft + col * cw;
  }

  // Vim-like scrolling: keep cursor visible with scrolloff margin
  const scrolloff = 3 * lineHeight;
  const viewH = editor.clientHeight;
  // Cursor above visible area (account for scrolloff)
  if (absTop - scrolloff < editor.scrollTop) {
    editor.scrollTop = Math.max(0, absTop - scrolloff);
  }
  // Cursor below visible area (account for scrolloff + cursor height)
  if (absTop + lineHeight + scrolloff > editor.scrollTop + viewH) {
    editor.scrollTop = absTop + lineHeight + scrolloff - viewH;
  }
  // Horizontal scroll (no wrap only)
  if (!editorArea.classList.contains("wrap")) {
    const viewW = editor.clientWidth;
    if (absLeft < editor.scrollLeft + padLeft) {
      editor.scrollLeft = Math.max(0, absLeft - padLeft);
    }
    if (absLeft + cw > editor.scrollLeft + viewW - padLeft) {
      editor.scrollLeft = absLeft + cw - viewW + padLeft;
    }
  }

  top = absTop - editor.scrollTop;
  left = absLeft - editor.scrollLeft;

  vimCursorEl.style.top = top + "px";
  vimCursorEl.style.left = left + "px";
  vimCursorEl.style.width = cw + "px";
  vimCursorEl.style.height = lineHeight + "px";
}

function vimSetMode(mode) {
  if (vimState.mode === "visual" && mode !== "visual") {
    const a = vimLineOf(vimState.visualAnchor);
    const h = vimLineOf(vimState.visualHead);
    vimState.visualMarks = { first: Math.min(a, h), last: Math.max(a, h) };
  }
  // When entering insert mode, snapshot current state as the undo point
  // (only if no edit command already pushed — e.g. plain i/a/I/A)
  if (mode === "insert" && vimState.mode !== "insert") {
    vimPushUndoOnce();
  }
  vimState.mode = mode;
  vimState.keys = [];
  if (mode === "normal") {
    editor.readOnly = true;
    vimState.visualLine = false;
  } else if (mode === "visual") {
    editor.readOnly = true;
  } else {
    editor.readOnly = false;
    vimState.visualLine = false;
  }
  updateCursorPos();
  vimUpdateBlockCursor();
}

function loadVim() {
  const saved = localStorage.getItem(VIM_KEY);
  if (saved === "true") {
    vimState.enabled = true;
    vimSetMode("normal");
  }
}

function toggleVim() {
  // In view mode, switch to edit tab first
  if (mdViewActive) {
    switchMdTab("edit", true);
    if (vimState.enabled) return; // already in vim, just switch to edit
  }
  // If disabling vim, save buffer first (like :wq)
  if (vimState.enabled && vimState.bufferDirty) {
    vimWriteBuffer();
  }
  vimState.enabled = !vimState.enabled;
  vimState.bufferDirty = false;
  localStorage.setItem(VIM_KEY, vimState.enabled ? "true" : "false");
  if (vimState.enabled) {
    vimSetMode("normal");
    editor.readOnly = false;
    editor.focus();
    editor.readOnly = true;
  } else {
    editor.readOnly = false;
    vimState.mode = "normal";
    vimState.keys = [];
    editor.focus();
  }
  updateCursorPos();
}

// ── Vim helpers ──
// Line starts are cached per buffer value — motions run several lookups
// per key, and splitting the whole buffer each time is O(n) per lookup

let _vimLineCache = { val: null, starts: [0] };

function vimLineStarts() {
  const val = editor.value;
  if (_vimLineCache.val !== val) {
    const starts = [0];
    for (let i = val.indexOf("\n"); i !== -1; i = val.indexOf("\n", i + 1))
      starts.push(i + 1);
    _vimLineCache = { val, starts };
  }
  return _vimLineCache.starts;
}

function vimLastLine() {
  return vimLineStarts().length - 1;
}

function vimLineOf(pos) {
  const starts = vimLineStarts();
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function vimCursorLine() {
  return vimLineOf(editor.selectionStart);
}

function vimLineStart(lineIdx) {
  const starts = vimLineStarts();
  return starts[Math.max(0, Math.min(lineIdx, starts.length - 1))];
}

// Position of the "\n" ending the line (or buffer length)
function vimLineEnd(lineIdx) {
  const starts = vimLineStarts();
  if (lineIdx >= starts.length - 1) return editor.value.length;
  return starts[lineIdx + 1] - 1;
}

function vimLineText(lineIdx) {
  return editor.value.slice(vimLineStart(lineIdx), vimLineEnd(lineIdx));
}

function vimFirstNonBlank(lineIdx) {
  return (
    vimLineStart(lineIdx) + vimLineText(lineIdx).match(/^[ \t]*/)[0].length
  );
}

// Normal mode: the cursor sits on a character, never on the "\n"
function vimLastCol(lineIdx) {
  return Math.max(vimLineStart(lineIdx), vimLineEnd(lineIdx) - 1);
}

function vimColPos(lineIdx, col) {
  return Math.min(vimLineStart(lineIdx) + col, vimLastCol(lineIdx));
}

function vimSetCursor(pos) {
  pos = Math.max(0, Math.min(pos, editor.value.length));
  editor.selectionStart = editor.selectionEnd = pos;
}

function vimClampCursor() {
  const pos = editor.selectionStart;
  vimSetCursor(Math.min(pos, vimLastCol(vimLineOf(pos))));
}

function vimPushUndoOnce() {
  const note = getActiveNote();
  if (!note || vimState._undoPushed) return;
  pushHistory(note.id, editor.value);
  vimState._undoPushed = true;
}

// Every buffer edit goes through here (undo point, change tracking).
// Inside a command the input event (highlight, save, swap) fires once at
// the end — >> on 1000 lines would otherwise re-render 1000 times.
function vimEdit(start, end, text) {
  vimPushUndoOnce();
  editor.setRangeText(text, start, end, "end");
  vimState._changed = true;
  if (!vimState._batch) editor.dispatchEvent(new Event("input"));
  else vimState._batchDirty = true;
}

function vimBatch(fn) {
  if (vimState._batch) return fn();
  vimState._batch = true;
  vimState._batchDirty = false;
  try {
    return fn();
  } finally {
    vimState._batch = false;
    if (vimState._batchDirty) editor.dispatchEvent(new Event("input"));
  }
}

function vimSetRegister(text, linewise) {
  vimState.clipboard = text;
  vimState.clipboardLinewise = linewise;
  navigator.clipboard.writeText(text).catch(() => {});
}

function vimDeleteRange(start, end) {
  const val = editor.value;
  vimSetRegister(val.slice(start, end), false);
  vimEdit(start, end, "");
  vimSetCursor(start);
}

// Lines first..last inclusive, as stored in a linewise register
function vimLinesText(first, last) {
  return editor.value.slice(vimLineStart(first), vimLineEnd(last)) + "\n";
}

function vimDeleteLines(first, last) {
  vimSetRegister(vimLinesText(first, last), true);
  const lastLine = vimLastLine();
  if (last < lastLine) vimEdit(vimLineStart(first), vimLineStart(last + 1), "");
  else if (first > 0) vimEdit(vimLineEnd(first - 1), vimLineEnd(last), "");
  else vimEdit(0, editor.value.length, "");
  vimSetCursor(vimFirstNonBlank(Math.min(first, vimLastLine())));
}

// Shift lines by `times` indent levels (2 spaces or a tab per level)
function vimShiftLines(first, last, dir, times = 1) {
  for (let li = last; li >= first; li--) {
    const ls = vimLineStart(li);
    const text = vimLineText(li);
    if (dir > 0) {
      if (text) vimEdit(ls, ls, "  ".repeat(times));
    } else {
      let strip = 0;
      for (let i = 0; i < times; i++) {
        const rest = text.slice(strip);
        strip += rest.startsWith("  ") ? 2 : rest.startsWith("\t") ? 1 : 0;
      }
      if (strip) vimEdit(ls, ls + strip, "");
    }
  }
  vimSetCursor(vimFirstNonBlank(first));
}

// Join `count` lines starting at lineIdx (J joins at least two)
function vimJoinLines(lineIdx, count) {
  for (let i = 1; i < Math.max(count, 2); i++) {
    if (lineIdx >= vimLastLine()) break;
    const le = vimLineEnd(lineIdx);
    const next = vimLineText(lineIdx + 1).replace(/^[ \t]+/, "");
    const cur = vimLineText(lineIdx);
    const sep = !next || !cur || /[ \t]$/.test(cur) ? "" : " ";
    vimEdit(
      le,
      vimLineStart(lineIdx + 1) + vimLineText(lineIdx + 1).length - next.length,
      sep,
    );
    vimSetCursor(le);
  }
}

// ── Vim text objects ──
// Returns { start, end } (end exclusive) or null; `linewise` for paragraphs

function vimTextObject(type, inner) {
  const val = editor.value;
  const pos = editor.selectionStart;

  if (type === "w" || type === "W") {
    const cls = type === "W" ? (ch) => (/\s/.test(ch) ? 0 : 1) : vimCharClass;
    const c = cls(val[pos] || "\n");
    if (val[pos] === "\n" || pos >= val.length) return null;
    let s = pos;
    let e = pos;
    while (s > 0 && val[s - 1] !== "\n" && cls(val[s - 1]) === c) s--;
    while (e < val.length && val[e] !== "\n" && cls(val[e]) === c) e++;
    if (!inner) {
      // "a word": trailing blanks, or leading ones if there are none
      const t = e;
      while (e < val.length && /[ \t]/.test(val[e])) e++;
      if (e === t) while (s > 0 && /[ \t]/.test(val[s - 1])) s--;
    }
    return { start: s, end: e };
  }

  if (type === "p") {
    const blank = (li) => vimLineText(li).trim() === "";
    const li = vimLineOf(pos);
    const b = blank(li);
    let first = li;
    let last = li;
    while (first > 0 && blank(first - 1) === b) first--;
    while (last < vimLastLine() && blank(last + 1) === b) last++;
    if (!inner) while (last < vimLastLine() && blank(last + 1) !== b) last++;
    return { first, last, linewise: true };
  }

  // Bracket pairs (b = parens, B = braces)
  const alias = { b: "(", B: "{" };
  const pairs = { "(": ")", "{": "}", "[": "]", "<": ">" };
  const closers = { ")": "(", "}": "{", "]": "[", ">": "<" };
  const open = alias[type] || (pairs[type] ? type : closers[type]);
  if (open) {
    const close = pairs[open];
    let s = -1;
    let depth = 0;
    // On the closing bracket itself: it belongs to the pair we want
    for (let i = val[pos] === close ? pos - 1 : pos; i >= 0; i--) {
      if (val[i] === close) depth++;
      else if (val[i] === open) {
        if (depth === 0) {
          s = i;
          break;
        }
        depth--;
      }
    }
    if (s === -1) return null;
    let e = -1;
    depth = 0;
    for (let i = s + 1; i < val.length; i++) {
      if (val[i] === open) depth++;
      else if (val[i] === close) {
        if (depth === 0) {
          e = i;
          break;
        }
        depth--;
      }
    }
    if (e === -1) return null;
    return inner ? { start: s + 1, end: e } : { start: s, end: e + 1 };
  }

  // Quotes: pairs on the current line, cursor inside or before one
  if (type === '"' || type === "'" || type === "`") {
    const li = vimLineOf(pos);
    const ls = vimLineStart(li);
    const line = vimLineText(li);
    const col = pos - ls;
    const quotes = [];
    for (let i = 0; i < line.length; i++)
      if (line[i] === type && line[i - 1] !== "\\") quotes.push(i);
    for (let i = 0; i + 1 < quotes.length; i += 2) {
      const [qs, qe] = [quotes[i], quotes[i + 1]];
      if (col <= qe) {
        return inner
          ? { start: ls + qs + 1, end: ls + qe }
          : { start: ls + qs, end: ls + qe + 1 };
      }
    }
    return null;
  }

  return null;
}

// ── Vim motions ──
// A motion yields { pos, type } with type exclusive | inclusive | linewise
// (see :help exclusive), or null when it can't move

function vimCharClass(ch) {
  if (ch === undefined || /\s/.test(ch)) return 0;
  return /\w/.test(ch) ? 2 : 1;
}

function vimWordClass(big) {
  return big
    ? (ch) => (ch === undefined || /\s/.test(ch) ? 0 : 1)
    : vimCharClass;
}

// Start of next word; an empty line counts as a word
function vimNextWordStart(p, big) {
  const val = editor.value;
  const cls = vimWordClass(big);
  const n = val.length;
  if (p >= n) return n;
  const c = cls(val[p]);
  if (c) while (p < n && cls(val[p]) === c) p++;
  while (p < n && !cls(val[p])) {
    if (val[p] === "\n") {
      p++;
      if (p >= n || val[p] === "\n") return p;
    } else p++;
  }
  return p;
}

function vimPrevWordStart(p, big) {
  const val = editor.value;
  const cls = vimWordClass(big);
  if (p <= 0) return 0;
  p--;
  while (p > 0 && !cls(val[p])) {
    if (val[p] === "\n" && val[p - 1] === "\n") return p;
    p--;
  }
  const c = cls(val[p]);
  while (p > 0 && c && cls(val[p - 1]) === c) p--;
  return p;
}

function vimNextWordEnd(p, big) {
  const val = editor.value;
  const cls = vimWordClass(big);
  const n = val.length;
  p++;
  while (p < n && !cls(val[p])) p++;
  if (p >= n) return n - 1;
  const c = cls(val[p]);
  while (p + 1 < n && cls(val[p + 1]) === c) p++;
  return p;
}

// End of the previous word (ge); an empty line counts as a word
function vimPrevWordEnd(p, big) {
  const val = editor.value;
  const cls = vimWordClass(big);
  if (p <= 0) return 0;
  const c = cls(val[p]);
  if (c) while (p > 0 && cls(val[p - 1]) === c) p--;
  p--;
  while (p > 0 && !cls(val[p])) {
    if (val[p] === "\n" && val[p - 1] === "\n") return p;
    p--;
  }
  return Math.max(p, 0);
}

// Lines fully on screen, shrunk by the 3-line scroll margin (vim's
// scrolloff) unless the screen already shows the start/end of the buffer
function vimScreenLines() {
  const rows = highlightLayer.children;
  const view = highlightLayer.getBoundingClientRect();
  let [top, bottom] = visibleRows();
  if (top < bottom && rows[top].getBoundingClientRect().top < view.top - 1)
    top++;
  if (
    top < bottom &&
    rows[bottom].getBoundingClientRect().bottom > view.bottom + 1
  )
    bottom--;
  const so = Math.min(3, (bottom - top) >> 1);
  return [
    top > 0 ? top + so : top,
    bottom < vimLastLine() ? bottom - so : bottom,
  ];
}

function vimFindChar(pos, char, kind, count) {
  const val = editor.value;
  const li = vimLineOf(pos);
  const ls = vimLineStart(li);
  const le = vimLineEnd(li);
  const fwd = kind === "f" || kind === "t";
  const till = kind === "t" || kind === "T";
  // Repeating t/T must not get stuck on the adjacent match
  let p = till && vimState._repeatFind ? pos + (fwd ? 1 : -1) : pos;
  for (let i = 0; i < count; i++) {
    p = fwd ? val.indexOf(char, p + 1) : val.lastIndexOf(char, p - 1);
    if (p === -1 || p >= le || p < ls) return null;
  }
  if (till) p -= fwd ? 1 : -1;
  return { pos: p, type: fwd ? "inclusive" : "exclusive" };
}

const VIM_MOTIONS = new Set(
  "hjklwWbBeE0^$G{};,%HML".split("").concat(["gg", "ge", "gE"]),
);

// opPending: motion is the target of an operator (affects l, $ and w)
function vimMotion(m, count, opPending) {
  const val = editor.value;
  const pos = editor.selectionStart;
  const li = vimLineOf(pos);
  const c = count || 1;
  const last = vimLastLine();
  const vertical = (target) => {
    if (vimState.desiredCol === null)
      vimState.desiredCol = pos - vimLineStart(li);
    const col = vimState.desiredCol;
    return { pos: vimColPos(target, col), type: "linewise", keepCol: true };
  };

  switch (m.name) {
    case "h":
      if (pos <= vimLineStart(li)) return null;
      return { pos: Math.max(vimLineStart(li), pos - c), type: "exclusive" };
    case "l": {
      const max = opPending ? vimLineEnd(li) : vimLastCol(li);
      if (pos >= max) return null;
      return { pos: Math.min(max, pos + c), type: "exclusive" };
    }
    case "j":
      return li < last ? vertical(Math.min(li + c, last)) : null;
    case "k":
      return li > 0 ? vertical(Math.max(li - c, 0)) : null;
    case "0":
      return { pos: vimLineStart(li), type: "exclusive" };
    case "^":
      return { pos: vimFirstNonBlank(li), type: "exclusive" };
    case "$": {
      const tl = Math.min(li + c - 1, last);
      vimState.desiredCol = Infinity;
      return { pos: vimLastCol(tl), type: "inclusive", keepCol: true };
    }
    case "G":
    case "gg": {
      const tl = count
        ? Math.min(count, last + 1) - 1
        : m.name === "G"
          ? last
          : 0;
      return { pos: vimFirstNonBlank(tl), type: "linewise" };
    }
    case "w":
    case "W": {
      const big = m.name === "W";
      let p = pos;
      let prev = pos;
      for (let i = 0; i < c && p < val.length; i++) {
        prev = p;
        p = vimNextWordStart(p, big);
      }
      if (p === pos) return null;
      // dw on the last word of a line stops at the line end (:help word)
      if (opPending && vimLineOf(p) > vimLineOf(prev) && prev < val.length) {
        const pl = vimLineOf(prev);
        if (
          vimLineText(pl)
            .slice(prev - vimLineStart(pl))
            .trim()
        )
          p = vimLineEnd(pl);
      }
      return { pos: p, type: "exclusive" };
    }
    case "b":
    case "B": {
      let p = pos;
      for (let i = 0; i < c; i++) p = vimPrevWordStart(p, m.name === "B");
      return p === pos ? null : { pos: p, type: "exclusive" };
    }
    case "e":
    case "E": {
      let p = pos;
      for (let i = 0; i < c; i++) p = vimNextWordEnd(p, m.name === "E");
      return p <= pos ? null : { pos: p, type: "inclusive" };
    }
    case "ge":
    case "gE": {
      let p = pos;
      for (let i = 0; i < c; i++) p = vimPrevWordEnd(p, m.name === "gE");
      return p === pos ? null : { pos: p, type: "inclusive" };
    }
    case "%": {
      // N% goes to N percent of the buffer
      if (count) {
        const tl =
          Math.min(Math.ceil((count * (last + 1)) / 100), last + 1) - 1;
        return { pos: vimFirstNonBlank(Math.max(tl, 0)), type: "linewise" };
      }
      // Bracket under the cursor, else the next one on the line
      const pairs = "()[]{}";
      const le = vimLineEnd(li);
      let p = pos;
      while (p < le && !pairs.includes(val[p])) p++;
      if (p >= le) return null;
      const idx = pairs.indexOf(val[p]);
      const other = pairs[idx ^ 1];
      const d = idx % 2 ? -1 : 1;
      for (let q = p, depth = 0; q >= 0 && q < val.length; q += d) {
        if (val[q] === val[p]) depth++;
        else if (val[q] === other && --depth === 0)
          return { pos: q, type: "inclusive" };
      }
      return null;
    }
    case "H":
    case "M":
    case "L": {
      const [top, bottom] = vimScreenLines();
      const l =
        m.name === "H"
          ? top + c - 1
          : m.name === "L"
            ? bottom - c + 1
            : (top + bottom) >> 1;
      return {
        pos: vimFirstNonBlank(Math.max(top, Math.min(bottom, l))),
        type: "linewise",
      };
    }
    case "{":
    case "}": {
      // Next/previous blank line after the current paragraph
      const blank = (l) => vimLineText(l).trim() === "";
      const d = m.name === "}" ? 1 : -1;
      const inside = (l) => (d > 0 ? l < last : l > 0);
      let l = li;
      for (let i = 0; i < c; i++) {
        while (inside(l) && blank(l)) l += d;
        while (inside(l) && !blank(l)) l += d;
      }
      if (d > 0 && !blank(l)) return { pos: val.length, type: "exclusive" };
      return l === li ? null : { pos: vimLineStart(l), type: "exclusive" };
    }
    case "f":
    case "F":
    case "t":
    case "T": {
      const r = vimFindChar(pos, m.char, m.name, c);
      if (r) vimState.findChar = { char: m.char, kind: m.name };
      return r;
    }
    case ";":
    case ",": {
      const fc = vimState.findChar;
      if (!fc) return null;
      const flip = { f: "F", F: "f", t: "T", T: "t" };
      const kind = m.name === ";" ? fc.kind : flip[fc.kind];
      vimState._repeatFind = true;
      try {
        return vimFindChar(pos, fc.char, kind, c);
      } finally {
        vimState._repeatFind = false;
      }
    }
  }
  return null;
}

// Range an operator acts on, from the cursor to motion result `r`
function vimMotionRange(pos, r) {
  if (r.type === "linewise") {
    const a = vimLineOf(pos);
    const b = vimLineOf(r.pos);
    return { linewise: true, first: Math.min(a, b), last: Math.max(a, b) };
  }
  let s = Math.min(pos, r.pos);
  let e = Math.max(pos, r.pos);
  if (r.type === "inclusive") {
    e = Math.min(e + 1, vimLineEnd(vimLineOf(e)));
  } else if (
    e > s &&
    e === vimLineStart(vimLineOf(e)) &&
    vimLineOf(e) > vimLineOf(s)
  ) {
    // Exclusive motion ending at column 0: stop at the previous line's
    // end, and go linewise if it started at/before the first non-blank
    const sl = vimLineOf(s);
    const el = vimLineOf(e) - 1;
    if (s <= vimFirstNonBlank(sl))
      return { linewise: true, first: sl, last: el };
    e = vimLineEnd(el);
  }
  return { linewise: false, start: s, end: e };
}

// ── Vim command parser ──
// Grammar: [count] (motion | operator [count] (motion | textobj | operator)
// | command [char]). Returns null while incomplete, { invalid } on garbage.

const VIM_OPERATORS = new Set(["d", "c", "y", ">", "<"]);
const VIM_TEXTOBJ = new Set("wWp()b{}B[]<>\"'`".split(""));
const VIM_COMMANDS = new Set("xXDCsSYJpPu.iaIAoOvVnN*#:/?~".split(""));

function vimParse(keys) {
  let i = 0;
  const readCount = () => {
    let s = "";
    while (i < keys.length && /^[0-9]$/.test(keys[i]) && (s || keys[i] !== "0"))
      s += keys[i++];
    return s ? parseInt(s, 10) : 0;
  };
  const readMotion = () => {
    if (i >= keys.length) return null;
    const k = keys[i++];
    if (k === "g") {
      if (i >= keys.length) return null;
      const name = "g" + keys[i++];
      return VIM_MOTIONS.has(name) ? { name } : { invalid: true };
    }
    if ("fFtT".includes(k)) {
      if (i >= keys.length) return null;
      const ch = keys[i++];
      return ch.length === 1 ? { name: k, char: ch } : { invalid: true };
    }
    return VIM_MOTIONS.has(k) ? { name: k } : { invalid: true };
  };

  const count = readCount();
  if (i >= keys.length) return null;
  const k = keys[i];

  if (VIM_OPERATORS.has(k)) {
    i++;
    const count2 = readCount();
    const total = count || count2 ? (count || 1) * (count2 || 1) : 0;
    if (i >= keys.length) return null;
    const next = keys[i];
    if (next === k) return { op: k, count: total, lines: true };
    if (next === "i" || next === "a") {
      if (i + 1 >= keys.length) return null;
      const t = keys[i + 1];
      if (!VIM_TEXTOBJ.has(t)) return { invalid: true };
      return { op: k, count: total, textobj: { type: t, inner: next === "i" } };
    }
    const motion = readMotion();
    if (!motion) return null;
    if (motion.invalid) return motion;
    return { op: k, count: total, motion };
  }

  if (k === "r") {
    if (i + 1 >= keys.length) return null;
    const ch = keys[i + 1];
    return ch.length === 1 ? { cmd: "r", count, char: ch } : { invalid: true };
  }
  if (k === "g" || VIM_MOTIONS.has(k) || "fFtT".includes(k)) {
    const motion = readMotion();
    if (!motion) return null;
    if (motion.invalid) return motion;
    return { motion, count };
  }
  if (VIM_COMMANDS.has(k)) return { cmd: k, count };
  return { invalid: true };
}

// ── Vim command execution ──

function vimExecNormal(key) {
  // Temporarily allow editing for commands that modify text
  editor.readOnly = false;
  try {
    vimBatch(() => _vimExecKey(key));
  } finally {
    if (vimState.mode === "normal") {
      if (!vimState.keys.length) vimClampCursor();
      editor.readOnly = true;
    } else if (vimState.mode === "visual") editor.readOnly = true;
    updateCursorPos();
  }
}

function _vimExecKey(key) {
  vimState.keys.push(key);
  const cmd = vimParse(vimState.keys);
  if (!cmd) return;
  const keys = vimState.keys;
  vimState.keys = [];
  if (cmd.invalid) return;
  vimState._undoPushed = false;
  vimState._changed = false;
  _vimExecNormal(cmd);
  // Remember changes for "." (inserts are completed on Escape)
  if (
    !vimState._replaying &&
    cmd.cmd !== "." &&
    (vimState._changed || vimState.mode === "insert")
  ) {
    vimState.lastChange = {
      keys: keys.slice(countKeys(keys)),
      count: cmd.count,
      insert: null,
    };
  }
}

// Number of leading count keys ("12dw" → 2)
function countKeys(keys) {
  let n = 0;
  while (n < keys.length && /^[0-9]$/.test(keys[n]) && (n || keys[n] !== "0"))
    n++;
  return n;
}

function vimEnterInsert(pos, key) {
  vimSetCursor(pos);
  vimState.insertEntry = { key, pos };
  vimSetMode("insert");
}

function _vimExecNormal(cmd) {
  const pos = editor.selectionStart;
  const li = vimLineOf(pos);
  const cnt = cmd.count || 1;

  if (cmd.motion && !cmd.op) {
    const r = vimMotion(cmd.motion, cmd.count, false);
    if (!r) return;
    if (!r.keepCol) vimState.desiredCol = null;
    vimSetCursor(r.pos);
    return;
  }

  if (cmd.op) {
    let range;
    if (cmd.lines) {
      if (cnt > 1 && li === vimLastLine()) return;
      range = {
        linewise: true,
        first: li,
        last: Math.min(li + cnt - 1, vimLastLine()),
      };
    } else if (cmd.textobj) {
      const obj = vimTextObject(cmd.textobj.type, cmd.textobj.inner);
      if (!obj) return;
      range = obj.linewise
        ? obj
        : { linewise: false, start: obj.start, end: obj.end };
    } else {
      let motion = cmd.motion;
      // cw on a word behaves like ce (:help cw)
      if (cmd.op === "c" && (motion.name === "w" || motion.name === "W")) {
        const val = editor.value;
        if (pos < val.length && !/\s/.test(val[pos])) {
          const cls = vimWordClass(motion.name === "W");
          let p = pos;
          while (
            p + 1 < val.length &&
            val[p + 1] !== "\n" &&
            cls(val[p + 1]) === cls(val[pos])
          )
            p++;
          for (let i = 1; i < cnt; i++)
            p = vimNextWordEnd(p, motion.name === "W");
          range = { linewise: false, start: pos, end: p + 1 };
        }
      }
      if (!range) {
        const r = vimMotion(motion, cmd.count, true);
        vimState.desiredCol = null;
        if (!r) return;
        range = vimMotionRange(pos, r);
      }
    }
    vimApplyOperator(cmd.op, range, pos);
    return;
  }

  const val = editor.value;
  const ls = vimLineStart(li);
  const le = vimLineEnd(li);
  switch (cmd.cmd) {
    case "s":
      // s on an empty line just inserts (cl has nothing to change)
      if (pos >= le) return vimEnterInsert(pos, "s");
    // falls through
    case "x":
    case "X":
    case "D":
    case "C":
    case "Y": {
      const alias = { x: "dl", X: "dh", D: "d$", C: "c$", s: "cl", Y: "yy" };
      const sub = vimParse(alias[cmd.cmd].split(""));
      sub.count = cmd.count;
      return _vimExecNormal(sub);
    }
    case "S":
      return _vimExecNormal({ op: "c", lines: true, count: cmd.count });
    case "r":
      if (pos + cnt > le) return;
      vimEdit(pos, pos + cnt, cmd.char.repeat(cnt));
      return vimSetCursor(pos + cnt - 1);
    case "~": {
      const end = Math.min(pos + cnt, le);
      if (end <= pos) return;
      const text = val
        .slice(pos, end)
        .replace(/./g, (ch) =>
          ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
        );
      vimEdit(pos, end, text);
      return vimSetCursor(Math.min(end, vimLastCol(li)));
    }
    case "J":
      return vimJoinLines(li, cnt);
    case "p":
    case "P": {
      const reg = vimState.clipboard;
      if (!reg) return;
      if (vimState.clipboardLinewise) {
        const lines = reg.replace(/\n$/, "");
        const block = Array(cnt).fill(lines).join("\n");
        if (cmd.cmd === "p") {
          vimEdit(le, le, "\n" + block);
          return vimSetCursor(vimFirstNonBlank(li + 1));
        }
        vimEdit(ls, ls, block + "\n");
        return vimSetCursor(vimFirstNonBlank(li));
      }
      const text = reg.repeat(cnt);
      const at = cmd.cmd === "p" && pos < le ? pos + 1 : pos;
      vimEdit(at, at, text);
      return vimSetCursor(at + text.length - 1);
    }
    case "u":
      for (let i = 0; i < cnt; i++) undo();
      return;
    case ".": {
      const lc = vimState.lastChange;
      if (!lc) return;
      vimState._replaying = true;
      const finishInsert = () => {
        if (vimState.mode !== "insert") return;
        if (lc.insert)
          vimEdit(editor.selectionStart, editor.selectionStart, lc.insert);
        vimLeaveInsert();
      };
      try {
        if (lc.visual) {
          // Vim ignores a count on "." for visual changes
          vimRepeatVisual(lc);
          finishInsert();
        } else {
          const count = cmd.count || lc.count;
          const keys = (count ? String(count).split("") : []).concat(lc.keys);
          for (const k of keys) vimExecNormal(k);
          finishInsert();
        }
      } finally {
        vimState._replaying = false;
      }
      return;
    }
    case "i":
      return vimEnterInsert(pos, "i");
    case "a":
      return vimEnterInsert(pos < le ? pos + 1 : pos, "a");
    case "I":
      return vimEnterInsert(vimFirstNonBlank(li), "I");
    case "A":
      return vimEnterInsert(le, "A");
    case "o":
      vimEdit(le, le, "\n");
      return vimEnterInsert(le + 1, "o");
    case "O":
      vimEdit(ls, ls, "\n");
      return vimEnterInsert(ls, "O");
    case "v":
    case "V":
      vimState.visualLine = cmd.cmd === "V";
      vimState.visualAnchor = pos;
      vimState.visualHead = pos;
      vimSetMode("visual");
      return vimRenderVisual();
    case "n":
    case "N":
      return vimSearch(
        null,
        cmd.cmd === "n" ? vimState.searchDirection : -vimState.searchDirection,
        cnt,
      );
    case "*":
    case "#": {
      // Whole keyword, case-insensitive (vim ignores smartcase for *)
      const obj = vimTextObject("w", true);
      if (!obj) return;
      const word = val.slice(obj.start, obj.end);
      vimState.searchDirection = cmd.cmd === "*" ? 1 : -1;
      const pattern = /^\w+$/.test(word)
        ? `\\<${word}\\>`
        : "\\V" + word.replace(/\\/g, "\\\\");
      return vimSearch(pattern, vimState.searchDirection, cnt, true);
    }
    case "/":
    case "?":
      vimState.searchDirection = cmd.cmd === "/" ? 1 : -1;
      return vimOpenCommandBar(cmd.cmd);
    case ":":
      return vimOpenCommandBar(":");
  }
}

function vimApplyOperator(op, range, pos, times = 1) {
  if (range.linewise) {
    const { first, last } = range;
    if (op === "d") return vimDeleteLines(first, last);
    if (op === "y") {
      vimSetRegister(vimLinesText(first, last), true);
      // yk moves up; yj stays
      if (vimLineOf(pos) > first)
        vimSetCursor(vimColPos(first, pos - vimLineStart(vimLineOf(pos))));
      return;
    }
    if (op === ">" || op === "<")
      return vimShiftLines(first, last, op === ">" ? 1 : -1, times);
    if (op === "c") {
      vimSetRegister(vimLinesText(first, last), true);
      const indent = vimLineText(first).match(/^[ \t]*/)[0];
      const s = vimLineStart(first);
      vimEdit(s, vimLineEnd(last), indent);
      return vimEnterInsert(s + indent.length, "c");
    }
    return;
  }
  const { start, end } = range;
  if (op === "d") return vimDeleteRange(start, end);
  if (op === "y") {
    vimSetRegister(editor.value.slice(start, end), false);
    return vimSetCursor(start);
  }
  if (op === "c") {
    vimDeleteRange(start, end);
    return vimEnterInsert(start, "c");
  }
  // > / < with a charwise motion still shift whole lines
  vimShiftLines(
    vimLineOf(start),
    vimLineOf(Math.max(start, end - 1)),
    op === ">" ? 1 : -1,
    times,
  );
}

// Leave insert mode: record typed text for ".", cursor back one (vim)
function vimLeaveInsert() {
  const ie = vimState.insertEntry;
  const end = editor.selectionStart;
  if (ie && vimState.lastChange && !vimState._replaying)
    vimState.lastChange.insert =
      end > ie.pos ? editor.value.slice(ie.pos, end) : "";
  vimState.insertEntry = null;
  vimSetMode("normal");
  if (end > vimLineStart(vimLineOf(end))) vimSetCursor(end - 1);
  vimClampCursor();
  editor.readOnly = true;
  updateCursorPos();
}

// Search with a vim pattern from the cursor, wrapping around. Without a
// pattern, repeats the last search (n / N).
function vimSearch(pattern, dir, count = 1, ignoreCase) {
  if (!pattern) {
    if (!vimState.lastSearch)
      return vimShowError("No previous regular expression");
    ({ pattern, ignoreCase } = vimState.lastSearch);
  }
  let re;
  try {
    re = vimCompile(pattern, ignoreCase);
  } catch (e) {
    return vimShowError("Invalid pattern: " + e.message);
  }
  vimState.lastSearch = { pattern, ignoreCase };
  const val = editor.value;
  const starts = [];
  for (let m; (m = re.exec(val));) {
    starts.push(m.index);
    if (!m[0]) re.lastIndex++;
  }
  if (!starts.length) return vimShowError("Pattern not found: " + pattern);
  let p = editor.selectionStart;
  for (let i = 0; i < count; i++) {
    const next =
      dir > 0
        ? (starts.find((s) => s > p) ?? starts[0])
        : ([...starts].reverse().find((s) => s < p) ??
          starts[starts.length - 1]);
    p = next;
  }
  vimState.desiredCol = null;
  vimSetCursor(p);
}

// ── Vim regex ──
// Translates vim pattern syntax to a JS RegExp: magic by default, \v \V \m
// \M, \c \C, \( \| \+ \= \{n,m} \{-}, \< \>, \a \l \u \x \h …

const VIM_CLASSES = {
  a: "[A-Za-z]",
  A: "[^A-Za-z]",
  l: "[a-z]",
  L: "[^a-z]",
  u: "[A-Z]",
  U: "[^A-Z]",
  x: "[0-9A-Fa-f]",
  X: "[^0-9A-Fa-f]",
  o: "[0-7]",
  O: "[^0-7]",
  h: "[A-Za-z_]",
  H: "[^A-Za-z_]",
  s: "[ \\t]",
  S: "[^ \\t\\n]",
  d: "\\d",
  D: "[^\\d\\n]",
  w: "[0-9A-Za-z_]",
  W: "[^0-9A-Za-z_\\n]",
  t: "\\t",
  n: "\\n",
  r: "\\r",
  e: "\\x1b",
};
const VIM_POSIX = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  xdigit: "0-9A-Fa-f",
};

function vimRegexSource(p) {
  let mode = "m";
  let ic;
  let out = "";
  let i = 0;
  const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const atomStart = () => out === "" || /(\(|\||\(\?:)$/.test(out);
  const brace = () => {
    const j = p.indexOf("}", i);
    if (j < 0) throw new Error("Missing } after \\{");
    let body = p.slice(i, j).replace(/\\$/, "");
    i = j + 1;
    const lazy = body.startsWith("-");
    if (lazy) body = body.slice(1);
    let q;
    if (body === "") q = "*";
    else if (/^\d+$/.test(body)) q = `{${body}}`;
    else if (/^\d*,\d*$/.test(body)) {
      const [a, b] = body.split(",");
      q = `{${a || 0},${b}}`;
    } else throw new Error("Invalid \\{" + body + "}");
    return q + (lazy ? "?" : "");
  };
  // [...] copied mostly as is; unclosed [ is a literal (as in vim)
  const cls = () => {
    let j = i;
    let body = "[";
    if (p[j] === "^") body += p[j++];
    if (p[j] === "]") ((body += "\\]"), j++);
    while (j < p.length && p[j] !== "]") {
      const posix = p.slice(j).match(/^\[:(\w+):\]/);
      if (posix && VIM_POSIX[posix[1]]) {
        body += VIM_POSIX[posix[1]];
        j += posix[0].length;
      } else if (p[j] === "\\" && j + 1 < p.length) {
        body += p[j] + p[j + 1];
        j += 2;
      } else ((body += p[j] === "[" ? "\\[" : p[j]), j++);
    }
    if (j >= p.length) return "\\[";
    i = j + 1;
    return body + "]";
  };

  while (i < p.length) {
    const c = p[i++];
    if (c === "\\") {
      const n = p[i++];
      if (n === undefined) {
        out += "\\\\";
        break;
      }
      if ("vVmM".includes(n)) {
        mode = n === "v" ? "v" : n === "V" ? "V" : "m";
        continue;
      }
      if (n === "c" || n === "C") {
        ic = n === "c";
        continue;
      }
      if (n === "<") out += "\\b(?=\\w)";
      else if (n === ">") out += "\\b(?<=\\w)";
      else if (VIM_CLASSES[n]) out += VIM_CLASSES[n];
      else if (/[1-9]/.test(n)) out += "\\" + n;
      else if (mode !== "v" && n === "(") out += "(";
      else if (mode !== "v" && n === "%" && p[i] === "(") ((out += "(?:"), i++);
      else if (mode !== "v" && ")|+".includes(n)) out += n;
      else if (mode !== "v" && (n === "=" || n === "?")) out += "?";
      else if (mode !== "v" && n === "{") out += brace();
      else if (
        mode === "V" &&
        (n === "." || n === "*" || n === "^" || n === "$")
      )
        out += n;
      else if (mode === "V" && n === "[") out += cls();
      else out += esc(n);
      continue;
    }
    if (mode === "V") {
      if (c === "^" && atomStart()) out += "^";
      else if (c === "$" && i === p.length) out += "$";
      else out += esc(c);
      continue;
    }
    if (mode === "v") {
      if (c === "<") out += "\\b(?=\\w)";
      else if (c === ">") out += "\\b(?<=\\w)";
      else if (c === "=") out += "?";
      else if (c === "{") out += brace();
      else if (c === "[") out += cls();
      else if (c === "%" && p[i] === "(") ((out += "(?:"), i++);
      else if (c === "/" || c === "}") out += esc(c);
      else out += c;
      continue;
    }
    // magic
    if (c === ".") out += ".";
    else if (c === "*") out += atomStart() ? "\\*" : "*";
    else if (c === "[") out += cls();
    else if (c === "^") out += atomStart() ? "^" : "\\^";
    else if (c === "$") {
      const rest = p.slice(i);
      out +=
        rest === "" || rest.startsWith("\\|") || rest.startsWith("\\)")
          ? "$"
          : "\\$";
    } else if (c === "~") out += esc(vimState.lastSubRep || "");
    else out += esc(c);
  }
  return { source: out, ic };
}

// Case: \c / \C win, then an explicit flag (:s i / I), then smartcase —
// ignore case unless the pattern has an uppercase letter (vim with
// 'ignorecase' + 'smartcase')
function vimCompile(pattern, ignoreCase) {
  const { source, ic } = vimRegexSource(pattern);
  const smart = !/[A-Z]/.test(pattern.replace(/\\./g, ""));
  return new RegExp(source, "gm" + ((ic ?? ignoreCase ?? smart) ? "i" : ""));
}

// ── Vim ex ranges ──
// Addresses: N . $ '< '> with +N / -N offsets; % = all lines

// `cur` is what . and bare +N are relative to
function vimParseAddress(s, i, cur = vimCursorLine()) {
  let line = null;
  const num = s.slice(i).match(/^\d+/);
  if (num) ((line = parseInt(num[0], 10) - 1), (i += num[0].length));
  else if (s[i] === ".") ((line = cur), i++);
  else if (s[i] === "$") ((line = vimLastLine()), i++);
  else if (s[i] === "'" && (s[i + 1] === "<" || s[i + 1] === ">")) {
    const m = vimState.visualMarks;
    if (!m) throw new Error("Mark not set");
    line = s[i + 1] === "<" ? m.first : m.last;
    i += 2;
  }
  let off;
  while ((off = s.slice(i).match(/^([+-])(\d*)/))) {
    line = (line ?? cur) + (off[1] === "+" ? 1 : -1) * (off[2] ? +off[2] : 1);
    i += off[0].length;
  }
  return { line, i };
}

function vimParseRange(s) {
  let i = s.match(/^\s*/)[0].length;
  if (s[i] === "%")
    return { first: 0, last: vimLastLine(), rest: s.slice(i + 1) };
  const a = vimParseAddress(s, i);
  if (a.line === null) return { first: null, last: null, rest: s.slice(a.i) };
  let first = a.line;
  let last = a.line;
  i = a.i;
  if (s[i] === "," || s[i] === ";") {
    // With ; the second address counts from the first (2;+1 = lines 2-3)
    const b = vimParseAddress(s, i + 1, s[i] === ";" ? first : undefined);
    if (b.line !== null) last = b.line;
    i = b.i;
  }
  if (first > last) [first, last] = [last, first];
  if (first < 0 || last > vimLastLine()) throw new Error("Invalid range");
  return { first, last, rest: s.slice(i) };
}

// :[range]s/pat/rep/[flags] — vim regex and replacement syntax
function vimSubstitute(cmd, first, last) {
  const head = cmd.match(/^s(?:ubstitute)?(.)/);
  const d = head[1];
  let i = head[0].length;
  const readPart = () => {
    let part = "";
    while (i < cmd.length && cmd[i] !== d) {
      if (cmd[i] === "\\" && i + 1 < cmd.length) {
        part += cmd[i + 1] === d ? d : cmd[i] + cmd[i + 1];
        i += 2;
      } else part += cmd[i++];
    }
    return part;
  };
  let pat = readPart();
  let rep = cmd[i] === d ? (i++, readPart()) : "";
  const flags = cmd[i] === d ? cmd.slice(i + 1).trim() : "";
  if (!pat) pat = vimState.lastSearch?.pattern;
  if (!pat) return vimShowError("No previous regular expression");
  // ~ in the replacement is the previous replacement string
  rep = rep.replace(
    /(^|[^\\])~/g,
    (_, pre) => pre + (vimState.lastSubRep || ""),
  );
  vimState.lastSubRep = rep;
  let re;
  try {
    re = vimCompile(
      pat,
      flags.includes("i") ? true : flags.includes("I") ? false : undefined,
    );
  } catch (e) {
    return vimShowError("Invalid pattern: " + e.message);
  }
  vimState.lastSearch = { pattern: pat };

  const start = vimLineStart(first);
  const end = vimLineEnd(last);
  const text = editor.value.slice(start, end);
  const nl = [];
  for (let k = text.indexOf("\n"); k !== -1; k = text.indexOf("\n", k + 1))
    nl.push(k);
  const lineAt = (off) => {
    let lo = 0;
    let hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < off) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const all = flags.includes("g");
  const lines = new Set();
  let count = 0;
  const out = text.replace(re, (...a) => {
    const line = lineAt(a[a.length - 2]);
    if (!all && lines.has(line)) return a[0];
    lines.add(line);
    count++;
    return vimExpandReplacement(rep, a);
  });
  if (!count)
    return flags.includes("e")
      ? undefined
      : vimShowError("Pattern not found: " + pat);
  const summary = `${count} substitution${count > 1 ? "s" : ""} on ${lines.size} line${lines.size > 1 ? "s" : ""}`;
  if (flags.includes("n"))
    return showMdToast(summary.replace("substitution", "match"));
  vimState._undoPushed = false;
  vimEdit(start, end, out);
  // Cursor on the last substituted line (shifted by inserted line breaks)
  const grown = out.split("\n").length - text.split("\n").length;
  vimSetCursor(
    vimFirstNonBlank(
      Math.min(first + Math.max(...lines) + Math.max(grown, 0), vimLastLine()),
    ),
  );
  if (lines.size > 2) showMdToast(summary);
}

// & \0-\9 \r (line break) \t \\ and case modifiers \u \l \U \L \e
function vimExpandReplacement(rep, m) {
  let out = "";
  let once = null;
  let all = null;
  for (let k = 0; k < rep.length; k++) {
    let piece = rep[k];
    if (piece === "&") piece = m[0];
    else if (piece === "\\" && k + 1 < rep.length) {
      const n = rep[++k];
      if (/\d/.test(n))
        piece = n === "0" ? m[0] : typeof m[+n] === "string" ? m[+n] : "";
      else if (n === "r" || n === "n") piece = "\n";
      else if (n === "t") piece = "\t";
      else if (n === "u" || n === "l") {
        once = n;
        continue;
      } else if (n === "U" || n === "L") {
        all = n;
        continue;
      } else if (n === "e" || n === "E") {
        all = null;
        continue;
      } else piece = n;
    }
    if (all) piece = all === "U" ? piece.toUpperCase() : piece.toLowerCase();
    if (once && piece) {
      piece =
        (once === "u" ? piece[0].toUpperCase() : piece[0].toLowerCase()) +
        piece.slice(1);
      once = null;
    }
    out += piece;
  }
  return out;
}

// ── Vim visual mode ──

function vimRenderVisual() {
  const a = vimState.visualAnchor;
  const h = vimState.visualHead;
  if (vimState.visualLine) {
    const first = Math.min(vimLineOf(a), vimLineOf(h));
    const last = Math.max(vimLineOf(a), vimLineOf(h));
    const end =
      last < vimLastLine() ? vimLineStart(last + 1) : editor.value.length;
    editor.setSelectionRange(vimLineStart(first), end);
  } else {
    editor.setSelectionRange(
      Math.min(a, h),
      Math.min(Math.max(a, h) + 1, editor.value.length),
    );
  }
  updateCursorPos();
  vimUpdateBlockCursor();
}

// Selection as an operator range
function vimVisualRange() {
  const a = vimState.visualAnchor;
  const h = vimState.visualHead;
  if (vimState.visualLine) {
    return {
      linewise: true,
      first: Math.min(vimLineOf(a), vimLineOf(h)),
      last: Math.max(vimLineOf(a), vimLineOf(h)),
    };
  }
  const s = Math.min(a, h);
  return {
    linewise: false,
    start: s,
    end: Math.min(Math.max(a, h) + 1, editor.value.length),
  };
}

function vimExecVisual(key) {
  editor.readOnly = false;
  try {
    vimBatch(() => _vimExecVisual(key));
  } finally {
    if (vimState.mode === "normal") vimClampCursor();
    if (vimState.mode !== "insert") editor.readOnly = true;
    updateCursorPos();
  }
}

function _vimExecVisual(key) {
  vimState.keys.push(key);
  const keys = vimState.keys;
  const exit = () => {
    vimState.keys = [];
    vimState.visualLine = false;
    vimSetMode("normal");
  };

  // Text objects extend the selection (viw, vi()
  if (
    keys.length >= 2 &&
    (keys[keys.length - 2] === "i" || keys[keys.length - 2] === "a") &&
    countKeys(keys) === keys.length - 2
  ) {
    vimState.keys = [];
    vimSetCursor(vimState.visualHead);
    const obj = vimTextObject(key, keys[keys.length - 2] === "i");
    if (obj && !obj.linewise && obj.end > obj.start) {
      vimState.visualAnchor = obj.start;
      vimState.visualHead = obj.end - 1;
    }
    return vimRenderVisual();
  }
  const n = countKeys(keys);
  if (n === keys.length) return; // count so far
  const k = keys[n];
  if ((k === "i" || k === "a") && keys.length === n + 1) return;

  if (k === "g" || VIM_MOTIONS.has(k) || "fFtT".includes(k)) {
    const cmd = vimParse(keys);
    if (!cmd) return;
    vimState.keys = [];
    if (cmd.invalid) return;
    vimSetCursor(vimState.visualHead);
    const r = vimMotion(cmd.motion, cmd.count, false);
    if (r) {
      if (!r.keepCol) vimState.desiredCol = null;
      vimState.visualHead = r.pos;
    }
    return vimRenderVisual();
  }

  vimState.keys = [];
  vimState._undoPushed = false;
  const range = vimVisualRange();
  const start = range.linewise ? vimLineStart(range.first) : range.start;
  const count = n ? parseInt(keys.slice(0, n).join(""), 10) : 1;
  // "." repeats a visual change on the same amount of text from the cursor
  if ("dxcs><J~uU".includes(k) && !vimState._replaying)
    vimState.lastChange = {
      visual: vimVisualShape(range),
      key: k,
      count,
      insert: null,
    };

  switch (k) {
    case "Escape":
      vimSetCursor(vimState.visualHead);
      return exit();
    case "v":
    case "V":
      if (vimState.visualLine === (k === "V")) {
        vimSetCursor(vimState.visualHead);
        return exit();
      }
      vimState.visualLine = k === "V";
      return vimRenderVisual();
    case "o":
      [vimState.visualAnchor, vimState.visualHead] = [
        vimState.visualHead,
        vimState.visualAnchor,
      ];
      return vimRenderVisual();
    case ":":
      vimSetCursor(vimState.visualHead);
      exit();
      return vimOpenCommandBar(":", "'<,'>");
    case "d":
    case "x":
    case "y":
    case ">":
    case "<":
      vimSetCursor(start);
      exit();
      return vimApplyOperator(k === "x" ? "d" : k, range, start, count);
    case "c":
    case "s":
      vimSetCursor(start);
      exit();
      return vimApplyOperator("c", range, start);
    case "J": {
      const first = vimLineOf(
        range.linewise ? vimLineStart(range.first) : range.start,
      );
      const last = range.linewise ? range.last : vimLineOf(range.end - 1);
      exit();
      return vimJoinLines(first, last - first + 1);
    }
    case "~":
    case "u":
    case "U": {
      const s = range.linewise ? vimLineStart(range.first) : range.start;
      const e = range.linewise ? vimLineEnd(range.last) : range.end;
      const text = editor.value.slice(s, e);
      const out =
        k === "u"
          ? text.toLowerCase()
          : k === "U"
            ? text.toUpperCase()
            : text.replace(/./g, (ch) =>
                ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase(),
              );
      exit();
      vimEdit(s, e, out);
      return vimSetCursor(s);
    }
  }
}

// Size of a visual selection, relative to its start (see :help visual-repeat)
function vimVisualShape(range) {
  if (range.linewise)
    return { linewise: true, lines: range.last - range.first };
  const first = vimLineOf(range.start);
  const last = vimLineOf(Math.max(range.start, range.end - 1));
  return last === first
    ? { lines: 0, chars: range.end - range.start }
    : { lines: last - first, endCol: range.end - 1 - vimLineStart(last) };
}

// Re-select a recorded shape at the cursor and apply the visual command
function vimRepeatVisual(lc) {
  const pos = editor.selectionStart;
  const li = vimLineOf(pos);
  const v = lc.visual;
  const target = Math.min(li + v.lines, vimLastLine());
  vimState.visualLine = !!v.linewise;
  vimState.visualAnchor = pos;
  vimState.visualHead = v.linewise
    ? vimLineStart(target)
    : v.lines
      ? Math.min(vimLineStart(target) + v.endCol, vimLastCol(target))
      : Math.min(pos + v.chars - 1, vimLastCol(li));
  vimSetMode("visual");
  // Replays the original count (V3> then . shifts 3 again)
  vimState.keys = lc.count > 1 ? String(lc.count).split("") : [];
  _vimExecVisual(lc.key);
}

// Cursor motion without the parser (scroll wheel, Ctrl+D/U)
function vimMoveLines(dir, lines) {
  const motion = { name: dir > 0 ? "j" : "k" };
  if (vimState.mode === "visual") {
    vimSetCursor(vimState.visualHead);
    const r = vimMotion(motion, lines, false);
    if (r) vimState.visualHead = r.pos;
    return vimRenderVisual();
  }
  const r = vimMotion(motion, lines, false);
  if (r) vimSetCursor(r.pos);
  updateCursorPos();
}

// ── Vim command mode ──

const vimCommandBar = document.getElementById("vimCommandBar");
const vimCommandInput = document.getElementById("vimCommandInput");

let vimErrorDismiss = null;

function vimOpenCommandBar(prefix, initial = "") {
  if (vimErrorDismiss) {
    vimCommandInput.removeEventListener("keydown", vimErrorDismiss);
    vimErrorDismiss = null;
  }
  vimCommandBar.classList.remove("error");
  vimCommandInput.readOnly = false;
  vimCommandBar.classList.add("visible");
  document.querySelector(".vim-command-prefix").textContent = prefix || ":";
  vimCommandInput.value = initial;
  vimCommandInput.focus();
}

function vimCloseCommandBar() {
  vimCommandBar.classList.remove("visible");
  vimCommandInput.value = "";
  // Temporarily allow focus, then re-assert readonly
  editor.readOnly = false;
  editor.focus();
  if (vimState.enabled && vimState.mode !== "insert") {
    editor.readOnly = true;
  }
  updateCursorPos();
  vimUpdateBlockCursor();
}

function vimShowError(msg) {
  vimCommandBar.classList.add("visible", "error");
  vimCommandInput.value = msg;
  vimCommandInput.readOnly = true;
  vimCommandInput.focus();
  const dismiss = () => {
    vimCommandBar.classList.remove("error");
    vimCommandInput.readOnly = false;
    vimCloseCommandBar();
    vimCommandInput.removeEventListener("keydown", dismiss);
    vimErrorDismiss = null;
  };
  vimErrorDismiss = dismiss;
  vimCommandInput.addEventListener("keydown", dismiss);
}

function vimWriteBuffer() {
  const note = getActiveNote();
  if (!note) return;
  note.content = editor.value;
  note.updatedAt = Date.now();
  saveState();
  scheduleDriveUpload(true);
  updateUrl();
  deleteSwap(note.id);
  vimState.bufferDirty = false;
  updateCursorPos();
}

function vimCheckDirty(onClean) {
  if (vimState.bufferDirty) {
    vimShowError("No write since last change (add ! to override)");
    return false;
  }
  onClean();
  return true;
}

function vimDiscardBuffer() {
  const note = getActiveNote();
  if (!note) return;
  editor.value = note.content;
  deleteSwap(note.id);
  vimState.bufferDirty = false;
  updateLineNumbers();
  updateHighlight();
  updateCursorPos();
}

function vimExecCommand(cmd) {
  let range;
  try {
    range = vimParseRange(cmd.trim());
  } catch (e) {
    return vimShowError(e.message);
  }
  const trimmed = range.rest.trim();
  const hasRange = range.first !== null;
  const cur = vimCursorLine();

  // :N, :$, :'< … — a bare range jumps to its last line
  if (hasRange && !trimmed) {
    vimSetCursor(vimFirstNonBlank(range.last));
    updateCursorPos();
    return;
  }

  // :[range]s/pat/rep/[flags]
  if (/^s(?:ubstitute)?[^\w\s"|]/.test(trimmed)) {
    vimSubstitute(trimmed, range.first ?? cur, range.last ?? cur);
    updateCursorPos();
    return;
  }

  // :[range]d — delete lines
  if (trimmed === "d" || trimmed === "delete") {
    vimState._undoPushed = false;
    vimDeleteLines(range.first ?? cur, range.last ?? cur);
    updateCursorPos();
    return;
  }

  // :w — write buffer to storage
  if (trimmed === "w") {
    vimWriteBuffer();
    return;
  }

  // :wq — write and exit vim
  if (trimmed === "wq") {
    vimWriteBuffer();
    toggleVim();
    return;
  }

  // :q! — discard and exit vim
  if (trimmed === "q!") {
    vimDiscardBuffer();
    toggleVim();
    return;
  }

  // :q — exit vim (with dirty check)
  if (trimmed === "q") {
    vimCheckDirty(() => toggleVim());
    return;
  }

  // :set wrap / :set nowrap / :set wrap!
  if (trimmed === "set wrap") {
    if (!editorArea.classList.contains("wrap")) toggleWrap();
    return;
  }
  if (trimmed === "set nowrap") {
    if (editorArea.classList.contains("wrap")) toggleWrap();
    return;
  }
  if (trimmed === "set wrap!") {
    toggleWrap();
    return;
  }

  // :new / :n — create new note
  if (trimmed === "new" || trimmed === "n") {
    if (vimState.bufferDirty) {
      vimShowError("No write since last change (add ! to override)");
      return;
    }
    createNote();
    return;
  }

  // :draw — create new drawing
  if (trimmed === "draw") {
    if (vimState.bufferDirty) {
      vimShowError("No write since last change (add ! to override)");
      return;
    }
    createNote(undefined, undefined, false, "draw");
    return;
  }

  // :help — open help
  if (trimmed === "help") {
    openHelp();
    return;
  }

  // :mddemo — open markdown features demo
  if (trimmed === "mddemo") {
    if (vimState.bufferDirty) vimWriteBuffer();
    openMdDemo();
    return;
  }

  // :view — open markdown preview
  if (trimmed === "view") {
    const note = getActiveNote();
    if (note && hasViewTab(note.name)) {
      if (vimState.bufferDirty) vimWriteBuffer();
      switchMdTab("view", true);
    } else {
      vimShowError("Not a markdown file or drawing");
    }
    return;
  }

  // :fmt — format markdown
  if (trimmed === "fmt") {
    const note = getActiveNote();
    if (note && isMarkdownFile(note.name)) {
      const pos = editor.selectionStart;
      pushHistory(note.id, editor.value);
      editor.value = formatMarkdown(editor.value);
      vimState.bufferDirty = true;
      saveSwap(note.id, editor.value);
      editor.selectionStart = editor.selectionEnd = Math.min(
        pos,
        editor.value.length,
      );
      updateLineNumbers();
      updateHighlight();
      updateCursorPos();
      showToast("Formatted", { ic: "format" });
    } else {
      vimShowError("format: markdown files only");
    }
    return;
  }

  // :e <name> — open note by name (fuzzy match)
  const eMatch = trimmed.match(/^e\s+(.+)$/);
  if (eMatch) {
    const query = eMatch[1].toLowerCase();
    const match =
      state.notes.find((n) => n.name.toLowerCase() === query) ||
      state.notes.find((n) => n.name.toLowerCase().includes(query));
    if (match) switchNote(match.id);
    else vimShowError("No note matching: " + eMatch[1]);
    return;
  }

  if (trimmed) vimShowError("Not an editor command: " + trimmed);
}

vimCommandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const prefix = document.querySelector(".vim-command-prefix").textContent;
    const cmd = vimCommandInput.value;
    vimCloseCommandBar();
    if (prefix === "/" || prefix === "?") {
      // Vim search: populate find and jump to match
      if (cmd) {
        vimSearch(cmd, vimState.searchDirection);
        updateCursorPos();
      }
    } else {
      vimExecCommand(cmd);
    }
  }
  if (e.key === "Escape") {
    e.preventDefault();
    vimCloseCommandBar();
  }
});

// ── Vim keydown handler ──

function vimHandleKeydown(e) {
  if (!vimState.enabled) return;

  // Restore cursor from before any mouse click so vim commands
  // operate from the original position (mouse doesn't move cursor)
  if (_vimPreClickPos !== null) {
    editor.selectionStart = editor.selectionEnd = _vimPreClickPos;
    _vimPreClickPos = null;
  }

  // Don't intercept when a non-editor input is focused
  const active = document.activeElement;
  if (
    active &&
    active !== editor &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
  )
    return;

  // Let Ctrl/Cmd combos pass through (except Ctrl+R, Ctrl+D, Ctrl+U in normal)
  if (e.metaKey) return;
  if (e.ctrlKey && e.key !== "r" && e.key !== "d" && e.key !== "u") return;

  if (vimState.mode === "insert") {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      vimLeaveInsert();
      return;
    }
    // In insert mode, let all other keys pass through
    return;
  }

  // Normal and visual modes: prevent default for most keys
  if (vimState.mode === "normal") {
    // Ctrl+R = redo
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      redo();
      updateCursorPos();
      return;
    }
    // Ctrl+D / Ctrl+U = half-page scroll
    if (e.ctrlKey && (e.key === "d" || e.key === "u")) {
      e.preventDefault();
      const lineHeight = parseFloat(_editorCS.lineHeight) || 21;
      const pageLines = Math.floor(editor.clientHeight / lineHeight / 2);
      vimMoveLines(e.key === "d" ? 1 : -1, pageLines);
      return;
    }

    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      moveLines(e.key === "ArrowUp" ? -1 : 1);
      updateCursorPos();
      return;
    }

    // Let these keys pass through
    if (e.key === "Tab" || e.key === "Shift") return;
    if (e.key.startsWith("F") && e.key.length > 1) return;
    // Escape in normal mode: clear pending state, then let it bubble to close panels/sidebars
    if (e.key === "Escape") {
      vimState.keys = [];
      return;
    }

    // Map arrow keys to hjkl, dead keys and _ to ^
    const arrowMap = {
      ArrowLeft: "h",
      ArrowDown: "j",
      ArrowUp: "k",
      ArrowRight: "l",
    };
    let mappedKey = arrowMap[e.key] || e.key;
    // _ → ^ (first non-blank), standard vim alias
    if (e.key === "_") mappedKey = "^";

    e.preventDefault();
    e.stopPropagation();
    vimExecNormal(mappedKey);
    return;
  }

  if (vimState.mode === "visual") {
    if (e.key === "Tab" || e.key === "Shift") return;
    // Ctrl+D/U — half-page scroll in visual mode
    if (e.ctrlKey && (e.key === "d" || e.key === "u")) {
      e.preventDefault();
      e.stopPropagation();
      const lineHeight = parseFloat(_editorCS.lineHeight) || 21;
      const pageLines = Math.floor(editor.clientHeight / lineHeight / 2);
      vimMoveLines(e.key === "d" ? 1 : -1, pageLines);
      return;
    }
    const arrowMapV = {
      ArrowLeft: "h",
      ArrowDown: "j",
      ArrowUp: "k",
      ArrowRight: "l",
    };
    let mappedKeyV = arrowMapV[e.key] || e.key;
    if (e.key === "_") mappedKeyV = "^";
    e.preventDefault();
    e.stopPropagation();
    vimExecVisual(mappedKeyV);
    return;
  }
}

// ═══════════════════════════════════════════════════
//  Chrome: keys, menus, title bar, status bar, tooltip, toast
// ═══════════════════════════════════════════════════

const IS_MAC = /mac|iphone|ipad/i.test(
  navigator.userAgentData?.platform || navigator.platform || "",
);

// Keys are written the Mac way; elsewhere ⌘ and ⌃ read Ctrl, ⌥ reads Alt.
// "new" is the new-note key: Chrome on Windows never hands Ctrl+N to a page.
function keyLabel(k) {
  if (k === "new") return IS_MAC ? "⌃N" : "Alt+N";
  if (IS_MAC) return k;
  return k
    .replace(/[⌘⌃]/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⇧/g, "Shift+");
}

for (const el of document.querySelectorAll("[data-k]"))
  el.textContent = keyLabel(el.dataset.k);

// ── Menus ──────────────────────────────────────────

const appMenu = document.getElementById("appMenu");
const themeMenu = document.getElementById("themeMenu");
const newMenu = document.getElementById("newMenu");
const noteMenu = document.getElementById("noteMenu");
const syncMenu = document.getElementById("syncMenu");
const sharePop = document.getElementById("sharePop");
let menuScrim = null;

// Opens next to `anchor` (or at a point); clicking the same anchor closes it
function openMenu(menu, anchor, opts = {}) {
  const wasOpen = menu.classList.contains("visible") && menu._anchor === anchor;
  closeAllMenus(opts.keep);
  if (wasOpen && anchor) return;
  menu._anchor = anchor;
  anchor?.setAttribute("aria-expanded", "true");
  menu.classList.add("visible");
  if (isMobile() && !menuScrim) {
    menuScrim = document.createElement("div");
    menuScrim.className = "menu-scrim";
    menuScrim.addEventListener("click", () => closeAllMenus());
    document.body.appendChild(menuScrim);
  }
  placeMenu(menu, anchor, opts);
  if (opts.focus) menu.querySelector(".menu-item:not([hidden])")?.focus();
}

function placeMenu(menu, anchor, { at, side, alignRight } = {}) {
  if (isMobile()) return; // a sheet, placed by CSS
  menu.style.left = menu.style.top = "0px";
  const m = menu.getBoundingClientRect();
  const vw = innerWidth;
  const vh = innerHeight;
  let x;
  let y;
  if (at) {
    x = at.x;
    y = at.y;
  } else {
    const r = anchor.getBoundingClientRect();
    if (side) {
      x = r.right + 4 + m.width > vw ? r.left - m.width - 4 : r.right + 4;
      y = r.top - 4;
    } else {
      x = alignRight ? r.right - m.width : r.left;
      y = r.bottom + 4;
      if (y + m.height > vh - 8 && r.top - m.height - 4 > 8)
        y = r.top - m.height - 4;
    }
  }
  menu.style.left = Math.max(8, Math.min(x, vw - m.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, vh - m.height - 8)) + "px";
}

function closeAllMenus(keep) {
  for (const m of document.querySelectorAll(".menu.visible")) {
    if (m === keep) continue;
    m.classList.remove("visible");
    m._anchor?.setAttribute("aria-expanded", "false");
    m._anchor = null;
  }
  for (const el of document.querySelectorAll(".menu-item.open"))
    el.classList.remove("open");
  if (menuScrim && !keep) {
    menuScrim.remove();
    menuScrim = null;
  }
}

// Kept for code that closed the old menus by name
const closeFileMenu = () => closeAllMenus();
const closeSyncMenu = () => closeAllMenus();

function toggleAppMenu() {
  openMenu(appMenu, document.getElementById("btnAppMenu"), {
    focus: event?.detail === 0,
  });
}

function toggleNewMenu() {
  openMenu(newMenu, document.getElementById("btnNewMenu"), {
    alignRight: true,
  });
}

function toggleSyncMenu() {
  openMenu(syncMenu, document.getElementById("syncButton"));
}

function openThemeMenu() {
  const btn = document.getElementById("btnThemeMenu");
  if (themeMenu.classList.contains("visible")) return;
  btn.classList.add("open");
  themeMenu._anchor = null;
  themeMenu.classList.add("visible");
  if (isMobile()) appMenu.classList.remove("visible");
  placeMenu(themeMenu, btn, { side: true });
}

document.getElementById("btnThemeMenu").addEventListener("pointerenter", (e) => {
  if (e.pointerType === "mouse") openThemeMenu();
});
for (const item of appMenu.querySelectorAll(".menu-item:not(#btnThemeMenu)"))
  item.addEventListener("pointerenter", () => {
    themeMenu.classList.remove("visible");
    document.getElementById("btnThemeMenu").classList.remove("open");
  });

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".menu, [aria-haspopup], .menu-scrim")) closeAllMenus();
});

// Arrow keys walk the open menu; Esc closes it and returns to its button
document.addEventListener("keydown", (e) => {
  const menus = [...document.querySelectorAll(".menu.visible")];
  if (!menus.length) return;
  const menu = menus.find((m) => m.contains(document.activeElement)) || menus[0];
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const anchor = menu._anchor;
    closeAllMenus();
    anchor?.focus();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  if (menu === sharePop) return;
  const items = [...menu.querySelectorAll(".menu-item")].filter(
    (b) => b.offsetParent,
  );
  if (!items.length) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const i = items.indexOf(document.activeElement);
  const next =
    e.key === "ArrowDown"
      ? items[(i + 1) % items.length]
      : items[(i - 1 + items.length) % items.length];
  next.focus();
}, true);

editor.addEventListener("focus", () => closeAllMenus());
editor.addEventListener("focus", scheduleOccurrenceUpdate);
editor.addEventListener("blur", scheduleOccurrenceUpdate);

// The ⋯ menu: the title bar's, a row's, and right-click on a row
function openNoteMenu(note, anchor, at) {
  const md = isMarkdownFile(note.name);
  const draw = isDrawFile(note.name);
  const active = note === getActiveNote();
  const kind = noteKind(note.name);
  const item = (ic, label, act, key = "", cls = "") =>
    `<button class="menu-item ${cls}" role="menuitem" data-note-act="${act}">${icon(ic)}<span class="label">${label}</span>${key ? `<span class="kbd">${keyLabel(key)}</span>` : ""}</button>`;
  const sep = '<div class="menu-sep"></div>';
  noteMenu.innerHTML =
    `<div class="menu-title">${icon(kind.icon, "kind " + kind.cls)}<span>${nameHtml(note.name)}</span></div>` +
    (sharedNote && active
      ? ""
      : item("pencil", "Rename", "rename", "F2") +
        item(note.pinned ? "pin-on" : "pin", note.pinned ? "Unpin" : "Pin", "pin") +
        sep) +
    item("link", "Copy link", "copy-link") +
    (draw ? item("image", "Copy as PNG", "png") : "") +
    item("download", "Download", "download") +
    (md ? item("download", "Download as HTML", "html") : "") +
    (draw ? item("download", "Download as SVG", "svg") : "") +
    (md ? sep + item("format", "Format markdown", "format", "⌥⇧F") : "") +
    (isMobile() && active && hasViewTab(note.name)
      ? sep + item("zen", "Zen", "zen")
      : "") +
    (isMobile() && active && !draw
      ? item(
          "wrap",
          editorArea.classList.contains("wrap")
            ? "Word wrap: on"
            : "Word wrap: off",
          "wrap",
        )
      : "") +
    (sharedNote && active
      ? ""
      : sep + item("trash", "Delete", "delete", "⌘⇧D", "danger"));
  noteMenu.onclick = (e) => {
    const b = e.target.closest("[data-note-act]");
    if (!b) return;
    closeAllMenus();
    runNoteAction(note, b.dataset.noteAct, anchor);
  };
  openMenu(noteMenu, anchor, {
    at,
    alignRight: anchor === btnNoteMenu,
    focus: event?.detail === 0,
  });
}

function toggleNoteMenu() {
  const note = getActiveNote();
  if (note) openNoteMenu(note, btnNoteMenu);
}

function runNoteAction(note, act, anchor) {
  const fromRow = anchor && anchor.closest?.(".note-list");
  switch (act) {
    case "rename":
      if (note === getActiveNote() && !fromRow) renameInTitle();
      else startRename(note.id);
      break;
    case "pin":
      return togglePin(note.id);
    case "copy-link":
      return copyLink(note);
    case "png":
      return drawCopyPng(note);
    case "download":
      return downloadNote(note);
    case "html":
      return downloadHtml(note);
    case "svg":
      return drawDownloadSvg(note);
    case "format":
      return formatNote(note);
    case "zen":
      return switchMdTab("zen", true);
    case "wrap":
      return toggleWrap();
    case "delete":
      return deleteNote(note.id);
  }
}

// ── Title bar ──────────────────────────────────────

function noteState(note) {
  if (sharedNote)
    return {
      label: sharedClash() ? "Shared version" : "Shared · not saved",
      detail: "Opened from a link — not in your notes yet",
    };
  if (vimState.enabled && vimState.bufferDirty)
    return { label: "Edited", detail: "Vim buffer not written yet — :w to save" };
  const at = new Date(note.updatedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  // These three repeat the sidebar footer: shown only while it is hidden
  if (gdriveConnected && syncDotCount > 0)
    return { label: "Syncing…", detail: "Saving to Google Drive", sync: true };
  if (gdriveConnected && !syncFailedState)
    return { label: "Synced", detail: "In this browser and Google Drive", sync: true };
  return { label: "Saved", detail: "In this browser at " + at, sync: true };
}

let titleBarKey = "";
function updateTitleBar() {
  const note = getActiveNote();
  const st = note ? noteState(note) : null;
  const key = note ? note.name + "\n" + st.label + "\n" + st.detail : "";
  btnShare.disabled = !note;
  btnNoteMenu.disabled = !note;
  if (key === titleBarKey) return;
  titleBarKey = key;
  crumb.style.visibility = note ? "" : "hidden";
  if (!note) return;
  crumbName.innerHTML = nameHtml(note.name);
  crumbState.textContent = st.label;
  crumbState.classList.toggle("sync-state", !!st.sync);
  crumbBtn.dataset.tip = st.label;
  crumbBtn.dataset.sub = st.detail;
}

// ── Status bar ─────────────────────────────────────

const LANG_NAMES = {
  md: "Markdown",
  markdown: "Markdown",
  draw: "Drawing",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  svg: "SVG",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  fish: "Shell",
  sql: "SQL",
  txt: "Plain text",
  "": "Plain text",
};

function langName(name) {
  const ext = getExtension(name);
  return LANG_NAMES[ext] ?? ext.toUpperCase();
}

// What the bar shows changes with the view; the bar itself never jumps
function updateStatusBar() {
  const note = getActiveNote();
  const editing = !!note && !mdViewActive;
  statusLang.textContent = note ? langName(note.name) : "";
  btnWrap.hidden = !editing;
  btnVim.hidden = !editing;
  statusSel.hidden = !editing;
  statusHint.textContent = "";
  if (!note || editing) return updateCursorPos();
  if (isDrawFile(note.name)) {
    cursorPos.textContent = "";
    return;
  }
  const words = (note.content.match(/[\p{L}\p{N}]+/gu) || []).length;
  cursorPos.textContent =
    words.toLocaleString() +
    (words === 1 ? " word" : " words") +
    " · " +
    Math.max(1, Math.round(words / 230)) +
    " min read";
  if (!zenModeActive)
    statusHint.innerHTML = 'Press <span class="hint-key">E</span> to edit';
}

function updateVimStatus() {
  btnVim.setAttribute("aria-pressed", vimState.enabled);
  vimPill.textContent = vimState.enabled
    ? vimState.mode.toUpperCase() + (vimState.bufferDirty ? " +" : "")
    : "";
  vimPill.className = "vim-pill " + vimState.mode;
  updateTitleBar();
  updateKeybar();
}

// Tapping the status bar must not move focus. Blurring the editor closes
// the mobile keyboard, the page grows into its space, and the click then
// lands on the editor (keyboard back up) instead of the button. Keeping
// focus where it is leaves the keyboard as it was and the layout still.
for (const bar of [statusbar, document.getElementById("keybar")])
  bar.addEventListener("mousedown", (e) => e.preventDefault());

// ── Tooltip ────────────────────────────────────────
// Icon buttons, short states and disabled reasons: data-tip, data-key, data-sub

const tip = document.getElementById("tip");
let tipTimer = null;
let tipFor = null;
let tipHiddenAt = 0;

function showTip(el, text) {
  const label = text ?? el.dataset.tip;
  if (!label || !el.isConnected) return;
  tip.innerHTML =
    el.dataset.sub && !text
      ? `<b>${escapeHtml(label)}</b><span class="sub">${escapeHtml(el.dataset.sub)}</span>`
      : escapeHtml(label) +
        (el.dataset.key && !text
          ? `<span class="kbd">${escapeHtml(keyLabel(el.dataset.key))}</span>`
          : "");
  tip.classList.add("visible");
  tipFor = el;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let y = r.bottom + 6;
  if (y + t.height > innerHeight - 4) y = r.top - t.height - 6;
  const x = r.left + r.width / 2 - t.width / 2;
  tip.style.left = Math.max(4, Math.min(x, innerWidth - t.width - 4)) + "px";
  tip.style.top = y + "px";
}

function hideTip() {
  clearTimeout(tipTimer);
  if (tip.classList.contains("visible")) tipHiddenAt = Date.now();
  tip.classList.remove("visible");
  tipFor = null;
}

document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const el = e.target.closest("[data-tip]");
  if (el === tipFor) return;
  hideTip();
  if (!el) return;
  tipFor = el;
  // Moving between neighbours shows the next one at once
  tipTimer = setTimeout(
    () => showTip(el),
    Date.now() - tipHiddenAt < 400 ? 0 : 500,
  );
});
document.addEventListener("pointerdown", hideTip, true);
document.addEventListener("keydown", hideTip, true);
document.addEventListener("scroll", hideTip, true);

// ── Toast ──────────────────────────────────────────
// Something happened: bottom centre, one at a time, an optional action

let toastTimer = null;
let toastUndo = null;

function showToast(msg, opts = {}) {
  const { action, onAction, ic, error, undo } = opts;
  mdToast.className = "toast visible" + (error ? " error" : "");
  mdToast.innerHTML =
    (error ? icon("alert") : ic ? icon(ic) : "") +
    '<span class="toast-msg"></span><button class="toast-act" hidden></button>';
  mdToast.querySelector(".toast-msg").textContent = msg;
  const act = mdToast.querySelector(".toast-act");
  toastUndo = undo ? onAction : null;
  if (action) {
    act.hidden = false;
    act.textContent = action;
    act.onclick = () => {
      hideToast();
      onAction();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 10000 : 4000);
}

function hideToast() {
  clearTimeout(toastTimer);
  mdToast.classList.remove("visible");
  toastUndo = null;
}

const showMdToast = (msg) => showToast(msg);

// ── Sidebar ────────────────────────────────────────

function closeSidebar() {
  sidebar.classList.remove("open");
  document.querySelector(".app").classList.remove("sidebar-open");
}

// ── Share ──────────────────────────────────────────

let shareMode = "edit";

async function openShare(anchor = btnShare) {
  const note = getActiveNote();
  if (!note) return;
  if (sharePop.classList.contains("visible")) return closeAllMenus();
  const url = await shareLink(note, shareMode);
  const kb = (n) => Math.max(1, Math.round(n / 1000)) + " kB";
  const fits = url.length <= URL_MAX_LENGTH;
  const pct = Math.min(100, (url.length / URL_MAX_LENGTH) * 100);
  const draw = isDrawFile(note.name);
  sharePop.innerHTML =
    `<h4>Share ${nameHtml(note.name)}</h4>` +
    (fits
      ? `<div class="seg"><button data-mode="edit" aria-pressed="${shareMode === "edit"}">Editable</button><button data-mode="zen" aria-pressed="${shareMode === "zen"}">${icon("lock", "sm")}Read-only</button></div>` +
        `<p class="hint">${shareMode === "zen" ? "Opens in zen. They can still save a copy." : "They get their own copy to edit."}</p>` +
        `<label class="field mono"><input readonly aria-label="Link" /></label>`
      : `<p>This note is too large for a link: ${kb(url.length)}, the limit is ${kb(URL_MAX_LENGTH)}.</p>`) +
    `<div class="share-size"><span>Link size</span><span>${kb(url.length)} of ${kb(URL_MAX_LENGTH)}</span></div>` +
    `<div class="meter${fits ? "" : " critical"}"><i style="width:${pct}%"></i></div>` +
    (fits
      ? `<button class="btn primary" data-share="copy">${icon("link", "sm")}Copy link</button><p class="hint">The note lives in the link. Nothing is uploaded; anyone with it can read it.</p>`
      : `<div class="share-row"><button class="btn" data-share="download">${icon("download", "sm")}Download</button>${draw ? `<button class="btn" data-share="png">${icon("image", "sm")}Copy as PNG</button>` : ""}</div>`);
  const input = sharePop.querySelector("input");
  if (input) input.value = url;
  sharePop.onclick = async (e) => {
    const mode = e.target.closest("[data-mode]")?.dataset.mode;
    if (mode && mode !== shareMode) {
      shareMode = mode;
      closeAllMenus();
      return openShare(anchor);
    }
    const act = e.target.closest("[data-share]")?.dataset.share;
    if (!act) return;
    closeAllMenus();
    if (act === "copy") copyLink(note);
    if (act === "download") downloadNote(note);
    if (act === "png") drawCopyPng(note);
  };
  openMenu(sharePop, anchor, { alignRight: true });
  sharePop.querySelector("[data-share]")?.focus();
}

// ── Banner: a state of this note that lasts until you act ──

function setBanner(kind, ic, html, actions = []) {
  if (!kind) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  banner.hidden = false;
  banner.className = "banner" + (kind === "warning" ? " warning" : "");
  banner.innerHTML =
    icon(ic) +
    `<span class="banner-text">${html}</span><span class="banner-acts"></span>`;
  const acts = banner.querySelector(".banner-acts");
  for (const [label, fn, cls = ""] of actions) {
    const b = document.createElement("button");
    b.className = "btn sm " + cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    acts.appendChild(b);
  }
}

// ── Phone key bar: keys a phone keyboard doesn't have ──

const keybar = document.getElementById("keybar");
const touchOnly = matchMedia("(pointer: coarse)");

function updateKeybar() {
  document.body.classList.toggle(
    "keybar-on",
    touchOnly.matches &&
      document.activeElement === editor &&
      !mdViewActive &&
      !(vimState.enabled && vimState.mode !== "insert"),
  );
}
editor.addEventListener("focus", updateKeybar);
editor.addEventListener("blur", () =>
  setTimeout(() => {
    if (document.activeElement !== editor) updateKeybar();
  }, 0),
);

keybar.addEventListener("click", (e) => {
  const b = e.target.closest("[data-key-action]");
  if (!b) return;
  const act = b.dataset.keyAction;
  if (act === "indent" || act === "outdent") indentAtCursor(act === "outdent");
  else if (act === "task") toggleTaskMarker();
  else if (act === "insert") insertAtCursor(b.dataset.text);
  else if (act === "undo") undo();
  else if (act === "redo") redo();
  else if (act === "find") openFindReplace();
});

function insertAtCursor(text) {
  const s = editor.selectionStart;
  editor.setRangeText(text, s, editor.selectionEnd, "end");
  // Pairs land with the cursor between them
  if (text === "[]") editor.setSelectionRange(s + 1, s + 1);
  editor.dispatchEvent(new Event("input"));
}

// A plain line becomes a task; a list item gets a checkbox
function toggleTaskMarker() {
  const val = editor.value;
  const pos = editor.selectionStart;
  const start = val.lastIndexOf("\n", pos - 1) + 1;
  const nl = val.indexOf("\n", start);
  const line = val.slice(start, nl === -1 ? val.length : nl);
  const m = line.match(LIST_RE);
  if (m && m[6]) return;
  const at = m ? start + m[0].length : start + line.match(/^\s*/)[0].length;
  const text = m ? "[ ] " : "- [ ] ";
  editor.setRangeText(text, at, at);
  editor.setSelectionRange(pos + text.length, pos + text.length);
  editor.dispatchEvent(new Event("input"));
}

// ── Settings: every setting in one place; the quick toggles stay where used ──

function formatOnSave() {
  return localStorage.getItem(FORMAT_ON_SAVE_KEY) !== "false";
}

function openSettings(section) {
  if (typeof section !== "string") section = actionEl?.dataset.section;
  const sw = (on) => `<span class="switch" aria-checked="${!!on}"></span>`;
  const row = (set, ic, title, small, end) =>
    `<button class="set-row" data-set="${set}">${ic ? icon(ic) : ""}<span class="set-text">${title}<small>${small}</small></span>${end}</button>`;
  const chosen = localStorage.getItem(THEME_KEY) || THEMES[0];
  const card = (t) =>
    `<button class="theme-card" data-set="theme" data-value="${t}" data-theme="${t}" aria-checked="${t === chosen}"><span class="pv"><span><i style="background:var(--blue)"></i><i style="background:var(--overlay)"></i></span><span><i style="background:var(--mauve);width:50%"></i><i style="background:var(--text);width:80%"></i><i style="background:var(--green);width:60%"></i></span></span>${THEME_LABELS[t]}</button>`;
  const bytes = getStorageUsed();
  const limit = idb ? storageQuota : STORAGE_LIMIT;
  const pct = limit ? Math.min((bytes / limit) * 100, 100) : 0;
  const largest = [...state.notes]
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, 3)
    .map((n) => escapeHtml(n.name) + " " + formatSize(n.content))
    .join(" · ");
  const drive = gdriveConnected
    ? `<div class="set-row">${icon("cloud")}<span class="set-text">Google Drive<small>${syncFailedState ? "Sync paused" : lastSyncAt ? "Synced " + relativeTime(lastSyncAt) : "Connected"} · in Drive's hidden app folder</small></span><button class="btn sm" data-set="sync">${syncFailedState ? "Reconnect" : "Sync now"}</button><button class="btn ghost sm" data-set="disconnect">Disconnect</button></div>`
    : `<div class="set-row">${icon("cloud")}<span class="set-text">Google Drive<small>Keep notes in sync across devices, in Drive's hidden app folder</small></span><button class="btn sm" data-set="sync">Connect…</button></div>`;
  const sections = [
    ["appearance", "contrast", "Appearance"],
    ["editor", "code", "Editor"],
    ["sync", "cloud", "Sync and backup"],
    ["storage", "archive", "Storage"],
    ["shortcuts", "keyboard", "Shortcuts"],
  ];
  const keys = [
    ["Search notes and lines", "⌘P"],
    ["All commands", "⌘⇧P"],
    ...paletteCommands()
      .filter((c) => c[2])
      .map((c) => [c[2] === "⌘E" ? "Edit ⇄ Preview" : c[1], c[2]]),
    ["Undo · redo", "⌘Z · ⌘⇧Z"],
    ["Move line up · down", "⌥↑ · ⌥↓"],
    ["Close the topmost layer", "Esc"],
  ];
  const panel = (id, title, body) =>
    `<section class="set-panel" id="set-${id}"><h3 class="set-panel-title">${title}</h3>${body}</section>`;
  const dlg = openDialog(
    `<nav class="set-nav" aria-label="Settings sections"><h2>Settings</h2>` +
      sections
        .map(
          ([id, ic, label]) =>
            `<button class="set-nav-item" data-set="section" data-section="${id}">${icon(ic)}${label}</button>`,
        )
        .join("") +
      `</nav>` +
      `<div class="settings-head"><h2>Settings</h2></div>` +
      `<button class="btn ghost square set-close" data-set="close" aria-label="Close">${icon("x")}</button>` +
      `<div class="set-main">` +
      panel(
        "appearance",
        "Appearance",
        `<div class="set-group"><h4>Theme</h4>` +
          row("system", "", "Match system", "Latte by day, your dark theme by night", sw(followsSystem())) +
          `</div><div class="set-group"><h4>Dark</h4><div class="themes">${THEMES.filter((t) => t !== "latte").map(card).join("")}</div></div>` +
          `<div class="set-group"><h4>Light</h4><div class="themes">${card("latte")}</div></div>`,
      ) +
      panel(
        "editor",
        "Editor",
        `<div class="set-group">` +
          row("wrap", "", "Wrap long lines", "Also in the status bar", sw(editorArea.classList.contains("wrap"))) +
          (touchOnly.matches ? "" : row("vim", "", "Vim keys", keyLabel("⌃⇧M"), sw(vimState.enabled))) +
          row("format", "", "Format markdown on save", "Headings, lists and tables, on " + keyLabel("⌘S"), sw(formatOnSave())) +
          `</div>`,
      ) +
      panel(
        "sync",
        "Sync and backup",
        `<div class="set-group">${drive}` +
          `<div class="set-row">${icon("archive")}<span class="set-text">Export all as ZIP<small>Every note, drawings as SVG too, re-importable</small></span><button class="btn sm" data-set="export">Export</button></div>` +
          `<div class="set-row">${icon("import")}<span class="set-text">Import files<small>Text files or a ZIP from Export</small></span><button class="btn sm" data-set="import">Choose…</button></div></div>` +
          `<p class="settings-note">Notes never pass through note.directory's server. Sign-in uses a small worker that only holds Google's token.</p>`,
      ) +
      panel(
        "storage",
        "Storage",
        `<div class="set-group"><div class="storage"><div><span>Browser storage</span><span>${sizeLabel(bytes)}${limit ? " of " + sizeLabel(limit) : ""}</span></div><div class="meter${pct >= 90 ? " critical" : pct >= 70 ? " warn" : ""}"><i style="width:${pct}%"></i></div></div>` +
          (largest ? `<div class="set-row"><span class="set-text">Largest notes<small>${largest}</small></span></div>` : "") +
          `<div class="set-row"><span class="set-text">Browsers may clear storage without warning<small>Turn on Google Drive or export now and then</small></span></div></div>`,
      ) +
      panel(
        "shortcuts",
        "Shortcuts",
        `<div class="set-group set-keys">` +
          keys
            .map(
              ([label, key]) =>
                `<div class="set-row"><span class="set-text">${escapeHtml(label)}</span><span class="kbd boxed">${escapeHtml(key.split(" · ").map(keyLabel).join(" · "))}</span></div>`,
            )
            .join("") +
          `</div>`,
      ) +
      `</div>`,
    (e, close) => {
      const b = e.target.closest("[data-set]");
      if (!b) return;
      const set = b.dataset.set;
      if (set === "close") return close();
      if (set === "section") return showSection(b.dataset.section);
      if (set === "export") return downloadAll();
      if (set === "import") {
        close();
        return openImport();
      }
      if (set === "sync") {
        close();
        return driveSync();
      }
      if (set === "disconnect") {
        close();
        return driveSignOut();
      }
      if (set === "theme") setTheme(b.dataset.value);
      if (set === "system") toggleSystemTheme();
      if (set === "wrap") toggleWrap();
      if (set === "vim") toggleVim();
      if (set === "format")
        localStorage.setItem(FORMAT_ON_SAVE_KEY, !formatOnSave());
      // Repaint the switches and cards in place
      const now = localStorage.getItem(THEME_KEY) || THEMES[0];
      for (const c of dlg.querySelectorAll(".theme-card"))
        c.setAttribute("aria-checked", c.dataset.value === now);
      const state = {
        system: followsSystem(),
        wrap: editorArea.classList.contains("wrap"),
        vim: vimState.enabled,
        format: formatOnSave(),
      };
      for (const [k, v] of Object.entries(state))
        dlg
          .querySelector(`[data-set=${k}] .switch`)
          ?.setAttribute("aria-checked", v);
    },
    () => {},
    "settings",
  );
  // Desktop shows one section beside the nav; phones scroll through all
  function showSection(id) {
    for (const p of dlg.querySelectorAll(".set-panel"))
      p.classList.toggle("active", p.id === "set-" + id);
    for (const n of dlg.querySelectorAll(".set-nav-item"))
      n.setAttribute("aria-selected", n.dataset.section === id);
    if (isMobile() && id !== "appearance")
      dlg.querySelector("#set-" + id)?.scrollIntoView();
  }
  showSection(section || "appearance");
  dlg.querySelector(".set-nav-item[aria-selected=true]")?.focus();
}

// ⌥⇧F, ⋯ › Format markdown, :fmt
function formatNote(note = getActiveNote()) {
  if (!note) return;
  if (!isMarkdownFile(note.name))
    return showToast("Format works on markdown notes", { error: true });
  if (note !== getActiveNote()) {
    pushHistory(note.id, note.content);
    note.content = formatMarkdown(note.content);
    note.updatedAt = Date.now();
    saveState();
    return showToast("Formatted " + note.name, { ic: "format" });
  }
  const pos = editor.selectionStart;
  pushHistory(note.id, editor.value);
  editor.value = formatMarkdown(editor.value);
  if (vimState.enabled) {
    vimState.bufferDirty = true;
    saveSwap(note.id, editor.value);
  } else {
    note.content = editor.value;
    note.updatedAt = Date.now();
    scheduleSave();
  }
  editor.selectionStart = editor.selectionEnd = Math.min(
    pos,
    editor.value.length,
  );
  updateLineNumbers();
  updateHighlight();
  updateCursorPos();
  if (mdViewActive) switchMdTab("view");
  showToast("Formatted", { ic: "format" });
}

// ⌘E: Edit ⇄ Preview, Canvas ⇄ Source
function toggleView() {
  const note = getActiveNote();
  if (!note || !hasViewTab(note.name) || zenModeActive) return;
  switchMdTab(mdViewActive ? "edit" : "view", true);
}

// Zen's top line and buttons fade while you read and come back when the
// pointer moves. Faded chrome takes no clicks, so a tap only wakes it
let zenFadeTimer = null;
function wakeZenBar() {
  const chrome = [
    document.getElementById("zenBar"),
    document.getElementById("zenActions"),
  ];
  chrome.forEach((el) => el.classList.remove("faded"));
  clearTimeout(zenFadeTimer);
  zenFadeTimer = setTimeout(() => {
    if (!zenModeActive) return;
    if (chrome.some((el) => el.matches(":hover, :has(:focus-visible)"))) return;
    chrome.forEach((el) => el.classList.add("faded"));
  }, 2000);
}
document.addEventListener("pointermove", () => {
  if (zenModeActive) wakeZenBar();
});
document.addEventListener("pointerdown", () => {
  if (zenModeActive) wakeZenBar();
});
document.addEventListener("focusin", () => {
  if (zenModeActive) wakeZenBar();
});

// ═══════════════════════════════════════════════════
//  Sharing & Download
// ═══════════════════════════════════════════════════

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function downloadNote(note = getActiveNote()) {
  if (!note) return;
  triggerDownload(new Blob([note.content], { type: "text/plain" }), note.name);
}

// Drawing as an image: the clipboard gets a PNG, the download an SVG
function drawCopyPng(note = getActiveNote()) {
  if (!note || !isDrawFile(note.name)) return;
  const png = loadDraw().then(() => Draw.pngBlob(note.content));
  // Safari needs the clipboard write to start inside the click
  navigator.clipboard
    .write([new ClipboardItem({ "image/png": png })])
    .then(() => showToast("Copied as PNG", { ic: "check" }))
    .catch(async () => {
      try {
        triggerDownload(await png, note.name.replace(/\.draw$/i, "") + ".png");
        showToast("Couldn't copy as PNG — downloaded instead", { error: true });
      } catch {
        showToast("Couldn't make a PNG of this drawing", { error: true });
      }
    });
}

async function drawDownloadSvg(note = getActiveNote()) {
  if (!note || !isDrawFile(note.name)) return;
  await loadDraw();
  triggerDownload(
    new Blob([await Draw.svgString(note.content)], { type: "image/svg+xml" }),
    note.name.replace(/\.draw$/i, "") + ".svg",
  );
}

// Standalone HTML of a markdown note as zen shows it. No scripts: a strict
// CSP inside the file keeps it inert wherever it is opened.
async function noteHtml(note) {
  const doc = document.createElement("div");
  doc.innerHTML = renderMarkdown(note.content);
  const embeds = doc.querySelectorAll(".draw-embed");
  // Fonts go in as data URLs: code is in Victor Mono, drawings use their own
  const fonts = new Set(doc.querySelector("code, pre") ? ["mono"] : []);
  let fontCss = "";
  if (embeds.length || fonts.size) {
    try {
      await loadDraw();
      await Draw.fontsReady();
      for (const el of embeds) {
        const ref =
          el.dataset.ref && state.notes.find((n) => n.name === el.dataset.ref);
        if (el.dataset.ref && !ref) continue;
        const content = ref ? ref.content : el.dataset.draw;
        el.replaceChildren(Draw.renderStatic(content));
        for (const f of Draw.usedFonts(content)) fonts.add(f);
      }
      fontCss = await Draw.fontFaces(fonts);
    } catch {}
  }
  for (const el of doc.querySelectorAll(".draw-embed")) {
    el.removeAttribute("data-draw");
    el.removeAttribute("data-ref");
  }
  for (const btn of doc.querySelectorAll(".code-copy-btn")) btn.remove();
  // Without the app's click handler, a label makes the whole line toggle
  doc.querySelectorAll("li.task-item > input").forEach((box, i) => {
    const span = box.nextElementSibling;
    if (span?.tagName !== "SPAN") return;
    const label = document.createElement("label");
    label.htmlFor = box.id = "task-" + i;
    label.append(...span.childNodes);
    span.replaceWith(label);
  });
  // Links to other notes have nowhere to go outside the app
  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^(https?:|mailto:|#)/i.test(href)) continue;
    const span = document.createElement("span");
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
  // The page's own rules for the preview, so the file looks like zen
  const wanted = /md-preview|zen-wrap|zen-mode|draw-embed|\.hl-|:root|data-theme=/;
  const css = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules)
      if (wanted.test(rule.cssText)) css.push(rule.cssText);
  }
  const title = escapeHtml(note.name);
  return `<!doctype html>
<html lang="en" data-theme="${currentTheme()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${title}</title>
<style>
body { margin: 0; background: var(--bg); color: var(--text); }
${fontCss}
${css.join("\n")}
.md-preview { overflow: visible; }
</style>
</head>
<body>
<div class="zen-mode"><div class="md-preview visible"><div class="zen-wrap">
${doc.innerHTML}
</div></div></div>
</body>
</html>
`;
}

async function downloadHtml(note) {
  if (!note || !isMarkdownFile(note.name)) return;
  const html = await noteHtml(note);
  triggerDownload(
    new Blob([html], { type: "text/html" }),
    note.name.replace(/\.(md|markdown)$/i, "") + ".html",
  );
}

// Zen's download: the note as it is shown (HTML for markdown, SVG for drawings)
async function zenDownload() {
  const note =
    zenFromUrl && zenEphemeralNote ? zenEphemeralNote : getActiveNote();
  if (!note) return;
  if (isMarkdownFile(note.name)) return downloadHtml(note);
  if (isDrawFile(note.name)) {
    await loadDraw();
    return triggerDownload(
      new Blob([await Draw.svgString(note.content)], { type: "image/svg+xml" }),
      note.name.replace(/\.draw$/i, "") + ".svg",
    );
  }
  downloadNote();
}

async function downloadAll() {
  if (!state.notes.length) return;
  const files = state.notes.map((n) => ({
    name: n.name,
    content: n.content,
  }));
  // Drawings also go in as images, readable without the app
  const renders = [];
  const drawings = state.notes.filter((n) => isDrawFile(n.name) && n.content);
  if (drawings.length) {
    try {
      await loadDraw();
      for (const n of drawings) {
        // The importer flattens folders, so renders sit next to the notes
        const name = n.name + ".svg";
        if (state.notes.some((o) => o.name === name)) continue;
        if (renders.includes(name)) continue;
        renders.push(name);
        files.push({ name, content: await Draw.svgString(n.content) });
      }
    } catch {}
  }
  const directory = {
    notes: state.notes.map((n) => ({
      id: n.id,
      name: n.name,
      updatedAt: n.updatedAt,
    })),
    renders,
  };
  files.push({
    name: ".note.directory",
    content: JSON.stringify(directory, null, 2),
  });
  const zip = await buildZip(files);
  triggerDownload(new Blob([zip], { type: "application/zip" }), "notes.zip");
}

// Share link for a note, built from its content (never from location,
// which may still show the previous note). Read-only links open in zen.
// May be longer than URL_MAX_LENGTH — Share says so instead of hiding.
async function shareLink(note, mode = "edit") {
  const view = mode === "zen" ? "zen" : viewQuery() === "zen" ? "" : viewQuery();
  const query = view ? "?view=" + view : "";
  const hashMap = new Map([
    ["name", note.name],
    ["note", await compress(note.content)],
    ["ts", String(note.updatedAt || Date.now())],
  ]);
  return location.origin + location.pathname + query + buildHash(hashMap);
}

async function shareUrlFor(note) {
  const url = await shareLink(note, shareMode);
  return url.length > URL_MAX_LENGTH ? null : url;
}

async function copyLink(note = getActiveNote()) {
  if (!note) return;
  const url = await shareUrlFor(note);
  if (!url) return openShare();
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied", { ic: "check" });
  } catch {
    showToast("Couldn't copy the link", { error: true });
  }
}

// text= runs to the end of the link, so an unencoded & or # in the content
// can't cut it short
function plainTextParam(hash) {
  const m = /(?:^#|&)text=/.exec(hash || "");
  if (!m) return null;
  const raw = hash.slice(m.index + m[0].length);
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {}
  // Other params only count before text=, not inside the content
  return { text, params: parseHashParams(hash.slice(0, m.index)) };
}

async function loadFromUrl() {
  const queryParams = new URLSearchParams(location.search);
  const hashMap = parseHashParams(location.hash);
  const viewParam = queryParams.get("view");

  // New format: name/note in hash
  let noteData = hashMap.get("note");
  let name = hashMap.get("name") || "shared note";
  let fromOldFormat = false;

  // Backward compat: fall back to query params
  if (!noteData) {
    noteData = queryParams.get("note");
    name = queryParams.get("name") || "shared note";
    fromOldFormat = !!noteData;
  }

  // Uncompressed links, easy to write by hand or by an LLM:
  // #name=x.md&text=<URI-encoded content>, text last
  const plain = noteData ? null : plainTextParam(location.hash);
  if (plain !== null) {
    name = plain.params.get("name") || "shared note";
    // Saved notes get the usual compressed URL; zen views stay as opened
    fromOldFormat = viewParam !== "zen";
  }

  if (!noteData && plain === null) return false;
  try {
    const content = plain ? plain.text : await decompress(noteData);

    const urlTs = Number(hashMap.get("ts")) || 0;
    const existing = state.notes.find((n) => n.name === name);

    // Zen mode from URL: don't persist, store ephemerally — unless it is
    // one of your notes (same content, or the URL is an older snapshot)
    if (viewParam === "zen") {
      if (
        existing &&
        (existing.content === content ||
          (urlTs && existing.updatedAt >= urlTs))
      ) {
        sharedNote = null;
        state.activeId = existing.id;
        saveState();
        return true;
      }
      zenFromUrl = true;
      zenEphemeralNote = { name, content };
      if (fromOldFormat) await updateUrl();
      return true;
    }

    if (existing) {
      if (existing.content === content) {
        sharedNote = null;
        state.activeId = existing.id;
        saveState();
        if (fromOldFormat) await updateUrl();
        return true;
      }
      // URL is stale (older than local) — prefer local state silently.
      // Why: updateUrl() is async and may not complete before the tab
      // closes, so on reopen the URL can contain a pre-save snapshot.
      if (urlTs && existing.updatedAt >= urlTs) {
        sharedNote = null;
        state.activeId = existing.id;
        saveState();
        return true;
      }
    }
    // Shown, not saved: the list only changes when the user says so
    openShared(name, content, urlTs, existing);
    if (fromOldFormat) await updateUrl();
    return true;
  } catch (err) {
    console.error("Failed to load shared note:", err);
    return false;
  }
}

// ═══════════════════════════════════════════════════
//  Drag & Drop
// ═══════════════════════════════════════════════════

const TEXT_EXTS = new Set(
  "txt md markdown draw json jsonl json5 js jsx ts tsx mjs cjs mts cts css scss sass less html htm xml xsl xslt csv tsv yaml yml toml ini cfg conf sh bash zsh fish ps1 bat cmd py pyi pyw rb rake gemspec go rs java scala kt kts groovy gradle c h cpp hpp cc cxx hxx cs fs fsx swift m mm r jl lua pl pm php phtml ex exs erl hrl hs lhs clj cljs cljc edn lisp cl el rkt ml mli v sv vhd vhdl sql graphql gql proto thrift avsc tf hcl nix dhall dart zig nim cr d pas pp asm s wasm wat sol vy move cairo log env properties lock sum mod cmake make mk svg plist strings resx pot po rst adoc asciidoc tex bib sty cls org wiki textile diff patch gitignore gitattributes gitmodules dockerignore npmignore eslintignore prettierignore editorconfig prettierrc eslintrc babelrc browserslistrc stylelintrc huskyrc lintstagedrc nvmrc".split(
    " ",
  ),
);

const TEXT_NAMES = new Set(
  "dockerfile containerfile vagrantfile rakefile gemfile podfile".split(" "),
);

const TEXT_SUFFIXES =
  ".node-version .ruby-version .python-version .tool-versions .env.local .env.example".split(
    " ",
  );

function isTextFilename(name) {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && TEXT_EXTS.has(lower.slice(dot + 1))) return true;
  if (TEXT_NAMES.has(lower)) return true;
  return TEXT_SUFFIXES.some((s) => lower.endsWith(s));
}

let dragCounter = 0;

document.addEventListener("dragenter", (e) => {
  if (zenModeActive) return;
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) dropOverlay.classList.add("visible");
  }
});

document.addEventListener("dragover", (e) => e.preventDefault());

document.addEventListener("dragleave", () => {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove("visible");
  }
});

// A note export (or any zip): its text entries, with ids and dates when the
// export's .note.directory has them
async function readZipEntries(file) {
  const arrayBuffer = await file.arrayBuffer();
  const header = new Uint8Array(arrayBuffer, 0, 4);
  if (
    header[0] !== 0x50 ||
    header[1] !== 0x4b ||
    header[2] !== 0x03 ||
    header[3] !== 0x04
  )
    return { error: "not a zip file" };
  let entries;
  try {
    entries = await readZip(arrayBuffer);
  } catch (e) {
    return { error: "couldn't read it: " + e.message };
  }

  const dirEntry = entries.find((e) => e.name === ".note.directory");
  let metadata = null;
  if (dirEntry) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(dirEntry.data));
      if (
        parsed &&
        Array.isArray(parsed.notes) &&
        parsed.notes.every(
          (n) =>
            typeof n.id === "string" &&
            typeof n.name === "string" &&
            typeof n.updatedAt === "number",
        )
      ) {
        metadata = parsed;
      }
    } catch (e) {
      // Invalid metadata — treat as plain zip
    }
  }

  // Images rendered from drawings at export are not notes
  const renders = new Set(
    Array.isArray(metadata?.renders) ? metadata.renders : [],
  );
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".note.directory" || renders.has(entry.name)) continue;
    // Strip control characters, limit length
    let name = entry.name.replace(/[\x00-\x1f\x7f]/g, "");
    if (name.length > 255) name = name.slice(0, 255);
    if (!name) continue;
    out.push({
      name,
      content: new TextDecoder().decode(entry.data),
      meta: metadata ? metadata.notes.find((n) => n.name === name) : null,
    });
  }
  return { entries: out };
}

function isZipFile(file) {
  return (
    file.name.toLowerCase().endsWith(".zip") || file.type === "application/zip"
  );
}

// Dropped or picked files: everything in, then one dialog for every clash
async function importFiles(files) {
  if (!files.length) return;
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  const wasInView = mdViewActive;
  const incoming = [];
  const skipped = [];
  for (const file of files) {
    if (isZipFile(file)) {
      const r = await readZipEntries(file);
      if (r.error) skipped.push(`${file.name} — ${r.error}`);
      else incoming.push(...r.entries);
    } else if (file.type.startsWith("text/") || isTextFilename(file.name)) {
      incoming.push({ name: file.name, content: await file.text(), meta: null });
    } else skipped.push(`${file.name} — not a text file`);
  }

  const ready = [];
  const clashes = [];
  let merged = 0;
  for (const it of incoming) {
    // Binary file detection: null bytes in the first 8KB
    if (it.content.slice(0, 8192).includes("\x00")) {
      skipped.push(`${it.name} — not a text file`);
      continue;
    }
    const existing = state.notes.find((n) => n.name === it.name);
    if (existing && it.meta && it.meta.id === existing.id) {
      // The same note exported earlier: the newer one wins, no question
      if (it.meta.updatedAt > existing.updatedAt) {
        existing.content = it.content;
        existing.updatedAt = it.meta.updatedAt;
        merged++;
      }
    } else if (existing) {
      const theirsNewer = it.meta && it.meta.updatedAt > existing.updatedAt;
      clashes.push({
        ...it,
        existing,
        theirsNewer,
        choice: theirsNewer ? "replace" : "keep",
      });
    } else ready.push(it);
  }

  if (clashes.length && !(await importDialog(ready, clashes, skipped))) return;

  let last = null;
  let added = 0;
  const add = (it, name) => {
    if (wouldExceedStorage(it.content.length * 2 + name.length * 2 + 200)) {
      skipped.push(`${name} — not enough storage space`);
      return;
    }
    // The id may belong to a renamed or deleted note — don't reuse it
    const idTaken =
      !it.meta ||
      state.notes.some((n) => n.id === it.meta.id) ||
      state.deletedIds.includes(it.meta.id);
    last = {
      id: idTaken ? crypto.randomUUID() : it.meta.id,
      name,
      content: it.content,
      updatedAt: it.meta?.updatedAt ?? Date.now(),
      cursorPos: 0,
    };
    state.notes.unshift(last);
    added++;
  };
  for (const it of ready) add(it, it.name);
  for (const c of clashes) {
    if (c.choice === "replace") {
      pushHistory(c.existing.id, c.existing.content);
      c.existing.content = c.content;
      c.existing.updatedAt = c.meta?.updatedAt ?? Date.now();
      last = c.existing;
      added++;
    } else if (c.choice === "keep") add(c, uniqueName(c.name));
  }
  if (last) {
    sharedNote = null;
    state.activeId = last.id;
  }
  if (last || merged) {
    saveState();
    scheduleDriveUpload(true);
    if (mdViewActive) switchMdTab("edit");
    render();
    updateUrl();
    const note = getActiveNote();
    if (wasInView && note && hasViewTab(note.name)) switchMdTab("view");
  }
  const total = added + merged;
  if (skipped.length && !clashes.length)
    showToast(
      (total ? `Imported ${total}, skipped ` : "Skipped ") +
        skipped.map((s) => s.split(" — ")[0]).join(", ") +
        " — " +
        skipped[0].split(" — ")[1],
      { error: true },
    );
  else if (total)
    showToast(total === 1 ? "Imported " + (last?.name ?? "1 note") : `Imported ${total} notes`, {
      ic: "check",
    });
}

function importDialog(ready, clashes, skipped) {
  return new Promise((resolve) => {
    const count = () =>
      ready.length + clashes.filter((c) => c.choice !== "skip").length;
    const seg = (c, i) =>
      `<div class="seg">${[
        ["replace", "Replace"],
        ["keep", "Keep both"],
        ["skip", "Skip"],
      ]
        .map(
          ([v, l]) =>
            `<button data-row="${i}" data-choice="${v}" aria-pressed="${c.choice === v}">${l}</button>`,
        )
        .join("")}</div>`;
    const row = (name, aside, extra = "") => {
      const kind = noteKind(name);
      return `<div class="import-row">${icon(kind.icon, "kind " + kind.cls)}<span class="note-item-name">${nameHtml(name)}</span>${aside ? `<span class="note-item-time">${aside}</span>` : ""}${extra}</div>`;
    };
    const total = ready.length + clashes.length;
    const dlg = openDialog(
      `<h2>Import ${total} ${total === 1 ? "note" : "notes"}</h2>` +
        `<p>${clashes.length} already ${clashes.length === 1 ? "exists" : "exist"}. Choose what to do with each.</p>` +
        `<div class="import-rows">` +
        clashes
          .map((c, i) =>
            row(c.name, c.theirsNewer ? "theirs is newer" : c.meta ? "yours is newer" : "", seg(c, i)),
          )
          .join("") +
        ready.map((r) => row(r.name, "New")).join("") +
        skipped.map((s) => row(s.split(" — ")[0], "Skipped: " + s.split(" — ")[1])).join("") +
        `</div>` +
        `<div class="dialog-actions"><label class="same"><span class="check" role="checkbox" aria-checked="false" tabindex="0"></span>Same for all</label>` +
        `<button class="btn" data-dlg="cancel">Cancel</button><button class="btn primary" data-dlg="ok">Import ${count()}</button></div>`,
      (e, close) => {
        const same = dlg.querySelector(".check");
        const b = e.target.closest("[data-choice]");
        if (b) {
          const targets = same.getAttribute("aria-checked") === "true"
            ? clashes
            : [clashes[b.dataset.row]];
          for (const c of targets) c.choice = b.dataset.choice;
          for (const btn of dlg.querySelectorAll("[data-choice]"))
            btn.setAttribute(
              "aria-pressed",
              clashes[btn.dataset.row].choice === btn.dataset.choice,
            );
          dlg.querySelector("[data-dlg=ok]").textContent = "Import " + count();
          return;
        }
        if (e.target.closest("label.same")) {
          e.preventDefault();
          same.setAttribute(
            "aria-checked",
            same.getAttribute("aria-checked") !== "true",
          );
          return;
        }
        const act = e.target.closest("[data-dlg]")?.dataset.dlg;
        if (act) close(act === "ok");
      },
      resolve,
    );
    dlg.querySelector("[data-dlg=ok]").focus();
  });
}

// One dialog at a time in #dialogOverlay; Esc and the scrim cancel
function openDialog(html, onClick, onClose = () => {}, cls = "") {
  const overlay = document.getElementById("dialogOverlay");
  const previousFocus = document.activeElement;
  overlay.innerHTML = `<div class="dialog ${cls}" role="document">${html}</div>`;
  overlay.classList.add("visible");
  const dlg = overlay.firstElementChild;
  let done = false;
  const close = (result) => {
    if (done) return;
    done = true;
    removeTrap();
    overlay.classList.remove("visible");
    overlay.innerHTML = "";
    overlay.onclick = null;
    previousFocus?.focus?.();
    onClose(result);
  };
  const removeTrap = trapFocus(overlay, (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  });
  overlay.onclick = (e) => {
    if (e.target === overlay) return close(false);
    onClick(e, close);
  };
  return dlg;
}

const importInput = document.getElementById("importInput");
function openImport() {
  importInput.click();
}
importInput.addEventListener("change", () => {
  importFiles([...importInput.files]);
  importInput.value = "";
});

document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove("visible");
  if (zenModeActive) return;
  importFiles([...e.dataTransfer.files]);
});

// ═══════════════════════════════════════════════════
//  Sidebar Resize
// ═══════════════════════════════════════════════════

(function restoreSidebarWidth() {
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (saved) {
    sidebar.style.setProperty("--sidebar-width", saved + "px");
  } else if (window.innerWidth >= 1000) {
    sidebar.style.setProperty("--sidebar-width", "350px");
  }
})();

sidebarResize.addEventListener("mousedown", (e) => {
  e.preventDefault();
  sidebarResize.classList.add("active");
  const onMove = (e) => {
    const w = Math.min(Math.max(e.clientX, 120), window.innerWidth * 0.5);
    sidebar.style.setProperty("--sidebar-width", w + "px");
  };
  const onUp = () => {
    sidebarResize.classList.remove("active");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    localStorage.setItem(
      SIDEBAR_WIDTH_KEY,
      parseInt(getComputedStyle(sidebar).width),
    );
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
});

// ═══════════════════════════════════════════════════
//  Cross-tab Sync
// ═══════════════════════════════════════════════════

window.addEventListener("storage", (e) => {
  // Another tab claimed leadership — this tab must stop syncing
  if (e.key === TAB_LEADER_KEY && e.newValue !== tabId) {
    revokeLeadership();
  }
  if (
    (e.key === STORAGE_KEY || e.key === PENDING_KEY) &&
    e.newValue &&
    stateLoaded
  ) {
    try {
      lastRaw[e.key] = e.newValue;
      const before = activeNoteVersion();
      if (!mergeStoredState(JSON.parse(e.newValue))) return;
      // Older versions only write the mirror — keep IndexedDB current.
      // A journal's own tab commits it.
      if (e.key === STORAGE_KEY) scheduleIdbFlush();
      // Only touch the editor if the open note itself changed
      if (activeNoteVersion() !== before) {
        render();
        updateUrl();
      } else renderNoteList();
    } catch {}
  }
  // Drive connect / token refresh / sign-out in another tab
  if (e.key === GDRIVE_CONNECTED_KEY || e.key === GDRIVE_TOKEN_KEY) {
    if (e.key === GDRIVE_CONNECTED_KEY && !e.newValue) {
      if (gdriveConnected) driveSignOut(false);
    } else if (
      localStorage.getItem(GDRIVE_CONNECTED_KEY) === "true" &&
      restoreToken() === "ok"
    ) {
      gdriveConnected = true;
      showSyncConnected();
      scheduleTokenRefresh();
    }
  }
  if (e.key === SIDEBAR_WIDTH_KEY && e.newValue) {
    sidebar.style.setProperty("--sidebar-width", e.newValue + "px");
  }
  if (e.key === WRAP_KEY && e.newValue) {
    const isWrap = e.newValue === "true";
    editorArea.classList.toggle("wrap", isWrap);
    btnWrap.classList.toggle("active", isWrap);
    if (isWrap) {
      requestAnimationFrame(syncScrollbarGap);
    } else {
      highlightLayer.style.paddingRight = "";
      _lastScrollbarW = "";
    }
  }
  if (e.key === VIM_KEY && e.newValue) {
    const isVim = e.newValue === "true";
    vimState.enabled = isVim;
    if (isVim) {
      vimSetMode("normal");
    } else {
      editor.readOnly = false;
      vimState.mode = "normal";
    }
    updateCursorPos();
  }
});

// ═══════════════════════════════════════════════════
//  Tab Leadership (only the active tab syncs)
// ═══════════════════════════════════════════════════

function reclaimLeadership() {
  if (isTabLeader) return;
  const before = activeNoteVersion();
  if (mergeFromStorage() && activeNoteVersion() !== before) render();
  claimLeadership();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") reclaimLeadership();
});

window.addEventListener("focus", reclaimLeadership);

// Flush pending saves when the tab is closed
// Mobile browsers may discard hidden tabs without firing beforeunload
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  const note = getActiveNote();
  if (note && vimState.bufferDirty) saveSwap(note.id, editor.value);
  saveState();
  flushMirror();
});

window.addEventListener("beforeunload", () => {
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveState();
  }
  flushMirror();
});
window.addEventListener("pagehide", flushMirror);

// ═══════════════════════════════════════════════════
//  Editor Events & Keyboard Shortcuts
// ═══════════════════════════════════════════════════

editor.addEventListener("input", () => {
  lastOccurrenceQuery = "";
  occurrenceOverlay.innerHTML = "";
  if (sharedNote) {
    sharedNote.content = editor.value;
    saveShared(true);
  }
  const note = getActiveNote();
  if (!note) return;
  // In vim mode, skip automatic history — vim commands handle their own undo
  const vimActive = vimState.enabled;
  if (!vimActive) {
    const h = getHistory(note.id);
    const lastContent = h.past.length
      ? h.past[h.past.length - 1].content
      : null;
    if (lastContent !== note.content) {
      if (!historyTimeout || historyNoteId !== note.id)
        pushHistory(note.id, note.content);
    }
  }
  if (vimActive) {
    vimState.bufferDirty = true;
    scheduleSwap(note.id);
  } else {
    note.content = editor.value;
    note.updatedAt = Date.now();
  }
  // Highlight first: it is what shows the typed character, and line
  // heights / caret positions are measured from it
  updateHighlight();
  updateLineNumbers();
  updateCursorPos();
  ensureCursorScrolloff();
  // Keep find offsets valid — replace/next would otherwise hit shifted text
  if (findMatches.length) updateFindMatches(false);
  if (!vimActive) {
    scheduleSave();
    scheduleHistorySnapshot();
    scheduleUrlUpdate();
  }
});

editor.addEventListener("scroll", () => {
  gutter.scrollTop = editor.scrollTop;
  highlightLayer.scrollTop = editor.scrollTop;
  highlightLayer.scrollLeft = editor.scrollLeft;
  if (editorArea.classList.contains("wrap")) syncScrollbarGap();
  syncOccurrenceScroll();
  vimUpdateBlockCursor();
  // Occurrence highlights are drawn for visible rows only
  if (lastOccurrenceQuery) {
    clearTimeout(occurrenceTimeout);
    occurrenceTimeout = setTimeout(() => updateOccurrenceMarkers(true), 100);
  }
});

// Track cursor position for line/col and current line highlight
// In vim normal/visual mode, mouse clicks create selections (for copy)
// but don't move the vim cursor — matching real vim terminal behavior.
editor.addEventListener("mousedown", () => {
  clearOccurrenceHighlights();
  if (vimState.enabled && vimState.mode !== "insert") {
    _vimPreClickPos = editor.selectionStart;
  }
});
editor.addEventListener("click", () => {
  if (_vimPreClickPos !== null) {
    // Single click: restore cursor position immediately
    if (editor.selectionStart === editor.selectionEnd) {
      editor.selectionStart = editor.selectionEnd = _vimPreClickPos;
    }
    // Double-click (selection): keep selection visible, block cursor
    // stays at _vimPreClickPos via vimUpdateBlockCursor
  } else {
    vimState.desiredCol = null;
  }
  updateCursorPos();
});
editor.addEventListener("keyup", updateCursorPos);
editor.addEventListener("select", updateCursorPos);
editor.addEventListener("mouseup", scheduleOccurrenceUpdate);
editor.addEventListener("keydown", (e) => {
  if (
    e.key === "ArrowLeft" ||
    e.key === "ArrowRight" ||
    e.key === "ArrowUp" ||
    e.key === "ArrowDown" ||
    e.key === "Home" ||
    e.key === "End" ||
    e.key === "PageUp" ||
    e.key === "PageDown"
  ) {
    clearOccurrenceHighlights();
  }
});

editor.addEventListener("keydown", vimHandleKeydown);

// Vim: scroll wheel moves cursor instead of scrolling
editor.addEventListener(
  "wheel",
  (e) => {
    if (!vimState.enabled || vimState.mode === "insert") return;
    e.preventDefault();
    const lines = Math.round(Math.abs(e.deltaY) / 20) || 1;
    vimMoveLines(e.deltaY > 0 ? 1 : -1, lines);
  },
  { passive: false },
);

// Move the lines touched by the cursor/selection one line up or down
function moveLines(dir) {
  const val = editor.value;
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  // A selection ending at a line start doesn't include that line
  const blockEnd = e > s && val[e - 1] === "\n" ? e - 1 : e;
  const first = val.lastIndexOf("\n", s - 1) + 1;
  const nl = val.indexOf("\n", blockEnd);
  const last = nl === -1 ? val.length : nl;
  if (dir < 0 ? first === 0 : nl === -1) return;
  const block = val.slice(first, last);
  let start, end, text, delta;
  if (dir < 0) {
    start = val.lastIndexOf("\n", first - 2) + 1;
    end = last;
    text = block + "\n" + val.slice(start, first - 1);
    delta = start - first;
  } else {
    const ne = val.indexOf("\n", last + 1);
    start = first;
    end = ne === -1 ? val.length : ne;
    const next = val.slice(last + 1, end);
    text = next + "\n" + block;
    delta = next.length + 1;
  }
  const note = getActiveNote();
  // Vim mode keeps its own undo points (the input handler skips them)
  if (note && vimState.enabled && vimState.mode !== "insert")
    pushHistory(note.id, val);
  const ro = editor.readOnly;
  editor.readOnly = false;
  editor.setRangeText(text, start, end);
  editor.readOnly = ro;
  editor.setSelectionRange(s + delta, e + delta);
  // Text typed before the move no longer sits at insertEntry.pos
  if (vimState.insertEntry) vimState.insertEntry.pos = editor.selectionStart;
  editor.dispatchEvent(new Event("input"));
}

// Markdown lists: Enter continues the item's marker; on an empty item it
// removes the marker instead, ending the list
const LIST_RE = /^(\s*)(?:([-+*])|(\d+)([.)]))(\s+)(\[[ xX]?\]\s+)?/;

function inCodeFence(text, upTo) {
  let open = false;
  for (const line of text.slice(0, upTo).split("\n"))
    if (/^\s*(```|~~~)/.test(line)) open = !open;
  return open;
}

function continueList() {
  const note = getActiveNote();
  if (!note || !isMarkdownFile(note.name)) return false;
  const val = editor.value;
  const pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) return false;
  const start = val.lastIndexOf("\n", pos - 1) + 1;
  const nl = val.indexOf("\n", pos);
  const end = nl === -1 ? val.length : nl;
  const line = val.slice(start, end);
  const m = line.match(LIST_RE);
  if (!m || pos < start + m[0].length || inCodeFence(val, start)) return false;
  const [marker, indent, bullet, num, delim, gap, task] = m;
  const rest = val.slice(pos, end);
  const lead = rest.length - rest.trimStart().length;
  if (!line.slice(marker.length).trim()) {
    editor.setRangeText("", start, end, "start");
  } else if (LIST_RE.test(rest.slice(lead))) {
    // The text after the cursor already starts with its own marker: split
    // there instead of adding a second one
    const before = val.slice(start + marker.length, pos);
    const trail = before.length - before.trimEnd().length;
    editor.setRangeText("\n" + indent, pos - trail, pos + lead, "end");
  } else {
    const next = bullet || Number(num) + 1 + delim;
    editor.setRangeText(
      "\n" + indent + next + gap + (task ? "[ ] " : ""),
      pos,
      pos,
      "end",
    );
  }
  editor.dispatchEvent(new Event("input"));
  return true;
}

let lastKeydownKey = "";
editor.addEventListener("keydown", (e) => (lastKeydownKey = e.key), true);
// Mobile keyboards that don't report Enter on keydown still send this
editor.addEventListener("beforeinput", (e) => {
  if (
    (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") &&
    lastKeydownKey !== "Enter" &&
    !e.isComposing &&
    !(vimState.enabled && vimState.mode !== "insert") &&
    continueList()
  )
    e.preventDefault();
});

editor.addEventListener("keydown", (e) => {
  // Skip in vim normal/visual mode
  if (vimState.enabled && vimState.mode !== "insert") return;

  if (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.isComposing &&
    continueList()
  ) {
    e.preventDefault();
    return;
  }

  // Alt+Arrow Up/Down — move line(s) up/down
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    moveLines(e.key === "ArrowUp" ? -1 : 1);
    return;
  }

  // Tab / Shift+Tab for indent/dedent
  if (e.key === "Tab") {
    e.preventDefault();
    indentAtCursor(e.shiftKey);
  }
});

// At the start of a list item: change its nesting; with a selection: indent
// or dedent its lines; otherwise insert two spaces
function indentAtCursor(shift) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const val = editor.value;
  const lineStart = val.lastIndexOf("\n", start - 1) + 1;
  const nl = val.indexOf("\n", lineStart);
  const line = val.slice(lineStart, nl === -1 ? val.length : nl);
  const listMarker =
    start === end &&
    isMarkdownFile(getActiveNote()?.name || "") &&
    line.match(LIST_RE);

  if (
    listMarker &&
    start <= lineStart + listMarker[0].length &&
    !inCodeFence(val, lineStart)
  ) {
    // Cursor at the start of a list item: change its nesting level
    const lead = line.match(/^(?:\t| {1,2})?/)[0];
    if (!shift) {
      editor.setRangeText("  ", lineStart, lineStart, "preserve");
      editor.setSelectionRange(start + 2, start + 2);
    } else if (lead) {
      editor.setRangeText("", lineStart, lineStart + lead.length, "preserve");
      const pos = Math.max(lineStart, start - lead.length);
      editor.setSelectionRange(pos, pos);
    }
  } else if (start === end && !shift) {
    // No selection: insert 2 spaces
    editor.setRangeText("  ", start, end, "end");
  } else {
    // Selection: indent/dedent all selected lines
    const lineEnd = val.indexOf("\n", end);
    const actualEnd = lineEnd === -1 ? val.length : lineEnd;
    const block = val.substring(lineStart, actualEnd);
    const lines = block.split("\n");
    let newLines;
    if (shift) {
      newLines = lines.map((l) => {
        if (l.startsWith("  ")) return l.slice(2);
        if (l.startsWith("\t")) return l.slice(1);
        return l;
      });
    } else {
      newLines = lines.map((l) => "  " + l);
    }
    const newBlock = newLines.join("\n");
    editor.setRangeText(newBlock, lineStart, actualEnd, "select");
    editor.selectionStart = lineStart;
    editor.selectionEnd = lineStart + newBlock.length;
  }
  editor.dispatchEvent(new Event("input"));
}

document.addEventListener("keydown", (e) => {
  const inInput =
    document.activeElement &&
    document.activeElement !== editor &&
    (document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "TEXTAREA");
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  // Dialogs keep their own keys
  if (
    modalOverlay.classList.contains("visible") ||
    document.getElementById("dialogOverlay").classList.contains("visible")
  )
    return;

  // In zen mode, block all shortcuts except "e", Escape, and Cmd/Ctrl+A
  if (zenModeActive) {
    if (!inInput && e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      exitZenMode();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitZenMode();
    } else if (!inInput && mod && key === "a") {
      e.preventDefault();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(mdPreview);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return;
  }
  // Switch from preview to edit with "e" (on the canvas, e is the eraser)
  if (
    !inInput &&
    mdViewActive &&
    !drawActive() &&
    e.key === "e" &&
    !mod &&
    !e.altKey
  ) {
    e.preventDefault();
    switchMdTab("edit", true);
    return;
  }
  // ⌘E: Edit ⇄ Preview, Canvas ⇄ Source
  if (mod && !e.shiftKey && !e.altKey && key === "e") {
    e.preventDefault();
    toggleView();
    return;
  }
  // Find and replace: ⌘⌥F, Ctrl+H
  if (
    (mod && e.altKey && !e.shiftKey && e.code === "KeyF") ||
    (e.ctrlKey && !e.metaKey && !e.shiftKey && key === "h")
  ) {
    e.preventDefault();
    openFindReplace(true);
    return;
  }
  // Find: ⌘F (on the canvas it searches the shapes' text)
  if (mod && !e.shiftKey && !e.altKey && key === "f") {
    e.preventDefault();
    if (drawActive()) openSearch("note");
    else openFindReplace();
    return;
  }
  // Palette: ⌘P notes, ⌘⇧P and ⌘/ commands
  if (mod && !e.altKey && key === "p") {
    e.preventDefault();
    openSearch("all", e.shiftKey ? "> " : "");
    return;
  }
  if (mod && e.key === "/") {
    e.preventDefault();
    openSearch("all", "> ");
    return;
  }
  // ⌘\: sidebar
  if (mod && e.key === "\\") {
    e.preventDefault();
    toggleSidebar();
    return;
  }
  // F2: rename this note
  if (e.key === "F2" && !inInput) {
    e.preventDefault();
    renameInTitle();
    return;
  }
  // Escape closes the topmost layer only
  if (e.key === "Escape" && findReplaceBar.classList.contains("visible")) {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  if (e.key === "Escape" && searchResults.classList.contains("visible")) {
    e.preventDefault();
    closeSearch();
    searchInput.value = "";
    editor.focus();
    return;
  }
  if (e.key === "Escape" && sidebar.classList.contains("open")) {
    e.preventDefault();
    closeSidebar();
    editor.focus();
    return;
  }
  // Delete note
  if (mod && e.shiftKey && key === "d") {
    e.preventDefault();
    const note = getActiveNote();
    if (note && !sharedNote) deleteNote(note.id);
    return;
  }
  // Undo — a just-deleted note first
  if (!inInput && mod && key === "z" && !e.shiftKey) {
    e.preventDefault();
    if (toastUndo) {
      const fn = toastUndo;
      hideToast();
      fn();
    } else undo();
    return;
  }
  // Redo
  if (
    !inInput &&
    ((mod && e.shiftKey && key === "z") ||
      (e.ctrlKey && !e.metaKey && key === "y"))
  ) {
    e.preventDefault();
    redo();
    return;
  }
  // ⌘S: suppress the browser's save; format markdown if set, save and sync
  if (mod && key === "s") {
    e.preventDefault();
    // Vim mode: do nothing (use :w)
    if (vimState.enabled) return;
    if (!mdViewActive && formatOnSave()) {
      const note = getActiveNote();
      if (note && isMarkdownFile(note.name)) {
        const pos = editor.selectionStart;
        pushHistory(note.id, editor.value);
        editor.value = formatMarkdown(editor.value);
        note.content = editor.value;
        note.updatedAt = Date.now();
        editor.selectionStart = editor.selectionEnd = Math.min(
          pos,
          editor.value.length,
        );
        updateLineNumbers();
        updateHighlight();
        updateCursorPos();
      }
    }
    saveState();
    scheduleUrlUpdate();
    if (gdriveConnected) driveSync();
    return;
  }
  // New note: ⌃N (Chrome keeps ⌘N and, on Windows, Ctrl+N), Alt+N elsewhere
  if (
    (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && key === "n") ||
    (!IS_MAC && e.altKey && !mod && !e.shiftKey && e.code === "KeyN")
  ) {
    e.preventDefault();
    createNote(undefined, undefined, true);
    return;
  }
  // Toggle vim mode
  if (e.ctrlKey && !e.metaKey && e.shiftKey && key === "m") {
    e.preventDefault();
    toggleVim();
    return;
  }
  // Format markdown: ⌥⇧F (and the old Ctrl+Shift+F)
  if (
    (e.altKey && e.shiftKey && !mod && e.code === "KeyF") ||
    (mod && e.shiftKey && !e.altKey && key === "f")
  ) {
    e.preventDefault();
    formatNote();
  }
});

// ═══════════════════════════════════════════════════
//  Google Drive Sync (lazy-loaded)
// ═══════════════════════════════════════════════════

// Sign-in runs in worker.js: it keeps Google's refresh token in an HttpOnly
// cookie and hands out access tokens, so no popup is ever needed after the
// first connect. The access token lives here; Drive is called directly.
const GDRIVE_FILE_NAME = "note-app-data.json";
const GDRIVE_TOKEN_KEY = "notepad_gdrive_token";
const GDRIVE_CONNECTED_KEY = "notepad_gdrive_connected";
let gdriveToken = null;
let gdriveTokenExpiry = 0;

function persistToken(token, expiresIn) {
  gdriveToken = token;
  gdriveTokenExpiry = Date.now() + expiresIn * 1000;
  localStorage.setItem(
    GDRIVE_TOKEN_KEY,
    JSON.stringify({ token, expiry: gdriveTokenExpiry }),
  );
}

function restoreToken() {
  try {
    const raw = localStorage.getItem(GDRIVE_TOKEN_KEY);
    if (raw) {
      const { token, expiry } = JSON.parse(raw);
      if (Date.now() < expiry) {
        gdriveToken = token;
        gdriveTokenExpiry = expiry;
        return "ok";
      }
      localStorage.removeItem(GDRIVE_TOKEN_KEY);
      return "expired";
    }
  } catch {}
  // No token — check if user was previously connected
  if (localStorage.getItem(GDRIVE_CONNECTED_KEY) === "true") return "expired";
  return "none";
}

function clearToken() {
  gdriveToken = null;
  gdriveTokenExpiry = 0;
  localStorage.removeItem(GDRIVE_TOKEN_KEY);
}

// The sidebar footer: sync state for all notes, with the fix when it fails
let syncFailedState = false;
let lastSyncAt = 0;
const syncLabel = document.getElementById("syncLabel");
const syncDot = document.getElementById("syncDot");

function showSyncLine(on) {
  document.getElementById("syncMenuContainer").style.display = on ? "" : "none";
  document.getElementById("syncLocal").style.display = on ? "none" : "";
  document.getElementById("btnDriveSync").hidden = on;
}

function showSyncConnected() {
  syncFailedState = false;
  showSyncLine(true);
  syncDot.classList.remove("disconnected");
  document.getElementById("syncMenuConnected").style.display = "";
  document.getElementById("syncMenuFailed").style.display = "none";
  updateSyncLine();
}

function showSyncFailed() {
  syncFailedState = true;
  showSyncLine(true);
  syncDot.classList.remove("syncing");
  syncDot.classList.add("disconnected");
  document.getElementById("syncMenuConnected").style.display = "none";
  document.getElementById("syncMenuFailed").style.display = "";
  // Offline needs no action; a missing or revoked sign-in does
  document.getElementById("syncSignedOutHint").style.display = gdriveSignedOut
    ? ""
    : "none";
  updateSyncLine();
}

function hideSyncConnected() {
  syncFailedState = false;
  showSyncLine(false);
  syncDot.classList.remove("disconnected");
  updateTitleBar();
}

function updateSyncLine() {
  const when = document.getElementById("syncWhen");
  if (syncDotCount > 0) {
    syncLabel.textContent = "Syncing…";
    when.textContent = "";
  } else if (syncFailedState) {
    syncLabel.innerHTML = gdriveSignedOut
      ? "<b>Sync paused</b> · sign-in expired"
      : "<b>Sync paused</b> · will retry";
    when.textContent = "";
  } else {
    syncLabel.textContent = "Synced to Google Drive";
    when.textContent = lastSyncAt ? relativeTime(lastSyncAt) : "";
  }
  updateTitleBar();
}

let gdriveRefreshTimer = null;
let gdriveSignedOut = false; // last refresh said only a new sign-in helps

// Never shows UI. Rejects with "signed_out" when only a new sign-in helps
// (no cookie yet, or access revoked), with anything else when offline etc.
async function silentTokenRefresh() {
  const res = await fetch("/auth/token", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  gdriveSignedOut = res.status === 401;
  if (!res.ok) throw new Error(gdriveSignedOut ? "signed_out" : "auth");
  const { access_token, expires_in } = await res.json();
  persistToken(access_token, expires_in);
  scheduleTokenRefresh();
}

function scheduleTokenRefresh() {
  clearTimeout(gdriveRefreshTimer);
  const msUntilExpiry = gdriveTokenExpiry - Date.now();
  // Refresh 5 minutes before expiry
  const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, 0);
  gdriveRefreshTimer = setTimeout(async () => {
    if (!gdriveConnected || !isTabLeader) return;
    try {
      await silentTokenRefresh();
    } catch {
      clearToken();
      showSyncFailed();
    }
  }, refreshIn);
}

// User-initiated only: when no sign-in cookie is left, the page leaves for
// Google and comes back with ?drive=connected (beforeunload saves edits)
async function gdriveAuth() {
  if (gdriveToken && Date.now() < gdriveTokenExpiry) return;
  clearToken();
  try {
    await silentTokenRefresh();
  } catch (e) {
    if (e.message !== "signed_out") throw e;
    location.assign("/auth/start");
    await new Promise(() => {});
  }
}

async function gdriveFetch(url, opts = {}) {
  if (!gdriveToken || Date.now() >= gdriveTokenExpiry) {
    await silentTokenRefresh();
  }
  const send = () =>
    fetch(url, {
      ...opts,
      headers: { Authorization: "Bearer " + gdriveToken, ...opts.headers },
    });
  let res = await send();
  if (res.status === 401) {
    // Token rejected — refresh silently and retry once
    clearToken();
    await silentTokenRefresh();
    res = await send();
  }
  if (!res.ok) throw new Error("Drive error: " + res.status);
  return res;
}

const GDRIVE_API = "https://www.googleapis.com/drive/v3/files";
const GDRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

// Oldest first — if devices raced to create the file, the oldest is canonical
async function gdriveListFiles() {
  const res = await gdriveFetch(
    GDRIVE_API +
      "?spaces=appDataFolder&orderBy=createdTime&fields=files(id,version)&q=" +
      encodeURIComponent(`name='${GDRIVE_FILE_NAME}'`),
  );
  return (await res.json()).files || [];
}

async function gdriveVersion(id) {
  const res = await gdriveFetch(GDRIVE_API + "/" + id + "?fields=version");
  return (await res.json()).version;
}

async function gdriveDownload(id) {
  const res = await gdriveFetch(GDRIVE_API + "/" + id + "?alt=media");
  return parseDrivePayload(await res.json().catch(() => null));
}

async function gdriveUpload(fileId, payload) {
  if (fileId) {
    await gdriveFetch(GDRIVE_UPLOAD + "/" + fileId + "?uploadType=media", {
      method: "PATCH",
      body: payload,
      headers: { "Content-Type": "application/json" },
    });
    return;
  }
  const metadata = JSON.stringify({
    name: GDRIVE_FILE_NAME,
    parents: ["appDataFolder"],
  });
  const boundary = "---noteapp" + Date.now();
  const body =
    "--" +
    boundary +
    "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadata +
    "\r\n--" +
    boundary +
    "\r\nContent-Type: application/json\r\n\r\n" +
    payload +
    "\r\n--" +
    boundary +
    "--";
  await gdriveFetch(GDRIVE_UPLOAD + "?uploadType=multipart", {
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
}

// Remote data is untrusted: drop anything that would break the editor
function parseDrivePayload(data) {
  const isNote = (n) =>
    n &&
    typeof n.id === "string" &&
    typeof n.name === "string" &&
    typeof n.content === "string";
  const notes = Array.isArray(data?.notes) ? data.notes.filter(isNote) : [];
  for (const n of notes) if (typeof n.updatedAt !== "number") n.updatedAt = 0;
  const deletedAt = {};
  if (data?.deletedAt && typeof data.deletedAt === "object")
    for (const [id, t] of Object.entries(data.deletedAt))
      if (typeof t === "number") deletedAt[id] = t;
  return {
    notes,
    deletedIds: Array.isArray(data?.deletedIds)
      ? data.deletedIds.filter((id) => typeof id === "string")
      : [],
    deletedAt,
    settings: data?.settings || null,
  };
}

// Several files (devices raced to create one): newest note version wins
function combineDrivePayloads(payloads) {
  const out = parseDrivePayload({});
  const byId = new Map();
  for (const p of payloads) {
    for (const n of p.notes) {
      const prev = byId.get(n.id);
      if (!prev || n.updatedAt > prev.updatedAt) byId.set(n.id, n);
    }
    out.deletedIds.push(...p.deletedIds);
    Object.assign(out.deletedAt, p.deletedAt);
    out.settings ||= p.settings;
  }
  out.notes = [...byId.values()];
  out.deletedIds = [...new Set(out.deletedIds)];
  return out;
}

function gatherDrivePayload() {
  return JSON.stringify({
    ...state,
    settings: {
      wrap: localStorage.getItem(WRAP_KEY),
      vim: localStorage.getItem(VIM_KEY),
      sidebarWidth: localStorage.getItem(SIDEBAR_WIDTH_KEY),
      theme: localStorage.getItem(THEME_KEY),
    },
  });
}

function applyDriveSettings(settings) {
  if (!settings) return;
  if (settings.wrap !== null && settings.wrap !== undefined) {
    localStorage.setItem(WRAP_KEY, settings.wrap);
    const wrapOn = settings.wrap === "true";
    editorArea.classList.toggle("wrap", wrapOn);
    btnWrap.setAttribute("aria-pressed", wrapOn);
    if (wrapOn) {
      requestAnimationFrame(syncScrollbarGap);
    } else {
      highlightLayer.style.paddingRight = "";
      _lastScrollbarW = "";
    }
    updateLineNumbers();
  }
  if (settings.vim !== null && settings.vim !== undefined) {
    localStorage.setItem(VIM_KEY, settings.vim);
    const vimOn = settings.vim === "true";
    vimState.enabled = vimOn;
    if (vimOn) {
      vimSetMode("normal");
    } else {
      editor.readOnly = false;
      vimState.mode = "normal";
    }
    updateCursorPos();
  }
  if (THEMES.includes(settings.theme)) {
    localStorage.setItem(THEME_KEY, settings.theme);
    applyTheme(settings.theme);
  }
  if (/^\d+$/.test(settings.sidebarWidth || "")) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, settings.sidebarWidth);
    sidebar.style.setProperty("--sidebar-width", settings.sidebarWidth + "px");
  }
}

// ── Merge ───────────────────────────────────────────

// Per device: fingerprint of every note as of the last successful sync.
// This is the common ancestor that tells which side changed a note.
const GDRIVE_BASE_KEY = "notepad_gdrive_base";

function noteFingerprint(n) {
  return crc32(
    new TextEncoder().encode(
      n.name + "\0" + n.content + "\0" + (n.pinned ? 1 : 0),
    ),
  );
}

function loadSyncBase() {
  try {
    const b = JSON.parse(localStorage.getItem(GDRIVE_BASE_KEY));
    if (b && b.notes) return b;
  } catch {}
  return { notes: {}, syncedAt: 0 };
}

function conflictName(name) {
  const dot = name.lastIndexOf(".");
  const copy =
    dot > 0
      ? name.slice(0, dot) + " (conflict)" + name.slice(dot)
      : name + " (conflict)";
  return state.notes.some((n) => n.name === copy) ? uniqueName(copy) : copy;
}

// Three-way merge of local state with `remote`. A side that didn't change a
// note since the last sync yields to the other; if both changed it, both
// versions are kept. Edits made after a deletion win over the deletion.
// Mutates `state`; returns true if remote lacks something we have.
function mergeDriveState(remote, base) {
  const now = Date.now();
  // true/false, or null when this device has no sync history for the note
  const changed = (n) => {
    const fp = base.notes[n.id];
    if (fp !== undefined) return fp !== noteFingerprint(n);
    return base.syncedAt ? n.updatedAt > base.syncedAt : null;
  };
  const freshCopy = (n, name) => ({
    ...n,
    id: crypto.randomUUID(),
    name: name ?? n.name,
    updatedAt: now,
  });

  const deletedAt = { ...remote.deletedAt };
  for (const [id, t] of Object.entries(state.deletedAt || {}))
    deletedAt[id] = Math.max(deletedAt[id] || 0, t);
  const localDeleted = new Set(state.deletedIds);
  const remoteDeleted = new Set(remote.deletedIds);
  // Edit-after-delete check; legacy tombstones have no timestamp → delete
  const editedAfterDelete = (n) =>
    changed(n) ?? n.updatedAt > (deletedAt[n.id] ?? Infinity);

  const remoteById = new Map(remote.notes.map((n) => [n.id, n]));
  const localIds = new Set(state.notes.map((n) => n.id));
  const merged = [];
  const added = [];

  for (const local of state.notes) {
    const r = remoteById.get(local.id);
    if (!r) {
      if (!remoteDeleted.has(local.id)) merged.push(local);
      else if (editedAfterDelete(local)) added.push(freshCopy(local));
      continue;
    }
    if (noteFingerprint(local) === noteFingerprint(r)) {
      merged.push(local);
      continue;
    }
    const lc = changed(local);
    const rc = changed(r);
    let take = local;
    if (lc === null || rc === null) {
      // No sync history on this device — fall back to newest wins
      if (r.updatedAt > local.updatedAt) take = r;
    } else if (!lc) {
      take = r;
    } else if (rc) {
      // Both sides changed it: keep the newer, add the other as a copy
      const [winner, loser] =
        r.updatedAt > local.updatedAt ? [r, local] : [local, r];
      take = winner;
      if (winner.content !== loser.content)
        added.push(freshCopy(loser, conflictName(loser.name)));
    }
    if (take !== local) {
      // In place — UI closures hold references to note objects. The bump
      // makes other tabs' merge-on-write adopt it despite clock skew.
      const updatedAt = Math.max(take.updatedAt, local.updatedAt + 1);
      for (const k of Object.keys(local)) delete local[k];
      Object.assign(local, take, { updatedAt });
    }
    merged.push(local);
  }

  for (const r of remote.notes) {
    if (localIds.has(r.id)) continue;
    if (!localDeleted.has(r.id)) added.push(r);
    else if (editedAfterDelete(r)) added.push(freshCopy(r));
  }

  const deleted = new Set([...localDeleted, ...remoteDeleted]);
  state.notes = [...added, ...merged];
  state.deletedIds = [...deleted];
  state.deletedAt = deletedAt;
  pruneTombstones();
  if (!getActiveNote()) state.activeId = state.notes[0]?.id ?? null;
  sortNotes();

  const remoteFp = new Map(remote.notes.map((n) => [n.id, noteFingerprint(n)]));
  return (
    state.notes.length !== remote.notes.length ||
    state.notes.some((n) => remoteFp.get(n.id) !== noteFingerprint(n)) ||
    deleted.size !== remoteDeleted.size
  );
}

// ── Sync ────────────────────────────────────────────

let gdriveConnected = false;
let gdriveSyncTimeout = null;
let driveGen = 0; // bumped on every local change that should reach Drive
let driveSyncedGen = 0;
let syncEpoch = 0; // bumped on sign-out to abort in-flight syncs
let syncRunning = null;
let syncAgain = false;

function scheduleDriveUpload(immediate) {
  if (!gdriveConnected || !isTabLeader) return;
  driveGen++;
  clearTimeout(gdriveSyncTimeout);
  if (immediate) syncNow();
  // Batch typing: wait 30s after the last change
  else gdriveSyncTimeout = setTimeout(syncNow, 30000);
}

// One sync at a time: concurrent calls coalesce into one follow-up run.
// The Web Lock also keeps two tabs from syncing at once.
function syncNow() {
  if (!gdriveConnected || !isTabLeader) return Promise.resolve();
  if (syncRunning) {
    syncAgain = true;
    return syncRunning;
  }
  syncRunning = (async () => {
    try {
      do {
        syncAgain = false;
        await navigator.locks.request("note-drive-sync", runSync);
      } while (syncAgain && gdriveConnected);
    } finally {
      syncRunning = null;
    }
  })();
  return syncRunning;
}

async function runSync() {
  const epoch = syncEpoch;
  const alive = () => {
    if (epoch !== syncEpoch) throw new Error("signed out");
  };
  setSyncDotSyncing(true);
  try {
    let base = loadSyncBase();
    for (let attempt = 0; ; attempt++) {
      const gen = driveGen;
      const files = await gdriveListFiles();
      alive();
      const remote = combineDrivePayloads(
        await Promise.all(files.map((f) => gdriveDownload(f.id))),
      );
      alive();

      // Pick up edits other tabs saved, then merge with Drive
      mergeFromStorage();
      const before = activeNoteVersion();
      const copiesBefore = new Set(
        state.notes.filter((n) => isConflictCopy(n.name)).map((n) => n.id),
      );
      const needsUpload = mergeDriveState(remote, base);
      announceConflicts(copiesBefore);
      saveState();
      if (activeNoteVersion() !== before) render();
      else renderNoteList();
      if (
        remote.settings &&
        !localStorage.getItem(VIM_KEY) &&
        !localStorage.getItem(WRAP_KEY)
      )
        applyDriveSettings(remote.settings);

      const payload = gatherDrivePayload();
      if (needsUpload || files.length !== 1) {
        // Another device wrote since we downloaded → merge again
        if (
          files[0] &&
          (await gdriveVersion(files[0].id)) !== files[0].version
        ) {
          if (attempt >= 3) throw new Error("Drive file keeps changing");
          // We now contain `remote` — it is the ancestor for the next merge
          base = {
            notes: Object.fromEntries(
              remote.notes.map((n) => [n.id, noteFingerprint(n)]),
            ),
            syncedAt: Date.now(),
          };
          continue;
        }
        alive();
        await gdriveUpload(files[0]?.id, payload);
        alive();
        for (const extra of files.slice(1))
          await gdriveFetch(GDRIVE_API + "/" + extra.id, { method: "DELETE" });
      }

      const uploaded = JSON.parse(payload).notes;
      localStorage.setItem(
        GDRIVE_BASE_KEY,
        JSON.stringify({
          notes: Object.fromEntries(
            uploaded.map((n) => [n.id, noteFingerprint(n)]),
          ),
          syncedAt: Date.now(),
        }),
      );
      driveSyncedGen = gen;
      // Edits that arrived during the sync go out with the next run
      if (driveGen !== gen) syncAgain = true;
      setSyncResult(true);
      return;
    }
  } catch (e) {
    if (epoch === syncEpoch) setSyncResult(false);
  } finally {
    setSyncDotSyncing(false);
  }
}

// Both sides changed a note: the merge kept both — now say so, once
function announceConflicts(before) {
  const fresh = state.notes.filter(
    (n) => isConflictCopy(n.name) && !before.has(n.id),
  );
  if (!fresh.length) return;
  showToast(
    fresh.length === 1
      ? "1 note changed on two devices — both kept"
      : fresh.length + " notes changed on two devices — both kept",
    { action: "Show", onAction: () => switchNote(fresh[0].id) },
  );
}

// User-initiated (menu, Ctrl+S): may go to Google's sign-in page
async function driveSync() {
  closeAllMenus();
  try {
    await gdriveAuth();
  } catch {
    setSyncResult(false);
    return;
  }
  gdriveConnected = true;
  localStorage.setItem(GDRIVE_CONNECTED_KEY, "true");
  claimLeadership();
  showSyncConnected();
  await syncNow();
}

let syncDotCount = 0;
let syncDotTimer = null;
let syncOkTimer = null;
function setSyncDotSyncing(on) {
  if (on) {
    syncDotCount++;
    clearTimeout(syncDotTimer);
    syncDot.classList.add("syncing");
    syncDot.classList.remove("disconnected");
    updateSyncLine();
  } else {
    syncDotCount = Math.max(0, syncDotCount - 1);
    if (syncDotCount === 0) {
      updateSyncLine();
      // Keep pulsing for at least one full cycle
      syncDotTimer = setTimeout(() => {
        if (syncDotCount === 0) syncDot.classList.remove("syncing");
      }, 900);
    }
  }
}
function setSyncResult(success) {
  clearTimeout(syncOkTimer);
  clearTimeout(syncDotTimer);
  if (success) {
    lastSyncAt = Date.now();
    syncDot.classList.remove("syncing");
    showSyncConnected();
  } else {
    showSyncFailed();
  }
}

// `broadcast` is false when reacting to a sign-out in another tab
function driveSignOut(broadcast = true) {
  closeSyncMenu();
  syncEpoch++;
  // Revokes Google's grant and deletes the sign-in cookie
  if (broadcast) fetch("/auth/logout", { method: "POST" }).catch(() => {});
  gdriveToken = null;
  gdriveTokenExpiry = 0;
  gdriveConnected = false;
  if (broadcast) {
    clearToken();
    // The sync base is kept: on reconnect it still tells which side changed
    localStorage.removeItem(GDRIVE_CONNECTED_KEY);
  }
  clearTimeout(gdriveSyncTimeout);
  clearTimeout(gdriveRefreshTimer);
  hideSyncConnected();
}

// ═══════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════

const HELP_DESKTOP = [
  "# Welcome to note.",
  "",
  "A private, local-first editor for text and drawings.",
  "No data is collected, transmitted, or stored on any server.",
  "Your notes stay in your browser — nothing is sent anywhere.",
  "",
  "## Start",
  "",
  "- **+** at the top left, or ⌃N (Alt+N on Windows and Linux) — a new note",
  "- **⌘P** (Ctrl+P) finds any note, any line, and with `>` any command",
  "- **Share** at the top right puts the whole note in a link",
  "",
  "## Share via URL",
  "",
  "No server, no upload — the entire note lives in the link.",
  "Pick *Editable* or *Read-only*; anyone with the link can read it",
  "instantly (~60kB limit). A link someone sends you opens for",
  "reading first, and joins your notes only when you save it.",
  "",
  "## Keep it safe",
  "",
  "Browsers can clear their storage without warning.",
  "Turn on Google Drive sync or export a ZIP now and then —",
  "both in **note ▾ › Settings**.",
  "",
  "## Tips",
  "",
  "- Double-click a note to rename it, or F2 for the open one",
  "- Right-click a note for everything else; drag to reorder",
  "- Pin notes to keep them on top",
  "- Deleting shows Undo for a few seconds",
  "- Drop files anywhere, or **note ▾ › Import files…**",
  "- Word wrap and vim keys in the status bar",
  "- .md files switch between Edit and Preview, .draw files",
  "  between Canvas and Source",
  "- Link between notes: [label](other.md)",
  "- Syncs across tabs automatically",
  "",
  "## Shortcuts",
  "",
  "On Windows and Linux, ⌘ is Ctrl, ⌥ is Alt and ⇧ is Shift.",
  "",
  "- ⌃N (Alt+N) — new note",
  "- ⌘P — search notes · ⌘⇧P or ⌘/ — all commands",
  "- ⌘F — find · ⌘⌥F or Ctrl+H — find and replace",
  "- ⌘E — Edit ⇄ Preview (or E in Preview)",
  "- F2 — rename · ⌘\\ — show or hide the sidebar",
  "- ⌘⇧D — delete note (with Undo)",
  "- ⌥⇧F — format markdown (⌘S does too, see Settings)",
  "- Tab / ⇧Tab — indent / dedent; at a list item, its nesting",
  "- Enter in a list continues it, on an empty item ends it",
  "- ⌥↑ / ⌥↓ — move line up / down",
  "",
  "## Markdown preview",
  "",
  "Preview renders your markdown with these interactive features:",
  "",
  "- **Heading anchors** — hover a heading to reveal a #",
  "  link. Click it to copy a shareable URL with the",
  "  anchor to your clipboard.",
  "- **Clickable anchor links** — [link](#heading) scrolls",
  "  to the matching heading in the preview.",
  "- **Code block copy** — hover a fenced code block to",
  "  reveal a copy button in the top-right corner.",
  "- **Syntax highlighting** — fenced code blocks with a",
  "  language tag (e.g. \\`\\`\\`js) are syntax-highlighted.",
  "- **Task checkboxes** — click a checkbox to toggle it.",
  "  Checking/unchecking a parent toggles all children.",
  "  All children checked auto-checks the parent.",
  "- **Inter-note links** — [label](other.md) navigates",
  "  to that note. Browser back button works.",
  "- **Drawings** — `![label](sketch.draw)` embeds a drawing,",
  "  or put one inline in a fenced \\`\\`\\`draw block.",
  "",
  "## Drawings",
  "",
  "Pick **New drawing** from the ▾ next to + (or :draw in vim).",
  "A drawing is text too: **Source** shows one line per",
  "shape, so it syncs, shares and searches like any note.",
  "",
  "```draw",
  "draw 1",
  'r a 0 0 140 60 c=blue f=semi "note"',
  'e b 240 -10 150 80 c=green "drawing"',
  "a x a b",
  "```",
  "",
  "- v select · h hand · d draw · shift+d highlighter · e eraser",
  "- r rectangle · o ellipse · m diamond · w wedge · l line · a arrow · t text",
  "- Line: drag for a line, or click points; click the first one to close",
  "- Double-click a shape to write in it, empty space for text",
  "- Double-click a line to add a point, a point to remove it",
  "- Wedge: drag its round handles for the slice and the hole",
  "- Draw: pen, sharpie or brush pen (faster is thinner), in the style panel",
  "- Arrow from one shape to another to connect them",
  "- Shift: keep proportions, straight lines, 15° steps",
  "- Ctrl+D duplicate · Ctrl+G group · Del delete",
  "- Alt+↑/↓ forward/backward · Alt+Shift+↑/↓ to front/back",
  "- Right-click a shape for stacking, grouping and more",
  "- Space+drag or scroll to pan · Ctrl+scroll to zoom",
  "- Shift+1 fit · Shift+0 100% · Ctrl+' grid",
  "- Ctrl+B / Ctrl+I / Ctrl+U bold, italic, underline",
  "- ⋯ menu: Copy as PNG, Download as SVG",
  "",
  "## Vim",
  "",
  "Toggle from the status bar, or ⌃⇧M.",
  "Keys do different things depending on the mode.",
  "",
  "### Modes",
  "",
  "- **Normal** — keys are commands. Esc to return.",
  "- **Insert** — type text. Enter with:",
  "  i a o O A I s S",
  "- **Visual** — select text. Enter with v or V.",
  "  Then d/y/c/>/< to act on selection.",
  "",
  "### Movement",
  "",
  "- h/j/k/l — left/down/up/right",
  "- w/b/e — word forward/back/end",
  "- 0 / $ / _ — line start/end/first char",
  "- gg / G — top/bottom of file",
  "- { / } — prev/next blank line",
  "- % — matching bracket, ge — end of previous word",
  "- H / M / L — top / middle / bottom of screen",
  "- f/F + char — jump to char, t/T stops before",
  "- ; / , — repeat last f/F/t/T",
  "- Ctrl+D / Ctrl+U — half page down/up",
  "",
  "### Editing",
  "",
  "- x — delete char, r + char — replace char",
  "- dd — delete line, D — delete to end",
  "- yy — copy line, p/P — paste after/before",
  "- J — join lines, . — repeat last change",
  "- ~ — toggle case (in visual: u / U lower / upper)",
  "- u — undo, Ctrl+R — redo",
  "- >> / << — indent / dedent",
  "",
  "### Operators + motions",
  "",
  "Combine d/c/y with any motion:",
  "- dw cw yw — word",
  "- d$ d0 — to line end/start",
  "- 3dd — 3 lines, 2dw — 2 words, 2d3w — 6 words",
  "",
  "### Text objects",
  "",
  "i = inner, a = around:",
  "- ciw diw — word, dap yip >ip — paragraph",
  '- ci" da( — quotes, parens',
  "- Works with \" \\' ` ( ) { } [ ] < >",
  "",
  "### Search",
  "",
  "- / — search forward, ? — backward (vim regex,",
  "  case-insensitive unless the pattern has capitals)",
  "- n/N — next/prev match",
  "- * / # — word under cursor fwd/back",
  "",
  "### Commands",
  "",
  "Press : to open the command bar.",
  "- :w — save, :q — exit vim",
  "- :set wrap / :set nowrap / :set wrap!",
  "- :new — new note, :draw — new drawing, :e name — open note",
  "- :d — delete line, :42 — jump to line",
  "- :fmt — format markdown",
  "- :view — markdown preview",
  "- :help — this page",
  "- :mddemo — markdown features showcase",
  "- :s/a/b/ — replace in line, :%s/a/b/g — everywhere",
  "  :'<,'>s/… — in the visual selection (press : in visual)",
  "  vim regex: \\( \\) \\| \\+ \\< \\>, \\v very magic; \\1 & \\r",
].join("\n");
const HELP_MOBILE = [
  "# Welcome to note.",
  "",
  "A private, local-first editor for text and drawings.",
  "No data is collected, transmitted, or stored on any server.",
  "Your notes stay in your browser — nothing is sent anywhere.",
  "",
  "## Start",
  "",
  "- Tap **‹** at the top left for your notes, **+** for a new one",
  "- Tap a note's name at the top for rename, pin, zen and more",
  "- Hold a note in the list for the same actions",
  "- The key bar above the keyboard has Tab, ⇧Tab, tasks and undo",
  "",
  "## Share via URL",
  "",
  "Tap **Share** to embed a note in a link. No server, no upload —",
  "the entire note lives in the link (~60kB limit). A link someone",
  "sends you opens for reading first, and joins your notes only",
  "when you save it.",
  "",
  "## Keep it safe",
  "",
  "Browsers can clear their storage without warning.",
  "Turn on Google Drive sync or export a ZIP now and then —",
  "both in **note ▾ › Settings**.",
  "",
  "## Tips",
  "",
  "- **note ▾ › Import files…** brings in text files or a ZIP",
  "- Deleting shows Undo for a few seconds",
  "- .md files switch between Edit and Preview",
  "- Drawings: one finger draws, two fingers pan and zoom,",
  "  a two-finger tap undoes",
  "- Link between notes: [label](other.md)",
  "- Syncs across tabs automatically",
].join("\n");

const MD_DEMO = [
  "# The Lantern in the Woods",
  "",
  "Once upon a time, in a village at the edge of a **dark forest**, there lived a girl named *Elara*. She was known for two things: her ~~fear of the dark~~ courage, and her love of broken things.",
  "",
  "## The Discovery",
  "",
  "One autumn morning, Elara found a lantern half-buried in mud. It was dented, cracked, and missing its glass — but inside, a faint glow pulsed like a heartbeat.",
  "",
  '> "Things that still glow," her grandmother always said, "are never truly broken."',
  "",
  "She decided to fix it. Her supplies were simple:",
  "",
  "- One cracked lantern",
  "- A shard of glass from the old chapel",
  "- Thread spun from moonlight (or so she claimed)",
  "  - Collected on the first frost",
  "  - Stored in a tin box",
  "",
  "The steps were clear:",
  "",
  "1. Clean the rust",
  "2. Fit the glass",
  "3. Seal the cracks with beeswax",
  "",
  "### The Task List",
  "",
  "She kept track of her progress:",
  "",
  "- [x] Find the lantern",
  "- [x] Gather supplies",
  "- [ ] Repair the frame",
  "- [ ] Enter the forest",
  "",
  "## The Journey",
  "",
  "With the lantern repaired, she entered the forest. The creatures she met were catalogued by the village elders long ago:",
  "",
  "| Creature    | Temperament |  Danger | Weakness      |",
  "| ----------- | :---------: | ------: | ------------- |",
  "| Moss Fox    |   Curious   |       2 | Honey cakes   |",
  "| Thorn Owl   |   Grumpy    |       7 | Compliments   |",
  "| Root Troll  |   Sleepy    |       4 | Lullabies     |",
  "",
  "Her map of the way in, drawn right into the story:",
  "",
  "```draw",
  "draw 1",
  'r v 0 0 150 70 c=yellow f=semi "Village"',
  'e f 280 -10 170 90 c=green f=semi "Forest"',
  'm t 570 -15 170 100 c=mauve "Terminal"',
  'a a1 v f "lantern"',
  "a a2 f t c=mauve d=dash bend=-30",
  "```",
  "",
  "---",
  "",
  "## The Heart of the Forest",
  "",
  "At the center of the woods stood an ancient terminal, covered in ivy. Elara wiped the screen and began to type.",
  "",
  "```typescript",
  'const lantern = { glow: true, owner: "Elara" };',
  "",
  "function enterForest(brave: boolean): string {",
  '  if (!brave) return "Maybe tomorrow.";',
  "",
  '  const creatures = ["Moss Fox", "Thorn Owl", "Root Troll"];',
  "  for (const c of creatures) {",
  "    console.log(`Elara befriended the ${c}.`);",
  "  }",
  "",
  '  return "The forest remembered her name.";',
  "}",
  "",
  "const ending = enterForest(lantern.glow);",
  "console.log(ending);",
  "```",
  "",
  "The terminal hummed. The trees parted. And somewhere deep in the code, a `console.log` whispered her name back to her.",
  "",
  "## Epilogue",
  "",
  "<details>",
  "<summary>What happened next?</summary>",
  "",
  "She returned to the village carrying the lantern, now glowing brighter than before. The forest was no longer dark — it had only been waiting for someone to bring the light.",
  "",
  "***And so the girl who fixed broken things fixed the oldest thing of all — a forgotten story.***",
  "",
  "</details>",
  "",
  "---",
  "",
  "*Written in [note](https://note.directory/) — where all good tales begin.*",
].join("\n");

// Opens an app-provided note (help, demo). Refreshes it only while the user
// hasn't edited it — `builtin` holds the hash of what the app last wrote.
async function openBuiltinNote(name, content) {
  const hash = (text) => crc32(new TextEncoder().encode(text));
  const dot = name.lastIndexOf(".");
  const isVariant = (n) =>
    n === name ||
    (n.startsWith(name.slice(0, dot)) &&
      n.endsWith(name.slice(dot)) &&
      /^\d+$/.test(n.slice(dot, n.length - (name.length - dot))));
  const existing = state.notes.find(
    (n) =>
      isVariant(n.name) &&
      (n.content === content || n.builtin === hash(n.content)),
  );
  if (existing) {
    if (existing.content !== content) {
      existing.content = content;
      existing.updatedAt = Date.now();
    }
    existing.builtin = hash(content);
    switchNote(existing.id);
    saveState();
  } else {
    const taken = state.notes.some((n) => n.name === name);
    const note = await createNote(taken ? uniqueName(name) : name, content);
    if (note) {
      note.builtin = hash(content);
      saveState();
    }
  }
  // Built-in notes are for reading
  switchMdTab("view");
}

async function openMdDemo() {
  await openBuiltinNote("markdown-features.md", MD_DEMO);
}

async function openHelp() {
  const mobile = isMobile();
  await openBuiltinNote(
    mobile ? "help-mobile.md" : "help.md",
    mobile ? HELP_MOBILE : HELP_DESKTOP,
  );
  // Enable word wrap on mobile so help reads nicely
  if (mobile && !editorArea.classList.contains("wrap")) {
    toggleWrap();
  }
}

async function init() {
  const isFirstVisit = !(await loadState());
  if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "true" && !isMobile())
    document.querySelector(".app").classList.add("sidebar-hidden");
  loadWrap();
  applyTheme(currentTheme());
  loadVim();

  // Tabs opened in the background must not take Drive sync from the
  // tab the user is working in — they claim it on focus instead
  if (document.visibilityState === "visible") claimLeadership();

  // Back from Google's sign-in page (worker.js)
  const query = new URLSearchParams(location.search);
  const driveReturn = query.get("drive");
  if (driveReturn) {
    query.delete("drive");
    history.replaceState(
      null,
      "",
      location.pathname + (query.size ? "?" + query : ""),
    );
    if (driveReturn === "connected") {
      localStorage.setItem(GDRIVE_CONNECTED_KEY, "true");
      clearToken();
    }
  }

  // Restore Google Drive session
  // Expired tokens are refreshed silently by the first sync; if that
  // fails the user reconnects via the sync menu (never a surprise redirect)
  const tokenState = restoreToken();
  if (tokenState !== "none") {
    gdriveConnected = true;
    showSyncConnected();
    if (tokenState === "ok") scheduleTokenRefresh();
  } else if (driveReturn && driveReturn !== "connected") showSyncFailed();
  const loaded = await loadFromUrl();
  if (!loaded && state.notes.length === 0 && isFirstVisit) {
    await openBuiltinNote(
      isMobile() ? "help-mobile.md" : "help.md",
      isMobile() ? HELP_MOBILE : HELP_DESKTOP,
    );
  }
  render();
  checkMdViewParam();
  showSharedView();
  updateUrl();
  updateSyncLine();
  startTimestampRefresh();
  if (getActiveNote() && !zenModeActive) {
    const note = getActiveNote();
    editor.focus();
    // Restore cursor position after focus (focus can move cursor to end)
    const pos = Math.min(note.cursorPos ?? 0, editor.value.length);
    editor.selectionStart = editor.selectionEnd = pos;
    updateCursorPos();
    ensureCursorScrolloff();
    // Sync highlight layer and gutter after browser layout
    requestAnimationFrame(() => {
      gutter.scrollTop = editor.scrollTop;
      highlightLayer.scrollTop = editor.scrollTop;
      highlightLayer.scrollLeft = editor.scrollLeft;
      syncOccurrenceScroll();
    });
  }

  if (gdriveConnected) syncNow();
}

// Button clicks — CSP forbids inline onclick handlers
const clickActions = {
  "new-note": () => createNote(),
  "new-note-rename": () => createNote(undefined, undefined, true),
  "new-drawing": () => createNote(undefined, undefined, false, "draw"),
  "new-drawing-rename": () => createNote(undefined, undefined, true, "draw"),
  "toggle-new-menu": toggleNewMenu,
  "toggle-app-menu": toggleAppMenu,
  "toggle-note-menu": toggleNoteMenu,
  "toggle-sync-menu": toggleSyncMenu,
  "toggle-theme-menu": openThemeMenu,
  "toggle-system-theme": toggleSystemTheme,
  "toggle-share": () => openShare(),
  "rename-active": renameInTitle,
  "zen-download": zenDownload,
  "zen-save": zenSave,
  "toggle-sidebar": toggleSidebar,
  "find-next": findNext,
  "find-prev": findPrev,
  "replace-current": replaceCurrent,
  "replace-all": replaceAll,
  "close-find-replace": () => closeFindReplace(),
  "toggle-replace": toggleReplace,
  "download-all": downloadAll,
  import: openImport,
  settings: () => openSettings(),
  shortcuts: () => openSearch("all", "> "),
  search: () => openSearch(),
  help: openHelp,
  "md-demo": openMdDemo,
  "drive-sync": driveSync,
  "drive-sign-out": () => driveSignOut(),
  "tab-edit": () => switchMdTab("edit", true),
  "tab-view": () => switchMdTab("view", true),
  "tab-zen": () => switchMdTab("zen", true),
  "exit-zen": exitZenMode,
  "zen-share": zenShare,
  "toggle-vim": toggleVim,
  "toggle-wrap": toggleWrap,
  "set-theme": () => setTheme(),
};
let actionEl = null;
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  actionEl = el;
  clickActions[el.dataset.action]();
  if (el.hasAttribute("data-close-menu")) closeAllMenus();
});

init();

navigator.serviceWorker?.register("sw.js").catch(() => {});
// Notes live only in localStorage; ask the browser not to evict it.
// Firefox prompts for this, so wait until the user has written something.
const requestPersist = () => navigator.storage?.persist?.().catch(() => {});
if (navigator.userAgent.includes("Firefox"))
  editor.addEventListener("input", requestPersist, { once: true });
else requestPersist();

// Re-sync when tab becomes visible again (handles backgrounded timers)
let lastSyncCheck = 0;
async function onTabResume() {
  if (!gdriveConnected) return;
  // Debounce — visibilitychange and focus can fire together
  const now = Date.now();
  if (now - lastSyncCheck < 5000) return;
  lastSyncCheck = now;
  syncNow();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onTabResume();
  // Leaving the tab: push pending edits now instead of in 30s
  else if (gdriveConnected && driveGen !== driveSyncedGen) syncNow();
});
window.addEventListener("focus", onTabResume);

// Safari ignores interactive-widget=resizes-content, so use visualViewport API.
// Only apply on browsers that lack native support (i.e., not Chromium).
if (
  window.visualViewport &&
  !CSS.supports("interactive-widget: resizes-content")
) {
  const onViewportResize = () => {
    document.documentElement.style.height = window.visualViewport.height + "px";
  };
  window.visualViewport.addEventListener("resize", onViewportResize);
}
