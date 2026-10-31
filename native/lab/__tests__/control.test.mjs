// The SSM document, the control script and the setup scripts. Only the Mac script can be syntax-checked here, since this
// machine has no PowerShell, so the Windows script is checked for the settings the design requires. Both have also run on
// the real boxes (docs/NATIVE_LAB.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS, bundleParameterName, bundleProblem, cleanupCommands, parseAgentPid, restartCommands, s3CopyCommand } from "../control.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(HERE, "..", relative), "utf8");
const doc = JSON.parse(read("ssm/MuseLab-Control.json"));

describe("MuseLab-Control", () => {
  test("it's a command document with one enum parameter", () => {
    assert.equal(doc.schemaVersion, "2.2");
    assert.deepEqual(Object.keys(doc.parameters), ["action"]);
    assert.deepEqual(doc.parameters.action.allowedValues, ["status", "restart-agent", "update-agent", "cleanup", "reboot"]);
    assert.deepEqual(doc.parameters.action.allowedValues, ACTIONS);
    assert.equal(doc.parameters.action.default, undefined, "no default: a call must name its action");
  });
  test("only the enum goes into the scripts", () => {
    const text = JSON.stringify(doc.mainSteps);
    const used = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    assert.ok(used.length >= 2);
    assert.ok(used.every((name) => name === "action"));
  });
  test("one step per platform, each with a timeout", () => {
    const platforms = doc.mainSteps.map((step) => step.precondition.StringEquals[1]);
    assert.deepEqual(platforms, ["MacOS", "Windows"]);
    for (const step of doc.mainSteps) assert.ok(Number(step.inputs.timeoutSeconds) > 0);
  });
  test("the action reaches node quoted, and the Mac step drops root", () => {
    const mac = doc.mainSteps[0].inputs.runCommand.join("\n");
    assert.match(mac, /ACTION='\{\{ action \}\}'/);
    assert.match(mac, /sudo -u ec2-user/);
    assert.match(mac, /control\.mjs" "\$ACTION"/);
    assert.ok(!/\beval\b/.test(mac));
    const windows = doc.mainSteps[1].inputs.runCommand.join("\n");
    assert.match(windows, /\$action = '\{\{ action \}\}'/);
    assert.ok(!/Invoke-Expression|\biex\b/i.test(windows));
  });
  test("the Mac step reboots, and never stops the instance", () => {
    const mac = doc.mainSteps[0].inputs.runCommand.join("\n");
    assert.match(mac, /shutdown -r/);
    assert.ok(!/shutdown -h/.test(mac), "stopping a Mac scrubs it for hours");
  });
});

describe("control.mjs", () => {
  test("restarts per platform", () => {
    assert.deepEqual(restartCommands({ platform: "darwin", uid: 501 }), [["launchctl", "kickstart", "-k", "gui/501/ai.musemuse.lab"]]);
    assert.equal(restartCommands({ platform: "win32" })[1].at(-1), "MuseLabAgent");
  });
  test("a Windows restart ends the old node.exe before it starts the new one", () => {
    const commands = restartCommands({ platform: "win32", agentPid: "4242" });
    assert.deepEqual(commands.map((c) => c[0]), ["schtasks", "taskkill", "schtasks"]);
    assert.equal(commands[0][1], "/End");
    assert.equal(commands[2][1], "/Run");
    const kill = commands[1];
    assert.deepEqual(kill.slice(1, 3), ["/F", "/T"], "and the app and tools under it");
    assert.ok(kill.includes("PID eq 4242"));
    assert.ok(kill.includes("IMAGENAME eq node.exe"), "a stale pid can't end anything else");
  });
  test("a restart with no pid file still restarts, and the Mac needs none", () => {
    assert.deepEqual(restartCommands({ platform: "win32" }).map((c) => c[1]), ["/End", "/Run"]);
    assert.equal(restartCommands({ platform: "darwin", uid: 501, agentPid: "4242" }).length, 1);
  });
  test("parseAgentPid only takes a number", () => {
    assert.equal(parseAgentPid("4242\n"), "4242");
    for (const bad of [null, "", "4242 & calc", "-1", "abc"]) assert.equal(parseAgentPid(bad), null, String(bad));
  });
  test("cleanup clears simulators and the emulator on the Mac", () => {
    const text = cleanupCommands({ platform: "darwin" }).map((c) => c.join(" ")).join("\n");
    assert.match(text, /simctl shutdown all/);
    assert.match(text, /emu kill/);
    assert.deepEqual(cleanupCommands({ platform: "win32" }), []);
  });
  test("the bundle is pinned in Parameter Store", () => {
    assert.equal(bundleParameterName("mac"), "/musemuse/lab/mac/bundle");
    const pin = { version: "0.1.0", sha256: "a".repeat(64), url: "https://a.public.blob.vercel-storage.com/x.tgz" };
    assert.equal(bundleProblem(pin), null);
    assert.ok(bundleProblem(null));
    assert.ok(bundleProblem({ ...pin, version: "../../x" }));
    assert.ok(bundleProblem({ ...pin, sha256: "nope" }));
    assert.ok(bundleProblem({ ...pin, url: undefined }));
  });
  test("a bundle can also be pinned in the lab's bucket", () => {
    const pin = { version: "0.1.1-abc", sha256: "a".repeat(64), url: "s3://muse-knowledge-916979311153/lab/bundles/x.tgz" };
    assert.equal(bundleProblem(pin), null);
    assert.ok(bundleProblem({ ...pin, url: "s3://bucket/a b" }));
    assert.ok(bundleProblem({ ...pin, url: "s3:evil" }));
    assert.deepEqual(s3CopyCommand(pin.url, "/tmp/x", "us-east-1").slice(0, 5), ["aws", "s3", "cp", pin.url, "/tmp/x"]);
  });
  test("it refuses anything off the list, and reboot, which the document handles", () => {
    const script = path.join(HERE, "..", "control.mjs");
    for (const action of ["reboot", "rm -rf /", ""]) {
      const reply = spawnSync(process.execPath, [script, action], { encoding: "utf8" });
      assert.equal(reply.status, 2, action);
    }
  });
});

describe("setup/mac.sh", () => {
  const script = read("setup/mac.sh");
  test("is valid bash", () => {
    const reply = spawnSync("bash", ["-n", path.join(HERE, "..", "setup", "mac.sh")], { encoding: "utf8" });
    assert.equal(reply.status, 0, reply.stderr);
  });
  test("has what the design asks for", () => {
    for (const part of [
      "sysadminctl -autologin",
      "pmset -a sleep 0",
      "askForPassword",
      "brew install node@22 ffmpeg openjdk@17",
      "android-commandlinetools",
      "system-images;android-35;google_apis;arm64-v8a",
      'AVD_NAME="mm_pixel"',
      "ai.musemuse.lab.plist",
      "launchctl bootstrap",
      "xcodebuild -runFirstLaunch",
    ]) {
      assert.ok(script.includes(part), part);
    }
  });
  test("every license step sits behind MUSE_LAB_ACCEPT_LICENSES, and nothing here sets it", () => {
    const lines = script.split("\n");
    const gated = (needle) => {
      const at = lines.findIndex((line) => line.includes(needle));
      assert.ok(at > 0, needle);
      let depth = 0;
      for (let i = at; i >= 0; i--) {
        if (/^\s*fi\b/.test(lines[i])) depth += 1;
        if (/^\s*if\b/.test(lines[i])) {
          if (depth === 0 && lines[i].includes('"$ACCEPT_LICENSES" = "1"')) return true;
          if (depth > 0) depth -= 1;
        }
      }
      return false;
    };
    for (const needle of ["xcodebuild -license accept", "xcodebuild -runFirstLaunch", "xcodebuild -downloadPlatform iOS", "--licenses", "--cask android-commandlinetools", "--install"]) {
      assert.ok(gated(needle), needle);
    }
    assert.ok(!/MUSE_LAB_ACCEPT_LICENSES=1(?! )/.test(script.replace(/#.*$/gm, "").replace(/echo ".*"/g, "")), "only the owner sets it");
    assert.match(script, /ACCEPT_LICENSES="\$\{MUSE_LAB_ACCEPT_LICENSES:-\}"/);
  });
  test("the finish script refuses to run without the owner's flag", () => {
    const reply = spawnSync("bash", [path.join(HERE, "..", "setup", "mac-finish.sh")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: "/nonexistent" } });
    assert.equal(reply.status, 2);
    assert.match(reply.stderr, /MUSE_LAB_ACCEPT_LICENSES=1/);
  });
  test("never prints the password", () => {
    assert.ok(!/echo .*PASSWORD/.test(script));
    assert.ok(!script.includes("set -x"));
  });
});

describe("the LaunchAgent", () => {
  const plist = read("setup/ai.musemuse.lab.plist");
  test("runs at load, stays alive and only in the GUI session", () => {
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
    assert.match(plist, /__PLATFORM__/);
  });
  test("holds no secret", () => assert.ok(!/token|password|secret/i.test(plist)));
});

describe("setup/windows.ps1", () => {
  const script = read("setup/windows.ps1");
  test("has what the design asks for", () => {
    for (const part of [
      "LsaStorePrivateData",
      "AutoAdminLogon",
      "-AtLogOn",
      "-LogonType Interactive",
      "-RunLevel Limited",
      "MuseLabAgent",
      "$IdleMinutes = 20",
      "MUSE_LAB_IDLE_MINUTES",
      "ffmpeg-release-essentials.zip",
      "SHASUMS256.txt",
      "NoLockScreen",
      "SeShutdownPrivilege",
      "Width 1920 -Height 1080",
    ]) {
      assert.ok(script.includes(part), part);
    }
  });
  test("it takes no tool that makes the box accept a license", () => {
    assert.ok(!/accepteula|autologon64/i.test(script));
  });
  test("the lab user isn't an administrator", () => {
    assert.ok(!/Add-LocalGroupMember\s+-Group\s+"?Administrators/i.test(script));
  });
  test("never prints the password", () => {
    assert.ok(!/Write-(Host|Output)[^\n]*\$password/i.test(script));
    assert.ok(script.includes("Remove-Variable password"));
  });
});

describe("no em dashes in anything a person reads", () => {
  test("setup scripts and the SSM document", () => {
    for (const file of ["setup/mac.sh", "setup/windows.ps1", "ssm/MuseLab-Control.json", "lib/caption.mjs", "lib/rules.mjs"]) {
      assert.ok(!read(file).includes("\u2014"), file);
    }
  });
});
