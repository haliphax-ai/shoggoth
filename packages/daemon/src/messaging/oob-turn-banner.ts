/**
 * OOB turn banners: a blockquoted "processing" banner at turn start, the status
 * bar streamed live into that message while the turn runs, and a terminal banner
 * (plus any `to_operator` content) when an out-of-band turn (timer, inter-session
 * message, workflow notification) finishes. Builders are platform-neutral and the
 * strings are unit-tested; a platform that cannot edit messages falls back to
 * posting the terminal banner as a new message. See docs/daemon.md (Turn Output
 * Presentation).
 */

/** Terminal outcome of an OOB turn, mirroring the status bar's terminal emoji. */
export type OobTurnOutcome = "finished" | "aborted" | "canceled" | "failed";

export interface OobTurnBannerText {
  /** Block-quoted "processing" line posted when the turn starts. */
  readonly processing: string;
  /** Block-quoted terminal line for the given outcome (✅ / 🛑 / ❌). */
  terminal(outcome: OobTurnOutcome): string;
}

/** Default cap on a timer prompt echoed into the processing banner. */
const DEFAULT_TIMER_PROMPT_CHARS = 60;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function terminalEmoji(outcome: OobTurnOutcome): string {
  if (outcome === "finished") return "✅";
  return outcome === "failed" ? "❌" : "🛑";
}

function terminalVerb(outcome: OobTurnOutcome): string {
  if (outcome === "finished") return "processed";
  if (outcome === "failed") return "failed";
  return outcome === "aborted" ? "aborted" : "canceled";
}

export function buildTimerTurnBanner(input: {
  timerId: string;
  message: string;
  maxPromptChars?: number;
}): OobTurnBannerText {
  const maxChars = input.maxPromptChars ?? DEFAULT_TIMER_PROMPT_CHARS;
  const prompt = truncate(input.message, maxChars);
  return {
    processing: `> ⏰ Processing timer: *${prompt}* \`${input.timerId}\` …`,
    terminal: (outcome) =>
      `> ⏰ ${terminalEmoji(outcome)} Timer ${terminalVerb(outcome)}: \`${input.timerId}\``,
  };
}

export function buildExecNotifyTurnBanner(input: {
  handleId: string;
  command: string;
  maxPromptChars?: number;
}): OobTurnBannerText {
  const maxChars = input.maxPromptChars ?? DEFAULT_TIMER_PROMPT_CHARS;
  const command = truncate(input.command, maxChars);
  return {
    processing: `> ↩️ Processing exec notification: *${command}* \`${input.handleId}\` …`,
    terminal: (outcome) =>
      `> ↩️ ${terminalEmoji(outcome)} Exec notification ${terminalVerb(outcome)}: \`${input.handleId}\``,
  };
}

export function buildSessionSendReplyTurnBanner(input: {
  handleId: string;
  targetSessionId: string;
  maxPromptChars?: number;
}): OobTurnBannerText {
  const maxChars = input.maxPromptChars ?? DEFAULT_TIMER_PROMPT_CHARS;
  const target = truncate(input.targetSessionId, maxChars);
  return {
    processing: `> 📨 Processing session-send reply from *${target}* \`${input.handleId}\` …`,
    terminal: (outcome) =>
      `> 📨 ${terminalEmoji(outcome)} Session-send reply ${terminalVerb(outcome)}: \`${input.handleId}\``,
  };
}

export function buildSessionMessageTurnBanner(input: {
  senderSessionId: string;
}): OobTurnBannerText {
  return {
    processing: `> 🗨️ Processing incoming message from \`${input.senderSessionId}\` …`,
    terminal: (outcome) =>
      `> 🗨️ ${terminalEmoji(outcome)} Message ${terminalVerb(outcome)} from \`${input.senderSessionId}\``,
  };
}

export function buildWorkflowTurnBanner(input: {
  workflowId: string;
  title?: string;
}): OobTurnBannerText {
  const titleSegment = input.title ? `from **${input.title}** ` : "";
  return {
    processing: `> ⚙️ Processing workflow notification ${titleSegment}\`${input.workflowId}\` …`,
    terminal: (outcome) =>
      `> ⚙️ ${terminalEmoji(outcome)} Workflow notification ${terminalVerb(outcome)} from \`${input.workflowId}\``,
  };
}
