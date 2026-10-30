/**
 * The stage parser and the staged-approval engine against the staged-approvals recipe: its three-stage command,
 * the modes, incomplete stages, the dangerous list, prefix grants and rule precedence.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/shell-approvals.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDangerous, parseCommand, prefixSuggestion } from "@/components/docs/playgrounds/muse-code-cookbook/logic/shell";
import { answer, choicesFor, intentFor, jqOutput, policyFile, stageEvidence, startReview, toolOutcome, type Rule } from "@/components/docs/playgrounds/muse-code-cookbook/logic/approvals";

const RECIPE = "wc -l report.log && echo cleaning && rm -rf report.log";

describe("parseCommand", () => {
  it("splits the recipe's command into three complete stages", () => {
    const p = parseCommand(RECIPE);
    assert.equal(p.error, null);
    assert.deepEqual(
      p.stages.map((s) => [s.sourcePosition, s.argv, s.argvComplete, s.next]),
      [
        [0, ["wc", "-l", "report.log"], true, "&&"],
        [20, ["echo", "cleaning"], true, "&&"],
        [37, ["rm", "-rf", "report.log"], true, null],
      ],
    );
  });

  it("marks the recipe's three reasons for an incomplete argv", () => {
    assert.deepEqual(parseCommand("FOO=1 make test").stages[0].incompleteReasons, ["variable-assignment prefix"]);
    assert.deepEqual(parseCommand("FOO=1 make test").stages[0].argv, ["make", "test"]);
    assert.deepEqual(parseCommand("echo $(whoami) > out.txt").stages[0].incompleteReasons, ["command substitution", "a redirect that isn't read-only"]);
    assert.deepEqual(parseCommand("echo `date`").stages[0].incompleteReasons, ["command substitution"]);
    assert.equal(parseCommand("ls 2>/dev/null").stages[0].argvComplete, true, "a write to /dev/null is read-only");
    assert.equal(parseCommand("grep x 2>&1").stages[0].argvComplete, true, "a descriptor copy is read-only");
    assert.equal(parseCommand("sort < in.txt").stages[0].argvComplete, true);
  });

  it("reads quotes, redirects inside words, pipes and comments", () => {
    assert.deepEqual(parseCommand("echo 'a && b' \"c d\"").stages.map((s) => s.argv), [["echo", "a && b", "c d"]]);
    const hi = parseCommand("echo hi>out.txt").stages[0];
    assert.deepEqual([hi.argv, hi.redirects.map((r) => [r.op, r.target])], [["echo", "hi"], [[">", "out.txt"]]]);
    const fd = parseCommand("make 2>err.log").stages[0];
    assert.deepEqual(fd.redirects.map((r) => [r.fd, r.op, r.target]), [[2, ">", "err.log"]]);
    assert.deepEqual(parseCommand("cat a | grep b; ls # list").stages.map((s) => [s.argv, s.next]), [
      [["cat", "a"], "|"],
      [["grep", "b"], ";"],
      [["ls"], null],
    ]);
  });

  it("fails closed on what it can't read", () => {
    assert.match(parseCommand("echo 'open").error ?? "", /never closed/);
    assert.match(parseCommand("cat <<EOF").error ?? "", /Heredocs/);
    assert.match(parseCommand("(cd x && rm -rf y)").error ?? "", /Subshells/);
    assert.equal(parseCommand("echo 'open").stages.every((s) => !s.argvComplete), true);
  });

  it("knows the dangerous list and which stages get a prefix", () => {
    assert.equal(isDangerous(["rm", "-rf", "x"]), true);
    assert.equal(isDangerous(["rm", "-f", "x"]), true);
    assert.equal(isDangerous(["sudo", "-u", "root", "rm", "-fr", "/x"]), true);
    assert.equal(isDangerous(["setsid", "rm", "--force", "x"]), true);
    assert.equal(isDangerous(["rm", "x"]), false);
    assert.equal(isDangerous(["echo", "rm", "-rf"]), false);
    const prefix = (c: string) => prefixSuggestion(parseCommand(c).stages[0]);
    assert.deepEqual(prefix("rm -rf report.log"), ["rm"]);
    assert.deepEqual(prefix("cargo test --release"), ["cargo", "test"]);
    assert.deepEqual(prefix("git push origin main"), ["git", "push"]);
    assert.equal(prefix("git"), null, "a bare git");
    assert.equal(prefix("python3 script.py"), null);
    assert.equal(prefix("sudo rm -f build.log"), null);
    assert.equal(prefix("FOO=1 make test"), null, "incomplete argv");
  });
});

describe("staged review", () => {
  it("clears the safe stages, holds rm -rf, and denies everything on reject", () => {
    const r = startReview(RECIPE, "on-request", []);
    assert.deepEqual(r.stages.map((s) => s.resolution.kind), ["known_safe", "known_safe", "unresolved"]);
    assert.equal(r.blocking, 2);
    assert.deepEqual(choicesFor(r.stages[2].stage).workspacePrefix, ["rm"]);
    const rejected = answer(r, "abort");
    assert.equal(rejected.status, "denied");
    assert.equal(toolOutcome(rejected), "tool denied: approval aborted");
    assert.equal(intentFor(rejected), null, "an aborted review records no side_effect_intent");
    assert.deepEqual(jqOutput(rejected), {
      stages: JSON.stringify({
        raw: RECIPE,
        stages: [
          { pos: 0, argv: ["wc", "-l", "report.log"], complete: true, res: "known_safe" },
          { pos: 20, argv: ["echo", "cleaning"], complete: true, res: "known_safe" },
          { pos: 37, argv: ["rm", "-rf", "report.log"], complete: true, res: "unresolved" },
        ],
      }),
      decision: '{"decision":"abort","policy_result":"deny"}',
    });
  });

  it("runs the original text once after allow once, as allow:approved", () => {
    const ran = answer(startReview(RECIPE, "on-request", []), "allow_once");
    assert.equal(ran.status, "ran");
    assert.equal(toolOutcome(ran), `Ran: ${RECIPE}`);
    assert.equal(intentFor(ran)?.policy_decision, "allow:approved");
    assert.equal(policyFile("/tmp/perm_run", ran.rules), JSON.stringify({ rules: [] }, null, 2), "allow once persists nothing");
  });

  it("keeps stage provenance on the approval event, not on the command-level intent", () => {
    const ran = answer(startReview(RECIPE, "on-request", []), "allow_once");
    assert.deepEqual(intentFor(ran), { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:approved" }, "the intent carries the authorization only");
    assert.deepEqual(stageEvidence(ran), [
      { source_position: 0, argv: ["wc", "-l", "report.log"], resolution: "known_safe" },
      { source_position: 20, argv: ["echo", "cleaning"], resolution: "known_safe" },
      { source_position: 37, argv: ["rm", "-rf", "report.log"], resolution: "unresolved", decision: "allow_once" },
    ]);
    assert.equal(jqOutput(ran).decision, '{"decision":"approved","policy_result":"allow"}', "the decision value the audit recipe's log shows for an allowed action");
    assert.equal(stageEvidence(answer(startReview(RECIPE, "on-request", []), "abort")), null, "an aborted review has no evidence of a run");
    assert.equal(stageEvidence(startReview("ls && cat notes.txt", "on-request", [])), null, "nothing went to review");
  });

  it("prints one decision_applied line per answered stage", () => {
    const first = answer(startReview("ls && cat notes.txt", "untrusted", []), "allow_once");
    const both = answer(first, "allow_once");
    assert.equal(both.status, "ran");
    assert.equal(jqOutput(both).decision, ['{"decision":"approved","policy_result":"allow"}', '{"decision":"approved","policy_result":"allow"}'].join("\n"));
  });

  it("clears every stage on its own in on-request mode when nothing is dangerous", () => {
    const r = startReview("ls && cat notes.txt | grep TODO", "on-request", []);
    assert.equal(r.status, "ran");
    assert.equal(r.reviewed, false);
    assert.equal(intentFor(r)?.policy_decision, "allow:policy");
    const incomplete = startReview("FOO=1 make test", "on-request", []);
    assert.equal(incomplete.stages[0].resolution.kind, "policy_allow");
    assert.equal(incomplete.stages[0].resolution.sandboxed, true);
  });

  it("holds even ls in untrusted mode until a rule covers it", () => {
    const r = startReview("ls", "untrusted", []);
    assert.equal(r.stages[0].resolution.kind, "unresolved");
    const granted = answer(r, "allow_workspace");
    assert.equal(granted.status, "ran");
    assert.deepEqual(granted.rules.map((x) => [x.effect, x.prefix, x.origin]), [["allow", ["ls"], "granted"]]);
    assert.equal(startReview("ls -la", "untrusted", granted.rules).status, "ran", "the grant covers the ls prefix next time");
    assert.match(policyFile("/tmp/perm_run", granted.rules), /"argv_prefix": \[\n\s+"ls"\n\s+\]/);
  });

  it("lets a workspace grant clear a later stage it covers", () => {
    const r = startReview("cargo test && cargo test --release", "untrusted", []);
    assert.equal(r.blocking, 0);
    const after = answer(r, "allow_workspace");
    assert.equal(after.status, "ran");
    assert.equal(after.stages[1].resolution.kind, "policy_allow");
  });

  it("applies rule precedence: deny over prompt over allow, whatever the specificity", () => {
    const rules = (...r: Array<[Rule["effect"], string]>): Rule[] => r.map(([effect, p]) => ({ effect, prefix: p.split(" "), origin: "preset" }));
    const denied = startReview("rm -rf build", "on-request", rules(["allow", "rm -rf"], ["deny", "rm"]));
    assert.equal(denied.status, "denied");
    assert.match(toolOutcome(denied), /tool denied: policy/);
    const prompted = startReview("cargo publish", "on-request", rules(["allow", "cargo"], ["prompt", "cargo publish"]));
    assert.equal(prompted.stages[0].resolution.kind, "unresolved");
    const allowed = startReview("rm -rf build", "on-request", rules(["allow", "rm -rf"]));
    assert.equal(allowed.status, "ran", "a matching allow rule clears a dangerous stage");
    const deniedLater = startReview("ls && rm x", "on-request", rules(["deny", "rm"]));
    assert.equal(deniedLater.status, "denied", "a deny anywhere denies before anything is asked");
  });
});
