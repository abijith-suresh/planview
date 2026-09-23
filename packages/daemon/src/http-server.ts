import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export type DaemonHttpRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
  isAccepting: () => boolean
) => Promise<void>;

export type DaemonHttpErrorHandler = (response: ServerResponse, cause: unknown) => void;

export type DaemonHttpServer = Readonly<{
  readonly server: Server;
  readonly listen: (
    host: string,
    preferredPort: number,
    strictPort: boolean,
    fallbackAttempts: number
  ) => Promise<number>;
  readonly stopAccepting: () => void;
  readonly forceClose: () => void;
  readonly abortRequests: () => void;
  readonly waitForRequests: () => Promise<void>;
  readonly close: () => Promise<void>;
}>;

const isAddressInUse = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE";

const listen = (
  server: Server,
  host: string,
  preferredPort: number,
  strictPort: boolean,
  fallbackAttempts: number
) =>
  new Promise<number>((resolvePromise, rejectPromise) => {
    let fallbackAttempt = 0;
    let candidatePort = preferredPort;

    const tryCandidate = () => {
      const onError = (cause: Error) => {
        server.off("listening", onListening);
        server.off("error", onError);
        if (
          isAddressInUse(cause) &&
          !strictPort &&
          fallbackAttempt < fallbackAttempts &&
          candidatePort < 65_535
        ) {
          fallbackAttempt += 1;
          candidatePort += 1;
          tryCandidate();
          return;
        }
        rejectPromise(cause);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectPromise(new Error("The daemon listener did not report a TCP address."));
          return;
        }
        resolvePromise(address.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidatePort, host);
    };

    tryCandidate();
  });

const forceCloseServer = (server: Server, connections: ReadonlySet<Socket>) => {
  server.closeIdleConnections();
  server.closeAllConnections();
  for (const connection of connections) {
    connection.destroy();
  }
};

const closeServer = (server: Server, connections: ReadonlySet<Socket>) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (cause?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cause === undefined) {
        resolvePromise();
      } else {
        rejectPromise(cause);
      }
    };

    if (!server.listening) {
      forceCloseServer(server, connections);
      finish();
      return;
    }
    // close() may wait on unref'd keep-alive sockets. Close idle sockets
    // first while active requests retain their graceful path.
    server.closeIdleConnections();
    server.close((cause) => {
      if (cause === undefined || ("code" in cause && cause.code === "ERR_SERVER_NOT_RUNNING")) {
        finish();
      } else {
        finish(cause);
      }
    });
  });

export const createDaemonHttpServer = (
  handleRequest: DaemonHttpRequestHandler,
  handleError: DaemonHttpErrorHandler
): DaemonHttpServer => {
  const connections = new Set<Socket>();
  const requests = new Set<{
    readonly controller: AbortController;
    readonly request: IncomingMessage;
  }>();
  const requestIdleWaiters = new Set<() => void>();
  let accepting = true;

  const notifyRequestsIdle = () => {
    if (requests.size !== 0) {
      return;
    }
    for (const resolvePromise of requestIdleWaiters) {
      resolvePromise();
    }
    requestIdleWaiters.clear();
  };
  const stopAccepting = () => {
    if (!accepting) {
      return;
    }
    accepting = false;
    // Do this as the first shutdown action so idle keep-alive sockets do not
    // hold server.close() open until the process fallback runs.
    server.closeIdleConnections();
  };
  const abortRequests = () => {
    for (const { controller } of requests) {
      controller.abort(new Error("The daemon shutdown deadline elapsed."));
    }
  };
  const waitForRequests = () =>
    requests.size === 0
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => requestIdleWaiters.add(resolvePromise));

  const server = createServer((request, response) => {
    const controller = new AbortController();
    const activeRequest = { controller, request };
    requests.add(activeRequest);
    const abortIfIncomplete = (cause: Error) => {
      if (!response.writableFinished) {
        controller.abort(cause);
      }
    };
    const onRequestAborted = () => abortIfIncomplete(new Error("The client disconnected."));
    const onResponseClosed = () => {
      // IncomingMessage#aborted does not fire if the peer stops consuming a
      // response after its request body has already been read.
      abortIfIncomplete(new Error("The client closed the response."));
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClosed);
    void handleRequest(request, response, controller.signal, () => accepting)
      .catch((cause) => handleError(response, cause))
      .finally(() => {
        request.off("aborted", onRequestAborted);
        response.off("close", onResponseClosed);
        requests.delete(activeRequest);
        notifyRequestsIdle();
      });
  });

  server.on("connection", (connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
  });

  return {
    server,
    listen: (host, preferredPort, strictPort, fallbackAttempts) =>
      listen(server, host, preferredPort, strictPort, fallbackAttempts),
    stopAccepting,
    forceClose: () => forceCloseServer(server, connections),
    abortRequests,
    waitForRequests,
    close: () => closeServer(server, connections),
  };
};
