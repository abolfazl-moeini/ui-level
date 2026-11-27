import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { NoiseMask, NOISE_TILE } from "../src/diff/noise-mask.js";
import { computeBlockSimilarity, computePerceptualSimilarity } from "../src/diff/similarity.js";
import {
  extractSemanticSkeleton,
  computeStructureLikeness,
  cleanFontFamilyName,
  checkHorizontalOverflow,
} from "../src/diff/skeleton.js";
import { compareColors } from "../src/diff/color.js";

describe("Phase 1: Triple-Shot Noise Masking", () => {
  it("detects changing regions between two frames and dilates by 1 tile", async () => {
    // 64x32 image (4 cols, 2 rows of 16x16 tiles)
    const w = 64;
    const h = 32;
    const a = Buffer.alloc(w * h * 4, 100); // flat grey
    const b = Buffer.alloc(w * h * 4, 100);

    // Change a 10x10 square inside tile (1, 0) - x in [16..26], y in [0..10]
    for (let y = 0; y < 10; y++) {
      for (let x = 16; x < 26; x++) {
        const idx = (y * w + x) * 4;
        b[idx] = 250;
        b[idx + 1] = 250;
        b[idx + 2] = 250;
        b[idx + 3] = 255;
      }
    }

    const mask = NoiseMask.betweenRaw(
      { width: w, height: h, data: a },
      { width: w, height: h, data: b },
      24
    );

    expect(mask.cols).toBe(4);
    expect(mask.rows).toBe(2);

    // Tile (1, 0) changed, so with 1-tile dilation:
    // (0,0), (1,0), (2,0) and (0,1), (1,1), (2,1) should be covered
    expect(mask.covers(20, 5)).toBe(true); // inside (1, 0)
    expect(mask.covers(5, 5)).toBe(true);  // dilated into (0, 0)
    expect(mask.covers(35, 5)).toBe(true); // dilated into (2, 0)
    expect(mask.covers(20, 20)).toBe(true); // dilated into (1, 1)

    // Far tile (3, 1) should NOT be covered
    expect(mask.covers(55, 25)).toBe(false);
  });

  it("unions two noise masks correctly", () => {
    const mask1 = new NoiseMask(16, 2, 2, [true, false, false, false]);
    const mask2 = new NoiseMask(16, 2, 2, [false, false, false, true]);
    const united = mask1.union(mask2);

    expect(united.bits).toEqual([true, false, false, true]);
    expect(united.count()).toBe(2);
  });

  it("converts NoiseMask to and from PNG", async () => {
    const mask = new NoiseMask(16, 4, 2, [
      true, false, true, false,
      false, true, false, true
    ]);
    const pngBuf = await mask.toPng();
    const restored = await NoiseMask.fromPng(pngBuf);

    expect(restored.cols).toBe(4);
    expect(restored.rows).toBe(2);
    expect(restored.bits).toEqual(mask.bits);
  });
});

describe("Phase 2: Block & Perceptual (SSIM) Similarity", () => {
  it("computes block similarity correctly with and without noise mask", () => {
    // 32x32 image (2x2 tiles of 16x16)
    const w = 32;
    const h = 32;
    const img1 = { width: w, height: h, data: Buffer.alloc(w * h * 4, 100) };
    const img2 = { width: w, height: h, data: Buffer.alloc(w * h * 4, 100) };

    // Same images => 1.0
    expect(computeBlockSimilarity(img1, img2, 16, 24)).toBe(1.0);

    // Modify bottom-right tile (1, 1)
    for (let y = 16; y < 32; y++) {
      for (let x = 16; x < 32; x++) {
        const idx = (y * w + x) * 4;
        img2.data[idx] = 200; // change from 100 to 200 (diff 100 > 24)
        img2.data[idx + 1] = 200;
        img2.data[idx + 2] = 200;
      }
    }

    // 3 out of 4 tiles are identical => 0.75
    expect(computeBlockSimilarity(img1, img2, 16, 24)).toBe(0.75);

    // If bottom-right tile is masked, similarity over unmasked tiles is 1.0
    const mask = new NoiseMask(16, 2, 2, [false, false, false, true]);
    expect(computeBlockSimilarity(img1, img2, 16, 24, mask)).toBe(1.0);
  });

  it("computes perceptual SSIM similarity recognizing structure and masked regions", () => {
    const w = 64;
    const h = 64;
    const imgA = { width: w, height: h, data: Buffer.alloc(w * h * 4, 0) };
    const imgB = { width: w, height: h, data: Buffer.alloc(w * h * 4, 0) };

    // Create vertical stripes
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.floor(x / 4) % 2 === 0 ? 30 : 220;
        const idx = (y * w + x) * 4;
        imgA.data[idx] = v;
        imgA.data[idx + 1] = v;
        imgA.data[idx + 2] = v;
        imgA.data[idx + 3] = 255;

        imgB.data[idx] = v;
        imgB.data[idx + 1] = v;
        imgB.data[idx + 2] = v;
        imgB.data[idx + 3] = 255;
      }
    }

    // Identical images => ~1.0
    const ssimIdentical = computePerceptualSimilarity(imgA, imgB);
    expect(ssimIdentical).toBeGreaterThan(0.999);

    // Flat grey image vs stripes => low SSIM
    const flatGrey = { width: w, height: h, data: Buffer.alloc(w * h * 4, 125) };
    const ssimFlat = computePerceptualSimilarity(imgA, flatGrey);
    expect(ssimFlat).toBeLessThan(0.3);

    // Slight tint (+10 on stripes) => high SSIM > 0.9
    const imgTinted = { width: w, height: h, data: Buffer.alloc(w * h * 4, 0) };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.floor(x / 4) % 2 === 0 ? 40 : 230;
        const idx = (y * w + x) * 4;
        imgTinted.data[idx] = v;
        imgTinted.data[idx + 1] = v;
        imgTinted.data[idx + 2] = v;
        imgTinted.data[idx + 3] = 255;
      }
    }
    const ssimTinted = computePerceptualSimilarity(imgA, imgTinted);
    expect(ssimTinted).toBeGreaterThan(0.9);
  });
});

describe("Phase 3: Semantic Skeleton (LCS) and Horizontal Overflow", () => {
  it("extracts semantic skeleton with ARIA roles and computes LCS likeness", () => {
    const originalElements = [
      { tagName: "header", role: "banner" },
      { tagName: "nav", role: "navigation" },
      { tagName: "main", role: "main" },
      { tagName: "h1" },
      { tagName: "ul" },
      { tagName: "button" },
      { tagName: "footer", role: "contentinfo" },
    ];

    const builtElements = [
      { tagName: "header" },
      { tagName: "div", role: "navigation" },
      { tagName: "main" },
      { tagName: "h1" },
      { tagName: "button" }, // missed "ul"
      { tagName: "footer" },
    ];

    const refSkeleton = extractSemanticSkeleton(originalElements);
    const liveSkeleton = extractSemanticSkeleton(builtElements);

    expect(refSkeleton).toEqual([
      "header", "navigation bar", "main area", "top heading", "list", "button", "footer"
    ]);
    expect(liveSkeleton).toEqual([
      "header", "navigation bar", "main area", "top heading", "button", "footer"
    ]);

    const likeness = computeStructureLikeness(refSkeleton, liveSkeleton);
    expect(likeness).toBeDefined();
    // 6 common parts, original has 7, live has 6 => similarity = 200 * 6 / 13 = 92.3%
    expect(likeness.similarity).toBeGreaterThan(90);
    expect(likeness.missing).toEqual([{ name: "list", count: 1 }]);
    expect(likeness.note).toContain("missing parts: a list");
  });

  it("checks horizontal overflow correctly", () => {
    // Within tolerance (page_w <= viewport_w + 1)
    expect(checkHorizontalOverflow(375, 375).overflow).toBe(false);
    expect(checkHorizontalOverflow(376, 375).overflow).toBe(false); // +1px rounding

    // Real overflow
    const result = checkHorizontalOverflow(410, 375);
    expect(result.overflow).toBe(true);
    expect(result.delta).toBe(35);
  });
});

describe("Phase 4: Font, Color and Non-semantic normalizations", () => {
  it("cleans hashed Next.js font names", () => {
    expect(cleanFontFamilyName("__Vazirmatn_91a2b3")).toBe("Vazirmatn");
    expect(cleanFontFamilyName("__Inter_Fallback_a1b2c3")).toBe("Inter");
    expect(cleanFontFamilyName('"__Roboto_Mono_123456", sans-serif')).toBe("Roboto Mono, sans-serif");
    expect(cleanFontFamilyName("Arial, sans-serif")).toBe("Arial, sans-serif");
  });

  it("applies color channel rounding tolerance (±3)", () => {
    // Differing by 2 units in Red channel (e.g. rgb(100, 150, 200) vs rgb(102, 150, 200))
    const res = compareColors("rgb(100, 150, 200)", "rgb(102, 150, 200)", 2.0);
    expect(res.match).toBe(true);
    expect(res.deltaE).toBe(0); // within ±3 RGB rounding tolerance
  });
});
