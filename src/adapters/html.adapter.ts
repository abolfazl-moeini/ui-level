import path from "node:path";
import fs from "node:fs";
import type { Browser } from "playwright-core";
import type { NormalizedSpec, UILevelConfig } from "../schema.js";
import { extractPageTelemetry } from "../browser/telemetry.js";
import { findProjectRoot, startStaticServer, type StaticServerInstance } from "../server/static-host.js";

export interface HTMLAdapterResult {
  spec: NormalizedSpec;
  refScreenshotPath: string;
  closeServer?: () => Promise<void>;
}

export async function processHTMLReference(
  browser: Browser,
  refTarget: string,
  config: UILevelConfig,
  outputDir: string
): Promise<HTMLAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  let server: StaticServerInstance | undefined;
  let targetUrl = refTarget;

  if (!refTarget.startsWith("http://") && !refTarget.startsWith("https://")) {
    const projectRoot = findProjectRoot(refTarget, config.root);
    server = await startStaticServer(projectRoot);
    targetUrl = server.getUrlForFile(refTarget);
  }

  const context = await browser.newContext({
    viewport: {
      width: config.viewport.width,
      height: config.viewport.height,
    },
    deviceScaleFactor: config.viewport.deviceScaleFactor,
    ignoreHTTPSErrors: config.ignoreHttpsErrors,
  });

  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30000 });

    if (config.injectCss) {
      await page.addStyleTag({ content: config.injectCss });
    }

    const telemetry = await extractPageTelemetry(page, config.selector, refScreenshotPath);

    const spec: NormalizedSpec = {
      adapter: "html",
      viewport: config.viewport,
      nodes: telemetry.nodes,
      imagePath: refScreenshotPath,
    };

    return {
      spec,
      refScreenshotPath,
      closeServer: server ? server.close : undefined,
    };
  } finally {
    await context.close();
  }
}
