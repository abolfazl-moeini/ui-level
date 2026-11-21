import { z } from "zod";

export const ViewportSchema = z.object({
  width: z.number().int().positive().default(1280),
  height: z.number().int().positive().default(800),
  deviceScaleFactor: z.number().positive().default(2),
});

export type ViewportConfig = z.infer<typeof ViewportSchema>;

export const GeometryRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export type GeometryRect = z.infer<typeof GeometryRectSchema>;

export const StyleSpecSchema = z.object({
  paddingTop: z.number().optional(),
  paddingRight: z.number().optional(),
  paddingBottom: z.number().optional(),
  paddingLeft: z.number().optional(),

  marginTop: z.number().optional(),
  marginRight: z.number().optional(),
  marginBottom: z.number().optional(),
  marginLeft: z.number().optional(),

  borderTopWidth: z.number().optional(),
  borderRightWidth: z.number().optional(),
  borderBottomWidth: z.number().optional(),
  borderLeftWidth: z.number().optional(),

  borderTopLeftRadius: z.number().optional(),
  borderTopRightRadius: z.number().optional(),
  borderBottomRightRadius: z.number().optional(),
  borderBottomLeftRadius: z.number().optional(),

  rowGap: z.number().optional(),
  columnGap: z.number().optional(),

  fontSize: z.number().optional(),
  lineHeight: z.number().optional(),
  fontWeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  fontFamily: z.string().optional(),

  color: z.string().optional(),
  backgroundColor: z.string().optional(),

  display: z.string().optional(),
  flexDirection: z.string().optional(),
  justifyContent: z.string().optional(),
  alignItems: z.string().optional(),

  width: z.number().optional(),
  height: z.number().optional(),
});

export type StyleSpec = z.infer<typeof StyleSpecSchema>;

export const NodeSpecSchema = z.object({
  id: z.string(),
  selector: z.string(),
  tagName: z.string().optional(),
  rect: GeometryRectSchema,
  styles: StyleSpecSchema,
  text: z.string().optional(),
  textRects: z.array(GeometryRectSchema).optional(),
});

export type NodeSpec = z.infer<typeof NodeSpecSchema>;

export const NormalizedSpecSchema = z.object({
  adapter: z.enum(["html", "figma", "image"]),
  viewport: ViewportSchema,
  nodes: z.array(NodeSpecSchema),
  imagePath: z.string().optional(),
});

export type NormalizedSpec = z.infer<typeof NormalizedSpecSchema>;

export const CssRuleSourceSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  selector: z.string().optional(),
  cssText: z.string().optional(),
});

export type CssRuleSource = z.infer<typeof CssRuleSourceSchema>;

export const StyleViolationSchema = z.object({
  selector: z.string(),
  property: z.string(),
  expected: z.union([z.string(), z.number()]),
  actual: z.union([z.string(), z.number()]),
  delta: z.union([z.string(), z.number()]),
  unit: z.enum(["px", "dE00", "str", "scale"]),
  cssRuleSource: CssRuleSourceSchema.optional(),
  fixHint: z.string(),
});

export type StyleViolation = z.infer<typeof StyleViolationSchema>;

export const GeometryViolationSchema = z.object({
  selector: z.string(),
  expected: GeometryRectSchema,
  actual: GeometryRectSchema,
  delta: z.object({
    dx: z.number(),
    dy: z.number(),
    dWidth: z.number(),
    dHeight: z.number(),
  }),
  fixHint: z.string(),
});

export type GeometryViolation = z.infer<typeof GeometryViolationSchema>;

export const PixelDiffSummarySchema = z.object({
  match: z.boolean(),
  diffCount: z.number().int().nonnegative(),
  diffPercentage: z.number().nonnegative(),
  dimensionDrift: z.boolean(),
  refDimensions: z.object({ width: z.number(), height: z.number() }),
  liveDimensions: z.object({ width: z.number(), height: z.number() }),
  tripletImagePath: z.string().optional(),
  diffImagePath: z.string().optional(),
});

export type PixelDiffSummary = z.infer<typeof PixelDiffSummarySchema>;

export const DeltaPacketSchema = z.object({
  status: z.enum(["pass", "fail"]),
  adapter: z.enum(["html", "figma", "image"]),
  timestamp: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),
  refSource: z.string(),
  styleViolations: z.array(StyleViolationSchema),
  geometryViolations: z.array(GeometryViolationSchema),
  pixelDiff: PixelDiffSummarySchema,
  summary: z.string(),
});

export type DeltaPacket = z.infer<typeof DeltaPacketSchema>;

export const ConfigSchema = z.object({
  targetUrl: z.string().default("index.html"),
  ref: z.string().optional(),
  adapter: z.enum(["html", "figma", "image"]).default("html"),
  viewport: ViewportSchema.default({
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
  }),
  threshold: z.number().min(0).max(1).default(0.05),
  colorThresholdDeltaE: z.number().positive().default(2.0),
  geometryTolerancePx: z.number().nonnegative().default(0.5),
  subpixelTolerancePx: z.number().nonnegative().default(1.0),
  selector: z.string().default("body"),
  maskSelectors: z.array(z.string()).default([]),
  injectCss: z.string().optional(),
  ignoreHttpsErrors: z.boolean().default(true),
  root: z.string().optional(),
  outputDir: z.string().default(".ui-level"),
  figma: z
    .object({
      token: z.string().optional(),
      fileKey: z.string().optional(),
      nodeId: z.string().optional(),
    })
    .optional(),
});

export type UILevelConfig = z.infer<typeof ConfigSchema>;
