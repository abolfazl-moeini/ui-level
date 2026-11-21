# ui-level

[![npm version](https://img.shields.io/npm/v/ui-level.svg?style=flat-square)](https://www.npmjs.com/package/ui-level)
[![npm downloads](https://img.shields.io/npm/dt/ui-level.svg?style=flat-square)](https://www.npmjs.com/package/ui-level)
[![CI](https://github.com/abolfazl-moeini/ui-level/actions/workflows/ci.yml/badge.svg)](https://github.com/abolfazl-moeini/ui-level/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

> Deterministic visual, DOM geometry, and computed CSS regression engine for HTML, Figma, and PNG/SVG references.

`ui-level` eliminates vision-LLM guesswork (patch quantization, downscaling blindness, and hallucinated CSS values) by combining two deterministic verification gates:

1. **Gate 1 — DOM, Geometry & Computed Styles (Chromium + Lazy CDP):**
   Normalizes longhand CSS properties (`padding*`, `margin*`, `border*`, `fontSize`, `lineHeight`, `fontWeight`, `letterSpacing`, `fontFamily`), checks perceptual color drift via **CIEDE2000** ($\Delta E_{00}$), validates line wrapping (`renderedLines`) and `textContent`, and lazily queries Chrome DevTools Protocol (`CSS.styleSheetAdded` + `CSS.getMatchedStylesForNode`) on violations to pinpoint the winning CSS rule, file, and line number.
2. **Gate 2 — SIMD Pixel Diff & Hotspot Correlation (`odiff-bin` + `sharp`):**
   Runs SIMD-accelerated pixel comparison at device scale (`2x` or auto-detected `1x`), masks dynamic selectors or Figma text regions (to avoid Skia vs CoreText font-shaping noise), pads dimension drift with magenta sentinels, produces a 1:1 `Ref | Live | Diff` triplet (`triplet.png`), and clusters pixel discrepancies into CSS-coordinate `regions` mapped to overlapping DOM selectors and sampled RGB/$\Delta E_{00}$ deltas.

---

## Requirements & Installation

- Node.js `>= 20`
- Chromium (system Chrome/Chromium or Playwright Chromium)

```bash
# Run diagnostics
npx ui-level doctor

# Install locally or globally
npm install -D ui-level

# Install Chromium if not already present on the machine
npx ui-level setup
```

---

## Quick Start

### 1. HTML vs HTML (Mockup / Exported HTML vs Live Site)
Compare a live page against an exported HTML mockup (supports different root selectors via `--ref-selector` and automatic 4-tier node matching):

```bash
npx ui-level check \
  --target http://localhost:3000 \
  --ref designs/mockup.html \
  --selector ".product-card" \
  --ref-selector ".exported-card"
```

### 2. Implementation vs PNG or SVG Screenshot
Supports both `2x` Retina and `1x` standard PNGs (auto-detected) as well as `.svg` files rendered inside Chromium for full `@font-face` and RTL ligature fidelity:

```bash
npx ui-level check \
  --target http://localhost:3000 \
  --ref designs/hero.svg \
  --adapter image \
  --selector ".hero"
```

### 3. Implementation vs Figma Node
Compares directly against a Figma node (`use_absolute_bounds=true` + best-effort `/variables/local` + text masking in pixel diff):

```bash
export FIGMA_TOKEN="figd_..."
npx ui-level check \
  --target http://localhost:3000 \
  --adapter figma \
  --ref "fileKey:nodeId" \
  --selector "#navbar"
```

Or offline with exported spec/image files (e.g. from Figma MCP):

```bash
npx ui-level check \
  --target http://localhost:3000 \
  --adapter figma \
  --ref-spec figma-node.json \
  --ref-image figma-node.png \
  --selector "#navbar"
```

---

## Warm Daemon Mode

Avoid cold Chromium startup overhead across repeated checks using the HTTP-over-Unix-Domain-Socket daemon (`/tmp/ui-level-<uid>/d.sock`, `0600` permissions, 10-minute idle TTL):

```bash
npx ui-level daemon start
npx ui-level check --daemon --target dist/index.html --ref ref.html --selector "#card"
npx ui-level daemon stop
```

---

## Configuration (`ui-level.config.json`)

Generate a starter configuration:

```bash
npx ui-level init
```

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
  "subpixelTolerancePx": 1.0,
  "selector": "body",
  "maskSelectors": [".dynamic-timestamp", ".user-avatar"],
  "outputDir": ".ui-level"
}
```

---

## MCP Server (Model Context Protocol)

Expose `level_check` and `level_doctor` over `stdio` for Claude Code, Cursor, or Antigravity:

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

---

## Structured Output (`--json`)

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
        "line": 142,
        "column": 5,
        "selector": ".btn",
        "cssText": "padding: 18px;"
      },
      "fixHint": "Set 'paddingLeft' to 16px (currently 18px, drift: +2px)"
    }
  ],
  "pixelDiff": {
    "match": false,
    "diffCount": 1420,
    "diffPercentage": 1.85,
    "dimensionDrift": false,
    "tripletImagePath": ".ui-level/triplet.png",
    "regions": [
      {
        "x": 233,
        "y": 81,
        "width": 87,
        "height": 36,
        "pixelCount": 1420,
        "overlappingSelectors": ["#card-btn", "#test-card"],
        "refColor": "rgb(37, 99, 235)",
        "liveColor": "rgb(220, 38, 38)",
        "deltaE": 54.2
      }
    ]
  }
}
```

### Exit Codes
- `0`: PASS — all style, geometry, and pixel gates matched.
- `1`: FAIL — visual or style regressions detected.
- `2`: ERROR — invalid config, missing target, or runtime error.

---

## Docker

```bash
docker build -t ui-level .
docker run --rm ui-level doctor
```

## License

MIT
