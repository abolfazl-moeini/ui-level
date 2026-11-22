import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isNormalizedSpec,
  isFigwrightPayload,
  parseHexOrRgbColor,
  mapFontStyleToWeight,
  convertFigwrightToNormalizedSpec,
} from "../src/adapters/figwright.converter.js";
import {
  isFigmaRestPayload,
  convertFigmaRestToNormalizedSpec,
} from "../src/adapters/figma-rest.normalizer.js";

describe("Figwright pure schema converter & normalizer", () => {
  const fixturesDir = path.resolve(__dirname, "fixtures");

  it("discriminates NormalizedSpec vs Figwright payloads vs invalid payloads", () => {
    const normalizedSpec = {
      adapter: "figma",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      nodes: [
        {
          id: "1:1",
          selector: '[data-figma-id="1:1"]',
          rect: { x: 0, y: 0, width: 100, height: 50 },
          styles: { width: 100, height: 50 },
        },
      ],
    };

    expect(isNormalizedSpec(normalizedSpec)).toBe(true);
    expect(isFigwrightPayload(normalizedSpec)).toBe(false);

    const figwrightCtx = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "figwright-context.json"), "utf-8")
    );
    expect(isNormalizedSpec(figwrightCtx)).toBe(false);
    expect(isFigwrightPayload(figwrightCtx)).toBe(true);

    const designDiffSnapshot = {
      formatVersion: 13,
      context: figwrightCtx,
    };
    expect(isFigwrightPayload(designDiffSnapshot)).toBe(true);

    const getNodePayload = {
      node: figwrightCtx.nodes[0],
    };
    expect(isFigwrightPayload(getNodePayload)).toBe(true);
  });

  it("converts hex and RGB colors accurately with opacity and handles invalid input", () => {
    expect(parseHexOrRgbColor("#FFFFFF")).toBe("rgb(255, 255, 255)");
    expect(parseHexOrRgbColor("#000")).toBe("rgb(0, 0, 0)");
    expect(parseHexOrRgbColor("#2563EB")).toBe("rgb(37, 99, 235)");
    expect(parseHexOrRgbColor("#2563EB", 0.5)).toBe("rgba(37, 99, 235, 0.5)");
    expect(parseHexOrRgbColor({ r: 1, g: 0, b: 0, a: 0.8 })).toBe("rgba(255, 0, 0, 0.8)");

    // Invalid hex characters should return undefined, not NaN
    expect(parseHexOrRgbColor("#GGGGGG")).toBeUndefined();
    expect(parseHexOrRgbColor("#12345Z")).toBeUndefined();
    expect(parseHexOrRgbColor("not-a-color")).toBeUndefined();

    // RGB / RGBA strings with opacityOverride
    expect(parseHexOrRgbColor("rgb(37, 99, 235)", 0.5)).toBe("rgba(37, 99, 235, 0.5)");
    expect(parseHexOrRgbColor("rgba(37, 99, 235, 0.8)", 0.5)).toBe("rgba(37, 99, 235, 0.4)");
  });

  it("maps font styles and OpenType variable axes to numeric fontWeights", () => {
    expect(mapFontStyleToWeight("Bold")).toBe(700);
    expect(mapFontStyleToWeight("SemiBold")).toBe(600);
    expect(mapFontStyleToWeight("Medium")).toBe(500);
    expect(mapFontStyleToWeight("Regular")).toBe(400);
    expect(mapFontStyleToWeight("Light")).toBe(300);
    expect(mapFontStyleToWeight("Thin")).toBe(100);
    expect(mapFontStyleToWeight("Extra Bold")).toBe(800);
    expect(mapFontStyleToWeight("Black")).toBe(900);
    expect(mapFontStyleToWeight("Custom", { wght: 650 })).toBe(650);
  });

  it("normalizes a full Figwright get_design_context payload into NormalizedSpec", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "figwright-context.json"), "utf-8")
    );

    const result = convertFigwrightToNormalizedSpec(raw);
    expect(result.spec.adapter).toBe("figma");
    expect(result.spec.nodes.length).toBe(5);

    // Root node
    const root = result.spec.nodes[0];
    expect(root.id).toBe("100:1");
    expect(root.rect).toEqual({ x: 0, y: 0, width: 354, height: 134 });
    expect(root.styles.paddingTop).toBe(16);
    expect(root.styles.paddingLeft).toBe(16);
    expect(root.styles.borderTopLeftRadius).toBe(12);
    expect(root.styles.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(root.styles.display).toBe("flex");
    expect(root.styles.flexDirection).toBe("column");
    expect(root.styles.rowGap).toBe(12);

    // Child text node
    const title = result.spec.nodes[1];
    expect(title.id).toBe("100:2");
    expect(title.rect).toEqual({ x: 16, y: 16, width: 322, height: 24 });
    expect(title.text).toBe("تست عنوان کارت");
    expect(title.styles.fontFamily).toBe("Vazirmatn");
    expect(title.styles.fontWeight).toBe(700);
    expect(title.styles.fontSize).toBe(18);
    expect(title.styles.lineHeight).toBe(24);
    expect(title.styles.color).toBe("rgb(17, 24, 39)");

    // Group child (Figma GROUP child coordinates are relative to group parent frame)
    const btn = result.spec.nodes[3];
    expect(btn.id).toBe("100:4");
    expect(btn.rect).toEqual({ x: 16, y: 52, width: 80, height: 36 });
    expect(btn.styles.backgroundColor).toBe("rgb(37, 99, 235)");
    expect(btn.styles.borderTopLeftRadius).toBe(8);

    // Warning emitted for deduped badge node 100:5
    expect(result.meta.hasDedupedNodes).toBe(true);
    expect(result.warnings.some((w) => w.includes("deduped instance"))).toBe(true);
  });

  it("fails fast when encountering a sectionPlan stub", () => {
    const raw = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "figwright-section-plan.json"), "utf-8")
    );
    expect(() => convertFigwrightToNormalizedSpec(raw)).toThrow(
      /sectionPlan/
    );
  });

  it("fails fast on detail: minimal captures missing width or height on root node", () => {
    const minimalPayload = {
      nodes: [
        {
          id: "1:2",
          name: "MinimalCard",
          type: "FRAME",
          // width and height missing!
        },
      ],
    };
    expect(() => convertFigwrightToNormalizedSpec(minimalPayload)).toThrow(
      /detail: 'minimal'/
    );
  });

  it("emits warnings on DISPLAY_P3 color profile, truncated subtrees, and multi-root nodes", () => {
    const p3Payload = {
      colorProfile: "DISPLAY_P3",
      nodes: [
        {
          id: "1:1",
          name: "Root1",
          type: "FRAME",
          width: 200,
          height: 100,
          children: [
            {
              id: "1:2",
              name: "TruncatedChild",
              type: "FRAME",
              width: 50,
              height: 50,
              truncated: true,
            },
          ],
        },
        {
          id: "2:1",
          name: "Root2",
          type: "FRAME",
          width: 200,
          height: 100,
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(p3Payload);
    expect(res.meta.colorProfile).toBe("DISPLAY_P3");
    expect(res.meta.hasTruncatedNodes).toBe(true);
    expect(res.warnings.some((w) => w.includes("DISPLAY_P3"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("truncated subtree"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("top-level nodes"))).toBe(true);
  });

  it("converts PERCENT lineHeight & letterSpacing, cornerRadii, and strokeWeights", () => {
    const styledPayload = {
      nodes: [
        {
          id: "10:1",
          name: "Card",
          type: "FRAME",
          width: 300,
          height: 200,
          cornerRadii: { topLeft: 10, topRight: 12, bottomRight: 14, bottomLeft: 16 },
          stroke: "solid-border",
          strokeWeights: { top: 1, right: 2, bottom: 3, left: 4 },
          children: [
            {
              id: "10:2",
              name: "Heading",
              type: "TEXT",
              width: 200,
              height: 40,
              fontSize: 20,
              lineHeight: { unit: "PERCENT", value: 150 },
              letterSpacing: { unit: "PERCENT", value: 5 },
            },
          ],
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(styledPayload);
    const root = res.spec.nodes[0];
    expect(root.styles.borderTopLeftRadius).toBe(10);
    expect(root.styles.borderTopRightRadius).toBe(12);
    expect(root.styles.borderBottomRightRadius).toBe(14);
    expect(root.styles.borderBottomLeftRadius).toBe(16);
    expect(root.styles.borderTopWidth).toBe(1);
    expect(root.styles.borderRightWidth).toBe(2);
    expect(root.styles.borderBottomWidth).toBe(3);
    expect(root.styles.borderLeftWidth).toBe(4);

    const text = res.spec.nodes[1];
    expect(text.styles.lineHeight).toBe(30); // 20 * 150% = 30
    expect(text.styles.letterSpacing).toBe(1); // 20 * 5% = 1
  });

  it("handles GROUP as root node coordinate normalization", () => {
    const groupPayload = {
      nodes: [
        {
          id: "50:1",
          name: "RootGroup",
          type: "GROUP",
          x: 100,
          y: 200,
          width: 400,
          height: 300,
          children: [
            {
              id: "50:2",
              name: "GroupChild",
              type: "RECTANGLE",
              x: 120,
              y: 220,
              width: 80,
              height: 40,
            },
          ],
        },
      ],
    };

    const res = convertFigwrightToNormalizedSpec(groupPayload);
    const root = res.spec.nodes[0];
    expect(root.rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });

    const child = res.spec.nodes[1];
    // Next origin for depth 0 GROUP is { x: -100, y: -200 }, so child at 120, 220 becomes (120 - 100, 220 - 200) = (20, 20)
    expect(child.rect.x).toBe(20);
    expect(child.rect.y).toBe(20);
  });

  it("handles real Figma REST API object-shaped nodes { '1:2': { document: ... } }", () => {
    const realFigmaRest = {
      name: "Figma File",
      lastModified: "2026-11-22T00:00:00Z",
      nodes: {
        "1:2": {
          document: {
            id: "1:2",
            name: "Navbar",
            type: "FRAME",
            absoluteBoundingBox: { x: 50, y: 100, width: 1200, height: 80 },
            fills: [{ type: "SOLID", color: { r: 0.1, g: 0.2, b: 0.3 } }],
            children: [
              {
                id: "1:3",
                name: "Logo",
                type: "TEXT",
                characters: "My Brand",
                absoluteBoundingBox: { x: 70, y: 120, width: 100, height: 40 },
                style: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
              },
            ],
          },
        },
      },
    };

    expect(isFigmaRestPayload(realFigmaRest)).toBe(true);
    expect(isFigwrightPayload(realFigmaRest)).toBe(false);

    const normalized = convertFigmaRestToNormalizedSpec(realFigmaRest);
    expect(normalized.adapter).toBe("figma");
    expect(normalized.nodes.length).toBe(2);

    const root = normalized.nodes[0];
    expect(root.id).toBe("1:2");
    expect(root.rect).toEqual({ x: 0, y: 0, width: 1200, height: 80 });
    expect(root.styles.backgroundColor).toBe("rgb(26, 51, 77)");

    const logo = normalized.nodes[1];
    expect(logo.id).toBe("1:3");
    expect(logo.rect).toEqual({ x: 20, y: 20, width: 100, height: 40 });
    expect(logo.text).toBe("My Brand");
    expect(logo.styles.fontFamily).toBe("Inter");
  });

  it("handles design_diff baseline snapshot format properly", () => {
    const rawContext = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, "figwright-context.json"), "utf-8")
    );
    const snapshot = {
      formatVersion: 13,
      context: rawContext,
    };
    const result = convertFigwrightToNormalizedSpec(snapshot);
    expect(result.spec.nodes.length).toBe(5);
    expect(result.spec.nodes[0].id).toBe("100:1");
  });
});
