# @shoggoth/service-auth

Standalone authentication package for Shoggoth service authors. Provides token validation, Express-style auth middleware, and an identity provisioning handler.

## Installation

This package is internal to the Shoggoth monorepo:

```json
{
  "dependencies": {
    "@shoggoth/service-auth": "workspace:*"
  }
}
```

## Usage

### Token Validation

Validate an age-encrypted service token directly:

```ts
import { TokenValidator } from "@shoggoth/service-auth";

const payload = await TokenValidator.validate(token, ageIdentityString);
if (payload) {
  console.log(`Authenticated as ${payload.sub}, scope: ${payload.scope}`);
} else {
  console.log("Invalid or expired token");
}
```

### Auth Middleware

Create Express-style middleware that validates Bearer tokens and attaches the payload to the request:

```ts
import { createAuthMiddleware } from "@shoggoth/service-auth";

let identity: string | null = null;

const authMiddleware = createAuthMiddleware({
  getIdentity: () => identity,
});

app.use("/api", authMiddleware);

app.get("/api/data", (req, res) => {
  // req.serviceAuth contains the validated ServiceTokenPayload
  const { sub, scope, session } = req.serviceAuth;
  res.json({ agent: sub });
});
```

### Identity Handler

Create an HTTP handler for receiving the service identity from the daemon during provisioning:

```ts
import { createIdentityHandler } from "@shoggoth/service-auth";

let identity: string | null = null;

const handler = createIdentityHandler({
  provisionSecret: process.env.PROVISION_SECRET,
  onReceive: (id) => {
    identity = id;
    console.log("Identity received, service is ready");
  },
});

// Mount at POST /_shoggoth/identity
app.post("/_shoggoth/identity", (req, res) => {
  try {
    const result = handler(req);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
```

## API

### `TokenValidator.validate(token: string, identityString: string): Promise<ServiceTokenPayload | null>`

Decodes a base64url token, decrypts it with the provided age identity, parses the JSON payload, and checks expiry. Returns the payload on success or `null` on failure.

### `createAuthMiddleware(options: AuthMiddlewareOptions)`

Returns an Express-style `(req, res, next)` middleware. Extracts the Bearer token from the Authorization header, validates it, and attaches the payload to `req.serviceAuth`. Returns 401 on failure.

### `createIdentityHandler(options: IdentityHandlerOptions)`

Returns a handler function that validates the provision secret (if configured) and calls `onReceive` with the identity string from the request body.

## Types

```ts
interface ServiceTokenPayload {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  session?: string;
}

interface AuthMiddlewareOptions {
  getIdentity: () => string | null | undefined;
}

interface IdentityHandlerOptions {
  provisionSecret?: string;
  onReceive: (identity: string) => void;
}
```
