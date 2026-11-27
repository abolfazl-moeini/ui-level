import type { NoiseMask, RawImage } from "./noise-mask.js";

function getTileMean(
  img: RawImage,
  block: number,
  bx: number,
  by: number
): [number, number, number] {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;

  const channels = (img as any).channels || 4;
  const startY = by * block;
  const endY = Math.min((by + 1) * block, img.height);
  const startX = bx * block;
  const endX = Math.min((bx + 1) * block, img.width);

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const offset = (y * img.width + x) * channels;
      sumR += img.data[offset];
      sumG += img.data[offset + 1];
      sumB += img.data[offset + 2];
      n++;
    }
  }

  if (n === 0) return [0, 0, 0];
  return [sumR / n, sumG / n, sumB / n];
}

/**
 * Coarse scale block similarity (layout similarity):
 * Share of block x block tiles whose mean colors match within threshold per channel.
 * Ignores tiles covered by the optional NoiseMask.
 */
export function computeBlockSimilarity(
  a: RawImage,
  b: RawImage,
  block: number = 16,
  threshold: number = 24,
  mask?: NoiseMask
): number {
  const blk = Math.max(1, block);
  if (a.width !== b.width || a.height !== b.height || a.width === 0 || a.height === 0) {
    return 0.0;
  }

  const cols = Math.ceil(a.width / blk);
  const rows = Math.ceil(a.height / blk);
  let same = 0;
  let counted = 0;

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      if (mask && mask.covers(bx * blk, by * blk)) {
        continue;
      }
      counted++;
      const ma = getTileMean(a, blk, bx, by);
      const mb = getTileMean(b, blk, bx, by);

      const match =
        Math.abs(ma[0] - mb[0]) <= threshold &&
        Math.abs(ma[1] - mb[1]) <= threshold &&
        Math.abs(ma[2] - mb[2]) <= threshold;

      if (match) {
        same++;
      }
    }
  }

  if (counted === 0) return 1.0;
  return Number((same / counted).toFixed(4));
}

/**
 * Multi-scale perceptual similarity (SSIM on downsampled luminance):
 * Smallest dimension scaled down so max dimension is at most 512px.
 * Computes luminance SSIM across 8x8 windows.
 * Ignores windows covered by NoiseMask.
 */
export function computePerceptualSimilarity(
  a: RawImage,
  b: RawImage,
  mask?: NoiseMask
): number {
  if (a.width !== b.width || a.height !== b.height || a.width === 0 || a.height === 0) {
    return 0.0;
  }

  const f = Math.max(1, Math.ceil(Math.max(a.width, a.height) / 512));
  const sw = Math.ceil(a.width / f);
  const sh = Math.ceil(a.height / f);

  const getLuma = (img: RawImage): Float64Array => {
    const out = new Float64Array(sw * sh);
    const count = new Uint32Array(sw * sh);
    const channels = (img as any).channels || 4;

    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const o = (y * img.width + x) * channels;
        const l =
          0.299 * img.data[o] +
          0.587 * img.data[o + 1] +
          0.114 * img.data[o + 2];

        const sy = Math.floor(y / f);
        const sx = Math.floor(x / f);
        const idx = sy * sw + sx;
        if (idx < out.length) {
          out[idx] += l;
          count[idx] += 1;
        }
      }
    }

    for (let i = 0; i < out.length; i++) {
      if (count[i] > 0) {
        out[i] /= count[i];
      }
    }
    return out;
  };

  const la = getLuma(a);
  const lb = getLuma(b);

  const c1 = Math.pow(0.01 * 255.0, 2);
  const c2 = Math.pow(0.03 * 255.0, 2);
  const WIN = 8;

  let total = 0;
  let windows = 0;
  let masked = 0;

  for (let y = 0; y < sh; y += WIN) {
    for (let x = 0; x < sw; x += WIN) {
      if (mask && mask.covers(x * f, y * f)) {
        masked++;
        continue;
      }

      const ye = Math.min(y + WIN, sh);
      const xe = Math.min(x + WIN, sw);
      const n = (ye - y) * (xe - x);
      if (n === 0) continue;

      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;

      for (let yy = y; yy < ye; yy++) {
        for (let xx = x; xx < xe; xx++) {
          const i = yy * sw + xx;
          const p = la[i] || 0;
          const q = lb[i] || 0;
          sa += p;
          sb += q;
          saa += p * p;
          sbb += q * q;
          sab += p * q;
        }
      }

      const ma = sa / n;
      const mb = sb / n;
      const va = Math.max(0, saa / n - ma * ma);
      const vb = Math.max(0, sbb / n - mb * mb);
      const cov = sab / n - ma * mb;

      const ssim =
        ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) /
        ((ma * ma + mb * mb + c1) * (va + vb + c2));

      total += ssim;
      windows++;
    }
  }

  if (windows === 0 && masked === 0) return 0.0;
  if (windows === 0 && masked > 0) return 1.0;

  const result = Math.min(1.0, Math.max(0.0, total / windows));
  return Number(result.toFixed(4));
}
