import { afterEach, describe, expect, it, vi } from "vitest";
import * as age from "age-encryption";
import { createAuthMiddleware } from "../src/middleware.js";
import { TokenValidator, type ServiceTokenPayload } from "../src/validator.js";

type MiddlewareRequest = Parameters<ReturnType<typeof createAuthMiddleware>>[0];
type MiddlewareResponse = Parameters<ReturnType<typeof createAuthMiddleware>>[1];

interface RecordedResponse {
  status?: number;
  body?: unknown;
}

async function mintToken(payload: ServiceTokenPayload, recipient: string): Promise<string> {
  const plaintext = JSON.stringify(payload);
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(plaintext);
  return Buffer.from(ciphertext).toString("base64url");
}

/** Mint a token that the returned identity will successfully validate. */
async function mintValidToken(): Promise<{
  identity: string;
  token: string;
  payload: ServiceTokenPayload;
}> {
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const now = Math.floor(Date.now() / 1000);
  const payload: ServiceTokenPayload = {
    sub: "agent-1",
    scope: "service",
    iat: now,
    exp: now + 300,
  };
  const token = await mintToken(payload, recipient);
  return { identity, token, payload };
}

function makeRequest(headers: Record<string, string | string[] | undefined>): MiddlewareRequest {
  return { headers };
}

function makeResponse(): { res: MiddlewareResponse; record: RecordedResponse } {
  const record: RecordedResponse = {};
  const res = {
    status(code: number) {
      record.status = code;
      return {
        json(body: unknown) {
          record.body = body;
        },
      };
    },
  } as unknown as MiddlewareResponse;
  return { res, record };
}

function expectUnauthorized(record: RecordedResponse, error: string): void {
  expect(record.status).toBe(401);
  expect(record.body).toEqual({ error });
}

describe("createAuthMiddleware", () => {
  const next = vi.fn();
  // Wraps the real implementation (call-through); history is cleared per test.
  const validateSpy = vi.spyOn(TokenValidator, "validate");

  afterEach(() => {
    next.mockClear();
    validateSpy.mockClear();
  });

  it("passes a valid bearer token through and attaches the payload to the request", async () => {
    const { identity, token, payload } = await mintValidToken();
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({ authorization: `Bearer ${token}` });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(record.status).toBeUndefined();
    expect(req.serviceAuth).toEqual(payload);
    expect(validateSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the first element when the Authorization header is an array", async () => {
    const { identity, token, payload } = await mintValidToken();
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({ authorization: [`Bearer ${token}`, "Bearer bogus"] });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(record.status).toBeUndefined();
    expect(req.serviceAuth).toEqual(payload);
  });

  it("responds 401 when the Authorization header is missing", async () => {
    const middleware = createAuthMiddleware({ getIdentity: () => null });
    const req = makeRequest({});
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Missing or invalid Authorization header");
    expect(next).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
    expect(req.serviceAuth).toBeUndefined();
  });

  it.each([
    ["an empty string", ""],
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["a lowercase bearer scheme", "bearer abc"],
    ["a bare Bearer prefix without a token separator", "Bearer"],
  ])("responds 401 when the Authorization header is %s", async (_label, headerValue) => {
    const middleware = createAuthMiddleware({ getIdentity: () => null });
    const req = makeRequest({ authorization: headerValue });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Missing or invalid Authorization header");
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when the Authorization header is an empty array", async () => {
    const middleware = createAuthMiddleware({ getIdentity: () => null });
    const req = makeRequest({ authorization: [] });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Missing or invalid Authorization header");
    expect(next).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("responds 401 when the bearer token is empty", async () => {
    const identity = await age.generateIdentity();
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({ authorization: "Bearer " });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when the identity getter returns null", async () => {
    const { token } = await mintValidToken();
    const middleware = createAuthMiddleware({ getIdentity: () => null });
    const req = makeRequest({ authorization: `Bearer ${token}` });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Service identity not available");
    expect(next).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("responds 401 when the identity getter returns undefined", async () => {
    const { token } = await mintValidToken();
    const middleware = createAuthMiddleware({ getIdentity: () => undefined });
    const req = makeRequest({ authorization: `Bearer ${token}` });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Service identity not available");
    expect(next).not.toHaveBeenCalled();
    expect(validateSpy).not.toHaveBeenCalled();
  });

  it("responds 401 when the token is invalid for the configured identity", async () => {
    const identity = await age.generateIdentity();
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({ authorization: "Bearer not-a-valid-token!!!" });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
    expect(req.serviceAuth).toBeUndefined();
  });

  it("responds 401 when the token is expired", async () => {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const past = Math.floor(Date.now() / 1000) - 600;
    const token = await mintToken(
      { sub: "agent-1", scope: "service", iat: past, exp: past + 300 },
      recipient,
    );
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({ authorization: `Bearer ${token}` });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expectUnauthorized(record, "Invalid or expired token");
    expect(next).not.toHaveBeenCalled();
    expect(req.serviceAuth).toBeUndefined();
  });

  it("prefers the lowercase authorization header when both casings are present", async () => {
    const { identity, token, payload } = await mintValidToken();
    const middleware = createAuthMiddleware({ getIdentity: () => identity });
    const req = makeRequest({
      authorization: `Bearer ${token}`,
      Authorization: "Bearer deliberately-invalid",
    });
    const { res, record } = makeResponse();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(record.status).toBeUndefined();
    expect(req.serviceAuth).toEqual(payload);
    expect(validateSpy).toHaveBeenCalledWith(token, identity);
  });
});
