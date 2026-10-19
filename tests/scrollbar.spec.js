// Real scrollbars, as on Android: headless Chromium hides them by default
const { test, expect, openApp } = require("./fixtures");

test.use({
  viewport: { width: 390, height: 760 },
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

test("wrap mode: highlight layer wraps at the textarea's width", async ({
  page,
}) => {
  await openApp(page);
  const [ta, hl] = await page.evaluate(async () => {
    await createNote("w.txt", "word ".repeat(400));
    if (!editorArea.classList.contains("wrap")) toggleWrap();
    const inner = (el) => {
      const s = getComputedStyle(el);
      return (
        el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
      );
    };
    return [inner(editor), inner(highlightLayer)];
  });
  expect(hl).toBe(ta);
});
