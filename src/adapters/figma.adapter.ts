import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";
import {
  NormalizedSpecSchema,
  type NormalizedSpec,
  type NodeSpec,
  type StyleSpec,
  type UILevelConfig,
  type ReferenceManifest,
  type ViewportConfig,
} from "../schema.js";
import {
  convertFigwrightToNormalizedSpec,
  isFigwrightPayload,
  isNormalizedSpec,
} from "./figwright.converter.js";
import {
  convertFigmaRestToNormalizedSpec,
  isFigmaRestPayload,
  traverseFigmaNode,
} from "./figma-rest.normalizer.js";
import {
  isSnapshotDirectory,
  loadReferenceSnapshot,
} from "../snapshot/manager.js";

export {
  convertFigmaRestToNormalizedSpec,
  isFigmaRestPayload,
} from "./figma-rest.normalizer.js";

export interface FigmaAdapterOptions {
  token?: string;
  fileKey?: string;
  nodeId?: string;
  refSpecPath?: string;
  refImagePath?: string;
}

export interface FigmaAdapterResult {
  spec: NormalizedSpec;
  refScreenshotPath: string;
  warnings?: string[];
  manifest?: ReferenceManifest;
  inferredDpr?: number;
}

export function parseFigmaRef(ref?: string): { fileKey?: string; nodeId?: string } {
  if (!ref) return {};
  const trimmed = ref.trim();

  // Figma URL format: https://www.figma.com/(file|design)/<fileKey>/...?node-id=<nodeId>
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const match = url.pathname.match(/\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/);
      const fileKey = match?.[1];
      const rawNodeId = url.searchParams.get("node-id") || undefined;
      const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : undefined;
      return { fileKey, nodeId };
    } catch {
      return {};
    }
  }

  // Shorthand format: "<fileKey>:<nodeId>" e.g. "AbCdEf123:1:2" or "AbCdEf123:1-2"
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const fileKey = trimmed.slice(0, colonIdx);
    const rawNodeId = trimmed.slice(colonIdx + 1);
    const nodeId = rawNodeId.replace(/-/g, ":");
    return { fileKey, nodeId };
  }

  return {};
}

async function tryFetchLocalVariables(
  fileKey: string,
  token: string
): Promise<Map<string, { r: number; g: number; b: number; a?: number }>> {
  const vars = new Map<string, { r: number; g: number; b: number; a?: number }>();
  try {
    const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/variables/local`, {
      headers: { "X-Figma-Token": token },
    });
    if (!res.ok) {
      // Non-Enterprise plans return 403; gracefully fall back to node-resolved fills
      return vars;
    }
    const data: any = await res.json();
    const variables = data?.meta?.variables || {};
    for (const [id, v] of Object.entries<any>(variables)) {
      if (v?.resolvedType === "COLOR" && v.valuesByMode) {
        const firstModeVal = Object.values<any>(v.valuesByMode)[0];
        if (firstModeVal && typeof firstModeVal.r === "number") {
          vars.set(id, firstModeVal);
        }
      }
    }
  } catch {
    // Best-effort only
  }
  return vars;
}

async function writeValidPng(srcPath: string, destPath: string): Promise<void> {
  if (path.resolve(srcPath) === path.resolve(destPath)) return;
  const meta = await sharp(srcPath).metadata();
  if (meta.format === "png") {
    fs.copyFileSync(srcPath, destPath);
  } else {
    await sharp(srcPath).png().toFile(destPath);
  }
}

export async function processFigmaReference(
  config: UILevelConfig,
  outputDir: string,
  options: FigmaAdapterOptions = {}
): Promise<FigmaAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  // 1. Snapshot Directory Mode
  const snapshotCandidate =
    (config.ref && isSnapshotDirectory(config.ref) ? config.ref : undefined) ||
    (options.refSpecPath && isSnapshotDirectory(options.refSpecPath)
      ? options.refSpecPath
      : undefined) ||
    (config.refSpec && isSnapshotDirectory(config.refSpec)
      ? config.refSpec
      : undefined);

  if (snapshotCandidate) {
    const loaded = loadReferenceSnapshot(snapshotCandidate, {
      skipIntegrityCheck: config.skipIntegrityCheck,
      viewport: config.viewport,
    });
    await writeValidPng(loaded.imagePath, refScreenshotPath);
    return {
      spec: loaded.spec,
      refScreenshotPath,
      warnings: loaded.warnings,
      manifest: loaded.manifest,
      inferredDpr: loaded.manifest?.image.deviceScaleFactor,
    };
  }

  const refSpecPath =
    options.refSpecPath ||
    config.refSpec ||
    (config.ref?.endsWith(".json") ? config.ref : undefined);
  const refImagePath =
    options.refImagePath ||
    config.refImage ||
    (config.ref && /\.(png|jpe?g|webp)$/i.test(config.ref) ? config.ref : undefined);

  // 2. Offline Mode: Local spec &/or image provided (for Figma MCP or offline bundles)
  if (refSpecPath || refImagePath) {
    if (!refSpecPath) {
      throw new Error(
        "Figma offline mode requires a reference specification JSON via --ref-spec or config.refSpec."
      );
    }

    let spec: NormalizedSpec = {
      adapter: "figma",
      viewport: config.viewport,
      nodes: [],
      imagePath: refScreenshotPath,
    };
    const warnings: string[] = [];

    if (!fs.existsSync(refSpecPath)) {
      throw new Error(`Figma offline spec file not found: ${refSpecPath}`);
    }
    const rawSpec = JSON.parse(fs.readFileSync(refSpecPath, "utf-8"));
    if (isNormalizedSpec(rawSpec)) {
      spec = rawSpec;
    } else if (isFigwrightPayload(rawSpec)) {
      const conv = convertFigwrightToNormalizedSpec(rawSpec, config.viewport, refScreenshotPath);
      spec = conv.spec;
      warnings.push(...conv.warnings);
    } else if (isFigmaRestPayload(rawSpec)) {
      spec = convertFigmaRestToNormalizedSpec(rawSpec, config.viewport, refScreenshotPath);
    } else {
      throw new Error(`Unrecognized Figma reference spec format in: ${refSpecPath}`);
    }

    if (refImagePath) {
      if (!fs.existsSync(refImagePath)) {
        throw new Error(`Figma offline reference image not found: ${refImagePath}`);
      }
      await writeValidPng(refImagePath, refScreenshotPath);
    } else if (
      spec.imagePath &&
      fs.existsSync(spec.imagePath) &&
      path.resolve(spec.imagePath) !== path.resolve(refScreenshotPath)
    ) {
      await writeValidPng(spec.imagePath, refScreenshotPath);
    } else {
      throw new Error(
        "Figma offline spec mode requires an associated reference PNG via --ref-image or config.refImage."
      );
    }

    // Validate NormalizedSpec structure (guarantees at least 1 node)
    NormalizedSpecSchema.parse(spec);

    return { spec, refScreenshotPath, warnings: warnings.length > 0 ? warnings : undefined };
  }

  const parsedRef = parseFigmaRef(config.ref);
  const token = options.token || config.figma?.token || process.env.FIGMA_TOKEN;
  const fileKey = options.fileKey || config.figma?.fileKey || parsedRef.fileKey;
  const nodeId = (options.nodeId || config.figma?.nodeId || parsedRef.nodeId)?.replace(/-/g, ":");

  if (!token || !fileKey || !nodeId) {
    throw new Error(
      "Figma adapter requires 'token' (FIGMA_TOKEN), 'fileKey', and 'nodeId' (via --ref '<fileKey>:<nodeId>', Figma URL, or --ref-spec/--ref-image)."
    );
  }

  const cacheDir = path.join(outputDir, "cache", "figma");
  fs.mkdirSync(cacheDir, { recursive: true });
  const sanitizedNodeId = nodeId.replace(/[:]/g, "_");
  const cachedSpecPath = path.join(cacheDir, `${fileKey}_${sanitizedNodeId}_v2_spec.json`);
  const cachedImagePath = path.join(cacheDir, `${fileKey}_${sanitizedNodeId}_v2_ref.png`);

  if (fs.existsSync(cachedSpecPath) && fs.existsSync(cachedImagePath)) {
    const spec: NormalizedSpec = JSON.parse(fs.readFileSync(cachedSpecPath, "utf-8"));
    fs.copyFileSync(cachedImagePath, refScreenshotPath);
    return { spec, refScreenshotPath };
  }

  const headers = { "X-Figma-Token": token };

  // Fetch nodes + best-effort local variables in parallel
  const nodeApiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const imageApiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(
    nodeId
  )}&scale=2&format=png&use_absolute_bounds=true`;

  const [nodeRes, imgRes, variablesMap] = await Promise.all([
    fetch(nodeApiUrl, { headers }),
    fetch(imageApiUrl, { headers }),
    tryFetchLocalVariables(fileKey, token),
  ]);

  if (!nodeRes.ok) {
    throw new Error(`Figma API error (${nodeRes.status}): ${await nodeRes.text()}`);
  }
  const nodeData: any = await nodeRes.json();
  const rootNode =
    nodeData.nodes?.[nodeId]?.document ||
    (Object.values(nodeData.nodes || {})[0] as any)?.document;
  if (!rootNode) {
    throw new Error(`Node '${nodeId}' not found in Figma file '${fileKey}'`);
  }

  if (!imgRes.ok) {
    throw new Error(`Figma Image API error (${imgRes.status}): ${await imgRes.text()}`);
  }
  const imgData: any = await imgRes.json();
  const imageUrl = imgData.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`No image URL returned from Figma for node '${nodeId}'`);
  }

  const downloadRes = await fetch(imageUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download Figma image (${downloadRes.status})`);
  }
  const arrayBuffer = await downloadRes.arrayBuffer();
  fs.writeFileSync(refScreenshotPath, Buffer.from(arrayBuffer));
  fs.writeFileSync(cachedImagePath, Buffer.from(arrayBuffer));

  const rootBbox = rootNode.absoluteBoundingBox || rootNode.absoluteRenderBounds || { x: 0, y: 0 };
  const nodes: NodeSpec[] = [];
  traverseFigmaNode(rootNode, { x: rootBbox.x, y: rootBbox.y }, nodes, variablesMap);

  const spec: NormalizedSpec = {
    adapter: "figma",
    viewport: config.viewport,
    nodes,
    imagePath: refScreenshotPath,
  };

  fs.writeFileSync(cachedSpecPath, JSON.stringify(spec, null, 2), "utf-8");

  return { spec, refScreenshotPath };
}
