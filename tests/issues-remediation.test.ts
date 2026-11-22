import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {
  convertFigwrightToNormalizedSpec,
} from "../src/adapters/figwright.converter.js";
import {
  isSnapshotDirectory,
  importReferenceSnapshot,
  loadReferenceSnapshot,
} from "../src/snapshot/manager.js";
import { normalizeFigmaId } from "../src/browser/telemetry.js";
import { NormalizedSpecSchema } from "../src/schema.js";
import { processFigmaReference } from "../src/adapters/figma.adapter.js";
import { McpImportSnapshotSchema } from "../src/mcp/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

describe("TDD Remediation for ISSUES.md (BUG-001 through BUG-016)", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "ui-level-issues-test-"));

  // BUG-001: Empty specs produce green runs
  it("BUG-001: rejects empty specs and throws instead of passing silently", () => {
    expect(() =>
      NormalizedSpecSchema.parse({
        adapter: "figma",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        nodes: [],
      })
    ).toThrow(/at least one node/i);

    expect(() =>
      convertFigwrightToNormalizedSpec({
        formatVersion: 13,
        context: { nodes: [] },
      })
    ).toThrow(/zero renderable nodes|empty/i);
  });

  // BUG-002: Figwright converter ignores absoluteBoundingBox
  it("BUG-002: extracts geometry from absoluteBoundingBox in Figwright converter", () => {
    const rawFigmaNode = {
      nodes: [
        {
          id: "1:1",
          name: "Card",
          type: "FRAME",
          absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 100 },
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(rawFigmaNode);
    expect(res.spec.nodes.length).toBe(1);
    expect(res.spec.nodes[0].rect).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  // BUG-005: "Immutable" snapshots can be silently overwritten
  it("BUG-005: refuses to overwrite an existing snapshot unless force is true", async () => {
    const specFile = path.join(tmpBase, "spec.json");
    const imgFile = path.join(tmpBase, "img.png");
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        adapter: "figma",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        nodes: [{ id: "1:1", selector: "#card", rect: { x: 0, y: 0, width: 100, height: 50 }, styles: {} }],
      })
    );
    await sharp({ create: { width: 100, height: 50, channels: 4, background: "#fff" } })
      .png()
      .toFile(imgFile);

    const snapshotBase = path.join(tmpBase, "refs-immutability");

    await importReferenceSnapshot({
      slug: "immutable-test",
      specPath: specFile,
      imagePath: imgFile,
      baseDir: snapshotBase,
    });

    // Re-importing same slug without force MUST reject
    await expect(
      importReferenceSnapshot({
        slug: "immutable-test",
        specPath: specFile,
        imagePath: imgFile,
        baseDir: snapshotBase,
      })
    ).rejects.toThrow(/already exists.*--force/i);

    // Re-importing with force: true succeeds
    const forced = await importReferenceSnapshot({
      slug: "immutable-test",
      specPath: specFile,
      imagePath: imgFile,
      baseDir: snapshotBase,
      force: true,
    });
    expect(forced.manifest.slug).toBe("immutable-test");
  });

  // BUG-006: Snapshot auto-detection is too permissive
  it("BUG-006: requires manifest.json or reference.json+reference.png for snapshot directory detection", () => {
    const randomDir = path.join(tmpBase, "random-folder");
    fs.mkdirSync(randomDir, { recursive: true });
    fs.writeFileSync(path.join(randomDir, "data.json"), "{}");
    fs.writeFileSync(path.join(randomDir, "avatar.png"), "dummy");

    // Random json + png should NOT be considered a snapshot directory
    expect(isSnapshotDirectory(randomDir)).toBe(false);

    // Canonical reference.json + reference.png should be detected
    const canonicalDir = path.join(tmpBase, "canonical-folder");
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, "reference.json"), "{}");
    fs.writeFileSync(path.join(canonicalDir, "reference.png"), "dummy");
    expect(isSnapshotDirectory(canonicalDir)).toBe(true);
  });

  // BUG-007: Loaded specs are not validated
  it("BUG-007: validates loaded reference.json against NormalizedSpecSchema and rejects malformed specs", () => {
    const badDir = path.join(tmpBase, "bad-spec-dir");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        slug: "bad-spec",
        source: "normalized",
        exportedAt: new Date().toISOString(),
        image: { file: "reference.png", width: 100, height: 50, deviceScaleFactor: 2 },
        specFile: "reference.json",
        hashes: {
          specSha256: "0".repeat(64),
          imageSha256: "0".repeat(64),
        },
      })
    );
    // Invalid spec (missing nodes, wrong adapter)
    fs.writeFileSync(path.join(badDir, "reference.json"), JSON.stringify({ broken: true }));
    fs.writeFileSync(path.join(badDir, "reference.png"), "dummy");

    expect(() => loadReferenceSnapshot(badDir, { skipIntegrityCheck: true })).toThrow(
      /invalid spec|normalizedspec/i
    );
  });

  // BUG-008: Figma ID normalization corrupts non-Figma IDs
  it("BUG-008: preserves non-Figma IDs (card-1) and canonicalizes Figwright I-prefix (I100:2)", () => {
    // Non-Figma hyphenated IDs should NOT be converted to colons
    expect(normalizeFigmaId("card-1")).toBe("card-1");
    expect(normalizeFigmaId("submit-button")).toBe("submit-button");

    // Standard Figma IDs with hyphens convert to colons
    expect(normalizeFigmaId("100-2")).toBe("100:2");
    expect(normalizeFigmaId("100:2")).toBe("100:2");

    // Figwright I-prefixed instance node IDs canonicalize to unprefixed
    expect(normalizeFigmaId("I100:2")).toBe("100:2");
    expect(normalizeFigmaId("I100-2")).toBe("100:2");
  });

  // BUG-009: DPR inference falls back to 2 silently
  it("BUG-009: emits warning when DPR ratio cannot be reliably determined", async () => {
    const specFile = path.join(tmpBase, "dpr-spec.json");
    const imgFile = path.join(tmpBase, "dpr-img.png");
    fs.writeFileSync(
      specFile,
      JSON.stringify({
        adapter: "figma",
        viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        nodes: [{ id: "1:1", selector: "#card", rect: { x: 0, y: 0, width: 200, height: 100 }, styles: {} }],
      })
    );
    // 330px width on 200px node = 1.65 ratio (ambiguous, not near 1, 2, or 3)
    await sharp({ create: { width: 330, height: 165, channels: 4, background: "#fff" } })
      .png()
      .toFile(imgFile);

    const imported = await importReferenceSnapshot({
      slug: "dpr-warn-test",
      specPath: specFile,
      imagePath: imgFile,
      baseDir: path.join(tmpBase, "refs-dpr"),
    });

    expect(imported.manifest.warnings.some((w) => w.includes("DPR") || w.includes("ratio"))).toBe(
      true
    );
  });

  // BUG-010: AUTO units and unsupported paints
  it("BUG-010: emits warnings for unsupported paint types in Figwright converter", () => {
    const raw = {
      nodes: [
        {
          id: "1:1",
          type: "FRAME",
          width: 100,
          height: 100,
          fills: [
            {
              type: "GRADIENT_LINEAR",
              visible: true,
            },
          ],
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(raw);
    expect(res.warnings.some((w) => w.includes("GRADIENT_LINEAR") || w.includes("unsupported"))).toBe(true);
  });

  // BUG-010 (extension): AUTO units for lineHeight and letterSpacing
  it("BUG-010 (extension): resolves AUTO lineHeight and letterSpacing instead of silently ignoring", () => {
    const raw = {
      nodes: [
        {
          id: "t1",
          name: "Heading",
          type: "TEXT",
          width: 100,
          height: 40,
          fontSize: 20,
          lineHeight: { unit: "AUTO" },
          letterSpacing: { unit: "AUTO" },
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(raw);
    expect(res.spec.nodes[0].styles.lineHeight).toBe(24); // 20 * 1.2
    expect(res.spec.nodes[0].styles.letterSpacing).toBe(0);
  });

  // NEW-001: Image-only Figma mode produces vacuous pass
  it("NEW-001: processFigmaReference rejects image-only offline mode without reference spec", async () => {
    const dummyImg = path.join(tmpBase, "new001-ref.png");
    await sharp({ create: { width: 100, height: 50, channels: 4, background: "#fff" } })
      .png()
      .toFile(dummyImg);

    await expect(
      processFigmaReference(
        {
          adapter: "figma",
          targetUrl: "http://localhost:3000",
          refImage: dummyImg,
          selector: "#card",
          viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
        } as any,
        path.join(tmpBase, "out-new001")
      )
    ).rejects.toThrow(/requires.*spec|spec.*required|cannot be empty/i);
  });

  // NEW-002: Unsupported paint warning reports child node id instead of rootNodeId
  it("NEW-002: reports child node ID in unsupported paint warning", () => {
    const raw = {
      nodes: [
        {
          id: "root-frame-1",
          name: "Root",
          type: "FRAME",
          width: 300,
          height: 300,
          children: [
            {
              id: "child-btn-42",
              name: "Button",
              type: "RECTANGLE",
              width: 100,
              height: 40,
              fills: [{ type: "GRADIENT_RADIAL", visible: true }],
            },
          ],
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(raw);
    expect(res.warnings.some((w) => w.includes("child-btn-42"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("root-frame-1"))).toBe(false);
  });

  // BUG-011: Constrain MCP baseDir to project root
  it("BUG-011: McpImportSnapshotSchema rejects baseDir that escapes the project root", () => {
    expect(() =>
      McpImportSnapshotSchema.parse({
        slug: "test-slug",
        specPath: "some/spec.json",
        imagePath: "some/img.png",
        baseDir: "/etc/cron.d",
      })
    ).toThrow(/project root/i);

    expect(() =>
      McpImportSnapshotSchema.parse({
        slug: "test-slug",
        specPath: "some/spec.json",
        imagePath: "some/img.png",
        baseDir: "../../outside-project",
      })
    ).toThrow(/project root/i);
  });

  // IDEA-13: MCP stdio smoke test
  it("IDEA-13: connects to MCP server over stdio, lists tools, and executes level_doctor", async () => {
    const cliPath = path.resolve(__dirname, "../dist/cli.js");
    const transport = new StdioClientTransport({
      command: "node",
      args: [cliPath, "mcp"],
    });
    const client = new Client({ name: "ui-level-smoke", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((t) => t.name);
      expect(toolNames).toContain("level_check");
      expect(toolNames).toContain("level_import_snapshot");
      expect(toolNames).toContain("level_doctor");

      const doctorRes: any = await client.callTool({ name: "level_doctor", arguments: {} });
      expect(doctorRes.isError).toBeFalsy();
      const parsed = JSON.parse(doctorRes.content[0].text);
      expect(parsed.status).toBe("ok");
    } finally {
      await client.close();
    }
  });

  // NEW-003: Clean up temporary directories in afterAll
  afterAll(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });
});
