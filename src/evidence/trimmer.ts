import crypto from "node:crypto";

export const RUN_STATUSES = {
  PASS: "PASS",
  FAIL: "FAIL",
  DRIFT: "DRIFT",
  ERROR: "ERROR",
} as const;

export type RunStatus = (typeof RUN_STATUSES)[keyof typeof RUN_STATUSES];

export interface TrimOptions {
  maxCulprits?: number;
  keepScreenshots?: boolean;
}

export interface TrimmedDefect {
  fingerprint: string;
  type: string;
  selector?: string;
  rule: string;
  summary: string;
  culprits?: Array<Record<string, unknown>>;
  pixelDiff?: {
    diffCount?: number;
    diffPercentage?: number;
    match?: boolean;
  };
}

export interface TrimmedSuiteEvidence {
  status: RunStatus;
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    drifted: number;
    errored: number;
  };
  defects: TrimmedDefect[];
  compressionRatio: string;
  rawBytes: number;
  trimmedBytes: number;
}

/**
 * Classifies an individual check result conservatively against ui-level and suite outputs.
 * Supports both flat DeltaPacket objects and summary.json entries with a nested `delta` object.
 */
export function classifyCheckResult(result: unknown): RunStatus {
  if (!result || typeof result !== "object") return RUN_STATUSES.ERROR;
  const r = result as Record<string, any>;
  const payload: Record<string, any> =
    r.delta && typeof r.delta === "object" ? { ...r, ...r.delta } : r;

  if (payload.error || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
    return RUN_STATUSES.ERROR;
  }

  const hasPixelMismatch =
    payload.match === false ||
    payload.pixelDiff?.match === false ||
    (typeof payload.pixelDiff?.diffCount === "number" && payload.pixelDiff.diffCount > 0) ||
    (typeof payload.pixelDiff?.pixelsChanged === "number" && payload.pixelDiff.pixelsChanged > 0);

  const hasStructuralMismatch =
    (Array.isArray(payload.geometryViolations) && payload.geometryViolations.length > 0) ||
    (Array.isArray(payload.styleViolations) && payload.styleViolations.length > 0) ||
    (Array.isArray(payload.diffRegions) && payload.diffRegions.length > 0) ||
    (Array.isArray(payload.misaligned) && payload.misaligned.length > 0) ||
    payload.dimensionDrift === true ||
    payload.pixelDiff?.dimensionDrift === true ||
    payload.horizontalOverflow?.overflow === true ||
    payload.verdict === "mismatch";

  if (hasPixelMismatch || hasStructuralMismatch) {
    return RUN_STATUSES.DRIFT;
  }

  const isExplicitFailure =
    payload.ok === false ||
    payload.passed === false ||
    payload.status === "failed" ||
    payload.status === "failure" ||
    payload.status === "fail" ||
    payload.verdict === "fail";

  if (isExplicitFailure) {
    return RUN_STATUSES.FAIL;
  }

  const isExplicitPass =
    payload.ok === true ||
    payload.passed === true ||
    payload.match === true ||
    payload.status === "pass" ||
    payload.status === "passed" ||
    payload.verdict === "pass";

  if (isExplicitPass) {
    return RUN_STATUSES.PASS;
  }

  return RUN_STATUSES.ERROR;
}

/**
 * Aggregates a list of statuses into an overall status.
 */
export function aggregateStatus(statuses: RunStatus[]): RunStatus {
  if (!statuses || statuses.length === 0) return RUN_STATUSES.PASS;
  if (statuses.includes(RUN_STATUSES.ERROR)) return RUN_STATUSES.ERROR;
  if (statuses.includes(RUN_STATUSES.FAIL)) return RUN_STATUSES.FAIL;
  if (statuses.includes(RUN_STATUSES.DRIFT)) return RUN_STATUSES.DRIFT;
  return RUN_STATUSES.PASS;
}

function sortKeysDeep(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  const record = val as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeysDeep(record[key]);
  }
  return sorted;
}

/**
 * Generates a stable 16-char SHA-256 defect fingerprint ignoring transient paths/timestamps.
 */
export function defectFingerprint(defect: Record<string, any> | null | undefined): string {
  if (!defect) return "0000000000000000";
  const canonical = {
    checkType: defect.checkType || defect.type || "unknown",
    selector: defect.selector || defect.culprit || "",
    rule: defect.rule || defect.reason || "",
    expected: defect.expected !== undefined ? defect.expected : "",
    actual: defect.actual !== undefined ? defect.actual : "",
    diffCount: defect.pixelDiff?.diffCount ?? defect.pixelDiff?.pixelsChanged ?? "",
    delta: defect.delta !== undefined ? defect.delta : "",
    culpritSummary: Array.isArray(defect.culprits)
      ? defect.culprits.map((c: any) => c?.selector || c?.id || "").sort().slice(0, 5)
      : "",
  };
  const str = JSON.stringify(sortKeysDeep(canonical));
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/**
 * Summarizes JSON shape and rough byte sizes.
 */
export function summarizeJsonShape(obj: unknown): {
  byteSize: number;
  keyCount: number;
  keys: string[];
} {
  const jsonStr = JSON.stringify(obj || {});
  const isObj = obj !== null && typeof obj === "object";
  return {
    byteSize: Buffer.byteLength(jsonStr, "utf8"),
    keyCount: isObj ? Object.keys(obj as Record<string, unknown>).length : 0,
    keys: isObj ? Object.keys(obj as Record<string, unknown>).sort() : [],
  };
}

/**
 * Trims a verbose ui-level check/suite result into a compact defect dossier.
 */
export function trimSuiteEvidence(
  suiteEvidence: any,
  options: TrimOptions = {}
): TrimmedSuiteEvidence {
  const { maxCulprits = 5, keepScreenshots = false } = options;
  const rawBytes = Buffer.byteLength(JSON.stringify(suiteEvidence || {}), "utf8");

  const items: any[] = Array.isArray(suiteEvidence)
    ? suiteEvidence
    : suiteEvidence?.results || suiteEvidence?.checks || [suiteEvidence];

  const statuses: RunStatus[] = [];
  const defects: TrimmedDefect[] = [];
  let passed = 0;
  let failed = 0;
  let drifted = 0;
  let errored = 0;

  for (const item of items) {
    if (!item) continue;
    const status = classifyCheckResult(item);
    statuses.push(status);

    if (status === RUN_STATUSES.PASS) {
      passed++;
      continue;
    }

    if (status === RUN_STATUSES.FAIL) failed++;
    if (status === RUN_STATUSES.DRIFT) drifted++;
    if (status === RUN_STATUSES.ERROR) errored++;

    const deltaObj = item.delta && typeof item.delta === "object" ? item.delta : {};
    const effectivePixelDiff = deltaObj.pixelDiff || item.pixelDiff;
    const rawCulprits =
      item.culprits ||
      item.misaligned ||
      deltaObj.styleViolations ||
      item.styleViolations ||
      deltaObj.geometryViolations ||
      item.geometryViolations ||
      [];

    const defectItem: Record<string, any> = {
      type: item.checkType || item.name || item.id || "unknown-check",
      selector: item.selector || item.target || rawCulprits?.[0]?.selector,
      rule: item.rule || item.verdict || (item.error ? "runtime-error" : "unspecified"),
      expected: item.expected,
      actual: item.actual,
      pixelDiff: effectivePixelDiff,
      delta:
        deltaObj.horizontalOverflow?.delta ??
        (typeof item.delta === "number" ? item.delta : undefined),
      culprits: Array.isArray(rawCulprits) ? rawCulprits : undefined,
    };

    const fp = defectFingerprint(defectItem);

    const culprits = Array.isArray(rawCulprits)
      ? rawCulprits.slice(0, maxCulprits).map((c: any) => {
          const { screenshot, stack, ...rest } = c || {};
          return keepScreenshots && screenshot ? { ...rest, screenshot } : rest;
        })
      : [];

    defects.push({
      fingerprint: fp,
      type: defectItem.type,
      selector: defectItem.selector,
      rule: defectItem.rule,
      summary:
        item.error ||
        deltaObj.summary ||
        item.summary ||
        `${defectItem.type} violation on ${defectItem.selector || "root"}`,
      ...(culprits.length > 0 ? { culprits } : {}),
      ...(effectivePixelDiff
        ? {
            pixelDiff: {
              diffCount: effectivePixelDiff.diffCount ?? effectivePixelDiff.pixelsChanged,
              diffPercentage: effectivePixelDiff.diffPercentage ?? effectivePixelDiff.ratio,
              match: effectivePixelDiff.match,
            },
          }
        : {}),
    });
  }

  const overallStatus = aggregateStatus(statuses);
  const trimmed = {
    status: overallStatus,
    summary: {
      totalChecks: items.length,
      passed,
      failed,
      drifted,
      errored,
    },
    defects,
  };

  const trimmedBytes = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
  const compressionRatio =
    rawBytes > 0 ? `${((1 - trimmedBytes / rawBytes) * 100).toFixed(1)}%` : "0%";

  return {
    ...trimmed,
    compressionRatio,
    rawBytes,
    trimmedBytes,
  };
}
