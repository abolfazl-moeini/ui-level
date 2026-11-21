import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { check } from "../index.js";
import { resolveBrowserExecutable } from "../browser/resolver.js";

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name: "ui-level",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

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
                description: "Reference HTML file, Figma fileKey/nodeId, or image path",
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
              threshold: {
                type: "number",
                description: "Pixel diff threshold (0 to 1, default 0.05)",
                default: 0.05,
              },
              maskSelectors: {
                type: "array",
                items: { type: "string" },
                description: "Selectors to mask out from pixel diff",
              },
            },
            required: ["targetUrl"],
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

    if (name === "level_check") {
      try {
        const result = await check(args as any);
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
  await server.connect(transport);
}
