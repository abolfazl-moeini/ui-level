import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { check } from "../src/index.js";
import { launchBrowser } from "../src/browser/resolver.js";
import type { Browser } from "playwright-core";

describe("Plan Integration Tests", () => {
  let browser: Browser;
  const testOutputDir = path.resolve(".ui-level/test-plan");

  beforeAll(async () => {
    browser = await launchBrowser();
    fs.mkdirSync(testOutputDir, { recursive: true });
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    fs.rmSync(testOutputDir, { recursive: true, force: true });
  });

  it("calculates layoutSimilarity and perceptualSimilarity on pixel diff", async () => {
    // Two simple HTML pages with slightly different colors
    const htmlA = `<!DOCTYPE html><html><body style="margin:0; background:#ffffff; width:200px; height:200px;">
      <div style="width:100px; height:100px; background:#0077ff;"></div>
    </body></html>`;

    const htmlB = `<!DOCTYPE html><html><body style="margin:0; background:#ffffff; width:200px; height:200px;">
      <div style="width:100px; height:100px; background:#0077ee;"></div>
    </body></html>`;

    const fileA = path.join(testOutputDir, "sim_a.html");
    const fileB = path.join(testOutputDir, "sim_b.html");
    fs.writeFileSync(fileA, htmlA);
    fs.writeFileSync(fileB, htmlB);

    const result = await check(
      {
        targetUrl: fileA,
        ref: fileB,
        adapter: "html",
        viewport: { width: 200, height: 200, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-sim"),
      },
      browser
    );

    expect(result.pixelDiff.layoutSimilarity).toBeDefined();
    expect(result.pixelDiff.layoutSimilarity).toBeGreaterThan(0.9);
    expect(result.pixelDiff.perceptualSimilarity).toBeDefined();
    expect(result.pixelDiff.perceptualSimilarity).toBeGreaterThan(0.9);
  });

  it("handles commonArea when target and reference have different heights without failing on dimensionDrift", async () => {
    // Reference is 200x150, Target is 200x300 (dynamic list)
    const refHtml = `<!DOCTYPE html><html><body style="margin:0; background:#ffffff; width:200px; height:150px;">
      <div style="width:100px; height:50px; background:#ff0000;"></div>
    </body></html>`;

    const liveHtml = `<!DOCTYPE html><html><body style="margin:0; background:#ffffff; width:200px; height:300px;">
      <div style="width:100px; height:50px; background:#ff0000;"></div>
      <div style="width:100px; height:150px; background:#00ff00;"></div>
    </body></html>`;

    const refFile = path.join(testOutputDir, "common_ref.html");
    const liveFile = path.join(testOutputDir, "common_live.html");
    fs.writeFileSync(refFile, refHtml);
    fs.writeFileSync(liveFile, liveHtml);

    const result = await check(
      {
        targetUrl: liveFile,
        ref: refFile,
        adapter: "html",
        commonArea: true,
        viewport: { width: 200, height: 200, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-common"),
      },
      browser
    );

    expect(result.pixelDiff.commonAreaApplied).toBe(true);
    expect(result.pixelDiff.dimensionDrift).toBe(false);
  });

  it("extracts semantic skeleton and reports structure likeness", async () => {
    const refHtml = `<!DOCTYPE html><html><body>
      <header><nav><a href="#">Link</a></nav></header>
      <main>
        <h1>Title</h1>
        <ul><li>Item 1</li></ul>
        <button>Click</button>
      </main>
      <footer>Footer</footer>
    </body></html>`;

    const liveHtml = `<!DOCTYPE html><html><body>
      <header><nav><a href="#">Link</a></nav></header>
      <main>
        <h1>Title</h1>
        <button>Click</button>
      </main>
      <footer>Footer</footer>
    </body></html>`;

    const refFile = path.join(testOutputDir, "skel_ref.html");
    const liveFile = path.join(testOutputDir, "skel_live.html");
    fs.writeFileSync(refFile, refHtml);
    fs.writeFileSync(liveFile, liveHtml);

    const result = await check(
      {
        targetUrl: liveFile,
        ref: refFile,
        adapter: "html",
        viewport: { width: 400, height: 400, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-skel"),
      },
      browser
    );

    expect(result.structureLikeness).toBeDefined();
    expect(result.structureLikeness?.similarity).toBeGreaterThan(80);
    expect(result.structureLikeness?.missing).toEqual([
      { name: "list", count: 1 },
    ]);
  });

  it("detects horizontal scroll overflow and adds warning", async () => {
    // 375px viewport with a 500px wide child
    const liveHtml = `<!DOCTYPE html><html><body style="margin:0; width:100%;">
      <div style="width:500px; height:50px; background:#333;">Overflowing element</div>
    </body></html>`;

    const refHtml = `<!DOCTYPE html><html><body style="margin:0; width:375px;">
      <div style="width:375px; height:50px; background:#333;">Normal</div>
    </body></html>`;

    const refFile = path.join(testOutputDir, "over_ref.html");
    const liveFile = path.join(testOutputDir, "over_live.html");
    fs.writeFileSync(refFile, refHtml);
    fs.writeFileSync(liveFile, liveHtml);

    const result = await check(
      {
        targetUrl: liveFile,
        ref: refFile,
        adapter: "html",
        viewport: { width: 375, height: 600, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-over"),
      },
      browser
    );

    expect(result.horizontalOverflow).toBeDefined();
    expect(result.horizontalOverflow?.overflow).toBe(true);
    expect(result.horizontalOverflow?.delta).toBeGreaterThanOrEqual(100);
    expect(result.warnings?.some((w) => w.includes("Horizontal scroll overflow"))).toBe(true);
  });

  it("matches Next.js hashed fonts against clean font name in reference", async () => {
    // Reference expects "Vazirmatn", target has Next.js class or computed style "__Vazirmatn_91a2b3"
    const refHtml = `<!DOCTYPE html><html><body style="margin:0;">
      <p id="txt" style="font-family: 'Vazirmatn', sans-serif; font-size:16px;">Hello</p>
    </body></html>`;

    const liveHtml = `<!DOCTYPE html><html><body style="margin:0;">
      <p id="txt" style="font-family: '__Vazirmatn_91a2b3', sans-serif; font-size:16px;">Hello</p>
    </body></html>`;

    const refFile = path.join(testOutputDir, "font_ref.html");
    const liveFile = path.join(testOutputDir, "font_live.html");
    fs.writeFileSync(refFile, refHtml);
    fs.writeFileSync(liveFile, liveHtml);

    const result = await check(
      {
        targetUrl: liveFile,
        ref: refFile,
        adapter: "html",
        viewport: { width: 300, height: 200, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-font"),
      },
      browser
    );

    // Font family should NOT be marked as a style violation!
    const fontViolations = result.styleViolations.filter((v) => v.property === "fontFamily");
    expect(fontViolations.length).toBe(0);
  });

  it("performs triple-shot noise masking to ignore animated elements", async () => {
    // Page with an animated blinking box driven by JS (e.g. slider, video, loader)
    const liveHtml = `<!DOCTYPE html><html><body style="margin:0; width:200px; height:200px; background:#fff;">
      <div id="box" style="width:32px; height:32px; background:#ff0000;"></div>
      <script>
        let count = 0;
        setInterval(() => {
          count++;
          const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'];
          document.getElementById('box').style.background = colors[count % colors.length];
        }, 150);
      </script>
    </body></html>`;

    // Reference has flat white background with red box
    const refHtml = `<!DOCTYPE html><html><body style="margin:0; width:200px; height:200px; background:#fff;">
      <div style="width:32px; height:32px; background:#ff0000;"></div>
    </body></html>`;

    const refFile = path.join(testOutputDir, "noise_ref.html");
    const liveFile = path.join(testOutputDir, "noise_live.html");
    fs.writeFileSync(refFile, refHtml);
    fs.writeFileSync(liveFile, liveHtml);

    const result = await check(
      {
        targetUrl: liveFile,
        ref: refFile,
        adapter: "html",
        autoNoiseMask: true,
        viewport: { width: 200, height: 200, deviceScaleFactor: 1 },
        outputDir: path.join(testOutputDir, "out-noise"),
      },
      browser
    );

    expect(result.pixelDiff.noiseTiles).toBeDefined();
    expect(result.pixelDiff.noiseTiles).toBeGreaterThan(0);
    expect(result.pixelDiff.noiseMaskFile).toBeDefined();
    expect(fs.existsSync(result.pixelDiff.noiseMaskFile!)).toBe(true);
  });
});
