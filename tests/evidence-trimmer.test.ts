import { describe, it, expect } from "vitest";
import {
  RUN_STATUSES,
  classifyCheckResult,
  aggregateStatus,
  defectFingerprint,
  trimSuiteEvidence,
} from "../src/index.js";

describe("Evidence Trimmer & Defect Fingerprinting", () => {
  it("classifies DeltaPackets, nested delta wrappers, and unknown shapes conservatively", () => {
    expect(classifyCheckResult({ status: "pass" })).toBe(RUN_STATUSES.PASS);
    expect(classifyCheckResult({ ok: false })).toBe(RUN_STATUSES.FAIL);
    expect(classifyCheckResult({ match: false })).toBe(RUN_STATUSES.DRIFT);
    expect(classifyCheckResult({ geometryViolations: [{ selector: ".x" }] })).toBe(RUN_STATUSES.DRIFT);
    expect(
      classifyCheckResult({ id: "page", delta: { horizontalOverflow: { overflow: true, delta: 12 } } })
    ).toBe(RUN_STATUSES.DRIFT);
    expect(classifyCheckResult({ error: "Timeout" })).toBe(RUN_STATUSES.ERROR);
    expect(classifyCheckResult({ unknownShape: true })).toBe(RUN_STATUSES.ERROR);

    expect(aggregateStatus([RUN_STATUSES.PASS, RUN_STATUSES.DRIFT])).toBe(RUN_STATUSES.DRIFT);
    expect(aggregateStatus([RUN_STATUSES.PASS, RUN_STATUSES.FAIL])).toBe(RUN_STATUSES.FAIL);
    expect(aggregateStatus([RUN_STATUSES.FAIL, RUN_STATUSES.ERROR])).toBe(RUN_STATUSES.ERROR);
  });

  it("generates deterministic 16-char fingerprints resistant to key order and collisions", () => {
    const a = {
      checkType: "overflow",
      selector: ".card",
      expected: { width: 100, height: 50 },
      culprits: [{ selector: ".child-a" }],
      delta: 5,
    };
    const aReordered = {
      delta: 5,
      culprits: [{ selector: ".child-a" }],
      expected: { height: 50, width: 100 },
      selector: ".card",
      checkType: "overflow",
    };
    const b = { ...a, culprits: [{ selector: ".child-b" }], delta: 15 };

    const fpA = defectFingerprint(a);
    expect(fpA).toHaveLength(16);
    expect(fpA).toBe(defectFingerprint(aReordered));
    expect(fpA).not.toBe(defectFingerprint(b));
  });

  it("compacts verbose evidence and propagates nested delta pixelDiff metrics", () => {
    const payload = {
      results: [
        { id: "pass-item", status: "pass" },
        {
          id: "hero",
          selector: ".hero",
          status: "fail",
          delta: {
            pixelDiff: { match: false, diffCount: 420, diffPercentage: 1.5 },
            styleViolations: Array.from({ length: 10 }, (_, i) => ({
              selector: `.item-${i}`,
              screenshot: "data:image/png;base64," + "A".repeat(4000),
            })),
          },
        },
      ],
    };

    const trimmed = trimSuiteEvidence(payload);
    expect(trimmed.status).toBe(RUN_STATUSES.DRIFT);
    expect(trimmed.summary.passed).toBe(1);
    expect(trimmed.summary.drifted).toBe(1);
    expect(trimmed.defects[0].pixelDiff?.diffCount).toBe(420);
    expect(trimmed.defects[0].culprits).toHaveLength(5);
    expect(parseFloat(trimmed.compressionRatio)).toBeGreaterThan(90);
  });
});
