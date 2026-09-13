import { Data, Effect } from "effect";
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
  type DaemonConfig,
  type DaemonError,
} from "@planview/daemon";
import type { DocumentId } from "@planview/core";
import type { DocumentCleanupResult } from "@planview/storage";
import { preparePublishSource } from "./publish-source.js";
import { parseDocumentReference } from "./reference.js";

export type LocalOperation = "publish" | "get" | "start" | "stop" | "restart" | "inspect" | "clean";

export class LocalApplicationError extends Data.TaggedError("LocalApplicationError")<{
  readonly operation: LocalOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type LocalApplicationFailure = LocalApplicationError | DaemonError;

export type LocalApplicationOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly config?: DaemonConfig;
}>;

export type LocalPublishedDocument = Readonly<{
  readonly id: DocumentId;
  readonly url: string;
}>;

export type LocalDaemonRunningStatus = Readonly<{
  readonly state: "running";
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}>;

export type LocalDaemonStatus = Readonly<{ readonly state: "stopped" }> | LocalDaemonRunningStatus;

export type LocalDaemonStartResult = Readonly<{
  readonly status: LocalDaemonRunningStatus;
  readonly reused: boolean;
}>;

export type LocalGetOptions = Readonly<{
  readonly reference: string;
  readonly onChunk: (chunk: Uint8Array) => void | Promise<void>;
}>;

export type LocalApplication = Readonly<{
  readonly publish: (
    sourcePath: string
  ) => Effect.Effect<LocalPublishedDocument, LocalApplicationFailure>;
  readonly get: (options: LocalGetOptions) => Effect.Effect<void, LocalApplicationFailure>;
  readonly start: () => Effect.Effect<LocalDaemonStartResult, LocalApplicationFailure>;
  readonly stop: () => Effect.Effect<void, LocalApplicationFailure>;
  readonly restart: () => Effect.Effect<LocalDaemonRunningStatus, LocalApplicationFailure>;
  readonly inspect: () => Effect.Effect<LocalDaemonStatus, LocalApplicationFailure>;
  readonly clean: () => Effect.Effect<DocumentCleanupResult, LocalApplicationFailure>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const localFailure = (operation: LocalOperation, cause: unknown) =>
  new LocalApplicationError({
    operation,
    cause,
    message: `Local ${operation} failed: ${describe(cause)}`,
  });

const statusFromDescriptor = (descriptor: {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}): LocalDaemonRunningStatus => ({
  state: "running",
  pid: descriptor.pid,
  host: descriptor.host,
  port: descriptor.port,
  startedAt: descriptor.startedAt,
});

const withConfig = Effect.fnUntraced(function* <A, E>(
  operation: LocalOperation,
  resolveConfig: () => DaemonConfig,
  run: (config: DaemonConfig) => Effect.Effect<A, E>
): Effect.fn.Return<A, E | LocalApplicationError> {
  const config = yield* Effect.try({
    try: resolveConfig,
    catch: (cause) => localFailure(operation, cause),
  });
  return yield* run(config);
});

export const createLocalApplication = (options: LocalApplicationOptions): LocalApplication => {
  const resolveConfig = () => {
    if (options.config !== undefined) {
      return options.config;
    }
    const { NODE_ENV, PLANVIEW_TEST_DAEMON_PORT: configuredTestPort } = process.env;
    return NODE_ENV === "test" && configuredTestPort !== undefined
      ? resolveDaemonConfigForTest({ port: Number(configuredTestPort) })
      : resolveDaemonConfig();
  };
  const daemonOptions = { daemonScriptPath: options.daemonScriptPath };

  const publish = Effect.fn("LocalApplication.publish")(function* (sourcePath: string) {
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => preparePublishSource(sourcePath),
        catch: (cause) => localFailure("publish", cause),
      }),
      (prepared) =>
        withConfig("publish", resolveConfig, (config) =>
          publishDocument(config, {
            ...daemonOptions,
            sourcePath: prepared.sourcePath,
            sourceSizeBytes: prepared.sourceSizeBytes,
          }).pipe(
            Effect.map((published) => ({
              id: published.id,
              url: `http://localhost:${published.descriptor.port}/${published.id}`,
            }))
          )
        ),
      (prepared) =>
        Effect.tryPromise({
          try: () => prepared.cleanup(),
          catch: (cause) => localFailure("publish", cause),
        })
    );
  });

  const get = Effect.fn("LocalApplication.get")(function* ({
    reference,
    onChunk,
  }: LocalGetOptions) {
    const config = yield* Effect.try({
      try: resolveConfig,
      catch: (cause) => localFailure("get", cause),
    });
    const documentId = yield* Effect.try({
      try: () => parseDocumentReference(reference, config.port),
      catch: (cause) => localFailure("get", cause),
    });
    yield* retrieveDocument(config, {
      ...daemonOptions,
      documentId,
      onChunk,
    });
  });

  const start = Effect.fn("LocalApplication.start")(function* () {
    return yield* withConfig("start", resolveConfig, (config) =>
      startDetachedDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor, reused }) => ({
          status: statusFromDescriptor(descriptor),
          reused,
        }))
      )
    );
  });

  const stop = Effect.fn("LocalApplication.stop")(function* () {
    return yield* withConfig("stop", resolveConfig, (config) =>
      stopDaemon(config).pipe(Effect.asVoid)
    );
  });

  const restart = Effect.fn("LocalApplication.restart")(function* () {
    return yield* withConfig("restart", resolveConfig, (config) =>
      restartDaemon(config, daemonOptions).pipe(
        Effect.map(({ descriptor }) => statusFromDescriptor(descriptor))
      )
    );
  });

  const inspect = Effect.fn("LocalApplication.inspect")(function* () {
    return yield* withConfig("inspect", resolveConfig, (config) =>
      inspectDaemon(config).pipe(
        Effect.map((status) =>
          status.state === "running" ? statusFromDescriptor(status.status) : status
        )
      )
    );
  });

  const clean = Effect.fn("LocalApplication.clean")(function* () {
    return yield* withConfig("clean", resolveConfig, (config) =>
      cleanDaemon(config, daemonOptions).pipe(Effect.map(({ result }) => result))
    );
  });

  return { publish, get, start, stop, restart, inspect, clean };
};

export { parseDocumentReference, preparePublishSource };
