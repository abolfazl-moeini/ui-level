export const SEMANTIC_PARTS: Array<[string, string]> = [
  ["header", "header"],
  ["nav", "navigation bar"],
  ["main", "main area"],
  ["footer", "footer"],
  ["section", "section"],
  ["article", "article"],
  ["aside", "sidebar"],
  ["form", "form"],
  ["h1", "top heading"],
  ["h2", "subheading"],
  ["h3", "subheading"],
  ["h4", "subheading"],
  ["ul", "list"],
  ["ol", "list"],
  ["img", "image"],
  ["video", "video"],
  ["button", "button"],
  ["input", "form field"],
  ["select", "form field"],
  ["textarea", "form field"],
];

const ROLE_MAP: Record<string, string> = {
  banner: "header",
  navigation: "nav",
  main: "main",
  contentinfo: "footer",
  complementary: "aside",
  form: "form",
  search: "form",
  button: "button",
  img: "img",
};

export interface SemanticElementItem {
  tagName?: string;
  role?: string;
}

/**
 * Extracts a normalized semantic outline from a list of elements.
 */
export function extractSemanticSkeleton(elements: SemanticElementItem[]): string[] {
  const outline: string[] = [];

  for (const item of elements) {
    const rawRole = item.role?.trim().toLowerCase();
    const rawTag = item.tagName?.trim().toLowerCase();

    let mappedTag: string | undefined;
    if (rawRole && ROLE_MAP[rawRole]) {
      mappedTag = ROLE_MAP[rawRole];
    } else if (rawTag) {
      mappedTag = rawTag;
    }

    if (!mappedTag) continue;

    const matchedPart = SEMANTIC_PARTS.find(([tag]) => tag === mappedTag);
    if (matchedPart) {
      outline.push(matchedPart[1]);
    }
  }

  return outline;
}

/**
 * Longest Common Subsequence (LCS) length between two token lists.
 */
export function computeLongestCommonSubsequence(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;

  let row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diag = 0;
    for (let j = 0; j < b.length; j++) {
      const y = b[j];
      const up = row[j + 1];
      row[j + 1] = x === y ? diag + 1 : Math.max(up, row[j]);
      diag = up;
    }
  }
  return row[b.length];
}

export interface MissingPart {
  name: string;
  count: number;
}

export interface StructureLikeness {
  similarity: number; // 0..100
  missing: MissingPart[];
  note: string;
}

/**
 * Compares reference page structure with live page structure via LCS.
 */
export function computeStructureLikeness(
  refSkeleton: string[],
  liveSkeleton: string[]
): StructureLikeness {
  if (refSkeleton.length === 0) {
    return {
      similarity: liveSkeleton.length === 0 ? 100 : 0,
      missing: [],
      note: "No reference outline to compare",
    };
  }

  const commonLen = computeLongestCommonSubsequence(refSkeleton, liveSkeleton);
  const totalLen = refSkeleton.length + liveSkeleton.length;
  const similarity = Number(((200.0 * commonLen) / totalLen).toFixed(1));

  const countOccurrences = (arr: string[], key: string): number => {
    let c = 0;
    for (const item of arr) {
      if (item === key) c++;
    }
    return c;
  };

  const missing: MissingPart[] = [];
  const checkedNames = new Set<string>();

  for (const [, plainName] of SEMANTIC_PARTS) {
    if (checkedNames.has(plainName)) continue;
    checkedNames.add(plainName);

    const countRef = countOccurrences(refSkeleton, plainName);
    const countLive = countOccurrences(liveSkeleton, plainName);

    if (countRef > countLive) {
      missing.push({ name: plainName, count: countRef - countLive });
    }
  }

  // Sort descending by count, truncate to 6
  missing.sort((a, b) => b.count - a.count);
  const truncatedMissing = missing.slice(0, 6);

  let note = `structure ${Math.round(similarity)}% alike`;
  if (truncatedMissing.length > 0) {
    const partsStr = truncatedMissing
      .map((m) => (m.count === 1 ? `a ${m.name}` : `${m.count} ${m.name}s`))
      .join(", ");
    note += `; missing parts: ${partsStr}`;
  }

  return {
    similarity,
    missing: truncatedMissing,
    note,
  };
}

/**
 * Checks for unintended horizontal overflow: page_w <= viewport_w + 1
 */
export function checkHorizontalOverflow(
  scrollWidth: number,
  viewportWidth: number
): { overflow: boolean; delta: number; hint?: string } {
  const allowed = viewportWidth + 1;
  const overflow = scrollWidth > allowed;
  const delta = Math.max(0, scrollWidth - viewportWidth);

  return {
    overflow,
    delta,
    hint: overflow
      ? `Horizontal scroll overflow detected: page width (${scrollWidth}px) exceeds viewport (${viewportWidth}px) by ${delta}px`
      : undefined,
  };
}

/**
 * Cleans hashed font names (e.g. Next.js font hashes: __Vazirmatn_91a2b3 -> Vazirmatn).
 */
export function cleanFontFamilyName(fontFamily: string): string {
  if (!fontFamily) return fontFamily;

  return fontFamily
    .split(",")
    .map((entry) => {
      let trimmed = entry.trim().replace(/^['"]|['"]$/g, "");
      // Match Next.js font patterns: __<FontName>_<hash> or __<FontName>_Fallback_<hash>
      const nextFontMatch = trimmed.match(/^__([A-Za-z0-9_-]+?)(?:_Fallback)?(?:_[a-f0-9]{5,})?$/i);
      if (nextFontMatch && nextFontMatch[1]) {
        trimmed = nextFontMatch[1].replace(/_/g, " ");
      }
      return trimmed;
    })
    .join(", ");
}
