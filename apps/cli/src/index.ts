#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

export const VERSION = "0.1.0";

export const HELP = `Usage: planview [options]

Options:
  -h, --help     Show this help message
  -v, --version  Show the version
`;

export const formatHelp = () => HELP;

export const formatVersion = () => `planview ${VERSION}\n`;

const writeStdout = (message: string) => {
  process.stdout.write(message);
};

const writeStderr = (message: string) => {
  process.stderr.write(message);
};

export class UnknownOptionError extends Data.TaggedError("UnknownOptionError")<{
  readonly option: string;
  readonly message: string;
}> {}

export class UnexpectedArgumentsError extends Data.TaggedError("UnexpectedArgumentsError")<{
  readonly arguments: readonly string[];
  readonly message: string;
}> {}

export type CliError = UnknownOptionError | UnexpectedArgumentsError;

const command = (
  args: readonly string[],
  stdout: (message: string) => void
): Effect.Effect<number, CliError> => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    const output = formatHelp();
    return Effect.sync(() => {
      stdout(output);
      return 0;
    });
  }

  if (argument !== "--help" && argument !== "-h" && argument !== "--version" && argument !== "-v") {
    return Effect.fail(
      new UnknownOptionError({
        option: argument,
        message: `Unknown option: ${argument}\n\n${formatHelp()}`,
      })
    );
  }

  if (trailing.length > 0) {
    const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
    return Effect.fail(
      new UnexpectedArgumentsError({
        arguments: trailing,
        message: `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`,
      })
    );
  }

  if (argument === "--version" || argument === "-v") {
    const output = formatVersion();
    return Effect.sync(() => {
      stdout(output);
      return 0;
    });
  }

  const output = formatHelp();
  return Effect.sync(() => {
    stdout(output);
    return 0;
  });
};

export const run = (args: readonly string[], stdout = writeStdout, stderr = writeStderr) =>
  command(args, stdout).pipe(
    Effect.tapError((error: CliError) => Effect.sync(() => stderr(`${error.message}`)))
  );

export const main = (args = process.argv.slice(2), stdout = writeStdout, stderr = writeStderr) =>
  Effect.runSync(
    run(args, stdout, stderr).pipe(
      Effect.catchTag(["UnknownOptionError", "UnexpectedArgumentsError"], () => Effect.succeed(1))
    )
  );

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
