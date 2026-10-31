/**
 * The platform's AWS calls for the device lab: start, stop and read the Windows box, and send the fixed MuseLab-Control
 * document. These are all the role musemuse-platform-native lets it do on EC2 and SSM, and they're all this file offers:
 * no caller can name an instance, a document or a command. The Mac has no stop on purpose, since stopping scrubs it for up
 * to 4.5 hours.
 *
 * Credentials come from the Vercel OIDC role in AWS_ROLE_ARN. Off Vercel, an AWS_ACCESS_KEY_ID in the environment works
 * too, for a local run. The region is always env.nativeAwsRegion, because a Vercel function's own AWS_REGION can differ.
 *
 * These are plain signed requests, not @aws-sdk clients: EC2 and SSM are two small protocols here, and their SDKs would be
 * tens of megabytes in a function that calls them once every 5 minutes. Everything in this file is loaded with import()
 * from the sweep and the wake, so nothing here runs unless NATIVE_LAB is on.
 */
import { createHash, createHmac } from "node:crypto";
import { env } from "@/lib/env";
import type { NativeLane } from "@/lib/native/types";

/** The one SSM document the platform runs, and the one parameter it takes. */
export const CONTROL_DOCUMENT = "MuseLab-Control";
export const CONTROL_ACTIONS = ["status", "restart-agent", "update-agent", "cleanup", "reboot"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export class AwsError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = "AwsError";
  }
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface AwsDeps {
  credentials?: () => Promise<AwsCredentials>;
  fetch?: typeof fetch;
}

let cachedCredentials: AwsCredentials | null = null;

/** The platform's role through the deployment's OIDC token. Kept until 5 minutes before they expire. */
async function platformCredentials(): Promise<AwsCredentials> {
  if (cachedCredentials?.expiration && cachedCredentials.expiration.getTime() - Date.now() > 5 * 60_000) return cachedCredentials;
  const roleArn = env.awsRoleArn;
  if (roleArn) {
    const { awsCredentialsProvider } = await import("@vercel/functions/oidc");
    cachedCredentials = await awsCredentialsProvider({
      roleArn,
      roleSessionName: "musemuse-native",
      clientConfig: { region: env.nativeAwsRegion },
    })();
    return cachedCredentials;
  }
  const { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_SESSION_TOKEN: sessionToken } = process.env;
  if (!process.env.VERCEL && accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  throw new AwsError("AWS isn't set up: AWS_ROLE_ARN is empty.", "not_configured");
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

function bytesOf(data: SourceData): string | Uint8Array {
  if (typeof data === "string") return data;
  return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
}

/** The hash SignatureV4 asks for, on node:crypto. */
class Sha256 {
  private readonly hash;
  constructor(secret?: SourceData) {
    this.hash = secret ? createHmac("sha256", bytesOf(secret)) : createHash("sha256");
  }
  update(data: Uint8Array) {
    this.hash.update(data);
  }
  async digest() {
    return new Uint8Array(this.hash.digest());
  }
  reset() {}
}

async function send(
  deps: AwsDeps,
  service: "ec2" | "ssm",
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  const { SignatureV4 } = await import("@smithy/signature-v4");
  const region = env.nativeAwsRegion;
  const hostname = `${service}.${region}.amazonaws.com`;
  const signer = new SignatureV4({ service, region, sha256: Sha256, credentials: await (deps.credentials ?? platformCredentials)() });
  const signed = await signer.sign({ method: "POST", protocol: "https:", hostname, path: "/", query: {}, headers: { host: hostname, ...headers }, body });
  return (deps.fetch ?? fetch)(`https://${hostname}/`, {
    method: "POST",
    headers: signed.headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

/** One EC2 Query API call. Answers its XML. AWS's own error code stays, its text doesn't: it can quote account details. */
async function ec2(deps: AwsDeps, action: string, params: Record<string, string>): Promise<string> {
  const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params }).toString();
  const res = await send(deps, "ec2", { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }, body);
  const text = await res.text();
  if (!res.ok) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
    throw new AwsError(`EC2 ${action} answered ${res.status}${code ? ` (${code})` : ""}.`, code, res.status);
  }
  return text;
}

/** One SSM JSON API call. */
async function ssm<T>(deps: AwsDeps, action: string, input: unknown): Promise<T> {
  const headers = { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AmazonSSM.${action}` };
  const res = await send(deps, "ssm", headers, JSON.stringify(input));
  const reply = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof reply.__type === "string" ? reply.__type.split("#").pop() ?? null : null;
    throw new AwsError(`SSM ${action} answered ${res.status}${code ? ` (${code})` : ""}.`, code, res.status);
  }
  return reply as T;
}

function instanceOf(lane: NativeLane): string {
  const id = lane === "mac" ? env.nativeMacInstanceId : env.nativeWindowsInstanceId;
  if (!id) throw new AwsError(`The ${lane} box has no instance id.`, "not_configured");
  return id;
}

/** EC2's name for an instance's state: pending, running, stopping, stopped, shutting-down or terminated. */
export async function windowsBoxState(deps: AwsDeps = {}): Promise<string> {
  const xml = await ec2(deps, "DescribeInstances", { "InstanceId.1": instanceOf("windows") });
  const state = /<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/.exec(xml)?.[1];
  if (!state) throw new AwsError("EC2 didn't say what state the Windows box is in.", "no_state");
  return state;
}

export async function startWindowsBox(deps: AwsDeps = {}): Promise<void> {
  await ec2(deps, "StartInstances", { "InstanceId.1": instanceOf("windows") });
}

export async function stopWindowsBox(deps: AwsDeps = {}): Promise<void> {
  await ec2(deps, "StopInstances", { "InstanceId.1": instanceOf("windows") });
}

/** Runs one action of the control document on a box. Answers the command's id. */
export async function sendLabCommand(lane: NativeLane, action: ControlAction, deps: AwsDeps = {}): Promise<string> {
  if (!CONTROL_ACTIONS.includes(action)) throw new AwsError(`${String(action)} isn't a control action.`, "bad_action");
  const reply = await ssm<{ Command?: { CommandId?: string } }>(deps, "SendCommand", {
    DocumentName: CONTROL_DOCUMENT,
    InstanceIds: [instanceOf(lane)],
    Parameters: { action: [action] },
    TimeoutSeconds: 120,
    Comment: `Muse Muse sweep: ${action}`,
  });
  const id = reply.Command?.CommandId;
  if (!id) throw new AwsError("SSM didn't return a command id.", "no_command");
  return id;
}

export interface LabCommandResult {
  /** SSM's status: Pending, InProgress, Success, Failed, TimedOut and so on. */
  status: string;
  stdout: string;
}

/** Where a command has got to. A command SSM hasn't delivered yet reads as Pending. */
export async function labCommandResult(lane: NativeLane, commandId: string, deps: AwsDeps = {}): Promise<LabCommandResult> {
  try {
    const reply = await ssm<{ Status?: string; StandardOutputContent?: string }>(deps, "GetCommandInvocation", {
      CommandId: commandId,
      InstanceId: instanceOf(lane),
    });
    return { status: reply.Status ?? "Pending", stdout: reply.StandardOutputContent ?? "" };
  } catch (err) {
    if (err instanceof AwsError && err.code === "InvocationDoesNotExist") return { status: "Pending", stdout: "" };
    throw err;
  }
}

/** Whether SSM can reach a box: "Online", "ConnectionLost", or null when SSM doesn't know it. */
export async function labPing(lane: NativeLane, deps: AwsDeps = {}): Promise<string | null> {
  const reply = await ssm<{ InstanceInformationList?: Array<{ PingStatus?: string }> }>(deps, "DescribeInstanceInformation", {
    Filters: [{ Key: "InstanceIds", Values: [instanceOf(lane)] }],
  });
  return reply.InstanceInformationList?.[0]?.PingStatus ?? null;
}
