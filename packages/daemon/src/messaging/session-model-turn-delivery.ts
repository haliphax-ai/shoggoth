/**
 * How a session model turn delivers its assistant output to the user. Core uses these shapes; each
 * messaging transport interprets them (e.g. maps `messaging_surface` to a platform-specific channel post).
 */
export type SessionModelTurnDelivery =
  | { readonly kind: "internal" }
  | {
      readonly kind: "messaging_surface";
      readonly userId: string;
      readonly replyToMessageId?: string;
    };
