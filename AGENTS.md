# Agent Instructions

## The Project

This is Shoggoth, an agent orchestration platform that is Docker-first with a strict permission boundary between the system (`root`, UID/GID `0`), the orchestrator daemon (`shoggoth`, UID/GID `900`) and agents (`agent`, UID/GID `901`).

## Plan Ahead

Significant or complex changes to the codebase should be planned first. See [`plans/AGENTS.md`](plans/AGENTS.md) for instructions on creating, updating, and completing plan documents. If you are a subagent who is doing a simple task that does not involve a plan document, DO NOT waste tokens looking around in there.

## Tests Before Code

Contributions to this codebase must use red/green TDD. Changes that affect existing behavior or integrations with existing system parts should be tested as well as the added/changed code.

## Commit Early, Commit Often

Commits should be small and focused, representing a single unit of work. They also provide a convenient rollback point if changes turn out to break things in unexpected ways.

## It's Okay to Break Things

This is pre-release software, and the only user is the developer. Backward compatibility, maintaining call site structure, etc. are a waste of effort and should be skipped.

## Security First

The security principles and policies of the project should always be kept in mind when implementing new features or refactoring. The system, daemon, and agent layers should have read-only (or read-never) barriers between them both in the file system and in processes.

## Pluggable Platforms

Message platform code should maintain separation between a platform implementation (e.g. Discord reaction handling code) and the daemon's internal representation of the feature capability (reactions) for features that exist in multiple platforms.

Platforms should plug into system internals using hook points so that the implementation remains packaged and separate.

Discord is currently the only available platform, but it should not be treated as such--future platform development and layers of abstraction should always be considered when making changes to the messaging system. Platform capabilities and transport should be registered and routed through the presentation layer.
