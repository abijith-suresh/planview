import assert from "node:assert/strict";
import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
import { createDaemonHttpServer } from "../dist/http-server.js";

const createServer = (handleRequest: Parameters<typeof createDaemonHttpServer>[0]) =>
  createDaemonHttpServer(handleRequest, (response) => {
    response.statusCode = 500;
    response.end();
  });

const request = (port: number, agent?: Agent) => {
  const clientRequest = httpRequest({ host: "127.0.0.1", port, path: "/", agent });
  clientRequest.on("error", () => undefined);
  clientRequest.end();
  return clientRequest;
};

test("HTTP transport tracks active requests and propagates a shutdown abort", {
  timeout: 5_000,
}, async () => {
  let resolveStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    resolveStarted = resolve;
  });
  const server = createServer((_request, response, signal) => {
    resolveStarted(signal);
    return new Promise<void>((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          response.end("aborted");
          resolve();
        },
        { once: true }
      );
    });
  });

  try {
    const port = await server.listen("127.0.0.1", 0, true, 0);
    const clientRequest = request(port);
    clientRequest.on("response", (response) => response.resume());
    const signal = await started;
    let requestsDrained = false;
    const drained = server.waitForRequests().then(() => {
      requestsDrained = true;
    });
    await Promise.resolve();
    assert.equal(requestsDrained, false);

    server.abortRequests();
    await drained;
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).message, "The daemon shutdown deadline elapsed.");
    await server.close();
  } finally {
    server.forceClose();
    await server.close().catch(() => undefined);
  }
});

test("HTTP transport aborts a request when the client disconnects", {
  timeout: 5_000,
}, async () => {
  let resolveStarted!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>((resolve) => {
    resolveStarted = resolve;
  });
  const server = createServer((_request, _response, signal) => {
    resolveStarted(signal);
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });

  try {
    const port = await server.listen("127.0.0.1", 0, true, 0);
    const clientRequest = request(port);
    const signal = await started;
    const aborted = new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
      } else {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }
    });

    clientRequest.destroy();
    await aborted;
    await server.waitForRequests();
    assert.equal(signal.aborted, true);
    assert.ok(
      ["The client disconnected.", "The client closed the response."].includes(
        (signal.reason as Error).message
      )
    );
    await server.close();
  } finally {
    server.forceClose();
    await server.close().catch(() => undefined);
  }
});

test("HTTP transport closes idle keep-alive connections while closing the listener", {
  timeout: 5_000,
}, async () => {
  const server = createServer((_request, response) => {
    response.end("ready");
    return Promise.resolve();
  });
  const agent = new Agent({ keepAlive: true });

  try {
    const port = await server.listen("127.0.0.1", 0, true, 0);
    const clientRequest = httpRequest({ host: "127.0.0.1", port, path: "/", agent });
    const socket = new Promise<Socket>((resolve) => {
      clientRequest.once("socket", resolve);
    });
    const responseEnded = new Promise<void>((resolve, reject) => {
      clientRequest.once("response", (response) => {
        response.resume();
        response.once("end", resolve);
        response.once("error", reject);
      });
      clientRequest.once("error", reject);
    });
    clientRequest.end();

    const idleSocket = await socket;
    await responseEnded;
    const connectionClosed = new Promise<void>((resolve) => {
      if (idleSocket.destroyed) {
        resolve();
      } else {
        idleSocket.once("close", () => resolve());
      }
    });
    await server.close();
    await connectionClosed;
    assert.equal(idleSocket.destroyed, true);
  } finally {
    agent.destroy();
    server.forceClose();
    await server.close().catch(() => undefined);
  }
});
