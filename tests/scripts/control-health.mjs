/**
 * Invoke control-plane health as Unix user shoggoth (SO_PEERCRED path).
 */
import { invokeControlRequest } from "@shoggoth/daemon/lib";

const socketPath = process.env.SHOGGOTH_CONTROL_SOCKET ?? "/run/shoggoth/control.sock";
const r = await invokeControlRequest({
  socketPath,
  auth: { kind: "operator_peercred" },
  op: "health",
});
if (!r.ok) {
  console.error(JSON.stringify(r, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(r.result, null, 2));
