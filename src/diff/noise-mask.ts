import sharp from "sharp";

export const NOISE_TILE = 16;

export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array | Buffer;
  channels?: number;
}

export class NoiseMask {
  public readonly tile: number;
  public readonly cols: number;
  public readonly rows: number;
  public readonly bits: boolean[];

  constructor(tile: number, cols: number, rows: number, bits: boolean[]) {
    this.tile = tile;
    this.cols = cols;
    this.rows = rows;
    this.bits = bits;
  }

  /**
   * Calculates tile mean RGB color.
   */
  private static tileMean(
    img: RawImage,
    tile: number,
    bx: number,
    by: number
  ): [number, number, number] {
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let n = 0;

    const startY = by * tile;
    const endY = Math.min((by + 1) * tile, img.height);
    const startX = bx * tile;
    const endX = Math.min((bx + 1) * tile, img.width);
    const channels = img.channels || 4;

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
   * Finds tiles whose mean RGB differs by more than `threshold` per channel between two pictures,
   * grown by 1 tile (dilation 3x3) so moving edges are covered too.
   */
  public static betweenRaw(
    a: RawImage,
    b: RawImage,
    threshold: number = 24
  ): NoiseMask {
    const tile = NOISE_TILE;
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const cols = Math.ceil(w / tile);
    const rows = Math.ceil(h / tile);

    const changed: boolean[] = new Array(cols * rows).fill(false);

    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const ma = this.tileMean(a, tile, tx, ty);
        const mb = this.tileMean(b, tile, tx, ty);

        const diffR = Math.abs(ma[0] - mb[0]);
        const diffG = Math.abs(ma[1] - mb[1]);
        const diffB = Math.abs(ma[2] - mb[2]);

        if (diffR > threshold || diffG > threshold || diffB > threshold) {
          changed[ty * cols + tx] = true;
        }
      }
    }

    const at = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
      return changed[y * cols + x] || false;
    };

    // Dilate by 1 tile in all directions (3x3 neighborhood)
    const bits: boolean[] = new Array(cols * rows).fill(false);
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        let isCovered = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (at(tx + dx, ty + dy)) {
              isCovered = true;
              break;
            }
          }
          if (isCovered) break;
        }
        bits[ty * cols + tx] = isCovered;
      }
    }

    return new NoiseMask(tile, cols, rows, bits);
  }

  /**
   * The tiles either mask covers.
   */
  public union(other: NoiseMask): NoiseMask {
    if (this.cols !== other.cols || this.rows !== other.rows) {
      // If sizes differ, expand to max
      const maxCols = Math.max(this.cols, other.cols);
      const maxRows = Math.max(this.rows, other.rows);
      const newBits: boolean[] = new Array(maxCols * maxRows).fill(false);
      for (let y = 0; y < maxRows; y++) {
        for (let x = 0; x < maxCols; x++) {
          const bitA = x < this.cols && y < this.rows ? this.bits[y * this.cols + x] : false;
          const bitB = x < other.cols && y < other.rows ? other.bits[y * other.cols + x] : false;
          newBits[y * maxCols + x] = bitA || bitB;
        }
      }
      return new NoiseMask(this.tile, maxCols, maxRows, newBits);
    }

    const merged = this.bits.map((bit, idx) => bit || other.bits[idx]);
    return new NoiseMask(this.tile, this.cols, this.rows, merged);
  }

  /**
   * Check if pixel (x, y) is covered by the mask.
   */
  public covers(x: number, y: number): boolean {
    const tx = Math.floor(x / Math.max(1, this.tile));
    const ty = Math.floor(y / Math.max(1, this.tile));
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return false;
    return this.bits[ty * this.cols + tx] || false;
  }

  /**
   * Count how many tiles change by themselves.
   */
  public count(): number {
    return this.bits.filter(Boolean).length;
  }

  /**
   * Export to 1 pixel per tile PNG (white where changing, black where still).
   */
  public async toPng(): Promise<Buffer> {
    const width = Math.max(1, this.cols);
    const height = Math.max(1, this.rows);
    const rgba = Buffer.alloc(width * height * 4);

    for (let i = 0; i < this.bits.length; i++) {
      const isWhite = this.bits[i];
      const val = isWhite ? 255 : 0;
      const offset = i * 4;
      rgba[offset] = val;
      rgba[offset + 1] = val;
      rgba[offset + 2] = val;
      rgba[offset + 3] = 255;
    }

    return sharp(rgba, { raw: { width, height, channels: 4 } })
      .png()
      .toBuffer();
  }

  /**
   * Read back a mask from a PNG.
   */
  public static async fromPng(pngBuffer: Buffer): Promise<NoiseMask> {
    const img = sharp(pngBuffer);
    const meta = await img.metadata();
    const cols = meta.width || 1;
    const rows = meta.height || 1;
    const raw = await img.raw().toBuffer();

    const bits: boolean[] = [];
    const channels = meta.channels || 4;
    for (let i = 0; i < cols * rows; i++) {
      const r = raw[i * channels];
      bits.push(r > 127);
    }

    return new NoiseMask(NOISE_TILE, cols, rows, bits);
  }

  /**
   * Convert masked tiles to odiff ignoreRegions rects.
   */
  public toIgnoreRegions(
    cropRect?: { x: number; y: number },
    dpr: number = 1,
    maxDimensions?: { width: number; height: number }
  ): Array<{ x1: number; y1: number; x2: number; y2: number }> {
    const regions: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const tilePx = this.tile;

    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        if (!this.bits[ty * this.cols + tx]) continue;

        let x1 = tx * tilePx;
        let y1 = ty * tilePx;
        let x2 = (tx + 1) * tilePx;
        let y2 = (ty + 1) * tilePx;

        if (maxDimensions) {
          x2 = Math.min(x2, maxDimensions.width);
          y2 = Math.min(y2, maxDimensions.height);
        }

        if (x2 > x1 && y2 > y1) {
          regions.push({ x1, y1, x2, y2 });
        }
      }
    }

    return regions;
  }
}
