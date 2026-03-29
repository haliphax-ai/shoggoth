/**
 * Control ping using operator_token auth (same policy path; source cli_operator_token).
 * Requires SHOGGOTH_OPERATOR_TOKEN to match daemon secret (env or operatorTokenPath).
 */
import { invokeControlRequest } from "@shoggoth/daemon/lib";

const socketPath = process.env.SHOGGOTH_CONTROL_SOCKET ?? "/run/shoggoth/control.sock";
const token = process.env.SHOGGOTH_OPERATOR_TOKEN?.trim();
if (!token) {
  console.error("SHOGGOTH_OPERATOR_TOKEN required");
  process.exit(1);
}
const r = await invokeControlRequest({
  socketPath,
  auth: { kind: "operator_token", token },
  op: "ping",
});
if (!r.ok) {
  console.error(JSON.stringify(r, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(r.result));
