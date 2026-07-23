import { test, expect, afterEach } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { RCONClient } from "./client";

const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;
const SERVERDATA_RESPONSE_VALUE = 0;

function packet(id: number, type: number, payload: string): Buffer {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const length = payloadBuffer.length + 10;
  const buf = Buffer.alloc(length + 4);
  buf.writeInt32LE(length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payloadBuffer.copy(buf, 12);
  buf.writeInt8(0, buf.length - 2);
  buf.writeInt8(0, buf.length - 1);
  return buf;
}

function readPacketHeader(buf: Buffer): { length: number; id: number; type: number; payload: string } {
  const length = buf.readInt32LE(0);
  const id = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const payload = buf.toString("utf8", 12, 4 + length - 2);
  return { length, id, type, payload };
}

/** Minimal in-process fake RCON server: authenticates anything, then answers
 * commands according to a per-connection handler the test supplies. */
function startFakeServer(
  onCommand: (socket: Socket, id: number, payload: string) => void
): Promise<{ server: Server; port: number; connectionCount: () => number }> {
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount++;
    let buf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const length = buf.readInt32LE(0);
        const total = length + 4;
        if (buf.length < total) break;
        const raw = buf.subarray(0, total);
        buf = buf.subarray(total);
        const { id, type, payload } = readPacketHeader(raw);
        if (type === SERVERDATA_AUTH) {
          socket.write(packet(id, SERVERDATA_AUTH_RESPONSE, ""));
        } else {
          onCommand(socket, id, payload);
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port, connectionCount: () => connectionCount });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let activeClient: RCONClient | null = null;
let activeServer: Server | null = null;

afterEach(async () => {
  if (activeClient) {
    await activeClient.disconnect();
    activeClient = null;
  }
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = null;
  }
});

test("response split across two socket writes is reassembled", async () => {
  const { server, port } = await startFakeServer((socket, id) => {
    const full = packet(id, SERVERDATA_RESPONSE_VALUE, "hello world");
    // Split mid-payload: header (12 bytes) + a bit, then the rest.
    const splitAt = 15;
    socket.write(full.subarray(0, splitAt));
    setTimeout(() => socket.write(full.subarray(splitAt)), 10);
  });
  activeServer = server;

  const client = new RCONClient({ host: "127.0.0.1", port, password: "x" });
  activeClient = client;
  await client.connect();

  const response = await client.sendCommand("/fac_help");
  expect(response.success).toBe(true);
  expect(response.data).toBe("hello world");
});

test("two coalesced responses in one write resolve two concurrent commands", async () => {
  const pendingIds: number[] = [];
  const { server, port } = await startFakeServer((socket, id) => {
    pendingIds.push(id);
    if (pendingIds.length === 2) {
      const combined = Buffer.concat([
        packet(pendingIds[0]!, SERVERDATA_RESPONSE_VALUE, "first"),
        packet(pendingIds[1]!, SERVERDATA_RESPONSE_VALUE, "second"),
      ]);
      socket.write(combined);
    }
  });
  activeServer = server;

  const client = new RCONClient({ host: "127.0.0.1", port, password: "x" });
  activeClient = client;
  await client.connect();

  const [r1, r2] = await Promise.all([
    client.sendCommand("/fac_cmd_one"),
    client.sendCommand("/fac_cmd_two"),
  ]);

  expect(r1.success).toBe(true);
  expect(r1.data).toBe("first");
  expect(r2.success).toBe(true);
  expect(r2.data).toBe("second");
});

test("an oversized length field tears the socket down; the next command reconnects", async () => {
  let commandCount = 0;
  const { server, port, connectionCount } = await startFakeServer((socket, id) => {
    commandCount++;
    if (commandCount === 1) {
      // A bogus, oversized length field - the client must treat this as a
      // framing desync rather than waiting forever for 2MB of payload.
      const bogus = Buffer.alloc(12);
      bogus.writeInt32LE(2_000_000, 0);
      bogus.writeInt32LE(id, 4);
      bogus.writeInt32LE(SERVERDATA_RESPONSE_VALUE, 8);
      socket.write(bogus);
    } else {
      socket.write(packet(id, SERVERDATA_RESPONSE_VALUE, "recovered"));
    }
  });
  activeServer = server;

  const client = new RCONClient({ host: "127.0.0.1", port, password: "x" });
  activeClient = client;
  await client.connect();

  const first = await client.sendCommand("/fac_bad", 500);
  expect(first.success).toBe(false);

  const second = await client.sendCommand("/fac_good", 2000);
  expect(second.success).toBe(true);
  expect(second.data).toBe("recovered");

  // The fake server must have seen a second TCP connection (re-auth) - the
  // desynced socket must not have been silently reused.
  expect(connectionCount()).toBe(2);
});

test("two consecutive command timeouts force a reconnect on the next command", async () => {
  let respondToCommands = false;
  const { server, port, connectionCount } = await startFakeServer((socket, id, payload) => {
    if (respondToCommands) {
      socket.write(packet(id, SERVERDATA_RESPONSE_VALUE, "alive"));
    }
    // else: silently swallow the command (simulates a hung server).
  });
  activeServer = server;

  const client = new RCONClient({ host: "127.0.0.1", port, password: "x" });
  activeClient = client;
  await client.connect();
  expect(connectionCount()).toBe(1);

  const t1 = await client.sendCommand("/fac_silent_one", 100);
  expect(t1.success).toBe(false);
  const t2 = await client.sendCommand("/fac_silent_two", 100);
  expect(t2.success).toBe(false);

  respondToCommands = true;
  const third = await client.sendCommand("/fac_after_reconnect", 2000);
  expect(third.success).toBe(true);
  expect(third.data).toBe("alive");

  expect(connectionCount()).toBe(2);
});
