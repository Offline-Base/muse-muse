/**
 * The mini agent loop's simulated shell, on commands Muse Spark actually sent in the loop through the docs proxy.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code/__tests__/sim-shell.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPO, runTests } from "@/components/docs/playgrounds/muse-code/agent-loop";
import { expandGlob, resolvePath, simShell } from "@/components/docs/playgrounds/muse-code/sim-shell";

const ctx = { original: REPO, runTests };
const sh = (command: string, files = REPO) => simShell(command, files, ctx);

describe("simulated shell", () => {
  it("runs the compound survey commands models open with", () => {
    const a = sh("ls -R | head -n 100; echo ---; cat package.json 2>/dev/null; cat README.md 2>/dev/null | head -n 100");
    assert.equal(a.isError, false);
    assert.match(a.output, /^README\.md\npackage\.json\nsrc\/server\.js\nsrc\/signup\.js\ntest\/signup\.test\.js\n---\n\{\n {2}"name": "signup-service"/);
    assert.match(a.output, /# signup-service/);
    const b = sh("ls -R src test && wc -l src/* test/*");
    assert.equal(b.isError, false, b.output);
    assert.match(b.output, /\d+ src\/server\.js\n\d+ src\/signup\.js\n\d+ test\/signup\.test\.js\n\d+ total$/);
  });

  it("pipes, chains and redirects like a shell", () => {
    assert.match(sh("npm test 2>&1 | head -n 30").output, /# fail 2/);
    assert.equal(sh("npm test").isError, true, "failing tests exit nonzero");
    assert.equal(sh("false && echo no || echo yes").output, "yes");
    assert.equal(sh("grep -rn signup src | wc -l").output, "5");
    const wrote = sh("echo hello > notes.txt; cat notes.txt");
    assert.equal(wrote.output, "hello");
    assert.equal(wrote.files["notes.txt"], "hello\n");
    assert.match(sh("echo x > /etc/passwd").output, /Read-only file system/);
    assert.equal(sh("cat < src/signup.js | head -1").output, "// Registers a user. Called by src/server.js for POST /signup.");
  });

  it("reads files the ways models ask", () => {
    assert.equal(sh("sed -n '2,3p' src/signup.js").output, "export function signup(body) {\n  const user = { email: body.email, password: body.password };");
    assert.equal(sh("tail -n 1 test/signup.test.js").output, "});");
    assert.match(sh("grep -n 'status' src/signup.js").output, /^4:\s+return \{ status: 201/);
    assert.equal(sh("grep -l 400 -r .").output, "test/signup.test.js");
    assert.match(sh("rg 'export function'").output, /^src\/signup\.js:2:export function signup/);
    assert.equal(sh("cd src && ls").output, "server.js\nsignup.js");
    assert.equal(sh("cd test && pwd").output, "/workspace/signup-service/test");
    assert.equal(sh("find . -name '*.test.js'").output, "./test/signup.test.js");
    assert.equal(sh("find src -type f").output, "src/server.js\nsrc/signup.js");
  });

  it("writes here-documents and tracks git status and diff", () => {
    const w = sh("cat > src/signup.js <<'JS'\nexport function signup() { return { status: 400 }; }\nJS");
    assert.equal(w.files["src/signup.js"], "export function signup() { return { status: 400 }; }\n");
    assert.equal(sh("git status", w.files).output, " M src/signup.js");
    assert.match(sh("git diff", w.files).output, /^diff --git a\/src\/signup\.js b\/src\/signup\.js[\s\S]*\+export function signup\(\) \{ return \{ status: 400 \}; \}/);
    assert.equal(sh("git status").output, "nothing to commit, working tree clean");
  });

  it("explains what it can't run", () => {
    assert.match(sh("rm -rf /").output, /rm: command not found\. This simulated workspace runs/);
    assert.match(sh("(cd src && ls)").output, /subshell/);
    assert.match(sh("grep nothing-matches-this src/signup.js").output, /exit status 1/);
    assert.match(sh("cat nope.js").output, /No such file or directory/);
    const quiet = sh("cat package.json > /dev/null; cat nope.js 2>/dev/null");
    assert.equal(quiet.output, "(no output, exit status 1)", "2>/dev/null drops the error text, not the exit status");
    assert.match(sh("npm test 2>/dev/null").output, /# fail 2/, "test output is stdout");
  });

  it("resolves paths and globs inside the repo", () => {
    assert.equal(resolvePath("./src/../test/x.js", ""), "test/x.js");
    assert.equal(resolvePath("/workspace/signup-service/src/a.js", "test"), "src/a.js");
    assert.equal(resolvePath("a.js", "src"), "src/a.js");
    assert.deepEqual(expandGlob("**/*.js", "", REPO), ["src/server.js", "src/signup.js", "test/signup.test.js"]);
    assert.deepEqual(expandGlob("*.md", "", REPO), ["README.md"]);
  });
});
