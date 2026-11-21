import path from "node:path";
import fs from "node:fs";
import type { Browser } from "playwright-core";
import {
  ConfigSchema,
  DeltaPacketSchema,
  type DeltaPacket,
  type GeometryRect,
  type UILevelConfig,
} from "./schema.js";
import { launchBrowser } from "./browser/resolver.js";
import { extractPageTelemetry, compareTelemetryWithSpec } from "./browser/telemetry.js";
import { findWinningCssRule } from "./browser/cdp-styles.js";
import { runPixelDiff } from "./diff/pixel.js";
import { generateTripletImage } from "./diff/triplet.js";
import { processHTMLReference } from "./adapters/html.adapter.js";
import { processImageReference } from "./adapters/image.adapter.js";
import { processFigmaReference } from "./adapters/figma.adapter.js";
import { findProjectRoot, startStaticServer, type StaticServerInstance } from "./server/static-host.js";

export * from "./schema.js";
export { launchBrowser } from "./browser/resolver.js";
export { startDaemon, isDaemonRunning, sendDaemonRequest } from "./browser/daemon.js";
export { startStaticServer } from "./server/static-host.js";

export async function check(
  userConfig: Partial<UILevelConfig> = {},
  existingBrowser?: Browser
): Promise<DeltaPacket> {
  const startTime = Date.now();
  const config = ConfigSchema.parse(userConfig);

  const outputDir = path.resolve(config.outputDir || ".ui-level");
  fs.mkdirSync(outputDir, { recursive: true });

  const liveScreenshotPath = path.join(outputDir, "live.png");
  const diffOutputPath = path.join(outputDir, "diff.png");
  const tripletOutputPath = path.join(outputDir, "triplet.png");

  let browser = existingBrowser;
  const shouldCloseBrowser = !existingBrowser;

  if (!browser) {
    browser = await launchBrowser();
  }

  let targetServer: StaticServerInstance | undefined;
  let targetUrl = config.targetUrl;

  try {
    // 1. Resolve local target files via static server from project root
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
      const projectRoot = findProjectRoot(targetUrl, config.root);
      targetServer = await startStaticServer(projectRoot);
      targetUrl = targetServer.getUrlForFile(targetUrl);
    }

    // 2. Process Reference via Adapter
    let refResult: { spec: any; refScreenshotPath: string; closeServer?: () => Promise<void> };

    if (config.adapter === "figma") {
      refResult = await processFigmaReference(config, outputDir, {
        refSpecPath: config.ref?.endsWith(".json") ? config.ref : undefined,
        refImagePath: config.ref?.endsWith(".png") ? config.ref : undefined,
      });
    } else if (config.adapter === "image" || (config.ref && /\.(png|jpe?g|svg|webp)$/i.test(config.ref))) {
      refResult = await processImageReference(browser, config.ref || "ref.png", config, outputDir);
    } else {
      // Default HTML adapter
      refResult = await processHTMLReference(browser, config.ref || "ref.html", config, outputDir);
    }

    // 3. Navigate to Live Target Page
    const context = await browser.newContext({
      viewport: {
        width: config.viewport.width,
        height: config.viewport.height,
      },
      deviceScaleFactor: config.viewport.deviceScaleFactor,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
    });

    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    if (config.injectCss) {
      await page.addStyleTag({ content: config.injectCss });
    }

    // 4. Extract Live Page Telemetry & Live Screenshot
    const liveTelemetry = await extractPageTelemetry(page, config.selector, liveScreenshotPath);

    // 5. Gate 1: Deterministic Style & Geometry Check
    const { styleViolations, geometryViolations } = compareTelemetryWithSpec(
      liveTelemetry.nodes,
      refResult.spec.nodes,
      config
    );

    // Lazy CDP Inspection for winning CSS rule on style violations
    if (styleViolations.length > 0) {
      for (const violation of styleViolations) {
        const source = await findWinningCssRule(page, violation.selector, violation.property);
        if (source) {
          violation.cssRuleSource = source;
        }
      }
    }

    // 6. Gate 2: Pixel Diff
    const maskRects: GeometryRect[] = [];

    // Collect user mask selectors
    if (config.maskSelectors && config.maskSelectors.length > 0) {
      for (const maskSel of config.maskSelectors) {
        const count = await page.locator(maskSel).count();
        for (let i = 0; i < count; i++) {
          const bcr = await page.locator(maskSel).nth(i).boundingBox();
          if (bcr) {
            maskRects.push(bcr);
          }
        }
      }
    }

    // If Figma adapter, add text regions to maskRects so Skia vs CoreText text antialiasing does not give false diffs
    if (config.adapter === "figma") {
      for (const node of liveTelemetry.nodes) {
        if (node.textRects && node.textRects.length > 0) {
          maskRects.push(...node.textRects);
        }
      }
    }

    const pixelDiff = await runPixelDiff(
      refResult.refScreenshotPath,
      liveScreenshotPath,
      diffOutputPath,
      {
        threshold: config.threshold,
        dpr: config.viewport.deviceScaleFactor,
        cropRect: liveTelemetry.rootRect,
        maskRects,
        adapter: config.adapter,
      }
    );

    // Generate Triplet image (Ref | Live | Diff)
    await generateTripletImage(
      refResult.refScreenshotPath,
      liveScreenshotPath,
      diffOutputPath,
      tripletOutputPath
    );
    pixelDiff.tripletImagePath = tripletOutputPath;

    await context.close();
    if (refResult.closeServer) {
      await refResult.closeServer();
    }

    const durationMs = Date.now() - startTime;
    const isPass =
      styleViolations.length === 0 &&
      geometryViolations.length === 0 &&
      pixelDiff.match;

    const summaryParts: string[] = [];
    if (styleViolations.length > 0) {
      summaryParts.push(`${styleViolations.length} style violation(s)`);
    }
    if (geometryViolations.length > 0) {
      summaryParts.push(`${geometryViolations.length} geometry violation(s)`);
    }
    if (!pixelDiff.match) {
      summaryParts.push(
        pixelDiff.dimensionDrift
          ? `dimension drift (${pixelDiff.liveDimensions.width}x${pixelDiff.liveDimensions.height} vs ${pixelDiff.refDimensions.width}x${pixelDiff.refDimensions.height})`
          : `${pixelDiff.diffCount} different pixel(s) (${pixelDiff.diffPercentage}%)`
      );
    }

    const summary = isPass
      ? `PASS: Visual & Style Spec 100% matched in ${durationMs}ms`
      : `FAIL: ${summaryParts.join(", ")} in ${durationMs}ms`;

    const deltaPacket: DeltaPacket = {
      status: isPass ? "pass" : "fail",
      adapter: config.adapter,
      timestamp: new Date().toISOString(),
      durationMs,
      targetUrl: config.targetUrl,
      refSource: config.ref || "default",
      styleViolations,
      geometryViolations,
      pixelDiff,
      summary,
    };

    return DeltaPacketSchema.parse(deltaPacket);
  } finally {
    if (targetServer) {
      await targetServer.close();
    }
    if (shouldCloseBrowser && browser) {
      await browser.close();
    }
  }
}
