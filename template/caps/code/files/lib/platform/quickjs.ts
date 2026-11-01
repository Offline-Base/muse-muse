// Platform file (Muse Muse platform services). Don't edit: call runJavaScript from client components.
//
// JavaScript in the visitor's browser, in QuickJS: its own small engine, compiled to WebAssembly and bundled with the
// product. The program sees no page, no network, no fetch and no timers: only console.log, console.error and INPUT (stdin
// as text). It gets 64 MB of memory and stops after 3 seconds by default.
//   const run = await runJavaScript(code, { stdin });
//   <CodeOutput run={run} />
import variant from "@jitl/quickjs-singlefile-browser-release-sync";
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core";
import { appendCapped, noteRun, type CodeRun } from "@/lib/platform/code-run";

export interface JavaScriptOptions {
  /** The program reads it as INPUT. */
  stdin?: string;
  /** 3 seconds by default, 10 at most. */
  timeoutMs?: number;
  /** 64 by default, 256 at most. */
  memoryMb?: number;
}

let engine: Promise<QuickJSWASMModule> | null = null;

/** The engine, loaded once. Tests pass their own. */
export function quickJS(): Promise<QuickJSWASMModule> {
  return (engine ??= newQuickJSWASMModuleFromVariant(variant));
}

/** A value as console.log prints it: text as it is, everything else as JSON. */
export function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorText(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const e = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const head = `${typeof e.name === "string" ? e.name : "Error"}: ${typeof e.message === "string" ? e.message : printable(dumped)}`;
    return typeof e.stack === "string" && e.stack.trim() ? `${head}\n${e.stack.trim()}` : head;
  }
  return printable(dumped);
}

/** Runs a JavaScript program in its own engine. Never throws for the program's own errors: they come back in stderr. */
export async function runJavaScript(code: string, opts: JavaScriptOptions = {}, module?: QuickJSWASMModule): Promise<CodeRun> {
  const QuickJS = module ?? (await quickJS());
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 3_000, 100), 10_000);
  const memoryMb = Math.min(Math.max(opts.memoryMb ?? 64, 8), 256);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm: QuickJSContext = runtime.newContext();
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const writer = (to: "out" | "err") => (...args: QuickJSHandle[]) => {
    const line = `${args.map((a) => printable(vm.dump(a))).join(" ")}\n`;
    const next = appendCapped(to === "out" ? stdout : stderr, line);
    if (to === "out") stdout = next.text;
    else stderr = next.text;
    truncated ||= next.cut;
  };
  const started = performance.now();
  let status: CodeRun["status"] = "ok";
  try {
    const consoleObject = vm.newObject();
    for (const [name, to] of [["log", "out"], ["info", "out"], ["debug", "out"], ["warn", "err"], ["error", "err"]] as const) {
      const fn = vm.newFunction(name, writer(to));
      vm.setProp(consoleObject, name, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, "console", consoleObject);
    consoleObject.dispose();
    const input = vm.newString(opts.stdin ?? "");
    vm.setProp(vm.global, "INPUT", input);
    input.dispose();

    const result = vm.evalCode(code, "main.js");
    if (result.error) {
      const dumped = vm.dump(result.error);
      result.error.dispose();
      status = Date.now() >= deadline ? "timeout" : "error";
      stderr = appendCapped(stderr, status === "timeout" ? `The program was stopped after ${timeoutMs / 1000} seconds.\n` : `${errorText(dumped)}\n`).text;
    } else {
      result.value.dispose();
      // Promise callbacks the program queued run now, within the same deadline.
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const dumped = vm.dump(jobs.error);
        jobs.error.dispose();
        status = Date.now() >= deadline ? "timeout" : "error";
        stderr = appendCapped(stderr, `${errorText(dumped)}\n`).text;
      }
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  const run: CodeRun = { runtime: "quickjs", status, stdout, stderr, truncated, ms: Math.round(performance.now() - started) };
  noteRun(run);
  return run;
}
