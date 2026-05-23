import type { ServiceTokenPayload } from "./validator.js";
import { TokenValidator } from "./validator.js";

export interface AuthMiddlewareOptions {
  getIdentity: () => string | null | undefined;
}

export interface AuthenticatedRequest {
  serviceAuth?: ServiceTokenPayload;
}

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  return async (
    req: { headers: Record<string, string | string[] | undefined> } & AuthenticatedRequest,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    const authHeader = req.headers["authorization"] ?? req.headers["Authorization"];
    const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

    if (!headerValue || !headerValue.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid Authorization header" });
      return;
    }

    const token = headerValue.slice(7);
    const identity = options.getIdentity();

    if (!identity) {
      res.status(401).json({ error: "Service identity not available" });
      return;
    }

    const payload = await TokenValidator.validate(token, identity);

    if (!payload) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    req.serviceAuth = payload;
    next();
  };
}
