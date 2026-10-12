import fs from 'node:fs';
import { chromium } from 'playwright-core';

/** Use the installed browser; no browser download is needed. CHROME_PATH overrides detection. */
export function launchBrowser() {
  const executablePath = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((p) => p && fs.existsSync(p));
  if (!executablePath) throw new Error('Install Chrome/Chromium or set CHROME_PATH to its executable.');
  return chromium.launch({ executablePath, headless: true });
}
