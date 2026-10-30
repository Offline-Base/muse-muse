"use client";

import { useState } from "react";
import { PresetPills } from "@/components/docs/kit/Field";
import { ToolLoopPlayground } from "@/components/docs/playgrounds/common/ToolLoopPlayground";
import type { Effort } from "@/lib/docs/client/models";
import type { LoopProtocol } from "@/lib/docs/client/toolloop";
import type { ToolSpec } from "@/lib/docs/client/tools";
import { DemoTabs } from "@/components/docs/playgrounds/text/parts";
import { RuleChecks } from "@/components/docs/playgrounds/text/RuleChecks";
import type { RuleCheck } from "@/components/docs/playgrounds/text/rules";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * The tool calling page's demo: the kit's ToolLoopPlayground (call, run the tool here, send the result back, final
 * answer; Responses or Chat Completions), set up for one scenario at a time from the page (its get_weather example,
 * parallel calls, a chain of calls, a strict schema), plus the page's rules checked live (strict validation, function
 * names, tool_choice, call ids, custom tools). Switching scenarios starts the loop over with that scenario's tools.
 */

export interface ToolScenario {
  id: string;
  label: string;
  /** One line under the pills: what this scenario shows. */
  about: string;
  prompt: string;
  /** Built-in mock tools by name, or definitions (lib/docs/client/tools ToolSpec). */
  tools: Array<string | ToolSpec>;
  results?: Record<string, unknown>;
  parallel?: boolean;
  system?: string;
  protocols?: LoopProtocol[];
  /** Other prompts for the same tools. */
  presets?: Array<{ label: string; prompt: string }>;
}

export interface ToolCallingDemoProps {
  slug: string;
  scenarios: ToolScenario[];
  checks?: RuleCheck[];
  checksIntro?: string;
  /** Default ["responses", "chat"]. */
  protocols?: LoopProtocol[];
  model?: string;
  models?: string[];
  effort?: Effort | null;
  maxCalls?: number;
}

export function ToolCallingDemo(props: ToolCallingDemoProps) {
  const [index, setIndex] = useState(0);
  const scenario = props.scenarios[index] ?? props.scenarios[0];
  const protocols = scenario?.protocols ?? props.protocols ?? ["responses", "chat"];

  const loop = scenario ? (
    <div className={styles.stack}>
      {props.scenarios.length > 1 ? (
        <div className={styles.tight}>
          <PresetPills label="Scenario" presets={props.scenarios} active={index} onPick={setIndex} />
          <p className={styles.about} aria-live="polite">
            {scenario.about}
          </p>
        </div>
      ) : null}
      <ToolLoopPlayground
        key={scenario.id}
        slug={props.slug}
        prompt={scenario.prompt}
        tools={scenario.tools}
        results={scenario.results}
        protocols={protocols}
        protocol={protocols[0]}
        model={props.model}
        models={props.models}
        system={scenario.system}
        parallel={scenario.parallel ?? true}
        maxCalls={props.maxCalls}
        effort={props.effort}
        presets={scenario.presets}
      />
    </div>
  ) : null;

  if (!props.checks?.length) return loop;
  return (
    <DemoTabs
      label="Tool calling demo"
      tabs={[
        { id: "loop", label: "Run the loop", content: loop },
        { id: "rules", label: "Check the rules", count: props.checks.length, content: <RuleChecks slug={props.slug} checks={props.checks} intro={props.checksIntro} models={props.models} /> },
      ]}
    />
  );
}
