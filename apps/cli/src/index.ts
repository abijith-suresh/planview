import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalApplication,
  parseDocumentReference,
  type LocalApplication,
  type LocalDaemonStatus,
} from "@planview/local";
import { Data, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { COMMANDS, formatHelp, type Command, type HelpTopic } from "./help.js";
import { installSkills } from "./skills.js";

export { HELP, formatHelp } from "./help.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const packageVersion = packageJson.version;
if (packageJson.name !== "@abijith-suresh/planview" || !SEMVER_PATTERN.test(packageVersion)) {
  throw new Error(`Invalid planview package metadata version: ${JSON.stringify(packageVersion)}`);
}

export const VERSION = packageVersion;

export const formatVersion = () => `planview ${VERSION}\n`;

type StdoutWriter = (message: string | Uint8Array) => void | Promise<void>;

const writeStdout: StdoutWriter = (message) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let writeFinished = false;
    let waitingForDrain = true;
    let settled = false;

    const cleanup = () => {
      process.stdout.off("drain", onDrain);
      process.stdout.off("error", onError);
    };
    const finish = (cause?: Error) => {
      if (settled) {
        return;
      }
      if (cause !== undefined) {
        settled = true;
        // Keep the error listener until a possible write error event arrives;
        // some streams report EPIPE through both the callback and the event.
        process.stdout.off("drain", onDrain);
        rejectPromise(cause);
        return;
      }
      if (!writeFinished || waitingForDrain) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise();
    };
    const onError = (cause: Error) => {
      finish(cause);
      process.stdout.off("error", onError);
    };
    const onDrain = () => {
      waitingForDrain = false;
      finish();
    };
    const onWrite = (cause?: Error | null) => {
      if (cause !== undefined && cause !== null) {
        finish(cause);
        return;
      }
      writeFinished = true;
      finish();
    };

    process.stdout.once("error", onError);
    try {
      waitingForDrain = !process.stdout.write(message, onWrite);
    } catch (cause) {
      finish(cause instanceof Error ? cause : new Error(String(cause)));
      return;
    }
    if (!waitingForDrain) {
      finish();
    } else {
      process.stdout.once("drain", onDrain);
      finish();
    }
  });

const writeStderr = (message: string) => {
  process.stderr.write(message);
};

export class UnknownOptionError extends Data.TaggedError("UnknownOptionError")<{
  readonly option: string;
  readonly message: string;
}> {}

export class UnknownCommandError extends Data.TaggedError("UnknownCommandError")<{
  readonly command: string;
  readonly message: string;
}> {}

export class UnexpectedArgumentsError extends Data.TaggedError("UnexpectedArgumentsError")<{
  readonly arguments: readonly string[];
  readonly message: string;
}> {}

export class DaemonCommandError extends Data.TaggedError("DaemonCommandError")<{
  readonly command: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class PublishCommandError extends Data.TaggedError("PublishCommandError")<{
  readonly sourcePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class PreviewCommandError extends Data.TaggedError("PreviewCommandError")<{
  readonly sourcePath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class GetCommandError extends Data.TaggedError("GetCommandError")<{
  readonly reference: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class SkillsCommandError extends Data.TaggedError("SkillsCommandError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class OutputCommandError extends Data.TaggedError("OutputCommandError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CliError =
  | UnknownOptionError
  | UnknownCommandError
  | UnexpectedArgumentsError
  | DaemonCommandError
  | PublishCommandError
  | PreviewCommandError
  | GetCommandError
  | SkillsCommandError
  | OutputCommandError;

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && (COMMANDS as readonly string[]).includes(value);

const isHelpOption = (value: string) => value === "--help" || value === "-h";

const isVersionOption = (value: string) => value === "--version" || value === "-v";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

type OutputFormat = "text" | "json";

type ParsedArguments = Readonly<{
  readonly help: boolean;
  readonly json: boolean;
  readonly force: boolean;
  readonly operands: readonly string[];
}>;

type OptionParserOptions = Readonly<{
  readonly allowForce?: boolean;
  readonly allowJson?: boolean;
  readonly allowLeadingHyphenOperand?: (argument: string) => boolean;
  readonly helpTopic: HelpTopic;
}>;

const unknownOption = (option: string, helpTopic?: HelpTopic) =>
  new UnknownOptionError({
    option,
    message: `Unknown option: ${option}\n\n${formatHelp(helpTopic)}`,
  });

const unexpectedArguments = (argumentsList: readonly string[], message: string) =>
  new UnexpectedArgumentsError({
    arguments: argumentsList,
    message,
  });

const parseOptions = (
  args: readonly string[],
  options: OptionParserOptions
): Effect.Effect<ParsedArguments, CliError> => {
  let optionsEnded = false;
  let help = false;
  let json = false;
  let force = false;
  const operands: string[] = [];

  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }

    if (!optionsEnded && isHelpOption(argument)) {
      help = true;
      continue;
    }

    if (!optionsEnded && argument === "--json") {
      if (options.allowJson !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      json = true;
      continue;
    }

    if (!optionsEnded && argument === "--force") {
      if (options.allowForce !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      force = true;
      continue;
    }

    if (
      !optionsEnded &&
      argument.startsWith("-") &&
      argument !== "-" &&
      options.allowLeadingHyphenOperand?.(argument) !== true
    ) {
      return Effect.fail(unknownOption(argument, options.helpTopic));
    }

    operands.push(argument);
  }

  return Effect.succeed({ help, json, force, operands });
};

const formatJson = (value: unknown) => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("The command result could not be represented as JSON.");
  }
  return `${serialized}\n`;
};

type CleanupFailureForJson = Readonly<{
  readonly phase: string;
  readonly id?: string;
  readonly message: string;
}>;

const cleanupResultForJson = <T extends { readonly failures: readonly CleanupFailureForJson[] }>(
  result: T
) => ({
  ...result,
  failures: result.failures.map(({ phase, id, message }) => ({
    phase,
    ...(id === undefined ? {} : { id }),
    message,
  })),
});

const writeOutput = (stdout: StdoutWriter, message: string | Uint8Array) =>
  Effect.tryPromise({
    try: async () => {
      await stdout(message);
    },
    catch: (cause) =>
      new OutputCommandError({
        cause,
        message: `Could not write command output: ${describe(cause)}`,
      }),
  });

const writeCommandResult = <A>(
  stdout: StdoutWriter,
  format: OutputFormat,
  value: A,
  text: (value: A) => string
) =>
  Effect.try({
    try: () => (format === "json" ? formatJson(value) : text(value)),
    catch: (cause) =>
      new OutputCommandError({
        cause,
        message: `Could not format command output: ${describe(cause)}`,
      }),
  }).pipe(Effect.flatMap((message) => writeOutput(stdout, message)));

const outputFormatFromArgs = (args: readonly string[]): OutputFormat => {
  let optionsEnded = false;
  for (const argument of args) {
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && argument === "--json") {
      return "json";
    }
  }
  return "text";
};

const conciseErrorMessage = (message: string) => message.split("\n\n", 1)[0] ?? message;

type JsonErrorDetails = {
  code: string;
  message: string;
  option?: string;
  command?: string;
  arguments?: readonly string[];
  sourcePath?: string;
  reference?: string;
};

const formatError = (error: CliError, format: OutputFormat) => {
  if (format === "text") {
    return error.message.endsWith("\n") ? error.message : `${error.message}\n`;
  }

  const details: JsonErrorDetails = {
    code: error._tag,
    message: conciseErrorMessage(error.message),
  };
  if (error instanceof UnknownOptionError) {
    details.option = error.option;
  } else if (error instanceof UnknownCommandError) {
    details.command = error.command;
  } else if (error instanceof UnexpectedArgumentsError) {
    details.arguments = error.arguments;
  } else if (error instanceof DaemonCommandError) {
    details.command = error.command;
  } else if (error instanceof PublishCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof PreviewCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof GetCommandError) {
    details.reference = error.reference;
  }
  return formatJson({ error: details });
};

const daemonScriptPath = () => fileURLToPath(new URL("./daemon.js", import.meta.url));

const localApplication: LocalApplication = createLocalApplication({
  daemonScriptPath: daemonScriptPath(),
});

const browserCommand = () =>
  process.platform === "win32"
    ? { command: "cmd.exe", arguments: ["/c", "start", ""] }
    : process.platform === "darwin"
      ? { command: "open", arguments: [] }
      : { command: "xdg-open", arguments: [] };

export const openUrl = (url: string, spawnProcess: typeof spawn = spawn) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    const browser = browserCommand();
    let settled = false;
    const child = spawnProcess(browser.command, [...browser.arguments, url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const cleanup = () => {
      child.off("error", onError);
      child.off("spawn", onSpawn);
    };
    const onError = (cause: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(cause);
    };
    const onSpawn = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.unref();
      resolvePromise();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });

const formatRunning = (status: Extract<LocalDaemonStatus, { readonly state: "running" }>) =>
  `Planview daemon is running at http://${status.host}:${status.port}/ (pid ${status.pid}).\n`;

const publishFailure = (sourcePath: string, cause: unknown) =>
  new PublishCommandError({
    sourcePath,
    cause,
    message: `Could not publish ${sourcePath}: ${describe(cause)}`,
  });

const publishSource = (sourcePath: string) =>
  localApplication
    .publish(sourcePath)
    .pipe(Effect.mapError((cause) => publishFailure(sourcePath, cause)));

const runPublishCommand = (sourcePath: string, format: OutputFormat, stdout: StdoutWriter) =>
  publishSource(sourcePath).pipe(
    Effect.flatMap((published) =>
      writeCommandResult(stdout, format, published, ({ url }) => `${url}\n`).pipe(
        Effect.map(() => 0)
      )
    ),
    Effect.mapError((cause) =>
      cause instanceof OutputCommandError || cause instanceof PublishCommandError
        ? cause
        : new PublishCommandError({
            sourcePath,
            cause,
            message: `Could not publish ${sourcePath}: ${describe(cause)}`,
          })
    )
  );

const runPreviewCommand = (sourcePath: string, format: OutputFormat, stdout: StdoutWriter) =>
  publishSource(sourcePath).pipe(
    Effect.flatMap((published) =>
      writeCommandResult(stdout, format, published, ({ url }) => `${url}\n`).pipe(
        Effect.flatMap(() =>
          Effect.tryPromise({
            try: () => openUrl(published.url),
            catch: (cause) => cause,
          })
        ),
        Effect.map(() => 0)
      )
    ),
    Effect.mapError((cause) =>
      cause instanceof PreviewCommandError || cause instanceof OutputCommandError
        ? cause
        : new PreviewCommandError({
            sourcePath,
            cause,
            message: `Could not preview ${sourcePath}: ${describe(cause)}`,
          })
    )
  );

const runGetCommand = (reference: string, stdout: StdoutWriter) =>
  localApplication
    .get({
      reference,
      onChunk: (chunk) => stdout(chunk),
    })
    .pipe(
      Effect.map(() => 0),
      Effect.mapError(
        (cause) =>
          new GetCommandError({
            reference,
            cause,
            message: `Could not retrieve ${reference}: ${describe(cause)}`,
          })
      )
    );

const runSkillsInstallCommand = (force: boolean, stdout: StdoutWriter) =>
  Effect.tryPromise({
    try: async () => {
      const destination = await installSkills({ force });
      await stdout(`Installed planview and create-html skills in ${destination}.\n`);
      return 0;
    },
    catch: (cause) =>
      new SkillsCommandError({
        cause,
        message: `Could not install Planview skills: ${describe(cause)}`,
      }),
  });

const runDaemonCommand = Effect.fnUntraced(
  function* (
    command: Exclude<Command, "publish" | "preview" | "get" | "skills" | "help">,
    format: OutputFormat,
    stdout: StdoutWriter
  ) {
    if (command === "status") {
      const result = yield* localApplication.inspect();
      yield* writeCommandResult(stdout, format, result, (status) =>
        status.state === "running" ? formatRunning(status) : "Planview daemon is not running.\n"
      );
      return 0;
    }

    if (command === "stop") {
      yield* localApplication.stop();
      yield* writeCommandResult(
        stdout,
        format,
        { state: "stopped" },
        () => "Planview daemon stopped.\n"
      );
      return 0;
    }

    if (command === "restart") {
      const result = yield* localApplication.restart();
      yield* writeCommandResult(
        stdout,
        format,
        result,
        (status) => `Planview daemon restarted at http://${status.host}:${status.port}/.\n`
      );
      return 0;
    }

    if (command === "clean") {
      const result = yield* localApplication.clean();
      const failures = result.failures.length;
      const summary =
        result.removedDocuments === 0 &&
        result.removedDocumentFiles === 0 &&
        result.removedMetadataRows === 0 &&
        result.removedStagedFiles === 0 &&
        result.removedReadReferences === 0 &&
        result.removedFinalizationLocks === 0 &&
        result.retainedEntries === 0
          ? "Planview cleanup found no expired or inconsistent snapshots."
          : `Planview cleanup removed ${result.removedDocuments} expired snapshot${result.removedDocuments === 1 ? "" : "s"}, reconciled ${result.removedMetadataRows} metadata row${result.removedMetadataRows === 1 ? "" : "s"} and ${result.removedDocumentFiles} document file${result.removedDocumentFiles === 1 ? "" : "s"}, reclaimed ${result.reclaimedBytes} bytes, and removed ${result.removedStagedFiles} staged file${result.removedStagedFiles === 1 ? "" : "s"}, ${result.removedReadReferences} crashed-read marker${result.removedReadReferences === 1 ? "" : "s"}, and ${result.removedFinalizationLocks} finalization lock${result.removedFinalizationLocks === 1 ? "" : "s"}.`;
      yield* writeCommandResult(stdout, format, cleanupResultForJson(result), (cleanup) => {
        const retained = cleanup.retainedEntries;
        return `${summary}${retained === 0 ? "" : ` ${retained} state${retained === 1 ? "" : "s"} retained for retry.`}\n`;
      });
      return failures === 0 ? 0 : 1;
    }

    const result = yield* localApplication.start();
    yield* writeCommandResult(
      stdout,
      format,
      { ...result.status, reused: result.reused },
      (start) =>
        start.reused
          ? `Planview daemon is already running at http://${start.host}:${start.port}/.\n`
          : `Planview daemon started at http://${start.host}:${start.port}/.\n`
    );
    return 0;
  },
  (effect, command) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new DaemonCommandError({
            command,
            cause,
            message: `Could not ${command} the Planview daemon: ${describe(cause)}`,
          })
      )
    )
);

export const parseGetReference = (reference: string, port?: number) =>
  String(parseDocumentReference(reference, port));

const writeHelp = (stdout: StdoutWriter, topic?: HelpTopic) =>
  writeOutput(stdout, formatHelp(topic)).pipe(Effect.as(0));

const runHelpCommand = (
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, { helpTopic: "help" }).pipe(
    Effect.flatMap(({ help, operands }): Effect.Effect<number, CliError> => {
      if (operands.length === 0) {
        return writeHelp(stdout, help ? "help" : undefined);
      }

      const topic =
        operands.length === 1 && isCommand(operands[0])
          ? operands[0]
          : operands.length === 2 && operands[0] === "skills" && operands[1] === "install"
            ? "skills install"
            : undefined;
      if (topic === undefined) {
        const requestedTopic = operands.join(" ");
        return Effect.fail(
          new UnknownCommandError({
            command: requestedTopic,
            message: `Unknown help topic: ${requestedTopic}\n\n${formatHelp("help")}`,
          })
        );
      }
      return writeHelp(stdout, topic);
    })
  );

const runSkillsCommand = (
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> => {
  const [subcommand, ...remaining] = args;
  if (subcommand === undefined || isHelpOption(subcommand)) {
    if (remaining.length > 0) {
      return Effect.fail(
        unexpectedArguments(
          remaining,
          `Unexpected arguments: ${remaining.join(" ")}\n\n${formatHelp("skills")}`
        )
      );
    }
    return writeHelp(stdout, "skills");
  }

  if (subcommand !== "install") {
    if (subcommand.startsWith("-") && subcommand !== "-") {
      return Effect.fail(unknownOption(subcommand, "skills"));
    }
    return Effect.fail(
      unexpectedArguments(args, `Unknown skills command: ${subcommand}\n\n${formatHelp("skills")}`)
    );
  }

  return parseOptions(remaining, { allowForce: true, helpTopic: "skills install" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) {
        return writeHelp(stdout, "skills install");
      }
      if (parsed.operands.length > 0) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Unexpected arguments: ${parsed.operands.join(" ")}\n\n${formatHelp("skills install")}`
          )
        );
      }
      return runSkillsInstallCommand(parsed.force, stdout);
    })
  );
};

const runDocumentCommand = (
  commandName: "publish" | "preview" | "get",
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, {
    allowJson: commandName !== "get",
    ...(commandName === "get"
      ? {
          allowLeadingHyphenOperand: (argument: string) => {
            try {
              parseDocumentReference(argument);
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    helpTopic: commandName,
  }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) {
        return writeHelp(stdout, commandName);
      }

      if (parsed.operands.length !== 1 || parsed.operands[0] === undefined) {
        const label =
          parsed.operands.length === 0
            ? commandName === "get"
              ? "Missing document id or URL"
              : "Missing source file or folder"
            : "Unexpected arguments";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}: ${parsed.operands.join(" ")}\n\n${formatHelp(commandName)}`
          )
        );
      }

      const format: OutputFormat = parsed.json ? "json" : "text";
      const operand = parsed.operands[0];
      if (commandName === "publish") {
        return runPublishCommand(operand, format, stdout);
      }
      if (commandName === "preview") {
        return runPreviewCommand(operand, format, stdout);
      }
      return runGetCommand(operand, stdout);
    })
  );

const runDaemonCommandFromArgs = (
  commandName: Exclude<Command, "publish" | "preview" | "get" | "skills" | "help">,
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowJson: true, helpTopic: commandName }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) {
        return writeHelp(stdout, commandName);
      }
      if (parsed.operands.length > 0) {
        const label = parsed.operands.length === 1 ? "Unexpected argument" : "Unexpected arguments";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}: ${parsed.operands.join(" ")}\n\n${formatHelp(commandName)}`
          )
        );
      }
      return runDaemonCommand(commandName, parsed.json ? "json" : "text", stdout);
    })
  );

const command = (
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    return writeHelp(stdout);
  }

  if (isHelpOption(argument) || isVersionOption(argument)) {
    if (trailing.length > 0) {
      const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
      return Effect.fail(
        unexpectedArguments(trailing, `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`)
      );
    }

    return isVersionOption(argument)
      ? writeOutput(stdout, formatVersion()).pipe(Effect.as(0))
      : writeHelp(stdout);
  }

  if (!isCommand(argument)) {
    if (argument.startsWith("-")) {
      return Effect.fail(unknownOption(argument));
    }
    return Effect.fail(
      new UnknownCommandError({
        command: argument,
        message: `Unknown command: ${argument}\n\n${formatHelp()}`,
      })
    );
  }

  if (argument === "help") {
    return runHelpCommand(trailing, stdout);
  }

  if (argument === "skills") {
    return runSkillsCommand(trailing, stdout);
  }

  if (argument === "publish" || argument === "preview" || argument === "get") {
    return runDocumentCommand(argument, trailing, stdout);
  }

  return runDaemonCommandFromArgs(argument, trailing, stdout);
};

export const run = (
  args: readonly string[],
  stdout = writeStdout,
  stderr = writeStderr
): Effect.Effect<number, CliError> =>
  command(args, stdout).pipe(
    Effect.tapError((error) =>
      Effect.try({
        try: () => stderr(formatError(error, outputFormatFromArgs(args))),
        catch: (cause) =>
          new OutputCommandError({
            cause,
            message: `Could not write command error: ${describe(cause)}`,
          }),
      })
    )
  );

const boundary = (program: Effect.Effect<number, CliError>) =>
  program.pipe(
    Effect.catchTag(
      [
        "UnknownOptionError",
        "UnknownCommandError",
        "UnexpectedArgumentsError",
        "DaemonCommandError",
        "PublishCommandError",
        "PreviewCommandError",
        "GetCommandError",
        "SkillsCommandError",
        "OutputCommandError",
      ],
      () => Effect.succeed(1)
    )
  );

export const main = (args = process.argv.slice(2), stdout = writeStdout, stderr = writeStderr) => {
  const program = boundary(run(args, stdout, stderr));
  return Effect.runPromise(program);
};

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
  const result = main();
  if (result instanceof Promise) {
    result.then((code) => {
      process.exitCode = code;
    });
  } else {
    process.exitCode = result;
  }
}
