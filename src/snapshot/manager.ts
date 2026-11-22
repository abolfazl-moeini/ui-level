import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import {
  ReferenceManifestSchema,
  NormalizedSpecSchema,
  type NormalizedSpec,
  type ReferenceManifest,
  type ViewportConfig,
} from "../schema.js";
import {
  convertFigwrightToNormalizedSpec,
  isFigwrightPayload,
  isNormalizedSpec,
} from "../adapters/figwright.converter.js";
import {
  convertFigmaRestToNormalizedSpec,
  isFigmaRestPayload,
} from "../adapters/figma-rest.normalizer.js";

export interface SnapshotImportOptions {
  slug: string;
  specPath: string;
  imagePath: string;
  baseDir?: string;
  dpr?: number;
  force?: boolean;
  selectorMap?: Record<string, string>;
  figma?: ReferenceManifest["figma"];
  figwright?: ReferenceManifest["figwright"];
}

export interface LoadedSnapshot {
  spec: NormalizedSpec;
  imagePath: string;
  manifest?: ReferenceManifest;
  warnings: string[];
}

export function computeFileSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

function cleanDefined<T extends Record<string, any>>(obj?: T): T | undefined {
  if (!obj) return undefined;
  const cleaned: Record<string, any> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      cleaned[k] = v;
      hasKeys = true;
    }
  }
  return hasKeys ? (cleaned as T) : undefined;
}

function resolveWithinSnapshot(snapshotDir: string, filename: string, label: string): string {
  const resolvedFile = path.resolve(snapshotDir, filename);
  const rel = path.relative(snapshotDir, resolvedFile);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Unsafe ${label} path '${filename}' escapes snapshot directory.`);
  }
  return resolvedFile;
}

export function isSnapshotDirectory(targetPath?: string): boolean {
  if (!targetPath) return false;
  try {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) return false;
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return false;

    const files = fs.readdirSync(resolved);
    if (files.includes("manifest.json")) return true;

    const hasSpec = files.includes("reference.json");
    const hasImage = files.includes("reference.png");

    return hasSpec && hasImage;
  } catch {
    return false;
  }
}

export async function importReferenceSnapshot(
  options: SnapshotImportOptions
): Promise<{ snapshotDir: string; manifest: ReferenceManifest }> {
  if (
    !options.slug ||
    options.slug.includes("/") ||
    options.slug.includes("\\") ||
    options.slug.includes("..") ||
    options.slug.startsWith(".")
  ) {
    throw new Error(`Invalid snapshot slug '${options.slug}'.`);
  }

  const cleanSlug = options.slug.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!cleanSlug || cleanSlug === ".") {
    throw new Error(`Invalid snapshot slug '${options.slug}'.`);
  }

  const baseDir = path.resolve(options.baseDir || path.join(".ui-level", "references"));
  const snapshotDir = path.resolve(baseDir, cleanSlug);
  const rel = path.relative(baseDir, snapshotDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Snapshot slug '${options.slug}' escapes base directory '${baseDir}'.`);
  }

  const specPath = path.resolve(options.specPath);
  if (!fs.existsSync(specPath)) {
    throw new Error(`Snapshot spec file not found: ${specPath}`);
  }

  const imagePath = path.resolve(options.imagePath);
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Snapshot image file not found: ${imagePath}`);
  }

  if (fs.existsSync(snapshotDir) && !options.force) {
    throw new Error(
      `Snapshot '${cleanSlug}' already exists in '${baseDir}'. Pass --force (or force: true) to overwrite.`
    );
  }

  fs.mkdirSync(snapshotDir, { recursive: true });

  const rawSpec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
  let normalizedSpec: NormalizedSpec;
  let source: ReferenceManifest["source"] = "normalized";
  const warnings: string[] = [];
  let convMeta: any | undefined;

  const defaultViewport: ViewportConfig = {
    width: 1280,
    height: 800,
    deviceScaleFactor: options.dpr ?? 2,
  };

  if (isNormalizedSpec(rawSpec)) {
    normalizedSpec = rawSpec;
    source = "normalized";
  } else if (isFigwrightPayload(rawSpec)) {
    const conv = convertFigwrightToNormalizedSpec(rawSpec, defaultViewport);
    normalizedSpec = conv.spec;
    source = "figwright";
    convMeta = conv.meta;
    warnings.push(...conv.warnings);
  } else if (isFigmaRestPayload(rawSpec)) {
    normalizedSpec = convertFigmaRestToNormalizedSpec(rawSpec, defaultViewport);
    source = "figma-rest";
  } else {
    throw new Error(`Unable to recognize spec format in: ${specPath}`);
  }

  // Inspect image dimensions via sharp
  const imgMeta = await sharp(imagePath).metadata();
  const imgWidth = imgMeta.width || 0;
  const imgHeight = imgMeta.height || 0;

  if (imgWidth <= 0 || imgHeight <= 0) {
    throw new Error(`Invalid image dimensions for: ${imagePath}`);
  }

  // Infer DPR
  let inferredDpr = options.dpr;
  if (!inferredDpr) {
    const rootWidth = normalizedSpec.nodes[0]?.rect.width;
    if (rootWidth && rootWidth > 0) {
      const ratio = imgWidth / rootWidth;
      if (Math.abs(ratio - 1) <= 0.08) inferredDpr = 1;
      else if (Math.abs(ratio - 2) <= 0.08) inferredDpr = 2;
      else if (Math.abs(ratio - 3) <= 0.08) inferredDpr = 3;
      else {
        warnings.push(
          `Image width (${imgWidth}px) to reference root width (${rootWidth}px) ratio is ${ratio.toFixed(2)}, which does not reliably match DPR 1, 2, or 3. Defaulting to DPR 2; use --dpr to override.`
        );
      }
    }
  }
  const deviceScaleFactor = inferredDpr || 2;
  normalizedSpec.viewport.deviceScaleFactor = deviceScaleFactor;

  const targetSpecPath = path.join(snapshotDir, "reference.json");
  const targetImagePath = path.join(snapshotDir, "reference.png");

  normalizedSpec.imagePath = targetImagePath;

  fs.writeFileSync(targetSpecPath, JSON.stringify(normalizedSpec, null, 2), "utf-8");

  // Ensure reference image is written as a valid PNG
  if (imgMeta.format === "png") {
    fs.copyFileSync(imagePath, targetImagePath);
  } else {
    await sharp(imagePath).png().toFile(targetImagePath);
  }

  const specSha256 = computeFileSha256(targetSpecPath);
  const imageSha256 = computeFileSha256(targetImagePath);

  let figmaMeta = cleanDefined(options.figma);
  let figwrightMeta = cleanDefined(options.figwright);

  if (convMeta) {
    if (convMeta.rootNodeId || convMeta.rootNodeName || convMeta.colorProfile) {
      figmaMeta = cleanDefined({
        nodeId: convMeta.rootNodeId,
        nodeName: convMeta.rootNodeName,
        colorProfile: convMeta.colorProfile,
        ...figmaMeta,
      });
    }
    figwrightMeta = cleanDefined({
      detail: "full",
      dedupeComponents: convMeta.hasDedupedNodes,
      ...figwrightMeta,
    });
  }

  const manifestData: ReferenceManifest = {
    schemaVersion: 1,
    slug: cleanSlug,
    source,
    exportedAt: new Date().toISOString(),
    figma: figmaMeta,
    figwright: figwrightMeta,
    image: {
      file: "reference.png",
      width: imgWidth,
      height: imgHeight,
      deviceScaleFactor,
    },
    specFile: "reference.json",
    hashes: {
      specSha256,
      imageSha256,
    },
    selectorMap: cleanDefined(options.selectorMap),
    warnings,
  };

  const validatedManifest = ReferenceManifestSchema.parse(manifestData);
  fs.writeFileSync(
    path.join(snapshotDir, "manifest.json"),
    JSON.stringify(validatedManifest, null, 2),
    "utf-8"
  );

  return { snapshotDir, manifest: validatedManifest };
}

export function loadReferenceSnapshot(
  dirPath: string,
  options?: { skipIntegrityCheck?: boolean; viewport?: ViewportConfig }
): LoadedSnapshot {
  const resolved = path.resolve(dirPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Snapshot directory does not exist: ${dirPath}`);
  }

  const manifestPath = path.join(resolved, "manifest.json");
  const warnings: string[] = [];

  if (fs.existsSync(manifestPath)) {
    const rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const manifest = ReferenceManifestSchema.parse(rawManifest);

    const specPath = resolveWithinSnapshot(resolved, manifest.specFile || "reference.json", "specFile");
    const imagePath = resolveWithinSnapshot(resolved, manifest.image.file || "reference.png", "image.file");

    if (!fs.existsSync(specPath)) {
      throw new Error(`Snapshot spec file missing: ${specPath}`);
    }
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Snapshot image file missing: ${imagePath}`);
    }

    const currentSpecHash = computeFileSha256(specPath);
    const currentImageHash = computeFileSha256(imagePath);

    const specMismatch = currentSpecHash !== manifest.hashes.specSha256;
    const imageMismatch = currentImageHash !== manifest.hashes.imageSha256;

    if (specMismatch || imageMismatch) {
      const details = [
        specMismatch ? `specSha256 mismatch (${currentSpecHash} vs expected ${manifest.hashes.specSha256})` : "",
        imageMismatch ? `imageSha256 mismatch (${currentImageHash} vs expected ${manifest.hashes.imageSha256})` : "",
      ]
        .filter(Boolean)
        .join("; ");

      if (!options?.skipIntegrityCheck) {
        throw new Error(
          `Reference snapshot integrity check failed for '${dirPath}': ${details}. Re-import the snapshot or pass --skip-integrity.`
        );
      } else {
        warnings.push(`Snapshot integrity warning: ${details}`);
      }
    }

    const rawSpecJson = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    const specParseResult = NormalizedSpecSchema.safeParse(rawSpecJson);
    if (!specParseResult.success) {
      throw new Error(
        `Invalid NormalizedSpec in '${specPath}': ${specParseResult.error.message}`
      );
    }
    const spec: NormalizedSpec = specParseResult.data;
    if (manifest.warnings) {
      warnings.push(...manifest.warnings);
    }

    return {
      spec,
      imagePath,
      manifest,
      warnings,
    };
  }

  // Fallback directory discovery without manifest.json
  const files = fs.readdirSync(resolved);
  const specFile =
    files.find((f) => /^(reference|spec|figma-node)\.json$/i.test(f)) ||
    files.find((f) => f.endsWith(".json"));
  const imageFile =
    files.find((f) => /^(reference|ref|screenshot)\.(png|jpe?g|webp)$/i.test(f)) ||
    files.find((f) => /\.(png|jpe?g|webp)$/i.test(f));

  if (!specFile || !imageFile) {
    throw new Error(
      `Snapshot directory '${dirPath}' must contain both a JSON spec and a reference PNG/JPG.`
    );
  }

  const specPath = resolveWithinSnapshot(resolved, specFile, "specFile");
  const imagePath = resolveWithinSnapshot(resolved, imageFile, "image.file");
  const rawSpec = JSON.parse(fs.readFileSync(specPath, "utf-8"));

  let spec: NormalizedSpec;
  const viewport = options?.viewport || { width: 1280, height: 800, deviceScaleFactor: 2 };

  if (isNormalizedSpec(rawSpec)) {
    spec = NormalizedSpecSchema.parse(rawSpec);
  } else if (isFigwrightPayload(rawSpec)) {
    const conv = convertFigwrightToNormalizedSpec(rawSpec, viewport, imagePath);
    spec = conv.spec;
    warnings.push(...conv.warnings);
  } else if (isFigmaRestPayload(rawSpec)) {
    spec = convertFigmaRestToNormalizedSpec(rawSpec, viewport, imagePath);
  } else {
    throw new Error(`Unrecognized spec format in snapshot directory: ${specPath}`);
  }

  return {
    spec,
    imagePath,
    warnings,
  };
}
