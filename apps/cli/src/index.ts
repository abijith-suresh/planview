#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";

export const HELP = `Usage: planview [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

const writeStdout = (message: string) => {
  process.stdout.write(message);
};

const writeStderr = (message: string) => {
  process.stderr.write(message);
};

export const run = (args: readonly string[], stdout = writeStdout, stderr = writeStderr) => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    stdout(HELP);
    return 0;
  }

  if (argument !== "--help" && argument !== "-h" && argument !== "--version" && argument !== "-v") {
    stderr(`Unknown option: ${argument}\n\n${HELP}`);
    return 1;
  }

  if (trailing.length > 0) {
    const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
    stderr(`${label}: ${trailing.join(" ")}\n\n${HELP}`);
    return 1;
  }

  if (argument === "--version" || argument === "-v") {
    stdout(`planview ${VERSION}\n`);
    return 0;
  }

  stdout(HELP);
  return 0;
};

export const main = (args = process.argv.slice(2)) => run(args, writeStdout, writeStderr);

const isMain = (() => {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = main();
}
