import path from "node:path";
import fs from "node:fs";
import type { Browser, BrowserContext } from "playwright-core";
import {
  ConfigSchema,
  DeltaPacketSchema,
  type DeltaPacket,
  type GeometryRect,
  type NormalizedSpec,
  type UILevelConfig,
} from "./schema.js";
import { launchBrowser } from "./browser/resolver.js";
import { extractPageTelemetry, compareTelemetryWithSpec } from "./browser/telemetry.js";
import { createCdpStyleInspector, type CdpStyleInspector } from "./browser/cdp-styles.js";
import { runPixelDiff } from "./diff/pixel.js";
import { generateTripletImage } from "./diff/triplet.js";
import { processHTMLReference } from "./adapters/html.adapter.js";
import { processImageReference } from "./adapters/image.adapter.js";
import { processFigmaReference } from "./adapters/figma.adapter.js";
import {
  findProjectRoot,
  startStaticServer,
  type StaticServerInstance,
} from "./server/static-host.js";

export * from "./schema.js";
export { launchBrowser, resolveBrowserExecutable } from "./browser/resolver.js";
export {
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  sendDaemonRequest,
  getDaemonSocketPath,
} from "./browser/daemon.js";
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
  let targetContext: BrowserContext | undefined;
  let cdpInspector: CdpStyleInspector | undefined;
  let targetUrl = config.targetUrl;

  try {
    // 1. Resolve local target files via static server from project root
    const isRemoteTarget = targetUrl.startsWith("http://") || targetUrl.startsWith("https://");
    if (!isRemoteTarget) {
      if (!fs.existsSync(path.resolve(targetUrl))) {
        throw new Error(`Target HTML/SVG file not found: ${targetUrl}`);
      }
      const projectRoot = findProjectRoot(targetUrl, config.root);
      targetServer = await startStaticServer(projectRoot);
      targetUrl = targetServer.getUrlForFile(targetUrl);
    }

    // 2. Process Reference via Adapter
    let refResult: { spec: NormalizedSpec; refScreenshotPath: string };

    const cleanRefPath = config.ref ? config.ref.split(/[?#]/)[0] : "";
    const isImageRef = Boolean(cleanRefPath && /\.(png|jpe?g|svg|webp)$/i.test(cleanRefPath));
    const effectiveAdapter: "html" | "figma" | "image" =
      config.adapter === "figma"
        ? "figma"
        : config.adapter === "image" || isImageRef
          ? "image"
          : "html";

    if (effectiveAdapter === "figma") {
      refResult = await processFigmaReference(config, outputDir);
    } else if (effectiveAdapter === "image") {
      refResult = await processImageReference(browser, config.ref || "ref.png", config, outputDir);
    } else {
      refResult = await processHTMLReference(browser, config.ref || "ref.html", config, outputDir);
    }

    // 3. Navigate to Live Target Page in an isolated BrowserContext
    targetContext = await browser.newContext({
      viewport: {
        width: config.viewport.width,
        height: config.viewport.height,
      },
      deviceScaleFactor: config.viewport.deviceScaleFactor,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
    });

    const page = await targetContext.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    if (config.injectCss) {
      await page.addStyleTag({ content: config.injectCss });
    }

    // 4. Extract Live Page Telemetry, Mask Rects & Live Screenshot
    const liveTelemetry = await extractPageTelemetry(
      page,
      config.selector,
      liveScreenshotPath,
      config.maskSelectors
    );

    // 5. Gate 1: Deterministic Style & Geometry Check
    const { styleViolations, geometryViolations } = compareTelemetryWithSpec(
      liveTelemetry.nodes,
      refResult.spec.nodes,
      config
    );

    // Lazy CDP Inspection: zero overhead on green runs, single shared session on violations
    if (styleViolations.length > 0) {
      cdpInspector = await createCdpStyleInspector(page);
      for (const violation of styleViolations) {
        if (violation.property === "renderedLines" || violation.property === "textContent") continue;
        const source = await cdpInspector.inspect(violation.selector, violation.property);
        if (source) {
          violation.cssRuleSource = source;
        }
      }
      await cdpInspector.dispose();
      cdpInspector = undefined;
    }

    await targetContext.close();
    targetContext = undefined;

    // 6. Gate 2: Pixel Diff
    const maskRects: GeometryRect[] = [...liveTelemetry.maskRects];

    // Plan §3.2(2): In Figma mode, typography is proven 100% in Gate 1; keep text rects masked
    // during Gate 2 to eliminate Skia vs CoreText/FreeType font shaping false positives.
    if (effectiveAdapter === "figma") {
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
        adapter: effectiveAdapter,
        subpixelTolerancePx: config.subpixelTolerancePx,
      }
    );

    await generateTripletImage(
      refResult.refScreenshotPath,
      liveScreenshotPath,
      diffOutputPath,
      tripletOutputPath
    );
    pixelDiff.tripletImagePath = tripletOutputPath;

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
      adapter: effectiveAdapter,
      timestamp: new Date().toISOString(),
      durationMs,
      targetUrl: config.targetUrl,
      refSource: config.ref || config.refSpec || "default",
      styleViolations,
      geometryViolations,
      pixelDiff,
      summary,
    };

    return DeltaPacketSchema.parse(deltaPacket);
  } finally {
    if (cdpInspector) {
      await cdpInspector.dispose();
    }
    if (targetContext) {
      await targetContext.close();
    }
    if (targetServer) {
      await targetServer.close();
    }
    if (shouldCloseBrowser && browser) {
      await browser.close();
    }
  }
}
