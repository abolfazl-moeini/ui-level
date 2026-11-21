import path from "node:path";
import fs from "node:fs";
import type { Browser } from "playwright-core";
import sharp from "sharp";
import type { NormalizedSpec, UILevelConfig } from "../schema.js";
import {
  findProjectRoot,
  startStaticServer,
  type StaticServerInstance,
} from "../server/static-host.js";

export interface ImageAdapterResult {
  spec: NormalizedSpec;
  refScreenshotPath: string;
}

export async function processImageReference(
  browser: Browser,
  refTarget: string,
  config: UILevelConfig,
  outputDir: string
): Promise<ImageAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  const isRemoteUrl = refTarget.startsWith("http://") || refTarget.startsWith("https://");
  const cleanUrlPath = isRemoteUrl ? new URL(refTarget).pathname : refTarget;
  const ext = path.extname(cleanUrlPath).toLowerCase();

  if (ext === ".svg") {
    let server: StaticServerInstance | undefined;
    let svgUrl = refTarget;

    const context = await browser.newContext({
      viewport: {
        width: config.viewport.width,
        height: config.viewport.height,
      },
      deviceScaleFactor: config.viewport.deviceScaleFactor,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
    });

    try {
      if (!isRemoteUrl) {
        if (!fs.existsSync(path.resolve(refTarget))) {
          throw new Error(`Reference SVG file not found: ${refTarget}`);
        }
        const projectRoot = findProjectRoot(refTarget, config.root);
        server = await startStaticServer(projectRoot);
        svgUrl = server.getUrlForFile(refTarget);
      }

      const page = await context.newPage();
      await page.goto(svgUrl, { waitUntil: "networkidle", timeout: 15000 });

      const svgLocator = page.locator("svg").first();
      const hasSvgTag = (await svgLocator.count()) > 0;

      if (hasSvgTag) {
        await svgLocator.screenshot({
          animations: "disabled",
          scale: "device",
          path: refScreenshotPath,
        });
      } else {
        await page.screenshot({
          animations: "disabled",
          scale: "device",
          path: refScreenshotPath,
        });
      }
    } finally {
      await context.close();
      if (server) {
        await server.close();
      }
    }
  } else if (isRemoteUrl) {
    const res = await fetch(refTarget);
    if (!res.ok) {
      throw new Error(`Failed to fetch reference image ${refTarget}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await sharp(buf).png().toFile(refScreenshotPath);
  } else {
    const absPath = path.resolve(refTarget);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Reference image not found: ${refTarget}`);
    }
    await sharp(absPath).png().toFile(refScreenshotPath);
  }

  const meta = await sharp(refScreenshotPath).metadata();
  const dpr = config.viewport.deviceScaleFactor || 2;
  const cssWidth = Number(((meta.width || 0) / dpr).toFixed(2));
  const cssHeight = Number(((meta.height || 0) / dpr).toFixed(2));

  const spec: NormalizedSpec = {
    adapter: "image",
    viewport: config.viewport,
    nodes: [
      {
        id: "root-image",
        selector: config.selector,
        rect: {
          x: 0,
          y: 0,
          width: cssWidth,
          height: cssHeight,
        },
        styles: {
          width: cssWidth,
          height: cssHeight,
        },
      },
    ],
    imagePath: refScreenshotPath,
  };

  return {
    spec,
    refScreenshotPath,
  };
}
