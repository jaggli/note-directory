// IndexedDB storage, end to end — including against the last release that
// kept notes in localStorage only, served from git: upgrading, both
// versions open side by side, and going back.
const { execFileSync } = require("child_process");
const { test, expect, openApp } = require("./fixtures");

const LEGACY = "709c31b"; // last localStorage-only release
const gitShow = (path) => execFileSync("git", ["show", `${LEGACY}:${path}`]);
const legacyApp = gitShow("app.js");
const legacyHtml = gitShow("index.html");

async function useLegacy(page) {
  await page.route(
    (url) => url.pathname === "/app.js",
    (r) => r.fulfill({ body: legacyApp, contentType: "text/javascript" }),
  );
  await page.route(
    (url) => url.pathname === "/",
    (r) => r.fulfill({ body: legacyHtml, contentType: "text/html" }),
  );
}

// Reload and wait for the app. Not openApp(page.url()): navigating to the
// same URL again can reload a second time in WebKit, and the old version
// throws when its start-up is cut short (Blob.stream() during unload)
const reloaded = async (page) => {
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".note-item"));
};

// Waits until every save is committed to IndexedDB, and writes the
// localStorage mirror now instead of within MIRROR_EVERY
const flushed = (page) =>
  page.evaluate(async () => {
    saveState();
    flushMirror();
    while (idbFlushing) await idbFlushing;
  });

const idbDump = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("note-directory");
        req.onsuccess = () => {
          const tx = req.result.transaction(["notes", "meta"]);
          const notes = tx.objectStore("notes").getAll();
          const meta = tx.objectStore("meta").get("state");
          tx.oncomplete = () => {
            req.result.close();
            resolve({ notes: notes.result, meta: meta.result });
          };
        };
        req.onerror = () => reject(req.error);
      }),
  );

const summary = (notes) =>
  notes.map((n) => ({ id: n.id, name: n.name, content: n.content, pinned: !!n.pinned }));

const DRAWING = 'draw 1\nr a 0 0 100 50 c=blue "box"\n';

test("upgrade: notes from localStorage move to IndexedDB unchanged", async ({ page }) => {
  await useLegacy(page);
  await openApp(page);
  expect(await page.evaluate(() => typeof idbFlush)).toBe("undefined");
  await page.evaluate(async () => {
    await createNote("gone.md", "");
    await confirmDelete(getActiveNote().id);
    await createNote("sketch.draw", "draw 1\nr a 0 0 100 50 c=blue \"box\"\n");
    await createNote("ünï 😀.md", "# Grüße\n\n- [ ] task\n");
    await createNote("pinned.md", "keep me on top");
    getActiveNote().pinned = true;
    sortNotes();
    saveState();
    await createNote("typed.md", "");
  });
  await page.locator("#editor").focus();
  await page.keyboard.type("typed in the old version");
  await page.evaluate(() => switchNote(state.notes.find((n) => n.name === "ünï 😀.md").id));
  await page.waitForTimeout(400); // debounced save
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("notepad_data")));
  expect(before.notes.find((n) => n.name === "typed.md").content).toBe("typed in the old version");

  // The new version loads with nothing to click
  await page.unrouteAll();
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".note-item") && typeof idbFlush === "function");
  const after = await page.evaluate(() => state);
  expect(summary(after.notes)).toEqual(summary(before.notes));
  expect(after.activeId).toBe(before.activeId);
  expect(after.deletedIds).toEqual(before.deletedIds);
  await expect(page.locator("#modalOverlay")).toBeHidden();
  await expect(page.locator(".note-item").first()).toContainText("pinned.md");

  await flushed(page);
  const db = await idbDump(page);
  const byId = new Map(db.notes.map((n) => [n.id, n]));
  for (const n of before.notes) expect(byId.get(n.id)).toEqual(n);
  expect(db.notes).toHaveLength(before.notes.length);
  expect(db.meta.order).toEqual(before.notes.map((n) => n.id));
  expect(db.meta.activeId).toBe(before.activeId);
  expect(db.meta.deletedIds).toEqual(before.deletedIds);
  // The mirror stays for older tabs and versions
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("notepad_data")).notes.length)).toBe(before.notes.length);

  // IndexedDB alone is enough from now on
  await page.evaluate(() => localStorage.removeItem("notepad_data"));
  await reloaded(page);
  expect(summary(await page.evaluate(() => state.notes))).toEqual(summary(before.notes));
});

test("old and new version open side by side see each other's edits", async ({ page, context }) => {
  await openApp(page);
  const old = await context.newPage();
  await useLegacy(old);
  await openApp(old);
  const names = (p) => p.evaluate(() => state.notes.map((n) => n.name));
  const content = (p, name) =>
    p.evaluate((name) => state.notes.find((n) => n.name === name)?.content, name);

  // old → new: shows up, and lands in IndexedDB
  await old.evaluate(() => createNote("from-old.md", "old says hi"));
  await expect(page.locator(".note-item", { hasText: "from-old.md" })).toHaveCount(1);
  await flushed(page);
  expect((await idbDump(page)).notes.map((n) => n.name)).toContain("from-old.md");

  // new → old
  await page.evaluate(() => createNote("from-new.md", "new says hi"));
  await expect(old.locator(".note-item", { hasText: "from-new.md" })).toHaveCount(1);

  // Typing in either one reaches the other
  await page.click(".note-item:has-text('from-old.md')");
  await page.locator("#editor").focus();
  await page.evaluate(() => (editor.selectionStart = editor.selectionEnd = editor.value.length));
  await page.keyboard.type(" + new");
  await expect.poll(() => content(old, "from-old.md")).toBe("old says hi + new");
  await old.click(".note-item:has-text('from-new.md')");
  await old.locator("#editor").focus();
  await old.evaluate(() => (editor.selectionStart = editor.selectionEnd = editor.value.length));
  await old.keyboard.type(" + old");
  await expect.poll(() => content(page, "from-new.md")).toBe("new says hi + old");

  // Deleting in either one removes it in the other
  await page.evaluate(() => {
    confirmDelete(state.notes.find((n) => n.name === "from-old.md").id);
  });
  await page.click("#modalConfirm");
  await expect.poll(() => names(old)).not.toContain("from-old.md");
  await old.evaluate(() => {
    confirmDelete(state.notes.find((n) => n.name === "from-new.md").id);
  });
  await old.click("#modalConfirm");
  await expect.poll(() => names(page)).not.toContain("from-new.md");

  // No tab's URL still carries a deleted note (reloading it would bring
  // the note back) — then nothing comes back after reloading both
  for (const p of [page, old])
    await expect
      .poll(() => p.evaluate(() => decodeURIComponent(location.hash)))
      .not.toMatch(/from-(old|new)\.md/);
  await flushed(page);
  await reloaded(old);
  await reloaded(page);
  for (const p of [page, old]) {
    expect(await names(p)).not.toContain("from-old.md");
    expect(await names(p)).not.toContain("from-new.md");
  }
  const db = await idbDump(page);
  expect(db.notes.map((n) => n.name)).not.toContain("from-old.md");
  expect(db.notes.map((n) => n.name)).not.toContain("from-new.md");
});

test("going back to the old version finds every note", async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("made-in-new.md", "fresh");
    await createNote("drawing.draw", 'draw 1\nr a 0 0 100 50 c=blue "box"\n');
  });
  await flushed(page);
  const notes = summary(await page.evaluate(() => state.notes));
  await useLegacy(page);
  await reloaded(page);
  expect(await page.evaluate(() => typeof idbFlush)).toBe("undefined");
  expect(summary(await page.evaluate(() => state.notes))).toEqual(notes);
});

// Chromium's localStorage holds ~5M characters
const bigNotes = (page) =>
  page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await createNote(`big${i}.txt`, String(i).repeat(2e6));
    await createNote("small.md", "small");
    saveState();
  });

test("past the localStorage limit: no error, nothing lost", async ({ page }) => {
  await openApp(page);
  await bigNotes(page);
  await flushed(page);
  await expect(page.locator("#modalOverlay")).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("notepad_data"))).toBeNull();

  await reloaded(page);
  const sizes = await page.evaluate(() =>
    Object.fromEntries(state.notes.map((n) => [n.name, n.content.length])),
  );
  for (let i = 0; i < 4; i++) expect(sizes[`big${i}.txt`]).toBe(2e6);
  expect(sizes["small.md"]).toBe(5);

  // Back under the limit, the mirror for older versions returns
  await page.evaluate(() => {
    for (const n of state.notes.filter((n) => n.name.startsWith("big"))) {
      state.notes.splice(state.notes.indexOf(n), 1);
      state.deletedIds.push(n.id);
      state.deletedAt[n.id] = Date.now();
    }
    render();
  });
  await flushed(page);
  await reloaded(page);
  await flushed(page);
  const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem("notepad_data")));
  expect(mirror.notes.map((n) => n.name)).toContain("small.md");
  expect(mirror.notes.map((n) => n.name)).not.toContain("big0.txt");
});

test("closing mid-write keeps the last edit (journal)", async ({ page, context }) => {
  await openApp(page);
  await bigNotes(page);
  await flushed(page);
  // IndexedDB never finishes from here on
  await page.evaluate(() => {
    idbCommit = () => new Promise(() => {});
  });
  await page.click(".note-item:has-text('small.md')");
  await page.locator("#editor").focus();
  await page.evaluate(() => (editor.selectionStart = editor.selectionEnd = editor.value.length));
  await page.keyboard.type(" and unsaved");
  await page.evaluate(() => saveState());
  expect(await page.evaluate(() => localStorage.getItem("notepad_pending"))).toContain("and unsaved");
  await page.close({ runBeforeUnload: true });

  const next = await context.newPage();
  await openApp(next);
  expect(
    await next.evaluate(() => state.notes.find((n) => n.name === "small.md").content),
  ).toBe("small and unsaved");
  // Committed now, so the journal goes away
  await flushed(next);
  expect(await next.evaluate(() => localStorage.getItem("notepad_pending"))).toBeNull();
  expect((await idbDump(next)).notes.find((n) => n.name === "small.md").content).toBe(
    "small and unsaved",
  );
});

test("two tabs past the limit still sync (BroadcastChannel)", async ({ page, context }) => {
  await openApp(page);
  await bigNotes(page);
  await flushed(page);
  const other = await context.newPage();
  await openApp(other);
  await other.evaluate(() => createNote("from-other.md", "hello"));
  await expect(page.locator(".note-item", { hasText: "from-other.md" })).toHaveCount(1);
  await page.click(".note-item:has-text('small.md')");
  await page.locator("#editor").focus();
  await page.evaluate(() => (editor.selectionStart = editor.selectionEnd = editor.value.length));
  await page.keyboard.type("!");
  await expect
    .poll(() => other.evaluate(() => state.notes.find((n) => n.name === "small.md").content))
    .toBe("small!");
});

test("without IndexedDB everything works as before", async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new Error("blocked");
    };
  });
  await openApp(page);
  expect(await page.evaluate(() => idb)).toBeNull();
  await page.evaluate(() => createNote("plain.md", "still saved"));
  await page.waitForTimeout(400);
  await reloaded(page);
  expect(await page.evaluate(() => state.notes.map((n) => n.name))).toContain("plain.md");
});

test("an IndexedDB that never answers doesn't hang the app", async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => ({});
  });
  await page.goto("/");
  await page.waitForFunction(() => document.querySelector(".note-item"), null, { timeout: 6000 });
  expect(await page.evaluate(() => idb)).toBeNull();
});

test("a note deleted in another tab leaves this tab's URL", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => createNote("doomed.md", "bye"));
  const other = await context.newPage();
  await openApp(other);
  await other.evaluate(() => {
    confirmDelete(state.notes.find((n) => n.name === "doomed.md").id);
  });
  await other.click("#modalConfirm");
  // A reload would otherwise restore the note from the URL
  await expect
    .poll(() => page.evaluate(() => decodeURIComponent(location.hash)))
    .not.toContain("doomed.md");
  await reloaded(page);
  expect(await page.evaluate(() => state.notes.map((n) => n.name))).not.toContain("doomed.md");
});

test("the full mirror is written at most every MIRROR_EVERY ms, and on hide", async ({ page }) => {
  await openApp(page);
  await flushed(page);
  const writes = await page.evaluate(async () => {
    const keys = [];
    // On the prototype: WebKit stores "localStorage.setItem = …" as an item
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      keys.push(k);
      return set.call(this, k, v);
    };
    for (let i = 0; i < 5; i++) {
      getActiveNote().content += i;
      getActiveNote().updatedAt = Date.now();
      saveState();
    }
    const quick = keys.filter((k) => k === "notepad_data").length;
    const journal = keys.filter((k) => k === "notepad_pending").length;
    const later = await new Promise((r) =>
      setTimeout(() => r(keys.filter((k) => k === "notepad_data").length), MIRROR_EVERY + 200),
    );
    return { quick, journal, later };
  });
  // Right after a mirror write, saves only journal; one mirror write follows
  expect(writes.quick).toBe(0);
  expect(writes.journal).toBe(5);
  expect(writes.later).toBe(1);

  // Hiding the tab writes a waiting mirror at once
  await page.evaluate(() => {
    getActiveNote().content += "!";
    getActiveNote().updatedAt = Date.now();
    saveState();
  });
  expect(await page.evaluate(() => mirrorTimer !== null)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem("notepad_data")).notes[0].content.endsWith("!")),
  ).toBe(true);
});

test("a tab that dies between saves keeps the edit (journal)", async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => createNote("crash.md", "before"));
  await flushed(page);
  // Neither IndexedDB nor the mirror get to write anymore
  await page.evaluate(() => {
    idbCommit = () => new Promise(() => {});
    writeMirror = () => {};
    flushMirror = () => {};
    getActiveNote().content = "before and after";
    getActiveNote().updatedAt = Date.now();
    saveState();
  });
  await page.close();
  const next = await context.newPage();
  await openApp(next);
  expect(await next.evaluate(() => state.notes.find((n) => n.name === "crash.md").content)).toBe(
    "before and after",
  );
});
