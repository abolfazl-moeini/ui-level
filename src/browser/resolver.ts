import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";

const KNOWN_SYSTEM_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export function resolveBrowserExecutable(): string {
  // 1. Environment variable override
  const envCandidates = [
    process.env.UI_LEVEL_BROWSER_PATH,
    process.env.CHROME_BIN,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean) as string[];

  for (const candidate of envCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 2. Playwright managed / cached Chromium
  try {
    const pwPath = chromium.executablePath();
    if (pwPath && fs.existsSync(pwPath)) {
      return pwPath;
    }
  } catch {
    // Continue to system discovery
  }

  // 3. Known system locations
  const platform = os.platform();
  const paths = KNOWN_SYSTEM_PATHS[platform] || [];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    "No Chromium browser found! Please install Chrome, Chromium, or run 'npx playwright install chromium', or set UI_LEVEL_BROWSER_PATH."
  );
}

export async function launchBrowser(options?: LaunchOptions): Promise<Browser> {
  const executablePath = resolveBrowserExecutable();
  return chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "--disable-font-subpixel-positioning",
      "--disable-web-security",
    ],
    ...options,
  });
}
