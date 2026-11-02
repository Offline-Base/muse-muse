import { WorkingIcon } from "@/components/chat/WorkingIcon";
import { Icon } from "@/components/icons";
import type { Checklist } from "@/lib/steps-feed/checklist";

/** BUILD_ROOM_STEPS: the big steps, ticking off as the run really reaches them (lib/steps-feed/checklist.ts). */
export function PlanChecklist({ list }: { list: Checklist }) {
  return (
    <section className="plan-checklist" aria-label={list.title}>
      <h2>{list.title}</h2>
      <ol>
        {list.items.map((item) => (
          <li key={item.id} data-state={item.state} aria-current={item.state === "running" ? "step" : undefined}>
            <span className="plan-checklist-mark" aria-hidden="true">
              {item.state === "done" ? <Icon name="check" size={14} /> : item.state === "running" ? <WorkingIcon size={20} /> : item.state === "bad" ? <Icon name="alert" size={16} /> : null}
            </span>
            <span>{item.label}</span>
            <span className="sr-only">{item.state === "done" ? " (done)" : item.state === "running" ? " (happening now)" : item.state === "bad" ? " (stopped here)" : " (not started)"}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
