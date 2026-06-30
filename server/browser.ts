import { chromium, Browser, BrowserContext, Page } from "playwright";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

export async function launchBrowser(): Promise<Page> {
  if (browser) await closeBrowser();

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  return page;
}

export async function getPage(): Promise<Page> {
  if (!page) return launchBrowser();
  return page;
}

/** Navigate the headless Playwright browser to a URL. */
export async function navigateTo(url: string): Promise<Page> {
  const pg = await getPage();
  await pg.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  return pg;
}

export async function injectCode(html: string, css: string, js: string): Promise<void> {
  const pg = await getPage();
  const fullPage = `
<!DOCTYPE html>
<html>
<head><style>${css}</style></head>
<body>${html}<script>${js}</script></body>
</html>`;
  await pg.setContent(fullPage, { waitUntil: "networkidle" });
}

export async function extractDOM(): Promise<string> {
  const pg = await getPage();
  return pg.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const elements: string[] = [];
    let idx = 0;
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
      const tag = node.tagName.toLowerCase();
      const id = node.id ? ` id="${node.id}"` : "";
      const cls = node.className && typeof node.className === "string"
        ? ` class="${node.className}"` : "";
      const text = (node as HTMLElement).innerText?.trim().slice(0, 100) || "";
      const attrs: string[] = [];
      if (node.getAttribute("placeholder"))
        attrs.push(`placeholder="${node.getAttribute("placeholder")}"`);
      if (node.getAttribute("type"))
        attrs.push(`type="${node.getAttribute("type")}"`);
      if (node.getAttribute("name"))
        attrs.push(`name="${node.getAttribute("name")}"`);
      if (node.getAttribute("aria-label"))
        attrs.push(`aria-label="${node.getAttribute("aria-label")}"`);
      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      const textStr = text ? ` "${text}"` : "";
      elements.push(`[${idx}] <${tag}${id}${cls}${attrStr}>${textStr}`);
      idx++;
    }
    return elements.join("\n");
  });
}

export async function clickElement(index: number): Promise<void> {
  const pg = await getPage();
  await pg.evaluate((idx) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let i = 0;
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
      if (i === idx) {
        (node as HTMLElement).click();
        return;
      }
      i++;
    }
  }, index);
  await pg.waitForTimeout(500);
}

export async function typeIntoElement(index: number, text: string): Promise<void> {
  const pg = await getPage();
  await pg.evaluate(({ idx, text }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let i = 0;
    let node: Element | null;
    while ((node = walker.nextNode() as Element | null)) {
      if (i === idx) {
        const el = node as HTMLInputElement;
        el.focus();
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      i++;
    }
  }, { idx: index, text });
  await pg.waitForTimeout(300);
}

export async function getPageContent(): Promise<string> {
  const pg = await getPage();
  return pg.content();
}

/** Take a PNG screenshot and return a base64 data URL (DeepSeek-compatible). */
export async function takeScreenshot(): Promise<string> {
  const pg = await getPage();
  const buf = await pg.screenshot({ type: "png" });
  return `data:image/png;base64,${buf.toString("base64")}`;
}

export async function closeBrowser(): Promise<void> {
  await context?.close();
  await browser?.close();
  browser = null;
  context = null;
  page = null;
}
