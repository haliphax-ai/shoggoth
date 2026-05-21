# Specification

## Interfaces

### ServiceKeyStore

```ts
/**
 * Manages age X25519 key pairs for managed/external services.
 * Stores recipients (public keys) in the state DB, encrypted at rest.
 */
export class ServiceKeyStore {
  constructor(db: Database.Database);

  /**
   * Generate a new age X25519 identity for a service.
   * Stores the recipient (public key) in the DB.
   * @returns The identity (private key) string — delivered to the service via provisioning endpoint.
   */
  async generateIdentity(serviceId: string): Promise<{ identity: string; recipient: string }>;

  /**
   * Get the stored recipient (public key) for a service.
   * @returns The recipient string, or null if no key exists.
   */
  getRecipient(serviceId: string): string | null;

  /**
   * Get the key fingerprint (first 16 chars of recipient) for display.
   */
  getFingerprint(serviceId: string): string | null;

  /**
   * Rotate the key pair for a service. Generates a new identity,
   * replaces the stored recipient.
   * @returns The new identity (private key) string.
   */
  async rotateIdentity(serviceId: string): Promise<{ identity: string; recipient: string }>;

  /**
   * Delete all key material for a service.
   */
  deleteIdentity(serviceId: string): void;

  /**
   * Check if a service has a stored key pair.
   */
  hasIdentity(serviceId: string): boolean;
}
```

### TokenMinter

```ts
export interface ServiceTokenPayload {
  /** Agent ID making the request. */
  sub: string;
  /** Service ID this token is scoped to. */
  scope: string;
  /** Issued-at timestamp (unix seconds). */
  iat: number;
  /** Expiration timestamp (unix seconds). */
  exp: number;
  /** Session URN (optional context). */
  session?: string;
}

/**
 * Mints age-encrypted tokens for authenticating tool dispatch requests.
 */
export class TokenMinter {
  constructor(keyStore: ServiceKeyStore);

  /**
   * Mint a short-lived encrypted token for a service.
   * @param agentId - The agent making the request.
   * @param serviceId - The target service (determines encryption recipient).
   * @param sessionUrn - Optional session context.
   * @returns base64url-encoded encrypted token.
   * @throws If the service has no stored recipient.
   */
  async mint(agentId: string, serviceId: string, sessionUrn?: string): Promise<string>;
}
```

### TokenValidator

```ts
/**
 * Validates age-encrypted tokens. Used by services to verify requests
 * came from the Shoggoth daemon.
 *
 * Shipped as part of `@shoggoth/service-auth` standalone package.
 */
export class TokenValidator {
  /**
   * Validate and decrypt a token.
   * @param token - base64url-encoded encrypted token.
   * @param identityString - The service's age identity (private key).
   * @returns Decoded payload if valid, null if expired/invalid/undecryptable.
   */
  static async validate(token: string, identityString: string): Promise<ServiceTokenPayload | null>;
}
```

### Scoped Control Plane Access

```ts
/**
 * Operations a service can request access to.
 */
type ServiceOp =
  | "session.send"
  | "session.query"
  | "kv.get"
  | "kv.set"
  | "kv.list"
  | "kv.delete"
  | "service.status";

/**
 * Service manifest ops declaration.
 */
interface ServiceManifestOps {
  /** Operations this service requests access to. */
  ops?: ServiceOp[];
}

/**
 * Authenticates service connections to the control plane.
 */
export class ServiceControlPlaneAuth {
  constructor(keyStore: ServiceKeyStore, approvalStore: ServiceApprovalStore);

  /**
   * Authenticate a service connection using a signed challenge.
   * @param serviceId - Claimed service identity.
   * @param token - Age-encrypted challenge response.
   * @returns True if the service proved possession of its identity.
   */
  async authenticate(serviceId: string, token: string): Promise<boolean>;

  /**
   * Check if a service is authorized for a given operation.
   * @param serviceId - The authenticated service.
   * @param op - The operation being attempted.
   * @returns True if the operation is within the service's approved scope.
   */
  isAuthorized(serviceId: string, op: ServiceOp): boolean;
}
```

### Updated ServiceApprovalRecord

```ts
interface ServiceApprovalRecord {
  serviceId: string;
  status: ApprovalStatus;
  approvedFingerprint: string | null;
  /** Key fingerprint for the active age identity. */
  keyFingerprint?: string | null;
  /** Approved operations scope. */
  approvedOps?: ServiceOp[];
  createdAt: string;
  updatedAt: string;
}
```

## Data Structures / Schemas

### service_keys table

```sql
CREATE TABLE service_keys (
  service_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,          -- age public key (bech32 age1...)
  fingerprint TEXT NOT NULL,        -- first 16 chars of recipient for display
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### service_approvals table (migration)

```sql
ALTER TABLE service_approvals ADD COLUMN key_fingerprint TEXT;
ALTER TABLE service_approvals ADD COLUMN approved_ops TEXT; -- JSON array
```

## Code Examples

### Minting a token during tool dispatch

```ts
// In ServiceToolDispatcher.dispatch()
const token = await this.tokenMinter.mint(ctx.agentId, serviceId, ctx.sessionUrn);
const headers: Record<string, string> = {
  Authorization: `Bearer ${token}`,
};
```

### Validating a token in a service

```ts
import { TokenValidator } from "@shoggoth/service-auth";

// Service middleware
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.slice(7);
  const payload = await TokenValidator.validate(token, myStoredIdentity);

  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.serviceAuth = payload; // { sub: "agent-id", scope: "my-service", ... }
  next();
}
```

### Identity provisioning endpoint (service-side)

```ts
import { createIdentityHandler } from "@shoggoth/service-auth";

// The handler stores the identity and returns 200 on success.
// Services decide their own storage strategy (memory, file, etc.)
app.post(
  "/_shoggoth/identity",
  createIdentityHandler({
    onReceive: async (identity: string) => {
      // Store the identity however the service prefers
      currentIdentity = identity;
    },
  }),
);
```

### CLI approval with key provisioning

```
$ shoggoth service approve my-service

Service: my-service
Tier: managed
Manifest fingerprint: a3f8c2...

Requested operations:
  - session.send
  - kv.get

Approve this service? [y/N] y

✓ Service approved.
✓ Age identity generated.
✓ Identity delivered to service via POST /_shoggoth/identity.
```

### CLI approval — fallback when service is unreachable

```
$ shoggoth service approve my-external-service

Service: my-external-service
Tier: external
Manifest fingerprint: b7e1a9...

Approve this service? [y/N] y

✓ Service approved.
✓ Age identity generated.
⚠ Could not deliver identity (service unreachable). Will retry on next health check.

  If manual delivery is needed, the identity is:

  AGE-SECRET-KEY-1QFZQHELX3...
```
