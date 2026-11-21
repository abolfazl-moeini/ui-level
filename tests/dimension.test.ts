import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import { normalizeImageDimensions } from "../src/diff/triplet.js";
import { runPixelDiff } from "../src/diff/pixel.js";

describe("ui-level dimension drift & sentinel padding", () => {
  const outputDir = path.resolve(__dirname, ".test-output", "dimension-drift");

  it("pads smaller image with magenta sentinel and reports dimensionDrift", async () => {
    fs.mkdirSync(outputDir, { recursive: true });
    const img1Path = path.join(outputDir, "small.png");
    const img2Path = path.join(outputDir, "large.png");
    const diffPath = path.join(outputDir, "drift_diff.png");

    // Create 100x100 white image
    await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toFile(img1Path);

    // Create 120x110 white image
    await sharp({
      create: {
        width: 120,
        height: 110,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toFile(img2Path);

    const norm = await normalizeImageDimensions(img1Path, img2Path, outputDir);
    expect(norm.dimensionDrift).toBe(true);
    expect(norm.unifiedDimensions).toEqual({ width: 120, height: 110 });

    const diff = await runPixelDiff(img1Path, img2Path, diffPath);
    expect(diff.dimensionDrift).toBe(true);
    expect(diff.match).toBe(false);
    expect(diff.refDimensions).toEqual({ width: 100, height: 100 });
    expect(diff.liveDimensions).toEqual({ width: 120, height: 110 });
    expect(fs.existsSync(diffPath)).toBe(true);
  });
});
