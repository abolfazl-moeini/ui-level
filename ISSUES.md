# ui-level — Issues, Bugs & Improvement Backlog

Living markdown backlog for the `ui-level` repo. Compiled while auditing the Figwright integration described in
`/Users/moeini/.gemini/antigravity/brain/cefc421f-93a3-4475-85b1-b34c88293c97/figwright_integration_bridge_plan.md`.

> **Audit snapshot:** 2026-11-22, ~14:31–14:45 GMT+3:30. The working tree was still being edited by another agent
> during the audit (e.g. `src/adapters/figma-rest.normalizer.ts` appeared mid-run). Line numbers and behavior
> should be re-checked immediately before acting on any item.

## Verification baseline (observed, not inferred)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (no errors) |
| `npm run build` | PASS (`dist/index.js`, `dist/cli.js`, declarations emitted) |
| `npm test` | **FAIL as a suite** — 33/33 assertions pass, but `tests/figwright-bridge.test.ts` fails in `afterAll` |
| Failure detail | `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":61,"threshold":50}` at `tests/figwright-bridge.test.ts:29` |
| `node dist/cli.js --version` | `1.1.0` |
| `node dist/cli.js snapshot --help` | `import` and `verify` registered correctly |

Plan coverage: Layers 1–6 are largely implemented (converter, snapshot manager, telemetry mapping, CLI/MCP,
tests, version sync). Remaining plan gaps are called out as BUG-002, BUG-010, BUG-013 and IDEA-01.

Severity: **H** = incorrect results / silent false positives · **M** = broken workflow or degraded correctness ·
**L** = hygiene, docs, maintainability.

---

## Issue index

| ID | Severity | Area | Title |
| --- | --- | --- | --- |
| [BUG-001](#bug-001-h--empty-specs-produce-green-runs) | H | core / converter | Empty normalized specs yield `pass` with zero checks |
| [BUG-002](#bug-002-h--figwright-converter-ignores-absoluteboundingbox) | H | converter | Figwright converter ignores `absoluteBoundingBox` nodes |
| [BUG-003](#bug-003-m--test-suite-fails-in-teardown-and-leaves-repo-artifacts) | M | tests / CI | Suite fails in teardown and leaves `.ui-level-bridge-test/` |
| [BUG-004](#bug-004-m--bridge-test-depends-on-a-prebuilt-distcli) | M | tests | CLI smoke test depends on `dist/cli.js` |
| [BUG-005](#bug-005-m--immutable-snapshots-can-be-silently-overwritten) | M | snapshots | "Immutable" snapshots silently overwritten on re-import |
| [BUG-006](#bug-006-m--snapshot-auto-detection-is-too-permissive) | M | snapshots / core | Any directory with a `.json` + `.png` is treated as a snapshot |
| [BUG-007](#bug-007-m--loaded-specs-are-not-validated) | M | snapshots | `reference.json` is not schema-validated on load |
| [BUG-008](#bug-008-m--figma-id-normalization-corrupts-non-figma-ids) | M | telemetry | Unconditional hyphen→colon normalization corrupts IDs and drops `I` prefixes |
| [BUG-009](#bug-009-m--dpr-inference-falls-back-to-2-silently) | M | snapshots | DPR inference silently defaults to 2 when ratio is ambiguous |
| [BUG-010](#bug-010-m--auto-line-height--letter-spacing-is-not-implemented) | M | converter | `AUTO` units from the plan/Figwright are silently ignored |
| [BUG-011](#bug-011-m--mcp-import-tool-bypasses-validation-and-can-write-outside-the-project) | M | MCP / security | `level_import_snapshot` accepts raw args and arbitrary `baseDir` |
| [BUG-012](#bug-012-l--figma-rest-nodes-without-bounding-boxes-are-dropped) | L | Figma REST | Nodes without bounding boxes are silently dropped |
| [BUG-013](#bug-013-l--manifest-metadata--docs-are-incomplete) | L | docs / schema | Manifest metadata fields and CLI flags are under-documented |
| [BUG-014](#bug-014-l--node-engine-range-does-not-match-build-target) | L | packaging | `engines: >=20` vs `tsup target: node22` |
| [BUG-015](#bug-015-l--license-file-is-missing) | L | packaging | README badge links a `LICENSE` file that does not exist |
| [BUG-016](#bug-016-l--tests-share-and-mutate-state) | L | tests | Shared output dir and un-restored tampering make tests order-dependent |

---

## Bugs

### BUG-001 (H) — Empty specs produce green runs

**Where:** `src/adapters/figwright.converter.ts:217-231`, `src/schema.ts:27` (`isNormalizedSpec` accepts `nodes: []`),
`src/browser/telemetry.ts:455-468`, `src/index.ts:203-207`.

**Impact:** Gate 1 becomes vacuous. `compareTelemetryWithSpec` iterates live nodes but with zero reference nodes it
produces no style/geometry violations; root auto-pairing also requires `refNodes.length > 0`. If the reference image
matches, the whole check reports `pass` despite having verified no DOM/CSS spec at all. This is the most dangerous
failure mode for an agent-driven fix loop: a broken design spec looks "verified".

**Reproduced:** a `design_diff`-shaped payload `{ "formatVersion": 13, "context": { "nodes": [] } }` plus a matching
PNG returned:

```
{"status":"pass","style":0,"geometry":0,"pixel":true}
```

A `{ "adapter": "figma", "nodes": [] }` normalized spec behaves identically. (A bare `{ nodes: [] }` is rejected by
the format discriminator, so the guard is inconsistent.)

**Proposed fix:**
- Reject zero-node specs at every entry point: `convertFigwrightToNormalizedSpec`, `loadReferenceSnapshot`,
  `processFigmaReference` offline mode, and ideally `NormalizedSpecSchema.refine(nodes => nodes.length > 0)`.
- Alternatively emit an explicit `warnings[]` entry and force `status: "fail"` — never a silent pass.
- Add a regression test asserting that an empty spec throws / fails even when pixels match.

---

### BUG-002 (H) — Figwright converter ignores `absoluteBoundingBox`

**Where:** `src/adapters/figwright.converter.ts:234-238` and `283-311`; contrast with
`src/adapters/figma-rest.normalizer.ts:69-75` and the plan's Layer 2 coordinate rules
("If `node.absoluteBoundingBox` is present … compute x/y relative to rootOrigin").

**Impact:** A raw Figma REST node passed to the public `convertFigwrightToNormalizedSpec` API is misdiagnosed as a
`detail: 'minimal'` capture and throws, even though it contains full geometry. Both converter functions are exported
from `src/index.ts`, so consumers will hit this.

**Reproduced:**

```
convertFigwrightToNormalizedSpec({ nodes: [{ id: '1:1', type: 'FRAME',
  absoluteBoundingBox: { x:0, y:0, width:100, height:50 } }] })
→ throws "Figwright spec appears to be captured with detail: 'minimal' …"
```

**Proposed fix:** either implement the planned `absoluteBoundingBox` branch in the converter, or delegate to
`convertFigmaRestToNormalizedSpec` when `isFigmaRestPayload(raw)` is true, and document the boundary between the two
public converters.

---

### BUG-003 (M) — Test suite fails in teardown and leaves repo artifacts

**Where:** `tests/figwright-bridge.test.ts:18` (`outputDir = <repo>/.ui-level-bridge-test`) and `:29`
(`fs.rmSync(outputDir, { recursive: true, force: true })`).

**Impact:** All 33 assertions pass, yet `npm test` exits non-zero in any environment with a bulk-delete guard (the
sandbox used here counted 61 files against a threshold of 50). The untracked directory stays in the working tree and
can break subsequent runs. CI on a permissive runner may hide the problem.

**Proposed fix:** use `fs.mkdtempSync(path.join(os.tmpdir(), 'ui-level-bridge-'))`, clean up only that unique
directory, and wrap teardown in a best-effort `try/catch` (or delete files individually). Never delete a fixed path
inside the repository from a test.

---

### BUG-004 (M) — Bridge test depends on a prebuilt `dist/cli.js`

**Where:** `tests/figwright-bridge.test.ts:450` (`const cliPath = path.resolve(__dirname, "../dist/cli.js")`).

**Impact:** `npm test` on a clean checkout fails unless `npm run build` ran first. CI happens to build before testing,
so this is invisible there; local `npm test` and third-party contributors are affected.

**Proposed fix:** add a `pretest` build step, or spawn the CLI from source via a TS-aware runner, or skip the smoke
test with an explicit message when `dist/cli.js` is absent.

---

### BUG-005 (M) — "Immutable" snapshots can be silently overwritten

**Where:** `src/snapshot/manager.ts:109-126` and `:179-242`; README calls the
bundles "immutable"/"frozen".

**Impact:** `snapshot import --slug <existing>` rewrites `reference.json`, `reference.png`, and `manifest.json` with
no warning, no diff, no history. Integrity hashes are recomputed, so previously verified references can be replaced
without detection by a reviewer looking only at the slug.

**Proposed fix:** refuse to overwrite by default (exit 2 with "snapshot exists; use `snapshot update`" or require
`--force`); record `supersedes` / revision in the manifest; add `snapshot list` and `snapshot diff`.

---

### BUG-006 (M) — Snapshot auto-detection is too permissive

**Where:** `src/snapshot/manager.ts:66-89`, `:309-347`; `src/index.ts:95-106`.

**Impact:** `isSnapshotDirectory()` returns true for *any* directory containing `manifest.json`, or any directory with
an arbitrary `.json` plus an arbitrary `.png/.jpg/.webp`. A reference folder with unrelated artifacts is silently
rerouted to the Figma adapter, integrity checks are skipped in the no-manifest fallback, and DPR metadata is absent.
The broad heuristics can also produce confusing `Unrecognized spec format` errors.

**Proposed fix:** require `manifest.json` for auto-detection; make manifest-less loading opt-in via an explicit flag;
narrow discovery to the documented filenames (`reference.json`, `reference.png`) and emit a warning when a fallback
is used.

---

### BUG-007 (M) — Loaded specs are not validated

**Where:** `src/snapshot/manager.ts:296` (manifest path) and `:326-341` (fallback path); consumer assumes
`spec.nodes` is an array (`src/browser/telemetry.ts:452`).

**Impact:** With `--skip-integrity`, or with a hand-written snapshot directory, a syntactically valid JSON file that
is not a `NormalizedSpec` reaches `compareTelemetryWithSpec` and fails with an opaque `TypeError` (`for ... of
undefined`) instead of a clear configuration error. The same applies to a tampered spec whose hash check was bypassed.

**Proposed fix:** `NormalizedSpecSchema.parse()` immediately after reading `reference.json` in both load paths, with
an error naming the offending file and field.

---

### BUG-008 (M) — Figma ID normalization corrupts non-Figma IDs

**Where:** `src/browser/telemetry.ts:19-23`, `:240-244`, `:349-358`.

**Impact:** `const figmaId = rawFigmaId.replace(/-/g, ":")` runs for every value of `data-figma-id` /
`data-figma-node-id`. For real Figma IDs that is intended, but any non-numeric identifier containing hyphens (e.g.
`data-figma-id="card-1"`) becomes `card:1` and no longer matches reference IDs/selectors. Conversely, Figwright-style
IDs with an `I` prefix (`I123:456`) match `FIGMA_NODE_ID_RE` but are never canonicalized to the unprefixed form used
elsewhere, so the two representations do not match.

**Proposed fix:** apply hyphen→colon conversion only when `FIGMA_NODE_ID_RE.test(value)`; strip a leading `I` in a
single `normalizeFigmaId()` helper used by the converter, telemetry, and selector-map normalization. Add tests for
`card-1`, `I123:456`, `123-456`, and multi-node `I1:2;3:4`.

---

### BUG-009 (M) — DPR inference falls back to 2 silently

**Where:** `src/snapshot/manager.ts:165-177`.

**Impact:** DPR is inferred from `imageWidth / spec.nodes[0].rect.width`, snapped to 1/2/3 within ±0.08, otherwise
silently set to 2. Cropped, padded, or viewport-sized reference screenshots produce a wrong scale with no warning;
the result surfaces later as a mysterious `DIMENSION_DRIFT`.

**Proposed fix:** push a warning with the observed ratio when no snap matches, or require `--dpr` for ambiguous
inputs. Validate inferred DPR against image height as well as width.

---

### BUG-010 (M) — `AUTO` units are not implemented

**Where:** `src/adapters/figwright.converter.ts:424-454`; plan Layer 2 explicitly promises `PIXELS`/`PERCENT`/`AUTO`
resolution on `lineHeight` and `letterSpacing`.

**Impact:** `unit: "AUTO"` objects are silently ignored, so expected `lineHeight`/`letterSpacing` are simply absent
from the spec and Gate 1 cannot detect drift. Unknown paint types are likewise skipped without a warning, which can
turn gradient/shadow-only designs into partially verified references.

**Proposed fix:** map `AUTO` to the documented expected CSS representation (or skip with an explicit warning), and
emit a warning for unsupported fill/stroke types.

---

### BUG-011 (M) — MCP import tool bypasses validation and can write outside the project

**Where:** `src/mcp/server.ts:201-217` (`importReferenceSnapshot((args || {}) as any)`).

**Impact:** `level_check` arguments go through Zod inside `check()`, but `level_import_snapshot` accepts an unvalidated
object. A malformed call gives a generic `Import snapshot error: undefined`, and an arbitrary absolute `baseDir` lets
the tool create directories/files anywhere the process user can write. Slug and manifest path checks mitigate some
traversal, but `baseDir` itself is unrestricted.

**Proposed fix:** define a Zod schema for import arguments (and reuse it in the CLI), validate path types, and
constrain `baseDir` to the configured project root unless an explicit opt-in is given.

---

### BUG-012 (L) — Figma REST nodes without bounding boxes are dropped

**Where:** `src/adapters/figma-rest.normalizer.ts:69-70` (`if (!bbox) return;`).

**Impact:** Entire subtrees may disappear from the spec without a warning, leading to vacuous comparisons for those
nodes. Figma vectors/groups generally have `absoluteBoundingBox`, but `absoluteRenderBounds`-only or unusual nodes
can hit this path.

**Proposed fix:** fall back to `absoluteRenderBounds`, then to parent-relative `x/y/width/height` where available;
otherwise record a warning with the dropped node ID.

---

### BUG-013 (L) — Manifest metadata and docs are incomplete

**Where:** `src/schema.ts:162-179` defines `figma.nodeName/revision`, `figwright.pluginVersion/detail/dedupeComponents`;
`src/snapshot/manager.ts:196-213` populates only some of them; `src/cli.ts:419-440` exposes only `--figma-file`,
`--figma-name`, `--node-id`, `--figwright-version`; README's new section does not mention `--skip-integrity`,
`--dpr`, `--selector-map <file>`, or the security trade-off of skipping integrity checks.

**Impact:** Snapshots cannot fully record provenance from a Figwright export, and users cannot discover important
flags from the README.

**Proposed fix:** add CLI/MCP fields for the remaining metadata, document all snapshot flags, and add a "Integrity &
trust" paragraph explaining when `--skip-integrity` is acceptable.

---

### BUG-014 (L) — Node engine range does not match build target

**Where:** `package.json:25-27` (`"node": ">=20.0.0"`), `tsup.config.ts:12,25` (`target: "node22"`),
`src/cli.ts` doctor check (Node 20+).

**Impact:** A Node 20 consumer may install the package (npm honors `engines` only as a warning by default) and run a
bundle compiled for Node 22. CI only tests Node 22, so the mismatch is untested.

**Proposed fix:** either set `target: "node20"` and add a Node 20 CI matrix job, or raise `engines` to `>=22` and
update doctor/README.

---

### BUG-015 (L) — License file is missing

**Where:** repo root has no `LICENSE*`; `README.md:6` renders a license badge linking `LICENSE`, and `package.json`
declares MIT.

**Proposed fix:** add the MIT `LICENSE` file (and include it in `package.json.files` if npm does not add it
automatically).

---

### BUG-016 (L) — Tests share and mutate state

**Where:** `tests/figwright-bridge.test.ts:18` (one fixed `outputDir` for all tests), `:328-364` (appends a byte to
`references/test-card/reference.png` without restoring it).

**Impact:** Later assertions that reuse `test-card` operate on a tampered snapshot; failures depend on execution
order, and parallel workers would collide on the same directory.

**Proposed fix:** give each test its own temp directory, or snapshot/copy the reference before tampering and restore
it in a `finally` block.

---

## Improvement ideas

| ID | Idea | Why | Effort |
| --- | --- | --- | --- |
| IDEA-01 | Treat `NormalizedSpec` validation as a single choke point (`NormalizedSpecSchema.parse` + non-empty refinement) shared by all adapters, snapshot loader and MCP | Prevents BUG-001/BUG-007 class of false greens across every entry point | S |
| IDEA-02 | Explicit `snapshot update` / `--force` plus revision history, keeping `import` strictly immutable | Makes "frozen reference" a real guarantee and reviewable in git | M |
| IDEA-03 | `snapshot list` and `snapshot diff <a> <b>` commands showing manifest, DPR, selectorMap and spec drift | Snapshot lifecycle is currently import/verify only | M |
| IDEA-04 | Persist Figwright provenance (`detail`, `dedupeComponents`, plugin version, node name, revision) and a source pointer for re-capture | Enables the plan's `design_diff` → re-snapshot feedback loop | S |
| IDEA-05 | Surface mapping diagnostics: warn on invalid CSS selectors, unmatched `selectorMap` entries, and ambiguous multiple matches | Currently invalid selectors are swallowed in `el.matches` try/catch, causing silent misses | S |
| IDEA-06 | Machine-readable fix packets for coding agents (group violations by CSS file/line, suggest patch hunks) | Strengthens Layer 3 of the plan's agent feedback loop | M |
| IDEA-07 | Make tests hermetic: OS temp dirs, no `dist/` dependency, and a clean-checkout CI job that runs `npm test` before `npm run build` | Restores trust in the suite and catches packaging/test-order bugs | S |
| IDEA-08 | Stream SHA-256 for large reference images instead of `fs.readFileSync` in `computeFileSha256` | Avoids loading multi-MB PNGs into memory on every snapshot load | S |
| IDEA-09 | CI matrix across supported Node versions plus a smoke `ui-level doctor`/`snapshot --help` step | Closes BUG-014 and validates the published CLI surface | S |
| IDEA-10 | Document the 3-layer workflow diagram, failure taxonomy (style vs geometry vs pixel), troubleshooting, and exit codes in README | The plan's Layer 6 documentation requirement is only partially covered | S |
| IDEA-11 | Add golden fixtures for coordinate math (nested `GROUP`, `BOOLEAN_OPERATION`, AUTO layout, RTL) and DPR permutations | Coordinate accumulation and DPR parity are subtle and currently covered by a small fixture set | M |
| IDEA-12 | Run CDP inspection in one batched session with deduplicated selectors and a cap | Current per-violation loop can be slow on large violation sets | M |
| IDEA-13 | Add a `--json` smoke test through MCP stdio transport (`level_check`, `level_import_snapshot`, `level_doctor`) | MCP is a first-class surface in README but has no automated tests here | M |
| IDEA-14 | Replace heuristic format detection with explicit discriminated `kind`/`source` fields in stored specs | Reduces misclassification between NormalizedSpec, Figwright payloads and Figma REST ASTs | M |

---

## Suggested triage order

1. **BUG-001** — silent false pass; block release until fixed.
2. **BUG-002**, **BUG-010** — plan promises not met in the public converter.
3. **BUG-003**, **BUG-004** — make `npm test` green and self-contained.
4. **BUG-005**, **BUG-006**, **BUG-007** — snapshot trust model.
5. Everything else, batched with the corresponding ideas (e.g. BUG-001 + IDEA-01, BUG-003/004 + IDEA-07).
