import type { Page, Locator } from "playwright-core";
import type {
  GeometryRect,
  GeometryViolation,
  NodeSpec,
  StyleSpec,
  StyleViolation,
  UILevelConfig,
} from "../schema.js";
import { compareColors } from "../diff/color.js";

export interface TelemetryExtractionResult {
  nodes: NodeSpec[];
  rootRect: GeometryRect;
  screenshotBuffer: Buffer;
}

export async function extractPageTelemetry(
  page: Page,
  rootSelector: string = "body",
  screenshotPath?: string
): Promise<TelemetryExtractionResult> {
  const locator = page.locator(rootSelector).first();
  await locator.waitFor({ state: "attached", timeout: 10000 });

  // 1. Evaluate telemetry in browser context in one batched pass
  const extraction = await locator.evaluate((rootEl: Element) => {
    function parsePx(val: string | null | undefined): number {
      if (!val) return 0;
      const num = parseFloat(val);
      return isNaN(num) ? 0 : num;
    }

    function parseFontWeight(val: string | null | undefined): number {
      if (!val) return 400;
      if (val === "bold") return 700;
      if (val === "normal") return 400;
      const num = parseInt(val, 10);
      return isNaN(num) ? 400 : num;
    }

    function getUniqueSelector(el: Element, root: Element): string {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el === root) return root.id ? `#${CSS.escape(root.id)}` : root.tagName.toLowerCase();

      const parts: string[] = [];
      let cur: Element | null = el;

      while (cur && cur !== root && cur.parentElement) {
        const parent = cur.parentElement;
        const tag = cur.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === tag);

        if (siblings.length > 1) {
          const index = siblings.indexOf(cur) + 1;
          parts.unshift(`${tag}:nth-of-type(${index})`);
        } else {
          parts.unshift(tag);
        }
        cur = parent;
      }

      if (cur === root) {
        const rootTag = root.tagName.toLowerCase();
        parts.unshift(root.id ? `#${CSS.escape(root.id)}` : rootTag);
      }

      return parts.join(" > ");
    }

    function getTextRects(el: Element): Array<{ x: number; y: number; width: number; height: number }> {
      const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();

      while (node) {
        const text = node.textContent?.trim();
        if (text && text.length > 0) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const clientRects = range.getClientRects();
          for (let i = 0; i < clientRects.length; i++) {
            const r = clientRects[i];
            if (r.width > 0 && r.height > 0) {
              rects.push({
                x: r.left,
                y: r.top,
                width: r.width,
                height: r.height,
              });
            }
          }
        }
        node = walker.nextNode();
      }
      return rects;
    }

    const rootBcr = rootEl.getBoundingClientRect();
    const rootRect = {
      x: rootBcr.left,
      y: rootBcr.top,
      width: rootBcr.width,
      height: rootBcr.height,
    };

    const allElements: Element[] = [rootEl, ...Array.from(rootEl.querySelectorAll("*"))];
    const nodes: NodeSpec[] = [];

    for (const el of allElements) {
      const bcr = el.getBoundingClientRect();
      // Skip invisible elements
      if (bcr.width <= 0 && bcr.height <= 0) continue;

      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;

      const selector = getUniqueSelector(el, rootEl);
      const textRects = getTextRects(el);
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim())
        .filter(Boolean)
        .join(" ");

      const styles: StyleSpec = {
        paddingTop: parsePx(cs.paddingTop),
        paddingRight: parsePx(cs.paddingRight),
        paddingBottom: parsePx(cs.paddingBottom),
        paddingLeft: parsePx(cs.paddingLeft),

        marginTop: parsePx(cs.marginTop),
        marginRight: parsePx(cs.marginRight),
        marginBottom: parsePx(cs.marginBottom),
        marginLeft: parsePx(cs.marginLeft),

        borderTopWidth: parsePx(cs.borderTopWidth),
        borderRightWidth: parsePx(cs.borderRightWidth),
        borderBottomWidth: parsePx(cs.borderBottomWidth),
        borderLeftWidth: parsePx(cs.borderLeftWidth),

        borderTopLeftRadius: parsePx(cs.borderTopLeftRadius),
        borderTopRightRadius: parsePx(cs.borderTopRightRadius),
        borderBottomRightRadius: parsePx(cs.borderBottomRightRadius),
        borderBottomLeftRadius: parsePx(cs.borderBottomLeftRadius),

        rowGap: parsePx(cs.rowGap),
        columnGap: parsePx(cs.columnGap),

        fontSize: parsePx(cs.fontSize),
        lineHeight: parsePx(cs.lineHeight),
        fontWeight: parseFontWeight(cs.fontWeight),
        letterSpacing: parsePx(cs.letterSpacing),
        fontFamily: cs.fontFamily,

        color: cs.color,
        backgroundColor: cs.backgroundColor,

        display: cs.display,
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        alignItems: cs.alignItems,

        width: bcr.width,
        height: bcr.height,
      };

      nodes.push({
        id: el.id || selector,
        selector,
        tagName: el.tagName.toLowerCase(),
        rect: {
          x: bcr.left,
          y: bcr.top,
          width: bcr.width,
          height: bcr.height,
        },
        styles,
        text: directText || undefined,
        textRects: textRects.length > 0 ? textRects : undefined,
      });
    }

    return { nodes, rootRect };
  });

  // 2. Take component screenshot with animations disabled and device scale
  const screenshotBuffer = await locator.screenshot({
    animations: "disabled",
    caret: "hide",
    scale: "device",
    path: screenshotPath,
  });

  return {
    nodes: extraction.nodes,
    rootRect: extraction.rootRect,
    screenshotBuffer,
  };
}

export function compareTelemetryWithSpec(
  liveNodes: NodeSpec[],
  refNodes: NodeSpec[],
  config: UILevelConfig
): {
  styleViolations: StyleViolation[];
  geometryViolations: GeometryViolation[];
} {
  const styleViolations: StyleViolation[] = [];
  const geometryViolations: GeometryViolation[] = [];

  const tolerance = config.geometryTolerancePx ?? 0.5;
  const colorTolerance = config.colorThresholdDeltaE ?? 2.0;

  // Build lookup by selector or id
  const refMap = new Map<string, NodeSpec>();
  for (const n of refNodes) {
    refMap.set(n.selector, n);
    if (n.id && n.id !== n.selector) {
      refMap.set(n.id, n);
    }
  }

  for (const live of liveNodes) {
    const ref = refMap.get(live.selector) || (live.id ? refMap.get(live.id) : undefined);
    if (!ref) continue;

    // Check Geometry
    const dx = Number((live.rect.x - ref.rect.x).toFixed(2));
    const dy = Number((live.rect.y - ref.rect.y).toFixed(2));
    const dWidth = Number((live.rect.width - ref.rect.width).toFixed(2));
    const dHeight = Number((live.rect.height - ref.rect.height).toFixed(2));

    if (
      Math.abs(dx) > tolerance ||
      Math.abs(dy) > tolerance ||
      Math.abs(dWidth) > tolerance ||
      Math.abs(dHeight) > tolerance
    ) {
      geometryViolations.push({
        selector: live.selector,
        expected: ref.rect,
        actual: live.rect,
        delta: { dx, dy, dWidth, dHeight },
        fixHint: `Adjust positioning or sizing for '${live.selector}'. Drift: Δw=${dWidth}px, Δh=${dHeight}px, Δx=${dx}px, Δy=${dy}px`,
      });
    }

    // Check Styles
    const styleProps: Array<keyof StyleSpec> = [
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "marginTop",
      "marginRight",
      "marginBottom",
      "marginLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderTopLeftRadius",
      "borderTopRightRadius",
      "borderBottomRightRadius",
      "borderBottomLeftRadius",
      "rowGap",
      "columnGap",
      "fontSize",
      "lineHeight",
      "fontWeight",
      "letterSpacing",
    ];

    for (const prop of styleProps) {
      const expVal = ref.styles[prop];
      const actVal = live.styles[prop];

      if (typeof expVal === "number" && typeof actVal === "number") {
        const delta = Number((actVal - expVal).toFixed(2));
        const propTolerance = prop === "fontWeight" ? 50 : tolerance;
        if (Math.abs(delta) > propTolerance) {
          styleViolations.push({
            selector: live.selector,
            property: prop,
            expected: expVal,
            actual: actVal,
            delta,
            unit: "px",
            fixHint: `Set '${prop}' to ${expVal}px (currently ${actVal}px, drift: ${delta > 0 ? "+" : ""}${delta}px)`,
          });
        }
      }
    }

    // Check Colors
    if (ref.styles.color && live.styles.color) {
      const colorComp = compareColors(ref.styles.color, live.styles.color, colorTolerance);
      if (!colorComp.match) {
        styleViolations.push({
          selector: live.selector,
          property: "color",
          expected: colorComp.expectedNormalized,
          actual: colorComp.actualNormalized,
          delta: colorComp.deltaE,
          unit: "dE00",
          fixHint: `Change 'color' to '${colorComp.expectedNormalized}' (CIEDE2000 ΔE=${colorComp.deltaE})`,
        });
      }
    }

    if (ref.styles.backgroundColor && live.styles.backgroundColor) {
      const bgComp = compareColors(ref.styles.backgroundColor, live.styles.backgroundColor, colorTolerance);
      if (!bgComp.match) {
        styleViolations.push({
          selector: live.selector,
          property: "backgroundColor",
          expected: bgComp.expectedNormalized,
          actual: bgComp.actualNormalized,
          delta: bgComp.deltaE,
          unit: "dE00",
          fixHint: `Change 'backgroundColor' to '${bgComp.expectedNormalized}' (CIEDE2000 ΔE=${bgComp.deltaE})`,
        });
      }
    }
  }

  return { styleViolations, geometryViolations };
}
