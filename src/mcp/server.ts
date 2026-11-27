import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Browser } from "playwright-core";
import { check } from "../index.js";
import { launchBrowser, resolveBrowserExecutable } from "../browser/resolver.js";
import { importReferenceSnapshot } from "../snapshot/manager.js";

export const McpImportSnapshotSchema = z.object({
  slug: z.string().min(1),
  specPath: z.string().min(1),
  imagePath: z.string().min(1),
  baseDir: z
    .string()
    .optional()
    .refine(
      (dir) => {
        if (!dir) return true;
        const resolved = path.resolve(process.cwd(), dir);
        const rel = path.relative(process.cwd(), resolved);
        return !rel.startsWith("..") && !path.isAbsolute(rel);
      },
      {
        message: "baseDir must be within the project root directory",
      }
    ),
  dpr: z.number().positive().optional(),
  force: z.boolean().optional(),
  selectorMap: z.record(z.string(), z.string()).optional(),
  figma: z
    .object({
      fileKey: z.string().optional(),
      fileName: z.string().optional(),
      nodeId: z.string().optional(),
      nodeName: z.string().optional(),
      revision: z.string().optional(),
      colorProfile: z.enum(["SRGB", "DISPLAY_P3", "LEGACY"]).optional(),
    })
    .optional(),
  figwright: z
    .object({
      serverVersion: z.string().optional(),
      pluginVersion: z.string().optional(),
      detail: z.enum(["minimal", "compact", "full"]).optional(),
      dedupeComponents: z.boolean().optional(),
    })
    .optional(),
});

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "ui-level",
      version: "1.2.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  let warmBrowser: Browser | undefined;

  async function getBrowser(): Promise<Browser> {
    if (warmBrowser && warmBrowser.isConnected()) {
      return warmBrowser;
    }
    warmBrowser = await launchBrowser();
    return warmBrowser;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "level_check",
          description:
            "Run deterministic visual, DOM geometry, and CSS computed style regression tests between a live webpage and a reference design (HTML, Figma, or image).",
          inputSchema: {
            type: "object",
            properties: {
              targetUrl: {
                type: "string",
                description: "Target URL or local HTML file path to verify",
              },
              ref: {
                type: "string",
                description: "Reference HTML file, Figma 'fileKey:nodeId' or URL, or image/SVG path",
              },
              adapter: {
                type: "string",
                enum: ["html", "figma", "image"],
                description: "Adapter type: 'html', 'figma', or 'image'",
                default: "html",
              },
              selector: {
                type: "string",
                description: "CSS selector of the component to inspect (defaults to 'body')",
                default: "body",
              },
              refSelector: {
                type: "string",
                description: "Optional CSS selector in reference HTML (defaults to selector)",
              },
              threshold: {
                type: "number",
                description: "Pixel diff threshold (0 to 1, default 0.05)",
                default: 0.05,
              },
              viewport: {
                type: "object",
                properties: {
                  width: { type: "number" },
                  height: { type: "number" },
                  deviceScaleFactor: { type: "number" },
                },
                description: "Viewport dimensions & scale",
              },
              maskSelectors: {
                type: "array",
                items: { type: "string" },
                description: "Selectors to mask out from pixel diff",
              },
              selectorMap: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Explicit mapping from live selectors to reference IDs/selectors",
              },
              injectCss: {
                type: "string",
                description: "Custom CSS injected before capture",
              },
              root: {
                type: "string",
                description: "Explicit project root directory for static asset resolution",
              },
              outputDir: {
                type: "string",
                description: "Directory for live/diff/triplet PNG artifacts",
              },
              refSpec: {
                type: "string",
                description: "Offline reference JSON spec path (for Figma MCP)",
              },
              refImage: {
                type: "string",
                description: "Offline reference PNG image path (for Figma MCP)",
              },
              ignoreHttpsErrors: {
                type: "boolean",
                default: true,
              },
              skipIntegrityCheck: {
                type: "boolean",
                description: "Skip SHA-256 integrity verification for reference snapshots",
                default: false,
              },
              autoNoiseMask: {
                type: "boolean",
                description: "Triple-shot noise masking to ignore animated/moving elements",
                default: false,
              },
              commonArea: {
                type: "boolean",
                description: "Compare overlapping common area min(w1, w2) x min(h1, h2) instead of padding when heights differ",
                default: false,
              },
            },
            required: ["targetUrl"],
          },
        },
        {
          name: "level_import_snapshot",
          description:
            "Import and freeze an immutable reference snapshot from a spec JSON and image PNG into .ui-level/references/<slug>/.",
          inputSchema: {
            type: "object",
            properties: {
              slug: {
                type: "string",
                description: "Unique name/slug for the reference snapshot",
              },
              specPath: {
                type: "string",
                description: "Path to JSON spec (Figwright get_design_context or Figma REST)",
              },
              imagePath: {
                type: "string",
                description: "Path to PNG/JPG reference image",
              },
              baseDir: {
                type: "string",
                description: "Base output directory (default: .ui-level/references)",
              },
              dpr: {
                type: "number",
                description: "Optional device scale factor (default: auto-detected 1 or 2)",
              },
              force: {
                type: "boolean",
                description: "Overwrite an existing reference snapshot with the same slug",
                default: false,
              },
              selectorMap: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Optional mapping from selectors to Figma IDs",
              },
              figma: {
                type: "object",
                properties: {
                  fileKey: { type: "string" },
                  fileName: { type: "string" },
                  nodeId: { type: "string" },
                  nodeName: { type: "string" },
                  revision: { type: "string" },
                  colorProfile: { type: "string", enum: ["SRGB", "DISPLAY_P3", "LEGACY"] },
                },
                description: "Optional Figma provenance metadata",
              },
              figwright: {
                type: "object",
                properties: {
                  serverVersion: { type: "string" },
                  pluginVersion: { type: "string" },
                  detail: { type: "string", enum: ["minimal", "compact", "full"] },
                  dedupeComponents: { type: "boolean" },
                },
                description: "Optional Figwright capture metadata",
              },
            },
            required: ["slug", "specPath", "imagePath"],
          },
        },
        {
          name: "level_doctor",
          description: "Diagnose local environment (Chromium, SIMD odiff, sharp, color engine).",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "level_doctor") {
      try {
        const browserPath = resolveBrowserExecutable();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "ok",
                  browser: browserPath,
                  node: process.version,
                  platform: process.platform,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Doctor failed: ${err?.message || "unknown"}` }],
        };
      }
    }

    if (name === "level_import_snapshot") {
      try {
        const validated = McpImportSnapshotSchema.parse(args || {});
        const res = await importReferenceSnapshot(validated);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Import snapshot error: ${err?.message || "unknown"}` }],
        };
      }
    }

    if (name === "level_check") {
      try {
        const browser = await getBrowser();
        const result = await check((args || {}) as any, browser);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text", text: `Check error: ${err?.message || "unknown"}` }],
        };
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  transport.onclose = async () => {
    if (warmBrowser) {
      await warmBrowser.close().catch(() => {});
      warmBrowser = undefined;
    }
  };
  await server.connect(transport);
}
