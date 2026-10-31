"""Decode a slice from the middle of a gzip stream without the bytes before it.

Find a dynamic deflate block by trial, then inflate with the 32 KB history unknown: unknown bytes are NUL, copies carry
them along, and any record still holding a NUL is thrown away. Usage: gz_mid.py <key> <fraction from start> <MB> <out.xml>
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawcommon as common

LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258]
LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]
DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577]
DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]
ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]


class Bad(Exception):
    pass


def build(lengths):
    """A direct lookup table on the reversed code bits. Entry = (symbol << 4) | length, 0 for an unused code."""
    maxb = max(lengths) if lengths else 0
    if maxb == 0:
        raise Bad
    count = [0] * (maxb + 1)
    for l in lengths:
        if l:
            count[l] += 1
    code, nxt = 0, [0] * (maxb + 2)
    left = 1
    for b in range(1, maxb + 1):
        left = left * 2 - count[b]
        if left < 0:
            raise Bad
        code = (code + count[b - 1]) << 1
        nxt[b] = code
    if left != 0 and not (sum(count) == 1):
        raise Bad
    table = [0] * (1 << maxb)
    for sym, l in enumerate(lengths):
        if not l:
            continue
        c = nxt[l]
        nxt[l] += 1
        rev = int(format(c, f"0{l}b")[::-1], 2)
        v = (sym << 4) | l
        for i in range(rev, 1 << maxb, 1 << l):
            table[i] = v
    return table, maxb


class Bits:
    def __init__(self, data, bitpos=0):
        self.d = data
        self.p = bitpos >> 3
        self.buf = 0
        self.n = 0
        if bitpos & 7:
            self.need(8)
            self.drop(bitpos & 7)

    def need(self, k):
        while self.n < k:
            if self.p >= len(self.d):
                raise EOFError
            self.buf |= self.d[self.p] << self.n
            self.p += 1
            self.n += 8

    def drop(self, k):
        self.buf >>= k
        self.n -= k

    def take(self, k):
        self.need(k)
        v = self.buf & ((1 << k) - 1)
        self.drop(k)
        return v

    def pos(self):
        return self.p * 8 - self.n


def dyn_header(b):
    hlit, hdist, hclen = b.take(5) + 257, b.take(5) + 1, b.take(4) + 4
    if hlit > 286 or hdist > 30:
        raise Bad
    cl = [0] * 19
    for i in range(hclen):
        cl[ORDER[i]] = b.take(3)
    ct, cb = build(cl)
    lens = []
    while len(lens) < hlit + hdist:
        b.need(cb)
        e = ct[b.buf & ((1 << cb) - 1)]
        if not e:
            raise Bad
        b.drop(e & 15)
        s = e >> 4
        if s < 16:
            lens.append(s)
        elif s == 16:
            if not lens:
                raise Bad
            lens += [lens[-1]] * (3 + b.take(2))
        elif s == 17:
            lens += [0] * (3 + b.take(3))
        else:
            lens += [0] * (11 + b.take(7))
    if len(lens) != hlit + hdist or lens[256] == 0:
        raise Bad
    return build(lens[:hlit]), build(lens[hlit:])


def inflate_block(b, ltab, dtab, out, limit=None):
    lt, lb = ltab
    dt, db = dtab
    lm, dm = (1 << lb) - 1, (1 << db) - 1
    d, p, buf, n = b.d, b.p, b.buf, b.n
    L = len(d)
    while True:
        while n < 48 and p < L:
            buf |= d[p] << n
            p += 1
            n += 8
        e = lt[buf & lm]
        if not e:
            raise Bad
        l = e & 15
        if l > n:
            raise EOFError
        buf >>= l
        n -= l
        s = e >> 4
        if s < 256:
            out.append(s)
        elif s == 256:
            break
        else:
            s -= 257
            if s > 28:
                raise Bad
            x = LEN_EXTRA[s]
            ln = LEN_BASE[s] + (buf & ((1 << x) - 1))
            buf >>= x
            n -= x
            e = dt[buf & dm]
            if not e:
                raise Bad
            l = e & 15
            buf >>= l
            n -= l
            s = e >> 4
            if s > 29:
                raise Bad
            x = DIST_EXTRA[s]
            dist = DIST_BASE[s] + (buf & ((1 << x) - 1))
            buf >>= x
            n -= x
            if n < 0:
                raise EOFError
            st = len(out) - dist
            if st < 0:
                raise Bad
            if dist >= ln:
                out += out[st:st + ln]
            else:
                for i in range(ln):
                    out.append(out[st + i])
        if limit and len(out) > limit:
            raise Bad
    b.p, b.buf, b.n = p, buf, n


def find_start(data, maxbits):
    for pos in range(maxbits):
        if (data[pos >> 3] >> (pos & 7)) & 7 != 0b100:  # BFINAL 0, BTYPE 2, read low bit first
            continue
        try:
            b = Bits(data, pos)
            b.take(3)
            lt, dt = dyn_header(b)
            out = bytearray(b"\0" * 32768)
            inflate_block(b, lt, dt, out, limit=5_000_000)
            body = out[32768:]
            if len(body) < 2000:
                continue
            printable = sum(1 for c in body[:4000] if c == 0 or 9 <= c <= 126 or c >= 128)
            if printable < 0.98 * min(4000, len(body)):
                continue
            # The next header has to parse as well.
            b2 = Bits(data, b.pos())
            kind = b2.take(3) >> 1
            if kind == 2:
                dyn_header(b2)
            elif kind == 3:
                continue
            return pos
        except (Bad, EOFError, IndexError, ValueError):
            continue
    return None


def main():
    key, frac, mb, outp = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
    c = common.s3()
    size = c.head_object(Bucket=common.BUCKET, Key=key)["ContentLength"]
    a = int(size * frac)
    data = common.get_range(c, key, a, min(size - 1, a + int(mb * 1e6)))
    t0 = time.time()
    pos = find_start(data, 8 * 2_000_000)
    print("start bit", pos, "after", round(time.time() - t0, 1), "s", flush=True)
    if pos is None:
        return
    b = Bits(data, pos)
    out = bytearray(b"\0" * 32768)
    blocks = 0
    try:
        while True:
            head = b.take(3)
            kind = head >> 1
            if head & 1:
                break
            if kind == 2:
                lt, dt = dyn_header(b)
                inflate_block(b, lt, dt, out)
            elif kind == 1:
                ll = [8] * 144 + [9] * 112 + [7] * 24 + [8] * 8
                inflate_block(b, build(ll), build([5] * 30), out)
            elif kind == 0:
                b.drop(b.n & 7)
                ln = b.take(16)
                b.take(16)
                for _ in range(ln):
                    out.append(b.take(8))
            else:
                raise Bad
            blocks += 1
            if len(out) > 400 << 20:
                break
    except (EOFError, Bad, IndexError) as ex:
        print("stopped:", type(ex).__name__, flush=True)
    body = bytes(out[32768:])
    unknown = body.count(0)
    open(outp, "wb").write(body)
    print("blocks", blocks, "out", len(body), "unknown bytes", unknown, "secs", round(time.time() - t0, 1), flush=True)


if __name__ == "__main__":
    main()
