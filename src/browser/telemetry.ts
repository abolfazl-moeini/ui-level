import type { Page } from "playwright-core";
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
  maskRects: GeometryRect[];
  screenshotBuffer: Buffer;
}

export async function extractPageTelemetry(
  page: Page,
  rootSelector: string = "body",
  screenshotPath?: string,
  maskSelectors: string[] = []
): Promise<TelemetryExtractionResult> {
  const locator = page.locator(rootSelector).first();
  await locator.waitFor({ state: "attached", timeout: 10000 });

  // Evaluate DOM telemetry AND maskSelectors in a single pre-scroll pass
  // so rootRect, textRects, and maskRects share the exact same viewport origin.
  const extraction = await locator.evaluate(
    (rootEl: Element, masks: string[]) => {
      function parsePx(val: string | null | undefined): number | undefined {
        if (!val || val === "normal" || val === "none" || val === "auto") return undefined;
        const num = parseFloat(val);
        return isNaN(num) ? undefined : num;
      }

      function parseZeroDefaultPx(val: string | null | undefined): number {
        if (!val || val === "normal" || val === "none" || val === "auto") return 0;
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
          const parentEl: Element = cur.parentElement;
          const tag = cur.tagName.toLowerCase();
          const siblings = Array.from(parentEl.children).filter(
            (c: Element) => c.tagName.toLowerCase() === tag
          );

          if (siblings.length > 1) {
            const index = siblings.indexOf(cur) + 1;
            parts.unshift(`${tag}:nth-of-type(${index})`);
          } else {
            parts.unshift(tag);
          }
          cur = parentEl;
        }

        if (cur === root) {
          const rootTag = root.tagName.toLowerCase();
          parts.unshift(root.id ? `#${CSS.escape(root.id)}` : rootTag);
        }

        return parts.join(" > ");
      }

      function getTextRects(
        el: Element
      ): Array<{ x: number; y: number; width: number; height: number }> {
        const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const child of Array.from(el.childNodes)) {
          if (child.nodeType !== Node.TEXT_NODE) continue;
          const text = child.textContent?.trim();
          if (!text || text.length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
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
        return rects;
      }

      function countRenderedLines(
        textRects: Array<{ x: number; y: number; width: number; height: number }>
      ): number {
        if (textRects.length === 0) return 0;
        const lineTops: number[] = [];
        for (const r of textRects) {
          if (!lineTops.some((y) => Math.abs(y - r.y) <= 3)) {
            lineTops.push(r.y);
          }
        }
        return lineTops.length;
      }

      const rootBcr = rootEl.getBoundingClientRect();
      const rootRect = {
        x: rootBcr.left,
        y: rootBcr.top,
        width: rootBcr.width,
        height: rootBcr.height,
      };

      // Resolve maskSelectors inside same synchronous snapshot before scrolling
      const maskRects: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const maskSel of masks) {
        try {
          const matched = document.querySelectorAll(maskSel);
          matched.forEach((mEl) => {
            const r = mEl.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              maskRects.push({
                x: r.left,
                y: r.top,
                width: r.width,
                height: r.height,
              });
            }
          });
        } catch {
          // Ignore invalid CSS selectors in maskSelectors
        }
      }

      const allElements: Element[] = [rootEl, ...Array.from(rootEl.querySelectorAll("*"))];
      const nodes: NodeSpec[] = [];

      for (const el of allElements) {
        const bcr = el.getBoundingClientRect();
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
          paddingTop: parseZeroDefaultPx(cs.paddingTop),
          paddingRight: parseZeroDefaultPx(cs.paddingRight),
          paddingBottom: parseZeroDefaultPx(cs.paddingBottom),
          paddingLeft: parseZeroDefaultPx(cs.paddingLeft),

          marginTop: parseZeroDefaultPx(cs.marginTop),
          marginRight: parseZeroDefaultPx(cs.marginRight),
          marginBottom: parseZeroDefaultPx(cs.marginBottom),
          marginLeft: parseZeroDefaultPx(cs.marginLeft),

          borderTopWidth: parseZeroDefaultPx(cs.borderTopWidth),
          borderRightWidth: parseZeroDefaultPx(cs.borderRightWidth),
          borderBottomWidth: parseZeroDefaultPx(cs.borderBottomWidth),
          borderLeftWidth: parseZeroDefaultPx(cs.borderLeftWidth),

          borderTopLeftRadius: parseZeroDefaultPx(cs.borderTopLeftRadius),
          borderTopRightRadius: parseZeroDefaultPx(cs.borderTopRightRadius),
          borderBottomRightRadius: parseZeroDefaultPx(cs.borderBottomRightRadius),
          borderBottomLeftRadius: parseZeroDefaultPx(cs.borderBottomLeftRadius),

          rowGap: parseZeroDefaultPx(cs.rowGap),
          columnGap: parseZeroDefaultPx(cs.columnGap),

          fontSize: parsePx(cs.fontSize),
          lineHeight: parsePx(cs.lineHeight),
          fontWeight: parseFontWeight(cs.fontWeight),
          letterSpacing: parseZeroDefaultPx(cs.letterSpacing),
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

        const figmaId = el.getAttribute("data-figma-id") || undefined;
        const classes = Array.from(el.classList);

        nodes.push({
          id: el.id || selector,
          figmaId,
          selector,
          tagName: el.tagName.toLowerCase(),
          classes: classes.length > 0 ? classes : undefined,
          direction: cs.direction === "rtl" ? "rtl" : "ltr",
          rect: {
            x: Number((bcr.left - rootBcr.left).toFixed(2)),
            y: Number((bcr.top - rootBcr.top).toFixed(2)),
            width: Number(bcr.width.toFixed(2)),
            height: Number(bcr.height.toFixed(2)),
          },
          styles,
          text: directText || undefined,
          renderedLines: directText ? countRenderedLines(textRects) : undefined,
          textRects: textRects.length > 0 ? textRects : undefined,
        });
      }

      return { nodes, rootRect, maskRects };
    },
    maskSelectors
  );

  // Capture screenshot cleanly via Playwright locator (scrolls below-the-fold safely & freezes animations)
  const screenshotBuffer = await locator.screenshot({
    animations: "disabled",
    caret: "hide",
    scale: "device",
    path: screenshotPath,
  });

  return {
    nodes: extraction.nodes,
    rootRect: extraction.rootRect,
    maskRects: extraction.maskRects,
    screenshotBuffer,
  };
}

function normalizeFontList(fontFamily: string): string[] {
  return fontFamily
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean);
}

function buildRefMatchers(refNodes: NodeSpec[]) {
  const byId = new Map<string, NodeSpec>();
  const bySelector = new Map<string, NodeSpec>();
  const byClassSig = new Map<string, NodeSpec[]>();
  const byText = new Map<string, NodeSpec[]>();

  for (const r of refNodes) {
    if (r.id && r.id !== r.selector) {
      byId.set(r.id, r);
    }
    bySelector.set(r.selector, r);

    if (r.classes && r.classes.length > 0 && r.tagName) {
      const sig = `${r.tagName}.${[...r.classes].sort().join(".")}`;
      const list = byClassSig.get(sig) || [];
      list.push(r);
      byClassSig.set(sig, list);
    }

    if (r.text && r.text.trim().length >= 2) {
      const normText = r.text.trim().replace(/\s+/g, " ");
      const list = byText.get(normText) || [];
      list.push(r);
      byText.set(normText, list);
    }
  }

  return { byId, bySelector, byClassSig, byText };
}

function resolveMatchedRef(
  live: NodeSpec,
  refMatchers: ReturnType<typeof buildRefMatchers>,
  usedRefs: Set<NodeSpec>,
  selectorMap?: Record<string, string>
): NodeSpec | undefined {
  // Tier 0: Explicit selectorMap (live selector/id -> ref id/selector)
  if (selectorMap) {
    const mapped = selectorMap[live.selector] || selectorMap[live.id];
    if (mapped) {
      const cand = refMatchers.byId.get(mapped) || refMatchers.bySelector.get(mapped);
      if (cand && !usedRefs.has(cand)) return cand;
    }
  }

  // Tier 1: Explicit ID or data-figma-id attribute
  if (live.figmaId) {
    const cand = refMatchers.byId.get(live.figmaId) || refMatchers.bySelector.get(`[data-figma-id="${live.figmaId}"]`);
    if (cand && !usedRefs.has(cand)) return cand;
  }
  if (live.id && live.id !== live.selector) {
    const cand = refMatchers.byId.get(live.id);
    if (cand && !usedRefs.has(cand)) return cand;
  }

  // Tier 2: Exact selector path OR unique (tag + classes) signature
  const exactSel = refMatchers.bySelector.get(live.selector);
  if (exactSel && !usedRefs.has(exactSel)) return exactSel;

  if (live.classes && live.classes.length > 0 && live.tagName) {
    const sig = `${live.tagName}.${[...live.classes].sort().join(".")}`;
    const cands = refMatchers.byClassSig.get(sig);
    if (cands && cands.length === 1 && !usedRefs.has(cands[0])) {
      return cands[0];
    }
  }

  // Tier 3: Unique landmark / direct text match
  if (live.text && live.text.trim().length >= 2) {
    const normText = live.text.trim().replace(/\s+/g, " ");
    const cands = refMatchers.byText.get(normText);
    if (cands && cands.length === 1 && !usedRefs.has(cands[0])) {
      return cands[0];
    }
  }

  return undefined;
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

  const refMatchers = buildRefMatchers(refNodes);
  const usedRefs = new Set<NodeSpec>();

  for (let i = 0; i < liveNodes.length; i++) {
    const live = liveNodes[i];
    let ref = resolveMatchedRef(live, refMatchers, usedRefs, config.selectorMap);
    // Root auto-pairing: pair inspected root container with reference root frame/container (never hijack a text leaf)
    if (
      !ref &&
      i === 0 &&
      refNodes.length > 0 &&
      !usedRefs.has(refNodes[0]) &&
      refNodes[0].tagName !== "text"
    ) {
      ref = refNodes[0];
    }
    if (!ref) continue;
    usedRefs.add(ref);

    // 1. Check Root-Normalized Geometry
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

    // 2. Check Numeric Longhand Styles
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
          const unitLabel = prop === "fontWeight" ? "" : "px";
          styleViolations.push({
            selector: live.selector,
            property: prop,
            expected: expVal,
            actual: actVal,
            delta,
            unit: prop === "fontWeight" ? "str" : "px",
            fixHint: `Set '${prop}' to ${expVal}${unitLabel} (currently ${actVal}${unitLabel}, drift: ${delta > 0 ? "+" : ""}${delta}${unitLabel})`,
          });
        }
      }
    }

    // 3. Check Primary Font Family
    if (ref.styles.fontFamily && live.styles.fontFamily) {
      const expFonts = normalizeFontList(ref.styles.fontFamily);
      const actFonts = normalizeFontList(live.styles.fontFamily);
      const primaryExpected = expFonts[0];
      if (primaryExpected && !actFonts.includes(primaryExpected)) {
        styleViolations.push({
          selector: live.selector,
          property: "fontFamily",
          expected: primaryExpected,
          actual: live.styles.fontFamily,
          delta: `missing '${primaryExpected}'`,
          unit: "str",
          fixHint: `Ensure 'font-family' includes '${primaryExpected}' (computed: ${live.styles.fontFamily})`,
        });
      }
    }

    // 4. Check Rendered Lines (line wrapping drift)
    if (
      typeof ref.renderedLines === "number" &&
      typeof live.renderedLines === "number" &&
      ref.renderedLines > 0 &&
      live.renderedLines !== ref.renderedLines
    ) {
      styleViolations.push({
        selector: live.selector,
        property: "renderedLines",
        expected: ref.renderedLines,
        actual: live.renderedLines,
        delta: live.renderedLines - ref.renderedLines,
        unit: "str",
        fixHint: `Text wrapped to ${live.renderedLines} line(s) instead of expected ${ref.renderedLines} line(s) on '${live.selector}'`,
      });
    }

    // 4b. Check Text Content Drift (critical for Figma mode where text pixels are masked)
    if (ref.text && live.text) {
      const expText = ref.text.trim().replace(/\s+/g, " ");
      const actText = live.text.trim().replace(/\s+/g, " ");
      if (expText !== actText) {
        styleViolations.push({
          selector: live.selector,
          property: "textContent",
          expected: expText,
          actual: actText,
          delta: "text mismatch",
          unit: "str",
          fixHint: `Update text content on '${live.selector}' to '${expText}'`,
        });
      }
    }

    // 5. Check Colors (CIEDE2000)
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
