export interface IdentityHandlerOptions {
  provisionSecret?: string;
  /**
   * Allow re-provisioning after an identity has already been received.
   * Defaults to false: a second accepted provisioning attempt is rejected
   * instead of silently overwriting the stored identity. Rotation requests
   * that authenticate with a Bearer token should bypass this handler.
   */
  allowReprovision?: boolean;
  onReceive: (identity: string) => void;
}

export function createIdentityHandler(options: IdentityHandlerOptions) {
  let provisioned = false;

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
    if (typeof identity !== "string" || identity.length === 0) {
      throw new Error("Missing identity in request body: expected a non-empty string");
    }

    if (provisioned && !options.allowReprovision) {
      throw new Error("Identity already provisioned");
    }

    provisioned = true;
    try {
      options.onReceive(identity);
    } catch (err) {
      // A failed delivery must not consume the attempt; rethrow so the
      // HTTP wrapper reports it like any other provisioning failure.
      provisioned = false;
      throw err;
    }
    return { ok: true };
  };
}
