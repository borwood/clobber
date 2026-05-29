import type { ClobberPromptTag } from "@clobber/shared";
import type { ToolTokenStore } from "./tool-token-store.ts";

/**
 * The tool-token interlock (#321) — a reusable, prompt-independent confirmation
 * mechanism for high-repercussion tools. This helper carries the **mechanism
 * only**: mint, bind, inject the brief into the bearer's transcript, validate a
 * redemption, and revoke. Each consuming tool (`cycle`, `kill`, the internal
 * `test-tool`) supplies its own repercussion *copy* and its own `action` — that
 * split is the whole reuse story (OQ6).
 *
 * Generalized from the AskUserQuestion bridge's intercept-and-route shape
 * (`ask-user-question-bridge.ts`): there, a native tool call is intercepted and
 * routed through a side channel before it can run; here, an un-tokened CLI call
 * is no-op'd and routed as a `<clobber type="tool-token">` interjection into the
 * bearer's transcript, with the redemption accepted back through `--token`.
 */

// Mirror of the success/failure shape of `injectPrompt`'s result — the gate
// only needs to know whether delivery to the bearer succeeded.
export type ToolTokenInjectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface ToolTokenGateDeps {
  readonly tokens: ToolTokenStore;
  readonly inject: (
    sessionId: string,
    content: string,
    tag: ClobberPromptTag,
  ) => Promise<ToolTokenInjectResult>;
}

interface ToolTokenGateBase<A> {
  readonly tool: string;
  readonly callerSessionId: string;
  // Per-tool repercussion copy. The token + protocol reminder are appended by
  // the mechanism; the consumer writes only the consequence brief.
  readonly brief: string;
  // Fires on a valid redemption with the originally-saved args. It MUST throw
  // on failure: the gate consumes the token only after `action` resolves, so a
  // throw leaves the token live and the bearer retries without re-running the
  // interlock (retry-until-success, OQ4).
  readonly action: (args: A) => Promise<void>;
}

export type ToolTokenGateRequest<A> = ToolTokenGateBase<A> &
  (
    | {
        // Mint path: an un-tokened call. The bearer of the consequence is
        // `targetSessionId` (equals `callerSessionId` for a self-target).
        readonly token?: undefined;
        readonly targetSessionId: string;
        readonly args: A;
      }
    | {
        // Redeem path: the bearer presents the token; the saved args travel
        // with it, so no args are re-supplied here.
        readonly token: string;
      }
  );

export type ToolTokenGateResult =
  | { readonly kind: "minted"; readonly ack: string }
  | { readonly kind: "fired" }
  | { readonly kind: "rejected"; readonly status: number; readonly error: string };

export async function runToolTokenGate<A>(
  req: ToolTokenGateRequest<A>,
  deps: ToolTokenGateDeps,
): Promise<ToolTokenGateResult> {
  if (req.token === undefined) return mintAndInject(req, deps);
  return redeem(req.token, req, deps);
}

async function mintAndInject<A>(
  req: ToolTokenGateRequest<A> & { token?: undefined; targetSessionId: string; args: A },
  deps: ToolTokenGateDeps,
): Promise<ToolTokenGateResult> {
  const token = deps.tokens.mint({
    targetSessionId: req.targetSessionId,
    tool: req.tool,
    argsJson: JSON.stringify(req.args),
  });
  // The brief + token land in the BEARER's transcript, never in the caller's
  // return value. For Claude this queues even when the target is mid-turn; the
  // turn is processed at the next boundary. CAVEAT (#285): a turn injected into
  // a *busy* cross-agent target is processed but does not render in the UI
  // until #285 lands — acceptable for v1, and the self-target path (idle
  // caller reading its own interjection) sidesteps it entirely.
  const injected = await deps.inject(req.targetSessionId, composeInterjection(req.tool, req.brief, token), {
    kind: "tool-token",
    attrs: { via: req.tool },
  });
  if (!injected.ok) {
    // Delivery failed (target gone): a token nobody can read is dead weight and
    // would block the next mint, so drop it and surface the failure.
    deps.tokens.revoke({ targetSessionId: req.targetSessionId, tool: req.tool });
    return { kind: "rejected", status: injected.status, error: injected.error };
  }
  return { kind: "minted", ack: ackText(req.tool, req.targetSessionId) };
}

async function redeem<A>(
  token: string,
  req: ToolTokenGateBase<A>,
  deps: ToolTokenGateDeps,
): Promise<ToolTokenGateResult> {
  const binding = deps.tokens.lookup(token);
  if (binding === null) {
    return { kind: "rejected", status: 403, error: "invalid or revoked token" };
  }
  // Proof-of-receipt is non-transferable: only the bound bearer, redeeming for
  // the same tool, can fire the action.
  if (binding.tool !== req.tool || binding.target_session_id !== req.callerSessionId) {
    return { kind: "rejected", status: 403, error: "token not redeemable by this caller" };
  }
  const args = JSON.parse(binding.args_json) as A;
  await req.action(args);
  deps.tokens.consume(token);
  return { kind: "fired" };
}

function composeInterjection(tool: string, brief: string, token: string): string {
  return [
    brief,
    "",
    "To proceed you must redeem this one-time token — it is proof you have read the",
    "above. It cannot be guessed or supplied from memory:",
    `  clobber ${tool} --token ${token}`,
    "",
    "Follow any handoff or wrap protocol in place before you redeem.",
  ].join("\n");
}

function ackText(tool: string, targetSessionId: string): string {
  return (
    `The targeted agent (session ${targetSessionId}) has received a one-time ${tool} ` +
    "token with instructions. It will act when ready; the token never returns through this call."
  );
}
