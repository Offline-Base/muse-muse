"""Writes reasoning_probes.jsonl, the items score_reasoning.py asks: about 150 multi-step problems with exact answers and
about 60 general-skill tasks. All generated from a fixed seed, so the answers are computed here (by arithmetic, datetime
or a brute-force solver) and none depends on a 2026 fact. Same seed, same file.

Parts and kinds:
  multistep: arithmetic (2 to 5 steps), calendar, units, logic. Graded on the final answer by exact number, date or option.
             40 of them are marked also_off: asked a second time with reasoning off, to see what reasoning adds.
  hard:      50 harder items (long arithmetic, modular powers, weekdays with no anchor, 8-operation chains, knights and
             knaves), added after a 40-item sample showed base Q4_K_M at 29 of 29 on the multistep part: a test the base
             aces can't show damage. Drawn from their own seed, so the other items don't change.
  skills:    python (run against tests), json (parsed, must match exactly), instructions (checked by code),
             multiturn (a detail from turn 1 is needed in turn 2).

--check runs every python task's reference solution through score_reasoning.py's test runner and every logic puzzle's
solver again, then exits. Reference solutions are mine, not model-written, so --check is safe anywhere.

Usage: python make_reasoning_probes.py [--out reasoning_probes.jsonl] [--seed 20261031] [--check]
"""

import argparse
import datetime as dt
import itertools
import json
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
FORMAT = 'End your reply with a final line in the form "Answer: X".'
NAMES = ["Ana", "Ben", "Cara", "Dev", "Elif", "Finn", "Gita", "Hugo", "Iris", "Jon", "Kira", "Liam", "Mina", "Noor", "Omar", "Pia", "Quinn", "Rosa", "Sam", "Tara"]
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def long_date(d):
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


# Arithmetic word problems: each returns (question, exact answer).

def a2_change(r):
    name, n, p = r.choice(NAMES), r.randint(3, 12), r.randint(2, 9)
    bill = next(b for b in (20, 50, 100, 200) if b > n * p)
    return f"{name} buys {n} notebooks at {p} dollars each and pays with a {bill} dollar bill. How many dollars of change does {name} get?", bill - n * p


def a2_share(r):
    boxes, friends = r.randint(3, 9), r.choice([3, 4, 5, 6, 8])
    each = friends * r.randint(2, 6)
    return f"There are {boxes} boxes with {each} cookies in each box. The cookies are shared equally among {friends} friends. How many cookies does each friend get?", boxes * each // friends


def a2_trip(r):
    speed, hours, more = r.choice([40, 45, 50, 55, 60, 70]), r.randint(2, 6), r.randint(15, 95)
    return f"A van drives at {speed} miles per hour for {hours} hours and then goes another {more} miles on a side road. How many miles does it travel in all?", speed * hours + more


def a3_two_items(r):
    name, n1, p1, n2, p2 = r.choice(NAMES), r.randint(2, 8), r.randint(2, 9), r.randint(2, 8), r.randint(3, 12)
    total = n1 * p1 + n2 * p2
    bill = next(b for b in (50, 100, 200, 500) if b > total)
    return f"{name} buys {n1} apples at {p1} dollars each and {n2} melons at {p2} dollars each, and pays with a {bill} dollar bill. How many dollars of change does {name} get?", bill - total


def a3_savings(r):
    name, w, n, g = r.choice(NAMES), r.randint(5, 25), r.randint(4, 16), r.randint(5, 60)
    s = r.randint(5, min(40, w * n - 1))
    return f"{name} saves {w} dollars a week for {n} weeks, then spends {s} dollars on a game, then receives a gift of {g} dollars. How many dollars does {name} have now?", w * n - s + g


def a3_theatre(r):
    rows, seats = r.randint(8, 25), r.randint(10, 30)
    am, pm = r.randint(10, rows * seats // 3), r.randint(10, rows * seats // 3)
    return f"A theatre has {rows} rows with {seats} seats in each row. {am} seats are sold in the morning and {pm} more in the afternoon. How many seats are still unsold?", rows * seats - am - pm


def a4_boxes(r):
    machines, rate, hours, box = r.randint(3, 8), r.randint(10, 40), r.randint(2, 8), r.choice([6, 8, 12, 15, 20])
    made = machines * rate * hours
    boxes = max(1, made // box - r.randint(1, 5))
    bad = made - boxes * box
    return f"A factory has {machines} machines. Each makes {rate} parts an hour for {hours} hours. {bad} of the parts fail inspection and the rest are packed in boxes of {box}. How many full boxes are packed?", boxes


def a4_eggs(r):
    hens, per, days, price = r.randint(6, 20), r.randint(2, 5), r.randint(6, 14), r.randint(2, 6)
    made = hens * per * days
    dozens = made // 12 - r.randint(1, 3)
    eaten = made - dozens * 12
    return f"A farm has {hens} hens that each lay {per} eggs every 2 days. Over {2 * days} days the family eats {eaten} of the eggs and sells the rest at {price} dollars a dozen. How many dollars do the eggs bring in?", dozens * price


def a4_fuel(r):
    per, price = r.choice([10, 12, 15, 16, 20]), r.randint(2, 5)
    d1 = per * r.randint(3, 15)
    d2 = per * r.randint(3, 15)
    tolls = r.randint(2, 15)
    return f"A car goes {per} km on one liter of fuel. It drives {d1} km on Monday and {d2} km on Tuesday. Fuel costs {price} dollars a liter and tolls cost {tolls} dollars in all. How many dollars does the trip cost in all?", (d1 + d2) // per * price + tolls


def a5_wages(r):
    h1, r1, h2, r2, n = r.randint(10, 30), r.randint(10, 20), r.randint(3, 12), r.randint(21, 35), r.choice([2, 3, 4, 5])
    gross = h1 * r1 + h2 * r2
    rent = r.randint(40, 90)
    left = gross - rent
    tax = left % n + n * r.randint(3, 10)
    return f"{r.choice(NAMES)} works {h1} hours at {r1} dollars an hour and {h2} overtime hours at {r2} dollars an hour. From that pay, {tax} dollars go to tax and {rent} dollars to rent. The rest is split equally among {n} savings accounts. How many dollars go into each account?", (left - tax) // n


def a5_tank(r):
    cap, inflow, t1, out, t2, add = r.randint(400, 900), r.randint(10, 30), r.randint(4, 12), r.randint(5, 15), r.randint(3, 10), r.randint(20, 80)
    now = cap + inflow * t1 - out * t2 + add
    return f"A tank starts with {cap} liters. Water flows in at {inflow} liters a minute for {t1} minutes. Then the inflow stops and water drains at {out} liters a minute for {t2} minutes. Then {add} liters are poured in. How many liters are in the tank now?", now


def a5_bakery(r):
    trays, per, days, unsold, price, cost = r.randint(3, 8), r.randint(6, 12), r.randint(2, 5), r.randint(3, 15), r.randint(2, 5), r.randint(20, 90)
    cost = min(cost, (trays * per * days - unsold) * price - 5)
    return f"A bakery bakes {trays} trays of {per} muffins each day for {days} days. {unsold} muffins go unsold, and the others sell at {price} dollars each. Ingredients cost {cost} dollars in all. How many dollars of profit does it make?", (trays * per * days - unsold) * price - cost


ARITHMETIC = {2: [a2_change, a2_share, a2_trip], 3: [a3_two_items, a3_savings, a3_theatre], 4: [a4_boxes, a4_eggs, a4_fuel], 5: [a5_wages, a5_tank, a5_bakery]}


def random_date(r, lo=1985, hi=2045):
    return dt.date(r.randint(lo, hi), r.randint(1, 12), r.randint(1, 28))


def calendar_items(r):
    out = []
    for _ in range(10):
        d, n = random_date(r), r.randint(5, 400)
        q = f"{long_date(d)} is a {WEEKDAYS[d.weekday()]}. What day of the week is it {n} days later?"
        out.append(("weekday", q, "option", WEEKDAYS[(d + dt.timedelta(days=n)).weekday()], WEEKDAYS))
    for _ in range(10):
        a, n = random_date(r), r.randint(20, 900)
        b = a + dt.timedelta(days=n)
        out.append(("days_between", f"How many days are there from {long_date(a)} to {long_date(b)}? Count the difference between the two dates, not including the first day.", "number", n, None))
    for _ in range(10):
        d, n = random_date(r), r.randint(10, 300)
        out.append(("date_add", f"What date is {n} days after {long_date(d)}? Give it as YYYY-MM-DD.", "date", (d + dt.timedelta(days=n)).isoformat(), None))
    for y in r.sample([1900, 2000, 2024, 2028, 2100, 2032, 2023, 2027], 5):
        day = r.randint(10, 26)
        n = r.randint(8, 25)
        q = f"Using the Gregorian calendar's leap-year rule, what date is {n} days after February {day}, {y}? Give it as YYYY-MM-DD."
        out.append(("leap", q, "date", (dt.date(y, 2, day) + dt.timedelta(days=n)).isoformat(), None))
    return out


def unit_items(r):
    out = []
    for _ in range(5):
        h, m, s = r.randint(1, 9), r.randint(1, 59), r.randint(1, 59)
        out.append(("time", f"How many seconds are in {h} hours, {m} minutes and {s} seconds?", h * 3600 + m * 60 + s))
    for _ in range(5):
        km, m = r.randint(1, 40), r.randint(1, 999)
        out.append(("length", f"A trail is {km} km and {m} m long. How many centimeters long is it?", (km * 1000 + m) * 100))
    for _ in range(5):
        y, f, i = r.randint(1, 30), r.randint(1, 2), r.randint(1, 11)
        out.append(("imperial", f"A rope is {y} yards, {f} feet and {i} inches long. How many inches long is it?", y * 36 + f * 12 + i))
    for _ in range(5):
        ml = r.choice([250, 330, 500, 750])
        n = 100 * r.randint(1, 12)
        add = r.randint(1, 20)
        out.append(("volume", f"A pallet holds {n} bottles of {ml} ml each, and a jug next to it holds {add} liters. How many liters is that in all?", n * ml // 1000 + add))
    for _ in range(5):
        v = 18 * r.randint(1, 12)
        t = r.randint(5, 60)
        out.append(("speed", f"A train moves at {v} km/h. How many meters does it travel in {t} seconds?", v * 1000 // 3600 * t))
    for _ in range(5):
        kg, g = r.randint(2, 30), r.choice([125, 200, 250, 500])
        out.append(("mass", f"{kg} kg of flour is divided into packs of {g} grams each. How many packs is that?", kg * 1000 // g))
    return out


def order_puzzle(r, names):
    """A full ranking given as shuffled adjacent comparisons: unique by construction, confirmed by solver in unique_order()."""
    trait, more = r.choice([("height", "taller"), ("age", "older"), ("speed", "faster")])
    ranking = r.sample(names, len(names))
    clues = [f"{ranking[i]} is {more} than {ranking[i + 1]}." for i in range(len(ranking) - 1)]
    r.shuffle(clues)
    pos = r.randint(1, len(ranking))
    word = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth"}[pos]
    q = f"{' '.join(clues)} If the people are ranked from most to least by {trait}, who is {word}?"
    check = lambda perm: all(perm.index(ranking[i]) < perm.index(ranking[i + 1]) for i in range(len(ranking) - 1))
    return q, ranking[pos - 1], check, lambda perm: perm[pos - 1]


def row_puzzle(r, names):
    """Four people in a row, seats 1 to 4. Adds clues until the solver finds one seating."""
    seating = r.sample(names, 4)
    clues, tests = [], []
    def add_left():
        a, b = r.sample(range(4), 2)
        if a > b:
            a, b = b, a
        return f"{seating[a]} sits somewhere to the left of {seating[b]}.", (lambda p, x=seating[a], y=seating[b]: p.index(x) < p.index(y))
    def add_next():
        a = r.randint(0, 2)
        return f"{seating[a]} sits next to {seating[a + 1]}.", (lambda p, x=seating[a], y=seating[a + 1]: abs(p.index(x) - p.index(y)) == 1)
    def add_not_end():
        a = r.choice([1, 2])
        return f"{seating[a]} is not at either end of the row.", (lambda p, x=seating[a]: p.index(x) in (1, 2))
    def add_seat():
        a = r.randint(0, 3)
        return f"{seating[a]} is in seat {a + 1}.", (lambda p, x=seating[a], s=a: p.index(x) == s)
    makers = [add_left, add_next, add_not_end, add_left, add_next, add_left, add_next, add_seat]
    for make in makers:
        text, test = make()
        if text not in clues:
            clues.append(text)
            tests.append(test)
        if sum(all(t(p) for t in tests) for p in itertools.permutations(names)) == 1:
            break
    while sum(all(t(p) for t in tests) for p in itertools.permutations(names)) != 1:
        text, test = add_seat()
        clues.append(text)
        tests.append(test)
    r.shuffle(clues)
    # Ask about a seat no clue gives away.
    free = [i for i in range(4) if f"{seating[i]} is in seat {i + 1}." not in clues] or [0]
    seat = r.choice(free)
    q = f"{', '.join(names)} sit in a row of four seats numbered 1 to 4 from left to right. {' '.join(clues)} Who is in seat {seat + 1}?"
    return q, seating[seat], lambda p: all(t(p) for t in tests), lambda p: p[seat]


def culprit_puzzle(r, names):
    """Three suspects, one did it, exactly one statement is true; drawn until the solver finds exactly one culprit."""
    while True:
        statements = []
        for speaker in names:
            other = r.choice([n for n in names if n != speaker])
            statements.append((speaker, other, r.choice([True, False])))
        solutions = [c for c in names if sum((c == o) == pos for _, o, pos in statements) == 1]
        if len(solutions) == 1:
            break
    lines = [f'{s} says "{o} did it."' if pos else f'{s} says "{o} did not do it."' for s, o, pos in statements]
    q = f"One of {names[0]}, {names[1]} and {names[2]} broke the window. {' '.join(lines)} Exactly one of these three statements is true. Who broke the window?"
    return q, solutions[0], None, None


def pets_puzzle(r, names):
    """Three people, three pets. Only "does not own" clues, added until one assignment is left, so it takes elimination."""
    pets = ["cat", "dog", "parrot"]
    owner = dict(zip(pets, r.sample(names, 3)))
    facts = [(n, pet) for pet in pets for n in names if n != owner[pet]]
    r.shuffle(facts)
    clues, tests = [], []
    for wrong, pet in facts:
        clues.append(f"{wrong} does not own the {pet}.")
        tests.append(lambda p, x=wrong, y=pet: p[pets.index(y)] != x)
        if sum(all(t(p) for t in tests) for p in itertools.permutations(names)) == 1:
            break
    asked = r.choice(pets)
    q = f"{names[0]}, {names[1]} and {names[2]} each own exactly one pet: a cat, a dog and a parrot, one each. {' '.join(clues)} Who owns the {asked}?"
    return q, owner[asked], lambda p: all(t(p) for t in tests), lambda p: p[pets.index(asked)]


def logic_items(r):
    out = []
    for kind, make, count, people in (("ranking", order_puzzle, 8, 5), ("seating", row_puzzle, 7, 4), ("culprit", culprit_puzzle, 5, 3), ("pets", pets_puzzle, 5, 3)):
        for _ in range(count):
            names = r.sample(NAMES, people)
            q, answer, valid, read = make(r, names)
            if valid:
                solutions = {read(p) for p in itertools.permutations(names) if valid(p)}
                if solutions != {answer}:
                    raise RuntimeError(f"puzzle has answers {solutions}, expected {answer}: {q}")
            out.append((kind, f"{q} Options: {', '.join(sorted(names))}.", answer, sorted(names)))
    return out


PYTHON_TASKS = [
    ("rle_encode", "rle_encode(s)", 'returns the run-length encoding of string s, each character followed by its count, so "aaabcc" gives "a3b1c2" and "" gives ""',
     ['rle_encode("aaabcc") == "a3b1c2"', 'rle_encode("") == ""', 'rle_encode("z") == "z1"', 'rle_encode("aabbaa") == "a2b2a2"'],
     "def rle_encode(s):\n    out, i = [], 0\n    while i < len(s):\n        j = i\n        while j < len(s) and s[j] == s[i]:\n            j += 1\n        out.append(s[i] + str(j - i))\n        i = j\n    return ''.join(out)"),
    ("to_roman", "to_roman(n)", "returns the Roman numeral for an integer n from 1 to 3999, in uppercase and standard subtractive form",
     ['to_roman(4) == "IV"', 'to_roman(9) == "IX"', 'to_roman(1994) == "MCMXCIV"', 'to_roman(3888) == "MMMDCCCLXXXVIII"', 'to_roman(40) == "XL"'],
     "def to_roman(n):\n    t = [(1000,'M'),(900,'CM'),(500,'D'),(400,'CD'),(100,'C'),(90,'XC'),(50,'L'),(40,'XL'),(10,'X'),(9,'IX'),(5,'V'),(4,'IV'),(1,'I')]\n    out = ''\n    for v, s in t:\n        while n >= v:\n            out += s\n            n -= v\n    return out"),
    ("is_balanced", "is_balanced(s)", "returns True if the brackets ()[]{} in string s are balanced and correctly nested, ignoring all other characters, else False",
     ['is_balanced("([]{})") is True', 'is_balanced("([)]") is False', 'is_balanced("a(b)c") is True', 'is_balanced("(") is False', 'is_balanced("") is True', 'is_balanced(")(") is False'],
     "def is_balanced(s):\n    st, m = [], {')':'(',']':'[','}':'{'}\n    for c in s:\n        if c in '([{':\n            st.append(c)\n        elif c in m:\n            if not st or st.pop() != m[c]:\n                return False\n    return not st"),
    ("flatten", "flatten(lst)", "takes a list that may contain nested lists to any depth and returns a flat list of all the non-list items, in order",
     ["flatten([1, [2, [3, [4]]], 5]) == [1, 2, 3, 4, 5]", "flatten([]) == []", "flatten([[], [[]], 1]) == [1]", 'flatten(["a", ["b"]]) == ["a", "b"]'],
     "def flatten(lst):\n    out = []\n    for x in lst:\n        if isinstance(x, list):\n            out.extend(flatten(x))\n        else:\n            out.append(x)\n    return out"),
    ("word_freq", "word_freq(text)", "returns a dict counting each word in text, lowercased, where a word is a maximal run of ASCII letters",
     ['word_freq("The cat, the DOG!") == {"the": 2, "cat": 1, "dog": 1}', 'word_freq("") == {}', 'word_freq("a1b") == {"a": 1, "b": 1}'],
     "import re\ndef word_freq(text):\n    out = {}\n    for w in re.findall(r'[a-zA-Z]+', text):\n        w = w.lower()\n        out[w] = out.get(w, 0) + 1\n    return out"),
    ("merge_intervals", "merge_intervals(intervals)", "takes a list of [start, end] pairs and returns the merged overlapping intervals sorted by start; intervals that touch at an endpoint count as overlapping",
     ["merge_intervals([[1, 3], [2, 6], [8, 10]]) == [[1, 6], [8, 10]]", "merge_intervals([]) == []", "merge_intervals([[5, 6], [1, 2], [2, 3]]) == [[1, 3], [5, 6]]", "merge_intervals([[1, 10], [2, 3]]) == [[1, 10]]"],
     "def merge_intervals(intervals):\n    out = []\n    for a, b in sorted(intervals):\n        if out and a <= out[-1][1]:\n            out[-1][1] = max(out[-1][1], b)\n        else:\n            out.append([a, b])\n    return out"),
    ("second_largest", "second_largest(nums)", "returns the second largest distinct value in a list of numbers, or None if there isn't one",
     ["second_largest([3, 1, 3, 2]) == 2", "second_largest([5]) is None", "second_largest([2, 2]) is None", "second_largest([-1, -5, -3]) == -3"],
     "def second_largest(nums):\n    s = sorted(set(nums))\n    return s[-2] if len(s) > 1 else None"),
    ("caesar", "caesar(s, k)", "shifts each ASCII letter in s forward by k places in the alphabet, wrapping around and keeping its case; other characters stay; k may be negative or larger than 26",
     ['caesar("abc", 1) == "bcd"', 'caesar("XyZ", 3) == "AbC"', 'caesar("Hi, you!", 26) == "Hi, you!"', 'caesar("b", -3) == "y"', 'caesar("a-z", 53) == "b-a"'],
     "def caesar(s, k):\n    out = ''\n    for c in s:\n        if 'a' <= c <= 'z':\n            out += chr((ord(c) - 97 + k) % 26 + 97)\n        elif 'A' <= c <= 'Z':\n            out += chr((ord(c) - 65 + k) % 26 + 65)\n        else:\n            out += c\n    return out"),
    ("primes_upto", "primes_upto(n)", "returns a sorted list of all primes less than or equal to n",
     ["primes_upto(10) == [2, 3, 5, 7]", "primes_upto(1) == []", "primes_upto(2) == [2]", "primes_upto(30)[-1] == 29", "len(primes_upto(1000)) == 168"],
     "def primes_upto(n):\n    return [p for p in range(2, n + 1) if all(p % d for d in range(2, int(p ** 0.5) + 1))]"),
    ("chunk", "chunk(lst, n)", "splits lst into consecutive sublists of length n, the last one possibly shorter",
     ["chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]", "chunk([], 3) == []", "chunk([1, 2], 5) == [[1, 2]]"],
     "def chunk(lst, n):\n    return [lst[i:i + n] for i in range(0, len(lst), n)]"),
    ("dedupe", "dedupe(lst)", "returns lst with repeats removed, keeping the first occurrence of each item and the original order; items may be unhashable lists",
     ["dedupe([3, 1, 3, 2, 1]) == [3, 1, 2]", "dedupe([]) == []", "dedupe([[1], [1], [2]]) == [[1], [2]]"],
     "def dedupe(lst):\n    out = []\n    for x in lst:\n        if x not in out:\n            out.append(x)\n    return out"),
    ("transpose", "transpose(m)", "returns the transpose of a rectangular matrix given as a list of row lists; an empty matrix gives []",
     ["transpose([[1, 2, 3], [4, 5, 6]]) == [[1, 4], [2, 5], [3, 6]]", "transpose([]) == []", "transpose([[1]]) == [[1]]"],
     "def transpose(m):\n    return [list(r) for r in zip(*m)]"),
    ("binary_search", "binary_search(a, x)", "returns the index of the first occurrence of x in the sorted list a, or -1 if x is absent; it must find the first of any duplicates",
     ["binary_search([1, 3, 5], 3) == 1", "binary_search([1, 3, 5], 4) == -1", "binary_search([], 1) == -1", "binary_search([2, 2, 2, 3], 2) == 0"],
     "def binary_search(a, x):\n    lo, hi = 0, len(a)\n    while lo < hi:\n        mid = (lo + hi) // 2\n        if a[mid] < x:\n            lo = mid + 1\n        else:\n            hi = mid\n    return lo if lo < len(a) and a[lo] == x else -1"),
    ("anagram_groups", "anagram_groups(words)", "groups the words that are anagrams of each other; each group is a sorted list and the groups are sorted by their first word",
     ['anagram_groups(["tea", "bat", "eat", "tab"]) == [["bat", "tab"], ["eat", "tea"]]', "anagram_groups([]) == []", 'anagram_groups(["a"]) == [["a"]]'],
     "def anagram_groups(words):\n    g = {}\n    for w in words:\n        g.setdefault(''.join(sorted(w)), []).append(w)\n    return sorted(sorted(v) for v in g.values())"),
    ("common_prefix", "common_prefix(strs)", "returns the longest common prefix of a list of strings, or an empty string for an empty list",
     ['common_prefix(["flower", "flow", "flight"]) == "fl"', 'common_prefix(["a", "b"]) == ""', 'common_prefix([]) == ""', 'common_prefix(["same", "same"]) == "same"'],
     "import os\ndef common_prefix(strs):\n    return os.path.commonprefix(strs) if strs else ''"),
    ("digit_root", "digit_root(n)", "repeatedly sums the decimal digits of a non-negative integer n until one digit is left, and returns it",
     ["digit_root(9875) == 2", "digit_root(0) == 0", "digit_root(18) == 9", "digit_root(10 ** 20) == 1"],
     "def digit_root(n):\n    while n > 9:\n        n = sum(map(int, str(n)))\n    return n"),
    ("snake_to_camel", "snake_to_camel(s)", 'converts a snake_case string to camelCase, so "max_retry_count" gives "maxRetryCount"; repeated underscores count as one',
     ['snake_to_camel("max_retry_count") == "maxRetryCount"', 'snake_to_camel("word") == "word"', 'snake_to_camel("a__b") == "aB"'],
     "def snake_to_camel(s):\n    p = [x for x in s.split('_') if x]\n    return p[0] + ''.join(x.capitalize() for x in p[1:]) if p else ''"),
    ("days_in_month", "days_in_month(year, month)", "returns the number of days in the given month of the given year under the Gregorian leap-year rule, without importing any module",
     ["days_in_month(2024, 2) == 29", "days_in_month(1900, 2) == 28", "days_in_month(2000, 2) == 29", "days_in_month(2023, 4) == 30", "days_in_month(2023, 12) == 31"],
     "def days_in_month(year, month):\n    if month == 2:\n        return 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28\n    return 30 if month in (4, 6, 9, 11) else 31"),
    ("two_sum", "two_sum(nums, target)", "returns the pair of indices [i, j] with i < j whose values add up to target, the pair with the smallest i and then the smallest j, or None if there is none",
     ["two_sum([2, 7, 11, 15], 9) == [0, 1]", "two_sum([3, 3], 6) == [0, 1]", "two_sum([1, 2], 7) is None", "two_sum([1, 5, 3, 3], 6) == [1, 3] or two_sum([1, 5, 3, 3], 6) == [0, 1]"],
     "def two_sum(nums, target):\n    for i in range(len(nums)):\n        for j in range(i + 1, len(nums)):\n            if nums[i] + nums[j] == target:\n                return [i, j]\n    return None"),
    ("rotate_list", "rotate_list(lst, k)", "rotates a list right by k places and returns a new list; k may be larger than the length, and an empty list gives an empty list",
     ["rotate_list([1, 2, 3, 4], 1) == [4, 1, 2, 3]", "rotate_list([1, 2, 3], 7) == [3, 1, 2]", "rotate_list([], 3) == []"],
     "def rotate_list(lst, k):\n    if not lst:\n        return []\n    k %= len(lst)\n    return lst[-k:] + lst[:-k] if k else lst[:]"),
]


def python_items():
    out = []
    for name, sig, desc, tests, ref in PYTHON_TASKS:
        q = f"Write a Python function `{sig}` that {desc}. Reply with the code in one ```python code block."
        out.append({"kind": "python", "question": q, "function": name, "tests": tests, "reference": ref})
    return out


def json_items(r):
    out = []
    only = "Reply with only the JSON, with no code fence and no other text."
    cities = ["Oslo", "Lima", "Hanoi", "Accra", "Quito", "Perth", "Tunis", "Riga"]
    jobs = ["nurse", "welder", "pilot", "baker", "teacher", "plumber"]
    for _ in range(5):
        name, age, city, job = r.choice(NAMES) + " " + r.choice(["Lopez", "Okafor", "Novak", "Sato", "Haddad"]), r.randint(19, 80), r.choice(cities), r.choice(jobs)
        out.append({"question": f'{name} is a {age}-year-old {job} who lives in {city}. Give a JSON object with exactly the keys "name" (string), "age" (integer) and "city" (string). {only}',
                    "expect": {"name": name, "age": age, "city": city}})
    for _ in range(3):
        n, step = r.randint(4, 8), r.randint(3, 9)
        out.append({"question": f"Give a JSON array of the first {n} positive multiples of {step}, in increasing order. {only}", "expect": [step * (i + 1) for i in range(n)]})
    for _ in range(4):
        title, year = r.choice(["River Notes", "Stone Garden", "Blue Harbor", "Night Trains", "Paper Birds"]), r.randint(1950, 2020)
        out.append({"question": f'Give a JSON object for a book titled "{title}" from {year}, with exactly the keys "title" (string), "tags" (a list of exactly 3 strings that you choose) and "meta" (an object with exactly the keys "year", an integer, and "draft", the boolean false). {only}',
                    "expect": {"title": title, "tags": {"$list_of": "str", "$len": 3}, "meta": {"year": year, "draft": False}}})
    for _ in range(3):
        nums = r.sample(range(2, 40), 4)
        out.append({"question": f'For the numbers {nums}, give a JSON object with exactly the keys "sum", "max" and "sorted" (the numbers in increasing order). {only}',
                    "expect": {"sum": sum(nums), "max": max(nums), "sorted": sorted(nums)}})
    return [{"kind": "json", **x} for x in out]


def instruction_items():
    """Fifteen tasks, each with a check in score_reasoning.py's check_instruction()."""
    return [{"kind": "instructions", **x} for x in [
        {"question": "Explain why the sky is blue in at most 15 words.", "check": "max_words", "n": 15},
        {"question": "Describe what a volcano is in at most 12 words.", "check": "max_words", "n": 12},
        {"question": "Say what photosynthesis does in at most 10 words.", "check": "max_words", "n": 10},
        {"question": 'Give one tip for learning to ride a bicycle. Your reply must include the exact phrase "steady as a rock".', "check": "phrase", "text": "steady as a rock"},
        {"question": 'Write two sentences about bread. Your reply must include the exact phrase "golden crust".', "check": "phrase", "text": "golden crust"},
        {"question": "List exactly 4 kinds of tree as bullet points, each line starting with \"- \". Write nothing else.", "check": "bullets", "n": 4},
        {"question": "List exactly 3 primary colors of paint as bullet points, each line starting with \"- \". Write nothing else.", "check": "bullets", "n": 3},
        {"question": "List exactly 5 ocean animals as bullet points, each line starting with \"- \". Write nothing else.", "check": "bullets", "n": 5},
        {"question": "Describe a thunderstorm in two sentences using only lowercase letters, with no capital letters at all.", "check": "lowercase"},
        {"question": "Describe a library in one sentence using only lowercase letters, with no capital letters at all.", "check": "lowercase"},
        {"question": 'Describe the ocean in two sentences without using the word "water".', "check": "forbid", "text": "water"},
        {"question": 'Describe a dog in two sentences without using the word "pet" or the word "animal".', "check": "forbid", "text": "pet|animal"},
        {"question": 'Explain what a compass is. Your reply must begin with the word "Certainly".', "check": "starts", "text": "Certainly"},
        {"question": 'Write one sentence about mountains. The very last words of your reply must be "and that is all."', "check": "ends", "text": "and that is all."},
        {"question": "Explain how a lever works in exactly 2 sentences.", "check": "sentences", "n": 2},
    ]]


def multiturn_items(r):
    out = []
    ack = "Got it, thanks for telling me."
    for _ in range(2):
        pet, age, add = r.choice(["Biscuit", "Pepper", "Mochi", "Juniper"]), r.randint(2, 9), r.randint(2, 6)
        out.append({"first": f"My dog is called {pet} and she is {age} years old.", "second": f"What is my dog's name, and how old will she be in {add} years?", "needs": [pet, str(age + add)]})
    for _ in range(2):
        room, floor = r.randint(101, 480), r.randint(2, 9)
        out.append({"first": f"For my trip, I'm in hotel room {room} on floor {floor}.", "second": "Remind me which room and floor I'm on.", "needs": [str(room), str(floor)]})
    for _ in range(2):
        a, n, p = r.choice(["Kestrel", "Falcon", "Heron"]), r.randint(3, 9), r.randint(4, 9)
        out.append({"first": f"Our team is named {a}. We ordered {n} pizzas at {p} dollars each.", "second": "What is our team's name, and how many dollars did the pizzas cost in all?", "needs": [a, str(n * p)]})
    for _ in range(2):
        city, food = r.choice(["Porto", "Nairobi", "Busan"]), r.choice(["peanuts", "shellfish", "sesame"])
        out.append({"first": f"I'm visiting {city} next spring. I'm allergic to {food}.", "second": "Which food should I avoid when I eat out there, and which city did I say I'm visiting?", "needs": [city, food]})
    for _ in range(2):
        code, last = r.randint(1000, 9999), r.choice(["Marsh", "Vale", "Brook"])
        out.append({"first": f"My booking code is {code} and it is under the surname {last}.", "second": "Please repeat my booking code and surname back to me.", "needs": [str(code), last]})
    return [{"kind": "multiturn", "question": x["second"], "turns": [x["first"], ack, x["second"]], "needs": x["needs"]} for x in out]


def hard_items(r):
    out = []
    for _ in range(15):
        a, b, c, d, e = r.randint(120, 989), r.randint(120, 989), r.randint(12, 98), r.randint(120, 989), r.randint(1000, 9999)
        out.append(("long_arith", f"Compute {a} x {b} + {c} x {d} - {e}.", "number", a * b + c * d - e, None))
    for _ in range(5):
        base, power, mod = r.randint(3, 19), r.randint(11, 40), r.choice([7, 11, 13, 17, 19, 23])
        if base % mod == 0:
            base += 1
        out.append(("mod_power", f"What is the remainder when {base} to the power {power} is divided by {mod}?", "number", pow(base, power, mod), None))
    for _ in range(10):
        d = dt.date(r.randint(1950, 2099), r.randint(1, 12), r.randint(1, 28))
        out.append(("weekday_cold", f"Using the Gregorian calendar, what day of the week is {long_date(d)}? Work it out, for example with Zeller's congruence.", "option", WEEKDAYS[d.weekday()], WEEKDAYS))
    for _ in range(10):
        x = r.randint(20, 90)
        words, value = [f"Start with {x}."], x
        for _ in range(8):
            op = r.choice(["add", "sub", "mul", "div"])
            if op == "div":
                divs = [k for k in (2, 3, 4, 5, 6, 7) if value % k == 0]
                if not divs:
                    op = "add"
                else:
                    k = r.choice(divs)
                    value //= k
                    words.append(f"Divide by {k}.")
            if op == "mul":
                k = r.randint(2, 6)
                value *= k
                words.append(f"Multiply by {k}.")
            elif op == "add":
                k = r.randint(7, 97)
                value += k
                words.append(f"Add {k}.")
            elif op == "sub":
                k = r.randint(3, max(4, min(97, value - 1)))
                value -= k
                words.append(f"Subtract {k}.")
        out.append(("chain", " ".join(words) + " What number do you end with?", "number", value, None))
    done = 0
    while done < 10:
        names = r.sample(NAMES, 4)
        truth = {n: r.random() < 0.5 for n in names}
        said = []
        for sp in names:
            kind = r.choice(["type", "same", "count"])
            others = [n for n in names if n != sp]
            if kind == "type":
                o = r.choice(others)
                claim = r.random() < 0.5
                said.append((sp, f"{o} is a {'knight' if claim else 'knave'}", lambda w, o=o, claim=claim: w[o] == claim))
            elif kind == "same":
                x, y = r.sample(others, 2)
                said.append((sp, f"{x} and {y} are the same type", lambda w, x=x, y=y: w[x] == w[y]))
            else:
                k = r.randint(1, 3)
                said.append((sp, f"exactly {k} of us are knights", lambda w, k=k: sum(w.values()) == k))
        worlds = [dict(zip(names, v)) for v in itertools.product([True, False], repeat=4)]
        good = [w for w in worlds if all(w[sp] == f(w) for sp, _, f in said)]
        if len(good) != 1:
            continue
        lines = " ".join(f'{sp} says "{text}."' for sp, text, _ in said)
        q = f"On an island, knights always tell the truth and knaves always lie. {', '.join(names)} each is a knight or a knave. {lines} How many of the four are knights?"
        out.append(("knights", q, "number", sum(good[0].values()), None))
        done += 1
    return out


def build(seed):
    r = random.Random(seed)
    multistep = []
    for steps, makers in ARITHMETIC.items():
        for i in range(15):
            q, answer = makers[i % 3](r)
            multistep.append({"kind": "arithmetic", "subkind": f"{steps}-step", "steps": steps, "question": f"{q} {FORMAT}", "answer_type": "number", "answer": answer})
    for sub, q, typ, answer, options in calendar_items(r):
        multistep.append({"kind": "calendar", "subkind": sub, "question": f"{q} {FORMAT}", "answer_type": typ, "answer": answer, **({"options": options} if options else {})})
    for sub, q, answer in unit_items(r):
        multistep.append({"kind": "units", "subkind": sub, "question": f"{q} {FORMAT}", "answer_type": "number", "answer": answer})
    for sub, q, answer, options in logic_items(r):
        multistep.append({"kind": "logic", "subkind": sub, "question": f"{q} {FORMAT}", "answer_type": "option", "answer": answer, "options": options})
    for i, it in enumerate(multistep):
        it["id"], it["part"] = f"ms-{i:03d}", "multistep"
    # The 40 asked again with reasoning off, in proportion to each kind.
    off = {"arithmetic": 16, "calendar": 9, "units": 8, "logic": 7}
    for kind, count in off.items():
        for it in r.sample([x for x in multistep if x["kind"] == kind], count):
            it["also_off"] = True
    skills = python_items() + json_items(r) + instruction_items() + multiturn_items(r)
    for i, it in enumerate(skills):
        it["id"], it["part"] = f"sk-{i:03d}", "skills"
    hard = []
    for i, (sub, q, typ, answer, options) in enumerate(hard_items(random.Random(seed + 1))):
        hard.append({"id": f"hd-{i:03d}", "part": "hard", "kind": "hard", "subkind": sub, "question": f"{q} {FORMAT}", "answer_type": typ, "answer": answer, **({"options": options} if options else {})})
    return multistep + skills + hard


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "reasoning_probes.jsonl"))
    ap.add_argument("--seed", type=int, default=20261031)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    items = build(a.seed)
    if a.check:
        import sys
        sys.path.insert(0, HERE)
        from score_reasoning import run_python_tests
        bad = 0
        for it in items:
            if it["kind"] == "python":
                res = run_python_tests("```python\n" + it["reference"] + "\n```", it, allow=True)
                if not res["right"]:
                    bad += 1
                    print("REFERENCE FAILS", it["function"], res)
        print(f"{sum(it['kind'] == 'python' for it in items)} python references checked, {bad} failed; sandbox {res.get('sandbox')}")
        return
    with open(a.out, "w") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    counts = {}
    for it in items:
        counts[it["kind"]] = counts.get(it["kind"], 0) + 1
    print(json.dumps({"total": len(items), "off": sum(bool(it.get("also_off")) for it in items), "kinds": counts}))


if __name__ == "__main__":
    main()
