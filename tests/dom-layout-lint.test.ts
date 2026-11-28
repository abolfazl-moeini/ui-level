import { describe, it, expect } from "vitest";
import {
  findOverflowingChildren,
  findOverlappingBoxes,
  runDomLayoutLint,
  launchBrowser,
} from "../src/index.js";

describe("DOM & Layout Semantic Lint", () => {
  it("detects children overflowing container bounds beyond tolerance", () => {
    const container = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    const children = [
      { id: "inside", rect: { left: 10, top: 10, right: 90, bottom: 90, width: 80, height: 80 } },
      { id: "right-out", rect: { left: 10, top: 10, right: 106, bottom: 90, width: 96, height: 80 } },
      { id: "left-out", rect: { left: -4, top: 10, right: 90, bottom: 90, width: 94, height: 80 } },
    ];

    const violations = findOverflowingChildren(container, children, 1.5);
    expect(violations).toHaveLength(2);
    expect(violations[0].child.id).toBe("right-out");
    expect(violations[0].overflow.right).toBe(6);
    expect(violations[1].child.id).toBe("left-out");
    expect(violations[1].overflow.left).toBe(4);
  });

  it("detects in-flow sibling bounding box overlaps", () => {
    const a = { id: "a", rect: { left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50 } };
    const b = { id: "b", rect: { left: 60, top: 0, right: 100, bottom: 50, width: 40, height: 50 } };
    const c = { id: "c", rect: { left: 40, top: 10, right: 80, bottom: 40, width: 40, height: 30 } };

    expect(findOverlappingBoxes([a, b], 1.5)).toHaveLength(0);
    const overlaps = findOverlappingBoxes([a, b, c], 1.5);
    expect(overlaps).toHaveLength(2);
    expect(overlaps[0].intersectionArea).toBe(300);
  });

  it("verifies horizontal overflow, per-axis clipping, SVG children, and unloaded font rejection in Chromium", async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 400, height: 600 } });
      await page.setContent(`
        <!doctype html>
        <html dir="rtl">
          <head>
            <style>
              body { margin: 0; }
              .clipped-x { width: 100px; height: 100px; overflow-x: hidden; overflow-y: visible; }
              .clipped-x > .wide { width: 200px; height: 50px; }
              .unclipped { width: 100px; height: 50px; }
              .unclipped > .tall { width: 50px; height: 90px; }
              .wide-page { width: 520px; height: 20px; }
            </style>
          </head>
          <body>
            <div class="clipped-x">
              <div class="wide"></div>
              <svg class="icon" width="20" height="20"></svg>
            </div>
            <div class="unclipped">
              <div class="tall"></div>
            </div>
            <div class="wide-page"></div>
          </body>
        </html>
      `);

      const lint = await runDomLayoutLint(page, {
        expectedDir: "rtl",
        expectedFontFamily: "NonExistentFont",
        containers: [".clipped-x", ".unclipped"],
      });

      expect(lint.ok).toBe(false);
      expect(lint.rtl.ok).toBe(true);
      expect(lint.fonts.familyAvailable).toBe(false);
      expect(lint.fonts.ok).toBe(false);
      expect(lint.horizontalOverflow.ok).toBe(false);
      expect(lint.horizontalOverflow.delta).toBe(120);
      // .clipped-x clips X so wide child is ignored; .unclipped overflows Y
      expect(lint.containerOverflows).toHaveLength(1);
      expect(lint.containerOverflows[0].container).toBe(".unclipped");
    } finally {
      await browser.close();
    }
  }, 15000);
});
