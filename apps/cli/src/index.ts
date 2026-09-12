import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidDocumentId, V1_PORT } from "@planview/core";
import {
  cleanDaemon,
  inspectDaemon,
  publishDocument,
  resolveDaemonConfig,
  resolveDaemonConfigForTest,
  restartDaemon,
  retrieveDocument,
  startDetachedDaemon,
  stopDaemon,
} from "@planview/daemon";
import { Data, Effect } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { preparePublishSource } from "./publish-source.js";
import { installSkills } from "./skills.js";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const packageVersion = packageJson.version;
if (packageJson.name !== "@abijith-suresh/planview" || !SEMVER_PATTERN.test(packageVersion)) {
  throw new Error(`Invalid planview package metadata version: ${JSON.stringify(packageVersion)}`);
}

export const VERSION = packageVersion;

export const HELP = `Usage: planview <command>

Commands:
  publish     Publish one immutable HTML snapshot and print its localhost URL
  preview     Publish a file or page folder and open its URL in a browser
  get         Retrieve a stored HTML snapshot by id or exact local URL
  start       Start the local daemon, or reuse the running daemon
  status      Show daemon status without starting it
  stop        Gracefully stop the local daemon
  restart     Restart the local daemon
  clean       Remove expired snapshots and reconcile storage
  skills      Install bundled Agent Skills

Options:
  -h, --help     Show this help message
  -v, --version  Show the version

Skills:
  planview skills install [--force]
                 Install bundled skills into ~/.agents/skills; existing skill
                 directories are refused unless --force is supplied.
`;

export const formatHelp = () => HELP;

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

const COMMANDS = [
  "publish",
  "preview",
  "get",
  "start",
  "status",
  "stop",
  "restart",
  "clean",
  "skills",
] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && (COMMANDS as readonly string[]).includes(value);

const isOption = (value: string) =>
  value === "--help" || value === "-h" || value === "--version" || value === "-v";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const daemonScriptPath = () => fileURLToPath(new URL("./daemon.js", import.meta.url));

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

const resolveCliDaemonConfig = () => {
  const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
  const testPort = NODE_ENV === "test" ? configuredTestPort : undefined;
  return testPort === undefined
    ? resolveDaemonConfig()
    : resolveDaemonConfigForTest({ port: Number(testPort) });
};

const formatRunning = (status: {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
}) => `Planview daemon is running at http://${status.host}:${status.port}/ (pid ${status.pid}).\n`;

const publishFailure = (sourcePath: string, cause: unknown) =>
  new PublishCommandError({
    sourcePath,
    cause,
    message: `Could not publish ${sourcePath}: ${describe(cause)}`,
  });

const publishSource = (sourcePath: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => preparePublishSource(sourcePath),
      catch: (cause) => publishFailure(sourcePath, cause),
    }),
    (prepared) =>
      Effect.tryPromise({
        try: () => Promise.resolve(resolveCliDaemonConfig()),
        catch: (cause) => publishFailure(sourcePath, cause),
      }).pipe(
        Effect.flatMap((config) =>
          publishDocument(config, {
            daemonScriptPath: daemonScriptPath(),
            sourcePath: prepared.sourcePath,
            sourceSizeBytes: prepared.sourceSizeBytes,
          }).pipe(
            Effect.map(
              (published) => `http://localhost:${published.descriptor.port}/${published.id}`
            ),
            Effect.mapError((cause) => publishFailure(sourcePath, cause))
          )
        )
      ),
    (prepared) =>
      Effect.tryPromise({
        try: () => prepared.cleanup(),
        catch: (cause) => publishFailure(sourcePath, cause),
      })
  );

const runPublishCommand = (sourcePath: string, stdout: StdoutWriter) =>
  publishSource(sourcePath).pipe(
    Effect.flatMap((url) =>
      Effect.tryPromise({
        try: async () => {
          await stdout(`${url}\n`);
          return 0;
        },
        catch: (cause) =>
          new OutputCommandError({
            cause,
            message: `Could not write the published URL: ${describe(cause)}`,
          }),
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof OutputCommandError
        ? cause
        : new PublishCommandError({
            sourcePath,
            cause,
            message: `Could not publish ${sourcePath}: ${describe(cause)}`,
          })
    )
  );

const runPreviewCommand = (sourcePath: string, stdout: StdoutWriter) =>
  publishSource(sourcePath).pipe(
    Effect.flatMap((url) =>
      Effect.tryPromise({
        try: async () => {
          await stdout(`${url}\n`);
          await openUrl(url);
          return 0;
        },
        catch: (cause) => cause,
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof PreviewCommandError
        ? cause
        : new PreviewCommandError({
            sourcePath,
            cause,
            message: `Could not preview ${sourcePath}: ${describe(cause)}`,
          })
    )
  );

const runGetCommand = (reference: string, stdout: StdoutWriter) =>
  Effect.tryPromise({
    try: () =>
      Promise.resolve().then(() => {
        const config = resolveCliDaemonConfig();
        return { config, documentId: parseDocumentReference(reference, config.port) };
      }),
    catch: (cause) =>
      new GetCommandError({
        reference,
        cause,
        message: `Could not retrieve ${reference}: ${describe(cause)}`,
      }),
  }).pipe(
    Effect.flatMap(({ config, documentId }) =>
      retrieveDocument(config, {
        daemonScriptPath: daemonScriptPath(),
        documentId,
        onChunk: (chunk) => stdout(chunk),
      }).pipe(
        Effect.map(() => 0),
        Effect.mapError(
          (cause) =>
            new GetCommandError({
              reference,
              cause,
              message: `Could not retrieve ${reference}: ${describe(cause)}`,
            })
        )
      )
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

const runDaemonCommand = (
  command: Exclude<Command, "publish" | "preview" | "get" | "skills">,
  stdout: StdoutWriter
) =>
  Effect.tryPromise({
    try: () => Promise.resolve(resolveCliDaemonConfig()),
    catch: (cause) =>
      new DaemonCommandError({
        command,
        cause,
        message: `Could not ${command} the Planview daemon: ${describe(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((config) =>
      Effect.gen(function* () {
        const write = (message: string) =>
          Effect.tryPromise({
            try: () => Promise.resolve(stdout(message)),
            catch: (cause) => cause,
          });

        if (command === "status") {
          const result = yield* inspectDaemon(config);
          yield* write(
            result.state === "running"
              ? formatRunning(result.status)
              : "Planview daemon is not running.\n"
          );
          return 0;
        }

        if (command === "stop") {
          yield* stopDaemon(config);
          yield* write("Planview daemon stopped.\n");
          return 0;
        }

        if (command === "restart") {
          const result = yield* restartDaemon(config, { daemonScriptPath: daemonScriptPath() });
          yield* write(
            `Planview daemon restarted at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
          );
          return 0;
        }

        if (command === "clean") {
          const result = yield* cleanDaemon(config, { daemonScriptPath: daemonScriptPath() });
          const failures = result.result.failures.length;
          const summary =
            result.result.removedDocuments === 0 &&
            result.result.removedDocumentFiles === 0 &&
            result.result.removedMetadataRows === 0 &&
            result.result.removedStagedFiles === 0 &&
            result.result.removedReadReferences === 0 &&
            result.result.removedFinalizationLocks === 0 &&
            result.result.retainedEntries === 0
              ? "Planview cleanup found no expired or inconsistent snapshots."
              : `Planview cleanup removed ${result.result.removedDocuments} expired snapshot${result.result.removedDocuments === 1 ? "" : "s"}, reconciled ${result.result.removedMetadataRows} metadata row${result.result.removedMetadataRows === 1 ? "" : "s"} and ${result.result.removedDocumentFiles} document file${result.result.removedDocumentFiles === 1 ? "" : "s"}, reclaimed ${result.result.reclaimedBytes} bytes, and removed ${result.result.removedStagedFiles} staged file${result.result.removedStagedFiles === 1 ? "" : "s"}, ${result.result.removedReadReferences} crashed-read marker${result.result.removedReadReferences === 1 ? "" : "s"}, and ${result.result.removedFinalizationLocks} finalization lock${result.result.removedFinalizationLocks === 1 ? "" : "s"}.`;
          const retained = result.result.retainedEntries;
          yield* write(
            `${summary}${retained === 0 ? "" : ` ${retained} state${retained === 1 ? "" : "s"} retained for retry.`}\n`
          );
          return failures === 0 ? 0 : 1;
        }

        const result = yield* startDetachedDaemon(config, { daemonScriptPath: daemonScriptPath() });
        yield* write(
          result.reused
            ? `Planview daemon is already running at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
            : `Planview daemon started at http://${result.descriptor.host}:${result.descriptor.port}/.\n`
        );
        return 0;
      })
    ),
    Effect.mapError((cause) =>
      cause instanceof DaemonCommandError
        ? cause
        : new DaemonCommandError({
            command,
            cause,
            message: `Could not ${command} the Planview daemon: ${describe(cause)}`,
          })
    )
  );

const parseDocumentReference = (reference: string, port: number) => {
  if (isValidDocumentId(reference)) {
    return reference;
  }

  const expectedPort = String(port);
  const urlPrefixes = [`http://localhost:${expectedPort}/`, `http://127.0.0.1:${expectedPort}/`];
  const prefix = urlPrefixes.find((candidate) => reference.startsWith(candidate));
  if (prefix === undefined || reference.length <= prefix.length) {
    throw new Error(
      "Document reference must be a valid 21-character id or an exact local Planview URL."
    );
  }

  const candidate = reference.slice(prefix.length);
  if (!isValidDocumentId(candidate)) {
    throw new Error(
      "Document reference must be a valid 21-character id or an exact local Planview URL."
    );
  }

  return candidate;
};

export const parseGetReference = (reference: string, port = V1_PORT) =>
  String(parseDocumentReference(reference, port));

const command = (
  args: readonly string[],
  stdout: StdoutWriter
): Effect.Effect<number, CliError> => {
  const [argument, ...trailing] = args;

  if (argument === undefined) {
    const output = formatHelp();
    return Effect.tryPromise({
      try: async () => {
        await stdout(output);
        return 0;
      },
      catch: (cause) =>
        new OutputCommandError({
          cause,
          message: `Could not write command output: ${describe(cause)}`,
        }),
    });
  }

  if (isOption(argument)) {
    if (trailing.length > 0) {
      const label = trailing.length === 1 ? "Unexpected argument" : "Unexpected arguments";
      return Effect.fail(
        new UnexpectedArgumentsError({
          arguments: trailing,
          message: `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`,
        })
      );
    }

    const output = argument === "--version" || argument === "-v" ? formatVersion() : formatHelp();
    return Effect.tryPromise({
      try: async () => {
        await stdout(output);
        return 0;
      },
      catch: (cause) =>
        new OutputCommandError({
          cause,
          message: `Could not write command output: ${describe(cause)}`,
        }),
    });
  }

  if (!isCommand(argument)) {
    if (argument.startsWith("-")) {
      return Effect.fail(
        new UnknownOptionError({
          option: argument,
          message: `Unknown option: ${argument}\n\n${formatHelp()}`,
        })
      );
    }
    return Effect.fail(
      new UnknownCommandError({
        command: argument,
        message: `Unknown command: ${argument}\n\n${formatHelp()}`,
      })
    );
  }

  if (argument === "skills") {
    const [subcommand, ...options] = trailing;
    if (subcommand !== "install") {
      return Effect.fail(
        new UnexpectedArgumentsError({
          arguments: trailing,
          message: `Usage: planview skills install [--force]\n`,
        })
      );
    }
    const unknownOption = options.find((option) => option !== "--force");
    if (unknownOption !== undefined) {
      return Effect.fail(
        new UnknownOptionError({
          option: unknownOption,
          message: `Unknown option: ${unknownOption}\n\n${formatHelp()}`,
        })
      );
    }
    return runSkillsInstallCommand(options.includes("--force"), stdout);
  }

  if (argument === "publish" || argument === "preview" || argument === "get") {
    if (trailing.length !== 1 || trailing[0] === undefined) {
      const label =
        trailing.length === 0
          ? argument === "publish"
            ? "Missing source file or folder"
            : "Missing document id or URL"
          : "Unexpected arguments";
      return Effect.fail(
        new UnexpectedArgumentsError({
          arguments: trailing,
          message: `${label}: ${trailing.join(" ")}\n\n${formatHelp()}`,
        })
      );
    }
    if (argument === "publish") {
      return runPublishCommand(trailing[0], stdout);
    }
    if (argument === "preview") {
      return runPreviewCommand(trailing[0], stdout);
    }
    return runGetCommand(trailing[0], stdout);
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

  return runDaemonCommand(argument, stdout);
};

export const run = (args: readonly string[], stdout = writeStdout, stderr = writeStderr) =>
  command(args, stdout).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => stderr(error.message.endsWith("\n") ? error.message : `${error.message}\n`))
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
