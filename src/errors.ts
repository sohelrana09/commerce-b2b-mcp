/**
 * Structured tool errors.
 *
 * Every failure the agent sees has a stable `code`, a human-readable `message`
 * and a `retryable` flag, so the model can decide between retrying, changing
 * its input, or asking the human, instead of looping on the same call.
 */

export type ToolErrorCode =
  | "INVALID_INPUT" // the arguments are wrong; fix them, do not retry as-is
  | "NOT_FOUND" // no such entity visible to this caller
  | "FORBIDDEN" // caller lacks the B2B permission for this action
  | "TOOL_DISABLED" // merchant switched this tool off
  | "CONFIRMATION_REQUIRED" // write needs a valid confirmation token
  | "CONFIRMATION_INVALID" // token expired, tampered with, or for other input
  | "UPSTREAM_UNAVAILABLE" // commerce backend timed out / 5xx
  | "RATE_LIMITED"
  | "RESULT_TOO_LARGE" // the answer would not fit the context budget; narrow the request
  | "INTERNAL";

const RETRYABLE: Record<ToolErrorCode, boolean> = {
  INVALID_INPUT: false,
  NOT_FOUND: false,
  FORBIDDEN: false,
  TOOL_DISABLED: false,
  CONFIRMATION_REQUIRED: false,
  CONFIRMATION_INVALID: false,
  UPSTREAM_UNAVAILABLE: true,
  RATE_LIMITED: true,
  RESULT_TOO_LARGE: false,
  INTERNAL: false,
};

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;

  constructor(code: ToolErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.hint = hint;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.hint ? { hint: this.hint } : {}),
      },
    };
  }
}

/** Normalise anything thrown into a ToolError without leaking internals. */
export function asToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  return new ToolError("INTERNAL", "Unexpected server error. The call was not completed.");
}
