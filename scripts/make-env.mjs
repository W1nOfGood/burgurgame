// Converts the baked HDR reflection probes (assets/build/probe_*.hdr) into Babylon .env files
// (prefiltered RGBD mips + spherical harmonics) using Babylon itself in headless Chromium.
//
//   node scripts/make-env.mjs
//
// Needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH or CHROMIUM_PATH).
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "assets", "build");
const outDir = join(root, "apps", "client", "public", "assets", "restaurant");

const entry = `
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
import { CreateEnvTextureAsync } from "@babylonjs/core/Misc/environmentTextureTools";
import "@babylonjs/core/Materials/Textures/Filtering/hdrFiltering";
window.makeEnv = async (url, size) => {
  const canvas = document.createElement("canvas");
  canvas.width = 64; canvas.height = 64;
  document.body.appendChild(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true });
  const scene = new Scene(engine);
  const tex = await new Promise((resolve, reject) => {
    const t = new HDRCubeTexture(url, scene, size, false, true, false, true, () => resolve(t), (m, e) => reject(new Error(m + " " + e)));
  });
  const buf = await CreateEnvTextureAsync(tex, { imageType: "image/png" });
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: "js" },
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  conditions: ["source"],
});
const code = bundle.outputFiles[0].text;

const probes = existsSync(buildDir) ? readdirSync(buildDir).filter((f) => /^probe_.*\.hdr$/.test(f)) : [];
if (probes.length === 0) {
  console.error("No assets/build/probe_*.hdr — run the restaurant bake first.");
  process.exit(1);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
await page.route("http://probe.local/**", (route) => {
  const name = route.request().url().split("/").pop();
  if (name === "index.html") return route.fulfill({ status: 200, body: "<!doctype html><html><body></body></html>", contentType: "text/html" });
  route.fulfill({ status: 200, body: readFileSync(join(buildDir, name)), contentType: "application/octet-stream" });
});
await page.goto("http://probe.local/index.html");
await page.addScriptTag({ content: code });
for (const file of probes) {
  const t = Date.now();
  const b64 = await page.evaluate(([url]) => window.makeEnv(url, 256), [`http://probe.local/${file}`]);
  const out = join(outDir, file.replace(/\.hdr$/, ".env"));
  writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`${file} -> ${out} (${Math.round(Buffer.from(b64, "base64").length / 1024)} KB, ${Date.now() - t} ms)`);
}
await browser.close();
