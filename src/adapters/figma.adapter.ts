import path from "node:path";
import fs from "node:fs";
import type { NormalizedSpec, NodeSpec, StyleSpec, UILevelConfig } from "../schema.js";

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

function parseFigmaColor(
  color: { r: number; g: number; b: number; a?: number },
  opacity: number = 1
): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a !== undefined ? color.a * opacity : opacity;
  return a >= 0.999
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
}

function resolveColorWithVariables(
  fill: any,
  variablesMap: Map<string, { r: number; g: number; b: number; a?: number }>
): string | undefined {
  const varId = fill?.boundVariables?.color?.id;
  if (varId && variablesMap.has(varId)) {
    return parseFigmaColor(variablesMap.get(varId)!, fill.opacity);
  }
  if (fill?.color) {
    return parseFigmaColor(fill.color, fill.opacity);
  }
  return undefined;
}

function traverseFigmaNode(
  node: any,
  parentOrigin: { x: number; y: number },
  nodes: NodeSpec[],
  variablesMap: Map<string, { r: number; g: number; b: number; a?: number }>
): void {
  if (node.visible === false) return;

  const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
  if (!bbox) return;

  const width = Number(bbox.width.toFixed(2));
  const height = Number(bbox.height.toFixed(2));
  const x = Number((bbox.x - parentOrigin.x).toFixed(2));
  const y = Number((bbox.y - parentOrigin.y).toFixed(2));

  const styles: StyleSpec = {
    width,
    height,
  };

  if (node.paddingTop !== undefined) styles.paddingTop = node.paddingTop;
  if (node.paddingRight !== undefined) styles.paddingRight = node.paddingRight;
  if (node.paddingBottom !== undefined) styles.paddingBottom = node.paddingBottom;
  if (node.paddingLeft !== undefined) styles.paddingLeft = node.paddingLeft;

  if (node.itemSpacing !== undefined) {
    if (node.layoutMode === "VERTICAL") {
      styles.rowGap = node.itemSpacing;
    } else if (node.layoutMode === "HORIZONTAL") {
      styles.columnGap = node.itemSpacing;
    }
  }

  if (node.cornerRadius !== undefined) {
    styles.borderTopLeftRadius = node.cornerRadius;
    styles.borderTopRightRadius = node.cornerRadius;
    styles.borderBottomRightRadius = node.cornerRadius;
    styles.borderBottomLeftRadius = node.cornerRadius;
  } else if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
    styles.borderTopLeftRadius = node.rectangleCornerRadii[0];
    styles.borderTopRightRadius = node.rectangleCornerRadii[1];
    styles.borderBottomRightRadius = node.rectangleCornerRadii[2];
    styles.borderBottomLeftRadius = node.rectangleCornerRadii[3];
  }

  if (node.strokeWeight !== undefined && Array.isArray(node.strokes) && node.strokes.length > 0) {
    styles.borderTopWidth = node.strokeWeight;
    styles.borderRightWidth = node.strokeWeight;
    styles.borderBottomWidth = node.strokeWeight;
    styles.borderLeftWidth = node.strokeWeight;
  }

  if (Array.isArray(node.fills)) {
    const solidFill = node.fills.find((f: any) => f.type === "SOLID" && f.visible !== false);
    if (solidFill) {
      const resolved = resolveColorWithVariables(solidFill, variablesMap);
      if (resolved) {
        if (node.type === "TEXT") {
          styles.color = resolved;
        } else {
          styles.backgroundColor = resolved;
        }
      }
    }
  }

  if (node.type === "TEXT" && node.style) {
    const s = node.style;
    if (s.fontFamily) styles.fontFamily = s.fontFamily;
    if (s.fontSize) styles.fontSize = s.fontSize;
    if (s.fontWeight) styles.fontWeight = s.fontWeight;
    if (s.lineHeightPx) styles.lineHeight = Number(s.lineHeightPx.toFixed(1));
    if (s.letterSpacing !== undefined) styles.letterSpacing = Number(s.letterSpacing.toFixed(2));
  }

  const selector = `[data-figma-id="${node.id}"]`;

  nodes.push({
    id: node.id,
    figmaId: node.id,
    selector,
    tagName: node.type?.toLowerCase(),
    rect: { x, y, width, height },
    styles,
    text: typeof node.characters === "string" ? node.characters.trim() || undefined : undefined,
  });

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      traverseFigmaNode(child, parentOrigin, nodes, variablesMap);
    }
  }
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

export async function processFigmaReference(
  config: UILevelConfig,
  outputDir: string,
  options: FigmaAdapterOptions = {}
): Promise<FigmaAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  const refSpecPath =
    options.refSpecPath ||
    config.refSpec ||
    (config.ref?.endsWith(".json") ? config.ref : undefined);
  const refImagePath =
    options.refImagePath ||
    config.refImage ||
    (config.ref?.endsWith(".png") ? config.ref : undefined);

  // 1. Offline Mode: Local spec &/or image provided (for Figma MCP or offline bundles)
  if (refSpecPath || refImagePath) {
    let spec: NormalizedSpec = {
      adapter: "figma",
      viewport: config.viewport,
      nodes: [],
      imagePath: refScreenshotPath,
    };

    if (refSpecPath) {
      if (!fs.existsSync(refSpecPath)) {
        throw new Error(`Figma offline spec file not found: ${refSpecPath}`);
      }
      const rawSpec = JSON.parse(fs.readFileSync(refSpecPath, "utf-8"));
      if (Array.isArray(rawSpec.nodes)) {
        spec = rawSpec;
      } else if (rawSpec.document || rawSpec.absoluteBoundingBox) {
        // Raw Figma REST / MCP node JSON
        const rootNode = rawSpec.document || rawSpec;
        const rootBbox = rootNode.absoluteBoundingBox || rootNode.absoluteRenderBounds || { x: 0, y: 0 };
        const nodes: NodeSpec[] = [];
        traverseFigmaNode(rootNode, { x: rootBbox.x, y: rootBbox.y }, nodes, new Map());
        spec = {
          adapter: "figma",
          viewport: config.viewport,
          nodes,
          imagePath: refScreenshotPath,
        };
      }
    }

    if (refImagePath) {
      if (!fs.existsSync(refImagePath)) {
        throw new Error(`Figma offline reference image not found: ${refImagePath}`);
      }
      fs.copyFileSync(refImagePath, refScreenshotPath);
    } else if (!fs.existsSync(refScreenshotPath)) {
      throw new Error(
        "Figma offline spec mode requires an associated reference PNG via --ref-image or config.refImage."
      );
    }

    return { spec, refScreenshotPath };
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
  const rootNode = nodeData.nodes?.[nodeId]?.document;
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
