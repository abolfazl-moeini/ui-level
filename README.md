# ui-level

> Deterministic visual & CSS computed style regression engine.

`ui-level` is an open-source tool for testing UI implementations against designs (HTML, Figma, or PNG/SVG images) with zero hallucination.

Instead of relying on fuzzy vision LLMs that suffer from patch quantization and downscaling errors, `ui-level` uses a two-gate deterministic verification model:
1. **Gate 1: DOM & Computed Styles Inspection** (Chromium CDP): Compares exact longhand CSS dimensions, typography, and perceptual color differences ($\Delta E_{00}$).
2. **Gate 2: SIMD-Accelerated Pixel Diffing** (`odiff-bin`): Computes pixel-level divergence, masking out dynamic regions or text (when comparing Skia vs CoreText text engines).

---

## Installation

```bash
# Direct run via npx
npx ui-level doctor

# Or install locally
npm install -D ui-level
```

To install Chromium browser dependencies:
```bash
npx ui-level setup
```

---

## Quick Start

### 1. HTML vs HTML Comparison
Compare your local implementation against a reference HTML mockup:
```bash
npx ui-level check --target dist/index.html --ref designs/mockup.html --selector "#header"
```

### 2. Implementation vs Image (PNG or SVG)
Compare a live page against a reference design image:
```bash
npx ui-level check --target http://localhost:3000 --ref designs/hero.svg --adapter image --selector ".hero"
```

### 3. Implementation vs Figma Node
Compare directly against a Figma node using the Figma REST API:
```bash
export FIGMA_TOKEN="figd_..."
npx ui-level check \
  --target http://localhost:3000 \
  --adapter figma \
  --ref "fileKey:nodeId" \
  --selector "#navbar"
```

---

## Configuration (`ui-level.config.json`)

Generate a starter configuration:
```bash
npx ui-level init
```

Example configuration:
```json
{
  "targetUrl": "index.html",
  "ref": "designs/reference.html",
  "adapter": "html",
  "viewport": {
    "width": 1280,
    "height": 800,
    "deviceScaleFactor": 2
  },
  "threshold": 0.05,
  "colorThresholdDeltaE": 2.0,
  "geometryTolerancePx": 0.5,
  "selector": "body",
  "maskSelectors": [".dynamic-timestamp", ".user-avatar"],
  "outputDir": ".ui-level"
}
```

---

## MCP Server (Model Context Protocol)

`ui-level` includes a built-in stdio MCP server for agentic AI tools (Claude Code, Cursor, Antigravity):

```json
{
  "mcpServers": {
    "ui-level": {
      "command": "npx",
      "args": ["-y", "ui-level", "mcp"]
    }
  }
}
```

Exposed MCP Tools:
- `level_check`: Runs visual and CSS spec verification and returns a structured `DeltaPacket`.
- `level_doctor`: Diagnoses local browser and diff engines.

---

## Output (`DeltaPacket`)

When run with `--json`, `ui-level` outputs structured JSON:
```json
{
  "status": "fail",
  "adapter": "html",
  "durationMs": 420,
  "styleViolations": [
    {
      "selector": "#btn-submit",
      "property": "paddingLeft",
      "expected": 16,
      "actual": 18,
      "delta": 2,
      "unit": "px",
      "cssRuleSource": {
        "file": "http://127.0.0.1:54321/css/main.css",
        "line": 142
      },
      "fixHint": "Set 'paddingLeft' to 16px (currently 18px, drift: +2px)"
    }
  ],
  "pixelDiff": {
    "match": false,
    "diffCount": 42,
    "diffPercentage": 0.05,
    "dimensionDrift": false,
    "tripletImagePath": ".ui-level/triplet.png"
  }
}
```

Exit Codes:
- `0`: PASS (All style, geometry, and pixel gates matched).
- `1`: FAIL (Regressions or visual differences detected).
- `2`: ERROR (System, network, or configuration error).

---

## License

MIT
