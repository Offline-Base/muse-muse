"use client";

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { Icon } from "@/components/Icon";
import { glassesMessage, listenSeconds, type GlassesPhoto, type GlassesRecording, type UseGlasses } from "@/lib/glasses/client";

/** A press shorter than this is a tap: it keeps listening until the next tap. */
const TAP_MS = 350;

type Phase = "idle" | "held" | "tapped" | "asking";

/**
 * The product's main button. Hold it and ask out loud, then let go: it takes a photo with the current source and
 * calls onAsk with the photo and the recording. A tap or a key press also works, for anyone who can't hold a button:
 * it listens until the next one. It stops listening by itself after maxSeconds, 60 at the most. Tests hold it with
 * click({ delay: 1500 }). The iPhone app's checks find it by data-glasses-primary and click it twice, as two taps.
 */
export function HoldToAsk(props: {
  glasses: UseGlasses;
  onAsk: (ask: { photo: GlassesPhoto; question: GlassesRecording }) => void | Promise<void>;
  label?: string;
  /** What the button says while onAsk runs. It ends in "…" like every busy button. */
  working?: string;
  maxSeconds?: number;
  disabled?: boolean;
}) {
  const { glasses, label = "Hold to ask", working = "Thinking…" } = props;
  const maxSeconds = listenSeconds(props.maxSeconds);
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef<Promise<void> | null>(null);
  const heldAt = useRef(0);
  const pressWasTap = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  // Gone mid-question, with useGlasses still in the parent: nothing else would ever end this recording. If useGlasses
  // is gone too, it has already ended it, and stop() just says nothing is listening.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      const listening = started.current;
      if (!listening) return;
      started.current = null;
      void listening.then(() => latest.current.glasses.stop()).catch(() => {});
    },
    [],
  );

  const finish = async () => {
    const listening = started.current;
    if (!listening) return;
    started.current = null;
    if (timer.current) clearTimeout(timer.current);
    setPhase("asking");
    try {
      await listening;
      const question = await glasses.stop();
      const photo = await glasses.capture();
      await latest.current.onAsk({ photo, question });
    } catch (err) {
      setProblem(glassesMessage(err));
    } finally {
      setPhase("idle");
    }
  };

  const begin = (next: Phase) => {
    setProblem(null);
    setPhase(next);
    const listening = glasses.listen({ maxSeconds });
    started.current = listening;
    timer.current = setTimeout(() => void finish(), maxSeconds * 1000);
    // No microphone, or no permission: say so now, not after they've finished talking.
    listening.catch((err: unknown) => {
      if (started.current !== listening) return;
      started.current = null;
      if (timer.current) clearTimeout(timer.current);
      setProblem(glassesMessage(err));
      setPhase("idle");
    });
  };

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressWasTap.current = phase === "tapped";
    if (phase !== "idle") return;
    heldAt.current = performance.now();
    begin("held");
  };

  const up = () => {
    if (pressWasTap.current) {
      pressWasTap.current = false;
      void finish();
    } else if (phase === "held") {
      if (performance.now() - heldAt.current < TAP_MS) setPhase("tapped");
      else void finish();
    }
  };

  // A real press is handled above, and its click has a detail of 1 or more. Keys and scripts click with a detail of 0.
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0) return;
    if (phase === "idle") begin("tapped");
    else if (phase === "tapped") void finish();
  };

  const asking = phase === "asking";
  const listening = phase === "held" || phase === "tapped";
  const blocked = !glasses.ready || !!props.disabled;
  const words = asking ? working : phase === "held" ? "Listening. Let go when you're done." : phase === "tapped" ? "Listening. Tap when you're done." : label;
  const hint = glasses.ready
    ? "Hold the button, ask your question, then let go."
    : glasses.source === "sample"
      ? "There's no sample to show here. Try this device's camera."
      : "Connect your glasses first.";

  return (
    <div className="field" data-glasses-ask>
      <button
        type="button"
        className="primary ai"
        data-glasses-primary
        data-glasses-action="ask"
        disabled={asking || (blocked && !listening)}
        aria-busy={asking}
        aria-pressed={listening}
        style={{ width: "100%", touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
        onPointerDown={down}
        onPointerUp={up}
        onPointerCancel={up}
        onContextMenu={(e) => e.preventDefault()}
        onClick={click}
      >
        <Icon name="mic" />
        {words}
      </button>
      <span className="hint" role="status">
        {hint}
      </span>
      {problem ? (
        <div className="error" role="alert">
          <Icon name="alert" /> {problem}
        </div>
      ) : null}
    </div>
  );
}
