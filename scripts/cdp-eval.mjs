#!/usr/bin/env node
/**
 * Evaluate JavaScript inside the running app's WebView, over the WebView2
 * remote-debugging protocol.
 *
 * Why this exists: `tsc`, `cargo check` and `cargo build` all pass on code that
 * fails the moment it runs. The only way to check the real frontend-to-Rust IPC
 * path end to end — actual `invoke()` calls against actual commands, touching a
 * real SQLite file — is to talk to the live WebView, because that layer cannot
 * be exercised by a normal browser (no `window.__TAURI_INTERNALS__`) and cannot
 * be driven by clicking (there is no automation channel for the native window).
 *
 * Usage:
 *   # 1. launch the app with debugging enabled
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
 *   .\galgame-manager.exe
 *
 *   # 2. evaluate an expression (awaited if it returns a promise)
 *   node scripts/cdp-eval.mjs "1 + 1"
 *   node scripts/cdp-eval.mjs --file probe.js
 *
 * The expression runs in page context with `await` support. Anything not
 * JSON-serialisable is returned as a string, and exceptions are reported with
 * their message rather than swallowed.
 */

import { readFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";
const ENDPOINT = `http://127.0.0.1:${PORT}`;

/** Pick the app page target (WebView2 also exposes workers/iframes). */
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
  if (!page) {
    throw new Error(
      `no page target found; saw: ${targets.map((t) => t.type).join(", ")}`,
    );
  }
  return page;
}

/**
 * Open a CDP session, run one `Runtime.evaluate`, and resolve with the value.
 *
 * Minimal by design: no dependency, one message in, one message out.
 */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out after 120s"));
    }, 120_000);

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression,
            // Let `await` work at the top level and unwrap the promise, so
            // async probes return their resolved value.
            awaitPromise: true,
            returnByValue: true,
            // Surface syntax errors instead of returning undefined.
            throwOnSideEffect: false,
          },
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.id !== id) return; // ignore unrelated notifications

      clearTimeout(timer);
      socket.close();

      const result = payload.result;
      if (payload.error) {
        reject(new Error(`CDP error: ${JSON.stringify(payload.error)}`));
        return;
      }
      if (result?.exceptionDetails) {
        const details = result.exceptionDetails;
        reject(
          new Error(
            details.exception?.description ??
              details.text ??
              "uncaught exception in page",
          ),
        );
        return;
      }
      resolve(result?.result?.value);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error talking to the WebView"));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let expression;
  if (args[0] === "--file") {
    if (!args[1]) throw new Error("--file needs a path");
    expression = readFileSync(args[1], "utf8");
  } else if (args.length > 0) {
    expression = args.join(" ");
  } else {
    throw new Error("usage: cdp-eval.mjs <expression> | --file <path>");
  }

  const target = await findPageTarget();
  const value = await evaluate(target.webSocketDebuggerUrl, expression);

  if (value === undefined) {
    console.log("(undefined)");
  } else if (typeof value === "string") {
    console.log(value);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

main().catch((error) => {
  console.error(`cdp-eval failed: ${error.message}`);
  process.exit(1);
});
