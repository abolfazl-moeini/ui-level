import type { Page } from "playwright-core";
import { checkHorizontalOverflow } from "../diff/skeleton.js";

export interface RectBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface LayoutBoxItem {
  id?: string;
  selector?: string;
  rect: RectBox;
}

export interface OverflowViolation {
  child: LayoutBoxItem;
  overflow: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}

export interface OverlapViolation {
  a: LayoutBoxItem;
  b: LayoutBoxItem;
  intersectionArea: number;
}

export interface ContainerOverflowGroup {
  container: string;
  instanceIndex: number;
  violations: OverflowViolation[];
}

export interface SiblingOverlapGroup {
  group: string;
  instanceIndex: number;
  overlaps: OverlapViolation[];
}

export interface DomLayoutLintOptions {
  expectedDir?: string;
  expectedFontFamily?: string;
  containers?: string[];
  siblingGroups?: string[];
  ignoreOverlapSelectors?: string[];
  ignoreClippedContainers?: boolean;
  tolerancePx?: number;
}

export interface DomLayoutLintResult {
  ok: boolean;
  rtl: { ok: boolean; dir: string; expected: string };
  fonts: {
    ok: boolean;
    status: string;
    familyChecked?: string;
    familyAvailable?: boolean;
  };
  horizontalOverflow: {
    ok: boolean;
    scrollWidth?: number;
    viewportWidth?: number;
    delta: number;
    culprits: Array<{ error?: string; hint?: string }>;
  };
  containerOverflows: ContainerOverflowGroup[];
  siblingOverlaps: SiblingOverlapGroup[];
  summary: string;
}

/**
 * Pure helper: detect children overflowing their container box.
 */
export function findOverflowingChildren(
  containerRect: RectBox,
  children: LayoutBoxItem[],
  tolerancePx = 1.5
): OverflowViolation[] {
  const violations: OverflowViolation[] = [];
  if (!containerRect || !Array.isArray(children)) return violations;

  for (const child of children) {
    if (!child || !child.rect) continue;
    const r = child.rect;
    if (r.width <= 0 || r.height <= 0) continue;

    const leftDiff = containerRect.left - r.left;
    const rightDiff = r.right - containerRect.right;
    const topDiff = containerRect.top - r.top;
    const bottomDiff = r.bottom - containerRect.bottom;

    const overflowsLeft = leftDiff > tolerancePx;
    const overflowsRight = rightDiff > tolerancePx;
    const overflowsTop = topDiff > tolerancePx;
    const overflowsBottom = bottomDiff > tolerancePx;

    if (overflowsLeft || overflowsRight || overflowsTop || overflowsBottom) {
      violations.push({
        child,
        overflow: {
          left: overflowsLeft ? leftDiff : 0,
          right: overflowsRight ? rightDiff : 0,
          top: overflowsTop ? topDiff : 0,
          bottom: overflowsBottom ? bottomDiff : 0,
        },
      });
    }
  }

  return violations;
}

/**
 * Pure helper: detect in-flow bounding box overlap between sibling boxes.
 */
export function findOverlappingBoxes(
  items: LayoutBoxItem[],
  tolerancePx = 1.5
): OverlapViolation[] {
  const overlaps: OverlapViolation[] = [];
  if (!Array.isArray(items) || items.length < 2) return overlaps;

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!a?.rect || a.rect.width <= 0 || a.rect.height <= 0) continue;

    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (!b?.rect || b.rect.width <= 0 || b.rect.height <= 0) continue;

      const interLeft = Math.max(a.rect.left, b.rect.left);
      const interTop = Math.max(a.rect.top, b.rect.top);
      const interRight = Math.min(a.rect.right, b.rect.right);
      const interBottom = Math.min(a.rect.bottom, b.rect.bottom);

      const interWidth = interRight - interLeft;
      const interHeight = interBottom - interTop;

      if (interWidth > tolerancePx && interHeight > tolerancePx) {
        overlaps.push({
          a,
          b,
          intersectionArea: interWidth * interHeight,
        });
      }
    }
  }

  return overlaps;
}

/**
 * Runs DOM & layout semantic lint against an active Playwright page.
 */
export async function runDomLayoutLint(
  page: Page,
  options: DomLayoutLintOptions = {}
): Promise<DomLayoutLintResult> {
  const {
    expectedDir = "rtl",
    expectedFontFamily,
    containers = [],
    siblingGroups = [],
    ignoreOverlapSelectors = ['[aria-hidden="true"]'],
    ignoreClippedContainers = true,
    tolerancePx = 1.5,
  } = options;

  // 1. Reading direction check (configurable expectedDir)
  const dir = await page.evaluate(() => {
    return (
      document.documentElement.getAttribute("dir") ||
      document.body.getAttribute("dir") ||
      window.getComputedStyle(document.documentElement).direction ||
      window.getComputedStyle(document.body).direction ||
      "ltr"
    );
  });
  const rtlOk = dir.toLowerCase() === expectedDir.toLowerCase();

  // 2. Font readiness & expected font family verification
  const fontCheck = await page.evaluate(async (targetFamily?: string) => {
    try {
      let status = "unsupported";
      if (document.fonts && typeof document.fonts.ready !== "undefined") {
        await document.fonts.ready;
        status = document.fonts.status || "loaded";
      }
      let familyAvailable = true;
      if (targetFamily && document.fonts) {
        const normalizedTarget = targetFamily.replace(/['"]/g, "").trim().toLowerCase();
        const loadedFace = Array.from(document.fonts).some(
          (f) =>
            f.family.replace(/['"]/g, "").trim().toLowerCase() === normalizedTarget &&
            f.status === "loaded"
        );
        const checkPassed =
          typeof document.fonts.check === "function"
            ? document.fonts.check(`16px ${targetFamily}`) ||
              document.fonts.check(`16px "${targetFamily}"`)
            : true;
        // document.fonts.check() returns true when no @font-face matches, so require an actual loaded face
        familyAvailable = loadedFace && checkPassed;
      }
      return { status, familyAvailable };
    } catch {
      return { status: "error", familyAvailable: false };
    }
  }, expectedFontFamily);

  const fontsOk =
    (fontCheck.status === "loaded" || fontCheck.status === "unsupported") &&
    (expectedFontFamily ? fontCheck.familyAvailable : true);

  // 3. Horizontal page overflow using real measured scrollWidth & viewportWidth
  let horizontalOverflow: DomLayoutLintResult["horizontalOverflow"] = {
    ok: true,
    delta: 0,
    culprits: [],
  };
  try {
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }));
    const ho = checkHorizontalOverflow(metrics.scrollWidth, metrics.viewportWidth);
    horizontalOverflow = {
      ok: !ho.overflow,
      scrollWidth: metrics.scrollWidth,
      viewportWidth: metrics.viewportWidth,
      delta: ho.delta,
      culprits: ho.overflow ? [{ hint: ho.hint }] : [],
    };
  } catch (err: any) {
    horizontalOverflow = {
      ok: false,
      delta: 0,
      culprits: [{ error: err?.message || String(err) }],
    };
  }

  // 4. Container overflow inspection (supports multiple matching elements + per-axis clipping)
  const containerOverflows: ContainerOverflowGroup[] = [];
  for (const containerSel of containers) {
    const containersData = await page.evaluate(
      ({ sel, checkClipped }) => {
        const elements = Array.from(document.querySelectorAll(sel));
        if (elements.length === 0) return [];

        return elements
          .map((el, elIdx) => {
            const style = window.getComputedStyle(el);
            const overflowX = style.overflowX || style.overflow;
            const overflowY = style.overflowY || style.overflow;
            const clipX = ["hidden", "clip", "auto", "scroll"].includes(overflowX);
            const clipY = ["hidden", "clip", "auto", "scroll"].includes(overflowY);

            if (checkClipped && clipX && clipY) {
              return null;
            }

            const cRect = el.getBoundingClientRect();
            const children = Array.from(el.children)
              .filter((c) => {
                const cStyle = window.getComputedStyle(c);
                if (cStyle.display === "none" || cStyle.visibility === "hidden") return false;
                if (parseFloat(cStyle.opacity) === 0) return false;
                if (cStyle.position === "absolute" || cStyle.position === "fixed") return false;
                return true;
              })
              .map((c, index) => {
                const r = c.getBoundingClientRect();
                const classStr =
                  typeof (c as any).className === "string"
                    ? (c as any).className
                    : c.getAttribute("class") || "";
                const classes = classStr.split(/\s+/).filter(Boolean);
                return {
                  id: c.id || `${sel}[${elIdx}] > child(${index})`,
                  selector: classes.length > 0 ? `.${classes.join(".")}` : c.tagName.toLowerCase(),
                  rect: {
                    left: r.left,
                    top: r.top,
                    right: r.right,
                    bottom: r.bottom,
                    width: r.width,
                    height: r.height,
                  },
                };
              });

            return {
              instanceIndex: elIdx,
              clipX: checkClipped && clipX,
              clipY: checkClipped && clipY,
              containerRect: {
                left: cRect.left,
                top: cRect.top,
                right: cRect.right,
                bottom: cRect.bottom,
                width: cRect.width,
                height: cRect.height,
              },
              children,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);
      },
      { sel: containerSel, checkClipped: ignoreClippedContainers }
    );

    for (const cData of containersData) {
      const rawViolations = findOverflowingChildren(
        cData.containerRect,
        cData.children,
        tolerancePx
      );
      const violations = rawViolations.filter((v) => {
        const hasUnclippedX = !cData.clipX && (v.overflow.left > 0 || v.overflow.right > 0);
        const hasUnclippedY = !cData.clipY && (v.overflow.top > 0 || v.overflow.bottom > 0);
        return hasUnclippedX || hasUnclippedY;
      });
      if (violations.length > 0) {
        containerOverflows.push({
          container: containerSel,
          instanceIndex: cData.instanceIndex,
          violations,
        });
      }
    }
  }

  // 5. In-flow sibling overlap inspection
  const siblingOverlaps: SiblingOverlapGroup[] = [];
  for (const groupSel of siblingGroups) {
    const groupsItems = await page.evaluate(
      ({ sel, ignoreList }) => {
        const groups = Array.from(document.querySelectorAll(sel));
        if (groups.length === 0) return [];

        return groups.map((groupEl, groupIdx) => {
          const children = Array.from(groupEl.children).filter((c) => {
            const style = window.getComputedStyle(c);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (parseFloat(style.opacity) === 0) return false;
            if (style.position === "absolute" || style.position === "fixed") return false;
            for (const ignore of ignoreList) {
              if (c.matches(ignore)) return false;
            }
            return true;
          });

          return {
            groupIdx,
            items: children.map((c, idx) => {
              const r = c.getBoundingClientRect();
              const classStr =
                typeof (c as any).className === "string"
                  ? (c as any).className
                  : c.getAttribute("class") || "";
              const classes = classStr.split(/\s+/).filter(Boolean);
              return {
                id: c.id || `${sel}[${groupIdx}] > :nth-child(${idx + 1})`,
                selector: classes.length > 0 ? `.${classes.join(".")}` : c.tagName.toLowerCase(),
                rect: {
                  left: r.left,
                  top: r.top,
                  right: r.right,
                  bottom: r.bottom,
                  width: r.width,
                  height: r.height,
                },
              };
            }),
          };
        });
      },
      { sel: groupSel, ignoreList: ignoreOverlapSelectors }
    );

    for (const gData of groupsItems) {
      if (gData.items.length > 1) {
        const overlaps = findOverlappingBoxes(gData.items, tolerancePx);
        if (overlaps.length > 0) {
          siblingOverlaps.push({
            group: groupSel,
            instanceIndex: gData.groupIdx,
            overlaps,
          });
        }
      }
    }
  }

  const ok =
    rtlOk &&
    fontsOk &&
    horizontalOverflow.ok &&
    containerOverflows.length === 0 &&
    siblingOverlaps.length === 0;

  return {
    ok,
    rtl: { ok: rtlOk, dir, expected: expectedDir },
    fonts: {
      ok: fontsOk,
      status: fontCheck.status,
      familyChecked: expectedFontFamily,
      familyAvailable: fontCheck.familyAvailable,
    },
    horizontalOverflow,
    containerOverflows,
    siblingOverlaps,
    summary: ok
      ? `DOM and layout semantics passed cleanly (dir=${dir}, fonts=${fontCheck.status}${expectedFontFamily ? ` [${expectedFontFamily}: ready]` : ""}, no overflow/overlaps).`
      : `DOM and layout lint issues detected: dir=${rtlOk} (found ${dir}, expected ${expectedDir}), fonts=${fontsOk}, hOverflow=${horizontalOverflow.ok}, containerViolations=${containerOverflows.length}, siblingOverlaps=${siblingOverlaps.length}`,
  };
}
