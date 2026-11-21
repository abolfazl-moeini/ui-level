import sharp from "sharp";
import type { DiffRegion, NodeSpec } from "../schema.js";
import { compareColors } from "./color.js";

function sampleAverageRgb(
  buf: Buffer,
  imgW: number,
  imgH: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string | undefined {
  const cx1 = Math.max(0, x1);
  const cy1 = Math.max(0, y1);
  const cx2 = Math.min(imgW - 1, x2);
  const cy2 = Math.min(imgH - 1, y2);
  if (cx2 < cx1 || cy2 < cy1) return undefined;

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;

  // Subsample stride so large boxes stay O(1000) samples
  const stepX = Math.max(1, Math.floor((cx2 - cx1 + 1) / 24));
  const stepY = Math.max(1, Math.floor((cy2 - cy1 + 1) / 24));

  for (let y = cy1; y <= cy2; y += stepY) {
    for (let x = cx1; x <= cx2; x += stepX) {
      const idx = (y * imgW + x) * 4;
      const a = buf[idx + 3];
      if (a < 10) continue;
      rSum += buf[idx];
      gSum += buf[idx + 1];
      bSum += buf[idx + 2];
      count++;
    }
  }

  if (count === 0) return undefined;
  const r = Math.round(rSum / count);
  const g = Math.round(gSum / count);
  const b = Math.round(bSum / count);
  return `rgb(${r}, ${g}, ${b})`;
}

export async function extractDiffRegions(
  diffImagePath: string,
  refPaddedPath: string,
  livePaddedPath: string,
  dpr: number,
  liveNodes: NodeSpec[] = [],
  maxRegions: number = 8
): Promise<DiffRegion[]> {
  try {
    const { data: diffData, info } = await sharp(diffImagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const w = info.width;
    const h = info.height;
    if (w === 0 || h === 0) return [];

    // Cluster diff pixels on an 8px physical grid (~4px CSS at 2x DPR)
    const CELL = 8;
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    const cellCounts = new Int32Array(cols * rows);
    const cellMinX = new Int32Array(cols * rows).fill(w);
    const cellMinY = new Int32Array(cols * rows).fill(h);
    const cellMaxX = new Int32Array(cols * rows).fill(0);
    const cellMaxY = new Int32Array(cols * rows).fill(0);

    for (let y = 0; y < h; y++) {
      const cy = Math.floor(y / CELL);
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const r = diffData[idx];
        const g = diffData[idx + 1];
        const b = diffData[idx + 2];

        // Match odiff #ff0077 marker
        if (r >= 240 && g <= 15 && b >= 105 && b <= 135) {
          const cx = Math.floor(x / CELL);
          const cIdx = cy * cols + cx;
          cellCounts[cIdx]++;
          if (x < cellMinX[cIdx]) cellMinX[cIdx] = x;
          if (y < cellMinY[cIdx]) cellMinY[cIdx] = y;
          if (x > cellMaxX[cIdx]) cellMaxX[cIdx] = x;
          if (y > cellMaxY[cIdx]) cellMaxY[cIdx] = y;
        }
      }
    }

    // BFS connected components across 8-connected active cells
    const visited = new Uint8Array(cols * rows);
    const components: Array<{
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      pixelCount: number;
    }> = [];

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const startIdx = cy * cols + cx;
        if (cellCounts[startIdx] === 0 || visited[startIdx]) continue;

        const queue = [startIdx];
        visited[startIdx] = 1;

        let minX = w;
        let minY = h;
        let maxX = 0;
        let maxY = 0;
        let pixelCount = 0;

        while (queue.length > 0) {
          const curr = queue.pop()!;
          pixelCount += cellCounts[curr];
          if (cellMinX[curr] < minX) minX = cellMinX[curr];
          if (cellMinY[curr] < minY) minY = cellMinY[curr];
          if (cellMaxX[curr] > maxX) maxX = cellMaxX[curr];
          if (cellMaxY[curr] > maxY) maxY = cellMaxY[curr];

          const curX = curr % cols;
          const curY = Math.floor(curr / cols);

          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = curX + dx;
              const ny = curY + dy;
              if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
              const nIdx = ny * cols + nx;
              if (cellCounts[nIdx] > 0 && !visited[nIdx]) {
                visited[nIdx] = 1;
                queue.push(nIdx);
              }
            }
          }
        }

        components.push({ minX, minY, maxX, maxY, pixelCount });
      }
    }

    if (components.length === 0) return [];

    components.sort((a, b) => b.pixelCount - a.pixelCount);
    const topComponents = components.slice(0, maxRegions);

    // Load ref & live raw pixels once for exact color sampling in each hotspot
    const [refRaw, liveRaw] = await Promise.all([
      sharp(refPaddedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(livePaddedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    const scale = dpr > 0 ? dpr : 2;
    const regions: DiffRegion[] = [];

    for (const comp of topComponents) {
      const cssX = Number((comp.minX / scale).toFixed(1));
      const cssY = Number((comp.minY / scale).toFixed(1));
      const cssW = Number(((comp.maxX - comp.minX + 1) / scale).toFixed(1));
      const cssH = Number(((comp.maxY - comp.minY + 1) / scale).toFixed(1));

      // Correlate against live DOM nodes (preferring deepest / smallest bounding box first)
      const overlapping = liveNodes
        .filter((n) => {
          const nx2 = n.rect.x + n.rect.width;
          const ny2 = n.rect.y + n.rect.height;
          return (
            n.rect.x < cssX + cssW &&
            nx2 > cssX &&
            n.rect.y < cssY + cssH &&
            ny2 > cssY
          );
        })
        .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
        .slice(0, 4)
        .map((n) => n.selector);

      const refColor = sampleAverageRgb(
        refRaw.data,
        refRaw.info.width,
        refRaw.info.height,
        comp.minX,
        comp.minY,
        comp.maxX,
        comp.maxY
      );
      const liveColor = sampleAverageRgb(
        liveRaw.data,
        liveRaw.info.width,
        liveRaw.info.height,
        comp.minX,
        comp.minY,
        comp.maxX,
        comp.maxY
      );

      let deltaE: number | undefined;
      if (refColor && liveColor) {
        deltaE = compareColors(refColor, liveColor).deltaE;
      }

      regions.push({
        x: cssX,
        y: cssY,
        width: cssW,
        height: cssH,
        pixelCount: comp.pixelCount,
        overlappingSelectors: overlapping,
        refColor,
        liveColor,
        deltaE,
      });
    }

    return regions;
  } catch {
    return [];
  }
}
