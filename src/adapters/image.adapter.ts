import path from "node:path";
import fs from "node:fs";
import type { Browser } from "playwright-core";
import sharp from "sharp";
import type { NormalizedSpec, UILevelConfig } from "../schema.js";
import { findProjectRoot, startStaticServer, type StaticServerInstance } from "../server/static-host.js";

export interface ImageAdapterResult {
  spec: NormalizedSpec;
  refScreenshotPath: string;
  closeServer?: () => Promise<void>;
}

export async function processImageReference(
  browser: Browser,
  refTarget: string,
  config: UILevelConfig,
  outputDir: string
): Promise<ImageAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  const ext = path.extname(refTarget).toLowerCase();

  if (ext === ".svg") {
    // Render SVG inside Chromium for 100% font fidelity and RTL ligature preservation
    let server: StaticServerInstance | undefined;
    let svgUrl = refTarget;

    if (!refTarget.startsWith("http://") && !refTarget.startsWith("https://")) {
      const projectRoot = findProjectRoot(refTarget, config.root);
      server = await startStaticServer(projectRoot);
      svgUrl = server.getUrlForFile(refTarget);
    }

    const context = await browser.newContext({
      viewport: {
        width: config.viewport.width,
        height: config.viewport.height,
      },
      deviceScaleFactor: config.viewport.deviceScaleFactor,
    });

    const page = await context.newPage();

    try {
      await page.goto(svgUrl, { waitUntil: "networkidle", timeout: 15000 });
      // Capture screenshot of the SVG element
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

      if (server) {
        await server.close();
      }
    } finally {
      await context.close();
    }
  } else {
    // PNG, JPEG, WEBP
    const absPath = path.resolve(refTarget);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Reference image not found: ${refTarget}`);
    }

    // Convert or save directly to ref.png
    await sharp(absPath).png().toFile(refScreenshotPath);
  }

  const meta = await sharp(refScreenshotPath).metadata();
  const dpr = config.viewport.deviceScaleFactor || 2;
  const cssWidth = (meta.width || 0) / dpr;
  const cssHeight = (meta.height || 0) / dpr;

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
