import path from "node:path";
import fs from "node:fs";
import { compare, type ODiffOptions, type ODiffResult } from "odiff-bin";
import type { GeometryRect, PixelDiffSummary } from "../schema.js";
import { normalizeImageDimensions } from "./triplet.js";

export interface PixelDiffOptions {
  threshold?: number;
  dpr?: number;
  cropRect?: GeometryRect;
  imageDimensions?: { width: number; height: number };
  ignoreRegions?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  maskRects?: GeometryRect[];
  adapter?: "html" | "figma" | "image";
  subpixelTolerancePx?: number;
}

export function transformRectsToIgnoreRegions(
  rects: GeometryRect[],
  cropRect: GeometryRect,
  dpr: number,
  maxDimensions: { width: number; height: number }
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  return rects
    .map((r) => {
      const x1 = Math.max(0, Math.floor((r.x - cropRect.x) * dpr) - 2);
      const y1 = Math.max(0, Math.floor((r.y - cropRect.y) * dpr) - 2);
      const x2 = Math.min(maxDimensions.width, Math.ceil((r.x + r.width - cropRect.x) * dpr) + 2);
      const y2 = Math.min(maxDimensions.height, Math.ceil((r.y + r.height - cropRect.y) * dpr) + 2);

      if (x2 <= x1 || y2 <= y1) {
        return null;
      }
      return { x1, y1, x2, y2 };
    })
    .filter((item): item is { x1: number; y1: number; x2: number; y2: number } => item !== null);
}

export async function runPixelDiff(
  refImagePath: string,
  liveImagePath: string,
  diffOutputPath: string,
  options: PixelDiffOptions = {}
): Promise<PixelDiffSummary> {
  const outputDir = path.dirname(diffOutputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Normalize dimensions (Sentinel padding on DIMENSION_DRIFT)
  const normResult = await normalizeImageDimensions(
    refImagePath,
    liveImagePath,
    outputDir
  );

  const { refDimensions, liveDimensions, unifiedDimensions } = normResult;
  const dw = Math.abs(refDimensions.width - liveDimensions.width);
  const dh = Math.abs(refDimensions.height - liveDimensions.height);

  // Plan §3.2(5): Accept physical ±1px subpixel rounding in Figma external bounds before flagging DIMENSION_DRIFT
  const allowedSubpixel =
    options.adapter === "figma" ? (options.subpixelTolerancePx ?? 1) : 0;
  const dimensionDrift = normResult.dimensionDrift && (dw > allowedSubpixel || dh > allowedSubpixel);

  // 2. Prepare ignore regions (CSS 1x viewport coords -> DPR cropped pixel coords)
  const finalIgnoreRegions: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  if (options.ignoreRegions && options.ignoreRegions.length > 0) {
    finalIgnoreRegions.push(...options.ignoreRegions);
  }

  if (options.maskRects && options.maskRects.length > 0 && options.cropRect) {
    const dpr = options.dpr || 2;
    const transformed = transformRectsToIgnoreRegions(
      options.maskRects,
      options.cropRect,
      dpr,
      unifiedDimensions
    );
    finalIgnoreRegions.push(...transformed);
  }

  const odiffOptions: ODiffOptions = {
    threshold: options.threshold ?? 0.05,
    antialiasing: true,
    diffColor: "#ff0077",
    outputDiffMask: false,
    diffOverlay: true,
    failOnLayoutDiff: false,
  };

  if (finalIgnoreRegions.length > 0) {
    odiffOptions.ignoreRegions = finalIgnoreRegions;
  }

  const result: ODiffResult = await compare(
    normResult.refPath,
    normResult.livePath,
    diffOutputPath,
    odiffOptions
  );

  let match = false;
  let diffCount = 0;
  let diffPercentage = 0;

  if (result.match) {
    match = !dimensionDrift;
    diffCount = 0;
    diffPercentage = 0;
  } else if (result.reason === "pixel-diff") {
    diffCount = result.diffCount;
    diffPercentage = Number(result.diffPercentage.toFixed(4));
    match = diffCount === 0 && !dimensionDrift;
  } else if (result.reason === "layout-diff") {
    match = false;
    diffCount = Math.abs(
      refDimensions.width * refDimensions.height - liveDimensions.width * liveDimensions.height
    );
    diffPercentage = 100;
  } else {
    match = false;
  }

  return {
    match,
    diffCount,
    diffPercentage,
    dimensionDrift,
    refDimensions,
    liveDimensions,
    diffImagePath: diffOutputPath,
  };
}
