import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Browser } from "playwright-core";
import {
  convertFigwrightToNormalizedSpec,
  isFigwrightPayload,
  parseHexOrRgbColor,
} from "../src/adapters/figwright.converter.js";
import { isFigmaRestPayload } from "../src/adapters/figma-rest.normalizer.js";
import { processFigmaReference } from "../src/adapters/figma.adapter.js";
import { importReferenceSnapshot } from "../src/snapshot/manager.js";
import {
  compareTelemetryWithSpec,
  normalizeSelectorMapEntries,
} from "../src/browser/telemetry.js";
import { ConfigSchema, type NodeSpec } from "../src/schema.js";
import { launchBrowser } from "../src/browser/resolver.js";
import { check } from "../src/index.js";

describe("Adversarial Audit Remediation (A1–A11)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-level-audit-fixes-"));
  const fixturesDir = path.resolve(__dirname, "fixtures");
  const baseHtml = path.join(fixturesDir, "base.html");
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // A1: Double-counted absoluteBoundingBox coordinates on children & grandchildren
  it("A1: computes root-relative coordinates properly for nested absoluteBoundingBox nodes", () => {
    const raw = {
      nodes: [
        {
          id: "1:1",
          name: "Root",
          type: "FRAME",
          absoluteBoundingBox: { x: 100, y: 200, width: 300, height: 400 },
          children: [
            {
              id: "1:2",
              name: "Child",
              type: "FRAME",
              absoluteBoundingBox: { x: 120, y: 230, width: 200, height: 100 },
              children: [
                {
                  id: "1:3",
                  name: "Grandchild",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 135, y: 250, width: 50, height: 25 },
                },
              ],
            },
          ],
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(raw);
    expect(res.spec.nodes[0].rect).toEqual({ x: 0, y: 0, width: 300, height: 400 });
    expect(res.spec.nodes[1].rect).toEqual({ x: 20, y: 30, width: 200, height: 100 });
    expect(res.spec.nodes[2].rect).toEqual({ x: 35, y: 50, width: 50, height: 25 });
  });

  // A2: Figwright I-prefixed component instance IDs match cleanly in telemetry & selectorMap
  it("A2: matches I-prefixed Figwright instance node IDs between spec, live DOM, and selectorMap", () => {
    // 1. normalizeSelectorMapEntries canonicalizes I-prefixed IDs
    const pairs = normalizeSelectorMapEntries({
      "I100-2;200-3": "#instance-btn",
      "#other-btn": "I300-4",
    });
    expect(pairs).toEqual([
      { cssSelector: "#instance-btn", refId: "100:2;200:3" },
      { cssSelector: "#other-btn", refId: "300:4" },
    ]);

    // 2. compareTelemetryWithSpec matches live node (stripped I-prefix) to ref node (I-prefixed id)
    const refNodes: NodeSpec[] = [
      {
        id: "I100:2;200:3",
        figmaId: "I100:2;200:3",
        selector: '[data-figma-id="I100:2;200:3"]',
        tagName: "frame",
        rect: { x: 0, y: 0, width: 100, height: 40 },
        styles: { backgroundColor: "rgb(37, 99, 235)" },
      },
    ];
    const liveNodes: NodeSpec[] = [
      {
        id: "btn",
        figmaId: "100:2;200:3", // extracted from data-figma-id="I100:2;200:3"
        selector: "#btn",
        tagName: "button",
        rect: { x: 0, y: 0, width: 100, height: 40 },
        styles: { backgroundColor: "rgb(220, 38, 38)" },
      },
    ];

    const config = ConfigSchema.parse({});
    const { styleViolations } = compareTelemetryWithSpec(liveNodes, refNodes, config);
    const bgViolation = styleViolations.find((v) => v.property === "backgroundColor");
    expect(bgViolation).toBeDefined();
    expect(bgViolation?.selector).toBe("#btn");
  });

  // A3: CLI check --ref-spec without --adapter figma auto-infers figma adapter (F5b via CLI)
  it("A3: CLI check auto-infers figma adapter when --ref-spec is provided without --adapter", async () => {
    const cliPath = path.resolve(__dirname, "../dist/cli.js");
    const runDir = path.join(tmpDir, "cli-infer-figma");
    fs.mkdirSync(runDir, { recursive: true });

    const refPng = path.join(runDir, "ref.png");
    await sharp({ create: { width: 354, height: 134, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(refPng);

    const specPath = path.join(fixturesDir, "figwright-context.json");
    let stdout = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [
          cliPath,
          "check",
          "--target",
          baseHtml,
          "--ref-spec",
          specPath,
          "--ref-image",
          refPng,
          "--selector",
          "#test-card",
          "--output",
          path.join(runDir, "out"),
          "--root",
          fixturesDir,
          "--json",
        ],
        { encoding: "utf-8" }
      );
    } catch (err: any) {
      // Exit code 1 (visual fail) is fine; exit code 2 (adapter error) is a bug!
      expect(err.status).not.toBe(2);
      stdout = err.stdout;
    }

    const packet = JSON.parse(stdout);
    expect(packet.adapter).toBe("figma");
  });

  // A4: Failed snapshot import must NOT leave an empty ghost directory blocking retry
  it("A4: failed importReferenceSnapshot does not leave a ghost directory blocking retries", async () => {
    const baseDir = path.join(tmpDir, "atomic-refs");
    const badSpecPath = path.join(fixturesDir, "figwright-section-plan.json");
    const goodSpecPath = path.join(fixturesDir, "figwright-context.json");
    const imgPath = path.join(tmpDir, "atomic-img.png");
    await sharp({ create: { width: 354, height: 134, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(imgPath);

    // 1. First import fails due to sectionPlan guardrail
    await expect(
      importReferenceSnapshot({
        slug: "atomic-card",
        specPath: badSpecPath,
        imagePath: imgPath,
        baseDir,
      })
    ).rejects.toThrow(/sectionPlan/);

    // Directory should NOT exist after failed import
    expect(fs.existsSync(path.join(baseDir, "atomic-card"))).toBe(false);

    // 2. Retrying with valid spec WITHOUT force MUST succeed
    const res = await importReferenceSnapshot({
      slug: "atomic-card",
      specPath: goodSpecPath,
      imagePath: imgPath,
      baseDir,
    });
    expect(res.manifest.slug).toBe("atomic-card");
  });

  // A5: Offline Figma mode converts non-PNG --ref-image (JPEG) to valid PNG
  it("A5: processFigmaReference converts JPEG offline --ref-image to valid PNG", async () => {
    const jpegPath = path.join(tmpDir, "offline-ref.jpg");
    await sharp({ create: { width: 354, height: 134, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toFile(jpegPath);

    const outDir = path.join(tmpDir, "offline-jpeg-out");
    const config = ConfigSchema.parse({
      adapter: "figma",
      refSpec: path.join(fixturesDir, "figwright-context.json"),
      refImage: jpegPath,
    });

    const result = await processFigmaReference(config, outDir);
    const meta = await sharp(result.refScreenshotPath).metadata();
    expect(meta.format).toBe("png");
  });

  // A6: Wrapped Figma REST array payload is classified as Figma REST, not Figwright
  it("A6: classifies wrapped Figma REST array payloads as Figma REST instead of Figwright", async () => {
    const wrappedRest = {
      nodes: [
        {
          id: "1:1",
          name: "Card",
          type: "FRAME",
          absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 100 },
        },
      ],
    };

    expect(isFigmaRestPayload(wrappedRest)).toBe(true);
    expect(isFigwrightPayload(wrappedRest)).toBe(false);

    const specFile = path.join(tmpDir, "wrapped-rest.json");
    const imgFile = path.join(tmpDir, "wrapped-rest.png");
    fs.writeFileSync(specFile, JSON.stringify(wrappedRest));
    await sharp({ create: { width: 200, height: 100, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(imgFile);

    const imported = await importReferenceSnapshot({
      slug: "wrapped-rest-card",
      specPath: specFile,
      imagePath: imgFile,
      baseDir: path.join(tmpDir, "rest-refs"),
    });
    expect(imported.manifest.source).toBe("figma-rest");
  });

  // A7: Leading whitespace before dot in slug is rejected
  it("A7: rejects snapshot slugs with leading whitespace before a dot", async () => {
    const imgPath = path.join(tmpDir, "slug-img.png");
    await sharp({ create: { width: 10, height: 10, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(imgPath);

    await expect(
      importReferenceSnapshot({
        slug: "   .hidden-slug",
        specPath: path.join(fixturesDir, "figwright-context.json"),
        imagePath: imgPath,
        baseDir: path.join(tmpDir, "slug-refs"),
      })
    ).rejects.toThrow(/Invalid snapshot slug/);
  });

  // A8: DPR inference warns when height ratio disagrees sharply with width ratio
  it("A8: warns when image height ratio disagrees with width-inferred DPR", async () => {
    const specFile = path.join(tmpDir, "aspect-spec.json");
    const imgFile = path.join(tmpDir, "aspect-img.png");
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        adapter: "figma",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        nodes: [
          {
            id: "1:1",
            selector: "#card",
            rect: { x: 0, y: 0, width: 200, height: 100 },
            styles: {},
          },
        ],
      })
    );
    // Width matches 2x (400/200 = 2.0), but height is cropped to 0.5x (50/100 = 0.5)!
    await sharp({ create: { width: 400, height: 50, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(imgFile);

    const imported = await importReferenceSnapshot({
      slug: "cropped-aspect",
      specPath: specFile,
      imagePath: imgFile,
      baseDir: path.join(tmpDir, "aspect-refs"),
    });
    expect(
      imported.manifest.warnings.some((w) => /height|aspect/i.test(w))
    ).toBe(true);
  });

  // A9: selectorMap shadowing — broad selector before specific selector does not shadow second element
  it("A9: resolves shadowed selectorMap entries in both Tier 0a and Tier 0b", async () => {
    const htmlPath = path.join(tmpDir, "shadowing.html");
    fs.writeFileSync(
      htmlPath,
      `<!DOCTYPE html><html><body>
        <div id="wrap">
          <button class="btn" id="primary-btn" style="background:#2563eb;width:80px;height:36px;">One</button>
          <button class="btn" id="secondary-btn" style="background:#dc2626;width:80px;height:36px;">Two</button>
        </div>
      </body></html>`,
      "utf-8"
    );

    const refSpecPath = path.join(tmpDir, "shadowing-spec.json");
    const refImgPath = path.join(tmpDir, "shadowing-ref.png");
    fs.writeFileSync(
      refSpecPath,
      JSON.stringify({
        adapter: "figma",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        nodes: [
          { id: "1:1", selector: "#wrap", rect: { x: 0, y: 0, width: 200, height: 40 }, styles: {} },
          {
            id: "1:2",
            figmaId: "1:2",
            selector: '[data-figma-id="1:2"]',
            rect: { x: 0, y: 0, width: 80, height: 36 },
            styles: { backgroundColor: "rgb(37, 99, 235)" },
          },
          {
            id: "1:3",
            figmaId: "1:3",
            selector: '[data-figma-id="1:3"]',
            rect: { x: 80, y: 0, width: 80, height: 36 },
            styles: { backgroundColor: "rgb(16, 185, 129)" },
          },
        ],
      })
    );
    await sharp({ create: { width: 200, height: 40, channels: 4, background: "#ffffff" } })
      .png()
      .toFile(refImgPath);

    // Broad ".btn" listed BEFORE specific "#secondary-btn"
    const res = await check(
      {
        targetUrl: htmlPath,
        adapter: "figma",
        refSpec: refSpecPath,
        refImage: refImgPath,
        selector: "#wrap",
        selectorMap: {
          ".btn": "1:2",
          "#secondary-btn": "1:3",
        },
        outputDir: path.join(tmpDir, "shadowing-out"),
      },
      browser
    );

    // #secondary-btn (red) MUST match 1:3 (green) and report backgroundColor violation
    const secViolation = res.styleViolations.find(
      (v) => v.selector === "#secondary-btn" && v.property === "backgroundColor"
    );
    expect(secViolation).toBeDefined();
    expect(secViolation?.unit).toBe("dE00");
    expect(Number(secViolation?.delta)).toBeGreaterThan(2);

    // Also test Tier 0b shadowing directly (no mappedRefIds; reverse selectorMap has multiple entries for same live node, first already used)
    const tier0bRefNodes: NodeSpec[] = [
      {
        id: "1:2",
        figmaId: "1:2",
        selector: '[data-figma-id="1:2"]',
        rect: { x: 0, y: 0, width: 80, height: 36 },
        styles: { backgroundColor: "rgb(37, 99, 235)" },
      },
      {
        id: "1:3",
        figmaId: "1:3",
        selector: '[data-figma-id="1:3"]',
        rect: { x: 80, y: 0, width: 80, height: 36 },
        styles: { backgroundColor: "rgb(16, 185, 129)" },
      },
    ];
    const tier0bLiveNodes: NodeSpec[] = [
      {
        id: "btn-first",
        figmaId: "1:2",
        selector: "#btn-first",
        rect: { x: 0, y: 0, width: 80, height: 36 },
        styles: { backgroundColor: "rgb(37, 99, 235)" },
      },
      {
        id: "btn-second",
        selector: "#btn-second",
        rect: { x: 80, y: 0, width: 80, height: 36 },
        styles: { backgroundColor: "rgb(220, 38, 38)" },
      },
    ];
    const tier0bRes = compareTelemetryWithSpec(
      tier0bLiveNodes,
      tier0bRefNodes,
      ConfigSchema.parse({
        selectorMap: {
          "1:2": "#btn-second", // already used by #btn-first!
          "1:3": "#btn-second", // should fall through to this unused ref
        },
      })
    );
    expect(
      tier0bRes.styleViolations.some(
        (v) => v.selector === "#btn-second" && v.property === "backgroundColor"
      )
    ).toBe(true);
  });

  // A10: MCP level_import_snapshot advertises force, figma, and figwright in ListTools
  it("A10: MCP server advertises force, figma, and figwright properties on level_import_snapshot", async () => {
    const cliPath = path.resolve(__dirname, "../dist/cli.js");
    const transport = new StdioClientTransport({
      command: "node",
      args: [cliPath, "mcp"],
    });
    const client = new Client({ name: "audit-mcp-test", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const importTool = listed.tools.find((t) => t.name === "level_import_snapshot");
      expect(importTool).toBeDefined();
      const props = (importTool?.inputSchema as any)?.properties || {};
      expect(props.force).toBeDefined();
      expect(props.figma).toBeDefined();
      expect(props.figwright).toBeDefined();
    } finally {
      await client.close();
    }
  });

  // A11: CLI check --json outputs valid JSON on error & parseHexOrRgbColor rejects malformed alpha
  it("A11: CLI check --json emits valid JSON on error and parseHexOrRgbColor rejects malformed alpha", () => {
    expect(parseHexOrRgbColor("rgba(10, 20, 30, ...)")).toBeUndefined();

    const cliPath = path.resolve(__dirname, "../dist/cli.js");
    let caught = false;
    try {
      execFileSync(
        process.execPath,
        [cliPath, "check", "--target", path.join(tmpDir, "does-not-exist.html"), "--json"],
        { encoding: "utf-8" }
      );
    } catch (err: any) {
      caught = true;
      expect(err.status).toBe(2);
      const parsed = JSON.parse(err.stdout);
      expect(parsed.status).toBe("error");
      expect(parsed.error).toContain("not found");
    }
    expect(caught).toBe(true);
  });
});
