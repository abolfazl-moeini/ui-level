import type { CDPSession, Page } from "playwright-core";
import type { CssRuleSource } from "../schema.js";

function toKebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

const SHORTHAND_PARENTS: Record<string, string[]> = {
  "padding-top": ["padding", "padding-block", "padding-block-start"],
  "padding-right": ["padding", "padding-inline", "padding-inline-end"],
  "padding-bottom": ["padding", "padding-block", "padding-block-end"],
  "padding-left": ["padding", "padding-inline", "padding-inline-start"],
  "margin-top": ["margin", "margin-block", "margin-block-start"],
  "margin-right": ["margin", "margin-inline", "margin-inline-end"],
  "margin-bottom": ["margin", "margin-block", "margin-block-end"],
  "margin-left": ["margin", "margin-inline", "margin-inline-start"],
  "border-top-width": ["border", "border-top", "border-width"],
  "border-right-width": ["border", "border-right", "border-width"],
  "border-bottom-width": ["border", "border-bottom", "border-width"],
  "border-left-width": ["border", "border-left", "border-width"],
  "border-top-left-radius": ["border-radius"],
  "border-top-right-radius": ["border-radius"],
  "border-bottom-right-radius": ["border-radius"],
  "border-bottom-left-radius": ["border-radius"],
  "row-gap": ["gap"],
  "column-gap": ["gap"],
  "font-size": ["font"],
  "font-weight": ["font"],
  "font-family": ["font"],
  "line-height": ["font"],
  "background-color": ["background"],
};

const INHERITED_PROPERTIES = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
]);

function findMatchingDecl(cssProperties: any[], kebabProp: string): any | undefined {
  if (!Array.isArray(cssProperties)) return undefined;

  const active = cssProperties.filter(
    (p: any) => p && !p.disabled && p.parsedOk !== false && p.value
  );

  // Prefer shorthand entry with range + expanded longhandProperties so we get exact line number
  const parentNames = SHORTHAND_PARENTS[kebabProp] || [];
  const shorthandWithRange = active.find(
    (p: any) =>
      p.range &&
      (parentNames.includes(p.name) ||
        (Array.isArray(p.longhandProperties) &&
          p.longhandProperties.some((lp: any) => lp.name === kebabProp)))
  );

  // Direct longhand declaration WITH range wins if it overrides an earlier shorthand in same block
  let lastLonghand: any;
  let lastShorthand: any;

  for (const p of active) {
    if (p.name === kebabProp && p.range) {
      lastLonghand = p;
    } else if (
      p.range &&
      (parentNames.includes(p.name) ||
        (Array.isArray(p.longhandProperties) &&
          p.longhandProperties.some((lp: any) => lp.name === kebabProp)))
    ) {
      lastShorthand = p;
    }
  }

  if (lastLonghand) return lastLonghand;
  if (lastShorthand) return lastShorthand;
  if (shorthandWithRange) return shorthandWithRange;

  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i].name === kebabProp) return active[i];
  }
  return undefined;
}

function findWinningFromList(
  rules: any[],
  kebabProp: string
): { rule: any; decl: any; important: boolean } | undefined {
  if (!Array.isArray(rules)) return undefined;

  // matchedCSSRules is ordered lowest -> highest cascade specificity.
  // An !important rule at any specificity beats all normal rules,
  // and among !important rules the highest specificity (reverse scan) wins.
  let bestImportant: { rule: any; decl: any; important: boolean } | undefined;
  let bestNormal: { rule: any; decl: any; important: boolean } | undefined;

  for (let i = rules.length - 1; i >= 0; i--) {
    const match = rules[i];
    const decl = findMatchingDecl(match?.rule?.style?.cssProperties, kebabProp);
    if (!decl) continue;

    if (decl.important) {
      if (!bestImportant) {
        bestImportant = { rule: match.rule, decl, important: true };
        break;
      }
    } else if (!bestNormal) {
      bestNormal = { rule: match.rule, decl, important: false };
    }
  }

  return bestImportant || bestNormal;
}

export interface CdpStyleInspector {
  inspect: (selector: string, property: string) => Promise<CssRuleSource | undefined>;
  dispose: () => Promise<void>;
}

export async function createCdpStyleInspector(page: Page): Promise<CdpStyleInspector> {
  const client: CDPSession = await page.context().newCDPSession(page);
  const headers = new Map<string, any>();

  client.on("CSS.styleSheetAdded", ({ header }: any) => {
    if (header?.styleSheetId) {
      headers.set(header.styleSheetId, header);
    }
  });

  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const doc = await client.send("DOM.getDocument", { depth: -1 });
  const rootNodeId = doc.root.nodeId;

  const nodeIdCache = new Map<string, number>();
  const matchedCache = new Map<number, any>();

  async function inspect(selector: string, property: string): Promise<CssRuleSource | undefined> {
    try {
      let nodeId = nodeIdCache.get(selector);
      if (nodeId === undefined) {
        const res = await client.send("DOM.querySelector", {
          nodeId: rootNodeId,
          selector,
        });
        nodeId = res.nodeId;
        if (!nodeId) return undefined;
        nodeIdCache.set(selector, nodeId);
      }

      let matchedStyles = matchedCache.get(nodeId);
      if (!matchedStyles) {
        matchedStyles = await client.send("CSS.getMatchedStylesForNode", { nodeId });
        matchedCache.set(nodeId, matchedStyles);
      }

      const kebabProp = toKebabCase(property);

      // 1. Check inline styles unless overridden by !important stylesheet rule
      const inlineDecl = findMatchingDecl(matchedStyles.inlineStyle?.cssProperties, kebabProp);
      const matchedWin = findWinningFromList(matchedStyles.matchedCSSRules, kebabProp);

      if (inlineDecl && (!matchedWin || inlineDecl.important || !matchedWin.important)) {
        return {
          selector: "style (inline)",
          cssText: `${inlineDecl.name}: ${inlineDecl.value}${inlineDecl.important ? " !important" : ""};`,
          line: 1,
        };
      }

      let winner = matchedWin;

      // 2. Fallback to inherited CSS rules for inheritable typography/color properties
      if (!winner && INHERITED_PROPERTIES.has(kebabProp) && Array.isArray(matchedStyles.inherited)) {
        for (const ancestor of matchedStyles.inherited) {
          const ancInline = findMatchingDecl(ancestor.inlineStyle?.cssProperties, kebabProp);
          if (ancInline) {
            return {
              selector: "ancestor style (inline)",
              cssText: `${ancInline.name}: ${ancInline.value};`,
              line: 1,
            };
          }
          const ancWin = findWinningFromList(ancestor.matchedCSSRules, kebabProp);
          if (ancWin) {
            winner = ancWin;
            break;
          }
        }
      }

      if (!winner) return undefined;

      const { rule, decl } = winner;
      const header = rule.styleSheetId ? headers.get(rule.styleSheetId) : undefined;
      const sourceFile = header?.sourceURL ? header.sourceURL : "inline <style>";
      const baseLine = header?.isInline && typeof header?.startLine === "number" ? header.startLine : 0;
      const declStartLine = decl.range?.startLine ?? rule.style?.range?.startLine;
      const sourceLine = typeof declStartLine === "number" ? baseLine + declStartLine + 1 : undefined;
      const sourceCol =
        typeof (decl.range?.startColumn ?? rule.style?.range?.startColumn) === "number"
          ? (decl.range?.startColumn ?? rule.style?.range?.startColumn) + 1
          : undefined;

      return {
        file: sourceFile,
        line: sourceLine,
        column: sourceCol,
        selector: rule.selectorList?.text || selector,
        cssText: `${decl.name}: ${decl.value}${decl.important ? " !important" : ""};`,
      };
    } catch {
      return undefined;
    }
  }

  async function dispose(): Promise<void> {
    try {
      await client.detach();
    } catch {
      // Ignore detach errors
    }
  }

  return { inspect, dispose };
}

export async function findWinningCssRule(
  page: Page,
  selector: string,
  property: string
): Promise<CssRuleSource | undefined> {
  let inspector: CdpStyleInspector | undefined;
  try {
    inspector = await createCdpStyleInspector(page);
    return await inspector.inspect(selector, property);
  } catch {
    return undefined;
  } finally {
    if (inspector) {
      await inspector.dispose();
    }
  }
}
