#!/usr/bin/env node

import { spawnSync } from "child_process";
import { createRequire } from "module";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "docs/examples/tested-examples.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const args = process.argv.slice(2);
const implArg = readOption("--implementation") || "js";
const implementations = implArg === "all" ? ["js", "rust"] : [implArg];

function readOption(name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

function normalizeOutput(output) {
  return output
    .replace(/\r\n/g, "\n")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      "<uuid>",
    )
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/g, "<timestamp>")
    .replace(/\d+(?:\.\d{3})?s/g, "<duration>")
    .replace(/^│ log {7}.+$/gm, "│ log       <log-path>");
}

function assertReferenceExists(reference) {
  const filePath = join(root, reference.file);
  if (!existsSync(filePath)) {
    throw new Error(`Missing referenced documentation file: ${reference.file}`);
  }
  const content = readFileSync(filePath, "utf8");
  if (!content.includes(reference.text)) {
    throw new Error(
      `Documentation reference not found for ${reference.file}: ${reference.text}`,
    );
  }
}

function commandForImplementation(implementation, argv) {
  if (implementation === "js") {
    return {
      command: "bun",
      args: [join(root, "js/src/bin/cli.js"), ...argv],
    };
  }

  if (implementation === "rust") {
    const exe = process.platform === "win32" ? "start.exe" : "start";
    const candidates = [
      join(root, "rust/target/release", exe),
      join(root, "rust/target/debug", exe),
    ];
    const binary = candidates.find((candidate) => existsSync(candidate));
    if (!binary) {
      throw new Error(
        "Rust binary not found. Run `cargo build` or `cargo build --release` first.",
      );
    }
    return { command: binary, args: argv };
  }

  throw new Error(`Unknown implementation: ${implementation}`);
}

function runExample(example, implementation) {
  const commandSpec = example.commands?.[implementation];
  if (!commandSpec) {
    return;
  }

  const { command, args: commandArgs } = commandForImplementation(
    implementation,
    commandSpec.argv,
  );
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    input: commandSpec.stdin || undefined,
    env: {
      ...process.env,
      START_DISABLE_AUTO_ISSUE: "1",
      START_DISABLE_LOG_UPLOAD: "1",
      START_DISABLE_TRACKING: "1",
      START_LOG_DIR: join(root, ".tmp-doc-example-logs"),
    },
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${example.id} failed for ${implementation}: exit ${result.status}\n${result.stderr}`,
    );
  }

  const actual = normalizeOutput(result.stdout);
  const expected = example.expectedNormalizedStdout;
  if (actual !== expected) {
    throw new Error(
      `${example.id} output mismatch for ${implementation}\n\nExpected:\n${expected}\nActual:\n${actual}`,
    );
  }
}

function verifyParseOnly(example) {
  if (!example.parseOnly) {
    return;
  }

  const { parseArgs } = require("../js/src/lib/args-parser");
  const parsed = parseArgs(example.parseOnly.argv);
  const expected = example.parseOnly.expected || {};

  for (const [key, value] of Object.entries(expected)) {
    const actual =
      key === "command" ? parsed.command : parsed.wrapperOptions[key];
    if (actual !== value) {
      throw new Error(
        `${example.id} parse mismatch for ${key}: expected ${value}, got ${actual}`,
      );
    }
  }

  if (example.parseOnly.requiresImage && !parsed.wrapperOptions.image) {
    throw new Error(`${example.id} expected parser to assign a Docker image`);
  }
}

for (const example of manifest.examples) {
  for (const reference of example.references || []) {
    assertReferenceExists(reference);
  }
  verifyParseOnly(example);
  for (const implementation of implementations) {
    runExample(example, implementation);
  }
}

console.log(
  `Checked ${manifest.examples.length} documented example(s) for ${implementations.join(", ")}.`,
);
