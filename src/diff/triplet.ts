import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export interface PaddedDimensionsResult {
  refPath: string;
  livePath: string;
  dimensionDrift: boolean;
  refDimensions: { width: number; height: number };
  liveDimensions: { width: number; height: number };
  unifiedDimensions: { width: number; height: number };
  commonAreaApplied?: boolean;
}

export async function normalizeImageDimensions(
  refImagePath: string,
  liveImagePath: string,
  outputDir: string,
  options?: { commonArea?: boolean }
): Promise<PaddedDimensionsResult> {
  const refMeta = await sharp(refImagePath).metadata();
  const liveMeta = await sharp(liveImagePath).metadata();

  const refW = refMeta.width || 0;
  const refH = refMeta.height || 0;
  const liveW = liveMeta.width || 0;
  const liveH = liveMeta.height || 0;

  const refDimensions = { width: refW, height: refH };
  const liveDimensions = { width: liveW, height: liveH };

  const dimensionDrift = refW !== liveW || refH !== liveH;

  if (!dimensionDrift) {
    return {
      refPath: refImagePath,
      livePath: liveImagePath,
      dimensionDrift: false,
      refDimensions,
      liveDimensions,
      unifiedDimensions: refDimensions,
    };
  }

  // Phase 1.3: If commonArea is requested, crop to the overlapping area min(w1, w2) x min(h1, h2)
  if (options?.commonArea) {
    const minW = Math.min(refW, liveW);
    const minH = Math.min(refH, liveH);
    fs.mkdirSync(outputDir, { recursive: true });
    const croppedRefPath = path.join(outputDir, "ref_cropped.png");
    const croppedLivePath = path.join(outputDir, "live_cropped.png");

    await sharp(refImagePath)
      .extract({ left: 0, top: 0, width: minW, height: minH })
      .png()
      .toFile(croppedRefPath);

    await sharp(liveImagePath)
      .extract({ left: 0, top: 0, width: minW, height: minH })
      .png()
      .toFile(croppedLivePath);

    return {
      refPath: croppedRefPath,
      livePath: croppedLivePath,
      dimensionDrift: false,
      refDimensions,
      liveDimensions,
      unifiedDimensions: { width: minW, height: minH },
      commonAreaApplied: true,
    };
  }

  const maxW = Math.max(refW, liveW);
  const maxH = Math.max(refH, liveH);
  const unifiedDimensions = { width: maxW, height: maxH };

  fs.mkdirSync(outputDir, { recursive: true });
  const paddedRefPath = path.join(outputDir, "ref_padded.png");
  const paddedLivePath = path.join(outputDir, "live_padded.png");

  // Sentinel magenta color: rgba(255, 0, 255, 1)
  const sentinelColor = { r: 255, g: 0, b: 255, alpha: 1 };

  let finalRefPath = refImagePath;
  if (refW < maxW || refH < maxH) {
    await sharp(refImagePath)
      .ensureAlpha()
      .extend({
        top: 0,
        left: 0,
        bottom: maxH - refH,
        right: maxW - refW,
        background: sentinelColor,
      })
      .png()
      .toFile(paddedRefPath);
    finalRefPath = paddedRefPath;
  }

  let finalLivePath = liveImagePath;
  if (liveW < maxW || liveH < maxH) {
    await sharp(liveImagePath)
      .ensureAlpha()
      .extend({
        top: 0,
        left: 0,
        bottom: maxH - liveH,
        right: maxW - liveW,
        background: sentinelColor,
      })
      .png()
      .toFile(paddedLivePath);
    finalLivePath = paddedLivePath;
  }

  return {
    refPath: finalRefPath,
    livePath: finalLivePath,
    dimensionDrift: true,
    refDimensions,
    liveDimensions,
    unifiedDimensions,
  };
}

async function padTopLeftToSize(
  imgPath: string,
  targetW: number,
  targetH: number,
  background: { r: number; g: number; b: number; alpha: number }
): Promise<Buffer> {
  const meta = await sharp(imgPath).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;

  let pipeline = sharp(imgPath).ensureAlpha();
  if (imgW < targetW || imgH < targetH) {
    pipeline = pipeline.extend({
      top: 0,
      left: 0,
      bottom: Math.max(0, targetH - imgH),
      right: Math.max(0, targetW - imgW),
      background,
    });
  }
  return pipeline.png().toBuffer();
}

export async function generateTripletImage(
  refPath: string,
  livePath: string,
  diffPath: string,
  outputPath: string
): Promise<string> {
  const refMeta = await sharp(refPath).metadata();
  const liveMeta = await sharp(livePath).metadata();
  const diffMeta = fs.existsSync(diffPath) ? await sharp(diffPath).metadata() : null;

  const w = Math.max(refMeta.width || 0, liveMeta.width || 0, diffMeta?.width || 0, 1);
  const h = Math.max(refMeta.height || 0, liveMeta.height || 0, diffMeta?.height || 0, 1);

  const gap = 16;
  const totalW = w * 3 + gap * 2;
  const totalH = h;

  // Keep strict 1:1 scale and (0,0) top-left alignment across all three panels
  const neutralBg = { r: 240, g: 240, b: 240, alpha: 1 };
  const refBuffer = await padTopLeftToSize(refPath, w, h, neutralBg);
  const liveBuffer = await padTopLeftToSize(livePath, w, h, neutralBg);

  const diffBuffer = fs.existsSync(diffPath)
    ? await padTopLeftToSize(diffPath, w, h, { r: 20, g: 20, b: 20, alpha: 1 })
    : await sharp({
        create: {
          width: w,
          height: h,
          channels: 4,
          background: { r: 24, g: 24, b: 27, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  await sharp({
    create: {
      width: totalW,
      height: totalH,
      channels: 4,
      background: { r: 30, g: 30, b: 35, alpha: 1 },
    },
  })
    .composite([
      { input: refBuffer, left: 0, top: 0 },
      { input: liveBuffer, left: w + gap, top: 0 },
      { input: diffBuffer, left: (w + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(outputPath);

  return outputPath;
}
