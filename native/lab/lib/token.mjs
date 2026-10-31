// The lab token: read from SSM Parameter Store through the instance role, with the AWS SDK when it's installed and the
// aws CLI otherwise. It's never printed, and an error here never quotes what a tool wrote to stdout. For a run against
// a local platform, MUSE_LAB_TOKEN_FILE names a file that holds it.
import { readFile } from "node:fs/promises";
import { run } from "./proc.mjs";

export function tokenParameterName(lane) {
  return `/musemuse/lab/${lane}/token`;
}

export function ssmCliArgs(name, region) {
  const args = ["aws", "ssm", "get-parameter", "--name", name, "--with-decryption", "--query", "Parameter.Value", "--output", "text"];
  if (region) args.push("--region", region);
  return args;
}

async function viaSdk(name, region, importSdk) {
  let sdk;
  try {
    sdk = await importSdk();
  } catch {
    return null;
  }
  const client = new sdk.SSMClient(region ? { region } : {});
  const reply = await client.send(new sdk.GetParameterCommand({ Name: name, WithDecryption: true }));
  return reply?.Parameter?.Value ?? null;
}

/**
 * @param {object} opts
 * @param {string} opts.lane
 * @param {string} [opts.region]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {typeof run} [opts.exec]
 * @param {() => Promise<any>} [opts.importSdk]
 * @returns {Promise<string>}
 */
export async function readLabToken({
  lane,
  region,
  env = process.env,
  exec = run,
  importSdk = () => import("@aws-sdk/client-ssm"),
}) {
  if (env.MUSE_LAB_TOKEN_FILE) {
    const token = (await readFile(env.MUSE_LAB_TOKEN_FILE, "utf8")).trim();
    if (!token) throw new Error("The lab token file is empty.");
    return token;
  }
  const name = tokenParameterName(lane);
  let sdkError = null;
  try {
    const value = await viaSdk(name, region, importSdk);
    if (value) return value.trim();
  } catch (err) {
    sdkError = err?.name ?? "error";
  }
  const reply = await exec(ssmCliArgs(name, region), { timeoutMs: 30_000 });
  const token = reply.code === 0 ? String(reply.stdout).trim() : "";
  if (!token || token === "None") {
    const why = reply.spawnError ? "the aws CLI isn't installed" : `the aws CLI exited with ${reply.code}`;
    throw new Error(`Couldn't read ${name}: ${why}${sdkError ? ` (the SDK said ${sdkError})` : ""}.`);
  }
  return token;
}
