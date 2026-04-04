/** Discriminated auth payloads on the JSONL wire (embedded in WireRequest). */

export type WireAuthOperatorToken = {
  kind: "operator_token";
  token: string;
};

export type WireAuthAgent = {
  kind: "agent";
  session_id: string;
  token: string;
};

export type WireAuth =
  | WireAuthOperatorToken
  | WireAuthAgent;
