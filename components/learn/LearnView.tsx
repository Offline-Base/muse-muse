import Link from "next/link";
import { Icon } from "@/components/icons";
import { OpenOnHash } from "@/components/learn/OpenOnHash";
import { RebuildButton } from "@/components/rebuilds/RebuildButton";
import { ExternalLink, ModelChips, NotConnected, PageHeader, StatusPill } from "@/components/ui";
import type { RebuildCardView } from "@/components/view-types";
import {
  KIND_LABEL,
  LESSON_SECTION_TITLE,
  LESSON_STATES,
  LESSON_STATE_LABEL,
  LESSON_STATE_TONE,
  lessonCounts,
  lessonState,
  longDate,
  showsProduct,
  type LessonState,
} from "@/lib/learn";
import { plural, shortDuration, usd } from "@/lib/format";
import type { RebuildsData } from "@/lib/queries";
import type { RebuildTarget } from "@/lib/types";

function buildMeta(c: RebuildCardView): string | null {
  if (!c.attempts) return null;
  return `${plural(c.attempts, "attempt")}, ${shortDuration(c.totalMs)} and ${usd(c.totalCostUsd)} est. in all`;
}

function Byline({ lesson }: { lesson: RebuildTarget }) {
  const parts = [
    lesson.presenter ?? "Presenter not named",
    lesson.date ? longDate(lesson.date) : null,
    lesson.firstPublished ? `first posted ${longDate(lesson.firstPublished)}` : null,
    lesson.event ?? null,
    lesson.length ?? null,
  ].filter(Boolean);
  return (
    <>
      <p className="muted small">{parts.join(" · ")}</p>
      {lesson.presenterNote ? <p className="muted small">{lesson.presenterNote}</p> : null}
    </>
  );
}

function LessonLinks({ lesson }: { lesson: RebuildTarget }) {
  const links = lesson.links ?? {};
  if (!links.video && !links.code && !links.course && !lesson.pageNote) return null;
  return (
    <div className="rcard-status small">
      {links.video ? <ExternalLink href={links.video}>Watch on YouTube</ExternalLink> : null}
      {links.code ? <ExternalLink href={links.code}>Meta&apos;s code</ExternalLink> : null}
      {links.course ? <ExternalLink href={links.course}>The course</ExternalLink> : null}
      {lesson.pageNote ? <span className="muted">{lesson.pageNote}</span> : null}
    </div>
  );
}

function Today({ lesson, card, state }: { lesson: RebuildTarget; card: RebuildCardView | undefined; state: LessonState }) {
  const product = card?.product ?? null;
  if (showsProduct(state) && product) {
    const meta = card ? buildMeta(card) : null;
    return (
      <>
        <div className="rcard-status">
          <StatusPill status={product.status} />
          {product.liveUrl ? <ExternalLink href={product.liveUrl}>Live</ExternalLink> : null}
          <Link href={`/p/${product.slug}`}>{product.name}</Link>
          {card?.latestBuild ? <Link href={`/b/${card.latestBuild.id}`}>Latest build</Link> : null}
        </div>
        <p className="small">
          {state === "partly" && lesson.current
            ? lesson.current.state
            : "Built from the plan below. Nobody has checked it against the lesson yet."}
        </p>
        {meta ? <p className="pcard-meta">{meta}</p> : null}
      </>
    );
  }
  if (state === "partly" && lesson.current) {
    // The rows couldn't be read, so this is the audit's record, with no product link or demo.
    return <p className="small">{lesson.current.state}</p>;
  }
  if (state === "redo") {
    return (
      <p className="small">
        {lesson.current?.state} It isn&apos;t shown here as the lesson&apos;s answer.
      </p>
    );
  }
  return <p className="small muted">Nothing built for this lesson yet.</p>;
}

function LessonCard({
  lesson,
  card,
  state,
  admin,
}: {
  lesson: RebuildTarget;
  card: RebuildCardView | undefined;
  state: LessonState;
  admin: boolean;
}) {
  const demo = showsProduct(state) ? card?.product?.demoVideoUrl : null;
  const plan = lesson.learn;
  return (
    <article className="pcard rcard" id={`lesson-${lesson.id}`} data-lesson={lesson.id} data-state={state}>
      {demo ? (
        <div className="pcard-media">
          <video
            src={demo}
            poster={card?.product?.demoPosterUrl ?? undefined}
            preload="metadata"
            controls
            muted
            playsInline
            aria-label={`Demo of Muse Muse's version of ${lesson.title}`}
          />
        </div>
      ) : null}
      <div className="pcard-body">
        <div className="pills">
          <span className={`pill pill-${LESSON_STATE_TONE[state]}`}>{LESSON_STATE_LABEL[state]}</span>
          {lesson.kind ? <span className="pill pill-neutral">{KIND_LABEL[lesson.kind]}</span> : null}
          <span className="pill pill-neutral">{lesson.era}</span>
        </div>
        <h3 className="rcard-title">
          <ExternalLink href={lesson.url}>{lesson.title}</ExternalLink>
        </h3>
        <Byline lesson={lesson} />
        <LessonLinks lesson={lesson} />
        <p className="small">
          <strong>What it teaches.</strong> {lesson.teaches ?? lesson.demonstrates}
        </p>
        <div>
          <p className="small">
            <strong>Muse Muse today.</strong>
          </p>
          <Today lesson={lesson} card={card} state={state} />
        </div>
        {plan ? (
          // The plan is a next step, not something that ran, so it waits behind its own fold.
          <details className="fold lesson-plan">
            <summary>The plan to redo it</summary>
            <p className="small">
              <span className="pill pill-building">Planned</span> <strong>{plan.title}.</strong> {plan.plan}
            </p>
            <ModelChips models={plan.models} label="Models in the plan" />
            <p className="pcard-meta">{plan.tune ? `Tune: ${plan.tune}.` : "No fine-tune: the lesson has none."}</p>
            <p className="pcard-meta">
              Estimated cost to redo: {plan.estimate}.{admin ? " Nothing is spent until the owner says so." : ""}
            </p>
            {plan.unverified?.length ? <p className="pcard-meta">Not checked yet: {plan.unverified.join("; ")}.</p> : null}
          </details>
        ) : null}
        {admin ? (
          <RebuildButton
            ids={[lesson.id]}
            text={card?.attempts ? "Build its product again" : "Build its product"}
            confirm={`Start a product build for "${lesson.title}"? It spends model credits${plan ? ` (plan estimate: ${plan.estimate})` : ""}. Any tune in the plan runs separately in the fine-tuning lab.`}
          />
        ) : null}
      </div>
    </article>
  );
}

function FirstDemoCard({ c, admin }: { c: RebuildsData["missing"][number]; admin: boolean }) {
  const shipped = c.product && (c.product.status === "live" || c.product.status === "partial");
  const meta = buildMeta(c);
  return (
    <article className="pcard rcard">
      <div className="pcard-media">
        {c.product?.demoVideoUrl ? (
          <video
            src={c.product.demoVideoUrl}
            poster={c.product.demoPosterUrl ?? undefined}
            preload="metadata"
            controls
            muted
            playsInline
            aria-label={`Demo of ${c.title}`}
          />
        ) : (
          <div className="pcard-placeholder" aria-hidden>
            <Icon name="sparkle" size={28} />
            <span>{shipped ? "Demo coming" : "Not built yet"}</span>
          </div>
        )}
      </div>
      <div className="pcard-body">
        <div className="pills">
          <span className="pill pill-building">First demo</span>
        </div>
        <h3 className="rcard-title">{c.title}</h3>
        <p className="muted small">{c.demonstrates}</p>
        <ModelChips models={c.models} />
        <div className="rcard-status">
          {c.product ? (
            <>
              <StatusPill status={c.product.status} />
              {shipped && c.product.liveUrl ? <ExternalLink href={c.product.liveUrl}>Live</ExternalLink> : null}
              <Link href={`/p/${c.product.slug}`}>{c.product.name}</Link>
            </>
          ) : c.latestBuild ? (
            <>
              <StatusPill status={c.latestBuild.status} />
              <Link href={`/b/${c.latestBuild.id}`}>Build room</Link>
            </>
          ) : (
            <span className="muted small">Not built yet</span>
          )}
        </div>
        {meta ? <p className="pcard-meta">{meta}</p> : null}
        {admin ? <RebuildButton ids={[c.id]} text={c.attempts ? "Build again" : "Build"} /> : null}
      </div>
    </article>
  );
}

export interface LearnViewProps {
  lessons: RebuildTarget[];
  data: RebuildsData;
  /** False when the build and product rows couldn't be read; the lessons still show, without products. */
  connected: { ok: true } | { ok: false; reason: Parameters<typeof NotConnected>[0]["reason"] };
  admin: boolean;
  source: string;
  checkedOn: string;
}

export function LearnView({ lessons, data, connected, admin, source, checkedOn }: LearnViewProps) {
  const cards = new Map(data.videos.map((c) => [c.id, c] as const));
  const rows = lessons.map((lesson) => {
    const card = cards.get(lesson.id);
    return { lesson, card, state: lessonState(lesson, card, connected.ok) };
  });
  const counts = lessonCounts(rows.map((r) => r.state));
  const t = data.totals;
  const countLine = LESSON_STATES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${LESSON_SECTION_TITLE[s].toLowerCase()}`)
    .join(", ");

  return (
    <div className="page">
      <PageHeader
        title="Learn from Meta's lessons"
        subtitle={
          <>
            Every lesson on <ExternalLink href={source}>Meta&apos;s Videos page</ExternalLink>: what it teaches, what
            Muse Muse has built for it today, and a plan to do it better on current Muse models. Checked{" "}
            {longDate(checkedOn)}. Lessons link to Meta&apos;s pages and never copy them.
          </>
        }
      />

      {!connected.ok ? <NotConnected reason={connected.reason} what="the builds for these lessons" /> : null}

      <section className="card totals" aria-label="Where the lessons stand">
        <p className="totals-big">
          <strong>{plural(lessons.length, "lesson")}</strong>: {countLine}
        </p>
        <p className="muted small">
          No version teaches its lesson fully yet. Plans are marked planned until they run, and costs are estimates.
          {connected.ok && t.totalCostUsd
            ? ` Builds so far took ${shortDuration(t.totalMs)} for ${usd(t.totalCostUsd)} est., counting every attempt and fix round.`
            : ""}
        </p>
      </section>

      {LESSON_STATES.map((state) => {
        const group = rows.filter((r) => r.state === state);
        if (!group.length) return null;
        const head = <h2 id={`learn-${state}`}>{LESSON_SECTION_TITLE[state]}</h2>;
        const cards = (
          <div className="grid-cards">
            {group.map((r) => (
              <LessonCard key={r.lesson.id} lesson={r.lesson} card={r.card} state={r.state} admin={admin} />
            ))}
          </div>
        );
        return (
          <section key={state} aria-labelledby={`learn-${state}`} className="section">
            {state === "not-built" ? (
              // Lessons with nothing built yet are plans only: folded, so what has been built comes first.
              <details className="section-fold">
                <summary className="section-head">
                  {head}
                  <span className="section-fold-show">Show {plural(group.length, "lesson")}</span>
                  <span className="section-fold-hide">Hide</span>
                </summary>
                {cards}
                <OpenOnHash />
              </details>
            ) : (
              <>
                <div className="section-head">{head}</div>
                {cards}
              </>
            )}
          </section>
        );
      })}

      <section aria-labelledby="missing-title" className="section">
        <div className="section-head">
          <h2 id="missing-title">Demos Meta doesn&apos;t have yet</h2>
        </div>
        <p className="muted">
          None of Meta&apos;s videos shows SAM 3.1, Muse Image or Voice Transcribe, and Muse Wonder has only a short clip
          on Meta&apos;s home page. These are first demos for each.
        </p>
        <div className="grid-cards">
          {data.missing.map((c) => (
            <FirstDemoCard key={c.id} c={c} admin={admin} />
          ))}
        </div>
      </section>
    </div>
  );
}
