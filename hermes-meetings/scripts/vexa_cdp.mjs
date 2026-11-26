// vexa_cdp.mjs — act in the meeting the bot is sitting in.
//
// The Vexa bot joins the call in a real Chromium inside the vexa-lite container. This driver
// attaches to THAT browser over CDP (the local patch opens a DevTools port) and acts on the page
// the meeting is running in — so the agent can write in the meeting chat, click through the UI, and
// read the shared screen, instead of only hearing it.
//
// It runs INSIDE the container (node + playwright live there) and talks to the bot's browser on
// 127.0.0.1:9222. The host pipes this file in with `docker exec -i ... node --input-type=module -`.
//
//   chat --text "..."   post a message to the meeting chat
//   discover            dump the chat-related elements (for when the selectors moved)
//   pages               list the pages the browser has
//
// Output: one JSON object on stdout.

const ENDPOINT = process.env.VEXA_CDP_ENDPOINT || "http://127.0.0.1:9222";
const PLATFORM_HINTS = /meet\.google\.com|zoom\.us|teams\.microsoft|jitsi|jitsi\.meet|bigbluebutton/i;

// Chat input candidates, best first. Meet's has been a textarea with
// aria-label "Send a message to everyone"; Zoom and Teams differ. When the platform ships a
// redesign the chain misses and `discover` shows what is there instead.
const INPUT_SELECTORS = [
  'textarea[aria-label*="send a message" i]',
  'input[aria-label*="send a message" i]',
  'textarea[placeholder*="send a message" i]',
  'input[placeholder*="send a message" i]',
  'textarea[aria-label*="chat" i]',
  'input[aria-label*="chat" i]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="chat" i]',
  'textarea[placeholder*="chat" i]',
  'input[placeholder*="chat" i]',
];

// Buttons that open the chat panel.
const OPEN_CHAT_SELECTORS = [
  'button[aria-label*="chat with everyone" i]',
  'button[aria-label*="open chat" i]',
  'button[aria-label*="chat" i]',
  '[role="button"][aria-label*="chat" i]',
];

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function connect() {
  const { chromium } = await import("playwright");
  // JS spells it connectOverCDP (connect_over_cdp is the Python name).
  const browser = await chromium.connectOverCDP(ENDPOINT);
  const contexts = browser.contexts();
  if (!contexts.length) throw new Error("no browser context over CDP");
  const ctx = contexts[0];
  const pages = ctx.pages();
  if (!pages.length) throw new Error("no pages open in the meeting browser");
  const page =
    pages.find((p) => PLATFORM_HINTS.test(p.url())) ||
    pages[pages.length - 1];
  return { browser, ctx, pages, page };
}

async function findChatInput(page) {
  for (const sel of INPUT_SELECTORS) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) return { sel, el };
    }
  }
  return null;
}

async function openChatPanel(page) {
  for (const sel of OPEN_CHAT_SELECTORS) {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      // Only a button that is NOT the message box opens the panel.
      const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "");
      if (tag === "textarea" || tag === "input") continue;
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1200);
      return { opened: true, via: sel };
    }
  }
  return { opened: false };
}

async function discover(page) {
  return page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll(
      'textarea, input, [contenteditable="true"], button, [role="button"], [role="textbox"]'
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const visible = !!(r.width && r.height);
      const aria = el.getAttribute("aria-label") || "";
      const ph = el.getAttribute("placeholder") || "";
      const cls = (el.getAttribute("class") || "").slice(0, 60);
      if (!aria && !ph && !/chat|message|send/i.test(cls)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        aria,
        placeholder: ph,
        cls,
        contenteditable: el.getAttribute("contenteditable") || "",
        visible,
        value: "value" in el ? String(el.value || "").slice(0, 40) : "",
      });
    }
    return out.slice(0, 60);
  });
}

async function cmdChat(page, args) {
  const text = args.text || "";
  if (!text) throw new Error("--text is required");

  let found = await findChatInput(page);
  let opened = null;
  if (!found) {
    opened = await openChatPanel(page);
    if (opened.opened) found = await findChatInput(page);
  }
  if (!found) {
    const d = await discover(page);
    out({ ok: false, error: "chat input not found", opened, candidates: d });
    return 3;
  }

  await found.el.click({ timeout: 5000 }).catch(() => {});
  // Playwright's fill() uses the native value setter and fires input/change, which is what
  // React-controlled inputs need — a plain evaluate("el.value = ..") would not update state.
  await found.el.fill(text, { timeout: 5000 });
  const filled = await found.el.inputValue().catch(() => "");
  await found.el.press("Enter", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);
  const after = await found.el.inputValue().catch(() => "");

  // Verified by the input being cleared (the message left) — Meet clears the box on send.
  const sent = after.length === 0 && filled.length > 0;
  out({
    ok: sent,
    selector: found.sel,
    opened,
    filled: filled.slice(0, 80),
    after: after.slice(0, 40),
    sent,
    url: page.url(),
  });
  return sent ? 0 : 4;
}

async function cmdDiscover(page) {
  out({ ok: true, url: page.url(), candidates: await discover(page) });
  return 0;
}

async function cmdPages(ctx) {
  const pages = ctx.pages().map((p) => ({ url: p.url(), title: "" }));
  out({ ok: true, pages });
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "pages";
  const args = {};
  for (let i = 1; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, "")] = argv[i + 1];
  }
  const { browser, ctx, page } = await connect();
  try {
    if (cmd === "chat") return await cmdChat(page, args);
    if (cmd === "discover") return await cmdDiscover(page);
    return await cmdPages(ctx);
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    out({ ok: false, error: String(e && e.message ? e.message : e) });
    process.exit(1);
  });
