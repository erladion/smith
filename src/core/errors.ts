import OpenAI from "openai";

/** Turns API and network errors into readable text for the transcript. */
export function describeError(err: unknown, baseURL: string): string {
  if (err instanceof OpenAI.APIConnectionError) {
    // The SDK only says "Connection error."; the real reason (refused, DNS,
    // certificate, timeout) is in the chain of causes underneath.
    const cause = networkCause(err);
    if (!cause) return `Could not reach ${baseURL}. Is the server running? (${err.message})`;
    const hint = hintFor(cause.code);
    return `Could not reach ${baseURL}: ${cause.message}${cause.code && !cause.message.includes(cause.code) ? ` (${cause.code})` : ""}.${hint ? `\n${hint}` : ""}`;
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status ? `HTTP ${err.status}: ` : "";
    return `Server error. ${status}${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The innermost error with a system or TLS error code, following `cause` and AggregateError. */
export function networkCause(err: unknown): { code?: string; message: string } | undefined {
  let found: { code?: string; message: string } | undefined;
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof e.code === "string") {
      // Node appends advice to run with --use-system-ca, which the agent already does.
      const message = String(e.message ?? e.code).replace(/; if the root CA is installed locally.*$/, "");
      found = { code: e.code, message };
    }
    current = e.cause ?? (Array.isArray(e.errors) ? e.errors[0] : undefined);
  }
  return found;
}

function hintFor(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_TLS/.test(code)) {
    return (
      "The server's certificate isn't trusted. The agent trusts the system certificate store, so if it's " +
      "signed by an internal CA, add that CA there (RHEL: copy it to /etc/pki/ca-trust/source/anchors/ and " +
      "run update-ca-trust), or point NODE_EXTRA_CA_CERTS at it."
    );
  }
  if (code === "ECONNREFUSED") return "Nothing is listening at that address and port. Check the host, port and that the server is up.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The host name doesn't resolve. Check its spelling and your DNS.";
  if (/TIMEDOUT|TIMEOUT|ENETUNREACH|EHOSTUNREACH/.test(code)) {
    return "The server can't be reached from here. If your network needs a proxy, set HTTPS_PROXY (or HTTP_PROXY); the agent uses it, and NO_PROXY for exceptions.";
  }
  if (code === "ECONNRESET") return "The connection was dropped. A proxy or firewall in between may be refusing it.";
  return undefined;
}
