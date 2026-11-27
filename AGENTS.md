# AGENTS.md — Developer & AI Agent Guidelines for `ui-level`

> **Scope**: This document defines the architectural standards, verification gates, directory topology, and behavioral invariants for all autonomous AI agents and human contributors working on the `ui-level` codebase.

---

## 1. Project Purpose & Core Philosophy

`ui-level` is a deterministic visual, DOM geometry, and computed CSS regression engine for modern UI workflows. It replaces fragile vision-LLM heuristics, patch quantization artifacts, and downscaling blindness with a verifiable, two-gate regression pipeline:

1. **Gate 1 — Deterministic DOM, Geometry & Computed Styles (`src/browser/`):**
   - Normalizes longhand CSS box-model and typography properties.
   - Perceptual color drift verification via **CIEDE2000** ($\Delta E_{00}$) with $\pm 3$ RGB channel rounding tolerance.
   - Text wrapping verification (`renderedLines`) and `textContent` comparison.
   - Lazy CDP inspection (`CSS.getMatchedStylesForNode`) on violations to pinpoint the exact source file, line number, and selector.
   - Semantic skeleton outline extraction and horizontal scroll overflow safety gates.
2. **Gate 2 — SIMD Perceptual & Pixel Diff (`src/diff/`):**
   - SIMD-accelerated pixel comparison using `odiff-bin` and `sharp` at device scale (`2x` Retina or auto-detected `1x`).
   - Dynamic region masking (`maskSelectors`, Figma text rect masking to eliminate CoreText vs Skia font-rasterization noise).
   - Triple-Shot Noise Masking (`--auto-noise-mask`) to eliminate animation, carousel, and loader false positives.
   - Coarse-scale Block Layout Similarity ($0..1$) and Perceptual SSIM ($0..1$).
   - Common Area Mode (`--common-area`) for dynamic height/content diffing.
   - Generation of 1:1 side-by-side composite review triplets (`triplet.png`: `Ref | Live | Diff`).

---

## 2. Repository Layout & Topology

```
ui-level/
├── src/
│   ├── index.ts                     # Public programmatic API (check, daemon, server exports)
│   ├── cli.ts                       # Commander CLI implementation (check, snapshot, doctor, init)
│   ├── schema.ts                    # Single source of truth: Zod schemas & TypeScript types
│   ├── adapters/                    # Reference ingestion & normalization
│   │   ├── html.adapter.ts          # HTML reference normalization (4-tier selector matcher)
│   │   ├── image.adapter.ts         # Raster PNG/JPEG & Chromium-rendered SVG adapter
│   │   ├── figma.adapter.ts         # Figma REST API / offline JSON loader
│   │   ├── figma-rest.normalizer.ts # Figma REST payload normalizer
│   │   └── figwright.converter.ts   # Figwright MCP JSON AST converter
│   ├── browser/                     # Playwright & Chromium telemetry
│   │   ├── resolver.ts              # Headless Chromium executable resolution
│   │   ├── telemetry.ts             # DOM tree extraction, metrics, Next.js font cleaning
│   │   ├── cdp-styles.ts            # CDP style inspector & DOMDebugger event listener finder
│   │   └── daemon.ts                # Unix domain socket daemon for sub-350ms warm execution
│   ├── diff/                        # Mathematical, pixel & perceptual diffing
│   │   ├── pixel.ts                 # Gate 2 runner (odiff, sentinel padding, similarity)
│   │   ├── triplet.ts               # Side-by-side 3-column composite generator
│   │   ├── regions.ts               # Hotspot clustering in CSS coordinates
│   │   ├── color.ts                 # CIEDE2000 ΔE00 calculation & ±3 RGB tolerance
│   │   ├── noise-mask.ts            # Triple-shot 16x16 tile noise mask with 3x3 dilation
│   │   ├── similarity.ts            # Block similarity & 8x8 window luminance SSIM
│   │   └── skeleton.ts              # Semantic skeleton outline, LCS & horizontal overflow
│   ├── mcp/                         # Model Context Protocol
│   │   └── server.ts                # stdio MCP server for agent integration (level_check, etc.)
│   ├── server/                      # Static file hosting
│   │   └── static-host.ts           # Project root discovery & local HTTP static server
│   └── snapshot/                    # Reference snapshot management
│       └── manager.ts               # Immutable snapshots under .ui-level/references/<slug>
├── tests/                           # Vitest test suite
│   ├── craft-algorithms.test.ts     # Noise mask, similarity, skeleton LCS & Next.js font unit tests
│   ├── plan-integration.test.ts     # End-to-end integration tests for newly integrated algorithms
│   ├── figwright-converter.test.ts  # AST conversion tests
│   ├── figwright-bridge.test.ts     # Snapshot import & integrity tests
│   ├── issues-remediation.test.ts   # TDD regressions for historic issues
│   ├── audit-fixes.test.ts          # Adversarial edge-case tests
│   ├── dimension.test.ts            # Dimension drift and subpixel tolerance tests
│   └── mutation.test.ts             # 11 classic mutation regression tests
└── tsup.config.ts                   # Build bundle configuration (target: Node 20)
```

---

## 3. Core Algorithms & Innovations

### 3.1. Triple-Shot Noise Masking (`src/diff/noise-mask.ts`)
- **Problem**: Periodic CSS/JS animations, carousels, video backgrounds, loaders, or blinking carets trigger false pixel failures against static design references.
- **Solution**: Three snapshots are taken on the live target with asymmetric intervals ($t = 0\text{ms}$, $+900\text{ms}$, $+1300\text{ms}$) with `animations: "allow"`.
- **Tiling & Dilation**:
  - Image is partitioned into $16 \times 16$ pixel tiles (`NOISE_TILE = 16`).
  - Tiles where mean RGB channel difference exceeds `threshold` (default 24) are marked as changing.
  - The masks between $(t_1 \leftrightarrow t_2)$ and $(t_1 \leftrightarrow t_3)$ are unioned.
  - A 1-tile dilation ($3 \times 3$ tile neighborhood) is applied to prevent moving edge bleed.
  - Masked tiles are serialized to `.ui-level/noise.png`, passed as `ignoreRegions` to `odiff`, and excluded from similarity calculations.

### 3.2. Two-Layer Similarity Scoring (`src/diff/similarity.ts`)
In addition to exact pixel matching, `ui-level` computes two normalized ($0..1$) metrics:
1. **`layoutSimilarity`**: The ratio of $16 \times 16$ tiles whose mean RGB values match within tolerance (resilient against sub-pixel shifts and anti-aliasing).
2. **`perceptualSimilarity`**: Image is downscaled to $\le 512\text{px}$, converted to ITU-R BT.601 luminance ($0.299R + 0.587G + 0.114B$), and evaluated via luminance SSIM over $8 \times 8$ windows with standard Wang et al. constants ($C_1 = 6.5025, C_2 = 58.5225$).

### 3.3. Semantic Skeleton & LCS (`src/diff/skeleton.ts`)
- Extracts document structure mapped across 20 canonical semantic tags (`header`, `nav`, `main`, `footer`, `section`, `article`, `aside`, `form`, `h1`–`h4`, `ul`, `ol`, `img`, `video`, `button`, `input`, `select`, `textarea`) and ARIA roles (`banner`, `navigation`, `main`, `contentinfo`, `complementary`, `form`, `button`, `img`).
- Uses $O(N)$ space Longest Common Subsequence (LCS) to compute structure likeness percentage ($0..100\%$) and report missing elements (e.g. `structure 92% alike; missing parts: 2 lists, a form`).

### 3.4. Horizontal Scroll Overflow Gate
- Checks responsive viewport safety: `scrollWidth <= viewportWidth + 1`.
- If an element forces horizontal viewport scrolling, an alert and warning are recorded in `DeltaPacket.horizontalOverflow`.

### 3.5. Common Area Mode (`--common-area`)
- In dynamic list or feed pages where live height differs from the fixed design frame, crops both images to `min(w1, w2) x min(h1, h2)` from $(0, 0)$ to allow zero-false-positive evaluation.
- The review triplet (`triplet.png`) automatically composites the cropped images for aligned 3-panel comparison.

### 3.6. Next.js Font Normalization (`cleanFontFamilyName`)
- Automatically strips Next.js font hashing (e.g. `"__Vazirmatn_91a2b3"` $\to$ `"Vazirmatn"`, `"__Roboto_Mono_123456"` $\to$ `"Roboto Mono"`) so production Next.js builds match Figma and design specs.

### 3.7. Color Rounding Tolerance & CIEDE2000
- A $\pm 3$ RGB channel rounding tolerance is applied before CIEDE2000 evaluation to eliminate minor rounding drifts between Chromium rasterizers and Figma's Skia engine.

### 3.8. Figwright AST Conversion & Bidirectional Mapping (`src/adapters/figwright.converter.ts`)
- Converts Figwright MCP context payloads into canonical `NormalizedSpec`.
- Supports bidirectional mapping between DOM nodes and Figma layers via `data-figma-node-id` attributes and `selectorMap` configuration pairs.
- Validates section plan completeness to prevent false passes on truncated designs.

### 3.9. Reference Snapshot Storage & SHA-256 Integrity (`src/snapshot/manager.ts`)
- Stores immutable reference packages under `.ui-level/references/<slug>/` containing `manifest.json`, `ref.png`, and `spec.json`.
- Enforces SHA-256 hash checks on every run to detect reference tampering. Bypassed only when explicitly passing `--skip-integrity-check`.

### 3.10. CDP Lazy Style Inspection & Event Listeners (`src/browser/cdp-styles.ts`)
- Pinpoints exact CSS source files, line numbers, and active rules for violating properties via CDP `CSS.getMatchedStylesForNode`.
- Extracts attached event listeners using `DOMDebugger.getEventListeners` to verify interactive elements.

---

## 4. CLI & MCP Tool Reference

### 4.1. CLI Commands
```bash
# Main visual & CSS regression check
ui-level check -t http://localhost:3000 -r ref.png [options]
  --auto-noise-mask       Enable triple-shot noise masking for animated elements
  --common-area           Crop differing heights to min(w1, w2) x min(h1, h2)
  -a, --adapter <type>    Adapter: html | figma | image (default: html)
  --threshold <n>         Pixel diff threshold 0..1 (default: 0.05)
  --viewport <wxh>        Viewport size e.g. 1280x800 (default: 1280x800)
  --dpr <n>               Device pixel ratio: 1 | 2 (default: 2)
  -s, --selector <sel>    Target DOM selector (default: body)
  -c, --config <path>     Path to ui-level.config.json
  --json                  Output raw DeltaPacket JSON to stdout
  --skip-integrity-check  Bypass reference snapshot SHA-256 validation

# Reference Snapshot Management
ui-level snapshot import <slug> -i <ref.png> -s <spec.json>
ui-level snapshot verify <slug>

# Diagnostics & Initialization
ui-level doctor          Verify Chromium runtime, Playwright, and system font stack
ui-level init            Generate starter ui-level.config.json
```

### 4.2. MCP Tools
The `ui-level` stdio MCP server exposes 4 tools for AI agent integration:
- `level_check`: Run regression check with full configuration options.
- `level_import_snapshot`: Import a new immutable reference snapshot.
- `level_verify_snapshot`: Validate SHA-256 integrity of an existing snapshot.
- `level_doctor`: Run environment diagnostics.

---

## 5. Architectural Invariants & Rules for AI Agents

1. **Strict Test-Driven Development (TDD)**:
   - Every bug fix or new feature MUST begin with a failing test (Red phase) and conclude with a passing test (Green phase).
   - Never remove or weaken existing assertions in `tests/` without explicit approval.
2. **SemVer Consistency**:
   - Whenever preparing a release or bumping the package version:
     - Main `package.json` (`"version": "x.y.z"`)
     - Main CLI banner in `src/cli.ts` (`.version("x.y.z")`)
     - MCP server manifest in `src/mcp/server.ts` (`version: "x.y.z"`)
3. **Zero-Python Dependency**:
   - `ui-level` is a pure Node.js / TypeScript package. Do not introduce Python runtime dependencies or shell-outs to Python CLIs.
4. **Backwards Compatibility**:
   - Public APIs (`check()`) and config schemas (`ConfigSchema`, `DeltaPacketSchema`, `PixelDiffSummarySchema`) must remain backwards-compatible. Any new parameter must be optional or have a safe default.
   - CLI exit codes must remain consistent (`0`: Pass, `1`: Visual/CSS regression, `2`: Config/Runtime error).
5. **Deterministic Cleanup**:
   - All tests must clean up their temporary directories (`.ui-level/test-*` or `os.tmpdir()/*`) in `afterAll`.
   - Never perform unbounded recursive deletes outside declared test directories.

---

## 6. Development & Verification Workflow

```bash
# 1. Typecheck TypeScript across the repository
npm run typecheck

# 2. Run the complete Vitest test suite
npm test

# 3. Build dist/index.js and dist/cli.js
npm run build

# 4. Run system diagnostics
node dist/cli.js doctor
```
