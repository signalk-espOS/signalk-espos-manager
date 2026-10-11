import { chromium } from "@playwright/test";

/**
 * Walks the hosted flasher's guided start: the jobs, one job's boards, and one
 * board's card. Needs no server or device, only the built page (`npx vite
 * preview`) and the live registry index the page fetches. See README.md here.
 */
const BASE =
  process.env.BASE ?? "http://localhost:4173/signalk-espos-manager/flash/";
const OUT = process.env.TMPDIR ?? "/tmp";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM,
});
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
let index;
page.on("response", async (r) => {
  if (r.url().endsWith("/index.json")) index = (await r.json()).updated;
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".usecases");
await page.screenshot({ path: `${OUT}/flasher-start.png`, fullPage: true });

await page.locator(".usecase").first().click();
await page.waitForSelector(".board-tile");
await page.screenshot({ path: `${OUT}/flasher-usecase.png`, fullPage: true });

await page.locator(".board-tile").first().click();
await page.waitForSelector(".board-entry");
await page.screenshot({ path: `${OUT}/flasher-board.png`, fullPage: true });

console.log(`registry index updated ${index ?? "(not seen)"}`);
console.log(errors.length === 0 ? "no page errors" : errors.join("\n"));
await browser.close();
