import { ANTHROPIC_BASE_URL, API_BASE_URL } from "@/components/docs/playgrounds/start/facts";

/**
 * The authentication page as a builder: how to put the key in the environment on each shell (quickstart "Set your
 * API key", including its Windows note), and how each client sends it, always read from MODEL_API_KEY and never
 * written into code. Nothing here holds a key or asks for one; the key's shape is shown with placeholders.
 */

export type Shell = "unix" | "powershell" | "cmd";

export const SHELLS: ReadonlyArray<{ id: Shell; label: string }> = [
  { id: "unix", label: "macOS or Linux" },
  { id: "powershell", label: "Windows PowerShell" },
  { id: "cmd", label: "Windows cmd" },
];

export function envSetup(shell: Shell): { code: string; persist: string; syntax: "bash" } {
  if (shell === "powershell") {
    return {
      code: '$env:MODEL_API_KEY = "your-api-key-here"',
      persist: "To keep it across sessions, set it in System > Environment Variables.",
      syntax: "bash",
    };
  }
  if (shell === "cmd") {
    return {
      code: "set MODEL_API_KEY=your-api-key-here",
      persist: "To keep it across sessions, set it in System > Environment Variables.",
      syntax: "bash",
    };
  }
  return {
    code: 'export MODEL_API_KEY="your-api-key-here"',
    persist: "To keep it across sessions, add the export line to ~/.bashrc or ~/.zshrc.",
    syntax: "bash",
  };
}

/** The shell's way to read the variable inside a command. */
export function shellVar(shell: Shell): string {
  return shell === "powershell" ? "$env:MODEL_API_KEY" : shell === "cmd" ? "%MODEL_API_KEY%" : "$MODEL_API_KEY";
}

export type AuthClient = "curl" | "requests" | "openai-python" | "openai-typescript" | "anthropic-python" | "fetch" | "litellm";

export const AUTH_CLIENTS: ReadonlyArray<{ id: AuthClient; label: string; syntax: "bash" | "python" | "typescript" }> = [
  { id: "curl", label: "curl", syntax: "bash" },
  { id: "requests", label: "Python requests", syntax: "python" },
  { id: "openai-python", label: "OpenAI SDK (Python)", syntax: "python" },
  { id: "openai-typescript", label: "OpenAI SDK (TypeScript)", syntax: "typescript" },
  { id: "anthropic-python", label: "Anthropic SDK (Python)", syntax: "python" },
  { id: "litellm", label: "LiteLLM", syntax: "python" },
  { id: "fetch", label: "fetch (TypeScript)", syntax: "typescript" },
];

/** The page's request (Hello on Chat Completions) in each client, with the key coming from the environment. */
export function authSnippet(client: AuthClient, shell: Shell, model: string): string {
  const m = JSON.stringify(model);
  switch (client) {
    case "curl": {
      const json = `{"model": ${m}, "messages": [{"role": "user", "content": "Hello"}]}`;
      if (shell === "unix") {
        return [
          `curl ${API_BASE_URL}/chat/completions`,
          `  -H "Authorization: Bearer $MODEL_API_KEY"`,
          '  -H "Content-Type: application/json"',
          `  -d '{\n    "model": ${m},\n    "messages": [{"role": "user", "content": "Hello"}]\n  }'`,
        ].join(" \\\n");
      }
      // Windows shells quote inline JSON differently from version to version, and Windows PowerShell 5.1 aliases curl
      // to Invoke-WebRequest. A body file and curl.exe work the same everywhere.
      const write = shell === "powershell" ? `'${json}' | Out-File -Encoding ascii body.json` : `echo ${json} > body.json`;
      const nl = shell === "powershell" ? " `\n" : " ^\n";
      return [
        write,
        [
          `curl.exe ${API_BASE_URL}/chat/completions`,
          `  -H "Authorization: Bearer ${shellVar(shell)}"`,
          '  -H "Content-Type: application/json"',
          '  -d "@body.json"',
        ].join(nl),
      ].join("\n");
    }
    case "requests":
      return `import os

import requests

response = requests.post(
    "${API_BASE_URL}/chat/completions",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
    json={"model": ${m}, "messages": [{"role": "user", "content": "Hello"}]},
)
response.raise_for_status()
print(response.json()["choices"][0]["message"]["content"])`;
    case "openai-python":
      return `import os
from openai import OpenAI

# The OpenAI SDK reads OPENAI_API_KEY, not MODEL_API_KEY: pass the key explicitly.
client = OpenAI(
    api_key=os.environ["MODEL_API_KEY"],
    base_url="${API_BASE_URL}",
)

response = client.chat.completions.create(
    model=${m},
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`;
    case "openai-typescript":
      return `import OpenAI from "openai";

// The OpenAI SDK reads OPENAI_API_KEY, not MODEL_API_KEY: pass the key explicitly.
const client = new OpenAI({
  apiKey: process.env.MODEL_API_KEY,
  baseURL: "${API_BASE_URL}",
});

const response = await client.chat.completions.create({
  model: ${m},
  messages: [{ role: "user", content: "Hello" }],
});
console.log(response.choices[0].message.content);`;
    case "anthropic-python":
      return `import os
from anthropic import Anthropic

# auth_token sends the key as a bearer token; base_url has no /v1 (the SDK adds /v1/messages).
client = Anthropic(
    base_url="${ANTHROPIC_BASE_URL}",
    auth_token=os.environ["MODEL_API_KEY"],
)

message = client.messages.create(
    model=${m},
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
print("".join(block.text for block in message.content if block.type == "text"))`;
    case "litellm":
      return `import os
import litellm

response = litellm.completion(
    model=${JSON.stringify(`openai/${model}`)},
    api_base="${API_BASE_URL}",
    api_key=os.environ["MODEL_API_KEY"],
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)`;
    case "fetch":
      return `const apiKey = process.env.MODEL_API_KEY;
if (!apiKey) throw new Error("MODEL_API_KEY is not set");

const response = await fetch("${API_BASE_URL}/chat/completions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${apiKey}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ model: ${m}, messages: [{ role: "user", content: "Hello" }] }),
});
if (!response.ok) throw new Error(\`HTTP \${response.status}: \${await response.text()}\`);
console.log((await response.json()).choices[0].message.content);`;
  }
}

/** The page's key safety practices, in its order. */
export const KEY_SAFETY: ReadonlyArray<{ title: string; detail: string }> = [
  { title: "Use unique keys per application", detail: "A key per app or developer, so you can revoke one without breaking the rest." },
  { title: "Keep keys out of client code", detail: "Mobile and browser code is visible to users. Proxy requests through a server you control." },
  { title: "Never commit keys to version control", detail: "Load them from environment variables or a secrets manager, and add credential files to .gitignore." },
  { title: "Use environment variables or a key manager", detail: "Centralized secrets keep rotation simple and keys out of source files." },
  { title: "Monitor for anomalies", detail: "Watch usage for unexpected spikes that suggest a leak, then revoke and rotate immediately." },
];

/** The 401 the error-handling page records for a missing or bad key. */
export const RECORDED_401 = {
  status: 401,
  body: { error: { message: "Unauthorized", type: "authentication_error", param: null, code: "invalid_api_key" } },
  request: `curl -X POST "${API_BASE_URL}/chat/completions" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "muse-spark-1.3-contributor", "messages": [{"role": "user", "content": "Hello"}]}'`,
};
