// JSON-lines logging with redaction. Nothing the agent writes, to its log or to a job's uploaded log, may carry a token.

const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [hidden]"],
  [/(vercel-blob-(?:delegation|signature)=)[^&\s"']+/g, "$1[hidden]"],
  [/(-museToken['"]?,?\s*['"]?)[A-Za-z0-9._~-]+/g, "$1[hidden]"],
  [/([?&]token=)[^&\s"']+/g, "$1[hidden]"],
];

/** `text` with every known secret and token-shaped value hidden. */
export function redactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[hidden]");
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * @param {{ write?: (line: string) => void, now?: () => Date }} [opts]
 */
export function createLogger({ write = (line) => process.stdout.write(line), now = () => new Date() } = {}) {
  const secrets = new Set();
  const emit = (level, message, fields) => {
    const line = JSON.stringify({ t: now().toISOString(), level, message, ...fields });
    write(`${redactText(line, [...secrets])}\n`);
  };
  return {
    addSecret: (value) => {
      if (value) secrets.add(value);
    },
    removeSecret: (value) => secrets.delete(value),
    redact: (text) => redactText(text, [...secrets]),
    info: (message, fields = {}) => emit("info", message, fields),
    warn: (message, fields = {}) => emit("warn", message, fields),
    error: (message, fields = {}) => emit("error", message, fields),
  };
}
