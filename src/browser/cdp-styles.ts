import type { Page } from "playwright-core";
import type { CssRuleSource } from "../schema.js";

// Helper to convert camelCase CSS properties to kebab-case
function toKebabCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export async function findWinningCssRule(
  page: Page,
  selector: string,
  property: string
): Promise<CssRuleSource | undefined> {
  let client: any = null;
  try {
    client = await page.context().newCDPSession(page);
    await client.send("DOM.enable");
    await client.send("CSS.enable");

    const doc = await client.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });

    if (!nodeId) {
      return undefined;
    }

    const matchedStyles = await client.send("CSS.getMatchedStylesForNode", { nodeId });
    const kebabProp = toKebabCase(property);

    // 1. Check inline styles
    if (matchedStyles.inlineStyle?.cssProperties) {
      const inlineProp = matchedStyles.inlineStyle.cssProperties.find(
        (p: any) => p.name === kebabProp || p.name === property
      );
      if (inlineProp && inlineProp.value) {
        return {
          selector: "style (inline)",
          cssText: `${inlineProp.name}: ${inlineProp.value};`,
          line: 1,
        };
      }
    }

    // 2. Check matched CSS rules in order of precedence
    // matchedCSSRules is sorted from lowest to highest specificity,
    // so we iterate in reverse to find the winning rule
    const rules = matchedStyles.matchedCSSRules || [];
    let winningMatch: any = null;
    let winningImportant = false;

    for (let i = rules.length - 1; i >= 0; i--) {
      const match = rules[i];
      const declarations = match.rule.style.cssProperties || [];
      const decl = declarations.find(
        (p: any) => p.name === kebabProp || p.name === property
      );

      if (decl && decl.value) {
        const isImportant = decl.important || false;
        if (isImportant && !winningImportant) {
          winningMatch = { match, decl };
          winningImportant = true;
          break; // Nothing overrides an !important rule with high specificity
        } else if (!winningMatch && !winningImportant) {
          winningMatch = { match, decl };
        }
      }
    }

    if (!winningMatch) {
      return undefined;
    }

    const rule = winningMatch.match.rule;
    const decl = winningMatch.decl;
    const ruleSelector = rule.selectorList?.text || selector;

    let sourceFile: string | undefined;
    let sourceLine: number | undefined;

    if (rule.styleSheetId) {
      try {
        const header = await client.send("CSS.getStyleSheetHeader", {
          styleSheetId: rule.styleSheetId,
        });
        sourceFile = header.header.sourceURL || "inline stylesheet";
        if (rule.style.range) {
          sourceLine = rule.style.range.startLine + 1;
        }
      } catch {
        // Fallback if header lookup fails
      }
    }

    return {
      file: sourceFile,
      line: sourceLine,
      selector: ruleSelector,
      cssText: `${decl.name}: ${decl.value}${decl.important ? " !important" : ""};`,
    };
  } catch {
    return undefined;
  } finally {
    if (client) {
      try {
        await client.detach();
      } catch {
        // Ignore detach errors
      }
    }
  }
}
