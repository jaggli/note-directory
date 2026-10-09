const { test, expect, openApp } = require("./fixtures");

// [text before ("|" = cursor), keys, text after] — checked against real vim
// 9.1 with 'autoindent' (S/cc keep indent). Undo is per command, as when
// typing (vim's :normal would group them). Keys: one char each, <Esc>.
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
  ["|abc\ndef", "$ax<Esc>", "abc|x\ndef"], // $ lands on the last char; a appends
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
  ["|a b", "2dd", "|a b"], // count past the last line fails
  ["a\n|b\nc", "5dd", "|a"], // but clamps when it can move
  ["a\nb\n|c", "3dd", "a\nb\n|c"],
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
  ["|abcdefghij", "vld3.", "|efghij"], // "." ignores its count after visual
  ["|abcdef", "vl3d", "|cdef"],
  ["|a\nb", "V3>", "      |a\nb"],
  ["|a\nb", "V3>j.", "      a\n      |b"],
  ["|a\nb\nc", "V>2.", "    |a\nb\nc"],

  // %, ge
  ["f|oo(a, (b)) x", "%", "foo(a, (b)|) x"],
  ["foo(a, (b)|) x", "%", "foo|(a, (b)) x"],
  ["|x [1, 2] y", "d%", "| y"],
  ["x |[1, 2] y", "d%", "x | y"],
  ["x {a\n|}", "%", "x |{a\n}"],
  ["|a\nb\nc\nd", "50%", "a\n|b\nc\nd"],
  ["foo b|ar", "ge", "fo|o bar"],
  ["foo.b|ar", "ge", "foo|.bar"],
  ["a\n\n|b", "ge", "a\n|\nb"],
  ["foo ba|r", "dge", "f|o"],
  ["foo.bar b|az", "gE", "foo.ba|r baz"],

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

// [text before, ex command / search keys, text after] — generated from real
// vim 9.1 with 'ignorecase' + 'smartcase' (-u NONE, set ic scs)
const EX_CASES = [
  ["|foo foo\nfoo",":s/foo/bar/","|bar foo\nfoo"],
  ["|foo foo\nfoo",":%s/foo/bar/g","bar bar\n|bar"],
  ["|foo foo\nfoo",":%s/foo/bar/","bar foo\n|bar"],
  ["|foo",":s/\\(o\\+\\)/[\\1]/","|f[oo]"],
  ["|a/b",":s/\\//-/","|a-b"],
  ["|Foo",":s/foo/x/i","|x"],
  ["|foo bar",":s/\\<bar\\>/X/","|foo X"],
  ["|foobar bar",":s/\\<bar/X/g","|foobar X"],
  ["|a1b22c333",":s/\\d\\+/<&>/g","|a<1>b<22>c<333>"],
  ["|hello world",":s/\\w\\+/\\u&/g","|Hello World"],
  ["|hello world",":s/.*/\\U&/","|HELLO WORLD"],
  ["|a,b,c",":s/,/\\r/g","a\nb\n|c"],
  ["|x\ny\nz",":2,3s/^/# /","x\n# y\n|# z"],
  ["|aaa",":s/a\\{2}/b/","|ba"],
  ["|aaa",":s/a\\{-1,}/b/","|baa"],
  ["|foo(bar)",":s/(bar)/[x]/","|foo[x]"],
  ["|foo bar",":s/\\v(foo) (bar)/\\2 \\1/","|bar foo"],
  ["|a.b.c",":s/\\V./-/g","|a-b-c"],
  ["|abc",":s/b\\|c/X/g","|aXX"],
  ["|tab\there",":s/\\s/_/","|tab_here"],
  ["|one two",":s#o#0#g","|0ne tw0"],
  ["|a\nb\nc\nd",":.,+1s/$/!/","a!\n|b!\nc\nd"],
  ["|a\nb\nc",":$s/c/C/","a\nb\n|C"],
  ["|AbC abc",":s/abc/x/g","|x x"],
  ["|AbC abc",":s/Abc/x/g","|AbC abc"],
  ["|AbC abc",":s/abc\\C/x/g","|AbC x"],
  ["|x",":s/y/z/","|x"],
  ["|ab",":s/\\(a\\)\\(b\\)/\\2\\1/","|ba"],
  ["|a b",":s/ /\\t/","|a\tb"],
  ["|price 5",":s/\\d/$&/","|price $5"],
  ["|abc",":s/[[:alpha:]]/X/g","|XXX"],
  ["|a\n\nb",":%s/^$/EMPTY/","a\n|EMPTY\nb"],
  ["|a-b",":s/-/\\&/","|a&b"],
  ["|ab",":s/a/x/|","|xb"],
  ["|aXbXc",":s/x/-/g","|a-b-c"],
  ["|foo foo",":s/foo/bar/n","|foo foo"],
  ["|a\nb\nc\nd\ne",":2;+1s/^/>/","a\n>b\n|>c\nd\ne"],
  ["|one two three",":s/\\v(\\w+) (\\w+)/\\2 \\1/","|two one three"],
  ["|x  y",":s/ \\+/ /","|x y"],
  ["|a\nb\nc","Vj:s/$/!/","a!\n|b!\nc"],
  ["|a foo b foo","/foo","a |foo b foo"],
  ["|foo a foo","/foo","foo a |foo"],
  ["|ab abc","/\\<abc\\>","ab |abc"],
  ["|x Foo foo","/foo","x |Foo foo"],
  ["|x Foo foo","/Foo","x |Foo foo"],
  ["|x foo Foo","/Foo","x foo |Foo"],
  ["|a1 b22","/\\d\\+","a|1 b22"],
  ["|one\ntwo three","/t\\w\\+e","one\ntwo |three"],
  ["foo |x foo","?foo","|foo x foo"],
  ["|foo x foo","*","foo x |foo"],
  ["|foobar foo","*","|foobar foo"],
  ["|a x b x c x","/xn","a x b |x c x"],
  ["x a |x b","#","|x a x b"],
];

test(":s and search match real vim", async ({ page }) => {
  await setup(page);
  const failures = [];
  for (const [before, cmd, after] of EX_CASES) {
    const got = await page.evaluate(
      ([before, cmd]) => {
        const cur = before.indexOf("|");
        editor.value = before.replace("|", "");
        getActiveNote().content = editor.value;
        vimState.lastSearch = null;
        vimSetMode("normal");
        vimSetCursor(cur);
        if (cmd.startsWith(":")) vimExecCommand(cmd.slice(1));
        else if (/^[/?]/.test(cmd)) {
          const n = cmd.length > 2 && cmd.endsWith("n");
          vimState.searchDirection = cmd[0] === "/" ? 1 : -1;
          vimSearch(n ? cmd.slice(1, -1) : cmd.slice(1), vimState.searchDirection);
          if (n) vimExecNormal("n");
        } else if (cmd.includes(":")) {
          // visual keys, then ":" prefills '<,'>
          const [keys, ex] = cmd.split(":");
          for (const k of keys) vimState.mode === "visual" ? vimExecVisual(k) : vimExecNormal(k);
          vimExecVisual(":");
          const range = vimCommandInput.value;
          vimCloseCommandBar();
          vimExecCommand(range + ex);
        } else for (const k of cmd) vimExecNormal(k);
        vimCloseCommandBar();
        const p = editor.selectionStart;
        return editor.value.slice(0, p) + "|" + editor.value.slice(p);
      },
      [before, cmd],
    );
    if (got !== after) failures.push({ before, cmd, expected: after, got });
  }
  expect(failures).toEqual([]);
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

test("H / M / L move within the visible screen", async ({ page }) => {
  await setup(page);
  const r = await page.evaluate(() => {
    editor.value = Array.from({ length: 300 }, (_, i) => "line " + i).join("\n");
    editor.dispatchEvent(new Event("input"));
    vimSetMode("normal");
    vimSetCursor(vimLineStart(100));
    vimUpdateBlockCursor(); // scrolls line 100 into view
    const lineAt = (k) => {
      vimSetCursor(vimLineStart(100));
      vimExecNormal(k);
      return vimLineOf(editor.selectionStart);
    };
    const [top, bottom] = visibleRows();
    return { top, bottom, H: lineAt("H"), M: lineAt("M"), L: lineAt("L") };
  });
  expect(r.H).toBeGreaterThan(r.top); // scroll margin
  expect(r.L).toBeLessThan(r.bottom);
  expect(r.M).toBeGreaterThan(r.H);
  expect(r.M).toBeLessThan(r.L);
});
