#!/usr/bin/env python3
"""
A document-reading bench for the boards: invented receipt text to six JSON fields, scored by code with no judge model.

  python scripts/dev/receipt-bench.py make --out <dir>      writes train.jsonl (for train_model) and heldout.jsonl
  python scripts/dev/receipt-bench.py regex --heldout <f>   scores the regex baseline
  FLEET_TOKEN=... python scripts/dev/receipt-bench.py ask --heldout <f> --url <base> --board jetson-04 --out <f>

Everything is invented from a seed, with the right answers computed in code. Training uses three layouts, and the held-out set
uses two others plus scanner noise, so a tuned model is scored on receipts it never saw the shape of. Only for made-up data:
text sent with `ask` crosses ngrok and the lead board, so a real receipt doesn't belong here (lib/inference/reach.ts).
"""
import argparse
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal

FIELDS = ("merchant", "date", "subtotal", "tax", "total", "item_count")
SYSTEM = (
    "You read receipts. Answer with one JSON object and nothing else, with exactly these keys: merchant (string), "
    "date (YYYY-MM-DD), subtotal (number), tax (number), total (number), item_count (integer, the number of purchased lines)."
)
MERCHANTS = ["Juniper Pantry", "Harbor Lane Hardware", "Tin Roof Books", "Copperleaf Pharmacy", "Maple Row Grocers", "Northgate Cycle", "Blue Door Bakery", "Fennel & Sons", "Quarry Street Office Supply", "Saltmarsh Coffee", "Willow Bend Garden", "Atlas Pet Goods"]
ITEMS = ["Olive oil", "Masking tape", "AA batteries", "Notebook", "Oat milk", "Wood screws", "Sourdough", "Dish soap", "Bike chain", "Dog biscuits", "Tomato seeds", "Printer paper", "Bandages", "Coffee beans", "Paint roller", "Rice 2kg", "Hand cream", "Pencils", "Hinge set", "Lentils"]
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def money(cents):
    return f"{cents / 100:.2f}"


def invent(rng):
    lines = [(rng.choice(ITEMS), rng.randint(1, 3), rng.randint(99, 4999)) for _ in range(rng.randint(2, 8))]
    subtotal = sum(qty * price for _, qty, price in lines)
    rate = rng.choice([0, 5, 6, 7, 8, 10])
    tax = round(subtotal * rate / 100)
    year, month, day = rng.randint(2023, 2026), rng.randint(1, 12), rng.randint(1, 28)
    return {
        "merchant": rng.choice(MERCHANTS),
        "lines": lines,
        "subtotal": subtotal,
        "tax": tax,
        "total": subtotal + tax,
        "year": year,
        "month": month,
        "day": day,
        "phone": f"555-01{rng.randint(10, 99)}",
        "receipt_no": rng.randint(10000, 99999),
    }


def layout_plain(r):
    rows = [r["merchant"], f"Tel {r['phone']}", f"Date: {r['year']}-{r['month']:02d}-{r['day']:02d}", ""]
    rows += [f"{name} x{qty}  {money(qty * price)}" for name, qty, price in r["lines"]]
    return rows + ["", f"Subtotal {money(r['subtotal'])}", f"Tax {money(r['tax'])}", f"Total {money(r['total'])}"]


def layout_us(r):
    rows = [r["merchant"].upper(), f"RECEIPT #{r['receipt_no']}", f"{r['month']:02d}/{r['day']:02d}/{r['year']}", "-" * 24]
    rows += [f"{qty} {name.upper()} @ {money(price)} ... {money(qty * price)}" for name, qty, price in r["lines"]]
    return rows + ["-" * 24, f"SUB TOTAL   ${money(r['subtotal'])}", f"SALES TAX   ${money(r['tax'])}", f"AMOUNT DUE  ${money(r['total'])}"]


def layout_words(r):
    rows = [f"Thanks for shopping at {r['merchant']}!", f"{MONTHS[r['month'] - 1]} {r['day']}, {r['year']}"]
    rows += [f"- {name} ({qty}): {money(qty * price)}" for name, qty, price in r["lines"]]
    return rows + [f"Before tax: {money(r['subtotal'])}", f"Tax: {money(r['tax'])}", f"You paid: {money(r['total'])}"]


def layout_table(r):
    rows = [f"Store | {r['merchant']}", f"Ref | {r['receipt_no']}", f"When | {r['day']:02d} {MONTHS[r['month'] - 1]} {r['year']}", "Item | Qty | Amount"]
    rows += [f"{name} | {qty} | {money(qty * price)}" for name, qty, price in r["lines"]]
    return rows + [f"Net | | {money(r['subtotal'])}", f"VAT | | {money(r['tax'])}", f"Gross | | {money(r['total'])}"]


def layout_footer_first(r):
    rows = [f"TOTAL {money(r['total'])}  TAX {money(r['tax'])}  SUBTOTAL {money(r['subtotal'])}", f"{r['merchant']} / {r['phone']}", f"Sold on {r['year']}.{r['month']:02d}.{r['day']:02d}"]
    return rows + [f"{money(qty * price)}  {name}, qty {qty}" for name, qty, price in r["lines"]]


TRAIN_LAYOUTS = (layout_plain, layout_us, layout_words)
HELDOUT_LAYOUTS = (layout_table, layout_footer_first)


def scan_noise(text, rng):
    """What a cheap scanner does: a few misread letters, never in a digit, so the right answer stays on the page."""
    swaps = {"l": "1", "O": "0", "e": "c", "a": "o", "S": "5"}
    out = [swaps[c] if c in swaps and not c.isdigit() and rng.random() < 0.03 else c for c in text]
    return "".join(out)


def truth(r):
    return {
        "merchant": r["merchant"],
        "date": f"{r['year']}-{r['month']:02d}-{r['day']:02d}",
        "subtotal": money(r["subtotal"]),
        "tax": money(r["tax"]),
        "total": money(r["total"]),
        "item_count": len(r["lines"]),
    }


def row(text, r):
    return {"text": text, "truth": truth(r)}


def make(out, seed, train_n, heldout_n):
    rng = random.Random(seed)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "train.jsonl"), "w", encoding="utf8", newline="\n") as f:
        for i in range(train_n):
            r = invent(rng)
            text = "\n".join(TRAIN_LAYOUTS[i % len(TRAIN_LAYOUTS)](r))
            answer = dict(truth(r))
            for key in ("subtotal", "tax", "total"):
                answer[key] = float(answer[key])
            f.write(json.dumps({"messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}, {"role": "assistant", "content": json.dumps(answer, separators=(",", ":"))}]}) + "\n")
    with open(os.path.join(out, "heldout.jsonl"), "w", encoding="utf8", newline="\n") as f:
        for i in range(heldout_n):
            r = invent(rng)
            text = "\n".join(HELDOUT_LAYOUTS[i % len(HELDOUT_LAYOUTS)](r))
            noisy = i % 4 == 3
            f.write(json.dumps({"id": i, "layout": HELDOUT_LAYOUTS[i % len(HELDOUT_LAYOUTS)].__name__, "noisy": noisy, **row(scan_noise(text, rng) if noisy else text, r)}) + "\n")
    print(f"wrote {train_n} training and {heldout_n} held-out receipts to {out}")


def cents(value):
    try:
        return int((Decimal(str(value).replace("$", "").replace(",", "").strip()) * 100).to_integral_value())
    except Exception:
        return None


def norm_name(value):
    return re.sub(r"\s+", " ", str(value)).strip().lower()


def parse_answer(text):
    """The first JSON object in an answer, after any thinking or fence. None when there isn't one."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    start = text.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(text)):
            if text[end] == "{":
                depth += 1
            elif text[end] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        found = json.loads(text[start : end + 1])
                        return found if isinstance(found, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def field_right(field, got, want):
    if got is None:
        return False
    if field == "merchant":
        return norm_name(got) == norm_name(want)
    if field == "date":
        return str(got).strip() == want
    if field == "item_count":
        try:
            return int(got) == want
        except (TypeError, ValueError):
            return False
    return cents(got) is not None and cents(got) == cents(want)


def score(rows):
    """rows: {"truth", "answer" (dict or None), optional "raw", "seconds", "completion_tokens"}."""
    fields = {f: 0 for f in FIELDS}
    valid = exact = adds_up = 0
    for r in rows:
        answer = r["answer"]
        if answer is None:
            continue
        valid += 1
        right = [f for f in FIELDS if field_right(f, answer.get(f), r["truth"][f])]
        for f in right:
            fields[f] += 1
        exact += len(right) == len(FIELDS)
        a, b, c = cents(answer.get("subtotal")), cents(answer.get("tax")), cents(answer.get("total"))
        adds_up += a is not None and b is not None and c is not None and a + b == c
    n = len(rows) or 1
    seconds = [r["seconds"] for r in rows if r.get("seconds") is not None]
    tokens = sum(r.get("completion_tokens") or 0 for r in rows)
    return {
        "receipts": len(rows),
        "valid_json": round(valid / n, 3),
        "all_six_right": round(exact / n, 3),
        "fields_right": round(sum(fields.values()) / (n * len(FIELDS)), 3),
        "per_field": {f: round(fields[f] / n, 3) for f in FIELDS},
        "adds_up": round(adds_up / n, 3),
        "median_seconds": round(sorted(seconds)[len(seconds) // 2], 1) if seconds else None,
        "tokens_per_second": round(tokens / sum(seconds), 1) if seconds and sum(seconds) else None,
    }


MONEY = r"\$?\s*([0-9]+\.[0-9]{2})"


def regex_answer(text):
    """The cheap baseline a tuned model has to beat, written for the training layouts on purpose."""
    def after(words):
        m = re.search(r"(?:" + words + r")[^0-9\n]*" + MONEY, text, re.I)
        return m.group(1) if m else None

    date = None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        date = m.group(0)
    else:
        m = re.search(r"(\d{2})/(\d{2})/(\d{4})", text)
        if m:
            date = f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    return {
        "merchant": text.splitlines()[0].strip() if text else None,
        "date": date,
        "subtotal": after("sub ?total|before tax"),
        "tax": after("tax"),
        "total": after("amount due|you paid|(?<!sub )(?<!sub)total"),
        "item_count": len(re.findall(r"^(?:- |\d+ [A-Z]|.* x\d)", text, re.M)),
    }


def read_rows(path):
    with open(path, encoding="utf8") as f:
        return [json.loads(line) for line in f if line.strip()]


def ask_one(url, token, model, node_id, text, max_tokens):
    body = json.dumps({"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}], "temperature": 0, "max_tokens": max_tokens, "stream": False}).encode()
    req = urllib.request.Request(url + "/v1/chat/completions", data=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "X-JCP-Node": node_id})
    start = time.time()
    with urllib.request.urlopen(req, timeout=180) as res:
        data = json.load(res)
    choice = data["choices"][0]
    return {"raw": choice["message"].get("content") or "", "finish": choice.get("finish_reason"), "seconds": time.time() - start, "completion_tokens": (data.get("usage") or {}).get("completion_tokens")}


def ask(args):
    token = os.environ["FLEET_TOKEN"]
    url = args.url.rstrip("/")
    req = urllib.request.Request(url + "/api/nodes", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as res:
        node = next(n for n in json.load(res) if n["name"] == args.board)
    model = args.model or next(m for m in node["loaded_models"] if not m.lower().startswith("d1"))
    rows = []
    for held in read_rows(args.heldout)[: args.limit or None]:
        try:
            got = ask_one(url, token, model, node["id"], held["text"], args.max_tokens)
        except (urllib.error.URLError, TimeoutError, OSError, KeyError, ValueError) as err:
            got = {"raw": "", "finish": f"error: {type(err).__name__} {getattr(err, 'code', '')}", "seconds": None, "completion_tokens": None}
        rows.append({**held, **got, "answer": parse_answer(got["raw"])})
        print(args.board, held["id"], got["finish"], got["seconds"] and round(got["seconds"], 1), flush=True)
    report = {"board": args.board, "model": model, "seed_file": os.path.basename(args.heldout), **score(rows), "errors": sum(1 for r in rows if str(r["finish"]).startswith("error")), "cut_off": sum(1 for r in rows if r["finish"] == "length")}
    if args.out:
        with open(args.out, "w", encoding="utf8", newline="\n") as f:
            json.dump({"report": report, "rows": rows}, f, indent=1)
    print(json.dumps(report, indent=1))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    m = sub.add_parser("make")
    m.add_argument("--out", required=True)
    m.add_argument("--seed", type=int, default=2026)
    m.add_argument("--train", type=int, default=300)
    m.add_argument("--heldout", type=int, default=40)
    r = sub.add_parser("regex")
    r.add_argument("--heldout", required=True)
    a = sub.add_parser("ask")
    a.add_argument("--heldout", required=True)
    a.add_argument("--url", required=True)
    a.add_argument("--board", required=True)
    a.add_argument("--model")
    a.add_argument("--max-tokens", type=int, default=200)
    a.add_argument("--limit", type=int, default=0)
    a.add_argument("--out")
    s = sub.add_parser("score")
    s.add_argument("--heldout", required=True)
    s.add_argument("--answers", required=True, help="receipt-eval-board.py's output")
    args = parser.parse_args()
    if args.command == "make":
        make(args.out, args.seed, args.train, args.heldout)
    elif args.command == "score":
        held = {row["id"]: row for row in read_rows(args.heldout)}
        answers = read_rows(args.answers)
        for which in dict.fromkeys(a["which"] for a in answers):
            rows = [{**held[a["id"]], **a, "answer": parse_answer(a["raw"])} for a in answers if a["which"] == which]
            print(json.dumps({"model": which, **score(rows)}))
    elif args.command == "regex":
        rows = [{**held, "answer": regex_answer(held["text"])} for held in read_rows(args.heldout)]
        print(json.dumps({"board": "none", "model": "regex", **score(rows)}, indent=1))
    else:
        ask(args)


if __name__ == "__main__":
    sys.exit(main())
