import Color from "colorjs.io";

export interface ColorCompareResult {
  match: boolean;
  deltaE: number;
  expectedNormalized: string;
  actualNormalized: string;
}

export function parseColor(colorStr: string): Color | null {
  if (!colorStr || colorStr === "transparent" || colorStr === "inherit" || colorStr === "initial" || colorStr === "unset") {
    return null;
  }
  try {
    return new Color(colorStr.trim());
  } catch {
    return null;
  }
}

export function compareColors(
  expectedStr: string,
  actualStr: string,
  maxDeltaE: number = 2.0
): ColorCompareResult {
  const normExpected = expectedStr.trim().toLowerCase();
  const normActual = actualStr.trim().toLowerCase();

  if (normExpected === normActual) {
    return {
      match: true,
      deltaE: 0,
      expectedNormalized: expectedStr,
      actualNormalized: actualStr,
    };
  }

  const cExpected = parseColor(expectedStr);
  const cActual = parseColor(actualStr);

  if (!cExpected || !cActual) {
    // If one is transparent/null and the other is not
    const match = normExpected === normActual;
    return {
      match,
      deltaE: match ? 0 : 100,
      expectedNormalized: expectedStr,
      actualNormalized: actualStr,
    };
  }

  // Alpha check
  const alphaExpected = cExpected.alpha ?? 1;
  const alphaActual = cActual.alpha ?? 1;
  const alphaDiff = Math.abs(alphaExpected - alphaActual);

  if (alphaDiff > 0.05) {
    return {
      match: false,
      deltaE: Math.round(alphaDiff * 100),
      expectedNormalized: cExpected.toString({ format: "rgba" }),
      actualNormalized: cActual.toString({ format: "rgba" }),
    };
  }

  // Phase 4: Channel rounding tolerance (±3 per 8-bit channel, browser rasterizer vs Skia rounding)
  const rgbExp = cExpected.to("srgb");
  const rgbAct = cActual.to("srgb");
  const rDiff = Math.abs(Math.round((rgbExp.coords[0] ?? 0) * 255) - Math.round((rgbAct.coords[0] ?? 0) * 255));
  const gDiff = Math.abs(Math.round((rgbExp.coords[1] ?? 0) * 255) - Math.round((rgbAct.coords[1] ?? 0) * 255));
  const bDiff = Math.abs(Math.round((rgbExp.coords[2] ?? 0) * 255) - Math.round((rgbAct.coords[2] ?? 0) * 255));

  if (rDiff <= 3 && gDiff <= 3 && bDiff <= 3) {
    return {
      match: true,
      deltaE: 0,
      expectedNormalized: cExpected.toString({ format: "rgba" }),
      actualNormalized: cActual.toString({ format: "rgba" }),
    };
  }

  const deltaE = cExpected.deltaE(cActual, "2000");
  const match = deltaE <= maxDeltaE;

  return {
    match,
    deltaE: Number(deltaE.toFixed(3)),
    expectedNormalized: cExpected.toString({ format: "rgba" }),
    actualNormalized: cActual.toString({ format: "rgba" }),
  };
}
