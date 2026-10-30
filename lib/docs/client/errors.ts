import type { DocsError } from "@/lib/docs/client/api";

/**
 * What ErrorBox says about an error: a title and a line on what to do. The proxy's own messages are written for a
 * docs reader (docs/DOCS_MIRROR.md, "Errors"), so the box always shows the message too; this adds the why, keyed on
 * the error's code and type (the gateway's names, and Meta's).
 */

export type ErrorKind =
  | "rate_limit"
  | "budget"
  | "paused"
  | "too_large"
  | "model"
  | "endpoint"
  | "not_found"
  | "forbidden"
  | "network"
  | "timeout"
  | "invalid"
  | "auth"
  | "server"
  | "aborted"
  | "other";

export interface ErrorExplanation {
  kind: ErrorKind;
  title: string;
  hint: string;
}

export function errorKind(error: DocsError): ErrorKind {
  const code = `${error.code ?? ""} ${error.type ?? ""}`.toLowerCase();
  const message = error.message.toLowerCase();
  if (code.includes("aborted")) return "aborted";
  // Meta's media_url_origin_error is a bad media URL (its origin refused Meta's fetcher), not a blocked caller.
  if (code.includes("media_url")) return "invalid";
  if (/budget|spend|quota|cap_reached|daily_cap|ip_budget/.test(code)) return "budget";
  if (/paused|kill|docs_off/.test(code)) return "paused";
  if (/rate_limit|rate_limited|too_many|in_flight|429/.test(code)) return "rate_limit";
  if (/too_large|payload|body_too|413/.test(code)) return "too_large";
  if (/model_not_found|unknown_model/.test(code)) return "model";
  if (/unknown_endpoint|not_allowed_endpoint/.test(code)) return "endpoint";
  if (/not_found/.test(code)) return "not_found";
  if (/cross_site|cross-site|forbidden|permission_error|bad_origin/.test(code)) return "forbidden";
  if (/timeout|gateway_timeout|504/.test(code)) return "timeout";
  if (/authentication|invalid_api_key|unauthorized|upstream_auth/.test(code)) return "auth";
  if (/server_error|api_error|overloaded|upstream/.test(code)) return "server";
  if (/invalid_request|invalid_body|bad_request|missing_|unsupported/.test(code)) return "invalid";
  if (!error.code && !error.type && message.startsWith("couldn't reach")) return "network";
  return "other";
}

export function explainError(error: DocsError): ErrorExplanation {
  const kind = errorKind(error);
  switch (kind) {
    case "rate_limit":
      return {
        kind,
        title: "Too many runs at once",
        hint: "The live demos share one key, so each visitor gets a few runs a minute. Wait a moment and run it again.",
      };
    case "budget":
      return {
        kind,
        title: "Today's live demo budget is used up",
        hint: "Live demos have a daily spending cap per visitor and for the whole site, which resets at 00:00 UTC. The code samples still work with your own key.",
      };
    case "paused":
      return { kind, title: "Live demos are paused", hint: "Live calls are turned off for now. The code samples still work with your own key." };
    case "too_large":
      return { kind, title: "That request is too big", hint: "Live demos take bodies up to 4.5 MB. Use a file under 3 MB, or a smaller image." };
    case "model":
      return { kind, title: "That model isn't available here", hint: "Pick one from the model menu." };
    case "endpoint":
      return { kind, title: "The live demos can't call this endpoint", hint: "Copy the code and run it with your own key instead." };
    case "not_found":
      return {
        kind,
        title: "Not found",
        hint: "Live demos reach only the files and responses you created here, and clear files after an hour and responses after a day. Create a new one and use its id.",
      };
    case "forbidden":
      return { kind, title: "This call was blocked", hint: "Live demos run only from this site's own pages." };
    case "network":
      return { kind, title: "Couldn't connect", hint: "Check your connection and run it again." };
    case "timeout":
      return {
        kind,
        title: "The request took too long",
        hint: "Non-streamed calls have a time limit. Turn on streaming for long answers, or lower the reasoning effort.",
      };
    case "invalid":
      return { kind, title: "The API rejected the request", hint: "The message names the field it didn't accept. Fix it and run again." };
    case "auth":
      return { kind, title: "The demo key was rejected", hint: "This is on our side, not yours. Try again later." };
    case "server":
      return { kind, title: "The API had a problem", hint: "These usually pass. Try again in a moment." };
    case "aborted":
      return { kind, title: "Stopped", hint: "You stopped the request before the reply finished." };
    default:
      return { kind, title: "Something went wrong", hint: "Check the message below, then try again." };
  }
}

/** "12 s", "2 min 5 s". */
export function waitLabel(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
