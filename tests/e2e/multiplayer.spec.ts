import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __ahb: any;
  }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  // Close every page so software WebGL contexts don't pile up between tests.
  await Promise.all(contexts.splice(0).map((c) => c.close()));
});

const IPAD = {
  // iPad (gen 7) landscape, minus the WebKit-only browser hint: Chromium touch emulation.
  userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  viewport: { width: 1080, height: 810 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

async function openKitchen(browser: Browser, name: string): Promise<{ page: Page; code: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto("/?debug=1");
  await page.fill("#name", name);
  await page.click("#create");
  await page.waitForFunction(() => window.__ahb?.session?.welcome?.code, null, { timeout: 45_000 });
  const code = await page.evaluate(() => window.__ahb.session.welcome.code as string);
  return { page, code };
}

async function joinOnTablet(browser: Browser, name: string, code: string): Promise<Page> {
  const ctx = await browser.newContext(IPAD);
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto("/?debug=1");
  await page.fill("#name", name);
  await page.fill("#code", code);
  await page.locator("#join").tap();
  await page.waitForFunction(() => window.__ahb?.game, null, { timeout: 45_000 });
  // First touch session shows the touch tutorial.
  await page.getByRole("button", { name: "Got it" }).tap();
  return page;
}

const players = (p: Page) => p.evaluate(() => window.__ahb.session.state.players.size as number);
const held = (p: Page) => p.evaluate(() => window.__ahb.session.state.players.get(window.__ahb.session.sessionId)?.held as string);
const itemKind = (p: Page, id: string) => p.evaluate((i) => window.__ahb.session.state.items.get(i)?.kind as string, id);

/** Places the player and aims the camera at a world point. */
async function aimAt(p: Page, from: { x: number; z: number }, target: { x: number; y: number; z: number }, crouch = false) {
  const eyeY = crouch ? 1.15 : 1.62;
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.atan2(eyeY - target.y, Math.hypot(dx, dz));
  await p.evaluate(([x, z, yw, pt]) => window.__ahb.teleport(x, z, yw, pt), [from.x, from.z, yaw, pitch] as const);
  // Wait until the authoritative position arrives and prediction has reconciled.
  await expect
    .poll(() => p.evaluate(() => window.__ahb.game.debug().position as { x: number; z: number }), { timeout: 10_000 })
    .toMatchObject({ x: expect.closeTo(from.x, 1), z: expect.closeTo(from.z, 1) });
  await p.evaluate(([yw, pt]) => window.__ahb.game.debugLook(yw, pt), [yaw, pitch] as const);
  await p.waitForTimeout(400);
}

async function center(p: Page) {
  const box = (await p.locator("#game").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tapCenter(p: Page) {
  const c = await center(p);
  await p.touchscreen.tap(c.x, c.y);
}

test("a desktop browser and a touch tablet share one kitchen", async ({ browser }) => {
  const { page: desk, code } = await openKitchen(browser, "Avery");
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  const tab = await joinOnTablet(browser, "Blake", code);
  await expect.poll(() => players(desk)).toBe(2);
  await expect.poll(() => players(tab)).toBe(2);
  const platforms = await desk.evaluate(() => [...window.__ahb.session.state.players.values()].map((p: any) => p.platform).sort());
  expect(platforms).toEqual(["desktop", "touch"]);
  // Both clients render with WebGL2.
  for (const p of [desk, tab]) expect(await p.evaluate(() => window.__ahb.game.engine.webGLVersion)).toBe(2);
});

test("a tablet player picks up a tray with a tap and taps a counter to set it down", async ({ browser }) => {
  const { code } = await openKitchen(browser, "Avery");
  const tab = await joinOnTablet(browser, "Blake", code);
  const tray = await tab.evaluate(() => {
    for (const [id, it] of window.__ahb.session.state.items) if ((it as any).kind === "tray") return { id, x: (it as any).x, y: (it as any).y, z: (it as any).z };
    return null;
  });
  expect(tray).not.toBeNull();
  await aimAt(tab, { x: tray!.x, z: 1.25 }, { x: tray!.x, y: tray!.y, z: tray!.z });
  await tapCenter(tab);
  await expect.poll(() => held(tab)).toBe(tray!.id);
  // Lifting a finger never drops anything: still held after the tap ends.
  await tab.waitForTimeout(300);
  expect(await held(tab)).toBe(tray!.id);
  // Tap the island top a little to the side to set it down.
  await aimAt(tab, { x: tray!.x, z: 1.25 }, { x: tray!.x - 0.55, y: 0.92, z: 2.1 });
  await tapCenter(tab);
  await expect.poll(() => held(tab)).toBe("");
  const after = await tab.evaluate((id) => window.__ahb.session.state.items.get(id), tray!.id);
  expect(Math.abs(after.x - (tray!.x - 0.55))).toBeLessThan(0.2);
});

test("desktop opens the chiller drawer, takes a patty and hands it to the tablet player", async ({ browser }) => {
  const { page: desk, code } = await openKitchen(browser, "Avery");
  const tab = await joinOnTablet(browser, "Blake", code);
  await expect.poll(() => players(desk)).toBe(2);

  // Pull the drawer open by dragging its handle (pointer lock acquired by the first click).
  await aimAt(desk, { x: -1.6, z: 3.15 }, { x: -1.6, y: 0.62, z: 4.22 });
  const c = await center(desk);
  await desk.mouse.click(c.x, c.y);
  await desk.waitForTimeout(300);
  await desk.mouse.move(c.x, c.y);
  await desk.mouse.down();
  for (let i = 0; i < 12; i++) {
    await desk.mouse.move(c.x, c.y + (i + 1) * 15);
    await desk.waitForTimeout(40);
  }
  await desk.mouse.up();
  await expect.poll(() => desk.evaluate(() => window.__ahb.session.state.drawer as number)).toBeGreaterThan(0.6);

  // Take a patty from the exposed part of the open drawer.
  const open = await desk.evaluate(() => window.__ahb.session.state.drawer as number);
  await aimAt(desk, { x: -1.6, z: 3.15 }, { x: -1.6, y: 0.72, z: 4.23 - open * 0.42 + 0.14 });
  // Under pointer lock, clicks aim with the crosshair; moving the mouse would turn the camera.
  await desk.mouse.down();
  await desk.mouse.up();
  await expect.poll(() => held(desk)).not.toBe("");
  const patty = await held(desk);
  expect(await itemKind(desk, patty)).toBe("patty");

  // Face the tablet player and press E to offer the patty.
  await aimAt(tab, { x: -0.8, z: 3.15 }, { x: -1.6, y: 1.4, z: 3.15 });
  await aimAt(desk, { x: -1.6, z: 3.15 }, { x: -0.8, y: 1.2, z: 3.15 });
  await desk.keyboard.press("KeyE");
  await expect.poll(() => desk.evaluate((id) => window.__ahb.session.state.items.get(id)?.offered as boolean, patty)).toBe(true);

  // The tablet player taps the offered patty to take it.
  const pos = await tab.evaluate((id) => {
    const it = window.__ahb.session.state.items.get(id);
    return { x: it.x as number, y: it.y as number, z: it.z as number };
  }, patty);
  await aimAt(tab, { x: -0.8, z: 3.15 }, pos);
  await tapCenter(tab);
  await expect.poll(() => held(tab)).toBe(patty);
  await expect.poll(() => held(desk)).toBe("");
});
