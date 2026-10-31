"""Picks the final news records from the candidates read_set.py wrote: month targets, 80% English, at most 5 per site,
no duplicates, and a robots.txt check once per domain (the logic in scripts/knowledge/aws/box/ccnews_optout.py).

    python -I select_news.py CAND_DIR WORK_DIR OUT_DIR
"""

import collections
import concurrent.futures
import hashlib
import json
import os
import random
import re
import socket
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "aws", "box"))

import ccnews_optout as optout  # noqa: E402

import news_common as C  # noqa: E402

SEED = 20261030
CAP = 5
OVERSHOOT = 1.5
THREADS = 80
PRESWEEP = 2.0
CHECK_AGENTS = optout.AGENTS

MONTHS_10 = [f"2026-{m:02d}" for m in range(1, 11)]


def even(months, total):
    base, extra = divmod(total, len(months))
    return {m: base + (1 if i < extra else 0) for i, m in enumerate(months)}


CC = even(MONTHS_10[:8], 1100)
CC.update({"2026-09": 550, "2026-10": 550})
# Sets with the fewest sites go first, so the shared per-site cap doesn't starve them.
PLAN = {
    # 250 was asked for, but only about 20 of its sites pass robots.txt, so the 5-per-site cap allows about 100: spread them evenly.
    "forecast": ("forecast-news", even(MONTHS_10[:8], 104)),
    "fine": ("fine-news", even(MONTHS_10[:4], 250)),
    "plus": ("ccnews-plus", even(MONTHS_10[:8], 250)),
    "infini": ("infini-news", even(MONTHS_10[:4], 300)),
    "ccnews": ("ccnews", CC),
}
SOURCE = {"forecast": "forecast-news", "fine": "Fine-News", "plus": "CCNews-Plus", "infini": "Infini-News", "ccnews": "CC-NEWS"}
LICENSE = {
    "ccnews": "Article text under each publisher's copyright, extracted from Common Crawl CC-NEWS; Common Crawl terms of use apply. Private, training only.",
    "infini": "Article text under each publisher's copyright, via Infini-News v2, whose terms restrict bulk article text to academic research; only its derived metadata is CC BY 4.0. Private, training only.",
    "fine": "No dataset license for the text: article text under each publisher's copyright, via Fine-News, which inherits Infini-News terms restricting bulk article text to academic research. Private, training only.",
    "plus": "No license stated by CCNews-Plus; article text under each publisher's copyright. Private, training only.",
    "forecast": "Dataset tagged Apache-2.0, but article text belongs to each publisher. Private, training only.",
}


def site_of(domain):
    return optout.parent(domain)


def compile_rules(robots_txt):
    """Per agent, the (length, allow, regex) rules that apply, so each domain's robots.txt is parsed once."""
    groups, _ = optout.parse_robots(robots_txt or "")
    out = []
    for agent in CHECK_AGENTS:
        name = agent.lower()
        rules = [r for a, rs in groups if name in a for r in rs] or [r for a, rs in groups if "*" in a for r in rs]
        compiled = []
        for kind, value in rules:
            if not value:
                continue
            pattern = re.escape(value).replace(r"\*", ".*")
            if pattern.endswith(r"\$"):
                pattern = pattern[:-2] + "$"
            try:
                compiled.append((len(value), kind == "allow", re.compile(pattern)))
            except re.error:
                continue
        out.append(compiled)
    return out


def path_blocked(compiled, path):
    """Longest-match test (RFC 9309) of this article's path, for every AI agent, on a site with a partial block."""
    for rules in compiled:
        best, allow = -1, True
        for length, is_allow, rx in rules:
            if (length > best or (length == best and is_allow)) and rx.match(path):
                best, allow = length, is_allow
        if not allow:
            return True
    return False


class Robots:
    def __init__(self, cache_path):
        self.path, self.rows, self.compiled = cache_path, {}, {}
        if os.path.exists(cache_path):
            for line in open(cache_path):
                r = json.loads(line)
                self.rows[r["domain"]] = r

    def check(self, domains):
        todo = [d for d in sorted(set(domains)) if d not in self.rows]
        if not todo:
            return
        by_parent = collections.defaultdict(list)
        for d in todo:
            by_parent[site_of(d)].append(d)  # one connection per host: a parent's domains run in turn

        def work(group):
            return [optout.check(d, 0) for d in group]

        print("robots: checking", len(todo), "domains", flush=True)
        with concurrent.futures.ThreadPoolExecutor(THREADS) as pool, open(self.path, "a") as f:
            for rows in pool.map(work, by_parent.values()):
                for r in rows:
                    self.rows[r["domain"]] = r
                    f.write(json.dumps(r) + "\n")
                f.flush()
        print("robots: cache", len(self.rows), "excluded", sum(r["excluded"] for r in self.rows.values()), flush=True)

    def ok(self, cand):
        r = self.rows[cand["domain"]]
        if r["excluded"]:
            return False
        d = cand["domain"]
        if d not in self.compiled:
            self.compiled[d] = compile_rules(r.get("robots_txt"))
        return not path_blocked(self.compiled[d], urllib.parse.urlsplit(cand["url"]).path or "/")


def dedupe_key(c):
    return hashlib.sha1(re.sub(r"\W+", " ", c["text"].lower())[:400].encode()).hexdigest()


def title_key(c):
    return re.sub(r"\W+", " ", c["title"].lower()).strip()


def presweep(cand_dir, robots):
    """One big robots.txt pass over the domains the selection is most likely to want, so the loop rarely has to wait."""
    rng = random.Random(SEED + 1)
    seen, domains = collections.Counter(), []
    for name, (_, targets) in PLAN.items():
        by = collections.defaultdict(list)
        for line in open(f"{cand_dir}/{name}.jsonl"):
            r = json.loads(line)
            if C.late_ok(r):
                by[r["date"][:7]].append({"url": r["url"], "domain": r["domain"]})
        for month, need in targets.items():
            pool = sorted(by[month], key=lambda r: r["url"])
            rng.shuffle(pool)
            got = 0
            for c in pool:
                if got >= need * PRESWEEP:
                    break
                s = site_of(c["domain"])
                if seen[s] >= CAP:
                    continue
                seen[s] += 1
                got += 1
                domains.append(c["domain"])
    robots.check(domains)


def main():
    cand_dir, work_dir, out_dir = sys.argv[1:4]
    os.makedirs(work_dir, exist_ok=True)
    socket.setdefaulttimeout(optout.TIMEOUT)
    rng = random.Random(SEED)
    optout.TIMEOUT, optout.READ_SECONDS = 6, 6
    robots = Robots(f"{work_dir}/robots.jsonl")
    presweep(cand_dir, robots)
    sites, urls, texts, titles = collections.Counter(), set(), set(), set()
    report = {}
    final = {}
    for name, (label, targets) in PLAN.items():
        rows = [json.loads(l) for l in open(f"{cand_dir}/{name}.jsonl")]
        before = len(rows)
        rows = [r for r in rows if C.late_ok(r)]
        print(name, "late filter kept", len(rows), "of", before, flush=True)
        by = collections.defaultdict(lambda: collections.defaultdict(list))
        for r in rows:
            by[r["date"][:7]]["en" if r["language"] == "en" else "other"].append(r)
        chosen = []
        dropped_robots_rows = 0
        print(name, "selecting", flush=True)
        for month in sorted(targets):
            need = targets[month]
            for bucket in ("other", "en"):
                pool = sorted(by[month][bucket], key=lambda r: r["url"])
                rng.shuffle(pool)
                # Domains already checked first: a late batch of unseen hosts waits on its slowest server.
                pool = [c for c in pool if c["domain"] in robots.rows] + [c for c in pool if c["domain"] not in robots.rows]
                # English takes the rest of the month's target, so a thin foreign bucket doesn't lose records.
                got_month = sum(1 for c in chosen if c["date"][:7] == month)
                want = (round(need * 0.2) if bucket == "other" else need - got_month)
                if name == "plus":
                    want = need if bucket == "en" else 0
                got = 0
                i = 0
                while got < want and i < len(pool):
                    # Take a batch that fits the caps, check any unseen domains, then accept what passes.
                    batch, seen_sites = [], collections.Counter()
                    size = max(40, int((want - got) * OVERSHOOT))
                    while len(batch) < size and i < len(pool):
                        c = pool[i]
                        i += 1
                        if c["url"] in urls or dedupe_key(c) in texts or title_key(c) in titles:
                            continue
                        s = site_of(c["domain"])
                        if sites[s] + seen_sites[s] >= CAP:
                            continue
                        if c["domain"] in robots.rows and not robots.ok(c):
                            dropped_robots_rows += 1
                            continue
                        batch.append(c)
                        seen_sites[s] += 1
                    robots.check(c["domain"] for c in batch)
                    for c in batch:
                        if got >= want:
                            break
                        s = site_of(c["domain"])
                        if not robots.ok(c):
                            dropped_robots_rows += 1
                            continue
                        if sites[s] >= CAP or c["url"] in urls or dedupe_key(c) in texts or title_key(c) in titles:
                            continue
                        sites[s] += 1
                        urls.add(c["url"])
                        texts.add(dedupe_key(c))
                        titles.add(title_key(c))
                        chosen.append(c)
                        got += 1
        final[name] = chosen
        report[name] = {"candidates": len(rows), "final": len(chosen), "target": 250 if name == "forecast" else sum(targets.values()), "rows_dropped_by_robots": dropped_robots_rows,
                        "by_month": dict(sorted(collections.Counter(c["date"][:7] for c in chosen).items())),
                        "languages": dict(collections.Counter(c["language"] for c in chosen).most_common()),
                        "domains": len({c["domain"] for c in chosen})}
        print(name, json.dumps(report[name]), flush=True)
    os.makedirs(out_dir, exist_ok=True)
    for name, chosen in final.items():
        with open(f"{out_dir}/s3-{PLAN[name][0]}.jsonl", "w") as f:
            for c in sorted(chosen, key=lambda r: (r["date"], r["url"])):
                f.write(json.dumps({"id": C.rec_id(f"s3-{PLAN[name][0]}", c["url"]), "source": f"{c['domain']} via {SOURCE[name]}", "title": C.no_em_dash(c["title"]), "url": c["url"], "date": c["date"],
                                    "license": LICENSE[name], "visibility": "private", "text": C.no_em_dash(c["text"])}, ensure_ascii=False) + "\n")
    excl = [r for r in robots.rows.values() if r["excluded"]]
    reasons = collections.Counter(x.split(":")[0] for r in excl for x in (r["excluded_reasons"] or "").split(","))
    used = {c["domain"] for chosen in final.values() for c in chosen}
    report["robots"] = {"domains_checked": len(robots.rows), "domains_excluded": len(excl), "reasons": dict(reasons), "final_domains": len(used), "final_domains_without_check": len(used - set(robots.rows))}
    json.dump(report, open(f"{work_dir}/report.json", "w"), indent=1)
    print(json.dumps(report["robots"]))


if __name__ == "__main__":
    main()
