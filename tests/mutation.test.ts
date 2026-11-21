import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { check } from "../src/index.js";
import { launchBrowser } from "../src/browser/resolver.js";
import { isWithinRoot } from "../src/server/static-host.js";
import { parseFigmaRef } from "../src/adapters/figma.adapter.js";
import type { Browser } from "playwright-core";

describe("ui-level deterministic regression engine", () => {
  let browser: Browser;
  const fixturesDir = path.resolve(__dirname, "fixtures");
  const baseHtml = path.join(fixturesDir, "base.html");
  const mutatedPaddingHtml = path.join(fixturesDir, "mutated_padding.html");
  const mutatedFontHtml = path.join(fixturesDir, "mutated_font.html");
  const mutatedColorHtml = path.join(fixturesDir, "mutated_color.html");
  const sampleSvg = path.join(fixturesDir, "sample.svg");
  const outputDir = path.resolve(__dirname, ".test-output");

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it("passes 100% when comparing identical HTML files", async () => {
    const result = await check(
      {
        targetUrl: baseHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: path.join(outputDir, "pass-identical"),
        root: fixturesDir,
      },
      browser
    );

    expect(result.status).toBe("pass");
    expect(result.styleViolations.length).toBe(0);
    expect(result.geometryViolations.length).toBe(0);
    expect(result.pixelDiff.match).toBe(true);
    expect(result.pixelDiff.diffCount).toBe(0);
  });

  it("detects +2px padding drift with CDP source attribution via Gate 1 and Gate 2", async () => {
    const result = await check(
      {
        targetUrl: mutatedPaddingHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: path.join(outputDir, "fail-padding"),
        root: fixturesDir,
      },
      browser
    );

    expect(result.status).toBe("fail");
    const padViolation = result.styleViolations.find((v) => v.property.startsWith("padding"));
    expect(padViolation).toBeDefined();
    expect(padViolation?.delta).toBe(2);
    expect(padViolation?.fixHint).toContain("padding");
    // CDP must resolve the winning rule even when authored via shorthand `padding: 18px;`
    expect(padViolation?.cssRuleSource).toBeDefined();
    expect(padViolation?.cssRuleSource?.selector).toBe(".card");
    expect(padViolation?.cssRuleSource?.line).toBeGreaterThan(1);
    expect(result.pixelDiff.match).toBe(false);
  });

  it("detects font-weight drift (700 -> 400) with CDP rule attribution", async () => {
    const result = await check(
      {
        targetUrl: mutatedFontHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: path.join(outputDir, "fail-font"),
        root: fixturesDir,
      },
      browser
    );

    expect(result.status).toBe("fail");
    const fontViolation = result.styleViolations.find((v) => v.property === "fontWeight");
    expect(fontViolation).toBeDefined();
    expect(fontViolation?.expected).toBe(700);
    expect(fontViolation?.actual).toBe(400);
    expect(fontViolation?.cssRuleSource?.selector).toBe(".card-title");
  });

  it("detects color drift (blue -> red) with CIEDE2000 ΔE > 2", async () => {
    const result = await check(
      {
        targetUrl: mutatedColorHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: path.join(outputDir, "fail-color"),
        root: fixturesDir,
      },
      browser
    );

    expect(result.status).toBe("fail");
    const colorViolation = result.styleViolations.find((v) => v.property === "backgroundColor");
    expect(colorViolation).toBeDefined();
    expect(colorViolation?.unit).toBe("dE00");
    expect(Number(colorViolation?.delta)).toBeGreaterThan(2);
    expect(colorViolation?.cssRuleSource?.selector).toBe(".btn");
  });

  it("renders SVG inside Chromium and generates valid screenshot and triplet", async () => {
    const result = await check(
      {
        targetUrl: sampleSvg,
        ref: sampleSvg,
        adapter: "image",
        selector: "svg",
        outputDir: path.join(outputDir, "svg-test"),
        root: fixturesDir,
      },
      browser
    );

    expect(result.status).toBe("pass");
    expect(result.pixelDiff.match).toBe(true);
    expect(result.pixelDiff.tripletImagePath).toBeDefined();
    expect(fs.existsSync(result.pixelDiff.tripletImagePath!)).toBe(true);
  });

  it("supports offline Figma spec + 3-tier landmark/data-figma-id matching + text masking", async () => {
    const offDir = path.join(outputDir, "figma-offline");
    fs.mkdirSync(offDir, { recursive: true });

    // Capture base.html card screenshot to act as our offline Figma PNG
    const prep = await check(
      {
        targetUrl: baseHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: path.join(offDir, "prep"),
        root: fixturesDir,
      },
      browser
    );
    expect(prep.status).toBe("pass");
    const refPng = path.join(offDir, "prep", "ref.png");
    const refSpecPath = path.join(offDir, "figma-spec.json");

    // Author an offline Figma spec targeting landmark text "تست عنوان کارت" with wrong fontWeight (500 vs 700)
    const figmaSpec = {
      adapter: "figma",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      nodes: [
        {
          id: "12:99",
          figmaId: "12:99",
          selector: '[data-figma-id="12:99"]',
          tagName: "text",
          rect: { x: 17, y: 17, width: 320, height: 24 },
          styles: {
            fontSize: 18,
            fontWeight: 500,
            color: "rgb(17, 24, 39)",
          },
          text: "تست عنوان کارت",
        },
      ],
    };
    fs.writeFileSync(refSpecPath, JSON.stringify(figmaSpec, null, 2), "utf-8");

    const res = await check(
      {
        targetUrl: baseHtml,
        adapter: "figma",
        selector: "#test-card",
        refSpec: refSpecPath,
        refImage: refPng,
        outputDir: path.join(offDir, "run"),
        root: fixturesDir,
      },
      browser
    );

    expect(res.status).toBe("fail");
    const fwViolation = res.styleViolations.find((v) => v.property === "fontWeight");
    expect(fwViolation).toBeDefined();
    expect(fwViolation?.selector).toBe("#card-title");
    expect(fwViolation?.expected).toBe(500);
    expect(fwViolation?.actual).toBe(700);
    expect(res.pixelDiff.match).toBe(true);
  });

  it("validates strict path containment and Figma ref parsers", async () => {
    expect(isWithinRoot("/tmp/app/index.html", "/tmp/app")).toBe(true);
    expect(isWithinRoot("/tmp/app-secret/index.html", "/tmp/app")).toBe(false);
    expect(isWithinRoot("/etc/passwd", "/tmp/app")).toBe(false);

    expect(parseFigmaRef("AbC123:10-42")).toEqual({ fileKey: "AbC123", nodeId: "10:42" });
    expect(
      parseFigmaRef("https://www.figma.com/design/XyZ99/Hero?node-id=5-88&m=dev")
    ).toEqual({ fileKey: "XyZ99", nodeId: "5:88" });

    // Verify triplet dimensions preserve 1:1 padding without zooming ref smaller image
    const tripOut = path.join(outputDir, "triplet-pad-check.png");
    const refImg = path.join(outputDir, "t_ref.png");
    const liveImg = path.join(outputDir, "t_live.png");
    await sharp({ create: { width: 100, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
      .png()
      .toFile(refImg);
    await sharp({ create: { width: 140, height: 120, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } })
      .png()
      .toFile(liveImg);
    const { generateTripletImage } = await import("../src/diff/triplet.js");
    await generateTripletImage(refImg, liveImg, liveImg, tripOut);
    const tripMeta = await sharp(tripOut).metadata();
    expect(tripMeta.width).toBe(140 * 3 + 16 * 2);
    expect(tripMeta.height).toBe(120);
  });

  it("purges stale diff.png on subsequent passing run and reports effectiveAdapter accurately", async () => {
    const sharedDir = path.join(outputDir, "stale-diff-purge");

    // Run 1: Failing run creates diff.png
    const failRun = await check(
      {
        targetUrl: mutatedColorHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: sharedDir,
        root: fixturesDir,
      },
      browser
    );
    expect(failRun.status).toBe("fail");
    expect(failRun.pixelDiff.diffImagePath).toBeDefined();
    expect(fs.existsSync(failRun.pixelDiff.diffImagePath!)).toBe(true);

    // Run 2: Passing run reusing the exact same outputDir must remove stale diff.png
    const passRun = await check(
      {
        targetUrl: baseHtml,
        ref: baseHtml,
        adapter: "html",
        selector: "#test-card",
        outputDir: sharedDir,
        root: fixturesDir,
      },
      browser
    );
    expect(passRun.status).toBe("pass");
    expect(passRun.pixelDiff.diffImagePath).toBeUndefined();
    expect(fs.existsSync(path.join(sharedDir, "diff.png"))).toBe(false);

    // Auto-detected SVG reference without explicit adapter must report adapter: "image"
    const autoImg = await check(
      {
        targetUrl: sampleSvg,
        ref: sampleSvg,
        selector: "svg",
        outputDir: path.join(outputDir, "auto-adapter-svg"),
        root: fixturesDir,
      },
      browser
    );
    expect(autoImg.status).toBe("pass");
    expect(autoImg.adapter).toBe("image");
  });
});
