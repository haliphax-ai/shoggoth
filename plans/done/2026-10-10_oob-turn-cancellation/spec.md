# Specification

`SessionAgentTurnResult.aborted?: boolean` is true only when the session core
catches `TurnAbortedError`. Partial assistant text is retained independently.

`deliverOobStructuredResponse` accepts `aborted?: boolean`. An aborted initial
or repair response is never parsed, retried or delivered to the sender.
The handler posts a cancellation notice only if
`resolveOutboundChannelIdForSession(respondTo)` resolves an attached surface.

Timer and subagent-result callers forward the structured cancellation marker.
Ordinary malformed-output, provider-failure and successful-delivery contracts
do not change. Workflow callers requesting exceptions still receive them.
