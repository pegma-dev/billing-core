import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

let child: ChildProcess | undefined;
let workspace: string | undefined;

export function allocateAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => {
          reject(new Error("Could not allocate an Azurite loopback port."));
        });
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(port);
        }
      });
    });
  });
}

function portAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(1_000, () => settle(false));
  });
}

export function waitForStartup(
  process: ChildProcess,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let portIsAccepting = false;
    let childAnnouncedStartup = false;
    let stdoutBuffer = "";
    const deadline = Date.now() + timeoutMs;
    const startupMessage = `Azurite Table service successfully started on 127.0.0.1:${port}`;

    const cleanupListeners = () => {
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
      }
      process.off("error", onError);
      process.off("exit", onExit);
      process.stdout?.off("data", onStdout);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      reject(error);
    };
    const onError = (error: Error) => {
      fail(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `Azurite exited before startup (code ${String(code)}, signal ${String(signal)}).`,
        ),
      );
    };
    const onStdout = (chunk: Buffer | string) => {
      stdoutBuffer = `${stdoutBuffer}${String(chunk)}`.slice(-2_048);
      if (stdoutBuffer.includes(startupMessage)) {
        childAnnouncedStartup = true;
        if (portIsAccepting) {
          succeed();
        }
      }
    };
    const poll = async () => {
      try {
        portIsAccepting = await portAccepting(port);
        if (portIsAccepting && childAnnouncedStartup) {
          succeed();
        } else if (Date.now() >= deadline) {
          fail(
            new Error(
              `Azurite did not start listening on port ${port} within ${timeoutMs}ms.`,
            ),
          );
        } else if (!settled) {
          pollTimer = setTimeout(() => void poll(), portIsAccepting ? 50 : 200);
        }
      } catch (error) {
        fail(error);
      }
    };

    process.once("error", onError);
    process.once("exit", onExit);
    process.stdout?.on("data", onStdout);
    if (process.stdout === null) {
      fail(new Error("Azurite startup requires captured child output."));
      return;
    }
    void poll();
  });
}

async function stopChild(process: ChildProcess): Promise<void> {
  if (
    process.pid === undefined ||
    process.exitCode !== null ||
    process.signalCode !== null
  ) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off("error", finish);
      process.off("exit", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 2_000);
    process.once("error", finish);
    process.once("exit", finish);
    if (!process.kill()) {
      finish();
    }
  });
}

async function cleanup(): Promise<void> {
  const process = child;
  const directory = workspace;
  child = undefined;
  workspace = undefined;

  if (process !== undefined) {
    await stopChild(process);
  }
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function setup(project: TestProject): Promise<void> {
  const entry = join(
    process.cwd(),
    "node_modules",
    "azurite",
    "dist",
    "src",
    "table",
    "main.js",
  );
  if (!existsSync(entry)) {
    throw new Error(
      `Could not find Azurite at ${entry}. Run pnpm install first.`,
    );
  }

  try {
    const tablePort = await allocateAvailablePort();
    workspace = await mkdtemp(join(tmpdir(), "pegma-billing-azurite-"));
    child = spawn(
      process.execPath,
      [
        entry,
        "--location",
        workspace,
        "--silent",
        "--tableHost",
        "127.0.0.1",
        "--tablePort",
        String(tablePort),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await waitForStartup(child, tablePort, 30_000);
    project.provide("azuriteTablePort", tablePort);
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Azurite startup and cleanup both failed.",
      );
    }
    throw error;
  }
}

export async function teardown(): Promise<void> {
  await cleanup();
}
