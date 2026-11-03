import { PRIVATE_DETAIL } from "@/lib/private/replay";

const PROTECTS: string[] = [
  "The documents themselves: essays, records and scans. They stay in a folder on your device.",
  "Names and identifiers: names, phone numbers, emails, ids, addresses, dates of birth, Social Security and card numbers. They become tags before anything can leave.",
  "Sensitive topics, such as IEP or 504 status, health, discipline or custody. They wait for your OK, or stay on the device if you said never share.",
  "The list of who each tag is, and finished files with real names. Both are written only on your device.",
];

const FROM_WHOM: { who: string; how: string }[] = [
  { who: "A Muse that gets too curious, or is compromised", how: "The main case: it has every tool and can word things any way it likes, and should still get only tags. Tested with hand-written attacks, and a few known gaps are still open." },
  { who: "A document with planted instructions", how: "Text in an essay that orders a top grade or the class list gets neither, in those tests." },
  { who: "The relay in the middle", how: "It sees what Muse sees, tagged results, and stores no content. It is not end-to-end encrypted." },
  { who: "A stolen laptop or a curious person at home", how: "Only partly. Files are private to your account, but nothing here adds encryption beyond your disk's own." },
];

const NOT_FROM: string[] = [
  "Malware on your device, or an attacker who already controls it.",
  "What you type into Muse. It reaches Meta before the device sees it, and a typed card number can't be taken back.",
  "A summary that points at someone without naming them, or someone who matches tags to facts they already know.",
];

/** Opens /private: what, from whom, before and after. The example is invented and labeled that way. */
export function PrivateStory() {
  return (
    <>
      <p className="pv-lead">Let Muse do the tedious work on private files without giving it the files.</p>

      <h2 className="how-heading">Before and after</h2>
      <div className="pv-compare">
        <div className="pv-compare-card">
          <h3 className="how-title">Before: a normal connector</h3>
          <p className="muted">You ask Muse to grade essays. It reads the files, and they land in its cloud computer, names and all.</p>
          <pre>{`Dana Whitfield, ID 900142
"My grandmother moved in with us after..."`}</pre>
          <p className="muted">So work like this tends not to be handed over at all, where records have to stay with whoever holds them.</p>
        </div>
        <div className="pv-compare-card">
          <h3 className="how-title">After: Muse Privacy</h3>
          <p className="muted">Muse plans the job. A separate reader model reads and grades the essays (in this demo, Muse Glimmer 30B in the cloud, on invented essays), and Muse gets only what your rules let out.</p>
          <pre>{`[Student A] scored 3 of 4 on evidence.
Feedback saved on your device.`}</pre>
          <p className="muted">The feedback files with real names stay with you. Muse never needs to know who [Student A] is.</p>
        </div>
      </div>
      <p className="muted">The name and text here are made up to show the shape of it. They aren&apos;t a recorded output: the recorded run is below.</p>

      <h2 className="how-heading">What it protects</h2>
      <ul className="pv-list">
        {PROTECTS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <h2 className="how-heading">From whom</h2>
      <dl className="pv-who">
        {FROM_WHOM.map((row) => (
          <div key={row.who}>
            <dt>{row.who}</dt>
            <dd>{row.how}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">It does not protect against:</p>
      <ul className="pv-list">
        {NOT_FROM.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/** Follows the tiles: the numbers that make the result look less tidy, and the one measured job. */
export function PrivateStoryNumbers() {
  const { asks, holdout, grading } = PRIVATE_DETAIL;
  return (
    <>
      <ul className="pv-list">
        <li>
          It asks too often: {asks.requests} approval requests on the {asks.items} items, {asks.needless} of them needless, and {asks.overRefusals} results refused that shouldn&apos;t have been. {asks.wholeSummaries} results meant to go out only as a summary went out whole, with names as tags.
        </li>
        <li>
          On the {holdout.items} holdout items inside the 100 tasks, it agreed {holdout.percent} of the time ({holdout.right} of {holdout.items}), with {holdout.leaks} leaks, on {holdout.date}.
        </li>
        <li>
          With Muse Glimmer 30B in the cloud, a script playing Muse had {grading.essays} invented essays graded in {grading.seconds} s on {grading.date}, and {grading.files} feedback files written on the laptop. That measures the path and the time, not how good the grades are.
        </li>
        <li>The attacks are hand-written with a faked model. They show what the code does with the attacks someone thought of, not what an adaptive attacker would find.</li>
      </ul>
    </>
  );
}

/** How it helps someone who came to Muse Muse, and that the two aren't wired together. */
export function PrivateStoryHelps() {
  return (
    <>
      <h2 className="how-heading">If you came here to build with Muse Muse</h2>
      <p className="muted">
        Muse Muse builds in the cloud, so it&apos;s the wrong place for a real class list or patient file: please use made-up data there. Say you build a grading helper with it. You test on invented essays, and when the
        real essays come, Muse Privacy is built so Muse can help with them while they stay on your laptop. That needs the reader model on the laptop too, which is the target and hasn&apos;t been measured: today&apos;s demo runs it in the cloud, on invented essays only.
      </p>
      <p className="muted">
        They sit side by side today. A product Muse Muse builds doesn&apos;t call Muse Privacy, and the two share no code. You use it from the Muse app, as a connector.
      </p>
    </>
  );
}
