import type {
  NormalizedSpec,
  NodeSpec,
  StyleSpec,
  ViewportConfig,
} from "../schema.js";

export function extractFigmaRestRootNode(rawSpec: any): any | undefined {
  if (!rawSpec || typeof rawSpec !== "object") return undefined;
  if (rawSpec.document && typeof rawSpec.document === "object") {
    return rawSpec.document;
  }
  if (rawSpec.absoluteBoundingBox || rawSpec.absoluteRenderBounds) {
    return rawSpec;
  }
  // Real Figma REST API: GET /v1/files/:key/nodes?ids=... -> { nodes: { "1:2": { document: { ... } } } }
  if (rawSpec.nodes && typeof rawSpec.nodes === "object" && !Array.isArray(rawSpec.nodes)) {
    const firstEntry = Object.values(rawSpec.nodes)[0] as any;
    if (firstEntry?.document) return firstEntry.document;
    if (firstEntry?.absoluteBoundingBox || firstEntry?.absoluteRenderBounds) return firstEntry;
  }
  // Wrapped array variant: { nodes: [{ document: { ... } }] }
  if (Array.isArray(rawSpec.nodes) && rawSpec.nodes.length > 0) {
    if (rawSpec.nodes[0]?.document) return rawSpec.nodes[0].document;
    if (rawSpec.nodes[0]?.absoluteBoundingBox || rawSpec.nodes[0]?.absoluteRenderBounds) return rawSpec.nodes[0];
  }
  return undefined;
}

export function isFigmaRestPayload(rawSpec: unknown): boolean {
  return Boolean(extractFigmaRestRootNode(rawSpec));
}

export function parseFigmaColor(
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

export function resolveColorWithVariables(
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

export function traverseFigmaNode(
  node: any,
  parentOrigin: { x: number; y: number },
  nodes: NodeSpec[],
  variablesMap: Map<string, { r: number; g: number; b: number; a?: number }>
): void {
  if (node.visible === false) return;

  const bbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
  if (!bbox) {
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        traverseFigmaNode(child, parentOrigin, nodes, variablesMap);
      }
    }
    return;
  }

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

export function convertFigmaRestToNormalizedSpec(
  rawSpec: any,
  viewport: ViewportConfig = { width: 1280, height: 800, deviceScaleFactor: 2 },
  imagePath?: string,
  variablesMap: Map<string, { r: number; g: number; b: number; a?: number }> = new Map()
): NormalizedSpec {
  const rootNode = extractFigmaRestRootNode(rawSpec);
  if (!rootNode) {
    throw new Error("Unable to extract valid root node from Figma REST payload.");
  }
  const rootBbox =
    rootNode.absoluteBoundingBox || rootNode.absoluteRenderBounds || { x: 0, y: 0 };
  const nodes: NodeSpec[] = [];
  traverseFigmaNode(rootNode, { x: rootBbox.x, y: rootBbox.y }, nodes, variablesMap);
  return {
    adapter: "figma",
    viewport,
    nodes,
    imagePath,
  };
}
