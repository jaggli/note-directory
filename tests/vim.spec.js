const { test, expect, openApp } = require("./fixtures");

// [text before ("|" = cursor), keys, text after] — expectations follow real
// vim. Keys: one char each, <Esc> for Escape.
const CASES = [
  // motions
  ["|foo bar baz", "w", "foo |bar baz"],
  ["|  foo", "w", "  |foo"],
  ["foo |bar", "b", "|foo bar"],
  ["foo b|ar", "b", "foo |bar"],
  ["|foo bar", "e", "fo|o bar"],
  ["|foo.bar baz", "W", "foo.bar |baz"],
  ["|abc\ndef", "$", "ab|c\ndef"],
  ["|abc\ndef", "$l", "ab|c\ndef"],
  ["|abcdef\nab\nabcdef", "$jj", "abcdef\nab\nabcde|f"],
  ["abc|def\nx\nabcdef", "jj", "abcdef\nx\nabc|def"],
  ["|a\nb\nc", "G", "a\nb\n|c"],
  ["|a\nb\nc", "2G", "a\n|b\nc"],
  ["a\nb\n|c", "gg", "|a\nb\nc"],
  ["|a,b,c", "f,", "a|,b,c"],
  ["|a,b,c", "2f,", "a,b|,c"],
  ["|a,b,c", "t,;", "a,|b,c"],
  ["|a b\n\nc", "}", "a b\n|\nc"],
  ["a b\n\n|c", "{", "a b\n|\nc"],

  // operators + motions
  ["|foo bar", "dw", "|bar"],
  ["foo |bar\nbaz", "dw", "foo| \nbaz"],
  ["|foo\n  bar", "dw", "|\n  bar"],
  ["|foo bar", "cwxx<Esc>", "x|x bar"],
  ["|foo bar", "de", "| bar"],
  ["foo b|ar", "db", "foo |ar"],
  ["|abc\ndef\nghi", "dj", "|ghi"],
  ["abc\n|def\nghi", "dk", "|ghi"],
  ["|a\nb\nc\nd", "d2j", "|d"],
  ["|a b c d e f g", "2d3w", "|g"],
  ["abc\ndef\n|ghi", "dd", "abc\n|def"],
  ["|a b", "2dd", "|"],
  ["a|bc", "D", "|a"],
  ["|abc", "Cx<Esc>", "|x"],
  ["|  foo", "Sx<Esc>", "  |x"],

  // text objects
  ["foo(a, |b)", "di(", "foo(|)"],
  ["foo(a, b|)", "di)", "foo(|)"],
  ["g(f(a|))", "di)", "g(f(|))"],
  ['say "he|llo" now', 'ci"x<Esc>', 'say "|x" now'],
  ["foo b|ar baz", "daw", "foo |baz"],
  ["foo b|ar", "diw", "foo| "],
  ["|x\n\n\ny", "dap", "|y"],
  ["|a\nb\n\nc", ">ip", "  |a\n  b\n\nc"],

  // simple commands
  ["|abc", "x", "|bc"],
  ["ab|c", "x", "a|b"],
  ["|ab\ncd", "5x", "|\ncd"],
  ["|abc\ndef", "$x", "a|b\ndef"],
  ["|abc", "rX", "|Xbc"],
  ["|abc", "2rX", "X|Xc"],
  ["|abC", "3~", "AB|c"],
  ["|a\n  b", "J", "a| b"],
  ["|a\n\nb", "J", "|a\nb"],
  ["|a\nb\nc", ">>", "  |a\nb\nc"],

  // registers
  ["a\n|b", "ddp", "a\n|b"],
  ["|a\nb\nc", "yyjp", "a\nb\n|a\nc"],
  ["|abc def", "yeP", "ab|cabc def"],
  ["|abc", "yl2p", "aa|abc"],

  // dot repeat
  ["|foo foo foo", "cwbar<Esc>w.", "bar ba|r foo"],
  ["|a1 a2 a3", "ciwX<Esc>w.", "X |X a3"],
  ["|abc", "ifoo<Esc>.", "fofo|ooabc"],
  ["|abc", "Ax<Esc>.", "abcx|x"],
  ["|a\nb", "ox<Esc>.", "a\nx\n|x\nb"],
  ["|a,b,c", "df,.", "|c"],
  ["|a,b", "df,.", "|b"],
  ["|x y", "i<Esc>.", "|x y"],
  ["|a b c d", "dw2.", "|d"],

  // visual
  ["|abcdef", "vlld", "|def"],
  ["|abcdef", "vd", "|bcdef"],
  ["abc|def", "vhhlllld", "ab|c"],
  ["a\nb\n|c", "vggd", "|"],
  ["|foo bar", "viwd", "| bar"],
  ["|a\nb\nc", "Vjd", "|c"],
  ["|a\nb", "Vyp", "a\n|a\nb"],
  ["|a\nb\nc", "V>", "  |a\nb\nc"],
  ["|a\nb\nc", "Vj>", "  |a\n  b\nc"],
  ["|a\nb\nc", "VjJ", "a| b\nc"],
  ["|abc", "vlU", "|ABc"],

  // dot after visual changes: same amount of text from the cursor
  ["|abcdef", "vld.", "|ef"],
  ["|a\nb\nc\nd", "Vjd.", "|"],
  ["|a\nb\nc", "V>j.", "  a\n  |b\nc"],
  ["|foo bar", "vecx<Esc>w.", "x |x"],
  ["|ab\ncd\nef", "vjd.", "|f"],
  ["|abc", "vl~l.", "A|bC"],

  // undo
  ["|abc", "xxu", "|bc"],
  ["|abc", "xxuu", "|abc"],
];

async function setup(page) {
  await openApp(page);
  await page.evaluate(async () => {
    await createNote("vim.txt", "");
    vimState.enabled = true;
  });
}

// Runs keys through the vim engine; insert-mode chars are typed natively
function runVim(page, text, keys) {
  return page.evaluate(
    ([text, keys]) => {
      const cursor = text.indexOf("|");
      editor.value = text.replace("|", "");
      getActiveNote().content = editor.value;
      Object.assign(vimState, { lastChange: null, clipboard: "", desiredCol: null, findChar: null });
      vimSetMode("normal");
      vimSetCursor(cursor);
      for (const tok of keys.match(/<Esc>|./gs)) {
        const key = tok === "<Esc>" ? "Escape" : tok;
        if (vimState.mode === "insert") {
          if (key === "Escape") vimLeaveInsert();
          else {
            editor.setRangeText(key, editor.selectionStart, editor.selectionEnd, "end");
            editor.dispatchEvent(new Event("input"));
          }
        } else if (vimState.mode === "visual") vimExecVisual(key);
        else vimExecNormal(key);
      }
      const pos = vimState.mode === "visual" ? vimState.visualHead : editor.selectionStart;
      return editor.value.slice(0, pos) + "|" + editor.value.slice(pos);
    },
    [text, keys],
  );
}

test("vim keys behave like vim", async ({ page }) => {
  await setup(page);
  const failures = [];
  for (const [before, keys, after] of CASES) {
    const got = await runVim(page, before, keys);
    if (got !== after) failures.push({ before, keys, expected: after, got });
  }
  expect(failures).toEqual([]);
});

test("ex substitute and search", async ({ page }) => {
  await setup(page);
  const ex = (text, cmd) =>
    page.evaluate(
      ([text, cmd]) => {
        editor.value = text;
        vimSetMode("normal");
        vimSetCursor(0);
        vimExecCommand(cmd);
        return editor.value;
      },
      [text, cmd],
    );
  expect(await ex("foo foo\nfoo", "s/foo/bar/")).toBe("bar foo\nfoo");
  expect(await ex("foo foo\nfoo", "%s/foo/bar/g")).toBe("bar bar\nbar");
  expect(await ex("foo foo\nfoo", "%s/foo/bar/")).toBe("bar foo\nbar");
  expect(await ex("foo", "%s/(o+)/[$1]/")).toBe("f[oo]");
  expect(await ex("a/b", "s/\\//-/")).toBe("a-b");
  expect(await ex("Foo", "s/foo/x/i")).toBe("x");

  // Only whole words match: "a" occurs once, so * stays put
  expect(await runVim(page, "|a foo b foo", "*")).toBe("|a foo b foo");
  const search = await page.evaluate(() => {
    editor.value = "foo a foo b foo";
    vimSetCursor(0);
    vimState.searchDirection = 1;
    vimSearch("foo", 1);
    const first = editor.selectionStart;
    vimExecNormal("n");
    const second = editor.selectionStart;
    vimExecNormal("N");
    return [first, second, editor.selectionStart];
  });
  expect(search).toEqual([6, 12, 6]);
  expect(await runVim(page, "|foo x foo", "*")).toBe("foo x |foo");
});

test("error bar does not swallow the next command", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    vimShowError("boom");
    editor.focus(); // leave without pressing a key
    vimOpenCommandBar(":");
  });
  expect(await page.evaluate(() => vimCommandInput.readOnly)).toBe(false);
});

test("undo in vim mode keeps the swap file in sync", async ({ page }) => {
  await setup(page);
  const swap = await page.evaluate(() => {
    editor.value = "abc";
    getActiveNote().content = "abc";
    vimSetMode("normal");
    vimSetCursor(0);
    vimExecNormal("x");
    vimExecNormal("u");
    return [vimState.bufferDirty, localStorage.getItem("notepad_swap_" + getActiveNote().id)];
  });
  expect(swap).toEqual([false, null]);
});

test("real keyboard: normal, insert, visual, command bar, search", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => createNote("kb.txt", "one two three\nfour"));
  await page.click("#btnVim");
  await page.evaluate(() => vimSetCursor(0));
  const text = () => page.evaluate(() => editor.value);

  await page.keyboard.type("dw");
  expect(await text()).toBe("two three\nfour");
  await page.keyboard.type("Ahi");
  await page.keyboard.press("Escape");
  expect(await text()).toBe("two threehi\nfour");
  expect(await page.evaluate(() => vimState.mode)).toBe("normal");

  await page.keyboard.type("0vex");
  expect(await text()).toBe(" threehi\nfour");

  await page.keyboard.type(":");
  await page.keyboard.type("%s/four/4/");
  await page.keyboard.press("Enter");
  expect(await text()).toBe(" threehi\n4");

  await page.keyboard.type("gg/4");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => editor.selectionStart)).toBe(9);

  await page.keyboard.type(":w");
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => [vimState.bufferDirty, getActiveNote().content])).toEqual([
    false,
    " threehi\n4",
  ]);
});
