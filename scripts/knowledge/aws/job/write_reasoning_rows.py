"""Rows of base Glimmer's own reasoning, for the stage B repair (train_glimmer.py trains a whole turn when an
assistant message carries reasoning_content).

Run on the GPU machine, against the local vLLM servers (one per GPU). Every kept reasoning_content and content is the
server's field, copied unchanged. This file grades, drops and writes. It does not invent, paraphrase or edit either
field, and it does not call any model except those servers.

A sample is rendered back through the saved chat template and compared to the token ids the server returned. If that
sample does not match, the run stops before writing at scale: those rows would train the wrong tokens.

  python write_reasoning_rows.py --out OUT.jsonl --replay REPLAY.jsonl --tokenizer ADAPTER_DIR \
      --minutes 45 --target 30000
  python write_reasoning_rows.py --self-check
  python write_reasoning_rows.py --check-labels OUT.jsonl --tokenizer ADAPTER_DIR --n 1000

Resumes from OUT.jsonl. Writing stops at --target kept rows or --minutes after the sample passes, and a restarted
process keeps the deadline stored beside the output.
"""

import argparse
import ast
import collections
import hashlib
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import make_reasoning_probes as probes  # noqa: E402
from score_reasoning import check_instruction, code_block, grade_final, grade_json, grade_multiturn  # noqa: E402
from stage_b_lib import D, Screen, qkey  # noqa: E402
from train_glimmer import (  # noqa: E402
    CONTROL_TOKEN, GENERATION_PROMPT, SELF_CHANNEL, STRENGTHS, SYSTEM, channel_marks, training_text, wanted_labels_text, whole_turn_labels,
)

def make_screen():
    """Screen() on its own leaves the honesty dev file out. The brief keeps that file out of these prompts."""
    dev = os.path.join(D, "stage-b-honesty-dev.jsonl")
    return Screen(dev=dev if os.path.exists(dev) else None)


# Ordinary system lines. The first is train_glimmer.SYSTEM. None of them mentions a date or a reasoning strength:
# the template appends "Reasoning strength: ..." from the request.
SYSTEMS = (
    SYSTEM,
    "You are a helpful assistant. Answer in a direct and careful way.",
    "You are a clear, careful assistant.",
    "You are a helpful assistant. Do the task you are asked to do.",
)
STRENGTH_WEIGHTS = (("low", 0.45), ("medium", 0.40), ("high", 0.15))
# Base's guesses about 2026 and the news around it must not be trained. Calendar arithmetic on other years stays.
RECENT = re.compile(r"\b(2026|breaking news|this year|today|current president|prime minister|who won the (?:election|championship))\b", re.I)
MAX_TURN_TOKENS = 1024
WRITER = "muse-glimmer-30b"
SOURCES = ("multistep", "json", "instructions", "python", "multiturn", "general")


def say(event, **fields):
    print("MUSE " + json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def weighted_strength(rng):
    x = rng.random()
    acc = 0.0
    for name, weight in STRENGTH_WEIGHTS:
        acc += weight
        if x < acc:
            return name
    return "medium"


def other_strength(rng, taken):
    choices = [(n, w) for n, w in STRENGTH_WEIGHTS if n not in taken]
    if not choices:
        return None
    total = sum(w for _, w in choices)
    x = rng.random() * total
    acc = 0.0
    for name, weight in choices:
        acc += weight
        if x < acc:
            return name
    return choices[-1][0]


def pick_system(rng):
    if rng.random() < 0.5:
        return SYSTEMS[0]
    return rng.choice(SYSTEMS[1:])


def code_parses(final):
    """True when the last fenced block parses. The block is not executed."""
    block = code_block(final)
    if block is None or not block.strip():
        return False
    try:
        ast.parse(block)
    except SyntaxError:
        return False
    return True


def reply_problem(reasoning, content, token_ids, finish):
    """Why one server reply cannot be kept, or None. The strings are not modified."""
    if finish != "stop":
        return "unfinished"
    if not isinstance(reasoning, str) or not reasoning.strip():
        return "no_reasoning"
    if not isinstance(content, str) or not content.strip():
        return "no_answer"
    if CONTROL_TOKEN.search(reasoning) or CONTROL_TOKEN.search(content):
        return "control_token"
    if not token_ids:
        return "no_token_ids"
    if len(token_ids) > MAX_TURN_TOKENS:
        return "too_long"
    return None


def grade_content(check, content):
    part = check["part"]
    if part == "general":
        return None
    if part == "multistep":
        return None if grade_final(check, content)["right"] else "wrong"
    if part == "json":
        return None if grade_json(check, content)["right"] else "json_fail"
    if part == "instructions":
        return None if check_instruction(check, content) else "instruction_fail"
    if part == "python":
        if code_block(content) is None:
            return "no_code_block"
        return None if code_parses(content) else "code_does_not_parse"
    if part == "multiturn":
        return None if grade_multiturn(check, content) else "multiturn_miss"
    return "bad_check"


def make_row(job, turns):
    """turns is a list of {content, reasoning_content} from the server, in order, unmodified."""
    messages = [{"role": "system", "content": job["system"]}]
    for i, user in enumerate(job["user_turns"]):
        messages.append({"role": "user", "content": user})
        messages.append({"role": "assistant", "content": turns[i]["content"], "reasoning_content": turns[i]["reasoning_content"]})
    return {
        "messages": messages,
        "reasoning_strength": job["strength"],
        "source": "stageb-reasoning:" + job["source"],
        "kind": "reasoning",
        "lineage": {"writer": WRITER, "tuned": False, "student_usable": False, "prompt_id": job["id"]},
        "visibility": "private",
    }


# Prompt builders. The text is the task. Answers used for grading never go into the row.

def add_job(jobs, used, dropped, screen, rng, source, user_turns, check):
    text = "\n".join(user_turns)
    if RECENT.search(text):
        dropped["recent"] += 1
        return False
    why = None
    for turn in user_turns:
        why = screen.why(turn) or why
    if why:
        dropped["screen"] += 1
        return False
    key = qkey(text)
    limit = 2 if source == "general" else 1
    have = used.setdefault(key, [])
    if len(have) >= limit:
        dropped["duplicate"] += 1
        return False
    strength = other_strength(rng, have) if have else weighted_strength(rng)
    if strength is None or strength in have:
        dropped["duplicate"] += 1
        return False
    have.append(strength)
    jobs.append({
        "id": f"{source}-{len(jobs):06d}-{strength}",
        "source": source,
        "strength": strength,
        "system": pick_system(rng),
        "user_turns": user_turns,
        "check": check,
    })
    return True


def fill_multistep(rng, add, limit):
    got = stall = 0
    makers = [fn for group in probes.ARITHMETIC.values() for fn in group]
    for _ in range(max(limit, 1) * 2):
        question, answer = rng.choice(makers)(rng)
        got += add("multistep", [question], {"part": "multistep", "answer_type": "number", "answer": answer})
        if got >= limit:
            return
    while got < limit and stall < 40:
        before = got
        for _sub, question, _answer in probes.unit_items(rng):
            got += add("multistep", [question], {"part": "multistep", "answer_type": "number", "answer": _answer})
            if got >= limit:
                return
        for sub, question, typ, answer, options in probes.calendar_items(rng):
            check = {"part": "multistep", "answer_type": typ, "answer": answer}
            if options:
                check["options"] = options
            got += add("multistep", [question], check)
            if got >= limit:
                return
        for _sub, question, answer, options in probes.logic_items(rng):
            got += add("multistep", [question], {"part": "multistep", "answer_type": "option", "answer": answer, "options": options})
            if got >= limit:
                return
        for _sub, question, typ, answer, options in probes.hard_items(rng):
            check = {"part": "multistep", "answer_type": typ, "answer": answer}
            if options:
                check["options"] = options
            got += add("multistep", [question], check)
            if got >= limit:
                return
        stall = 0 if got > before else stall + 1


def fill_json(rng, add, limit):
    dishes = ["oat biscuits", "lentil stew", "rice pudding", "bean tacos", "apple crumble", "pea soup"]
    hues = ["amber", "cobalt", "linen", "moss", "plum", "sand"]
    stops = ["harbor", "market", "library", "station", "garden", "bridge"]
    got = tries = 0
    while got < limit and tries < limit * 8:
        tries += 1
        kind = tries % 4
        if kind == 0:
            dish, servings, minutes, vegan = rng.choice(dishes), rng.randint(2, 8), rng.choice([15, 20, 30, 45, 60]), rng.choice([True, False])
            question = (f"Return one JSON object and nothing else for a home recipe. Keys, exactly: "
                        f'"dish" (the string {dish!r}), "servings" (the integer {servings}), "minutes" (the integer {minutes}), '
                        f'"vegan" (the boolean {str(vegan).lower()}).')
            expect = {"dish": dish, "servings": servings, "minutes": minutes, "vegan": vegan}
        elif kind == 1:
            n, step = rng.randint(3, 7), rng.randint(2, 9)
            question = f"Return one JSON array and nothing else: the squares of the first {n} positive multiples of {step}, in increasing order."
            expect = [(step * (i + 1)) ** 2 for i in range(n)]
        elif kind == 2:
            hue, r, g, b = rng.choice(hues), rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255)
            question = (f"Return one JSON object and nothing else. Keys, exactly: \"swatch\" (the string {hue!r}) and "
                        f"\"rgb\" (the list [{r}, {g}, {b}]).")
            expect = {"swatch": hue, "rgb": [r, g, b]}
        else:
            a, b, minutes = rng.choice(stops), rng.choice(stops), rng.randint(4, 40)
            while a == b:
                b = rng.choice(stops)
            question = (f"Return one JSON object and nothing else for a walk. Keys, exactly: \"from\" ({a!r}), \"to\" ({b!r}) "
                        f"and \"minutes\" (the integer {minutes}).")
            expect = {"from": a, "to": b, "minutes": minutes}
        got += add("json", [question], {"part": "json", "expect": expect})


def fill_instructions(rng, add, limit):
    topics = ["a pulley", "a kiln", "an abacus", "a compass", "a lever", "a sundial", "a bellows", "a spindle", "a sextant", "a loom",
              "a whistle", "a ladder", "a magnet", "a candle", "a bucket", "a hammer", "a mirror", "a kettle", "a basket", "a shovel",
              "a violin", "a drum", "a flute", "a pencil", "a notebook", "a blanket", "a lantern", "a wagon", "an anchor", "a compass rose",
              "a wheelbarrow", "a thimble", "a corkscrew", "a rolling pin", "a watering can", "a clothesline", "a doorstop", "an hourglass",
              "a wind chime", "a birdhouse", "a stepladder", "a paintbrush", "a ruler", "a stapler", "an envelope", "a paperclip"]
    phrases = ["bright as brass", "quiet as chalk", "round as a wheel", "plain as linen", "sharp as flint", "soft as wool",
               "cool as clay", "light as cork", "still as stone", "clear as glass", "warm as bread", "dry as sand"]
    lists = ["garden tools", "string instruments", "bakery smells", "river birds", "hand tools", "cloud shapes",
             "kitchen vessels", "sewing tools", "orchard fruits", "forest trees", "board games", "boat parts"]
    bans = ["metal", "sugar", "wheel", "glass", "smoke", "cloth", "wood", "salt", "paper", "rope"]
    starts = ["Listen", "Notice", "Remember", "Consider", "Imagine", "Suppose"]
    ends = ["and so it goes.", "that is the lot.", "nothing further.", "and there you are."]
    got = tries = 0
    while got < limit and tries < limit * 8:
        tries += 1
        kind = tries % 7
        if kind == 0:
            n, topic = rng.randint(8, 16), rng.choice(topics)
            question = f"In no more than {n} words, say what {topic} is used for."
            check = {"part": "instructions", "check": "max_words", "n": n}
        elif kind == 1:
            phrase, topic = rng.choice(phrases), rng.choice(topics)
            question = f"Write two sentences about {topic}. Include this exact phrase: \"{phrase}\"."
            check = {"part": "instructions", "check": "phrase", "text": phrase}
        elif kind == 2:
            n, kind_name = rng.randint(3, 6), rng.choice(lists)
            question = f"Give exactly {n} {kind_name} as bullet points. Each line starts with \"- \" and you write nothing else."
            check = {"part": "instructions", "check": "bullets", "n": n}
        elif kind == 3:
            topic = rng.choice(topics)
            question = f"Describe {topic} in one sentence using only lowercase letters."
            check = {"part": "instructions", "check": "lowercase"}
        elif kind == 4:
            topic, ban = rng.choice(topics), rng.choice(bans)
            question = f"Describe {topic} in two sentences. Do not use the word \"{ban}\"."
            check = {"part": "instructions", "check": "forbid", "text": ban}
        elif kind == 5:
            word, topic = rng.choice(starts), rng.choice(topics)
            question = f"Explain {topic} in one or two sentences. The reply must begin with the word \"{word}\"."
            check = {"part": "instructions", "check": "starts", "text": word}
        else:
            topic, end, n = rng.choice(topics), rng.choice(ends), rng.choice([1, 2, 3])
            question = f"Explain {topic} in exactly {n} sentences. The reply must end with \"{end}\""
            # sentences check and the ending check can't both be stored; the ending is the stricter visible constraint.
            check = {"part": "instructions", "check": "ends", "text": end}
            if n != 1:
                question = f"Explain {topic} in exactly {n} sentences."
                check = {"part": "instructions", "check": "sentences", "n": n}
        got += add("instructions", [question], check)


def _py_question(fn, args, desc, example):
    return (f"Write a Python function `{fn}({args})` that {desc}. "
            f"A worked example: {example}. "
            "Put the function in one ```python code block.")


def fill_python(rng, add, limit):
    """Each family is its own task template. Names and examples change so the prompts are distinct.
    Model code is never run; a row is kept only when its block parses."""
    nouns = ["crate", "token", "label", "shard", "batch", "slice", "glyph", "ledger"]
    got = attempts = 0
    while got < limit and attempts < limit * 6:
        attempts += 1
        fn = rng.choice(nouns) + "_" + str(rng.randint(100, 999))
        family = attempts % 24
        nums = [rng.randint(-4, 12) for _ in range(5)]
        word = rng.choice(["harbor", "linen", "cinder", "marble", "willow"])
        if family == 0:
            question = _py_question(fn, "nums", "returns the sum of the even integers and ignores the odds", f"`{fn}({nums})` returns {sum(n for n in nums if n % 2 == 0)}")
        elif family == 1:
            question = _py_question(fn, "s", "returns the number of vowels aeiou, upper or lower, in the string s", f"`{fn}({word!r})` returns {sum(c in 'aeiou' for c in word)}")
        elif family == 2:
            question = _py_question(fn, "s", "returns the words of s in reverse order, joined by one space", f"`{fn}('red blue')` returns 'blue red'")
        elif family == 3:
            question = _py_question(fn, "s", "returns True when s reads the same forward and backward, ignoring case and spaces", f"`{fn}('A man a plan')` is False")
        elif family == 4:
            lo, hi, n = 2, 9, rng.randint(-2, 14)
            question = _py_question(fn, "n, lo, hi", "returns n limited to the closed range lo..hi", f"`{fn}({n}, {lo}, {hi})` returns {min(hi, max(lo, n))}")
        elif family == 5:
            question = _py_question(fn, "nums", "returns a new list of the running totals of nums", f"`{fn}([1, 2, 3])` returns [1, 3, 6]")
        elif family == 6:
            k = rng.randint(2, 4)
            question = _py_question(fn, "nums, k", "returns the sum of every k-th item of nums, starting at index 0", f"`{fn}({nums}, {k})` returns {sum(nums[i] for i in range(0, len(nums), k))}")
        elif family == 7:
            question = _py_question(fn, "nums", "returns the largest value in nums, or None when nums is empty", f"`{fn}({nums})` returns {max(nums)}")
        elif family == 8:
            question = _py_question(fn, "s", "returns s with its letters reversed and its other characters left in place", f"`{fn}('a1b')` returns 'b1a'")
        elif family == 9:
            n = rng.randint(3, 8)
            question = _py_question(fn, "n", "returns n factorial for a non-negative integer n", f"`{fn}({n})` returns {math.factorial(n)}")
        elif family == 10:
            a, b = rng.randint(2, 40), rng.randint(2, 40)
            import math as _math
            question = _py_question(fn, "a, b", "returns the greatest common divisor of the two non-negative integers", f"`{fn}({a}, {b})` returns {_math.gcd(a, b)}")
        elif family == 11:
            question = _py_question(fn, "nums", "returns the integers from nums that are strictly positive, in the same order", f"`{fn}({nums})` returns {[n for n in nums if n > 0]}")
        elif family == 12:
            question = _py_question(fn, "s", "returns a dict counting each character of s, including spaces", f"`{fn}('ab a')` returns a dict with a:2, b:1 and a space:1")
        elif family == 13:
            question = _py_question(fn, "rows", "returns the sum of each row of a list of lists of numbers", f"`{fn}([[1, 2], [3]])` returns [3, 3]")
        elif family == 14:
            shift = rng.randint(1, 5)
            question = _py_question(fn, "s, k", "rotates the string s left by k characters", f"`{fn}({word!r}, {shift})` returns {word[shift:] + word[:shift]!r}")
        elif family == 15:
            question = _py_question(fn, "pairs", "returns a dict made from a list of [key, value] pairs; a repeated key keeps the last value", f"`{fn}([['a', 1], ['a', 2]])` returns {{'a': 2}}")
        elif family == 16:
            question = _py_question(fn, "s", "returns True when every bracket in ()[] is matched and nested, ignoring other characters", f"`{fn}('(a[b])')` is True and `{fn}('([)]')` is False")
        elif family == 17:
            question = _py_question(fn, "nums", "returns the product of the numbers in nums, and 1 for an empty list", f"`{fn}([2, 3, 4])` returns 24")
        elif family == 18:
            width = rng.randint(3, 8)
            question = _py_question(fn, "s, width", "returns s cut to at most width characters", f"`{fn}({word!r}, {width})` returns {word[:width]!r}")
        elif family == 19:
            question = _py_question(fn, "nums", "returns the index of the minimum value, the first one if several, or None if nums is empty", f"`{fn}({nums})` returns {nums.index(min(nums))}")
        elif family == 20:
            question = _py_question(fn, "a, b", "returns a new list that alternates items from a and b, starting with a, then any tail", f"`{fn}([1, 2], [8])` returns [1, 8, 2]")
        elif family == 21:
            question = _py_question(fn, "s", "returns the digits of s in order, as a string, dropping every other character", f"`{fn}('a1b2')` returns '12'")
        elif family == 22:
            n = rng.randint(1, 20)
            question = _py_question(fn, "n", "returns the sum of the decimal digits of a non-negative integer n", f"`{fn}({n})` returns {sum(int(c) for c in str(n))}")
        else:
            question = _py_question(fn, "lines", "returns the lines with trailing spaces removed, dropping lines that were only spaces", f"`{fn}(['a  ', '  '])` returns ['a']")
        got += add("python", [question], {"part": "python"})


def fill_multiturn(rng, add, limit):
    colors = ["amber", "cobalt", "linen", "moss", "plum", "sand"]
    rooms = ["shed", "pantry", "loft", "studio", "porch"]
    plants = ["basil", "fern", "ivy", "mint", "sage"]
    got = tries = 0
    while got < limit and tries < limit * 8:
        tries += 1
        kind = tries % 6
        if kind == 0:
            color, code = rng.choice(colors), rng.randint(10, 99)
            first = f"The spare key for the shed is on a {color} hook, and the padlock code is {code}."
            second = "What color is the hook, and what is the padlock code?"
            needs = [color, str(code)]
        elif kind == 1:
            plant, days, cups = rng.choice(plants), rng.randint(2, 9), rng.randint(1, 4)
            first = f"My {plant} should be watered every {days} days, with {cups} cups each time."
            second = "How many days between waterings, and how many cups do I use?"
            needs = [str(days), str(cups)]
        elif kind == 2:
            room, locker, letter = rng.choice(rooms), rng.randint(100, 899), rng.choice("ABCDE")
            first = f"I left the parcel in the {room}, locker {locker}, marked with the letter {letter}."
            second = "Which room, which locker number, and which letter?"
            needs = [room, str(locker), letter]
        elif kind == 3:
            left, right = rng.randint(2, 9), rng.randint(2, 9)
            first = f"The recipe uses {left} cups of oats and {right} cups of milk."
            second = "How many cups of oats and how many cups of milk does the recipe use?"
            needs = [str(left), str(right)]
        elif kind == 4:
            aisle, seat = rng.randint(1, 30), rng.choice("ABCDEF")
            first = f"We are in aisle {aisle}, seat {seat}, on this trip."
            second = "Remind me of the aisle number and the seat letter."
            needs = [str(aisle), seat]
        else:
            count, price = rng.randint(2, 8), rng.randint(3, 9)
            first = f"I bought {count} blank notebooks at {price} dollars each."
            second = "How many notebooks did I buy, and what was the price of one in dollars?"
            needs = [str(count), str(price)]
        got += add("multiturn", [first, second], {"part": "multiturn", "needs": needs})
        if got > limit * 3:
            return


def fill_general(rng, add, path, limit):
    prompts = []
    with open(path) as f:
        for line in f:
            if line.strip():
                prompts.append(json.loads(line)["prompt"])
    rng.shuffle(prompts)
    got = 0
    for prompt in prompts:
        if got >= limit:
            return
        # At most twice, and the second call gets a different strength inside add_job.
        if add("general", [prompt], {"part": "general"}):
            got += 1
        if got >= limit:
            return
        if add("general", [prompt], {"part": "general"}):
            got += 1


def build_jobs(seed, screen, replay_path, limits):
    rng = random.Random(seed)
    jobs, used, dropped = [], {}, collections.Counter()

    def add(source, user_turns, check):
        return add_job(jobs, used, dropped, screen, rng, source, user_turns, check)

    fill_multistep(rng, add, limits["multistep"])
    fill_json(rng, add, limits["json"])
    fill_instructions(rng, add, limits["instructions"])
    fill_python(rng, add, limits["python"])
    fill_multiturn(rng, add, limits["multiturn"])
    if replay_path:
        fill_general(rng, add, replay_path, limits["general"])
    rng.shuffle(jobs)
    return jobs, dropped


def load_done(path):
    done = set()
    if not os.path.exists(path):
        return done
    with open(path) as f:
        for line in f:
            if line.strip():
                done.add(json.loads(line)["lineage"]["prompt_id"])
    return done


def field_text(message, name):
    """The server's reasoning or answer string, or None when the field is absent. Not stripped."""
    if not isinstance(message, dict):
        return None
    if name == "reasoning":
        if "reasoning_content" in message and message["reasoning_content"] is not None:
            return message["reasoning_content"]
        if "reasoning" in message and message["reasoning"] is not None:
            return message["reasoning"]
        return None
    value = message.get(name)
    return value if isinstance(value, str) else None


def token_ids_of(choice):
    if choice.get("token_ids"):
        return list(choice["token_ids"])
    logprobs = (choice.get("logprobs") or {}).get("content") or []
    ids = []
    for item in logprobs:
        if "token_id" not in item:
            return None
        ids.append(item["token_id"])
    return ids or None


def render_pair(tok, messages, strength):
    """(prompt ids, continuation ids) of messages rendered with the tokenizer's chat template, bos text removed."""
    bos = tok.bos_token or ""

    def render(msgs, generation):
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=generation, reasoning_strength=strength)
        return text.removeprefix(bos) if bos and text.startswith(bos) else text

    prompt = render(messages[:-1], True)
    full = render(messages, False)
    if not full.startswith(prompt):
        return None, None, "prompt text is not a prefix"
    prompt_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    full_ids = tok(full, add_special_tokens=False)["input_ids"]
    if full_ids[:len(prompt_ids)] != prompt_ids:
        return None, None, "prompt ids are not a prefix"
    return prompt_ids, full_ids[len(prompt_ids):], None


def ids_match(prompt_ids, continuation, produced):
    if produced is None:
        return False
    if continuation == produced:
        return True
    return produced == list(prompt_ids) + list(continuation)


def round_trip_note(tok, messages, strength, produced_by_turn):
    """A short description of a token mismatch. Lengths and special-token tails only, never the reply text."""
    notes = []
    for end in range(1, len(messages) + 1):
        if messages[end - 1].get("role") != "assistant":
            continue
        prompt_ids, continuation, err = render_pair(tok, messages[:end], strength)
        produced = produced_by_turn.get(end - 1)
        if err:
            notes.append(err)
            continue
        if not produced:
            notes.append("no ids")
            continue
        if ids_match(prompt_ids, continuation, produced):
            text = tok.apply_chat_template(messages[:end], tokenize=False, add_generation_prompt=False, reasoning_strength=strength)
            if SELF_CHANNEL + (messages[end - 1].get("reasoning_content") or "") + "<|eom|>" not in text:
                notes.append("template dropped the reasoning text")
            continue
        notes.append(f"continuation {len(continuation)} produced {len(produced)}")
        if produced[:len(continuation)] == list(continuation):
            tail = tok.decode(produced[len(continuation):], skip_special_tokens=False)
            notes.append("produced tail " + tail if tail.startswith("<|") else "produced has an extra tail")
        elif list(continuation)[:len(produced)] == list(produced):
            tail = tok.decode(continuation[len(produced):], skip_special_tokens=False)
            notes.append("template tail " + tail if tail.startswith("<|") else "template has an extra tail")
        else:
            n = min(len(continuation), len(produced))
            i = next((k for k in range(n) if continuation[k] != produced[k]), n)
            notes.append(f"first difference at token {i}")
    return "; ".join(notes) if notes else "mismatch"


def round_trip_ok(tok, messages, strength, produced_by_turn):
    """Each assistant turn, rendered through the template, is that turn's token ids."""
    for end in range(1, len(messages) + 1):
        if messages[end - 1].get("role") != "assistant":
            continue
        reasoning = messages[end - 1].get("reasoning_content")
        prompt_ids, continuation, err = render_pair(tok, messages[:end], strength)
        if err or not ids_match(prompt_ids, continuation, produced_by_turn.get(end - 1)):
            return False
        text = tok.apply_chat_template(messages[:end], tokenize=False, add_generation_prompt=False, reasoning_strength=strength)
        if SELF_CHANNEL + reasoning + "<|eom|>" not in text:
            return False
    return True


class Server:
    def __init__(self, ports, timeout):
        self.ports = list(ports)
        self.timeout = timeout
        self.model = None
        self._i = 0
        self._lock = threading.Lock()

    def load_model(self):
        last = None
        for port in self.ports:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=10) as resp:
                    body = json.loads(resp.read().decode())
                self.model = body["data"][0]["id"]
                return
            except (urllib.error.URLError, KeyError, TimeoutError, json.JSONDecodeError) as err:
                last = err
        raise RuntimeError(f"no server answered on {self.ports[0]}-{self.ports[-1]}: {last}")

    def complete(self, messages, strength):
        with self._lock:
            port = self.ports[self._i % len(self.ports)]
            self._i += 1
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": MAX_TURN_TOKENS,
            "temperature": 0.6,
            "top_p": 0.95,
            "chat_template_kwargs": {"reasoning_strength": strength},
            "return_token_ids": True,
        }
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/chat/completions", data=data, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            return {"error": f"http {err.code}"}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            return {"error": type(err).__name__}
        try:
            choice = body["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError):
            return {"error": "bad response"}
        usage = body.get("usage") or {}
        return {
            "reasoning_content": field_text(message, "reasoning"),
            "content": field_text(message, "content"),
            "token_ids": token_ids_of(choice),
            "finish": choice.get("finish_reason"),
            "completion_tokens": usage.get("completion_tokens") or 0,
        }


def run_job(server, tok, job):
    """One job. Returns (row or None, reason or None, completion_tokens, reasoning_tokens, per-turn token id lists)."""
    messages = [{"role": "system", "content": job["system"]}]
    produced = {}
    turns = []
    completion_tokens = 0
    for user in job["user_turns"]:
        messages.append({"role": "user", "content": user})
        reply = server.complete(messages, job["strength"])
        if reply.get("error"):
            return None, "http_error", completion_tokens, 0
        reason = reply_problem(reply["reasoning_content"], reply["content"], reply["token_ids"], reply["finish"])
        if reason:
            return None, reason, completion_tokens + (reply["completion_tokens"] or len(reply["token_ids"] or [])), 0
        turns.append({"content": reply["content"], "reasoning_content": reply["reasoning_content"]})
        messages.append({"role": "assistant", "content": reply["content"], "reasoning_content": reply["reasoning_content"]})
        produced[len(messages) - 1] = reply["token_ids"]
        completion_tokens += reply["completion_tokens"] or len(reply["token_ids"])
    if sum(len(ids) for ids in produced.values()) > MAX_TURN_TOKENS:
        return None, "too_long", completion_tokens, 0
    if not round_trip_ok(tok, messages, job["strength"], produced):
        return None, "round_trip: " + round_trip_note(tok, messages, job["strength"], produced), completion_tokens, 0
    reason = grade_content(job["check"], turns[-1]["content"])
    if reason:
        return None, reason, completion_tokens, 0
    reasoning_tokens = 0
    for turn in turns:
        reasoning_tokens += len(tok(turn["reasoning_content"], add_special_tokens=False)["input_ids"])
    return make_row(job, turns), None, completion_tokens, reasoning_tokens


def load_tokenizer(path):
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(path)
    jinja = os.path.join(path, "chat_template.jinja")
    if os.path.exists(jinja):
        with open(jinja) as f:
            tok.chat_template = f.read()
    return tok


def check_labels(path, tokenizer_dir, n, seed):
    """n random rows: train_glimmer's trained span is the whole turn. Prints counts only."""
    tok = load_tokenizer(tokenizer_dir)
    rows = []
    with open(path) as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    rng = random.Random(seed)
    picked = rows if len(rows) <= n else rng.sample(rows, n)
    bos = tok.bos_token or ""

    def render(messages, generation, strength="low", tools=None):
        text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=generation, reasoning_strength=strength,
                                       **({"tools": tools} if tools else {}))
        return text.removeprefix(bos) if bos and text.startswith(bos) else text

    bad = 0
    marks = channel_marks(tok)
    for row in picked:
        text = training_text(row, render)
        want = wanted_labels_text(row, text, render)
        ids = tok(text, add_special_tokens=True)["input_ids"]
        labels = whole_turn_labels(ids, [-100] * len(ids), marks)
        got = tok.decode([t for t, lab in zip(ids, labels) if lab != -100], skip_special_tokens=False)
        if got != want:
            bad += 1
    say("labels", checked=len(picked), bad=bad, whole_turn=bad == 0)
    if bad:
        raise SystemExit(1)


def self_check(replay_path):
    screen = make_screen()
    limits = {s: 30 for s in SOURCES}
    limits["general"] = 10
    jobs, dropped = build_jobs(917353, screen, replay_path, limits)
    by_source = collections.Counter(j["source"] for j in jobs)
    strengths = collections.Counter(j["strength"] for j in jobs)
    # Graders on answers this process computed, not on model text.
    assert grade_content({"part": "multistep", "answer_type": "number", "answer": 4}, "The total is 9.\nAnswer: 4") is None
    assert grade_content({"part": "multistep", "answer_type": "number", "answer": 4}, "Answer: 5") == "wrong"
    assert grade_content({"part": "json", "expect": {"a": 1}}, '{"a": 1}') is None
    assert grade_content({"part": "json", "expect": {"a": 1}}, "nope") == "json_fail"
    assert grade_content({"part": "instructions", "check": "max_words", "n": 5}, "A kiln bakes clay.") is None
    assert grade_content({"part": "python"}, "```python\ndef f(x):\n    return x\n```") is None
    assert grade_content({"part": "python"}, "no code here") == "no_code_block"
    assert grade_content({"part": "multiturn", "needs": ["moss", "14"]}, "The hook is moss and the code is 14.") is None
    assert reply_problem("Think.", "Ok.", [1, 2], "stop") is None
    assert reply_problem("Think <|eot|> .", "Ok.", [1], "stop") == "control_token"
    assert reply_problem("Think.", "Ok.", [1], "length") == "unfinished"
    raw_r, raw_c = "  Think.\n", "Ok. "
    row = make_row({"id": "t", "source": "general", "strength": "low", "system": SYSTEM, "user_turns": ["Hi"], "check": {}},
                   [{"reasoning_content": raw_r, "content": raw_c}])
    assert row["messages"][-1]["reasoning_content"] == raw_r and row["messages"][-1]["content"] == raw_c
    assert not RECENT.search("\n".join(t for j in jobs for t in j["user_turns"]))
    say("self_check", jobs=len(jobs), by_source=dict(by_source), strengths=dict(strengths),
        dropped=dict(dropped), screen=screen.counts())
    if any(s not in by_source for s in SOURCES if s != "general" or replay_path):
        raise SystemExit("a source produced no jobs")


def parse_ports(text):
    if "-" in text:
        a, b = text.split("-", 1)
        return list(range(int(a), int(b) + 1))
    return [int(p) for p in text.split(",")]


def deadline_of(state_path, minutes):
    state = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
    if "deadline_epoch" not in state:
        state["deadline_epoch"] = time.time() + minutes * 60
        with open(state_path, "w") as f:
            json.dump(state, f)
    return state["deadline_epoch"]


def percentiles(values):
    if not values:
        return {"n": 0}
    ordered = sorted(values)
    def at(p):
        return ordered[min(len(ordered) - 1, round(p * (len(ordered) - 1)))]
    return {"n": len(ordered), "median": at(0.5), "p90": at(0.9)}


def write_rows(args):
    tok = load_tokenizer(args.tokenizer)
    screen = make_screen()
    say("screen", **screen.counts())
    limits = {"multistep": 14000, "json": 6000, "instructions": 4000, "python": 8000, "multiturn": 4000, "general": 14000}
    jobs, dropped = build_jobs(args.seed, screen, args.replay, limits)
    done = load_done(args.out)
    pending = [j for j in jobs if j["id"] not in done]
    say("jobs", built=len(jobs), pending=len(pending), already_kept=len(done), screened_or_skipped=dict(dropped),
        by_source=dict(collections.Counter(j["source"] for j in jobs)))
    server = Server(parse_ports(args.ports), args.timeout)
    server.load_model()
    say("server", model=server.model, ports=server.ports, tools="skipped, serve script has no tool parser")
    state_path = args.out + ".state.json"
    # The gate: a handful of replies before anything is written. A resumed run already passed it.
    sample = [] if os.path.exists(state_path) else pending[:max(8, len(server.ports))]
    pending = pending[len(sample):]
    gate_ok = gate_bad = 0
    kept_rows = []
    rejects = collections.Counter()
    lengths = collections.defaultdict(list)
    tokens = 0
    with ThreadPoolExecutor(max_workers=len(server.ports)) as pool:
        futs = [pool.submit(run_job, server, tok, job) for job in sample]
        for fut in as_completed(futs):
            row, reason, ntok, rtok = fut.result()
            tokens += ntok
            # A grade failure still round-tripped: grading runs only after the token ids match.
            if reason and reason.startswith("round_trip"):
                gate_bad += 1
                rejects[reason] += 1
            elif row or reason in ("wrong", "json_fail", "instruction_fail", "no_code_block", "code_does_not_parse", "multiturn_miss"):
                gate_ok += 1
                if row:
                    kept_rows.append((row, rtok))
                else:
                    rejects[reason] += 1
            else:
                rejects[reason or "drop"] += 1
    say("round_trip", matched=gate_ok, failed=gate_bad, resumed=not bool(sample), notes=dict(rejects))
    if sample and (gate_bad or gate_ok < 4):
        say("stop", why="parsed reasoning and answer did not match the template token ids, or too few well formed replies")
        raise SystemExit(2)
    deadline = deadline_of(state_path, args.minutes)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    out = open(args.out, "a")
    for row, rtok in kept_rows:
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
        lengths[row["reasoning_strength"]].append(rtok)
    out.flush()
    kept = len(done) + len(kept_rows)
    t0 = time.time()
    last_say = t0
    say("write", kept=kept, minutes_left=round(max(0, deadline - time.time()) / 60, 1))
    workers = min(args.concurrency, max(1, len(pending)))
    # Pull work until the clock or the target. In-flight replies finish.
    cursor = 0
    inflight = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        def submit_more():
            nonlocal cursor
            while len(inflight) < workers and cursor < len(pending) and time.time() < deadline and kept < args.target:
                fut = pool.submit(run_job, server, tok, pending[cursor])
                inflight[fut] = pending[cursor]["strength"]
                cursor += 1
        submit_more()
        while inflight:
            done_futs = [f for f in inflight if f.done()]
            if not done_futs:
                time.sleep(0.05)
                continue
            for fut in done_futs:
                strength = inflight.pop(fut)
                row, reason, ntok, rtok = fut.result()
                tokens += ntok
                if row:
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                    lengths[strength].append(rtok)
                    kept += 1
                else:
                    rejects[reason or "drop"] += 1
            out.flush()
            if time.time() - last_say > 30:
                last_say = time.time()
                say("progress", kept=kept, rejected=sum(rejects.values()), pending=len(pending) - cursor,
                    minutes_left=round(max(0, deadline - time.time()) / 60, 1))
            submit_more()
    out.flush()
    out.close()
    elapsed = max(0.001, time.time() - t0)
    by_source = collections.Counter()
    lengths = collections.defaultdict(list)
    with open(args.out) as f:
        for line in f:
            if not line.strip():
                continue
            row = json.loads(line)
            by_source[row["source"]] += 1
            for message in row["messages"]:
                if message.get("reasoning_content"):
                    lengths[row["reasoning_strength"]].append(len(tok(message["reasoning_content"], add_special_tokens=False)["input_ids"]))
    h = hashlib.sha256()
    with open(args.out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    report = {
        "kept": kept, "by_source": dict(by_source), "rejects": dict(rejects),
        "tokens_per_second": round(tokens / elapsed, 1), "write_seconds": round(elapsed, 1),
        "reasoning_tokens": {k: percentiles(v) for k, v in lengths.items()},
        "sha256": h.hexdigest(), "screen": screen.counts(),
    }
    say("done", **{k: report[k] for k in ("kept", "by_source", "rejects", "tokens_per_second", "write_seconds", "reasoning_tokens", "sha256")})
    with open(args.out + ".report.json", "w") as f:
        json.dump(report, f, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--replay")
    ap.add_argument("--tokenizer")
    ap.add_argument("--ports", default="8000-8007")
    ap.add_argument("--minutes", type=float, default=45)
    ap.add_argument("--target", type=int, default=30000)
    ap.add_argument("--seed", type=int, default=917353)
    ap.add_argument("--concurrency", type=int, default=192)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--check-labels", action="store_true")
    ap.add_argument("--n", type=int, default=1000)
    a = ap.parse_args()
    if a.self_check:
        self_check(a.replay)
        return
    if a.check_labels:
        if not a.out or not a.tokenizer:
            ap.error("--check-labels needs --out and --tokenizer")
        check_labels(a.out, a.tokenizer, a.n, a.seed)
        return
    if not a.out or not a.replay or not a.tokenizer:
        ap.error("need --out, --replay and --tokenizer")
    write_rows(a)


if __name__ == "__main__":
    main()
