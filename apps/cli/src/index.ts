import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalApplication,
  isValidProfileName,
  type LocalApplication,
  type LocalDaemonStatus,
  parseDocumentReference,
} from "@planview/local";
import { Data, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { loginToCloud, removeCloudCredentials, uploadCloudDocument } from "./cloud.js";
import { COMMANDS, type Command, formatHelp, type HelpTopic } from "./help.js";
import { installSkills } from "./skills.js";

export { formatHelp, HELP } from "./help.js";

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

export class InvalidOptionValueError extends Data.TaggedError("InvalidOptionValueError")<{
  readonly option: string;
  readonly value?: string;
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

export class OpenBrowserCommandError extends Data.TaggedError("OpenBrowserCommandError")<{
  readonly sourcePath: string;
  readonly url: string;
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

export class CloudCommandError extends Data.TaggedError("CloudCommandError")<{
  readonly operation: "login" | "logout" | "upload";
  readonly cause: unknown;
  readonly message: string;
  readonly sourcePath?: string;
}> {}

export class OutputCommandError extends Data.TaggedError("OutputCommandError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type CliError =
  | UnknownOptionError
  | InvalidOptionValueError
  | UnknownCommandError
  | UnexpectedArgumentsError
  | DaemonCommandError
  | PublishCommandError
  | OpenBrowserCommandError
  | GetCommandError
  | SkillsCommandError
  | CloudCommandError
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
  readonly open: boolean;
  readonly cloudUrl?: string;
  readonly operands: readonly string[];
}>;

type ParsedGlobalArguments = Readonly<{
  readonly profile?: string;
  readonly commandArguments: readonly string[];
}>;

type OptionParserOptions = Readonly<{
  readonly allowForce?: boolean;
  readonly allowCloudUrl?: boolean;
  readonly allowJson?: boolean;
  readonly allowOpen?: boolean;
  readonly allowLeadingHyphenOperand?: (argument: string) => boolean;
  readonly helpTopic: HelpTopic;
}>;

const unknownOption = (option: string, helpTopic?: HelpTopic) =>
  new UnknownOptionError({
    option,
    message: `Unknown option: ${option}\n\n${formatHelp(helpTopic)}`,
  });

const invalidOptionValue = (option: string, value: string | undefined, message: string) =>
  new InvalidOptionValueError({
    option,
    ...(value === undefined ? {} : { value }),
    message,
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
  let open = false;
  let cloudUrl: string | undefined;
  const operands: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;

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

    if (!optionsEnded && argument === "--open") {
      if (options.allowOpen !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      open = true;
      continue;
    }

    if (!optionsEnded && argument === "--force") {
      if (options.allowForce !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      force = true;
      continue;
    }

    if (!optionsEnded && argument === "--cloud-url") {
      if (options.allowCloudUrl !== true) {
        return Effect.fail(unknownOption(argument, options.helpTopic));
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return Effect.fail(
          invalidOptionValue("--cloud-url", undefined, "Option --cloud-url requires a URL.")
        );
      }
      cloudUrl = value;
      index += 1;
      continue;
    }

    if (!optionsEnded && argument.startsWith("--cloud-url=")) {
      if (options.allowCloudUrl !== true) {
        return Effect.fail(unknownOption("--cloud-url", options.helpTopic));
      }
      const value = argument.slice("--cloud-url=".length);
      if (value.length === 0) {
        return Effect.fail(
          invalidOptionValue("--cloud-url", value, "Option --cloud-url requires a URL.")
        );
      }
      cloudUrl = value;
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

  return Effect.succeed({
    help,
    json,
    force,
    open,
    ...(cloudUrl === undefined ? {} : { cloudUrl }),
    operands,
  });
};

const parseGlobalOptions = (
  args: readonly string[]
): Effect.Effect<ParsedGlobalArguments, CliError> => {
  let profile: string | undefined;
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === undefined) {
      break;
    }
    if (argument === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return Effect.fail(
          invalidOptionValue("--profile", undefined, "Option --profile requires a profile name.")
        );
      }
      if (!isValidProfileName(value)) {
        return Effect.fail(
          invalidOptionValue(
            "--profile",
            value,
            `Invalid profile name: ${value}. Profile names start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores.`
          )
        );
      }
      profile = value;
      index += 2;
      continue;
    }

    if (argument.startsWith("--profile=")) {
      const value = argument.slice("--profile=".length);
      if (value.length === 0 || !isValidProfileName(value)) {
        return Effect.fail(
          invalidOptionValue(
            "--profile",
            value,
            `Invalid profile name: ${value || "(empty)"}. Profile names start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, and underscores.`
          )
        );
      }
      profile = value;
      index += 1;
      continue;
    }

    break;
  }

  return Effect.succeed({
    ...(profile === undefined ? {} : { profile }),
    commandArguments: args.slice(index),
  });
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
  value?: string;
  command?: string;
  arguments?: readonly string[];
  sourcePath?: string;
  reference?: string;
  operation?: string;
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
  } else if (error instanceof InvalidOptionValueError) {
    details.option = error.option;
    if (error.value !== undefined) {
      details.value = error.value;
    }
  } else if (error instanceof UnknownCommandError) {
    details.command = error.command;
  } else if (error instanceof UnexpectedArgumentsError) {
    details.arguments = error.arguments;
  } else if (error instanceof DaemonCommandError) {
    details.command = error.command;
  } else if (error instanceof PublishCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof OpenBrowserCommandError) {
    details.sourcePath = error.sourcePath;
  } else if (error instanceof GetCommandError) {
    details.reference = error.reference;
  } else if (error instanceof CloudCommandError) {
    details.operation = error.operation;
    if (error.sourcePath !== undefined) details.sourcePath = error.sourcePath;
  }
  return formatJson({ error: details });
};

const daemonScriptPath = () => fileURLToPath(new URL("./daemon.js", import.meta.url));

const applicationFor = (profile?: string): LocalApplication =>
  createLocalApplication({
    daemonScriptPath: daemonScriptPath(),
    ...(profile === undefined ? {} : { profile }),
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

const publishSource = (application: LocalApplication, sourcePath: string) =>
  application
    .publish(sourcePath)
    .pipe(Effect.mapError((cause) => publishFailure(sourcePath, cause)));

const openBrowserFailure = (sourcePath: string, url: string, cause: unknown) =>
  new OpenBrowserCommandError({
    sourcePath,
    url,
    cause,
    message: `Could not open ${url} in a browser: ${describe(cause)}`,
  });

const openPublishedUrl = (sourcePath: string, url: string) =>
  Effect.tryPromise({
    try: () => openUrl(url),
    catch: (cause) => openBrowserFailure(sourcePath, url, cause),
  });

const runPublishCommand = (
  application: LocalApplication,
  sourcePath: string,
  format: OutputFormat,
  open: boolean,
  stdout: StdoutWriter
) =>
  publishSource(application, sourcePath).pipe(
    Effect.flatMap((published) =>
      writeCommandResult(stdout, format, published, ({ url }) => `${url}\n`).pipe(
        Effect.flatMap(() =>
          open ? openPublishedUrl(sourcePath, published.url) : Effect.succeed(undefined)
        ),
        Effect.map(() => 0)
      )
    ),
    Effect.mapError((cause) =>
      cause instanceof OutputCommandError ||
      cause instanceof PublishCommandError ||
      cause instanceof OpenBrowserCommandError
        ? cause
        : new PublishCommandError({
            sourcePath,
            cause,
            message: `Could not publish ${sourcePath}: ${describe(cause)}`,
          })
    )
  );

const runGetCommand = (application: LocalApplication, reference: string, stdout: StdoutWriter) =>
  application
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
    command: Exclude<
      Command,
      "publish" | "upload" | "login" | "logout" | "get" | "skills" | "help"
    >,
    application: LocalApplication,
    format: OutputFormat,
    stdout: StdoutWriter
  ) {
    if (command === "status") {
      const result = yield* application.inspect();
      yield* writeCommandResult(stdout, format, result, (status) =>
        status.state === "running" ? formatRunning(status) : "Planview daemon is not running.\n"
      );
      return 0;
    }

    if (command === "stop") {
      yield* application.stop();
      yield* writeCommandResult(
        stdout,
        format,
        { state: "stopped" },
        () => "Planview daemon stopped.\n"
      );
      return 0;
    }

    if (command === "restart") {
      const result = yield* application.restart();
      yield* writeCommandResult(
        stdout,
        format,
        result,
        (status) => `Planview daemon restarted at http://${status.host}:${status.port}/.\n`
      );
      return 0;
    }

    if (command === "clean") {
      const result = yield* application.clean();
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

    const result = yield* application.start();
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

const runLoginCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowCloudUrl: true, helpTopic: "login" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "login");
      if (parsed.operands.length > 0) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Unexpected arguments: ${parsed.operands.join(" ")}\n\n${formatHelp("login")}`
          )
        );
      }

      return Effect.tryPromise({
        try: () =>
          loginToCloud({
            ...(profile === undefined ? {} : { profile }),
            ...(parsed.cloudUrl === undefined ? {} : { cloudUrl: parsed.cloudUrl }),
            openBrowser: openUrl,
            writeStatus: (message) => stdout(message),
          }),
        catch: (cause) =>
          new CloudCommandError({
            operation: "login",
            cause,
            message: `Cloud sign-in failed: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(({ cloudUrl }) =>
          writeOutput(stdout, `Signed in to ${cloudUrl}.\n`).pipe(Effect.as(0))
        )
      );
    })
  );

const runLogoutCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { helpTopic: "logout" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "logout");
      if (parsed.operands.length > 0) {
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `Unexpected arguments: ${parsed.operands.join(" ")}\n\n${formatHelp("logout")}`
          )
        );
      }

      return Effect.tryPromise({
        try: async () => {
          await removeCloudCredentials(profile);
          return 0;
        },
        catch: (cause) =>
          new CloudCommandError({
            operation: "logout",
            cause,
            message: `Could not remove the saved cloud sign-in: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(() =>
          writeOutput(stdout, "Removed the cloud sign-in saved on this computer.\n").pipe(
            Effect.as(0)
          )
        )
      );
    })
  );

const runCloudUploadCommand = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
): Effect.Effect<number, CliError> =>
  parseOptions(args, { allowJson: true, allowOpen: true, helpTopic: "upload" }).pipe(
    Effect.flatMap((parsed): Effect.Effect<number, CliError> => {
      if (parsed.help) return writeHelp(stdout, "upload");
      if (parsed.operands.length !== 1 || parsed.operands[0] === undefined) {
        const label = parsed.operands.length === 0 ? "Missing HTML file:" : "Unexpected arguments:";
        return Effect.fail(
          unexpectedArguments(
            parsed.operands,
            `${label}${parsed.operands.length === 0 ? "" : ` ${parsed.operands.join(" ")}`}\n\n${formatHelp("upload")}`
          )
        );
      }

      const sourcePath = parsed.operands[0];
      const format: OutputFormat = parsed.json ? "json" : "text";
      return Effect.tryPromise({
        try: () => uploadCloudDocument(sourcePath, profile),
        catch: (cause) =>
          new CloudCommandError({
            operation: "upload",
            sourcePath,
            cause,
            message: `Could not upload ${sourcePath}: ${describe(cause)}`,
          }),
      }).pipe(
        Effect.flatMap((uploaded) =>
          writeCommandResult(stdout, format, uploaded, ({ url }) => `${url}\n`).pipe(
            Effect.flatMap(() =>
              parsed.open
                ? Effect.tryPromise({
                    try: () => openUrl(uploaded.url),
                    catch: (cause) => openBrowserFailure(sourcePath, uploaded.url, cause),
                  })
                : Effect.succeed(undefined)
            ),
            Effect.map(() => 0)
          )
        )
      );
    })
  );

const runDocumentCommand = (
  commandName: "publish" | "get",
  application: LocalApplication,
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> =>
  parseOptions(args, {
    allowJson: commandName === "publish",
    allowOpen: commandName === "publish",
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
        return runPublishCommand(application, operand, format, parsed.open, stdout);
      }
      return runGetCommand(application, operand, stdout);
    })
  );

const runDaemonCommandFromArgs = (
  commandName: Exclude<
    Command,
    "publish" | "upload" | "login" | "logout" | "get" | "skills" | "help"
  >,
  application: LocalApplication,
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
      return runDaemonCommand(commandName, application, parsed.json ? "json" : "text", stdout);
    })
  );

const commandWithProfile = (
  args: readonly string[],
  stdout: StdoutWriter,
  profile?: string
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

  if (argument === "login") {
    return runLoginCommand(trailing, stdout, profile);
  }

  if (argument === "logout") {
    return runLogoutCommand(trailing, stdout, profile);
  }

  if (argument === "upload") {
    return runCloudUploadCommand(trailing, stdout, profile);
  }

  const application = applicationFor(profile);

  if (argument === "publish" || argument === "get") {
    return runDocumentCommand(argument, application, trailing, stdout);
  }

  return runDaemonCommandFromArgs(argument, application, trailing, stdout);
};

const command = (args: readonly string[], stdout: StdoutWriter): Effect.Effect<number, CliError> =>
  parseGlobalOptions(args).pipe(
    Effect.flatMap(({ profile, commandArguments }) =>
      commandWithProfile(commandArguments, stdout, profile)
    )
  );

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
        "InvalidOptionValueError",
        "UnknownCommandError",
        "UnexpectedArgumentsError",
        "DaemonCommandError",
        "PublishCommandError",
        "OpenBrowserCommandError",
        "GetCommandError",
        "SkillsCommandError",
        "CloudCommandError",
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
