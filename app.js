// ═══════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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
  if (bytes >= 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + "MB";
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

  if (entryCount > ZIP_MAX_ENTRIES)
    throw new Error("Zip has too many files");
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
      const compData = bytes.subarray(
        dataStart,
        dataStart + entry.compSize,
      );

      let data;
      if (entry.method === 0) {
        data = compData;
      } else {
        const stream = new Blob([compData])
          .stream()
          .pipeThrough(new DecompressionStream("deflate-raw"));
        data = new Uint8Array(await new Response(stream).arrayBuffer());
      }

      // Sanitize filename: strip directories, reject traversal
      let name = entry.rawName;
      if (name.includes("..")) return null;
      const slash = name.lastIndexOf("/");
      if (slash >= 0) name = name.slice(slash + 1);
      if (!name) return null;

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
const charCount = document.getElementById("charCount");
const wordCount = document.getElementById("wordCount");
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

// ═══════════════════════════════════════════════════
//  State & Storage
// ═══════════════════════════════════════════════════

const STORAGE_KEY = "notepad_data";
const SIDEBAR_WIDTH_KEY = "notepad_sidebar_width";
const WRAP_KEY = "notepad_wrap";
const VIM_KEY = "notepad_vim";
const SWAP_PREFIX = "notepad_swap_";
const TAB_LEADER_KEY = "notepad_tab_leader";
let state = { notes: [], activeId: null, deletedIds: [], deletedAt: {} };
let saveTimeout = null;
const tabId =
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
  if (!getActiveNote()) state.activeId = state.notes[0]?.id ?? null;
  return changed;
}

function activeNoteVersion() {
  const note = getActiveNote();
  return note ? note.id + ":" + note.updatedAt : "";
}

function mergeFromStorage() {
  try {
    return mergeStoredState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return false;
  }
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

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
    if (!state.deletedIds) state.deletedIds = [];
    if (!state.deletedAt) state.deletedAt = {};
  } catch {}
}

function wouldExceedStorage(extraBytes) {
  return getStorageUsed() + extraBytes > STORAGE_LIMIT;
}

function getStorageUsed() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += key.length + localStorage.getItem(key).length;
  }
  return total * 2;
}

function saveState() {
  mergeFromStorage();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    showModal(
      "Storage full. Delete some notes to free up space.",
      "ok",
      null,
    );
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

function loadSwap(noteId) {
  try {
    const raw = localStorage.getItem(swapKey(noteId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function deleteSwap(noteId) {
  localStorage.removeItem(swapKey(noteId));
}

function getActiveNote() {
  return state.notes.find((n) => n.id === state.activeId) || null;
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

async function compress(text) {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
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
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
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

async function updateUrl() {
  if (zenModeActive && zenFromUrl && zenEphemeralNote) return;
  const note = getActiveNote();
  if (!note) {
    history.replaceState(null, "", location.pathname);
    btnShare.style.display = "";
    return;
  }
  try {
    const compressed = await compress(note.content);
    const queryParams = new URLSearchParams();
    if (zenModeActive) queryParams.set("view", "zen");
    else if (mdViewActive) queryParams.set("view", "md");
    const queryStr = queryParams.toString();
    const query = queryStr ? "?" + queryStr : "";

    const hashMap = parseHashParams(location.hash);
    hashMap.set("name", note.name);
    hashMap.set("note", compressed);
    hashMap.set("ts", String(note.updatedAt));
    const full = location.pathname + query + buildHash(hashMap);
    if (full.length > URL_MAX_LENGTH) {
      // Too long — drop note content from URL, hide share
      hashMap.delete("note");
      hashMap.delete("ts");
      history.replaceState(
        { noteId: note.id, tab: currentTab() },
        "",
        location.pathname + query + buildHash(hashMap),
      );
      btnShare.style.display = "none";
    } else {
      history.replaceState(
        { noteId: note.id, tab: currentTab() },
        "",
        full,
      );
      btnShare.style.display = "";
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
      : "modal-btn";
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
    modalConfirm.textContent = confirmLabel || "create";
    modalConfirm.className = "modal-btn";
    modalCancel.textContent = "cancel";
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

function showImportModal(filename) {
  return queueModal((resolve) => {
    const previousFocus = document.activeElement;
    modalText.textContent = '"' + filename + '" already exists.';
    modalInput.style.display = "none";
    const actionsDiv = modalOverlay.querySelector(".modal-actions");
    // Hide (not replace) the shared buttons — modalConfirm/modalCancel
    // are cached references and must stay attached
    modalCancel.style.display = "none";
    modalConfirm.style.display = "none";
    const btnSkip = document.createElement("button");
    btnSkip.className = "modal-btn";
    btnSkip.textContent = "skip";
    const btnKeep = document.createElement("button");
    btnKeep.className = "modal-btn";
    btnKeep.textContent = "keep both";
    const btnOver = document.createElement("button");
    btnOver.className = "modal-btn";
    btnOver.textContent = "override";
    actionsDiv.append(btnSkip, btnKeep, btnOver);
    modalOverlay.classList.add("visible");

    let removeTrap;
    function cleanup() {
      if (removeTrap) removeTrap();
      modalOverlay.classList.remove("visible");
      btnSkip.remove();
      btnKeep.remove();
      btnOver.remove();
      modalConfirm.style.display = "";
      modalOverlay.removeEventListener("click", onOverlay);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    function onOverlay(e) {
      if (e.target === modalOverlay) {
        cleanup();
        resolve("skip");
      }
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve("skip");
      }
    }
    removeTrap = trapFocus(modalOverlay, onKey);
    btnSkip.addEventListener("click", () => {
      cleanup();
      resolve("skip");
    });
    btnKeep.addEventListener("click", () => {
      cleanup();
      resolve("keep-both");
    });
    btnOver.addEventListener("click", () => {
      cleanup();
      resolve("override");
    });
    modalOverlay.addEventListener("click", onOverlay);
    btnSkip.focus();
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

function pushHistory(id, content) {
  const h = getHistory(id);
  const lastContent = h.past.length
    ? h.past[h.past.length - 1].content
    : null;
  if (content === lastContent) return;
  h.past.push({ content });
  if (h.past.length > 200) h.past.shift();
  h.future = [];
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
  while (
    h.past.length &&
    h.past[h.past.length - 1].content === oldContent
  ) {
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
  if (vimState.enabled) {
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
}

function redo() {
  const note = getActiveNote();
  if (!note) return;
  cancelHistorySnapshot();
  const h = getHistory(note.id);
  if (!h.future.length) return;
  const oldContent = editor.value;
  h.past.push({ content: oldContent });
  if (h.past.length > 200) h.past.shift();
  const entry = h.future.pop();
  editor.value = entry.content;
  const diffPos = findFirstDiff(oldContent, entry.content);
  editor.selectionStart = editor.selectionEnd = Math.min(
    diffPos,
    entry.content.length,
  );
  if (vimState.enabled) {
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

function buildHTML(code, tokens) {
  let r = "",
    p = 0;
  for (const t of tokens) {
    if (t.s > p) r += escapeHtml(code.substring(p, t.s));
    r += `<span class="${t.cls}">${escapeHtml(t.t)}</span>`;
    p = t.e;
  }
  if (p < code.length) r += escapeHtml(code.substring(p));
  return r;
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
  [/[a-z\-]+(?=\s*:\s)/g, "hl-fn"],
  [/[{}();:,]/g, "hl-punc"],
];

const htmlBaseRules = [
  [/<!DOCTYPE\b[^>]*/gi, "hl-tag"],
  [/<!--[\s\S]*?-->/g, "hl-cmt"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/<\/?[a-zA-Z][a-zA-Z0-9\-]*/g, "hl-tag"],
  [/\/?>/g, "hl-tag"],
  [/\b[a-zA-Z\-:]+(?==)/g, "hl-attr"],
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
  [/\[([^\]]+)\]\([^)]+\)/g, "hl-link"],
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
  [/\[+[^\]]*\]+/g, "hl-tag"],
  [/^[a-zA-Z_][a-zA-Z0-9_\-]*(?=\s*=)/gm, "hl-key"],
  [/"""[\s\S]*?"""/g, "hl-str"],
  [/"(?:[^"\\]|\\.)*"/g, "hl-str"],
  [/'(?:[^'\\]|\\.)*'/g, "hl-str"],
  [/\b(true|false)\b/g, "hl-kw"],
  [/\b\d+(?:\.\d+)?\b/g, "hl-num"],
];

// --- Extension → rules mapping ---

const langRules = {
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
  return buildHTML(code, merged);
}

function highlightCode(code, name) {
  try {
    const ext = getExtension(name);
    if (htmlExts.has(ext)) return highlightHTML(code);
    const rules = langRules[ext];
    if (!rules) return escapeHtml(code);
    return buildHTML(code, tokenize(code, rules));
  } catch (e) {
    console.error("Highlight error:", e);
    return escapeHtml(code);
  }
}

function updateHighlight() {
  const note = getActiveNote();
  if (!note) {
    highlightLayer.innerHTML = "";
    return;
  }
  highlightLayer.innerHTML =
    highlightCode(editor.value, note.name) + "\n";
}

let highlightTimeout = null;
function scheduleHighlight() {
  clearTimeout(highlightTimeout);
  highlightTimeout = setTimeout(updateHighlight, 30);
}

// ═══════════════════════════════════════════════════
//  Rendering
// ═══════════════════════════════════════════════════

let currentLine = 1;

// Reusable measurement element for wrapped line heights
const _wrapMeasure = document.createElement("div");
_wrapMeasure.style.position = "absolute";
_wrapMeasure.style.visibility = "hidden";
_wrapMeasure.style.height = "auto";
_wrapMeasure.style.padding = "0";
_wrapMeasure.style.border = "none";
_wrapMeasure.style.whiteSpace = "pre-wrap";
_wrapMeasure.style.overflowWrap = "break-word";

let _gutterLineCount = 0;
let _wrapMeasureRAF = 0;

function updateLineNumbers() {
  const text = editor.value || "";
  const lineCount = Math.max((text.match(/\n/g) || []).length + 1, 1);
  const wrapOn = editorArea.classList.contains("wrap");

  if (!wrapOn) {
    // Only rebuild gutter DOM if line count changed
    if (lineCount !== _gutterLineCount) {
      _gutterLineCount = lineCount;
      let html = "";
      for (let i = 1; i <= lineCount; i++) {
        html += `<div class="gutter-line${i === currentLine ? " active" : ""}">${i}</div>`;
      }
      gutter.innerHTML = html;
    }
    return;
  }

  // Wrap mode: debounce expensive measurement to next frame
  cancelAnimationFrame(_wrapMeasureRAF);
  _wrapMeasureRAF = requestAnimationFrame(() => {
    _measureWrappedLines(text);
  });
}

function _measureWrappedLines(text) {
  const lines = text.split("\n");
  const cs = window.getComputedStyle(editor);
  const contentWidth =
    editor.clientWidth -
    parseFloat(cs.paddingLeft) -
    parseFloat(cs.paddingRight);

  _wrapMeasure.style.font = cs.font;
  _wrapMeasure.style.letterSpacing = cs.letterSpacing;
  _wrapMeasure.style.tabSize = cs.tabSize;
  _wrapMeasure.style.lineHeight = cs.lineHeight;
  _wrapMeasure.style.width = contentWidth + "px";
  document.body.appendChild(_wrapMeasure);

  let html = "";
  for (let i = 0; i < lines.length; i++) {
    _wrapMeasure.textContent = lines[i] || " ";
    const h = _wrapMeasure.offsetHeight;
    const isActive = i + 1 === currentLine;
    html += `<div class="gutter-line${isActive ? " active" : ""}" style="height:${h}px">${i + 1}</div>`;
  }

  document.body.removeChild(_wrapMeasure);
  _gutterLineCount = lines.length;
  gutter.innerHTML = html;
}

// Update only the active gutter line highlight without rebuilding DOM
function updateGutterActive() {
  const gutterLines = gutter.querySelectorAll(".gutter-line");
  gutterLines.forEach((el, i) => {
    el.classList.toggle("active", i + 1 === currentLine);
  });
}

const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB
const storageUsage = document.getElementById("storageUsage");

function updateStorageUsage() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += key.length + localStorage.getItem(key).length;
  }
  const bytes = total * 2;
  if (bytes < 200 * 1024) {
    storageUsage.innerHTML = "";
    storageUsage.title = "";
    return;
  }
  const pct = Math.min((bytes / STORAGE_LIMIT) * 100, 100);
  const label =
    bytes >= 1024 * 1024
      ? (bytes / (1024 * 1024)).toFixed(1) + "MB"
      : (bytes / 1024).toFixed(0) + "kB";
  const cls = pct >= 90 ? " critical" : pct >= 70 ? " warn" : "";
  storageUsage.innerHTML = `<span class="storage-bar"><span class="storage-fill${cls}" style="width:${pct}%"></span></span>${label} (${pct.toFixed(0)}%)`;
  storageUsage.title = `localStorage: ${label} / 5MB`;
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

// Build a flat text-node map of the highlight layer for Range-based positioning
function buildTextNodeMap() {
  const nodes = [];
  const walker = document.createTreeWalker(
    highlightLayer,
    NodeFilter.SHOW_TEXT,
  );
  let charOffset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    nodes.push({ node, start: charOffset, end: charOffset + len });
    charOffset += len;
  }
  return nodes;
}

function findNodeAtOffset(nodeMap, offset) {
  let lo = 0,
    hi = nodeMap.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nodeMap[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  const entry = nodeMap[lo];
  if (!entry) return null;
  return { node: entry.node, offset: offset - entry.start };
}

function updateOccurrenceMarkers() {
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

  // Skip if same query
  if (selected === lastOccurrenceQuery) return;
  lastOccurrenceQuery = selected;

  const positions = findAll(text, selected).map((m) => m.start);

  if (positions.length < 2) {
    occurrenceTrack.innerHTML = "";
    occurrenceOverlay.innerHTML = "";
    return;
  }

  // Build line-start index for track markers
  const lineStarts = [0];
  for (let j = 0; j < text.length; j++) {
    if (text.charCodeAt(j) === 10) lineStarts.push(j + 1);
  }
  const totalLines = lineStarts.length;
  const trackHeight = occurrenceTrack.clientHeight;
  if (totalLines === 0 || trackHeight === 0) {
    occurrenceTrack.innerHTML = "";
    occurrenceOverlay.innerHTML = "";
    return;
  }

  function lineOf(pos) {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const selLen = selected.length;

  // Use highlight layer's rendered text for pixel-perfect positioning
  const nodeMap = buildTextNodeMap();
  const layerRect = highlightLayer.getBoundingClientRect();
  const scrollLeft = highlightLayer.scrollLeft;
  const scrollTop = highlightLayer.scrollTop;
  let trackHtml = "";
  let overlayHtml = "";
  const range = document.createRange();

  for (let i = 0; i < positions.length; i++) {
    const line = lineOf(positions[i]);
    const top = Math.round((line / totalLines) * trackHeight);
    trackHtml +=
      '<div class="occurrence-marker" style="top:' + top + 'px"></div>';

    if (positions[i] !== start) {
      const startInfo = findNodeAtOffset(nodeMap, positions[i]);
      const endInfo = findNodeAtOffset(nodeMap, positions[i] + selLen);
      if (startInfo && endInfo) {
        range.setStart(startInfo.node, startInfo.offset);
        range.setEnd(endInfo.node, endInfo.offset);
        const rects = range.getClientRects();
        for (let r = 0; r < rects.length; r++) {
          const rect = rects[r];
          const x = rect.left - layerRect.left + scrollLeft;
          const y = rect.top - layerRect.top + scrollTop;
          overlayHtml +=
            '<div class="occurrence-highlight" style="top:' +
            y +
            "px;left:" +
            x +
            "px;width:" +
            rect.width +
            "px;height:" +
            (rect.height + 1) +
            'px"></div>';
        }
      }
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

let cursorSaveTimeout = null;
function updateCursorPos() {
  const val = editor.value || "";
  const pos = editor.selectionStart;
  const note = getActiveNote();
  if (note) {
    note.cursorPos = pos;
    clearTimeout(cursorSaveTimeout);
    cursorSaveTimeout = setTimeout(saveState, 1000);
  }
  const before = val.substring(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  currentLine = line;
  if (vimState.enabled) {
    if (typeof vimCursorMoving === "function") vimCursorMoving();
    const m = vimState.mode.toUpperCase();
    const dirty = vimState.bufferDirty
      ? '<span class="vim-dirty-indicator">[+]</span>'
      : "";
    cursorPos.innerHTML =
      '<span class="vim-mode-' +
      vimState.mode +
      '">' +
      m +
      "</span>" +
      dirty +
      "Ln " +
      line +
      ", Col " +
      col;
  } else {
    cursorPos.textContent = "Ln " + line + ", Col " + col;
  }
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

function startRename(noteId) {
  const item = noteList.querySelector(`.note-item[data-id="${noteId}"]`);
  if (!item) return;
  const input = item.querySelector(".note-item-input");
  if (!input) return;
  input.classList.add("editing");
  input.focus();
  const dot = input.value.lastIndexOf(".");
  if (dot > 0) {
    input.setSelectionRange(0, dot);
  } else {
    input.select();
  }
}

function renderNoteList() {
  noteList.innerHTML = "";
  sortNotes();
  for (let ni = 0; ni < state.notes.length; ni++) {
    const note = state.notes[ni];
    const div = document.createElement("div");
    div.className =
      "note-item" + (note.id === state.activeId ? " active" : "");
    div.setAttribute("role", "listitem");
    div.draggable = true;
    div.dataset.idx = ni;
    div.dataset.id = note.id;

    // Drag handlers
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
    div.addEventListener("dragleave", () => {
      div.classList.remove("drag-over");
    });
    div.addEventListener("drop", (e) => {
      e.preventDefault();
      div.classList.remove("drag-over");
      const fromIdx = dragSrcIdx;
      const toIdx = ni;
      if (fromIdx === null || fromIdx === toIdx) return;
      const [moved] = state.notes.splice(fromIdx, 1);
      state.notes.splice(toIdx, 0, moved);
      saveState();
      renderNoteList();
    });

    // Click on row to switch note
    div.addEventListener("click", (e) => {
      if (
        e.target.closest(".btn-pin") ||
        e.target.closest(".btn-delete") ||
        e.target.closest(".btn-rename") ||
        e.target.classList.contains("note-item-input")
      )
        return;
      if (state.activeId !== note.id) {
        switchNote(note.id);
      } else if (isMobile()) {
        sidebar.classList.remove("open");
        document.querySelector(".app").classList.remove("sidebar-open");
        editor.focus();
      } else {
        startRename(note.id);
      }
    });

    // Meta container (name + timestamp)
    const meta = document.createElement("div");
    meta.className = "note-item-meta";

    // Hidden input for new-file inline naming
    const input = document.createElement("input");
    input.className = "note-item-input";
    input.name = "filename";
    input.value = note.name;
    input.spellcheck = false;
    input.addEventListener("input", () => {
      note.name = input.value.trim() || "untitled";
      note.updatedAt = Date.now();
      scheduleSave();
      scheduleUrlUpdate();
      scheduleHighlight();
      updateTitle();
      updateMdTabBar();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
        editor.focus();
      }
    });
    input.addEventListener("blur", () => {
      input.classList.remove("editing");
      const name = input.value.trim() || "untitled";
      if (name === note.name) return renderNoteList();
      note.name = name;
      note.updatedAt = Date.now();
      saveState();
      scheduleDriveUpload(true);
      renderNoteList();
    });
    meta.appendChild(input);

    // Display name with middle-ellipsis
    const nameSpan = document.createElement("span");
    nameSpan.className = "note-item-name";
    const endLen = 8;
    const split = Math.max(note.name.length - endLen, 1);
    const startSpan = document.createElement("span");
    startSpan.className = "note-item-name-start";
    startSpan.textContent = note.name.slice(0, split);
    const endSpan = document.createElement("span");
    endSpan.className = "note-item-name-end";
    endSpan.textContent = note.name.slice(split);
    nameSpan.append(startSpan, endSpan);
    meta.appendChild(nameSpan);

    // Timestamp
    const timeEl = document.createElement("div");
    timeEl.className = "note-item-time";
    timeEl.textContent =
      relativeTime(note.updatedAt) +
      (note.content ? ", " + formatSize(note.content) : "");
    meta.appendChild(timeEl);

    // Pin button
    const pinBtn = document.createElement("button");
    pinBtn.className = "btn-pin" + (note.pinned ? " pinned" : "");
    pinBtn.title = note.pinned ? "Unpin" : "Pin";
    pinBtn.setAttribute(
      "aria-label",
      (note.pinned ? "Unpin " : "Pin ") + note.name,
    );
    pinBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01z"/></svg>';
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      note.pinned = !note.pinned;
      note.updatedAt = Date.now();
      saveState();
      renderNoteList();
    });

    // Rename button (touch devices only via CSS)
    const renameBtn = document.createElement("button");
    renameBtn.className = "btn-rename";
    renameBtn.title = "Rename";
    renameBtn.setAttribute("aria-label", "Rename " + note.name);
    renameBtn.innerHTML = "&#9998;";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startRename(note.id);
    });

    // Delete button
    const btn = document.createElement("button");
    btn.className = "btn-delete";
    btn.title = "Delete";
    btn.setAttribute("aria-label", "Delete " + note.name);
    btn.innerHTML = "&times;";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDelete(note.id);
    });

    div.appendChild(pinBtn);
    div.appendChild(meta);
    div.appendChild(renameBtn);
    div.appendChild(btn);
    noteList.appendChild(div);
  }
}

// Refresh timestamps periodically
let timestampInterval = null;
function startTimestampRefresh() {
  clearInterval(timestampInterval);
  timestampInterval = setInterval(() => {
    const times = noteList.querySelectorAll(".note-item-time");
    const sorted = state.notes.slice();
    sortNotes();
    times.forEach((el, i) => {
      if (state.notes[i])
        el.textContent =
          relativeTime(state.notes[i].updatedAt) +
          ", " +
          formatSize(state.notes[i].content);
    });
  }, 30000);
}

function updateTitle() {
  const note = getActiveNote();
  document.title = note
    ? note.name + " \u00b7 note \u2014 minimal text editor"
    : "note \u2014 minimal text editor";
}

function render() {
  renderNoteList();
  renderEditor();
  updateLineNumbers();
  updateCursorPos();
  updateTitle();
  updateStorageUsage();
  updateMdTabBar();
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
          if (aligns[c] === "center")
            line += " :" + dashes.slice(2) + ": |";
          else if (aligns[c] === "right")
            line += " " + dashes.slice(1) + ": |";
          else line += " " + dashes + " |";
        } else {
          const cell = rows[r][c] || "";
          if (aligns[c] === "right")
            line += " " + cell.padStart(widths[c]) + " |";
          else if (aligns[c] === "center") {
            const pad = widths[c] - cell.length;
            const left = Math.floor(pad / 2);
            line +=
              " " +
              " ".repeat(left) +
              cell +
              " ".repeat(pad - left) +
              " |";
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
    const isListStart =
      cur.type === "list" && (!prev || prev.type !== "list");
    const isCodeStart =
      cur.type === "code" && (!prev || prev.type !== "code");
    const needsBlankBefore =
      blockTypes.has(cur.type) ||
      isTableStart ||
      isListStart ||
      isCodeStart;

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
    const isListEnd =
      cur.type === "list" && (!next || next.type !== "list");
    const isCodeEnd =
      cur.type === "code" && (!next || next.type !== "code");
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
      codeBlocks.push(
        '<pre><button class="code-copy-btn">copy</button><code>' +
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
  text = text.replace(/^######[ \t]+(.+)$/gm, (_, t) =>
    makeHeading(6, t),
  );
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
        let isChecked = false;
        // Check for task list
        const taskChecked = content.match(/^\[x\]\s+(.*)/);
        const taskUnchecked = content.match(/^\[\s\]\s+(.*)/);
        if (taskChecked) {
          isTask = true;
          isChecked = true;
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
        i++;
        // Fold continuation lines (indented text that isn't a new list item)
        while (
          i < lines.length &&
          !listRe.test(lines[i]) &&
          lines[i].match(/^\s+\S/)
        ) {
          itemHtml += "<br>" + lines[i].trim();
          i++;
        }
        if (isTask) {
          itemHtml += "</span>";
          const cls = "task-item" + (isChecked ? " checked" : "");
          html +=
            '<li class="' +
            cls +
            '" data-task="' +
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
            .map(
              (c, i) => "<td" + alignAttr(i) + ">" + c.trim() + "</td>",
            )
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

  // Bold & italic
  text = text.replace(
    /(?<![a-zA-Z0-9])\*\*\*(.+?)\*\*\*(?![a-zA-Z0-9])/g,
    "<strong><em>$1</em></strong>",
  );
  text = text.replace(
    /(?<![a-zA-Z0-9])\*\*(.+?)\*\*(?![a-zA-Z0-9])/g,
    "<strong>$1</strong>",
  );
  text = text.replace(
    /(?<![a-zA-Z0-9])\*(.+?)\*(?![a-zA-Z0-9])/g,
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
  text = text.replace(
    /(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g,
    "<em>$1</em>",
  );

  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Paragraphs: wrap standalone lines that aren't already block elements
  const lines = text.split("\n");
  let result = "";
  let inParagraph = false;
  const blockTag =
    /^<(h[1-6]|ul|ol|li|blockquote|pre|hr|table|thead|tbody|tr|th|td|\x00)/;
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
  text = text.replace(
    /<a href="([^"]*)" title="[^"]*"/g,
    (m, href) => (!href.includes("<") && isSafeHref(href) ? m : "<a"),
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

function updateMdTabBar() {
  const note = getActiveNote();
  const isMd = note && isMarkdownFile(note.name);
  const zenEphemeral = zenModeActive && zenFromUrl && zenEphemeralNote;
  mdTabs.classList.toggle("visible", isMd || zenEphemeral);
  if (!isMd && !zenEphemeral && mdViewActive) {
    switchMdTab("edit");
  }
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
  zenModeActive = tab === "zen";
  mdViewActive = tab === "view" || tab === "zen";
  mdTabEdit.classList.toggle("active", tab === "edit");
  mdTabView.classList.toggle("active", tab === "view");
  document
    .getElementById("mdTabZen")
    .classList.toggle("active", tab === "zen");
  mdTabEdit.setAttribute("aria-selected", tab === "edit");
  mdTabView.setAttribute("aria-selected", tab === "view");
  document
    .getElementById("mdTabZen")
    .setAttribute("aria-selected", tab === "zen");

  const appEl = document.querySelector(".app");
  const zenBar = document.getElementById("zenBar");
  const btnReplace = document.getElementById("btnReplace");

  // Task checkbox handler shared by view and zen
  function attachCheckboxHandler() {
    mdPreview.onclick = (e) => {
      const li = e.target.closest("li.task-item");
      const input =
        e.target.tagName === "INPUT" &&
        e.target.dataset.task !== undefined
          ? e.target
          : null;
      if (!li && !input) return;
      e.preventDefault();

      // In zen mode, persist the note first if ephemeral
      if (zenModeActive && zenFromUrl && zenEphemeralNote) {
        persistZenNote();
      }

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
              .replace(TASK_RE, (_, prefix) => prefix + (checked ? "[x]" : "[ ]"));
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
      mdPreview.innerHTML = zenModeActive
        ? `<div class="zen-wrap">${rendered}</div>`
        : rendered;
    };
  }

  if (zenModeActive) {
    // Render preview from ephemeral note or active note
    const content =
      zenFromUrl && zenEphemeralNote
        ? zenEphemeralNote.content
        : getActiveNote()?.content || "";
    mdPreview.innerHTML = `<div class="zen-wrap">${renderMarkdown(content)}</div>`;
    attachCheckboxHandler();
    // Hide editor elements, show preview
    gutter.style.display = "none";
    editorArea.style.display = "none";
    emptyState.style.display = "none";
    mdPreview.classList.add("visible");
    // Hide all chrome, show zen bar
    appEl.classList.add("zen-mode");
    const zenName =
      (zenFromUrl && zenEphemeralNote
        ? zenEphemeralNote.name
        : getActiveNote()?.name) || "untitled";
    const zenEl = document.getElementById("zenBarFilename");
    const zenEndLen = 8;
    const zenSplit = Math.max(zenName.length - zenEndLen, 1);
    zenEl.querySelector(".zen-bar-filename-start").textContent =
      zenName.slice(0, zenSplit);
    zenEl.querySelector(".zen-bar-filename-end").textContent =
      zenName.slice(zenSplit);
    zenBar.style.display = "";
    document.getElementById("zenShareBtn").style.display = "";
  } else if (tab === "view") {
    const note = getActiveNote();
    if (note) {
      mdPreview.innerHTML = renderMarkdown(note.content);
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
    btnReplace.style.display = "none";
    btnWrap.style.display = "none";
    cursorPos.style.display = "none";
    btnVim.style.display = "none";
    appEl.classList.remove("zen-mode");
    zenBar.style.display = "none";
    document.getElementById("zenShareBtn").style.display = "none";
    // Scroll preview so cursor area is centered
    requestAnimationFrame(() => {
      const scrollMax = mdPreview.scrollHeight - mdPreview.clientHeight;
      if (scrollMax > 0) {
        const target =
          cursorRatio * mdPreview.scrollHeight -
          mdPreview.clientHeight / 2;
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
    btnReplace.style.display = "";
    btnWrap.style.display = "";
    cursorPos.style.display = "";
    btnVim.style.display = "";
    appEl.classList.remove("zen-mode");
    zenBar.style.display = "none";
    document.getElementById("zenShareBtn").style.display = "none";
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
    for (let i = 0; i < targetLine; i++)
      charOffset += lines[i].length + 1;
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
        createdAt: now,
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
      createdAt: now,
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

function exitZenMode() {
  persistZenNote();
  switchMdTab("edit", true);
  render();
  updateUrl();
}

async function zenShare() {
  try {
    const hashMap = parseHashParams(location.hash);
    hashMap.delete("anchor");
    const shareUrl =
      location.origin +
      location.pathname +
      location.search +
      buildHash(hashMap);
    await navigator.clipboard.writeText(shareUrl);
    const label = document.getElementById("zenCopied");
    label.classList.add("visible");
    setTimeout(() => label.classList.remove("visible"), 2000);
  } catch (err) {
    console.error("Share failed:", err);
  }
}

function updateMdViewUrl() {
  const params = new URLSearchParams();
  if (zenModeActive) params.set("view", "zen");
  else if (mdViewActive) params.set("view", "md");
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
      (getActiveNote() && isMarkdownFile(getActiveNote().name))
    ) {
      switchMdTab("zen");
      if (anchor) {
        requestAnimationFrame(() => {
          const el = mdPreview.querySelector("#" + CSS.escape(anchor));
          if (el) el.scrollIntoView({ behavior: "smooth" });
        });
      }
    }
  } else if (viewParam === "md") {
    const note = getActiveNote();
    if (note && isMarkdownFile(note.name)) {
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
  } else if (mdViewActive) {
    switchMdTab("edit");
  }
  if (!skipUrlUpdate) updateUrl();
  editor.scrollTop = 0;
  gutter.scrollTop = 0;
  highlightLayer.scrollTop = 0;
  highlightLayer.scrollLeft = 0;
  syncOccurrenceScroll();
}

// Toast helper for markdown preview
const mdToast = document.getElementById("mdToast");
let mdToastTimer = null;
function showMdToast(msg) {
  mdToast.textContent = msg;
  mdToast.classList.add("visible");
  clearTimeout(mdToastTimer);
  mdToastTimer = setTimeout(
    () => mdToast.classList.remove("visible"),
    2000,
  );
}

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
    null,
    "",
    location.pathname + location.search + newHash,
  );
  const heading = anchor.closest("h1,h2,h3,h4,h5,h6");
  if (heading) heading.scrollIntoView({ behavior: "smooth" });
  const fullUrl =
    location.origin + location.pathname + location.search + newHash;
  navigator.clipboard.writeText(fullUrl).then(() => {
    showMdToast("copied to clipboard");
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
    showMdToast("copied to clipboard");
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 2000);
  });
});

// Intercept clicks on local note links in preview
mdPreview.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || a.classList.contains("heading-anchor")) return;
  const href = a.getAttribute("href");
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
      null,
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
    const wantView = isMarkdownFile(target.name);
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
  if (!note || !isMarkdownFile(note.name)) {
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
    // Fallback: try to find note by name in hash
    const hashMap = parseHashParams(location.hash);
    const name = hashMap.get("name");
    if (name) {
      const note = state.notes.find((n) => n.name === name);
      if (note) {
        const viewParam = new URLSearchParams(location.search).get(
          "view",
        );
        const tab =
          viewParam === "zen"
            ? "zen"
            : viewParam === "md"
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
    }
  }
});

// ═══════════════════════════════════════════════════
//  Notes CRUD
// ═══════════════════════════════════════════════════

function nextNoteName() {
  let num = 1;
  while (state.notes.some((n) => n.name === `note${num}.md`)) num++;
  return `note${num}.md`;
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

async function createNote(name, content, focusName) {
  if (!name && isMobile()) {
    const result = await showPromptModal("Filename:", nextNoteName());
    if (!result) return null;
    name = result;
  }
  const contentStr = content || "";
  const estimatedBytes =
    (name || "").length * 2 + contentStr.length * 2 + 200;
  if (wouldExceedStorage(estimatedBytes)) {
    showModal(
      "Not enough storage space. Delete some notes to free up space.",
      "ok",
      null,
    );
    return null;
  }
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name || nextNoteName(),
    content: contentStr,
    updatedAt: Date.now(),
  };
  state.notes.unshift(note);
  state.activeId = note.id;
  saveState();
  scheduleDriveUpload(true);
  if (mdViewActive) switchMdTab("edit");
  render();
  if (focusName && !isMobile()) {
    const input = noteList.querySelector(
      ".note-item.active .note-item-input",
    );
    if (input) {
      input.classList.add("editing");
      input.focus();
      const dot = input.value.lastIndexOf(".");
      if (dot > 0) {
        input.setSelectionRange(0, dot);
      } else {
        input.select();
      }
    }
  } else {
    editor.focus();
  }
  return note;
}

async function confirmDelete(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  if (note.content) {
    const confirmed = await showModal(
      `Delete "${note.name}"?`,
      "delete",
      "cancel",
      true,
    );
    if (!confirmed) return;
  }
  const idx = state.notes.findIndex((n) => n.id === id);
  if (idx === -1) return;
  deleteSwap(id);
  delete histories[id];
  state.deletedIds.push(id);
  state.deletedAt[id] = Date.now();
  state.notes.splice(idx, 1);
  if (state.activeId === id) {
    state.activeId = state.notes.length ? state.notes[0].id : null;
    vimState.bufferDirty = false;
  }
  saveState();
  scheduleDriveUpload(true);
  render();
  updateUrl();
}

function switchNote(id) {
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
    if (targetNote && isMarkdownFile(targetNote.name)) {
      mdPreview.innerHTML = renderMarkdown(targetNote.content);
    } else {
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
  sidebar.classList.remove("open");
  document.querySelector(".app").classList.remove("sidebar-open");
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

// On mobile Safari, tapping a button while the editor is focused
// just blurs the editor on the first tap — the click never fires.
// Blurring on touchstart ensures the click registers on the same tap.
document
  .querySelector(".statusbar")
  .addEventListener("touchstart", () => {
    editor.blur();
  });

function toggleSidebar() {
  sidebar.classList.toggle("open");
  document
    .querySelector(".app")
    .classList.toggle("sidebar-open", sidebar.classList.contains("open"));
  if (!sidebar.classList.contains("open")) editor.focus();
}

function togglePin(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  note.pinned = !note.pinned;
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

function openSearch() {
  searchPreviousFocus = document.activeElement;
  searchResults.classList.add("visible");
  searchBackdrop.classList.add("visible");
  searchInput.value = "";
  searchCount.textContent = "";
  searchResultsList.innerHTML = "";
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

function searchNotes(query) {
  if (!query.trim()) {
    searchCount.textContent = "";
    searchResultsList.innerHTML = "";
    searchSelectedIdx = -1;
    return;
  }
  const results = [];
  for (const note of state.notes) {
    const nameMatch = matchLine(note.name, query);
    const lines = note.content.split("\n");
    const lineLimit = Math.min(lines.length, MAX_LINES_PER_NOTE);
    const lineMatches = [];
    for (let i = 0; i < lineLimit; i++) {
      const m = matchLine(lines[i], query);
      if (m) {
        let offset = 0;
        for (let j = 0; j < i; j++) offset += lines[j].length + 1;
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

    if (totalScore > 0) {
      results.push({
        note,
        score: totalScore + activeBoost,
        nameMatch,
        lines: topLines,
      });
    }
    if (results.length >= MAX_RESULTS * 2) break;
  }
  results.sort((a, b) => b.score - a.score);
  results.length = Math.min(results.length, MAX_RESULTS);
  showSearchResults(results);
}

function showSearchResults(results) {
  searchResults.classList.add("visible");
  searchBackdrop.classList.add("visible");
  searchCount.textContent =
    results.length + " result" + (results.length !== 1 ? "s" : "");
  searchResultsList.innerHTML = "";
  searchSelectedIdx = -1;
  if (results.length === 0) {
    searchResultsList.innerHTML =
      '<div class="search-no-results">no matches</div>';
    return;
  }
  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri];
    const div = document.createElement("div");
    div.className = "search-result-item";
    div.dataset.idx = ri;
    const nameDiv = document.createElement("div");
    nameDiv.className = "search-result-name";
    if (r.nameMatch) {
      nameDiv.innerHTML = highlightFuzzy(
        r.note.name,
        r.nameMatch.indices,
      );
    } else {
      nameDiv.textContent = r.note.name;
    }
    div.appendChild(nameDiv);
    const linesToShow = r.lines.length ? r.lines : [];
    for (const lm of linesToShow) {
      const snippetDiv = document.createElement("div");
      snippetDiv.className = "search-result-snippet";
      const prefix = lm.lineNum + ": ";
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
          (start > 0 ? "\u2026" : "") +
          snippetText.slice(start, end) +
          (end < lm.line.length ? "\u2026" : "");
        // Shift indices to match the sliced text
        const offset = start - (start > 0 ? 1 : 0);
        indices = indices
          .map((i) => i - start + (start > 0 ? 1 : 0))
          .filter((i) => i >= 0 && i < snippetText.length);
      }
      snippetDiv.innerHTML =
        '<span style="color:var(--gutter)">' +
        escapeHtml(prefix) +
        "</span>" +
        highlightFuzzy(snippetText, indices);
      div.appendChild(snippetDiv);
    }
    const target = linesToShow[0] || null;
    div.addEventListener("click", () => {
      const query = searchInput.value.trim();
      // Auto-save dirty vim buffer before switching
      if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
      switchNote(r.note.id);
      closeSearch();
      searchInput.value = "";
      editor.focus();
      if (target && target.charOffset > 0) {
        editor.setSelectionRange(target.charOffset, target.charOffset);
      }
      // Populate find state like vim / search so n/N work
      if (query) {
        findInput.value = query;
        vimState.searchDirection = 1;
        updateFindMatches();
        if (findMatches.length) selectFindMatch(true);
        updateCursorPos();
      }
    });
    searchResultsList.appendChild(div);
  }
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
  searchDebounce = setTimeout(() => searchNotes(searchInput.value), 150);
});

searchInput.addEventListener("keydown", (e) => {
  const items = searchResultsList.querySelectorAll(".search-result-item");
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
      searchSelectedIdx =
        (searchSelectedIdx - 1 + items.length) % items.length;
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
    const selected = items[searchSelectedIdx] || items[0];
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

function openFindReplace() {
  findReplaceBar.classList.add("visible");
  findInput.value = "";
  replaceInput.value = "";
  findReplaceCount.textContent = "";
  findMatches = [];
  findMatchIdx = -1;
  findInput.focus();

  // If there's a selection, pre-fill find input
  const sel = editor.value.substring(
    editor.selectionStart,
    editor.selectionEnd,
  );
  if (sel && !sel.includes("\n")) {
    findInput.value = sel;
    updateFindMatches();
  }
}

function closeFindReplace() {
  findReplaceBar.classList.remove("visible");
  findMatches = [];
  findMatchIdx = -1;
  findReplaceCount.textContent = "";
  editor.focus();
}

// select=false only refreshes offsets (after edits) without moving the cursor
function updateFindMatches(select = true) {
  const query = findInput.value;
  findMatches = [];
  findMatchIdx = -1;
  if (!query) {
    findReplaceCount.textContent = "";
    return;
  }
  findMatches = findAll(editor.value, query);
  if (findMatches.length === 0) {
    findReplaceCount.textContent = "0 matches";
    return;
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
  else findReplaceCount.textContent = findMatches.length + " matches";
}

function selectFindMatch(focusEditor) {
  if (findMatchIdx < 0 || findMatchIdx >= findMatches.length) return;
  const m = findMatches[findMatchIdx];
  editor.setSelectionRange(m.start, m.end);
  // Scroll the match into view by temporarily focusing the editor
  // (focus triggers native caret-scroll), then return focus to find input.
  editor.focus();
  // Compute the line of the match and scroll to it
  const textBefore = editor.value.substring(0, m.start);
  const line = textBefore.split("\n").length - 1;
  const lineHeight =
    parseFloat(getComputedStyle(editor).lineHeight) || 20;
  const targetScroll = line * lineHeight - editor.clientHeight / 2;
  editor.scrollTop = Math.max(0, targetScroll);
  gutter.scrollTop = editor.scrollTop;
  highlightLayer.scrollTop = editor.scrollTop;
  syncOccurrenceScroll();
  if (!focusEditor) findInput.focus();
  findReplaceCount.textContent =
    findMatchIdx + 1 + " of " + findMatches.length;
}

function findNext() {
  if (!findMatches.length) {
    updateFindMatches();
    return;
  }
  // After edits findMatchIdx points at the first match after the cursor
  if (isFindMatchSelected())
    findMatchIdx = (findMatchIdx + 1) % findMatches.length;
  selectFindMatch(true);
}

function findPrev() {
  if (!findMatches.length) {
    updateFindMatches();
    return;
  }
  findMatchIdx =
    (findMatchIdx - 1 + findMatches.length) % findMatches.length;
  selectFindMatch(true);
}

function replaceCurrent() {
  updateFindMatches(false);
  // Only replace what the user can see selected; otherwise select it first
  if (!isFindMatchSelected()) {
    if (findMatches.length) selectFindMatch(true);
    return;
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
  scheduleHighlight();
  updateLineNumbers();

  updateFindMatches();
  if (findMatches.length && findMatchIdx >= findMatches.length) {
    findMatchIdx = 0;
  }
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
}

findInput.addEventListener("input", () => updateFindMatches());
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    findNext();
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
  if (wrapOn) {
    editorArea.classList.add("wrap");
    btnWrap.classList.add("active");
    requestAnimationFrame(syncScrollbarGap);
  }
}

function toggleWrap() {
  const isWrap = editorArea.classList.toggle("wrap");
  btnWrap.classList.toggle("active", isWrap);
  localStorage.setItem(WRAP_KEY, isWrap ? "true" : "false");
  if (isWrap) {
    syncScrollbarGap();
  } else {
    highlightLayer.style.paddingRight = "";
    _lastScrollbarW = 0;
  }
  updateLineNumbers();
}

// Compensate highlight layer padding for textarea scrollbar width
let _lastScrollbarW = 0;
function syncScrollbarGap() {
  const scrollbarW = editor.offsetWidth - editor.clientWidth;
  if (scrollbarW !== _lastScrollbarW) {
    _lastScrollbarW = scrollbarW;
    highlightLayer.style.paddingRight = 16 + scrollbarW + "px";
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
  vimCursorMoveTimer = setTimeout(
    () => cur.classList.remove("moving"),
    150,
  );
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
    const padLeftPx = parseFloat(_editorCS.paddingLeft);
    const contentWidth =
      editor.clientWidth - padLeftPx - parseFloat(_editorCS.paddingRight);
    _wrapMeasure.style.font = _editorCS.font;
    _wrapMeasure.style.letterSpacing = _editorCS.letterSpacing;
    _wrapMeasure.style.tabSize = _editorCS.tabSize;
    _wrapMeasure.style.lineHeight = _editorCS.lineHeight;
    _wrapMeasure.style.width = contentWidth + "px";
    _wrapMeasure.style.whiteSpace = "pre-wrap";
    _wrapMeasure.style.overflowWrap = "break-word";
    const safePos = Math.min(pos, val.length);
    _wrapMeasure.textContent = "";
    if (safePos > 0) {
      _wrapMeasure.appendChild(
        document.createTextNode(val.substring(0, safePos)),
      );
    }
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    _wrapMeasure.appendChild(marker);
    if (safePos < val.length) {
      _wrapMeasure.appendChild(
        document.createTextNode(val.substring(safePos)),
      );
    }
    document.body.appendChild(_wrapMeasure);
    const markerRect = marker.getBoundingClientRect();
    const mr = _wrapMeasure.getBoundingClientRect();
    const rectTop = markerRect.top - mr.top;
    _wrapMeasure.textContent = "";
    document.body.removeChild(_wrapMeasure);
    const rowIdx = Math.max(0, Math.round(rectTop / lineHeight));
    absTop = padTop + rowIdx * lineHeight;
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

  const val = editor.value || "";
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
    // Locate the cursor by placing the ENTIRE editor value in a mirror
    // div and querying a Range at the cursor position. Measuring text
    // prefixes (the previous approach) is unreliable near wrap
    // boundaries because `overflow-wrap: break-word` may break a word
    // mid-way in a prefix while the full line wraps cleanly at the
    // word boundary, making the binary search land several characters
    // off from the real wrap position.
    const cs = window.getComputedStyle(editor);
    const padLeftPx = parseFloat(cs.paddingLeft);
    const contentWidth =
      editor.clientWidth - padLeftPx - parseFloat(cs.paddingRight);
    _wrapMeasure.style.font = cs.font;
    _wrapMeasure.style.letterSpacing = cs.letterSpacing;
    _wrapMeasure.style.tabSize = cs.tabSize;
    _wrapMeasure.style.lineHeight = cs.lineHeight;
    _wrapMeasure.style.width = contentWidth + "px";
    _wrapMeasure.style.whiteSpace = "pre-wrap";
    _wrapMeasure.style.overflowWrap = "break-word";
    // Insert a marker span at the cursor position. Measuring via
    // a Range on a plain text node returns no client rects on empty
    // lines in some browsers (Firefox, Safari), so the cursor would
    // snap to (0,0). A zero-width span always has a measurable box.
    const safePos = Math.min(pos, val.length);
    _wrapMeasure.textContent = "";
    if (safePos > 0) {
      _wrapMeasure.appendChild(
        document.createTextNode(val.substring(0, safePos)),
      );
    }
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    _wrapMeasure.appendChild(marker);
    if (safePos < val.length) {
      _wrapMeasure.appendChild(
        document.createTextNode(val.substring(safePos)),
      );
    }
    document.body.appendChild(_wrapMeasure);

    const markerRect = marker.getBoundingClientRect();
    const mr = _wrapMeasure.getBoundingClientRect();
    let rectTop = markerRect.top - mr.top;
    let rectLeft = markerRect.left - mr.left;

    _wrapMeasure.textContent = "";
    document.body.removeChild(_wrapMeasure);

    // Snap top to the lineHeight grid: rect.top sits on the glyph,
    // not the line box, so it is typically a few pixels off.
    const rowIdx = Math.max(0, Math.round(rectTop / lineHeight));
    absTop = padTop + rowIdx * lineHeight;
    absLeft = padLeftPx + rectLeft;
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
  return vimLineStart(lineIdx) + vimLineText(lineIdx).match(/^[ \t]*/)[0].length;
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

// Every buffer edit goes through here (undo point, change tracking)
function vimEdit(start, end, text) {
  vimPushUndoOnce();
  editor.setRangeText(text, start, end, "end");
  vimState._changed = true;
  editor.dispatchEvent(new Event("input"));
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

function vimShiftLines(first, last, dir) {
  for (let li = last; li >= first; li--) {
    const ls = vimLineStart(li);
    const text = vimLineText(li);
    if (dir > 0) {
      if (text) vimEdit(ls, ls, "  ");
    } else {
      const strip = text.startsWith("  ") ? 2 : text.startsWith("\t") ? 1 : 0;
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
    vimEdit(le, vimLineStart(lineIdx + 1) + vimLineText(lineIdx + 1).length - next.length, sep);
    vimSetCursor(le);
  }
}

// ── Vim text objects ──
// Returns { start, end } (end exclusive) or null; `linewise` for paragraphs

function vimTextObject(type, inner) {
  const val = editor.value;
  const pos = editor.selectionStart;

  if (type === "w" || type === "W") {
    const cls =
      type === "W"
        ? (ch) => (/\s/.test(ch) ? 0 : 1)
        : vimCharClass;
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
  return big ? (ch) => (ch === undefined || /\s/.test(ch) ? 0 : 1) : vimCharClass;
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

const VIM_MOTIONS = new Set("hjklwWbBeE0^$G{};,".split("").concat(["gg"]));

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
      const tl = count ? Math.min(count, last + 1) - 1 : m.name === "G" ? last : 0;
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
        if (vimLineText(pl).slice(prev - vimLineStart(pl)).trim())
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
  } else if (e > s && e === vimLineStart(vimLineOf(e)) && vimLineOf(e) > vimLineOf(s)) {
    // Exclusive motion ending at column 0: stop at the previous line's
    // end, and go linewise if it started at/before the first non-blank
    const sl = vimLineOf(s);
    const el = vimLineOf(e) - 1;
    if (s <= vimFirstNonBlank(sl)) return { linewise: true, first: sl, last: el };
    e = vimLineEnd(el);
  }
  return { linewise: false, start: s, end: e };
}

// ── Vim command parser ──
// Grammar: [count] (motion | operator [count] (motion | textobj | operator)
// | command [char]). Returns null while incomplete, { invalid } on garbage.

const VIM_OPERATORS = new Set(["d", "c", "y", ">", "<"]);
const VIM_TEXTOBJ = new Set('wWp()b{}B[]<>"\'`'.split(""));
const VIM_COMMANDS = new Set(
  "xXDCsSYJpPu.iaIAoOvVnN*#:/?~".split(""),
);

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
      return keys[i++] === "g" ? { name: "gg" } : { invalid: true };
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
  } finally {
    if (vimState.mode === "normal") {
      if (!vimState.keys.length) vimClampCursor();
      editor.readOnly = true;
    } else if (vimState.mode === "visual") editor.readOnly = true;
    updateCursorPos();
  }
}

// Number of leading count keys ("12dw" → 2)
function countKeys(keys) {
  let n = 0;
  while (n < keys.length && /^[0-9]$/.test(keys[n]) && (n || keys[n] !== "0")) n++;
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
      range = { linewise: true, first: li, last: Math.min(li + cnt - 1, vimLastLine()) };
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
          while (p + 1 < val.length && val[p + 1] !== "\n" && cls(val[p + 1]) === cls(val[pos])) p++;
          for (let i = 1; i < cnt; i++) p = vimNextWordEnd(p, motion.name === "W");
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
      const text = val.slice(pos, end).replace(/./g, (ch) =>
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
      try {
        const count = cmd.count || lc.count;
        const keys = (count ? String(count).split("") : []).concat(lc.keys);
        for (const k of keys) vimExecNormal(k);
        if (vimState.mode === "insert") {
          if (lc.insert) vimEdit(editor.selectionStart, editor.selectionStart, lc.insert);
          vimLeaveInsert();
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
        findInput.value,
        cmd.cmd === "n" ? vimState.searchDirection : -vimState.searchDirection,
        cnt,
      );
    case "*":
    case "#": {
      const obj = vimTextObject("w", true);
      if (!obj) return;
      vimState.searchDirection = cmd.cmd === "*" ? 1 : -1;
      return vimSearch(val.slice(obj.start, obj.end), vimState.searchDirection, cnt, true);
    }
    case "/":
    case "?":
      vimState.searchDirection = cmd.cmd === "/" ? 1 : -1;
      return vimOpenCommandBar(cmd.cmd);
    case ":":
      return vimOpenCommandBar(":");
  }
}

function vimApplyOperator(op, range, pos) {
  if (range.linewise) {
    const { first, last } = range;
    if (op === "d") return vimDeleteLines(first, last);
    if (op === "y") {
      vimSetRegister(vimLinesText(first, last), true);
      // yk moves up; yj stays
      if (vimLineOf(pos) > first) vimSetCursor(vimColPos(first, pos - vimLineStart(vimLineOf(pos))));
      return;
    }
    if (op === ">" || op === "<") return vimShiftLines(first, last, op === ">" ? 1 : -1);
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
  vimShiftLines(vimLineOf(start), vimLineOf(Math.max(start, end - 1)), op === ">" ? 1 : -1);
}

// Leave insert mode: record typed text for ".", cursor back one (vim)
function vimLeaveInsert() {
  const ie = vimState.insertEntry;
  const end = editor.selectionStart;
  if (ie && vimState.lastChange && !vimState._replaying)
    vimState.lastChange.insert = end > ie.pos ? editor.value.slice(ie.pos, end) : "";
  vimState.insertEntry = null;
  vimSetMode("normal");
  if (end > vimLineStart(vimLineOf(end))) vimSetCursor(end - 1);
  vimClampCursor();
  editor.readOnly = true;
  updateCursorPos();
}

// Case-insensitive literal search from the cursor, wrapping around
function vimSearch(query, dir, count = 1, wholeWord = false) {
  if (!query) return;
  findInput.value = query; // n/N continue from the last search
  const val = editor.value;
  let matches = findAll(val, query);
  if (wholeWord)
    matches = matches.filter(
      (m) => !/\w/.test(val[m.start - 1] || "") && !/\w/.test(val[m.end] || ""),
    );
  if (!matches.length) return vimShowError("Pattern not found: " + query);
  let p = editor.selectionStart;
  for (let i = 0; i < count; i++) {
    const next =
      dir > 0
        ? matches.find((m) => m.start > p) || matches[0]
        : [...matches].reverse().find((m) => m.start < p) || matches[matches.length - 1];
    p = next.start;
  }
  vimState.desiredCol = null;
  vimSetCursor(p);
}

// ── Vim visual mode ──

function vimRenderVisual() {
  const a = vimState.visualAnchor;
  const h = vimState.visualHead;
  if (vimState.visualLine) {
    const first = Math.min(vimLineOf(a), vimLineOf(h));
    const last = Math.max(vimLineOf(a), vimLineOf(h));
    const end = last < vimLastLine() ? vimLineStart(last + 1) : editor.value.length;
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
  return { linewise: false, start: s, end: Math.min(Math.max(a, h) + 1, editor.value.length) };
}

function vimExecVisual(key) {
  editor.readOnly = false;
  try {
    _vimExecVisual(key);
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
  if (keys.length >= 2 && (keys[keys.length - 2] === "i" || keys[keys.length - 2] === "a") && countKeys(keys) === keys.length - 2) {
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
      [vimState.visualAnchor, vimState.visualHead] = [vimState.visualHead, vimState.visualAnchor];
      return vimRenderVisual();
    case "d":
    case "x":
    case "y":
    case ">":
    case "<":
      vimSetCursor(start);
      exit();
      return vimApplyOperator(k === "x" ? "d" : k, range, start);
    case "c":
    case "s":
      vimSetCursor(start);
      exit();
      return vimApplyOperator("c", range, start);
    case "J": {
      const first = vimLineOf(range.linewise ? vimLineStart(range.first) : range.start);
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

function vimOpenCommandBar(prefix) {
  if (vimErrorDismiss) {
    vimCommandInput.removeEventListener("keydown", vimErrorDismiss);
    vimErrorDismiss = null;
  }
  vimCommandBar.classList.remove("error");
  vimCommandInput.readOnly = false;
  vimCommandBar.classList.add("visible");
  document.querySelector(".vim-command-prefix").textContent =
    prefix || ":";
  vimCommandInput.value = "";
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
  scheduleHighlight();
  updateCursorPos();
}

function vimExecCommand(cmd) {
  const trimmed = cmd.trim();

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
    if (note && isMarkdownFile(note.name)) {
      if (vimState.bufferDirty) vimWriteBuffer();
      switchMdTab("view", true);
    } else {
      vimShowError("Not a markdown file");
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
      showMdToast("formatted");
    } else {
      vimShowError("format: markdown files only");
    }
    return;
  }

  // :d — delete current line
  if (trimmed === "d") {
    vimState._undoPushed = false;
    const li = vimCursorLine();
    vimDeleteLines(li, li);
    updateCursorPos();
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

  // :<number> — jump to line
  if (/^\d+$/.test(trimmed)) {
    const li = Math.min(Math.max(1, parseInt(trimmed)) - 1, vimLastLine());
    vimSetCursor(vimFirstNonBlank(li));
    updateCursorPos();
    return;
  }

  // :s/pat/rep/[gi] on the current line, :%s/… on all lines.
  // JS regex syntax; replacement uses $1 / $& (not \1 / &).
  const sMatch = trimmed.match(/^(%?)s\/((?:\\.|[^/])+)\/((?:\\.|[^/])*)(?:\/([gi]*))?$/);
  if (sMatch) {
    const [, all, pat, rep, flags = ""] = sMatch;
    let re;
    try {
      // Without g only the first match of each line is replaced
      re = new RegExp(pat, flags.replace(/[^gi]/g, ""));
    } catch {
      return vimShowError("Invalid pattern: " + pat);
    }
    const replacement = rep.replace(/\\\//g, "/");
    const li = vimCursorLine();
    const start = all ? 0 : vimLineStart(li);
    const end = all ? editor.value.length : vimLineEnd(li);
    let count = 0;
    const out = editor.value
      .slice(start, end)
      .split("\n")
      .map((line) =>
        line.replace(re, (...args) => {
          count++;
          return replacement.replace(/\$(\d|&)/g, (_, g) => {
            const v = g === "&" ? args[0] : args[+g];
            return typeof v === "string" ? v : "";
          });
        }),
      )
      .join("\n");
    if (!count) return vimShowError("Pattern not found: " + pat);
    vimState._undoPushed = false;
    vimEdit(start, end, out);
    vimSetCursor(vimFirstNonBlank(li));
    vimClampCursor();
    updateCursorPos();
    return;
  }

  if (trimmed) vimShowError("Not an editor command: " + trimmed);
}

vimCommandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const prefix = document.querySelector(
      ".vim-command-prefix",
    ).textContent;
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
  if (e.ctrlKey && e.key !== "r" && e.key !== "d" && e.key !== "u")
    return;

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
//  File Menu
// ═══════════════════════════════════════════════════

const fileMenu = document.getElementById("fileMenu");
const syncMenu = document.getElementById("syncMenu");

function toggleFileMenu() {
  syncMenu.classList.remove("visible");
  fileMenu.classList.toggle("visible");
}

function closeFileMenu() {
  fileMenu.classList.remove("visible");
}

function toggleSyncMenu() {
  fileMenu.classList.remove("visible");
  syncMenu.classList.toggle("visible");
}

function closeSyncMenu() {
  syncMenu.classList.remove("visible");
}

function closeAllMenus() {
  closeFileMenu();
  closeSyncMenu();
}

document.addEventListener("click", (e) => {
  if (
    !e.target.closest(".file-menu-container") &&
    !e.target.closest("#syncMenuContainer")
  ) {
    closeAllMenus();
  }
});

editor.addEventListener("focus", closeAllMenus);

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

function downloadNote() {
  const note = getActiveNote();
  if (!note) return;
  triggerDownload(
    new Blob([note.content], { type: "text/plain" }),
    note.name,
  );
}

async function downloadAll() {
  if (!state.notes.length) return;
  const files = state.notes.map((n) => ({
    name: n.name,
    content: n.content,
  }));
  const directory = {
    notes: state.notes.map((n) => ({
      id: n.id,
      name: n.name,
      updatedAt: n.updatedAt,
    })),
  };
  files.push({
    name: ".note.directory",
    content: JSON.stringify(directory, null, 2),
  });
  const zip = await buildZip(files);
  triggerDownload(
    new Blob([zip], { type: "application/zip" }),
    "notes.zip",
  );
}

async function shareNote() {
  const note = getActiveNote();
  if (!note) return;
  try {
    const compressed = await compress(note.content);
    const queryParams = new URLSearchParams();
    if (zenModeActive) queryParams.set("view", "zen");
    else if (mdViewActive) queryParams.set("view", "md");
    const queryStr = queryParams.toString();
    const query = queryStr ? "?" + queryStr : "";

    const hashMap = new Map();
    hashMap.set("name", note.name);
    hashMap.set("note", compressed);
    hashMap.set("ts", String(note.updatedAt));

    const url =
      location.origin + location.pathname + query + buildHash(hashMap);
    if (url.length > URL_MAX_LENGTH) {
      showModal("Note is too large to share via URL.", "ok", null);
      closeFileMenu();
      return;
    }
    await navigator.clipboard.writeText(url);
    btnShare.textContent = "copied!";
    btnShare.classList.add("copied");
    setTimeout(() => {
      btnShare.textContent = "share";
      btnShare.classList.remove("copied");
      closeFileMenu();
    }, 2000);
  } catch (err) {
    console.error("Share failed:", err);
  }
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

  if (!noteData) return false;
  try {
    const content = await decompress(noteData);

    // Zen mode from URL: don't persist, store ephemerally
    if (viewParam === "zen") {
      zenFromUrl = true;
      zenEphemeralNote = { name, content };
      if (fromOldFormat) await updateUrl();
      return true;
    }

    const urlTs = Number(hashMap.get("ts")) || 0;
    const existing = state.notes.find((n) => n.name === name);
    if (existing) {
      if (existing.content === content) {
        state.activeId = existing.id;
        saveState();
        if (fromOldFormat) await updateUrl();
        return true;
      }
      // URL is stale (older than local) — prefer local state silently.
      // Why: updateUrl() is async and may not complete before the tab
      // closes, so on reopen the URL can contain a pre-save snapshot.
      if (urlTs && existing.updatedAt >= urlTs) {
        state.activeId = existing.id;
        saveState();
        return true;
      }
      render();
      const update = await showModal(
        `"${name}" already exists with different content.`,
        "update",
        "new file",
      );
      if (update) {
        existing.content = content;
        existing.updatedAt = Date.now();
        state.activeId = existing.id;
        saveState();
      } else {
        createNote(undefined, content);
      }
    } else {
      createNote(name, content);
    }
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
  "txt md markdown json jsonl json5 js jsx ts tsx mjs cjs mts cts css scss sass less html htm xml xsl xslt csv tsv yaml yml toml ini cfg conf sh bash zsh fish ps1 bat cmd py pyi pyw rb rake gemspec go rs java scala kt kts groovy gradle c h cpp hpp cc cxx hxx cs fs fsx swift m mm r jl lua pl pm php phtml ex exs erl hrl hs lhs clj cljs cljc edn lisp cl el rkt ml mli v sv vhd vhdl sql graphql gql proto thrift avsc tf hcl nix dhall dart zig nim cr d pas pp asm s wasm wat sol vy move cairo log env properties lock sum mod cmake make mk svg plist strings resx pot po rst adoc asciidoc tex bib sty cls org wiki textile diff patch gitignore gitattributes gitmodules dockerignore npmignore eslintignore prettierignore editorconfig prettierrc eslintrc babelrc browserslistrc stylelintrc huskyrc lintstagedrc nvmrc".split(
    " ",
  ),
);

const TEXT_NAMES = new Set(
  "dockerfile containerfile vagrantfile rakefile gemfile podfile".split(
    " ",
  ),
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

async function importZip(file) {
  const arrayBuffer = await file.arrayBuffer();
  const header = new Uint8Array(arrayBuffer, 0, 4);
  if (
    header[0] !== 0x50 ||
    header[1] !== 0x4b ||
    header[2] !== 0x03 ||
    header[3] !== 0x04
  ) {
    showModal("Invalid zip file.", "ok", null);
    return;
  }
  let entries;
  try {
    entries = await readZip(arrayBuffer);
  } catch (e) {
    showModal("Could not read zip file: " + e.message, "ok", null);
    return;
  }

  // Parse .note.directory metadata
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

  const importable = entries.filter((e) => e.name !== ".note.directory");
  const skipped = [];

  for (const entry of importable) {
    let name = entry.name;
    // Strip control characters, limit length
    name = name.replace(/[\x00-\x1f\x7f]/g, "");
    if (name.length > 255) name = name.slice(0, 255);
    // Strip leading dots (except .note.directory already filtered)
    if (name.startsWith(".")) name = name.slice(1);
    if (!name) continue;

    const content = new TextDecoder().decode(entry.data);

    // Binary file detection: check for null bytes in first 8KB
    const check = content.slice(0, 8192);
    if (check.includes("\x00")) {
      skipped.push(entry.name);
      continue;
    }

    if (wouldExceedStorage(content.length * 2 + name.length * 2 + 200)) {
      await showModal(
        '"' +
          name +
          '" is too large. Delete some notes to free up space.',
        "ok",
        null,
      );
      continue;
    }

    const meta = metadata
      ? metadata.notes.find((n) => n.name === name)
      : null;
    const existing = state.notes.find((n) => n.name === name);

    if (meta && existing && meta.id === existing.id) {
      // Same ID: auto-merge by updatedAt
      if (meta.updatedAt > existing.updatedAt) {
        existing.content = content;
        existing.updatedAt = meta.updatedAt;
        state.activeId = existing.id;
        saveState();
        render();
      }
    } else if (existing) {
      // Same filename, different ID or no metadata
      const action = await showImportModal(name);
      if (action === "override") {
        existing.content = content;
        existing.updatedAt = meta ? meta.updatedAt : Date.now();
        state.activeId = existing.id;
        saveState();
        render();
      } else if (action === "keep-both") {
        createNote(uniqueName(name), content);
      }
      // "skip": do nothing
    } else {
      // No conflict
      if (meta) {
        // The id may belong to a renamed or deleted note — don't reuse it
        const idTaken =
          state.notes.some((n) => n.id === meta.id) ||
          state.deletedIds.includes(meta.id);
        const note = {
          id: idTaken ? crypto.randomUUID() : meta.id,
          name: name,
          content: content,
          updatedAt: meta.updatedAt,
        };
        state.notes.unshift(note);
        state.activeId = note.id;
        saveState();
        scheduleDriveUpload(true);
        render();
      } else {
        createNote(name, content);
      }
    }
  }

  if (skipped.length) {
    showModal(
      "Skipped binary file" +
        (skipped.length > 1 ? "s" : "") +
        ": " +
        skipped.join(", "),
      "ok",
      null,
    );
  }
}

document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove("visible");
  if (zenModeActive) return;
  const files = e.dataTransfer.files;
  if (!files.length) return;
  // Save vim buffer before switching
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  const wasInView = mdViewActive;

  // Separate zip files from text files
  const zipFiles = [];
  const textFiles = [];
  const unsupported = [];
  for (const file of files) {
    if (
      file.name.toLowerCase().endsWith(".zip") ||
      file.type === "application/zip"
    ) {
      zipFiles.push(file);
    } else if (
      file.type.startsWith("text/") ||
      isTextFilename(file.name)
    ) {
      textFiles.push(file);
    } else {
      unsupported.push(file.name);
    }
  }

  // Handle zip files
  for (const zip of zipFiles) {
    await importZip(zip);
  }

  // Handle text files (existing logic)
  let remaining = textFiles.length;
  for (const file of textFiles) {
    const reader = new FileReader();
    reader.onload = async () => {
      if (wouldExceedStorage(reader.result.length * 2)) {
        showModal(
          `"${file.name}" is too large. Delete some notes to free up space.`,
          "ok",
          null,
        );
        remaining--;
        return;
      }
      const existing = state.notes.find((n) => n.name === file.name);
      if (existing) {
        const update = await showModal(
          `"${file.name}" already exists.`,
          "update",
          "new file",
        );
        if (update) {
          existing.content = reader.result;
          existing.updatedAt = Date.now();
          state.activeId = existing.id;
          saveState();
          render();
        } else {
          createNote(uniqueName(file.name), reader.result);
        }
      } else {
        createNote(file.name, reader.result);
      }
      remaining--;
      if (remaining === 0 && wasInView) {
        const note = getActiveNote();
        if (note && isMarkdownFile(note.name)) {
          switchMdTab("view");
        }
      }
    };
    reader.readAsText(file);
  }
  if (unsupported.length) {
    showModal(
      "Unsupported file" +
        (unsupported.length > 1 ? "s" : "") +
        ": " +
        unsupported.join(", ") +
        ". Only text files are supported.",
      "ok",
      null,
    );
  }
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
  if (e.key === STORAGE_KEY && e.newValue) {
    try {
      const before = activeNoteVersion();
      if (!mergeStoredState(JSON.parse(e.newValue))) return;
      // Only touch the editor if the open note itself changed
      if (activeNoteVersion() !== before) render();
      else renderNoteList();
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
      _lastScrollbarW = 0;
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
window.addEventListener("beforeunload", () => {
  if (vimState.enabled && vimState.bufferDirty) vimWriteBuffer();
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveState();
  }
});

// ═══════════════════════════════════════════════════
//  Editor Events & Keyboard Shortcuts
// ═══════════════════════════════════════════════════

editor.addEventListener("input", () => {
  lastOccurrenceQuery = "";
  occurrenceOverlay.innerHTML = "";
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
    saveSwap(note.id, editor.value);
  } else {
    note.content = editor.value;
    note.updatedAt = Date.now();
  }
  updateLineNumbers();
  updateCursorPos();
  ensureCursorScrolloff();
  scheduleHighlight();
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

editor.addEventListener("keydown", (e) => {
  // Skip in vim normal/visual mode
  if (vimState.enabled && vimState.mode !== "insert") return;

  // Alt+Arrow Up/Down — move line(s) up/down
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const val = editor.value;
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    // Expand selection to cover full lines
    const blockStart = val.lastIndexOf("\n", selStart - 1) + 1;
    const blockEndNl = val.indexOf("\n", selEnd);
    const blockEnd = blockEndNl === -1 ? val.length : blockEndNl;
    const block = val.substring(blockStart, blockEnd);
    // Offsets of selection within the block
    const offStart = selStart - blockStart;
    const offEnd = selEnd - blockStart;

    if (e.key === "ArrowUp" && blockStart > 0) {
      const prevLineStart = val.lastIndexOf("\n", blockStart - 2) + 1;
      const prevLine = val.substring(prevLineStart, blockStart - 1);
      editor.value =
        val.substring(0, prevLineStart) +
        block +
        "\n" +
        prevLine +
        val.substring(blockEnd);
      editor.selectionStart = prevLineStart + offStart;
      editor.selectionEnd = prevLineStart + offEnd;
    } else if (e.key === "ArrowDown" && blockEndNl !== -1) {
      const nextLineEndNl = val.indexOf("\n", blockEnd + 1);
      const nextLineEnd =
        nextLineEndNl === -1 ? val.length : nextLineEndNl;
      const nextLine = val.substring(blockEnd + 1, nextLineEnd);
      editor.value =
        val.substring(0, blockStart) +
        nextLine +
        "\n" +
        block +
        val.substring(nextLineEnd);
      const newBlockStart = blockStart + nextLine.length + 1;
      editor.selectionStart = newBlockStart + offStart;
      editor.selectionEnd = newBlockStart + offEnd;
    }
    editor.dispatchEvent(new Event("input"));
    return;
  }

  // Tab / Shift+Tab for indent/dedent
  if (e.key === "Tab") {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const val = editor.value;

    if (start === end && !e.shiftKey) {
      // No selection: insert 2 spaces
      editor.setRangeText("  ", start, end, "end");
    } else {
      // Selection: indent/dedent all selected lines
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = val.indexOf("\n", end);
      const actualEnd = lineEnd === -1 ? val.length : lineEnd;
      const block = val.substring(lineStart, actualEnd);
      const lines = block.split("\n");
      let newLines;
      if (e.shiftKey) {
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
});

document.addEventListener("keydown", (e) => {
  const inInput =
    document.activeElement &&
    document.activeElement !== editor &&
    (document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "TEXTAREA");

  // In zen mode, block all shortcuts except "e", Escape, and Cmd/Ctrl+A
  if (zenModeActive) {
    if (
      !inInput &&
      e.key === "e" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      exitZenMode();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitZenMode();
    } else if (
      !inInput &&
      (e.metaKey || e.ctrlKey) &&
      (e.key === "a" || e.key === "A")
    ) {
      e.preventDefault();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(mdPreview);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return;
  }
  // Switch from view to edit tab with "e"
  if (
    !inInput &&
    mdViewActive &&
    e.key === "e" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    e.preventDefault();
    switchMdTab("edit", true);
    return;
  }
  // Find & Replace (skip if typing in an input)
  if (
    !inInput &&
    !mdViewActive &&
    (e.metaKey || e.ctrlKey) &&
    e.key === "h"
  ) {
    e.preventDefault();
    openFindReplace();
    return;
  }
  // Open search (skip if typing in an input)
  if (
    !inInput &&
    (e.metaKey || e.ctrlKey) &&
    (e.key === "p" || e.key === "f")
  ) {
    e.preventDefault();
    openSearch();
    searchInput.select();
    return;
  }
  // Close find replace
  if (
    e.key === "Escape" &&
    findReplaceBar.classList.contains("visible")
  ) {
    e.preventDefault();
    closeFindReplace();
    return;
  }
  // Close search
  if (e.key === "Escape" && searchResults.classList.contains("visible")) {
    e.preventDefault();
    closeSearch();
    searchInput.value = "";
    editor.focus();
    return;
  }
  // Close sidebar
  if (e.key === "Escape" && sidebar.classList.contains("open")) {
    e.preventDefault();
    sidebar.classList.remove("open");
    document.querySelector(".app").classList.remove("sidebar-open");
    editor.focus();
    return;
  }
  // Delete note
  if (
    (e.metaKey || e.ctrlKey) &&
    e.shiftKey &&
    (e.key === "d" || e.key === "D")
  ) {
    e.preventDefault();
    const note = getActiveNote();
    if (note) confirmDelete(note.id);
    return;
  }
  // Undo
  const key = e.key.toLowerCase();
  if (!inInput && (e.metaKey || e.ctrlKey) && key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
    return;
  }
  // Redo
  if (
    !inInput &&
    (((e.metaKey || e.ctrlKey) && e.shiftKey && key === "z") ||
      (e.ctrlKey && !e.metaKey && key === "y"))
  ) {
    e.preventDefault();
    redo();
    return;
  }
  // Ctrl+S: suppress browser save
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    // Vim mode: do nothing (use :w)
    if (vimState.enabled) return;
    // Zen mode: do nothing
    if (zenModeActive) return;
    // Edit mode (non-vim): autoformat markdown, then save + sync
    if (!mdViewActive) {
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
    // Save + sync (edit mode and view mode, not zen)
    saveState();
    scheduleUrlUpdate();
    if (gdriveConnected) driveSync();
    return;
  }
  // New note
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === "n") {
    e.preventDefault();
    createNote();
  }
  // Toggle vim mode
  if (e.ctrlKey && !e.metaKey && e.shiftKey && e.key === "M") {
    e.preventDefault();
    toggleVim();
  }
  // Format markdown (Ctrl+Shift+F)
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
    e.preventDefault();
    const note = getActiveNote();
    if (!note) return;
    if (!isMarkdownFile(note.name)) {
      showMdToast("format: markdown files only");
      return;
    }
    const pos = editor.selectionStart;
    pushHistory(note.id, editor.value);
    const formatted = formatMarkdown(editor.value);
    if (vimState.enabled) {
      editor.value = formatted;
      vimState.bufferDirty = true;
      saveSwap(note.id, editor.value);
    } else {
      editor.value = formatted;
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
    showMdToast("formatted");
  }
});

// ═══════════════════════════════════════════════════
//  Google Drive Sync (lazy-loaded)
// ═══════════════════════════════════════════════════

const GDRIVE_CLIENT_ID =
  "355563554662-02psj7te5k9m01j8qefegce60ubghdjp.apps.googleusercontent.com";
const GDRIVE_SCOPES = "https://www.googleapis.com/auth/drive.appdata";
const GDRIVE_FILE_NAME = "note-app-data.json";
const GDRIVE_TOKEN_KEY = "notepad_gdrive_token";
const GDRIVE_CONNECTED_KEY = "notepad_gdrive_connected";
let gdriveToken = null;
let gdriveTokenExpiry = 0;
let gisLoaded = false;

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
  if (localStorage.getItem(GDRIVE_CONNECTED_KEY) === "true")
    return "expired";
  return "none";
}

function clearToken() {
  gdriveToken = null;
  gdriveTokenExpiry = 0;
  localStorage.removeItem(GDRIVE_TOKEN_KEY);
}

function showSyncConnected() {
  document.getElementById("syncMenuContainer").style.display = "";
  document.getElementById("btnDriveSync").style.display = "none";
  document.getElementById("btnDriveSyncSeparator").style.display = "none";
  document.querySelector(".sync-dot").classList.remove("disconnected");
  document.getElementById("syncLabel").textContent = "sync";
  document.getElementById("syncMenuConnected").style.display = "";
  document.getElementById("syncMenuFailed").style.display = "none";
  document.getElementById("syncMenuDisconnected").style.display = "none";
}

function showSyncFailed() {
  document.getElementById("syncMenuContainer").style.display = "";
  document.getElementById("btnDriveSync").style.display = "none";
  document.getElementById("btnDriveSyncSeparator").style.display = "none";
  document.querySelector(".sync-dot").classList.add("disconnected");
  document.getElementById("syncLabel").textContent = "sync failed";
  document.getElementById("syncMenuConnected").style.display = "none";
  document.getElementById("syncMenuFailed").style.display = "";
  document.getElementById("syncMenuDisconnected").style.display = "none";
}

function hideSyncConnected() {
  document.getElementById("syncMenuContainer").style.display = "none";
  document.getElementById("btnDriveSync").style.display = "";
  document.getElementById("btnDriveSyncSeparator").style.display = "";
  document.querySelector(".sync-dot").classList.remove("disconnected");
}

function loadGIS() {
  return new Promise((resolve, reject) => {
    if (gisLoaded) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = () => {
      gisLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load Google sign-in"));
    document.head.appendChild(s);
  });
}

let gdriveRefreshTimer = null;

// Never opens a popup: only succeeds if Google still has a session
async function silentTokenRefresh() {
  await loadGIS();
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(arg);
    };
    const timeout = setTimeout(done(reject), 10000, new Error("timeout"));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GDRIVE_CLIENT_ID,
      scope: GDRIVE_SCOPES,
      callback: done((resp) => {
        if (resp.error) return reject(new Error(resp.error));
        persistToken(resp.access_token, resp.expires_in);
        scheduleTokenRefresh();
        resolve();
      }),
      error_callback: done((err) => reject(new Error(err?.type || "auth"))),
    });
    client.requestAccessToken({ prompt: "" });
  });
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

// Interactive sign-in — only call from a click/key handler, or the
// browser blocks the popup
function gdriveAuth() {
  if (gdriveToken && Date.now() < gdriveTokenExpiry)
    return Promise.resolve();
  clearToken();
  return loadGIS().then(
    () =>
      new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GDRIVE_CLIENT_ID,
          scope: GDRIVE_SCOPES,
          callback: (resp) => {
            if (resp.error) return reject(new Error(resp.error));
            persistToken(resp.access_token, resp.expires_in);
            scheduleTokenRefresh();
            showSyncConnected();
            resolve();
          },
          // Popup closed or blocked — without this the promise never settles
          error_callback: (err) => reject(new Error(err?.type || "auth")),
        });
        client.requestAccessToken();
      }),
  );
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
    },
  });
}

function applyDriveSettings(settings) {
  if (!settings) return;
  if (settings.wrap !== null && settings.wrap !== undefined) {
    localStorage.setItem(WRAP_KEY, settings.wrap);
    const wrapOn = settings.wrap === "true";
    editorArea.classList.toggle("wrap", wrapOn);
    btnWrap.classList.toggle("active", wrapOn);
    if (wrapOn) {
      requestAnimationFrame(syncScrollbarGap);
    } else {
      highlightLayer.style.paddingRight = "";
      _lastScrollbarW = 0;
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
  if (/^\d+$/.test(settings.sidebarWidth || "")) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, settings.sidebarWidth);
    sidebar.style.setProperty(
      "--sidebar-width",
      settings.sidebarWidth + "px",
    );
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
      const needsUpload = mergeDriveState(remote, base);
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
        if (files[0] && (await gdriveVersion(files[0].id)) !== files[0].version) {
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

// User-initiated (menu, Ctrl+S): may open the sign-in popup
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
  const dot = document.querySelector(".sync-dot");
  const label = document.getElementById("syncLabel");
  if (!dot || !label) return;
  if (on) {
    syncDotCount++;
    clearTimeout(syncDotTimer);
    clearTimeout(syncOkTimer);
    dot.classList.add("syncing");
    dot.classList.remove("disconnected");
    label.textContent = "syncing";
  } else {
    syncDotCount = Math.max(0, syncDotCount - 1);
    if (syncDotCount === 0) {
      // Keep blinking for at least one full cycle (1.4s)
      syncDotTimer = setTimeout(() => {
        if (syncDotCount === 0) dot.classList.remove("syncing");
      }, 900);
    }
  }
}
function setSyncResult(success) {
  clearTimeout(syncOkTimer);
  clearTimeout(syncDotTimer);
  if (success) {
    showSyncConnected();
    const dot = document.querySelector(".sync-dot");
    if (dot) {
      dot.classList.remove("syncing");
      dot.textContent = "✔";
      syncOkTimer = setTimeout(() => {
        dot.textContent = "●";
      }, 2000);
    }
  } else {
    showSyncFailed();
  }
}

// `broadcast` is false when reacting to a sign-out in another tab
function driveSignOut(broadcast = true) {
  closeSyncMenu();
  syncEpoch++;
  const token = gdriveToken;
  if (broadcast && token)
    loadGIS()
      .then(() => google.accounts.oauth2.revoke(token))
      .catch(() => {});
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
  "A private, local-first text editor.",
  "No data is collected, transmitted, or stored on any server.",
  "Your notes stay in your browser — always.",
  "",
  "## Share via URL",
  "",
  "Click **share** to embed a note directly in the URL.",
  "No server, no upload — the entire note lives in the link.",
  "Anyone with the link can read it instantly (~60kB limit).",
  "",
  "## Tips",
  "",
  "Browsers can clear localStorage without warning.",
  "Bookmark your notes (URL updates as you type)",
  "or enable Drive sync so nothing gets lost.",
  "",
  "- Click a file to open, click again to rename",
  "- Drag to reorder, pin to keep on top",
  "- Drop files to import, download zip to backup",
  "- Word wrap and vim mode in the status bar",
  "- .md files get edit/view tabs for markdown preview",
  "- Link between notes: [label](other.md)",
  "- Syncs across tabs automatically",
  "",
  "## Shortcuts",
  "",
  "- Ctrl+N — new note",
  "- Ctrl+P — search notes",
  "- Ctrl+H — find & replace",
  "- Ctrl+Shift+D — delete note",
  "- Ctrl+Shift+F — format markdown",
  "- Tab / Shift+Tab — indent / dedent",
  "- Alt+↑ / Alt+↓ — move line up / down",
  "- e — switch from view to edit (in markdown preview)",
  "",
  "## Markdown preview",
  "",
  ".md files have edit/view tabs. The view tab renders",
  "your markdown with these interactive features:",
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
  "",
  "## Vim",
  "",
  "Toggle from the status bar.",
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
  "- / — search forward, ? — backward",
  "- n/N — next/prev match",
  "- * / # — word under cursor fwd/back",
  "",
  "### Commands",
  "",
  "Press : to open the command bar.",
  "- :w — save, :q — exit vim",
  "- :set wrap / :set nowrap / :set wrap!",
  "- :new — new note, :e name — open note",
  "- :d — delete line, :42 — jump to line",
  "- :fmt — format markdown",
  "- :view — markdown preview",
  "- :help — this page",
  "- :mddemo — markdown features showcase",
  "- :s/a/b/ — replace in line, :%s/a/b/g — everywhere",
  "  (JavaScript regex, $1 for groups, flags g and i)",
].join("\n");
const HELP_MOBILE = [
  "# Welcome to note.",
  "",
  "A private, local-first text editor.",
  "No data is collected, transmitted, or stored on any server.",
  "Your notes stay in your browser — always.",
  "",
  "## Share via URL",
  "",
  "Tap **share** to embed a note directly in the URL.",
  "No server, no upload — the entire note lives in the link.",
  "Anyone with the link can read it instantly (~60kB limit).",
  "",
  "## Tips",
  "",
  "Browsers can clear localStorage without warning.",
  "Bookmark your notes (URL updates as you type)",
  "or enable Drive sync so nothing gets lost.",
  "",
  "- Download zip to backup",
  "- .md files get edit/view tabs for markdown preview",
  "- Link between notes: [label](other.md)",
  "- Syncs across tabs automatically",
  "",
  "## Getting started",
  "",
  '- Tap "notes" to open the sidebar',
  "- Tap + to create a new note",
  "- Tap a file to open, tap again to rename",
  "- Long press to pin or delete",
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
  const isFirstVisit = !localStorage.getItem(STORAGE_KEY);
  loadState();
  loadWrap();
  loadVim();

  // Tabs opened in the background must not take Drive sync from the
  // tab the user is working in — they claim it on focus instead
  if (document.visibilityState === "visible") claimLeadership();

  // Restore Google Drive session
  // Expired tokens are refreshed silently by the first sync; if that
  // fails the user reconnects via the sync menu (never a surprise popup)
  const tokenState = restoreToken();
  if (tokenState !== "none") {
    gdriveConnected = true;
    if (tokenState === "ok") {
      showSyncConnected();
      scheduleTokenRefresh();
    } else showSyncFailed();
    // Preload so a later reconnect click can open the popup immediately
    loadGIS().catch(() => {});
  }
  const loaded = await loadFromUrl();
  if (!loaded && state.notes.length === 0 && isFirstVisit) {
    await openBuiltinNote(
      isMobile() ? "help-mobile.md" : "help.md",
      isMobile() ? HELP_MOBILE : HELP_DESKTOP,
    );
  }
  render();
  checkMdViewParam();
  updateUrl();
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
  "toggle-sidebar": toggleSidebar,
  "find-next": findNext,
  "find-prev": findPrev,
  "replace-current": replaceCurrent,
  "replace-all": replaceAll,
  "close-find-replace": closeFindReplace,
  "find-replace": openFindReplace,
  "toggle-file-menu": toggleFileMenu,
  "toggle-sync-menu": toggleSyncMenu,
  share: shareNote,
  download: downloadNote,
  "download-all": downloadAll,
  search: openSearch,
  "close-search": closeSearch,
  help: openHelp,
  "drive-sync": driveSync,
  "drive-sign-out": () => driveSignOut(),
  "tab-edit": () => switchMdTab("edit", true),
  "tab-view": () => switchMdTab("view", true),
  "tab-zen": () => switchMdTab("zen", true),
  "exit-zen": exitZenMode,
  "zen-share": zenShare,
  "toggle-vim": toggleVim,
  "toggle-wrap": toggleWrap,
};
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  clickActions[el.dataset.action]();
  if (el.hasAttribute("data-close-menu")) closeFileMenu();
});

init();

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
    document.documentElement.style.height =
      window.visualViewport.height + "px";
  };
  window.visualViewport.addEventListener("resize", onViewportResize);
}
