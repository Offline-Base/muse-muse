"""A seekable file over one S3 object, so zipfile can read a central directory and single members by range."""
import io
import rawcommon as C


class S3File(io.RawIOBase):
    def __init__(self, c, key):
        self.c, self.key = c, key
        self.size = c.head_object(Bucket=C.BUCKET, Key=key)["ContentLength"]
        self.p = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.p

    def seek(self, o, w=0):
        self.p = o if w == 0 else (self.p + o if w == 1 else self.size + o)
        return self.p

    def read(self, n=-1):
        if n < 0:
            n = self.size - self.p
        if n == 0 or self.p >= self.size:
            return b""
        b = C.get_range(self.c, self.key, self.p, min(self.size - 1, self.p + n - 1))
        self.p += len(b)
        return b
