import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { check } from "../src/index.js";
import { launchBrowser } from "../src/browser/resolver.js";
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

  it("detects +2px padding drift via Gate 1 and Gate 2", async () => {
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
    expect(result.pixelDiff.match).toBe(false);
  });

  it("detects font-weight drift (700 -> 400)", async () => {
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
});
