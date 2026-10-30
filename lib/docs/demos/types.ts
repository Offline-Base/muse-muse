import type { ComponentType } from "react";

/**
 * What a mirrored docs page adds on top of Meta's text: a live demo and the coding-agent prompt. One DemoSpec per page
 * slug, kept in the page group's file (lib/docs/demos/<group>.ts) and merged by lib/docs/demos/index.ts. The docs page
 * (app/docs/[...slug]/page.tsx) renders `<Component {...props} />` in its "Try it live" card, so `props` must be plain
 * JSON (it crosses from the server to a client component).
 */

/** The languages the copy-prompt menu offers. */
export type PromptLanguage = "python" | "typescript" | "curl";

export interface AgentPromptSpec {
  /**
   * What the coding agent should build, written to the agent in the imperative, specific to this page: "Add tool
   * calling to my app with the Responses API: define get_weather, run the call the model returns, send the result
   * back with previous_response_id, and print the final answer." No em dashes.
   */
  task: string;
  /** The facts the agent needs and might get wrong: endpoint, required fields, limits, model ids, gotchas. */
  facts?: string[];
  /** How the agent proves it works: commands to run, what the output should show. */
  checklist?: string[];
  /** Starter code per language, from the page's own examples. The prompt includes the one for the chosen language. */
  snippets?: Partial<Record<PromptLanguage, string>>;
}

export interface DemoSpec<P extends object = Record<string, unknown>> {
  /** The "Try it live" card's title, such as "Call a tool and send back the result". */
  title: string;
  /** One sentence under the title: what happens when you press Run. Mention the cost when it's above a cent. */
  blurb?: string;
  /** A client component ("use client") from components/docs/. It gets `props` plus the page slug. */
  Component: ComponentType<P & { slug: string }>;
  props: P;
  agentPrompt: AgentPromptSpec;
}

export type DemoMap = Record<string, DemoSpec<any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
