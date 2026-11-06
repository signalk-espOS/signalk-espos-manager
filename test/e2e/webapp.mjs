import { chromium } from "@playwright/test";

/**
 * Drives the built webapp in a real browser. Not part of `npm test`: it needs
 * a running server and real devices. See README.md in this directory.
 */
const BASE =
  process.env.BASE ?? "http://localhost:3100/signalk-espos-manager/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
const apiCalls = [];
page.on("response", (r) => { if (r.url().includes("/plugins/signalk-espos-manager/api/")) apiCalls.push(r.status() + " " + r.url().split("/api/")[1]); });

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

console.log("=== title:", await page.title());
console.log("=== heading:", await page.locator("h1").first().textContent());

// The device list
const devices = await page.locator(".device-name").allTextContents();
console.log("=== devices rendered:", devices.length);
for (const d of devices) console.log("   -", d.replace(/\s+/g, " ").trim());

const meta = await page.locator(".device-meta").allTextContents();
for (const m of meta.slice(0, 6)) console.log("     ", m.replace(/\s+/g," ").trim());

console.log("=== api calls:", [...new Set(apiCalls)].join(" | "));
await page.screenshot({ path: (process.env.TMPDIR ?? "/tmp") + "/webapp-fleet.png", fullPage: true });

// The fleet key: open the removal question and dismiss it with "Keep it",
// which must leave the key in place. The README's scratch config sets a key.
const keyDeletes = [];
page.on("request", (r) => { if (r.method() === "DELETE" && r.url().includes("/api/fleet-key")) keyDeletes.push(r.url()); });
const removeKey = page.locator("button", { hasText: /^Remove$/ });
if (await removeKey.count()) {
  await removeKey.first().click();
  const keep = page.locator("button", { hasText: "Keep it" });
  await keep.waitFor();
  console.log("=== fleet key removal:", (await keep.locator("xpath=../..").innerText()).replace(/\s+/g, " ").trim());
  await page.screenshot({ path: (process.env.TMPDIR ?? "/tmp") + "/webapp-fleet-key-remove.png", fullPage: true });
  // The question has to work on a phone at the helm too.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({ path: (process.env.TMPDIR ?? "/tmp") + "/webapp-fleet-key-remove-360.png", fullPage: true });
  await page.setViewportSize({ width: 900, height: 1000 });
  await keep.click();
  const fleetNow = await page.evaluate(async () => {
    const r = await fetch("/plugins/signalk-espos-manager/api/fleet", { credentials: "same-origin" });
    return r.ok ? (await r.json()).fleetKey : undefined;
  });
  const kept = (await keep.count()) === 0 && keyDeletes.length === 0 && fleetNow?.set === true;
  console.log("=== fleet key kept by Keep it:", kept, keyDeletes.length ? `(DELETE sent: ${keyDeletes.join(", ")})` : "");
  if (!kept) process.exitCode = 1;
} else {
  console.log("=== fleet key: none set, so the removal question could not be checked; set auth.fleetKey as in README.md");
  process.exitCode = 1;
}

// Open a device
if (devices.length > 0) {
  await page.locator(".device-main").first().click();
  await page.waitForTimeout(2500);
  console.log("=== device page heading:", await page.locator("h2").first().textContent());
  const facts = await page.locator(".facts dt").allTextContents();
  console.log("=== facts shown:", facts.join(", "));
  const updateText = await page.locator(".card", { hasText: "Firmware updates" }).first().innerText();
  console.log("=== update section ===");
  console.log(updateText.split("\n").slice(0,8).map(l=>"   "+l).join("\n"));
  await page.screenshot({ path: (process.env.TMPDIR ?? "/tmp") + "/webapp-device.png", fullPage: true });
}

// The store
await page.locator("button.tab", { hasText: "Firmware" }).click();
await page.waitForTimeout(2500);
const projects = await page.locator(".projects h3").allTextContents();
console.log("=== store projects:", projects.map(p=>p.replace(/\s+/g," ").trim()).join(" | "));
await page.screenshot({ path: (process.env.TMPDIR ?? "/tmp") + "/webapp-store.png", fullPage: true });

console.log("=== console errors:", errors.length ? errors.join("; ") : "none");
await browser.close();
