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

function parseFigmaColor(color: { r: number; g: number; b: number; a?: number }, opacity: number = 1): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a !== undefined ? color.a * opacity : opacity;
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
}

function traverseFigmaNode(
  node: any,
  parentOrigin: { x: number; y: number },
  nodes: NodeSpec[]
): void {
  const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
  if (!bbox) return;

  const width = bbox.width;
  const height = bbox.height;
  const x = bbox.x - parentOrigin.x;
  const y = bbox.y - parentOrigin.y;

  const styles: StyleSpec = {
    width,
    height,
  };

  // Padding from AutoLayout
  if (node.paddingTop !== undefined) styles.paddingTop = node.paddingTop;
  if (node.paddingRight !== undefined) styles.paddingRight = node.paddingRight;
  if (node.paddingBottom !== undefined) styles.paddingBottom = node.paddingBottom;
  if (node.paddingLeft !== undefined) styles.paddingLeft = node.paddingLeft;

  // Gaps
  if (node.itemSpacing !== undefined) {
    if (node.layoutMode === "VERTICAL") {
      styles.rowGap = node.itemSpacing;
    } else if (node.layoutMode === "HORIZONTAL") {
      styles.columnGap = node.itemSpacing;
    }
  }

  // Corner radius
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

  // Borders
  if (node.strokeWeight !== undefined && Array.isArray(node.strokes) && node.strokes.length > 0) {
    styles.borderTopWidth = node.strokeWeight;
    styles.borderRightWidth = node.strokeWeight;
    styles.borderBottomWidth = node.strokeWeight;
    styles.borderLeftWidth = node.strokeWeight;
  }

  // Background color from fills
  if (Array.isArray(node.fills)) {
    const solidFill = node.fills.find((f: any) => f.type === "SOLID" && f.visible !== false);
    if (solidFill && solidFill.color) {
      if (node.type === "TEXT") {
        styles.color = parseFigmaColor(solidFill.color, solidFill.opacity);
      } else {
        styles.backgroundColor = parseFigmaColor(solidFill.color, solidFill.opacity);
      }
    }
  }

  // Typography
  if (node.type === "TEXT" && node.style) {
    const s = node.style;
    if (s.fontFamily) styles.fontFamily = s.fontFamily;
    if (s.fontSize) styles.fontSize = s.fontSize;
    if (s.fontWeight) styles.fontWeight = s.fontWeight;
    if (s.lineHeightPx) styles.lineHeight = Number(s.lineHeightPx.toFixed(1));
    if (s.letterSpacing) styles.letterSpacing = s.letterSpacing;
  }

  const cleanName = (node.name || "node").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const selector = `[data-figma-id="${node.id}"]`;

  nodes.push({
    id: node.id,
    selector,
    tagName: node.type?.toLowerCase(),
    rect: { x, y, width, height },
    styles,
    text: node.characters || undefined,
  });

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      traverseFigmaNode(child, parentOrigin, nodes);
    }
  }
}

export async function processFigmaReference(
  config: UILevelConfig,
  outputDir: string,
  options: FigmaAdapterOptions = {}
): Promise<FigmaAdapterResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const refScreenshotPath = path.join(outputDir, "ref.png");

  // 1. Offline Mode: Local spec & image provided
  if (options.refSpecPath && fs.existsSync(options.refSpecPath)) {
    const rawSpec = fs.readFileSync(options.refSpecPath, "utf-8");
    const spec: NormalizedSpec = JSON.parse(rawSpec);
    if (options.refImagePath && fs.existsSync(options.refImagePath)) {
      fs.copyFileSync(options.refImagePath, refScreenshotPath);
    }
    return { spec, refScreenshotPath };
  }

  const token = options.token || config.figma?.token || process.env.FIGMA_TOKEN;
  const fileKey = options.fileKey || config.figma?.fileKey;
  const nodeId = options.nodeId || config.figma?.nodeId;

  if (!token || !fileKey || !nodeId) {
    throw new Error(
      "Figma adapter requires 'token', 'fileKey', and 'nodeId' (via config or environment variable FIGMA_TOKEN)."
    );
  }

  const cacheDir = path.join(outputDir, "cache", "figma");
  fs.mkdirSync(cacheDir, { recursive: true });
  const sanitizedNodeId = nodeId.replace(/[:]/g, "_");
  const cachedSpecPath = path.join(cacheDir, `${fileKey}_${sanitizedNodeId}_spec.json`);
  const cachedImagePath = path.join(cacheDir, `${fileKey}_${sanitizedNodeId}_ref.png`);

  if (fs.existsSync(cachedSpecPath) && fs.existsSync(cachedImagePath)) {
    const spec: NormalizedSpec = JSON.parse(fs.readFileSync(cachedSpecPath, "utf-8"));
    fs.copyFileSync(cachedImagePath, refScreenshotPath);
    return { spec, refScreenshotPath };
  }

  const headers = { "X-Figma-Token": token };

  // Fetch nodes
  const nodeApiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const nodeRes = await fetch(nodeApiUrl, { headers });
  if (!nodeRes.ok) {
    throw new Error(`Figma API error (${nodeRes.status}): ${await nodeRes.text()}`);
  }
  const nodeData: any = await nodeRes.json();
  const rootNode = nodeData.nodes?.[nodeId]?.document;
  if (!rootNode) {
    throw new Error(`Node '${nodeId}' not found in Figma file '${fileKey}'`);
  }

  // Fetch image with use_absolute_bounds=true
  const imageApiUrl = `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(
    nodeId
  )}&scale=2&format=png&use_absolute_bounds=true`;
  const imgRes = await fetch(imageApiUrl, { headers });
  if (!imgRes.ok) {
    throw new Error(`Figma Image API error (${imgRes.status}): ${await imgRes.text()}`);
  }
  const imgData: any = await imgRes.json();
  const imageUrl = imgData.images?.[nodeId];
  if (!imageUrl) {
    throw new Error(`No image URL returned from Figma for node '${nodeId}'`);
  }

  // Download image
  const downloadRes = await fetch(imageUrl);
  if (!downloadRes.ok) {
    throw new Error(`Failed to download Figma image (${downloadRes.status})`);
  }
  const arrayBuffer = await downloadRes.arrayBuffer();
  fs.writeFileSync(refScreenshotPath, Buffer.from(arrayBuffer));
  fs.writeFileSync(cachedImagePath, Buffer.from(arrayBuffer));

  // Traverse node tree
  const rootBbox = rootNode.absoluteBoundingBox || rootNode.absoluteRenderBounds || { x: 0, y: 0 };
  const nodes: NodeSpec[] = [];
  traverseFigmaNode(rootNode, { x: rootBbox.x, y: rootBbox.y }, nodes);

  const spec: NormalizedSpec = {
    adapter: "figma",
    viewport: config.viewport,
    nodes,
    imagePath: refScreenshotPath,
  };

  fs.writeFileSync(cachedSpecPath, JSON.stringify(spec, null, 2), "utf-8");

  return { spec, refScreenshotPath };
}
