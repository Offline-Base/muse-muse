"""Last local pass on the ccnews-select sets: em dashes out, then whole sentences off the end until the passage is
at most 210 words again (swapping an em dash for ', ' can split a joined word). Records left under 40 words go.

    python3 -I ccnews_finish.py IN.jsonl OUT.jsonl [OTHER_SET.jsonl]     (texts or URLs in OTHER_SET are dropped)
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ccnews_post as P  # noqa: E402
import news_common as C  # noqa: E402


def fit(text):
    paras = [C.sentences(p) for p in text.split("\n\n")]
    while sum(C.words(s) for p in paras for s in p) > C.MAX_WORDS:
        while paras and not paras[-1]:
            paras.pop()
        paras[-1].pop()
    out = "\n\n".join(" ".join(p) for p in paras if p)
    return out if C.words(out) >= C.MIN_WORDS else None


def main():
    src, dst = sys.argv[1:3]
    other = [json.loads(l) for l in open(sys.argv[3])] if len(sys.argv) > 3 else []
    seen_text, seen_url = {r["text"] for r in other}, {r["url"] for r in other}
    ai = "ai-meta" in os.path.basename(src)
    hits = None
    if ai:
        from ccnews_select import ai_hits as hits
    kept = trimmed = dropped = 0
    reasons = {}
    with open(dst, "w") as f:
        for line in open(src):
            r = json.loads(line)
            r["title"], text = C.no_em_dash(r["title"]), C.no_em_dash(r["text"]).replace("—", ", ")
            new = fit(text)
            if new is None or new in seen_text or r["url"] in seen_url:
                dropped += 1
                continue
            why = P.post_drop({"domain": r["source"].split(" via ")[0], "title": r["title"], "text": new}, ai, hits)
            if why:
                reasons[why] = reasons.get(why, 0) + 1
                dropped += 1
                continue
            trimmed += new != text
            r["text"] = re.sub(r"[ \t]+", " ", new).strip()
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            kept += 1
    print(os.path.basename(dst), "kept", kept, "trimmed", trimmed, "dropped", dropped, reasons)


if __name__ == "__main__":
    main()
