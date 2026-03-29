import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { parseResponseLine, WIRE_VERSION, type WireAuth, type WireResponse } from "@shoggoth/authn";

export type InvokeControlRequestInput = {
  readonly socketPath: string;
  readonly auth: WireAuth;
  readonly op: string;
  /** Defaults to a random UUID. */
  readonly id?: string;
  readonly payload?: unknown;
};

/**
 * Single JSONL round-trip to the Shoggoth control Unix socket (one request line, one response line).
 */
export async function invokeControlRequest(input: InvokeControlRequestInput): Promise<WireResponse> {
  const id = input.id ?? randomUUID();
  const line = `${JSON.stringify({
    v: WIRE_VERSION,
    id,
    op: input.op,
    auth: input.auth,
    payload: input.payload,
  })}\n`;

  return await new Promise<WireResponse>((resolve, reject) => {
    const c = createConnection(input.socketPath);
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        try {
          resolve(parseResponseLine(buf.slice(0, i)));
        } catch (e) {
          reject(e);
        }
        c.end();
      }
    });
    c.on("error", reject);
    c.on("connect", () => {
      c.write(line);
    });
  });
}
