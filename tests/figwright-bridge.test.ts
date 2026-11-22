import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { check } from "../src/index.js";
import { launchBrowser } from "../src/browser/resolver.js";
import {
  importReferenceSnapshot,
  loadReferenceSnapshot,
} from "../src/snapshot/manager.js";
import type { Browser } from "playwright-core";

describe("Figwright bridge, reference snapshots & node mapping", () => {
  let browser: Browser;
  const fixturesDir = path.resolve(__dirname, "fixtures");
  const baseHtml = path.join(fixturesDir, "base.html");
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-level-bridge-test-"));

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    try {
      fs.rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup in sandbox environments
    }
  });

  it("imports Figwright context and reference image into an immutable snapshot directory", async () => {
    const prepDir = path.join(outputDir, "prep");
    const prep = await check(
      {
        targetUrl: baseHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: prepDir,
        root: fixturesDir,
      },
      browser
    );
    expect(prep.status).toBe("pass");
    const livePng = path.join(prepDir, "live.png");
    expect(fs.existsSync(livePng)).toBe(true);

    const snapshotBaseDir = path.join(outputDir, "references");
    const figwrightSpecPath = path.join(fixturesDir, "figwright-context.json");

    const imported = await importReferenceSnapshot({
      slug: "test-card",
      specPath: figwrightSpecPath,
      imagePath: livePng,
      baseDir: snapshotBaseDir,
      selectorMap: { "100:4": "#card-btn" },
      figma: {
        fileKey: "FIG-KEY-123",
        nodeId: "100:1",
      },
      figwright: {
        serverVersion: "0.8.0",
      },
    });

    expect(imported.manifest.schemaVersion).toBe(1);
    expect(imported.manifest.slug).toBe("test-card");
    expect(imported.manifest.source).toBe("figwright");
    expect(imported.manifest.image.deviceScaleFactor).toBe(2);
    expect(imported.manifest.hashes.specSha256).toHaveLength(64);
    expect(imported.manifest.hashes.imageSha256).toHaveLength(64);
    expect(imported.manifest.selectorMap).toEqual({ "100:4": "#card-btn" });

    // Verify auto-populated metadata from conv.meta
    expect(imported.manifest.figma?.nodeId).toBe("100:1");
    expect(imported.manifest.figma?.nodeName).toBe("Card");

    const loaded = loadReferenceSnapshot(imported.snapshotDir);
    expect(loaded.manifest?.slug).toBe("test-card");
    expect(loaded.spec.nodes.length).toBe(5);
  });

  it("runs regression check using snapshot directory as --ref, matching nodes via data-figma-node-id", async () => {
    const snapshotDir = path.join(outputDir, "references", "test-card");
    const checkRunDir = path.join(outputDir, "run-snapshot");

    // Write real HTML file to test static server + CDP file:line rule attribution
    const alignedHtmlPath = path.join(outputDir, "aligned-card.html");
    fs.writeFileSync(
      alignedHtmlPath,
      `<!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <style>
          body { margin: 0; padding: 20px; background-color: #f7f9fa; font-family: Vazirmatn, sans-serif; }
          .card { background-color: #ffffff; border-radius: 12px; padding: 16px; width: 354px; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; }
          .card-title { font-size: 18px; line-height: 24px; font-weight: 700; color: #111827; margin: 0; }
        </style>
      </head>
      <body>
        <div class="card" id="test-card" data-figma-node-id="100:1">
          <h2 class="card-title" data-figma-node-id="100:2">تست عنوان کارت</h2>
        </div>
      </body>
      </html>`,
      "utf-8"
    );

    const res = await check(
      {
        targetUrl: alignedHtmlPath,
        ref: snapshotDir,
        selector: "#test-card",
        outputDir: checkRunDir,
      },
      browser
    );

    expect(res.adapter).toBe("figma");
    // Gate 1 should pass for matched root and title with zero style violations
    expect(res.styleViolations.length).toBe(0);
    // Figwright conversion warnings (deduped badge node) should be propagated
    expect(res.warnings).toBeDefined();
    expect(res.warnings?.some((w) => w.includes("deduped instance"))).toBe(true);
  });

  it("detects drift when element tagged with data-figma-node-id mutates and includes CDP rule source", async () => {
    const snapshotDir = path.join(outputDir, "references", "test-card");
    const checkRunDir = path.join(outputDir, "run-mutation");

    // Real HTML file with mutated padding (24px vs 16px) and font-weight (400 vs 700)
    const mutatedHtmlPath = path.join(outputDir, "mutated-card.html");
    fs.writeFileSync(
      mutatedHtmlPath,
      `<!DOCTYPE html>
      <html lang="fa" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <style>
          body { margin: 0; padding: 20px; background-color: #f7f9fa; }
          .card { background-color: #ffffff; border-radius: 12px; padding: 24px; width: 354px; }
          .card-title { font-size: 14px; line-height: 24px; font-weight: 400; color: #111827; }
        </style>
      </head>
      <body>
        <div class="card" id="test-card" data-figma-node-id="100:1">
          <h2 class="card-title" data-figma-node-id="100:2">تست عنوان کارت</h2>
        </div>
      </body>
      </html>`,
      "utf-8"
    );

    const res = await check(
      {
        targetUrl: mutatedHtmlPath,
        ref: snapshotDir,
        selector: "#test-card",
        outputDir: checkRunDir,
      },
      browser
    );

    expect(res.status).toBe("fail");
    const padViolation = res.styleViolations.find((v) => v.property === "paddingTop");
    expect(padViolation).toBeDefined();
    expect(padViolation?.expected).toBe(16);
    expect(padViolation?.actual).toBe(24);
    // Verifies CDP rule source attribution was populated
    expect(padViolation?.cssRuleSource).toBeDefined();
    expect(padViolation?.cssRuleSource?.selector).toBe(".card");

    const fwViolation = res.styleViolations.find((v) => v.property === "fontWeight");
    expect(fwViolation).toBeDefined();
    expect(fwViolation?.expected).toBe(700);
    expect(fwViolation?.actual).toBe(400);
  });

  it("non-tautologically verifies bidirectional selectorMap and catches deliberate style violations", async () => {
    const snapshotDir = path.join(outputDir, "references", "test-card");
    const checkRunDir = path.join(outputDir, "run-selectormap-bidirectional");

    // Create a target HTML with a red button (#dc2626 instead of Figma's #2563eb blue)
    // and NO data-figma-* attributes anywhere
    const redBtnHtmlPath = path.join(outputDir, "red-btn-card.html");
    fs.writeFileSync(
      redBtnHtmlPath,
      `<!DOCTYPE html>
      <html>
      <head>
        <style>
          .card { background: #fff; width: 354px; padding: 16px; border-radius: 12px; }
          #card-btn { background-color: #dc2626; color: #fff; border: none; border-radius: 8px; width: 80px; height: 36px; }
        </style>
      </head>
      <body>
        <div class="card" id="test-card">
          <button id="card-btn">Click</button>
        </div>
      </body>
      </html>`,
      "utf-8"
    );

    // 1. Forward mapping: { "#card-btn": "100:4" }
    const resForward = await check(
      {
        targetUrl: redBtnHtmlPath,
        ref: snapshotDir,
        selector: "#test-card",
        selectorMap: {
          "#card-btn": "100:4",
        },
        outputDir: path.join(checkRunDir, "forward"),
      },
      browser
    );

    const fwdColorViolation = resForward.styleViolations.find(
      (v) => v.property === "backgroundColor" && v.selector.includes("card-btn")
    );
    // Proves the mapping actually linked live #card-btn to Figma 100:4 (rgb(37, 99, 235))
    expect(fwdColorViolation).toBeDefined();
    expect(fwdColorViolation?.unit).toBe("dE00");
    expect(Number(fwdColorViolation?.delta)).toBeGreaterThan(2);

    // 2. Reverse mapping: { "100:4": "#card-btn" }
    const resReverse = await check(
      {
        targetUrl: redBtnHtmlPath,
        ref: snapshotDir,
        selector: "#test-card",
        selectorMap: {
          "100:4": "#card-btn",
        },
        outputDir: path.join(checkRunDir, "reverse"),
      },
      browser
    );

    const revColorViolation = resReverse.styleViolations.find(
      (v) => v.property === "backgroundColor" && v.selector.includes("card-btn")
    );
    expect(revColorViolation).toBeDefined();
    expect(revColorViolation?.unit).toBe("dE00");
    expect(Number(revColorViolation?.delta)).toBeGreaterThan(2);
  });

  it("preserves hyphenated selectors in HTML-to-HTML mode without colon corruption (regression F2)", async () => {
    const htmlRefPath = path.join(outputDir, "ref-hyphen.html");
    const htmlLivePath = path.join(outputDir, "live-hyphen.html");

    fs.writeFileSync(
      htmlRefPath,
      `<!DOCTYPE html><html><body><div id="ref-card"><button id="card-btn" style="background:#2563eb;width:80px;height:36px;">Save</button></div></body></html>`,
      "utf-8"
    );
    fs.writeFileSync(
      htmlLivePath,
      `<!DOCTYPE html><html><body><div id="live-card"><button id="action-btn" style="background:#dc2626;width:80px;height:36px;">Save</button></div></body></html>`,
      "utf-8"
    );

    // Map hyphenated live selector to hyphenated ref selector
    const res = await check(
      {
        targetUrl: htmlLivePath,
        ref: htmlRefPath,
        adapter: "html",
        selector: "#live-card",
        refSelector: "#ref-card",
        selectorMap: {
          "#action-btn": "#card-btn",
        },
        outputDir: path.join(outputDir, "run-hyphen-regress"),
      },
      browser
    );

    // The selectorMap MUST match #action-btn to #card-btn without turning into #card:btn
    const colorViolation = res.styleViolations.find(
      (v) => v.property === "backgroundColor" && v.selector.includes("action-btn")
    );
    expect(colorViolation).toBeDefined();
    expect(colorViolation?.unit).toBe("dE00");
    expect(Number(colorViolation?.delta)).toBeGreaterThan(2);
  });

  it("auto-detects 1x PNG reference image in Figma adapter and passes with zero pixel diff drift", async () => {
    const runDir = path.join(outputDir, "run-1x-real");
    fs.mkdirSync(runDir, { recursive: true });

    // Step 1: Capture a genuine 1x screenshot of #test-card from baseHtml
    const temp1xContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const temp1xPage = await temp1xContext.newPage();
    await temp1xPage.goto(`file://${baseHtml}`, { waitUntil: "networkidle" });
    const real1xPngPath = path.join(runDir, "real-1x-ref.png");
    await temp1xPage.locator("#test-card").screenshot({ path: real1xPngPath });
    await temp1xContext.close();

    const figwrightSpecPath = path.join(fixturesDir, "figwright-context.json");

    // Step 2: Run check in figma mode WITHOUT specifying dpr (defaults to 2)
    const res = await check(
      {
        targetUrl: baseHtml,
        refSpec: figwrightSpecPath,
        refImage: real1xPngPath,
        selector: "#test-card",
        outputDir: runDir,
        root: fixturesDir,
      },
      browser
    );

    // Should auto-detect 1x PNG, adjust DPR to 1, and match with no dimension drift
    expect(res.adapter).toBe("figma");
    expect(res.pixelDiff.liveDimensions.width).toBe(354);
    expect(res.pixelDiff.dimensionDrift).toBe(false);
    expect(res.pixelDiff.match).toBe(true);
  });

  it("enforces fail-fast SHA-256 integrity check and bypasses with skipIntegrityCheck", async () => {
    const snapshotDir = path.join(outputDir, "references", "test-card");
    const imgPath = path.join(snapshotDir, "reference.png");

    const origBytes = fs.readFileSync(imgPath);
    try {
      // Tamper with reference.png by appending a byte
      fs.appendFileSync(imgPath, Buffer.from([0x00]));

      // Fail-fast test
      await expect(
        check(
          {
            targetUrl: baseHtml,
            ref: snapshotDir,
            selector: "#test-card",
            outputDir: path.join(outputDir, "tamper-fail"),
            root: fixturesDir,
          },
          browser
        )
      ).rejects.toThrow(/integrity check failed/);

      // Override with skipIntegrityCheck
      const res = await check(
        {
          targetUrl: baseHtml,
          ref: snapshotDir,
          selector: "#test-card",
          skipIntegrityCheck: true,
          outputDir: path.join(outputDir, "tamper-pass"),
          root: fixturesDir,
        },
        browser
      );

      expect(res.warnings).toBeDefined();
      expect(res.warnings?.some((w) => w.includes("integrity warning"))).toBe(true);
    } finally {
      fs.writeFileSync(imgPath, origBytes);
    }
  });

  it("rejects path traversal attempts on slug and manifest file paths (security F1)", async () => {
    const figwrightSpecPath = path.join(fixturesDir, "figwright-context.json");
    const sampleImg = path.join(outputDir, "sample-card.png");
    if (!fs.existsSync(sampleImg)) {
      // Create a dummy png
      await sharp({ create: { width: 10, height: 10, channels: 4, background: "#fff" } })
        .png()
        .toFile(sampleImg);
    }

    // 1. Slugs attempting path traversal
    await expect(
      importReferenceSnapshot({
        slug: "../evil",
        specPath: figwrightSpecPath,
        imagePath: sampleImg,
        baseDir: path.join(outputDir, "safe-refs"),
      })
    ).rejects.toThrow(/Invalid snapshot slug|escapes base directory/);

    await expect(
      importReferenceSnapshot({
        slug: "..",
        specPath: figwrightSpecPath,
        imagePath: sampleImg,
        baseDir: path.join(outputDir, "safe-refs"),
      })
    ).rejects.toThrow(/Invalid snapshot slug|escapes base directory/);

    // 2. Tampered manifest with escaping specFile
    const tamperedDir = path.join(outputDir, "tampered-dir");
    fs.mkdirSync(tamperedDir, { recursive: true });
    fs.writeFileSync(path.join(tamperedDir, "reference.png"), fs.readFileSync(sampleImg));
    fs.writeFileSync(
      path.join(tamperedDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        slug: "tampered",
        source: "normalized",
        exportedAt: new Date().toISOString(),
        image: { file: "reference.png", width: 10, height: 10, deviceScaleFactor: 2 },
        specFile: "../../package.json", // path traversal attack!
        hashes: {
          specSha256: "0".repeat(64),
          imageSha256: "0".repeat(64),
        },
      })
    );

    expect(() => loadReferenceSnapshot(tamperedDir)).toThrow(
      /escapes snapshot directory/
    );
  });

  it("converts non-PNG images (JPEG/WebP) to valid PNG format and populates conv.meta (F4)", async () => {
    const jpegPath = path.join(outputDir, "source-ref.jpg");
    await sharp({ create: { width: 354, height: 134, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toFile(jpegPath);

    const figwrightSpecPath = path.join(fixturesDir, "figwright-context.json");
    const snapshotBaseDir = path.join(outputDir, "jpeg-test-refs");

    const imported = await importReferenceSnapshot({
      slug: "jpeg-card",
      specPath: figwrightSpecPath,
      imagePath: jpegPath,
      baseDir: snapshotBaseDir,
    });

    // Verify converted image is real PNG with valid format
    const targetPng = path.join(imported.snapshotDir, "reference.png");
    const meta = await sharp(targetPng).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(354);
    expect(meta.height).toBe(134);

    // Verify metadata auto-populated from conv.meta
    expect(imported.manifest.figma?.nodeId).toBe("100:1");
    expect(imported.manifest.figma?.nodeName).toBe("Card");
    expect(imported.manifest.figwright?.detail).toBe("full");
  });

  it("smoke tests CLI snapshot import and snapshot verify commands with --json", () => {
    const cliPath = path.resolve(__dirname, "../dist/cli.js");
    const sampleImg = path.join(outputDir, "sample-card.png");
    const figwrightSpecPath = path.join(fixturesDir, "figwright-context.json");
    const baseDir = path.join(outputDir, "cli-refs");

    // 1. Run snapshot import via CLI
    const importOutput = execFileSync(
      process.execPath,
      [
        cliPath,
        "snapshot",
        "import",
        "--slug",
        "cli-card",
        "--spec",
        figwrightSpecPath,
        "--image",
        sampleImg,
        "--out",
        baseDir,
        "--json",
      ],
      { encoding: "utf-8" }
    );

    const importParsed = JSON.parse(importOutput);
    expect(importParsed.manifest).toBeDefined();
    expect(importParsed.manifest.slug).toBe("cli-card");
    expect(importParsed.manifest.figma.nodeId).toBe("100:1");

    // 2. Run snapshot verify on valid directory
    const verifyOutput = execFileSync(
      process.execPath,
      [cliPath, "snapshot", "verify", importParsed.snapshotDir, "--json"],
      { encoding: "utf-8" }
    );

    const verifyParsed = JSON.parse(verifyOutput);
    expect(verifyParsed.valid).toBe(true);
    expect(verifyParsed.manifest.slug).toBe("cli-card");

    // 3. Run snapshot verify on invalid directory (should return exit code 2 and json)
    let verifyErrorCaught = false;
    try {
      execFileSync(
        process.execPath,
        [cliPath, "snapshot", "verify", path.join(outputDir, "non-existent-dir"), "--json"],
        { encoding: "utf-8" }
      );
    } catch (err: any) {
      verifyErrorCaught = true;
      expect(err.status).toBe(2);
      const jsonErr = JSON.parse(err.stdout);
      expect(jsonErr.valid).toBe(false);
      expect(jsonErr.error).toContain("Snapshot directory does not exist");
    }
    expect(verifyErrorCaught).toBe(true);
  });
});
