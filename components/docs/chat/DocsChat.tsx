"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ScrollButton } from "@/components/chat";
import { Reply, UserMessage } from "@/components/docs/chat/Message";
import { runTool, currentSlug, ToolError } from "@/components/docs/chat/tools";
import { performRun } from "@/components/docs/kit/useDocsRun";
import { Icon } from "@/components/icons";
import { VoiceInputButton } from "@/components/voice/VoiceInputButton";
import { ChatIcon, SparkIcon } from "@/components/docs/page/icons";
import {
  ASSISTANT_MAX_CHARS,
  ASSISTANT_MAX_TOOL_CALLS,
  chatStarters,
  clipResult,
  historyItems,
  messagesForStorage,
  noEmDashes,
  parseToolArgs,
  toolLabel,
  type ChatMessage,
  type ChatPart,
} from "@/lib/docs/client/assistant";
import { responsesCollector, type ToolCall } from "@/lib/docs/client/stream";

const OPEN_KEY = "docs:chat-open";
const MESSAGES_KEY = "docs:chat";
const SAVED_MESSAGES = 30;
/** The chat before anything is restored: saving skips it, so an empty first render can't wipe a saved conversation. */
const NOT_RESTORED: ChatMessage[] = [];

/**
 * The docs assistant: a sidebar on the right of every docs page that answers questions, opens pages and runs demos. It
 * lives in the docs layout, so the conversation carries across pages. Each question is a small loop in the browser:
 * send the conversation to /api/docs/assistant, run any tool the model asks for (components/docs/chat/tools), send the
 * result back, until the model answers in words. Every step shows in the chat, and Stop ends it. It wears the Muse
 * app's look (docs/UI_MUSE_APP.md): the reader's bubbles, the agent's steps (components/docs/chat/Message) and its box.
 */
export function DocsChat() {
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(NOT_RESTORED);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Scrolled up from the newest message: the scroll button shows.
  const [scrolledUp, setScrolledUp] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  // So one question's steps don't show the same picture twice. A new question can show it again.
  const shownImages = useRef(new Set<string>());
  const hasPage = /^\/docs\/.+/.test(pathname);

  useEffect(() => {
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === "1");
      const saved = window.sessionStorage.getItem(MESSAGES_KEY);
      if (saved) setMessages(JSON.parse(saved) as ChatMessage[]);
    } catch {
      // No storage, or something unreadable in it: start fresh.
    }
  }, []);

  const toggle = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      // No storage: it just won't carry over.
    }
  }, []);

  // The page and the demo panel make room for the sidebar in CSS (docs.css).
  useEffect(() => {
    if (open) document.documentElement.dataset.docsChat = "open";
    else delete document.documentElement.dataset.docsChat;
    return () => {
      delete document.documentElement.dataset.docsChat;
    };
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
    else if (document.activeElement === document.body) launcher.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setOpen((v) => {
          const next = !v;
          try {
            window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
          } catch {
            // As in toggle.
          }
          return next;
        });
      }
    };
    const onCommand = () => toggle(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("docs:open-assistant", onCommand);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("docs:open-assistant", onCommand);
    };
  }, [toggle]);

  useEffect(() => {
    if (running || messages === NOT_RESTORED) return;
    try {
      window.sessionStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesForStorage(messages, SAVED_MESSAGES)));
    } catch {
      // No storage: the chat lasts until the tab reloads.
    }
  }, [messages, running]);

  useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, error]);

  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (question: string) => {
    const text = question.trim().slice(0, ASSISTANT_MAX_CHARS);
    if (!text || running) return;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setError(null);
    setDraft("");
    pinned.current = true;
    setScrolledUp(false);
    shownImages.current.clear();

    const parts: ChatPart[] = [];
    const before = messages;
    const show = () => setMessages([...before, { role: "user", parts: [{ kind: "text", text }] }, { role: "assistant", parts: [...parts] }]);
    show();

    const items: unknown[] = [...historyItems(before), { role: "user", content: text }];
    try {
      for (let calls = 0; ; ) {
        const collector = responsesCollector();
        const start = parts.length;
        const outcome = await performRun(
          "",
          {
            base: "/api/docs/assistant",
            stream: true,
            record: false,
            body: { slug: currentSlug() ?? "overview", input: items },
            onEvent: (e) => {
              collector.push(e);
              const words = noEmDashes(collector.snapshot().text);
              if (!words) return;
              parts[start] = { kind: "text", text: words };
              show();
            },
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (outcome.error) {
          setError(outcome.error.message ?? "That didn't go through. Try again.");
          return;
        }
        const reply = collector.snapshot();
        if (reply.text) items.push({ role: "assistant", content: reply.text });
        const toolCalls: ToolCall[] = reply.toolCalls;
        // Words before a tool call only narrate the step the chat already shows.
        if (toolCalls.length && parts[start]?.kind === "text") parts.splice(start, 1);
        if (!toolCalls.length) {
          if (!reply.text) setError(reply.refusal || "The model didn't answer. Try asking another way.");
          return;
        }
        for (const call of toolCalls) {
          if (++calls > ASSISTANT_MAX_TOOL_CALLS) {
            setError("That took too many steps, so I stopped. Ask for something smaller.");
            return;
          }
          const args = parseToolArgs(call.arguments);
          const at = parts.length;
          parts[at] = { kind: "tool", name: call.name, label: toolLabel(call.name, args, true), state: "running" };
          show();
          items.push({ type: "function_call", call_id: call.callId, name: call.name, arguments: call.arguments || "{}" });
          let output: string;
          let failed = false;
          try {
            output = await runTool(call.name, args, {
              signal: controller.signal,
              navigate: (href) => router.push(href),
              showImages: (srcs) => {
                const fresh = srcs.filter((src) => !shownImages.current.has(src));
                if (!fresh.length) return;
                fresh.forEach((src) => shownImages.current.add(src));
                parts.push({ kind: "images", srcs: fresh });
                show();
              },
            });
          } catch (err) {
            failed = true;
            output = err instanceof ToolError || err instanceof Error ? err.message : "That didn't work.";
          }
          if (controller.signal.aborted) return;
          parts[at] = { kind: "tool", name: call.name, label: toolLabel(call.name, args, false), state: failed ? "failed" : "done", ...(failed ? { detail: output } : {}) };
          show();
          items.push({ type: "function_call_output", call_id: call.callId, output: clipResult(output) });
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      // A step cut short by Stop reads as stopped, not as still going.
      for (const [i, p] of parts.entries()) if (p.kind === "tool" && p.state === "running") parts[i] = { ...p, state: "failed", detail: "Stopped." };
      show();
      setRunning(false);
      abort.current = null;
    }
  };

  const clear = () => {
    abort.current?.abort();
    setMessages([]);
    setError(null);
    pinned.current = true;
    setScrolledUp(false);
    input.current?.focus();
  };

  // Straight to the newest message (nothing in this look slides), then back to the box to type.
  const toNewest = () => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setScrolledUp(false);
    input.current?.focus({ preventScroll: true });
  };

  return (
    <>
      {open ? null : (
        <button ref={launcher} type="button" className="docs-chat-launcher" onClick={() => toggle(true)} aria-keyshortcuts="Meta+I Control+I">
          <SparkIcon size={16} />
          <span>Ask AI</span>
        </button>
      )}
      <aside className="docs-chat" hidden={!open} aria-labelledby={`${id}-title`}>
        <div className="docs-chat-head">
          <h2 id={`${id}-title`}>
            <SparkIcon size={17} />
            Docs assistant
          </h2>
          {messages.length ? (
            <button type="button" className="docs-chat-new" onClick={clear}>
              New chat
            </button>
          ) : null}
          <button type="button" className="icon-btn icon-btn-plain" aria-label="Close the docs assistant" onClick={() => toggle(false)}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div
          ref={log}
          className="docs-chat-log"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            setScrolledUp(!pinned.current);
          }}
        >
          {messages.length ? (
            <ol className="docs-chat-list" aria-label="Conversation" aria-live="polite" aria-busy={running}>
              {messages.map((m, i) => (
                <li key={i} className={m.role === "user" ? "docs-chat-user" : "docs-chat-reply"}>
                  {m.role === "user" ? <UserMessage parts={m.parts} /> : <Reply parts={m.parts} live={running && i === messages.length - 1} />}
                </li>
              ))}
            </ol>
          ) : (
            <div className="docs-chat-empty">
              <ChatIcon size={22} />
              <p>Ask about the API. I can also open pages, run demos and start a build for you.</p>
              <ul>
                {chatStarters(hasPage).map((s) => (
                  <li key={s}>
                    <button type="button" className="docs-chat-starter" onClick={() => void ask(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error ? (
            <p className="docs-chat-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {scrolledUp && messages.length ? (
          <div className="docs-chat-jump">
            <ScrollButton onClick={toNewest} />
          </div>
        ) : null}
        <form
          className="composer docs-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(draft);
          }}
        >
          <label htmlFor={`${id}-input`} className="sr-only">
            Ask the docs assistant
          </label>
          <textarea
            id={`${id}-input`}
            ref={input}
            className="composer-input"
            data-voice="inline"
            rows={2}
            maxLength={ASSISTANT_MAX_CHARS}
            value={draft}
            placeholder="Ask, or say what to open or run"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                toggle(false);
                return;
              }
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void ask(draft);
            }}
          />
          <div className="composer-row">
            <div className="composer-actions">
              <VoiceInputButton target={() => input.current} className="composer-voice" size={22} />
              {running ? (
                <button type="button" className="send-btn" aria-label="Stop" onClick={() => abort.current?.abort()}>
                  <span className="docs-chat-stop" aria-hidden />
                </button>
              ) : (
                <button type="submit" className="send-btn" aria-label="Send" disabled={!draft.trim()}>
                  <Icon name="arrowUp" size={24} />
                </button>
              )}
            </div>
          </div>
        </form>
      </aside>
    </>
  );
}
