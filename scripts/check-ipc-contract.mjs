#!/usr/bin/env node
/**
 * Cross-check the Tauri IPC contract between frontend and Rust.
 *
 * Catches three failure modes that `tsc` and `cargo check` cannot see, because
 * both sides are individually valid — only the *agreement* is wrong:
 *
 *   1. A command the frontend calls but Rust never registers.
 *      → runtime "command not found", nothing fails at build time.
 *   2. A `#[tauri::command]` defined but missing from `generate_handler!`.
 *      → dead code that looks live.
 *   3. A parameter name the frontend sends that the Rust signature does not
 *      declare. Tauri maps camelCase JS keys onto snake_case Rust params, so
 *      `{ externalId }` needs `external_id: ...`; a typo silently deserialises
 *      to nothing and the command receives a missing-argument error.
 *
 * Run from the project root:
 *   node scripts/check-ipc-contract.mjs
 *
 * Exits non-zero on any mismatch so it can gate a build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const RUST = join(ROOT, "src-tauri", "src");
const LIB = join(RUST, "lib.rs");

/** Recursively list files under `dir` with one of `exts`. */
function walk(dir, exts) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(full))) out.push(full);
  }
  return out;
}

/**
 * Strip Rust line comments so commented-out code is not mistaken for live code.
 * (A previous audit in this repo was briefly misled by matching a warning that
 * only existed inside a comment.)
 */
function stripRustComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Commands registered in `generate_handler![...]`. */
function registeredCommands() {
  const lib = stripRustComments(readFileSync(LIB, "utf8"));
  const at = lib.indexOf("generate_handler![");
  if (at === -1) throw new Error("generate_handler! not found in lib.rs");
  // Bracket-match from the opening `[` so nested commas/attributes cannot
  // confuse a naive split.
  let depth = 0;
  let start = at + "generate_handler!".length;
  let end = -1;
  for (let i = start; i < lib.length; i += 1) {
    if (lib[i] === "[") depth += 1;
    else if (lib[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = lib.slice(start + 1, end);
  const names = [];
  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*,/g)) {
    names.push(match[1]);
  }
  return new Set(names);
}

/**
 * Every `#[tauri::command]` function: its name and declared parameter names,
 * excluding the injected `app`/`state` arguments (which the frontend never
 * sends).
 */
function rustCommands() {
  const files = walk(RUST, [".rs"]);
  const found = new Map();
  for (const file of files) {
    const text = stripRustComments(readFileSync(file, "utf8"));
    // The regex is rebuilt per file to keep `lastIndex` from leaking between
    // files when used with matchAll.
    const re =
      /#\[tauri::command\][\s\S]{0,120}?\bfn\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?:->|\{)/g;
    for (const match of text.matchAll(re)) {
      const [, name, params] = match;
      const names = params
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.split(":")[0].trim())
        .filter((p) => p && p !== "app" && p !== "state" && p !== "window");
      found.set(name, { file: file.replace(ROOT + "\\", ""), params: names });
    }
  }
  return found;
}

/**
 * Extract the top-level key names of an object literal body.
 *
 * Splits on commas at brace/bracket/paren depth 0, then takes the text before
 * any `:` as the key (covering both `{ a: 1 }` and shorthand `{ a }`).
 *
 * This deliberately does *not* rely on a key being followed by `,` or `:`: the
 * final key in `{ provider, externalId }` has neither, and an earlier version of
 * this script silently skipped it — which meant a real typo in that position
 * went undetected while the check still reported success.
 */
function objectKeys(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const keys = [];
  for (const part of parts) {
    const key = part.split(":")[0].trim();
    // Only bare identifiers are real argument names; this drops spreads
    // (`...rest`) and anything else that is not a plain key.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

/**
 * Find the `{ ... }` argument object starting at `from`, or `null`.
 * Brace-matching is used rather than a lazy regex so nested objects (for example
 * a `detail` payload) do not truncate the match.
 */
function objectBodyAt(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] !== "{") return null;
  let depth = 0;
  const start = i;
  for (; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

/** Every `invoke('name', { ... })` in the frontend, with its literal keys. */
function frontendCalls() {
  const files = walk(SRC, [".ts", ".tsx"]);
  const calls = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const re = /invoke\s*(?:<[^>]*>)?\s*\(\s*['"]([a-z0-9_]+)['"]/g;
    for (const match of text.matchAll(re)) {
      const name = match[1];
      const after = match.index + match[0].length;
      // Anything from here to the next `,` should be whitespace before the
      // options object; if there is no object, the call takes no arguments.
      const body = objectBodyAt(text, after + (text[after] === "," ? 1 : 0));
      const keys = body ? objectKeys(body) : [];
      calls.push({
        name,
        keys,
        file: file.replace(ROOT + "\\", ""),
      });
    }
  }
  return calls;
}

/** `externalId` -> `external_id`, matching Tauri's argument convention. */
function toSnake(name) {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function main() {
  const registered = registeredCommands();
  const rust = rustCommands();
  const calls = frontendCalls();

  const problems = [];

  // (1) frontend calls a command that is not registered.
  const calledNames = new Set(calls.map((c) => c.name));
  for (const name of calledNames) {
    if (!registered.has(name)) {
      problems.push(
        `[not registered] frontend invokes "${name}" but generate_handler! does not list it`,
      );
    }
  }

  // (2) a #[tauri::command] exists but is never registered.
  for (const name of rust.keys()) {
    if (!registered.has(name)) {
      problems.push(
        `[dead command] "#[tauri::command] ${name}" is defined but not registered`,
      );
    }
  }

  // (3) parameter-name agreement.
  for (const call of calls) {
    const definition = rust.get(call.name);
    if (!definition) {
      // Already reported by (1) unless it is registered-but-not-defined.
      if (registered.has(call.name) && !definition) {
        problems.push(
          `[not defined] "${call.name}" is registered but no #[tauri::command] fn was found`,
        );
      }
      continue;
    }
    const expected = new Set(definition.params.map(toSnake));
    for (const key of call.keys) {
      if (!expected.has(toSnake(key))) {
        problems.push(
          `[param mismatch] "${call.name}" (${call.file}) sends "${key}" but Rust declares [${definition.params.join(", ")}]`,
        );
      }
    }
  }

  console.log(`registered commands : ${registered.size}`);
  console.log(`#[tauri::command] fns: ${rust.size}`);
  console.log(`frontend invoke sites: ${calls.length}`);

  if (problems.length === 0) {
    console.log("\nOK — frontend and Rust agree on commands and parameters.");
    return 0;
  }
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log("  " + p);
  return 1;
}

process.exit(main());
