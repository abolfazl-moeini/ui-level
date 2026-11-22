import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import type { Browser, BrowserContext } from "playwright-core";
import {
  ConfigSchema,
  DeltaPacketSchema,
  NormalizedSpecSchema,
  type DeltaPacket,
  type GeometryRect,
  type NormalizedSpec,
  type ReferenceManifest,
  type UILevelConfig,
  type UserUILevelConfig,
} from "./schema.js";
import { launchBrowser } from "./browser/resolver.js";
import { extractPageTelemetry, compareTelemetryWithSpec } from "./browser/telemetry.js";
import { createCdpStyleInspector, type CdpStyleInspector } from "./browser/cdp-styles.js";
import { runPixelDiff } from "./diff/pixel.js";
import { generateTripletImage } from "./diff/triplet.js";
import { processHTMLReference } from "./adapters/html.adapter.js";
import { processImageReference } from "./adapters/image.adapter.js";
import { processFigmaReference } from "./adapters/figma.adapter.js";
import { isSnapshotDirectory } from "./snapshot/manager.js";
import {
  findProjectRoot,
  startStaticServer,
  type StaticServerInstance,
} from "./server/static-host.js";

export * from "./schema.js";
export * from "./adapters/figwright.converter.js";
export * from "./snapshot/manager.js";
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
  userConfig: UserUILevelConfig = {},
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
    const isRemoteTarget =
      targetUrl.startsWith("http://") ||
      targetUrl.startsWith("https://") ||
      targetUrl.startsWith("data:");
    if (!isRemoteTarget) {
      if (!fs.existsSync(path.resolve(targetUrl))) {
        throw new Error(`Target HTML/SVG file not found: ${targetUrl}`);
      }
      const projectRoot = findProjectRoot(targetUrl, config.root);
      targetServer = await startStaticServer(projectRoot);
      targetUrl = targetServer.getUrlForFile(targetUrl);
    }

    // 2. Process Reference via Adapter
    let refResult: {
      spec: NormalizedSpec;
      refScreenshotPath: string;
      warnings?: string[];
      manifest?: ReferenceManifest;
      inferredDpr?: number;
    };

    const cleanRefPath = config.ref ? config.ref.split(/[?#]/)[0] : "";
    const isImageRef = Boolean(cleanRefPath && /\.(png|jpe?g|svg|webp)$/i.test(cleanRefPath));
    const isSnapshotDir = Boolean(
      (config.ref && isSnapshotDirectory(config.ref)) ||
      (config.refSpec && isSnapshotDirectory(config.refSpec))
    );
    const hasExplicitNonFigmaAdapter =
      userConfig.adapter === "html" || userConfig.adapter === "image";
    const effectiveAdapter: "html" | "figma" | "image" =
      config.adapter === "figma" || isSnapshotDir || (Boolean(config.refSpec) && !hasExplicitNonFigmaAdapter)
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

    // Single validation choke point: ensure reference spec is valid and non-empty (IDEA-01)
    NormalizedSpecSchema.parse(refResult.spec);

    const effectiveSelectorMap = {
      ...(refResult.manifest?.selectorMap || {}),
      ...(config.selectorMap || {}),
    };

    const userSpecifiedDpr =
      userConfig.viewport && typeof userConfig.viewport.deviceScaleFactor === "number";
    const initialDpr = userSpecifiedDpr
      ? config.viewport.deviceScaleFactor
      : (refResult.inferredDpr || config.viewport.deviceScaleFactor);

    // 3. Navigate to Live Target Page in an isolated BrowserContext
    targetContext = await browser.newContext({
      viewport: {
        width: config.viewport.width,
        height: config.viewport.height,
      },
      deviceScaleFactor: initialDpr,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
    });

    const page = await targetContext.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    if (config.injectCss) {
      await page.addStyleTag({ content: config.injectCss });
    }

    // 4. Extract Live Page Telemetry, Mask Rects & Live Screenshot
    let effectiveDpr = initialDpr;
    let liveTelemetry = await extractPageTelemetry(
      page,
      config.selector,
      liveScreenshotPath,
      config.maskSelectors,
      Object.keys(effectiveSelectorMap).length > 0 ? effectiveSelectorMap : undefined
    );

    // Smart 1x Screenshot Support: if user supplied a 1x raster PNG/JPG/WEBP matching 1x CSS dimensions
    // while DPR defaulted to 2, re-capture live at 1x DPR so 1x screenshots work without false DIMENSION_DRIFT.
    const isRasterImageRef = Boolean(cleanRefPath && /\.(png|jpe?g|webp)$/i.test(cleanRefPath));
    const shouldAutoDetect1x =
      !userSpecifiedDpr &&
      effectiveDpr === 2 &&
      ((effectiveAdapter === "image" && isRasterImageRef) || effectiveAdapter === "figma");

    if (shouldAutoDetect1x) {
      const refImgMeta = await sharp(refResult.refScreenshotPath).metadata();
      const refW = refImgMeta.width || 0;
      const refH = refImgMeta.height || 0;
      const cssW = Math.round(liveTelemetry.rootRect.width);
      const cssH = Math.round(liveTelemetry.rootRect.height);
      if (Math.abs(refW - cssW) <= 2 && Math.abs(refH - cssH) <= 2 && cssW > 0 && cssH > 0) {
        effectiveDpr = 1;
        if (effectiveAdapter === "image" && refResult.spec.nodes[0]) {
          refResult.spec.nodes[0].rect.width = refW;
          refResult.spec.nodes[0].rect.height = refH;
        }
        const ctx1x = await browser.newContext({
          viewport: { width: config.viewport.width, height: config.viewport.height },
          deviceScaleFactor: 1,
          ignoreHTTPSErrors: config.ignoreHttpsErrors,
        });
        try {
          const p1x = await ctx1x.newPage();
          await p1x.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });
          if (config.injectCss) {
            await p1x.addStyleTag({ content: config.injectCss });
          }
          await p1x.locator(config.selector).first().screenshot({
            animations: "disabled",
            caret: "hide",
            scale: "device",
            path: liveScreenshotPath,
          });
        } finally {
          await ctx1x.close();
        }
      }
    }

    // 5. Gate 1: Deterministic Style & Geometry Check
    const configWithEffectiveSelectorMap = {
      ...config,
      selectorMap:
        Object.keys(effectiveSelectorMap).length > 0 ? effectiveSelectorMap : undefined,
    };
    const { styleViolations, geometryViolations } = compareTelemetryWithSpec(
      liveTelemetry.nodes,
      refResult.spec.nodes,
      configWithEffectiveSelectorMap
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
        dpr: effectiveDpr,
        cropRect: liveTelemetry.rootRect,
        maskRects,
        adapter: effectiveAdapter,
        subpixelTolerancePx: config.subpixelTolerancePx,
        liveNodes: liveTelemetry.nodes,
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
      ...(refResult.warnings && refResult.warnings.length > 0
        ? { warnings: refResult.warnings }
        : {}),
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
