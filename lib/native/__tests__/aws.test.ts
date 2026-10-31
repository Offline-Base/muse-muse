/**
 * The platform's AWS calls (lib/native/aws.ts), with fetch faked: no call leaves this machine. The requests have to be the
 * ones the role's policy allows, for the configured region and the configured box: one fixed document with one enum
 * parameter, and starts and stops only on the Windows box. The signature is checked against AWS's own SigV4 algorithm,
 * worked out here independently of the library that signs it.
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  AwsError,
  CONTROL_ACTIONS,
  CONTROL_DOCUMENT,
  labCommandResult,
  labPing,
  sendLabCommand,
  startWindowsBox,
  stopWindowsBox,
  windowsBoxState,
  type AwsCredentials,
} from "@/lib/native/aws";

const SAVED = { ...process.env };
const credentials: AwsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token-example" };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect?: RequestRedirect;
}

/** A fetch that answers `reply` and remembers what it was asked. */
function fakeAws(reply: { status?: number; body?: string } = {}) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body ?? ""), redirect: init?.redirect });
    return new Response(reply.body ?? "{}", { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, deps: { credentials: async () => credentials, fetch: fetchFake } };
}

const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
const sha = (data: string) => createHash("sha256").update(data).digest("hex");

/** AWS's Signature Version 4, step by step from its documentation. */
function expectedSignature(call: Call, service: string, region: string): string {
  const amzDate = call.headers["x-amz-date"]!;
  const date = amzDate.slice(0, 8);
  const auth = call.headers.authorization!;
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)![1]!;
  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => `${name}:${call.headers[name] ?? ""}\n`)
    .join("");
  const canonical = ["POST", "/", "", canonicalHeaders, signedHeaders, sha(call.body)].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service), "aws4_request");
  return hmac(key, toSign).toString("hex");
}

function assertSigned(call: Call, service: string, region: string) {
  const auth = call.headers.authorization!;
  assert.match(auth, new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${region}/${service}/aws4_request`));
  assert.match(auth, /SignedHeaders=[^,]*host/);
  assert.match(auth, /SignedHeaders=[^,]*x-amz-security-token/, "the session token is signed");
  assert.equal(call.headers["x-amz-security-token"], "session-token-example");
  assert.equal(/Signature=([a-f0-9]{64})/.exec(auth)?.[1], expectedSignature(call, service, region));
  assert.ok(!Object.values(call.headers).join(" ").includes(credentials.secretAccessKey), "the secret key isn't sent");
}

describe("the platform's AWS calls", () => {
  before(() => {
    process.env.NATIVE_WINDOWS_INSTANCE_ID = "i-0windows";
    process.env.NATIVE_MAC_INSTANCE_ID = "i-0mac";
    process.env.NATIVE_AWS_REGION = "us-east-1";
    // A function's own region must not count.
    process.env.AWS_REGION = "eu-west-1";
  });
  after(() => {
    process.env = { ...SAVED };
  });

  it("reads the Windows box's state from the configured region, signed", async () => {
    const { calls, deps } = fakeAws({
      body: `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-0windows</instanceId>
        <instanceState>
          <code>16</code>
          <name>running</name>
        </instanceState></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
    });
    assert.equal(await windowsBoxState(deps), "running");
    assert.equal(calls[0]!.url, "https://ec2.us-east-1.amazonaws.com/");
    assert.equal(calls[0]!.redirect, "error");
    const params = new URLSearchParams(calls[0]!.body);
    assert.equal(params.get("Action"), "DescribeInstances");
    assert.equal(params.get("InstanceId.1"), "i-0windows");
    assertSigned(calls[0]!, "ec2", "us-east-1");
  });

  it("follows NATIVE_AWS_REGION", async () => {
    process.env.NATIVE_AWS_REGION = "us-west-2";
    const { calls, deps } = fakeAws();
    await startWindowsBox(deps);
    assert.equal(calls[0]!.url, "https://ec2.us-west-2.amazonaws.com/");
    assertSigned(calls[0]!, "ec2", "us-west-2");
    process.env.NATIVE_AWS_REGION = "us-east-1";
  });

  it("starts and stops only the Windows box", async () => {
    const { calls, deps } = fakeAws();
    await startWindowsBox(deps);
    await stopWindowsBox(deps);
    assert.deepEqual(
      calls.map((c) => {
        const p = new URLSearchParams(c.body);
        return [p.get("Action"), p.get("InstanceId.1")];
      }),
      [["StartInstances", "i-0windows"], ["StopInstances", "i-0windows"]],
    );
    const anyMacStop = await import("@/lib/native/aws");
    assert.equal("stopMacBox" in anyMacStop, false, "nothing can stop the Mac, because stopping scrubs it for hours");
    assert.equal(JSON.stringify(calls).includes("i-0mac"), false);
  });

  it("names EC2's error code, and none of its text", async () => {
    const { deps } = fakeAws({ status: 403, body: "<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>Account 1234 role musemuse</Message></Error></Errors></Response>" });
    await assert.rejects(startWindowsBox(deps), (err: unknown) => {
      assert.ok(err instanceof AwsError);
      assert.equal(err.code, "UnauthorizedOperation");
      assert.equal(err.status, 403);
      assert.ok(!err.message.includes("1234"));
      return true;
    });
  });

  it("refuses to work with no instance id, or no state in the reply", async () => {
    const { deps } = fakeAws({ body: "<nothing/>" });
    await assert.rejects(windowsBoxState(deps), /what state/);
    delete process.env.NATIVE_WINDOWS_INSTANCE_ID;
    await assert.rejects(windowsBoxState(deps), /no instance id/);
    process.env.NATIVE_WINDOWS_INSTANCE_ID = "i-0windows";
  });

  it("sends the fixed control document with one enum parameter, to the right box", async () => {
    const { calls, deps } = fakeAws({ body: JSON.stringify({ Command: { CommandId: "cmd-1" } }) });
    assert.equal(await sendLabCommand("mac", "restart-agent", deps), "cmd-1");
    const call = calls[0]!;
    assert.equal(call.url, "https://ssm.us-east-1.amazonaws.com/");
    assert.equal(call.headers["x-amz-target"], "AmazonSSM.SendCommand");
    assert.equal(call.headers["content-type"], "application/x-amz-json-1.1");
    const body = JSON.parse(call.body);
    assert.equal(body.DocumentName, "MuseLab-Control");
    assert.deepEqual(body.InstanceIds, ["i-0mac"]);
    assert.deepEqual(body.Parameters, { action: ["restart-agent"] });
    assert.deepEqual(Object.keys(body.Parameters), ["action"]);
    assertSigned(call, "ssm", "us-east-1");
    await sendLabCommand("windows", "status", deps);
    assert.deepEqual(JSON.parse(calls[1]!.body).InstanceIds, ["i-0windows"]);
  });

  it("refuses an action the document doesn't have, before anything is sent", async () => {
    const { calls, deps } = fakeAws();
    await assert.rejects(sendLabCommand("mac", "rm -rf /" as "status", deps), (err: unknown) => err instanceof AwsError && err.code === "bad_action");
    assert.equal(calls.length, 0);
  });

  it("offers the actions the SSM document allows, under its name", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = JSON.parse(readFileSync(new URL("../../../native/lab/ssm/MuseLab-Control.json", import.meta.url), "utf8"));
    assert.deepEqual([...CONTROL_ACTIONS], doc.parameters.action.allowedValues);
    assert.deepEqual(Object.keys(doc.parameters), ["action"]);
    assert.equal(CONTROL_DOCUMENT, "MuseLab-Control");
  });

  it("reads a command's result, with an undelivered command as Pending", async () => {
    const done = fakeAws({ body: JSON.stringify({ Status: "Success", StandardOutputContent: '{"ok":true}' }) });
    assert.deepEqual(await labCommandResult("mac", "cmd-1", done.deps), { status: "Success", stdout: '{"ok":true}' });
    assert.deepEqual(JSON.parse(done.calls[0]!.body), { CommandId: "cmd-1", InstanceId: "i-0mac" });
    const early = fakeAws({ status: 400, body: JSON.stringify({ __type: "com.amazonaws.ssm#InvocationDoesNotExist" }) });
    assert.deepEqual(await labCommandResult("mac", "cmd-1", early.deps), { status: "Pending", stdout: "" });
    const bad = fakeAws({ status: 400, body: JSON.stringify({ __type: "AccessDeniedException", message: "role details" }) });
    await assert.rejects(labCommandResult("mac", "cmd-1", bad.deps), (err: unknown) => err instanceof AwsError && err.code === "AccessDeniedException" && !err.message.includes("role details"));
  });

  it("reads whether SSM can reach a box", async () => {
    const online = fakeAws({ body: JSON.stringify({ InstanceInformationList: [{ PingStatus: "Online" }] }) });
    assert.equal(await labPing("mac", online.deps), "Online");
    assert.deepEqual(JSON.parse(online.calls[0]!.body).Filters, [{ Key: "InstanceIds", Values: ["i-0mac"] }]);
    assert.equal(online.calls[0]!.headers["x-amz-target"], "AmazonSSM.DescribeInstanceInformation");
    assert.equal(await labPing("mac", fakeAws({ body: JSON.stringify({ InstanceInformationList: [] }) }).deps), null);
  });

  it("says plainly when AWS isn't set up, with no role and no local keys", async () => {
    delete process.env.AWS_ROLE_ARN;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    await assert.rejects(startWindowsBox({ fetch: fakeAws().deps.fetch }), /AWS_ROLE_ARN/);
  });

  it("never uses local keys on Vercel, only the role", async () => {
    delete process.env.AWS_ROLE_ARN;
    process.env.AWS_ACCESS_KEY_ID = "AKIALOCAL";
    process.env.AWS_SECRET_ACCESS_KEY = "local-secret";
    process.env.VERCEL = "1";
    await assert.rejects(startWindowsBox({ fetch: fakeAws().deps.fetch }), /AWS_ROLE_ARN/);
    delete process.env.VERCEL;
    const { calls, deps } = fakeAws();
    await startWindowsBox({ fetch: deps.fetch });
    assert.match(calls[0]!.headers.authorization!, /Credential=AKIALOCAL/);
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
  });
});
