# Implementation

## Phase 1: Pin Cancellation Behavior

Add real session/tool-loop regression tests under
`packages/daemon/test/control/oob-turn-abort.test.ts` and demonstrate failure
before changing production code.

## Phase 2: Carry Cancellation State

Update `sessions/session-agent-turn.ts`, `control/integration-ops.ts` and the
timer delivery in `index.ts`. Retain the existing abort scope lifecycle,
partial transcript behavior and platform-neutral notification boundary.

## Phase 3: Verify

Run focused and complete project tests, typecheck, formatter and linter. Cover
both OOB entry points and genuine failure/recovery before completing this plan.

## Implementation Notes

The timer callback is extracted into `timers/timer-delivery.ts` and used directly
by `TimerScheduler`, allowing the production entry to be tested without starting
the daemon. Its existing metadata, schema and delivery mode remain unchanged.

The 13 cancellation regressions and 27 existing OOB tests pass. Workspace-wide
typechecking passes for all 16 projects, and strict UID isolation passes all 200
tests. The complete project suite ran with 3,946 passing tests and one unrelated
TCP timeout failure, also reproduced on the clean base: the test assumes that
`192.0.2.1:8123` cannot connect, but the current network accepts that connection.
