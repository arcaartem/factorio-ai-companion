import { Socket } from "net";
import type { RCONConfig, RCONResponse } from "./types";

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

interface PendingRequest {
  resolve: (response: RCONResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RCONClient {
  private socket: Socket | null = null;
  private connected = false;
  private config: RCONConfig;
  private requestId = 1;
  private commandTimeout = 5000; // 5 second default timeout per command, overridable per call

  // Incoming-byte accumulator for length-prefixed packet framing. RCON packets
  // can arrive split across TCP segments or coalesced together in one "data"
  // event, so we buffer and only extract a packet once we have its full length.
  private recvBuffer: Buffer = Buffer.alloc(0);

  // Requests in flight, keyed by RCON packet id, so responses are routed to
  // the caller that sent them regardless of arrival order (fixes cross-talk
  // between concurrent callers sharing one connection).
  private pending = new Map<number, PendingRequest>();

  // The request id currently awaiting an auth response, so we can recognize
  // the protocol's id=-1 "auth failed" reply and route it back correctly.
  private authPendingId: number | null = null;

  // Dedupe concurrent reconnect attempts (multiple sendCommand callers can
  // notice a dead socket at the same time) so they share one connect().
  private connectingPromise: Promise<void> | null = null;

  // Consecutive command-timeout counter, reset on any successful dispatch.
  // Two in a row means the socket is dead-but-"connected" (e.g. server
  // stopped responding without closing the TCP connection) - self-heal by
  // tearing it down so the next sendCommand() reconnects.
  private consecutiveTimeouts = 0;

  constructor(config: RCONConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    if (this.connectingPromise) {
      return this.connectingPromise;
    }
    const promise = this.connectWithRetry(3).finally(() => {
      if (this.connectingPromise === promise) {
        this.connectingPromise = null;
      }
    });
    this.connectingPromise = promise;
    return promise;
  }

  private async connectWithRetry(maxRetries: number): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.connectOnce();
        console.error(`✅ RCON connected on attempt ${attempt}`);
        return;
      } catch (error: any) {
        const errorMsg = error?.message || String(error);
        console.error(`❌ RCON connection attempt ${attempt} failed:`, errorMsg);

        if (attempt === maxRetries) {
          const isConnectionRefused = errorMsg.includes("ECONNREFUSED") || errorMsg.includes("connect");
          if (isConnectionRefused) {
            throw new Error(
              `❌ Cannot connect to Factorio RCON (${this.config.host}:${this.config.port})\n\n` +
              `SOLUTION: Start Factorio in Multiplayer mode\n` +
              `1. Launch Factorio\n` +
              `2. Go to: Multiplayer → Host New Game\n` +
              `3. RCON will be automatically enabled\n\n` +
              `RCON config should be in %APPDATA%\\Factorio\\config\\config.ini:\n` +
              `  local-rcon-socket=127.0.0.1:34198\n` +
              `  local-rcon-password=factorio\n\n` +
              `If missing, add those lines and restart Factorio.\n\n` +
              `Original error: ${errorMsg}`
            );
          }
          throw new Error(`Failed to connect after ${maxRetries} attempts: ${errorMsg}`);
        }

        // Exponential backoff: 1s, 2s, 4s
        await this.sleep(1000 * Math.pow(2, attempt - 1));
      }
    }
  }

  private async connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Tear down whatever socket we had before (if any) without letting its
      // close/error events reject requests made against the new connection.
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.destroy();
      }

      const socket = new Socket();
      this.socket = socket;
      this.recvBuffer = Buffer.alloc(0);
      let settled = false;

      // Detect genuinely-dead TCP peers (server crash, network drop) even
      // while idle, instead of relying on application-level activity.
      socket.setKeepAlive(true, 10000);

      // Guard only the connect+auth handshake. Once authenticated we disable
      // this timer entirely — per-command timeouts (via `pending`) are what
      // bound normal operation, and an idle *connection* is not an error.
      socket.setTimeout(this.commandTimeout);

      socket.on("connect", () => {
        this.authenticate()
          .then(() => {
            settled = true;
            socket.setTimeout(0);
            this.connected = true;
            resolve();
          })
          .catch((err) => {
            settled = true;
            socket.setTimeout(0);
            socket.destroy();
            reject(err);
          });
      });

      socket.on("data", (chunk: Buffer) => this.onSocketData(chunk));

      socket.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.handleSocketDown(err.message);
      });

      socket.on("close", () => {
        this.handleSocketDown("socket closed");
      });

      socket.on("timeout", () => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("Socket connect/auth timeout"));
        }
        // If already connected, this timer has been disabled (setTimeout(0));
        // a stray event here is not treated as a failure.
      });

      socket.connect(this.config.port, this.config.host);
    });
  }

  private async authenticate(): Promise<void> {
    if (!this.socket) throw new Error("Socket not initialized");
    const socket = this.socket;
    const id = this.nextRequestId();
    const packet = this.createPacket(SERVERDATA_AUTH, this.config.password, id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.authPendingId = null;
        reject(new Error("Authentication timeout"));
      }, this.commandTimeout);

      this.authPendingId = id;
      this.pending.set(id, {
        timer,
        resolve: (response) => {
          this.authPendingId = null;
          if (response.success) {
            resolve();
          } else {
            reject(new Error(response.error || "Authentication failed - invalid password"));
          }
        },
      });

      socket.write(packet);
    });
  }

  async sendCommand(command: string, timeoutMs?: number): Promise<RCONResponse> {
    if (!this.isSocketUsable()) {
      try {
        await this.connect();
      } catch (error: any) {
        return {
          success: false,
          data: "",
          error: `Connection lost and reconnect failed: ${error?.message || String(error)}`,
        };
      }
    }

    const socket = this.socket;
    if (!socket) {
      return { success: false, data: "", error: "Socket not initialized" };
    }

    const id = this.nextRequestId();
    const packet = this.createPacket(SERVERDATA_EXECCOMMAND, command, id);
    const timeout = timeoutMs ?? this.commandTimeout;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts++;
        if (this.consecutiveTimeouts >= 2) {
          console.error("RCON: 2 consecutive command timeouts, tearing down socket");
          this.socket?.destroy();
          this.handleSocketDown("repeated command timeouts");
        }
        resolve({
          success: false,
          data: "",
          error: `Command timeout after ${timeout}ms`,
        });
      }, timeout);

      this.pending.set(id, { timer, resolve });

      socket.write(packet, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          resolve({ success: false, data: "", error: `Write failed: ${err.message}` });
        }
      });
    });
  }

  /** True only if we believe there is a live, usable socket to write to. */
  private isSocketUsable(): boolean {
    return this.connected && !!this.socket && !this.socket.destroyed;
  }

  /** Marks the connection dead and fails every in-flight request with a clear error. */
  private handleSocketDown(reason: string): void {
    if (!this.connected && this.pending.size === 0) return; // already handled
    this.connected = false;
    const error = `Connection lost: ${reason}`;
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.resolve({ success: false, data: "", error });
    }
    this.pending.clear();
    this.authPendingId = null;
    this.recvBuffer = Buffer.alloc(0);
  }

  /** Accumulates bytes and dispatches complete, length-prefixed RCON packets. */
  private onSocketData(chunk: Buffer): void {
    this.recvBuffer = this.recvBuffer.length ? Buffer.concat([this.recvBuffer, chunk]) : chunk;

    while (this.recvBuffer.length >= 4) {
      const length = this.recvBuffer.readInt32LE(0);
      if (length < 10 || length > 1_048_576) {
        // Out-of-range length field means we've lost the packet boundary -
        // dropping just this buffer and continuing desyncs every future read
        // (the next bytes we treat as a length prefix are actually mid-payload).
        // Treat it as fatal: tear down the socket and let handleSocketDown fail
        // in-flight requests; sendCommand()'s isSocketUsable() check then
        // reconnects cleanly on the next call.
        console.error(`RCON: framing desync (length=${length}), destroying socket`);
        this.socket?.destroy();
        this.handleSocketDown(`framing desync (length=${length})`);
        return;
      }

      const totalSize = length + 4;
      if (this.recvBuffer.length < totalSize) break; // wait for the rest to arrive

      const packet = this.recvBuffer.subarray(0, totalSize);
      this.recvBuffer = this.recvBuffer.subarray(totalSize);

      this.dispatchPacket(packet);
    }
  }

  private dispatchPacket(buffer: Buffer): void {
    const { id, payload } = this.parsePacket(buffer);

    // Failed auth: server echoes id=-1 rather than the id we sent.
    if (id === -1 && this.authPendingId !== null) {
      const pending = this.pending.get(this.authPendingId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(this.authPendingId);
        pending.resolve({ success: false, data: "", error: "Authentication failed - invalid password" });
      }
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      // No caller is waiting for this id anymore (already timed out, or an
      // unexpected/late packet) - drop it rather than crash.
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);
    this.consecutiveTimeouts = 0;
    pending.resolve({ success: true, data: payload });
  }

  private nextRequestId(): number {
    const id = this.requestId++;
    if (this.requestId >= 0x7fffffff) {
      this.requestId = 1;
    }
    return id;
  }

  private createPacket(type: number, payload: string, id: number): Buffer {
    const payloadBuffer = Buffer.from(payload, "utf8");
    const length = payloadBuffer.length + 10;

    const packet = Buffer.alloc(length + 4);
    packet.writeInt32LE(length, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    payloadBuffer.copy(packet, 12);
    packet.writeInt8(0, packet.length - 2);
    packet.writeInt8(0, packet.length - 1);

    return packet;
  }

  private parsePacket(buffer: Buffer): { id: number; type: number; payload: string } {
    const id = buffer.readInt32LE(4);
    const type = buffer.readInt32LE(8);
    const payload = buffer.toString("utf8", 12, buffer.length - 2);

    return { id, type, payload };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.handleSocketDown("disconnect() called");
  }
}
