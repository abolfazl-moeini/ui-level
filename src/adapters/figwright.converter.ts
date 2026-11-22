import type {
  NodeSpec,
  NormalizedSpec,
  StyleSpec,
  ViewportConfig,
} from "../schema.js";

export interface FigwrightConversionResult {
  spec: NormalizedSpec;
  warnings: string[];
  meta: {
    rootNodeId?: string;
    rootNodeName?: string;
    colorProfile?: "SRGB" | "DISPLAY_P3" | "LEGACY";
    hasDedupedNodes: boolean;
    hasTruncatedNodes: boolean;
  };
}

export function isNormalizedSpec(raw: unknown): raw is NormalizedSpec {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (
    (obj.adapter === "figma" || obj.adapter === "html" || obj.adapter === "image") &&
    Array.isArray(obj.nodes)
  ) {
    if (obj.nodes.length === 0) return false;
    return obj.nodes.every(
      (n: any) =>
        n &&
        typeof n === "object" &&
        n.rect &&
        typeof n.rect.x === "number" &&
        typeof n.rect.y === "number" &&
        typeof n.rect.width === "number" &&
        typeof n.rect.height === "number" &&
        n.styles &&
        typeof n.styles === "object"
    );
  }
  return false;
}

export function isFigwrightPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  if (isNormalizedSpec(raw)) return false;

  const obj = raw as Record<string, unknown>;

  // 1. Figwright design_diff snapshot wrapper ({ formatVersion: number, context: { ... } })
  if (
    typeof obj.formatVersion === "number" &&
    obj.context &&
    typeof obj.context === "object"
  ) {
    return true;
  }

  // 2. Figwright get_node result wrapper ({ node: SerializedNode })
  if (obj.node && typeof obj.node === "object" && typeof (obj.node as any).type === "string") {
    return true;
  }

  // 3. Figwright get_design_context result ({ nodes: DesignContextNode[], ... })
  if (Array.isArray(obj.nodes)) {
    if (obj.sectionPlan || obj.globalVars || obj.metrics) return true;
    const first = obj.nodes[0] as any;
    if (
      first &&
      typeof first.id === "string" &&
      typeof first.type === "string" &&
      !first.rect
    ) {
      return true;
    }
  }

  // 4. Single DesignContextNode or SerializedNode without absoluteBoundingBox
  if (
    typeof obj.id === "string" &&
    typeof obj.type === "string" &&
    (typeof obj.width === "number" || typeof obj.name === "string") &&
    !obj.absoluteBoundingBox &&
    !obj.absoluteRenderBounds &&
    !obj.document
  ) {
    return true;
  }

  return false;
}

export function parseHexOrRgbColor(
  input: unknown,
  opacityOverride: number = 1
): string | undefined {
  if (!input) return undefined;

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("#")) {
      let hex = trimmed.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        hex = hex
          .split("")
          .map((c) => c + c)
          .join("");
      }
      if (hex.length === 6 || hex.length === 8) {
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
          return undefined;
        }
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        let a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
        a = Number((a * opacityOverride).toFixed(2));
        return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
      }
      return undefined;
    }
    const rgbMatch = trimmed.match(
      /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i
    );
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      const baseA = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
      const a = Number((baseA * opacityOverride).toFixed(2));
      return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return undefined;
  }

  if (typeof input === "object" && input !== null) {
    const c = input as { r?: number; g?: number; b?: number; a?: number };
    if (typeof c.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
      const r = Math.round(c.r * 255);
      const g = Math.round(c.g * 255);
      const b = Math.round(c.b * 255);
      let a = c.a !== undefined ? c.a * opacityOverride : opacityOverride;
      a = Number(a.toFixed(2));
      return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
    }
  }

  return undefined;
}

export function mapFontStyleToWeight(
  fontStyle?: string,
  variationSettings?: Record<string, number>
): number | undefined {
  if (variationSettings && typeof variationSettings.wght === "number") {
    return Math.round(variationSettings.wght);
  }

  if (!fontStyle) return undefined;
  const s = fontStyle.toLowerCase().replace(/[\s-_]+/g, "");

  if (s.includes("thin") || s.includes("hairline")) return 100;
  if (s.includes("extralight") || s.includes("ultralight")) return 200;
  if (s.includes("light")) return 300;
  if (s.includes("regular") || s.includes("normal") || s.includes("book") || s.includes("plain"))
    return 400;
  if (s.includes("medium")) return 500;
  if (s.includes("semibold") || s.includes("demibold")) return 600;
  if (s.includes("extrabold") || s.includes("ultrabold")) return 800;
  if (s.includes("bold")) return 700;
  if (s.includes("black") || s.includes("heavy")) return 900;

  return undefined;
}

export function convertFigwrightToNormalizedSpec(
  raw: unknown,
  viewport: ViewportConfig = { width: 1280, height: 800, deviceScaleFactor: 2 },
  imagePath?: string
): FigwrightConversionResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Figwright spec: expected an object.");
  }

  const warnings: string[] = [];
  let payload: any = raw;

  // 1. Unwrap design_diff snapshot
  if (typeof payload.formatVersion === "number" && payload.context) {
    payload = payload.context;
  }

  // 2. Unwrap get_node wrapper
  if (payload.node && typeof payload.node === "object") {
    payload = { nodes: [payload.node] };
  } else if (!Array.isArray(payload.nodes) && payload.id && payload.type) {
    payload = { nodes: [payload] };
  }

  // 3. Completeness guardrail for sectionPlan
  if (payload.sectionPlan) {
    throw new Error(
      "Figwright spec contains a 'sectionPlan' stub (tree exceeded token budget) with no layout or style data. Re-run get_design_context per section nodeId with { detail: 'full', dedupeComponents: false }."
    );
  }

  if (payload.colorProfile === "DISPLAY_P3") {
    warnings.push(
      "Figwright document uses DISPLAY_P3 color profile; raw hex values represent P3 channels (color(display-p3 ...))."
    );
  }

  const globalVars = payload.globalVars || {};
  const globalStyles = globalVars.styles || {};
  const rawNodes: any[] = Array.isArray(payload.nodes) ? payload.nodes : [];

  if (rawNodes.length === 0) {
    throw new Error("Figwright spec contains zero renderable nodes.");
  }

  const rootNode = rawNodes[0];
  const rootBbox = rootNode.absoluteBoundingBox || rootNode.absoluteRenderBounds;
  const rootW = typeof rootNode.width === "number" ? rootNode.width : rootBbox?.width;
  const rootH = typeof rootNode.height === "number" ? rootNode.height : rootBbox?.height;

  if (typeof rootW !== "number" || typeof rootH !== "number") {
    throw new Error(
      `Figwright spec appears to be captured with detail: 'minimal' (missing width/height on root node '${rootNode.id || "unknown"}'). Re-run get_design_context with { detail: 'full', dedupeComponents: false }.`
    );
  }

  if (rawNodes.length > 1) {
    warnings.push(
      `Figwright payload contains ${rawNodes.length} top-level nodes; verifying first root '${rootNode.id}'. Pass a single nodeId for deterministic verification.`
    );
  }

  const rootNodeId = rootNode.id;
  const rootNodeName = rootNode.name;
  const dedupedNodeIds: string[] = [];
  const truncatedNodeIds: string[] = [];

  const outNodes: NodeSpec[] = [];

  function resolveSolidPaintColor(paint: any, currentNodeId: string = rootNodeId): string | undefined {
    if (!paint || paint.visible === false) return undefined;
    if (paint.type !== "SOLID") {
      warnings.push(
        `Unsupported paint type '${paint.type}' on node '${currentNodeId}'; only SOLID fills/strokes are currently verified.`
      );
      return undefined;
    }
    const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
    return parseHexOrRgbColor(paint.color, opacity);
  }

  function resolvePaints(node: any, kind: "fill" | "stroke"): string | undefined {
    const currentNodeId = node.id || rootNodeId;
    // 1. Check ref in globalVars
    const refKey = kind === "fill" ? node.fill : node.stroke;
    if (refKey && globalStyles[refKey]) {
      const paintBundle = globalStyles[refKey];
      const paints = Array.isArray(paintBundle) ? paintBundle : [paintBundle];
      for (const p of paints) {
        const c = resolveSolidPaintColor(p, currentNodeId);
        if (c) return c;
      }
    }

    // 2. Check inline paints
    const inlinePaints = kind === "fill" ? node.fills : node.strokes;
    if (Array.isArray(inlinePaints)) {
      for (const p of inlinePaints) {
        const c = resolveSolidPaintColor(p, currentNodeId);
        if (c) return c;
      }
    }

    return undefined;
  }

  function traverseNode(
    node: any,
    depth: number,
    frameOrigin: { x: number; y: number }
  ): void {
    if (node.visible === false) return;

    if (node.deduped === true) {
      dedupedNodeIds.push(node.id);
    }
    if (node.truncated === true) {
      truncatedNodeIds.push(node.id);
    }

    const nodeBbox = node.absoluteBoundingBox || node.absoluteRenderBounds;
    const width = Number((node.width ?? nodeBbox?.width ?? 0).toFixed(2));
    const height = Number((node.height ?? nodeBbox?.height ?? 0).toFixed(2));
    const nodeX = node.x ?? nodeBbox?.x ?? 0;
    const nodeY = node.y ?? nodeBbox?.y ?? 0;

    let nodeAbsX: number;
    let nodeAbsY: number;

    const isGroup = node.type === "GROUP" || node.type === "BOOLEAN_OPERATION";

    if (depth === 0) {
      nodeAbsX = 0;
      nodeAbsY = 0;
    } else {
      nodeAbsX = Number((frameOrigin.x + nodeX).toFixed(2));
      nodeAbsY = Number((frameOrigin.y + nodeY).toFixed(2));
    }

    const styles: StyleSpec = {
      width,
      height,
    };

    // Auto Layout / Positioning
    const layout = node.layout ?? node;
    if (layout) {
      if (typeof layout.paddingTop === "number") styles.paddingTop = layout.paddingTop;
      if (typeof layout.paddingRight === "number") styles.paddingRight = layout.paddingRight;
      if (typeof layout.paddingBottom === "number") styles.paddingBottom = layout.paddingBottom;
      if (typeof layout.paddingLeft === "number") styles.paddingLeft = layout.paddingLeft;

      const mode = layout.mode ?? node.layoutMode;
      if (mode === "VERTICAL") {
        styles.display = "flex";
        styles.flexDirection = "column";
        if (typeof layout.itemSpacing === "number") styles.rowGap = layout.itemSpacing;
      } else if (mode === "HORIZONTAL") {
        styles.display = "flex";
        styles.flexDirection = "row";
        if (typeof layout.itemSpacing === "number") styles.columnGap = layout.itemSpacing;
      } else if (mode === "GRID") {
        styles.display = "grid";
        if (typeof layout.gridRowGap === "number") styles.rowGap = layout.gridRowGap;
        if (typeof layout.gridColumnGap === "number") styles.columnGap = layout.gridColumnGap;
      }
    }

    // Border radiuses
    if (typeof node.cornerRadius === "number") {
      styles.borderTopLeftRadius = node.cornerRadius;
      styles.borderTopRightRadius = node.cornerRadius;
      styles.borderBottomRightRadius = node.cornerRadius;
      styles.borderBottomLeftRadius = node.cornerRadius;
    } else if (node.cornerRadii && typeof node.cornerRadii === "object") {
      if (typeof node.cornerRadii.topLeft === "number")
        styles.borderTopLeftRadius = node.cornerRadii.topLeft;
      if (typeof node.cornerRadii.topRight === "number")
        styles.borderTopRightRadius = node.cornerRadii.topRight;
      if (typeof node.cornerRadii.bottomRight === "number")
        styles.borderBottomRightRadius = node.cornerRadii.bottomRight;
      if (typeof node.cornerRadii.bottomLeft === "number")
        styles.borderBottomLeftRadius = node.cornerRadii.bottomLeft;
    } else if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
      styles.borderTopLeftRadius = node.rectangleCornerRadii[0];
      styles.borderTopRightRadius = node.rectangleCornerRadii[1];
      styles.borderBottomRightRadius = node.rectangleCornerRadii[2];
      styles.borderBottomLeftRadius = node.rectangleCornerRadii[3];
    }

    // Border strokes
    const hasStrokes = Boolean(
      node.stroke || (Array.isArray(node.strokes) && node.strokes.length > 0)
    );
    if (hasStrokes) {
      if (typeof node.strokeWeight === "number") {
        styles.borderTopWidth = node.strokeWeight;
        styles.borderRightWidth = node.strokeWeight;
        styles.borderBottomWidth = node.strokeWeight;
        styles.borderLeftWidth = node.strokeWeight;
      } else if (node.strokeWeights && typeof node.strokeWeights === "object") {
        if (typeof node.strokeWeights.top === "number")
          styles.borderTopWidth = node.strokeWeights.top;
        if (typeof node.strokeWeights.right === "number")
          styles.borderRightWidth = node.strokeWeights.right;
        if (typeof node.strokeWeights.bottom === "number")
          styles.borderBottomWidth = node.strokeWeights.bottom;
        if (typeof node.strokeWeights.left === "number")
          styles.borderLeftWidth = node.strokeWeights.left;
      }
    }

    // Fills (Color / BackgroundColor)
    const fillColor = resolvePaints(node, "fill");
    if (fillColor) {
      if (node.type === "TEXT") {
        styles.color = fillColor;
      } else {
        styles.backgroundColor = fillColor;
      }
    }

    // Typography
    const textBundle =
      (node.textStyle ? globalStyles[node.textStyle] : undefined) || {};

    const fontFamily =
      textBundle.fontFamily ??
      (typeof node.fontName === "object" ? node.fontName?.family : undefined) ??
      node.style?.fontFamily;
    if (fontFamily) styles.fontFamily = fontFamily;

    const fontSize =
      (typeof textBundle.fontSize === "number" ? textBundle.fontSize : undefined) ??
      (typeof node.fontSize === "number" ? node.fontSize : undefined) ??
      node.style?.fontSize;
    if (typeof fontSize === "number") styles.fontSize = fontSize;

    const fontStyle =
      textBundle.fontStyle ??
      (typeof node.fontName === "object" ? node.fontName?.style : undefined);
    const variationSettings =
      textBundle.fontVariationSettings ??
      (typeof node.fontName === "object" ? node.fontName?.variationSettings : undefined);

    const fontWeight =
      mapFontStyleToWeight(fontStyle, variationSettings) ??
      (typeof node.style?.fontWeight === "number" ? node.style.fontWeight : undefined);
    if (typeof fontWeight === "number") styles.fontWeight = fontWeight;

    // Line Height
    const rawLh = textBundle.lineHeight ?? node.lineHeight ?? node.style?.lineHeightPx;
    if (rawLh && typeof rawLh === "object") {
      if (rawLh.unit === "PIXELS" && typeof rawLh.value === "number") {
        styles.lineHeight = Number(rawLh.value.toFixed(1));
      } else if (
        rawLh.unit === "PERCENT" &&
        typeof rawLh.value === "number" &&
        typeof styles.fontSize === "number"
      ) {
        styles.lineHeight = Number(((styles.fontSize * rawLh.value) / 100).toFixed(1));
      } else if (rawLh.unit === "AUTO") {
        const px =
          typeof node.style?.lineHeightPx === "number"
            ? node.style.lineHeightPx
            : typeof node.lineHeightPx === "number"
            ? node.lineHeightPx
            : typeof styles.fontSize === "number"
            ? styles.fontSize * 1.2
            : undefined;
        if (typeof px === "number") {
          styles.lineHeight = Number(px.toFixed(1));
        }
      }
    } else if (typeof rawLh === "number") {
      styles.lineHeight = Number(rawLh.toFixed(1));
    }

    // Letter Spacing
    const rawLs = textBundle.letterSpacing ?? node.letterSpacing ?? node.style?.letterSpacing;
    if (rawLs && typeof rawLs === "object") {
      if (rawLs.unit === "PIXELS" && typeof rawLs.value === "number") {
        styles.letterSpacing = Number(rawLs.value.toFixed(2));
      } else if (
        rawLs.unit === "PERCENT" &&
        typeof rawLs.value === "number" &&
        typeof styles.fontSize === "number"
      ) {
        styles.letterSpacing = Number(((styles.fontSize * rawLs.value) / 100).toFixed(2));
      } else if (rawLs.unit === "AUTO") {
        const px =
          typeof node.style?.letterSpacing === "number"
            ? node.style.letterSpacing
            : typeof node.letterSpacingPx === "number"
            ? node.letterSpacingPx
            : 0;
        styles.letterSpacing = Number(px.toFixed(2));
      }
    } else if (typeof rawLs === "number") {
      styles.letterSpacing = Number(rawLs.toFixed(2));
    }

    const textContent =
      typeof node.characters === "string"
        ? node.characters.trim() || undefined
        : undefined;

    outNodes.push({
      id: node.id,
      figmaId: node.id,
      selector: `[data-figma-id="${node.id}"]`,
      tagName: node.type?.toLowerCase(),
      rect: {
        x: nodeAbsX,
        y: nodeAbsY,
        width,
        height,
      },
      styles,
      text: textContent,
    });

    // Next child coordinate frame origin
    let nextOrigin: { x: number; y: number };
    if (depth === 0) {
      if (isGroup) {
        nextOrigin = { x: -(node.x ?? 0), y: -(node.y ?? 0) };
      } else {
        nextOrigin = { x: 0, y: 0 };
      }
    } else {
      if (isGroup) {
        // Group children are relative to the group's parent container
        nextOrigin = frameOrigin;
      } else {
        nextOrigin = { x: nodeAbsX, y: nodeAbsY };
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        traverseNode(child, depth + 1, nextOrigin);
      }
    }
  }

  traverseNode(rootNode, 0, { x: 0, y: 0 });

  if (dedupedNodeIds.length > 0) {
    warnings.push(
      `Figwright context contains ${dedupedNodeIds.length} deduped instance(s) (${dedupedNodeIds
        .slice(0, 3)
        .join(", ")}${dedupedNodeIds.length > 3 ? "..." : ""}). For full verification coverage, capture with get_design_context({ detail: "full", dedupeComponents: false }).`
    );
  }

  if (truncatedNodeIds.length > 0) {
    warnings.push(
      `Figwright context has ${truncatedNodeIds.length} truncated subtree(s) reaching the depth limit. Set depth: 0 for full tree verification.`
    );
  }

  return {
    spec: {
      adapter: "figma",
      viewport,
      nodes: outNodes,
      imagePath,
    },
    warnings,
    meta: {
      rootNodeId,
      rootNodeName,
      colorProfile: payload.colorProfile,
      hasDedupedNodes: dedupedNodeIds.length > 0,
      hasTruncatedNodes: truncatedNodeIds.length > 0,
    },
  };
}
