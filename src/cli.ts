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
import {
  importReferenceSnapshot,
  loadReferenceSnapshot,
} from "./snapshot/manager.js";
import { z } from "zod";
import type { DeltaPacket, UILevelConfig, UserUILevelConfig } from "./schema.js";

const program = new Command();

const SelectorMapSchema = z.record(z.string(), z.string());

function parseSelectorMapArg(val?: string): Record<string, string> | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  let parsed: unknown;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: any) {
      throw new Error(`Invalid JSON passed to --selector-map: ${err.message}`);
    }
  } else {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) {
      try {
        parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
      } catch (err: any) {
        throw new Error(`Failed to read selectorMap file '${trimmed}': ${err.message}`);
      }
    } else {
      throw new Error(`--selector-map file not found or invalid JSON: ${trimmed}`);
    }
  }

  const result = SelectorMapSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `--selector-map must be an object of { [selector]: string }: ${result.error.message}`
    );
  }
  return result.data;
}

function isRemoteOrFigmaId(val?: string): boolean {
  if (!val) return true;
  if (val.startsWith("http://") || val.startsWith("https://") || val.startsWith("data:")) return true;
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
  .version("1.2.0");

program
  .command("check")
  .description("Run visual & CSS regression check between target and reference")
  .option("-t, --target <url|file>", "Target URL or local HTML file")
  .option("-r, --ref <url|file|key|dir>", "Reference HTML, image, Figma node/URL, or snapshot directory")
  .option("-a, --adapter <type>", "Adapter type: html, figma, image")
  .option("-s, --selector <css>", "CSS selector to inspect")
  .option("--ref-selector <css>", "CSS selector in reference HTML (defaults to --selector)")
  .option("--threshold <number>", "Pixel diff threshold (0.0 to 1.0)", parseFloat)
  .option("--viewport <WxH>", "Viewport size, e.g. 1280x800")
  .option("--dpr <number>", "Device scale factor (e.g. 1 or 2)", parseFloat)
  .option("-c, --config <path>", "Path to ui-level.config.json")
  .option("--selector-map <jsonOrFile>", "Explicit mapping between selectors and Figma IDs")
  .option("--skip-integrity", "Skip SHA-256 integrity verification for reference snapshots")
  .option("--mask <selectors...>", "Selectors to mask from pixel diff")
  .option("--inject-css <css>", "Custom CSS to inject into target page")
  .option("--root <dir>", "Project root directory")
  .option("--output <dir>", "Output directory for screenshots and triplet", undefined)
  .option("--ref-spec <path>", "Offline reference spec JSON path (Figma MCP)")
  .option("--ref-image <path>", "Offline reference PNG image path (Figma MCP)")
  .option("--ignore-https-errors", "Ignore HTTPS certificate errors")
  .option("--no-ignore-https-errors", "Enforce strict HTTPS certificates")
  .option("--auto-noise-mask", "Triple-shot noise masking to ignore animated/moving elements")
  .option("--common-area", "Compare overlapping common area min(w1, w2) x min(h1, h2)")
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

      if (cliSet("dpr") && (Number.isNaN(options.dpr) || options.dpr <= 0)) {
        throw new Error(`Invalid --dpr value. Expected a positive number (e.g. 1 or 2).`);
      }

      const hasExplicitDpr = cliSet("dpr") || fileConfig.viewport?.deviceScaleFactor !== undefined;

      const mergedViewport =
        options.viewport || cliSet("dpr")
          ? {
              ...(hasExplicitDpr
                ? {
                    deviceScaleFactor: cliSet("dpr")
                      ? options.dpr
                      : fileConfig.viewport?.deviceScaleFactor,
                  }
                : {}),
              width: fileConfig.viewport?.width ?? 1280,
              height: fileConfig.viewport?.height ?? 800,
              ...(options.viewport ? parseViewportFlag(options.viewport) : {}),
            }
          : fileConfig.viewport;

      const cliSelectorMap = options.selectorMap
        ? parseSelectorMapArg(options.selectorMap)
        : undefined;

      const mergedConfig: UserUILevelConfig = {
        ...fileConfig,
        targetUrl: cliSet("target") ? options.target : fileConfig.targetUrl || "index.html",
        ref: cliSet("ref") ? options.ref : fileConfig.ref,
        ...(cliSet("adapter")
          ? { adapter: options.adapter as any }
          : fileConfig.adapter
            ? { adapter: fileConfig.adapter }
            : {}),
        selector: cliSet("selector") ? options.selector : fileConfig.selector || "body",
        refSelector: cliSet("refSelector") ? options.refSelector : fileConfig.refSelector,
        selectorMap: cliSelectorMap || fileConfig.selectorMap,
        skipIntegrityCheck: cliSet("skipIntegrity")
          ? options.skipIntegrity
          : fileConfig.skipIntegrityCheck ?? false,
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
        autoNoiseMask: cliSet("autoNoiseMask")
          ? options.autoNoiseMask
          : fileConfig.autoNoiseMask ?? false,
        commonArea: cliSet("commonArea")
          ? options.commonArea
          : fileConfig.commonArea ?? false,
        ...(mergedViewport ? { viewport: mergedViewport } : {}),
      };

      let result: DeltaPacket;

      if (options.daemon) {
        const cwd = process.cwd();
        const daemonPayload: UserUILevelConfig = {
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
      if (options.json) {
        console.log(JSON.stringify({ status: "error", error: err.message }, null, 2));
      } else {
        console.error(`\x1b[31mError during check: ${err.message}\x1b[0m`);
      }
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
      skipIntegrityCheck: false,
      outputDir: ".ui-level",
      autoNoiseMask: false,
      commonArea: false,
      noiseThreshold: 24,
    };
    fs.writeFileSync(targetFile, JSON.stringify(template, null, 2), "utf-8");
    console.log(`\x1b[32mCreated ${targetFile}\x1b[0m`);
  });

const snapshotCmd = program
  .command("snapshot")
  .description("Manage immutable reference snapshot bundles");

snapshotCmd
  .command("import")
  .description("Import and freeze an immutable reference snapshot from spec & image")
  .requiredOption("--slug <slug>", "Unique slug for the reference component")
  .requiredOption("--spec <path>", "Path to reference spec JSON (Figwright or Figma REST)")
  .requiredOption("--image <path>", "Path to reference image PNG/JPG")
  .option("--out <dir>", "Base directory for references", ".ui-level/references")
  .option("--dpr <number>", "Device scale factor override (e.g. 1 or 2)", parseFloat)
  .option("--selector-map <jsonOrFile>", "Optional selectorMap for component matching")
  .option("--figma-file <key>", "Figma file key")
  .option("--figma-name <name>", "Figma file name")
  .option("--node-id <id>", "Figma node ID")
  .option("--node-name <name>", "Figma node name")
  .option("--revision <rev>", "Figma file revision / version")
  .option("--figwright-version <ver>", "Figwright version")
  .option("--plugin-version <ver>", "Figwright plugin version")
  .option("--detail <detail>", "Figwright detail level ('minimal' | 'compact' | 'full')")
  .option("--force", "Overwrite existing reference snapshot with same slug")
  .option("--json", "Output result as JSON")
  .action(async (options) => {
    try {
      if (options.dpr !== undefined && (Number.isNaN(options.dpr) || options.dpr <= 0)) {
        throw new Error(`Invalid --dpr value. Expected a positive number (e.g. 1 or 2).`);
      }
      const selectorMap = options.selectorMap ? parseSelectorMapArg(options.selectorMap) : undefined;
      const figmaOpts =
        options.figmaFile || options.figmaName || options.nodeId || options.nodeName || options.revision
          ? {
              fileKey: options.figmaFile,
              fileName: options.figmaName,
              nodeId: options.nodeId,
              nodeName: options.nodeName,
              revision: options.revision,
            }
          : undefined;

      const figwrightOpts =
        options.figwrightVersion || options.pluginVersion || options.detail
          ? {
              serverVersion: options.figwrightVersion,
              pluginVersion: options.pluginVersion,
              detail: options.detail,
            }
          : undefined;

      const res = await importReferenceSnapshot({
        slug: options.slug,
        specPath: options.spec,
        imagePath: options.image,
        baseDir: options.out,
        dpr: options.dpr,
        force: options.force,
        selectorMap,
        figma: figmaOpts,
        figwright: figwrightOpts,
      });

      if (options.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`\x1b[32mSuccessfully imported reference snapshot '${options.slug}'\x1b[0m`);
        console.log(`Location:   ${res.snapshotDir}`);
        console.log(`Source:     ${res.manifest.source}`);
        console.log(`Dimensions: ${res.manifest.image.width}x${res.manifest.image.height} @ DPR ${res.manifest.image.deviceScaleFactor}`);
        console.log(
          `SHA-256:    spec=${res.manifest.hashes.specSha256.slice(0, 12)}... image=${res.manifest.hashes.imageSha256.slice(0, 12)}...`
        );
        if (res.manifest.warnings && res.manifest.warnings.length > 0) {
          console.log("\n\x1b[33mWarnings:\x1b[0m");
          for (const w of res.manifest.warnings) {
            console.log(`  ! ${w}`);
          }
        }
      }
      process.exit(0);
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ success: false, error: err.message }, null, 2));
      } else {
        console.error(`\x1b[31mSnapshot import failed: ${err.message}\x1b[0m`);
      }
      process.exit(2);
    }
  });

snapshotCmd
  .command("verify")
  .description("Verify integrity of a reference snapshot directory against its manifest")
  .argument("<dir>", "Path to snapshot directory")
  .option("--json", "Output result as JSON")
  .action((dir, options) => {
    try {
      const loaded = loadReferenceSnapshot(dir);
      if (options.json) {
        console.log(
          JSON.stringify(
            { valid: true, manifest: loaded.manifest, warnings: loaded.warnings },
            null,
            2
          )
        );
      } else {
        console.log(`\x1b[32mSnapshot integrity verified: ${dir}\x1b[0m`);
        if (loaded.manifest) {
          console.log(`Slug:       ${loaded.manifest.slug}`);
          console.log(`Source:     ${loaded.manifest.source}`);
          console.log(`Dimensions: ${loaded.manifest.image.width}x${loaded.manifest.image.height}`);
        }
        if (loaded.warnings.length > 0) {
          console.log("\n\x1b[33mWarnings:\x1b[0m");
          for (const w of loaded.warnings) {
            console.log(`  ! ${w}`);
          }
        }
      }
      process.exit(0);
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({ valid: false, error: err.message }, null, 2));
      } else {
        console.error(`\x1b[31mVerification failed: ${err.message}\x1b[0m`);
      }
      process.exit(2);
    }
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

  if (packet.warnings && packet.warnings.length > 0) {
    console.log(`\x1b[33mWarnings (${packet.warnings.length}):\x1b[0m`);
    for (const w of packet.warnings) {
      console.log(`  ! \x1b[33m${w}\x1b[0m`);
    }
    console.log("");
  }

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
  if (packet.pixelDiff.layoutSimilarity !== undefined) {
    const layoutPct = (packet.pixelDiff.layoutSimilarity * 100).toFixed(1);
    const detailPct = ((packet.pixelDiff.perceptualSimilarity ?? 0) * 100).toFixed(1);
    console.log(`  Layout Alike:    ${layoutPct}%`);
    console.log(`  Detail (SSIM):   ${detailPct}%`);
  }
  if (packet.pixelDiff.noiseTiles !== undefined && packet.pixelDiff.noiseTiles > 0) {
    console.log(`  Noise Mask:      ${packet.pixelDiff.noiseTiles} animated tile(s) ignored`);
  }
  if (packet.pixelDiff.commonAreaApplied) {
    console.log(`  Common Area:     min(w1, w2) × min(h1, h2) evaluated`);
  }
  if (packet.structureLikeness) {
    console.log(`  Structure:       ${packet.structureLikeness.note}`);
  }
  if (packet.pixelDiff.tripletImagePath) {
    console.log(`  Triplet:         ${packet.pixelDiff.tripletImagePath}`);
  }
  if (packet.pixelDiff.regions && packet.pixelDiff.regions.length > 0) {
    console.log(`\n\x1b[33mGate 2: Diff Hotspots (${packet.pixelDiff.regions.length}):\x1b[0m`);
    for (const r of packet.pixelDiff.regions) {
      const selList = r.overlappingSelectors.length > 0 ? r.overlappingSelectors.join(", ") : "unknown";
      const colorInfo =
        r.refColor && r.liveColor
          ? ` | Ref: ${r.refColor} vs Live: ${r.liveColor} (ΔE00=${r.deltaE ?? "?"})`
          : "";
      console.log(
        `  - [${r.x}, ${r.y}, ${r.width}x${r.height} CSS px] (${r.pixelCount} px) -> ${selList}${colorInfo}`
      );
    }
  }

  console.log(`\n${color}${icon} ${packet.summary}${reset}\n`);
}

program.parse(process.argv);
