#!/usr/bin/env node
/**
 * Screenshot the running app's WebView, over the WebView2 remote-debugging
 * protocol.
 *
 * Useful for visually confirming rendering that no assertion can really cover —
 * a glass/blur theme, layout at a given window size, whether the UI is blank.
 *
 * Usage:
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
 *   node scripts/cdp-shot.mjs out.png
 */

import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";
const ENDPOINT = `http://127.0.0.1:${PORT}`;

async function findPageTarget() {
  const response = await fetch(`${ENDPOINT}/json/list`);
  if (!response.ok) {
    throw new Error(
      `CDP returned HTTP ${response.status}. Is the app running with ` +
        `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT}?`,
    );
  }
  const targets = await response.json();
  const page = targets.find(
    (t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string",
  );
  if (!page) throw new Error("no page target found");
  return page;
}

/** Send one CDP command and resolve with its `result`. */
function send(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out after 60s"));
    }, 60_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, method, params }));
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.id !== id) return;
      clearTimeout(timer);
      socket.close();
      if (payload.error) reject(new Error(JSON.stringify(payload.error)));
      else resolve(payload.result);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error talking to the WebView"));
    });
  });
}

async function main() {
  const outPath = process.argv[2] ?? "screenshot.png";
  const target = await findPageTarget();
  const result = await send(target.webSocketDebuggerUrl, "Page.captureScreenshot", {
    format: "png",
    // Capture beyond the viewport so the whole window is included.
    captureBeyondViewport: false,
  });
  if (!result?.data) throw new Error("CDP returned no image data");
  writeFileSync(outPath, Buffer.from(result.data, "base64"));
  console.log(`${outPath} (${Buffer.from(result.data, "base64").length} bytes)`);
}

main().catch((error) => {
  console.error(`cdp-shot failed: ${error.message}`);
  process.exit(1);
});
