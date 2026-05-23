export interface IdentityHandlerOptions {
  provisionSecret?: string;
  onReceive: (identity: string) => void;
}

export function createIdentityHandler(options: IdentityHandlerOptions) {
  return (req: {
    headers: Record<string, string | undefined>;
    body: { identity: string };
  }): { ok: true } => {
    if (options.provisionSecret) {
      const provided = req.headers["x-provision-secret"];
      if (provided !== options.provisionSecret) {
        throw new Error("Invalid or missing provision secret");
      }
    }

    const { identity } = req.body;
    if (!identity) {
      throw new Error("Missing identity in request body");
    }

    options.onReceive(identity);
    return { ok: true };
  };
}
