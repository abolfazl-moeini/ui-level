import { Command } from "commander";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check } from "./index.js";
import { resolveBrowserExecutable, launchBrowser } from "./browser/resolver.js";
import {
  isDaemonRunning,
  sendDaemonRequest,
  startDaemon,
  stopDaemon,
  getDaemonSocketPath,
} from "./browser/daemon.js";
import { startMcpServer } from "./mcp/server.js";
import type { DeltaPacket, UILevelConfig } from "./schema.js";

const program = new Command();

function isRemoteOrFigmaId(val?: string): boolean {
  if (!val) return true;
  if (val.startsWith("http://") || val.startsWith("https://")) return true;
  // Treat explicit fileKey:nodeId without path separators or extension as Figma shorthand
  if (val.includes(":") && !val.includes("/") && !val.includes("\\") && !/\.[a-z0-9]+$/i.test(val)) {
    return true;
  }
  return false;
}

function resolveLocalPathIfAny(val: string | undefined, baseDir: string): string | undefined {
  if (!val) return undefined;
  if (isRemoteOrFigmaId(val)) return val;
  return path.resolve(baseDir, val);
}

function parseViewportFlag(val: string): { width: number; height: number } {
  const m = val.trim().match(/^(\d+)x(\d+)$/i);
  if (!m) {
    throw new Error(`Invalid viewport '${val}'. Expected format '<width>x<height>', e.g. 1280x800.`);
  }
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

async function ensureWarmDaemon(): Promise<boolean> {
  if (await isDaemonRunning()) return true;

  try {
    const child = spawn(process.execPath, [process.argv[1], "daemon", "start", "--foreground"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await isDaemonRunning()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    // Fall back to direct execution
  }
  return false;
}

program
  .name("ui-level")
  .description("Deterministic visual & CSS spec regression engine for modern UI workflows")
  .version("1.0.0");

program
  .command("check")
  .description("Run visual & CSS regression check between target and reference")
  .option("-t, --target <url|file>", "Target URL or local HTML file")
  .option("-r, --ref <url|file|key>", "Reference HTML, image, or Figma node/URL")
  .option("-a, --adapter <type>", "Adapter type: html, figma, image")
  .option("-s, --selector <css>", "CSS selector to inspect")
  .option("--threshold <number>", "Pixel diff threshold (0.0 to 1.0)", parseFloat)
  .option("--viewport <WxH>", "Viewport size, e.g. 1280x800")
  .option("-c, --config <path>", "Path to ui-level.config.json")
  .option("--mask <selectors...>", "Selectors to mask from pixel diff")
  .option("--inject-css <css>", "Custom CSS to inject into target page")
  .option("--root <dir>", "Project root directory")
  .option("--output <dir>", "Output directory for screenshots and triplet", undefined)
  .option("--ref-spec <path>", "Offline reference spec JSON path (Figma MCP)")
  .option("--ref-image <path>", "Offline reference PNG image path (Figma MCP)")
  .option("--ignore-https-errors", "Ignore HTTPS certificate errors")
  .option("--no-ignore-https-errors", "Enforce strict HTTPS certificates")
  .option("--daemon", "Use background daemon for sub-350ms warm execution")
  .option("--json", "Output pure JSON DeltaPacket to stdout")
  .action(async (options, cmd) => {
    try {
      let fileConfig: Partial<UILevelConfig> = {};
      const defaultCandidates = [
        "ui-level.config.json",
        path.join(".harness", "frontend", "ui-level.config.json"),
      ];
      const discoveredConfig = defaultCandidates.find((p) => fs.existsSync(p)) || null;
      const configPath = options.config || discoveredConfig;

      if (options.config && !fs.existsSync(options.config)) {
        console.error(`Config file not found: ${options.config}`);
        process.exit(2);
      }

      if (configPath && fs.existsSync(configPath)) {
        try {
          const raw = fs.readFileSync(configPath, "utf-8");
          fileConfig = JSON.parse(raw);
        } catch (err: any) {
          console.error(`Error reading config file ${configPath}: ${err.message}`);
          process.exit(2);
        }
      }

      const cliSet = (name: string) => cmd.getOptionValueSource(name) === "cli";

      const mergedViewport = options.viewport
        ? {
            deviceScaleFactor: 2,
            ...(fileConfig.viewport || {}),
            ...parseViewportFlag(options.viewport),
          }
        : fileConfig.viewport;

      const mergedConfig: Partial<UILevelConfig> = {
        ...fileConfig,
        targetUrl: cliSet("target") ? options.target : fileConfig.targetUrl || "index.html",
        ref: cliSet("ref") ? options.ref : fileConfig.ref,
        adapter: cliSet("adapter") ? (options.adapter as any) : fileConfig.adapter || "html",
        selector: cliSet("selector") ? options.selector : fileConfig.selector || "body",
        threshold: cliSet("threshold") ? options.threshold : fileConfig.threshold,
        maskSelectors: cliSet("mask")
          ? [...(fileConfig.maskSelectors || []), ...(options.mask || [])]
          : fileConfig.maskSelectors || [],
        injectCss: cliSet("injectCss") ? options.injectCss : fileConfig.injectCss,
        root: cliSet("root") ? options.root : fileConfig.root,
        outputDir: cliSet("output") ? options.output : fileConfig.outputDir || ".ui-level",
        refSpec: cliSet("refSpec") ? options.refSpec : fileConfig.refSpec,
        refImage: cliSet("refImage") ? options.refImage : fileConfig.refImage,
        ignoreHttpsErrors: cliSet("ignoreHttpsErrors")
          ? options.ignoreHttpsErrors
          : fileConfig.ignoreHttpsErrors,
        ...(mergedViewport ? { viewport: mergedViewport } : {}),
      };

      let result: DeltaPacket;

      if (options.daemon) {
        const cwd = process.cwd();
        const daemonPayload: Partial<UILevelConfig> = {
          ...mergedConfig,
          targetUrl: resolveLocalPathIfAny(mergedConfig.targetUrl, cwd),
          ref: resolveLocalPathIfAny(mergedConfig.ref, cwd),
          refSpec: resolveLocalPathIfAny(mergedConfig.refSpec, cwd),
          refImage: resolveLocalPathIfAny(mergedConfig.refImage, cwd),
          root: mergedConfig.root ? path.resolve(cwd, mergedConfig.root) : cwd,
          outputDir: path.resolve(cwd, mergedConfig.outputDir || ".ui-level"),
        };

        const ready = await ensureWarmDaemon();
        if (ready) {
          result = await sendDaemonRequest<DeltaPacket>(daemonPayload);
        } else {
          result = await check(mergedConfig);
        }
      } else {
        result = await check(mergedConfig);
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        renderHumanReport(result);
      }

      process.exit(result.status === "pass" ? 0 : 1);
    } catch (err: any) {
      console.error(`\x1b[31mError during check: ${err.message}\x1b[0m`);
      process.exit(2);
    }
  });

program
  .command("doctor")
  .description("Diagnose environment, browser availability, and image diff engines")
  .action(async () => {
    console.log("\n=== ui-level System Diagnostics ===\n");
    let hasError = false;

    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    if (nodeMajor >= 20) {
      console.log(`[PASS] Node.js runtime: ${process.version}`);
    } else {
      console.log(`[FAIL] Node.js version is ${process.version}. Requires Node 20+.`);
      hasError = true;
    }

    try {
      const browserPath = resolveBrowserExecutable();
      console.log(`[PASS] Chromium executable: ${browserPath}`);
      const b = await launchBrowser();
      console.log(`[PASS] Chromium instance launch verified (${b.version()})`);
      await b.close();
    } catch (err: any) {
      console.log(`[FAIL] Chromium not available: ${err.message}`);
      console.log("       Fix: run 'npx ui-level setup' or set UI_LEVEL_BROWSER_PATH");
      hasError = true;
    }

    try {
      const odiff = await import("odiff-bin");
      if (typeof odiff.compare === "function") {
        console.log("[PASS] odiff-bin SIMD accelerated diff engine operational");
      } else {
        console.log("[FAIL] odiff-bin compare export missing");
        hasError = true;
      }
    } catch (err: any) {
      console.log(`[FAIL] odiff-bin failed to load: ${err.message}`);
      hasError = true;
    }

    try {
      const sharp = (await import("sharp")).default;
      const v = sharp.versions;
      console.log(`[PASS] sharp raster processing operational (libvips ${v.vips})`);
    } catch (err: any) {
      console.log(`[FAIL] sharp failed: ${err.message}`);
      hasError = true;
    }

    try {
      const Color = (await import("colorjs.io")).default;
      const c1 = new Color("red");
      const c2 = new Color("blue");
      c1.deltaE(c2, "2000");
      console.log("[PASS] colorjs.io CIEDE2000 perceptual color engine operational");
    } catch (err: any) {
      console.log(`[FAIL] colorjs.io failed: ${err.message}`);
      hasError = true;
    }

    console.log("");
    if (hasError) {
      console.log("\x1b[31mDiagnostics found issues. Please fix reported items above.\x1b[0m\n");
      process.exit(2);
    } else {
      console.log("\x1b[32mAll systems operational. ui-level is ready for production.\x1b[0m\n");
      process.exit(0);
    }
  });

program
  .command("setup")
  .description("Install Chromium browser binaries for headless execution")
  .action(async () => {
    console.log("Installing Chromium via Playwright...");
    const { execSync } = await import("node:child_process");
    try {
      execSync("npx playwright-core install chromium", { stdio: "inherit" });
      console.log("\x1b[32mChromium installed successfully!\x1b[0m");
    } catch (err: any) {
      console.error(`Installation failed: ${err.message}`);
      process.exit(2);
    }
  });

program
  .command("mcp")
  .description("Start the stdio MCP server for agent integration")
  .action(async () => {
    await startMcpServer();
  });

program
  .command("daemon")
  .description("Manage the warm background daemon")
  .argument("[action]", "start, stop, or status", "status")
  .option("--foreground", "Keep daemon attached to the foreground process")
  .action(async (action, opts) => {
    const running = await isDaemonRunning();

    if (action === "status") {
      console.log(
        running
          ? `[RUNNING] Daemon is active at ${getDaemonSocketPath()}`
          : "[STOPPED] Daemon is not running."
      );
      process.exit(0);
    }

    if (action === "start") {
      if (running) {
        console.log(`Daemon is already running at ${getDaemonSocketPath()}`);
        process.exit(0);
      }

      if (opts.foreground) {
        await startDaemon(async (payload, browser) => {
          return check(payload, browser);
        });
        console.log(`Daemon listening at ${getDaemonSocketPath()}`);
        return; // Keep event loop alive until idle timeout or SIGINT/SIGTERM
      }

      const started = await ensureWarmDaemon();
      if (started) {
        console.log(`Daemon started at ${getDaemonSocketPath()}`);
        process.exit(0);
      } else {
        console.error("Failed to start background daemon.");
        process.exit(2);
      }
    }

    if (action === "stop") {
      const stopped = await stopDaemon();
      if (stopped) {
        console.log("Daemon stopped cleanly.");
      } else {
        console.log("No active daemon found.");
      }
      process.exit(0);
    }

    console.error(`Unknown daemon action '${action}'. Use start, stop, or status.`);
    process.exit(2);
  });

program
  .command("init")
  .description("Create a default ui-level.config.json template")
  .action(() => {
    const targetFile = "ui-level.config.json";
    if (fs.existsSync(targetFile)) {
      console.log(`${targetFile} already exists.`);
      process.exit(0);
    }
    const template: UILevelConfig = {
      targetUrl: "index.html",
      ref: "ref.html",
      adapter: "html",
      viewport: {
        width: 1280,
        height: 800,
        deviceScaleFactor: 2,
      },
      threshold: 0.05,
      colorThresholdDeltaE: 2.0,
      geometryTolerancePx: 0.5,
      subpixelTolerancePx: 1.0,
      selector: "body",
      maskSelectors: [],
      ignoreHttpsErrors: true,
      outputDir: ".ui-level",
    };
    fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), "utf-8");
    console.log(`\x1b[32mCreated ${targetFile}\x1b[0m`);
  });

function renderHumanReport(packet: DeltaPacket): void {
  const isPass = packet.status === "pass";
  const icon = isPass ? "✓" : "✗";
  const color = isPass ? "\x1b[32m" : "\x1b[31m";
  const reset = "\x1b[0m";

  console.log(`\n${color}===[ ui-level Visual & Style Gate: ${packet.status.toUpperCase()} ]===${reset}`);
  console.log(`Target:   ${packet.targetUrl}`);
  console.log(`Ref:      ${packet.refSource} (${packet.adapter})`);
  console.log(`Duration: ${packet.durationMs}ms\n`);

  if (packet.styleViolations.length > 0) {
    console.log(`\x1b[33mGate 1: Style Violations (${packet.styleViolations.length}):\x1b[0m`);
    for (const v of packet.styleViolations) {
      const unitSuffix = v.unit === "px" || v.unit === "dE00" ? v.unit : "";
      console.log(`  - \x1b[1m${v.selector}\x1b[0m -> ${v.property}`);
      console.log(
        `    Expected: ${v.expected}${unitSuffix} | Actual: ${v.actual}${unitSuffix} (Δ: ${v.delta})`
      );
      if (v.cssRuleSource?.file) {
        const loc = v.cssRuleSource.line
          ? v.cssRuleSource.column
            ? `${v.cssRuleSource.file}:${v.cssRuleSource.line}:${v.cssRuleSource.column}`
            : `${v.cssRuleSource.file}:${v.cssRuleSource.line}`
          : v.cssRuleSource.file;
        console.log(`    Source:   ${loc} (${v.cssRuleSource.selector || ""})`);
      }
      console.log(`    Fix:      \x1b[36m${v.fixHint}\x1b[0m`);
    }
    console.log("");
  }

  if (packet.geometryViolations.length > 0) {
    console.log(`\x1b[33mGate 1: Geometry Drift (${packet.geometryViolations.length}):\x1b[0m`);
    for (const g of packet.geometryViolations) {
      console.log(`  - \x1b[1m${g.selector}\x1b[0m`);
      console.log(`    Expected: ${g.expected.width}x${g.expected.height} @ (${g.expected.x}, ${g.expected.y})`);
      console.log(`    Actual:   ${g.actual.width}x${g.actual.height} @ (${g.actual.x}, ${g.actual.y})`);
      console.log(`    Fix:      \x1b[36m${g.fixHint}\x1b[0m`);
    }
    console.log("");
  }

  console.log(`Gate 2: Pixel Diff:`);
  console.log(`  Match:           ${packet.pixelDiff.match ? "YES" : "NO"}`);
  console.log(`  Diff Count:      ${packet.pixelDiff.diffCount} px (${packet.pixelDiff.diffPercentage}%)`);
  console.log(`  Dimension Drift: ${packet.pixelDiff.dimensionDrift ? "YES" : "NO"}`);
  if (packet.pixelDiff.tripletImagePath) {
    console.log(`  Triplet:         ${packet.pixelDiff.tripletImagePath}`);
  }

  console.log(`\n${color}${icon} ${packet.summary}${reset}\n`);
}

program.parse(process.argv);
