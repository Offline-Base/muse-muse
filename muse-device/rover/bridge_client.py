#!/usr/bin/env python3
"""Calls a function the rover's sketch provides, through the UNO Q's arduino-router, from the board's Linux side.

Standard library only, since the board's python3 has no msgpack module. The router speaks MessagePack-RPC on a Unix socket:
a request is [0, msgid, method, params], its response [1, msgid, error, result], and a notification [2, method, params]. The
microcontroller registers its functions with Bridge.provide, and the router passes each call to whoever registered its name.

  python3 bridge_client.py status
  python3 bridge_client.py drive 120 120 500

Each call opens its own connection, so calls from several of server.py's threads never share one.
"""
import collections
import itertools
import json
import socket
import struct
import sys
import time

SOCKET_PATH = "/var/run/arduino-router.sock"
DEFAULT_TIMEOUT_S = 3
# The sketch answers in a few hundred bytes. A message far past that is never one to wait for.
MAX_MESSAGE_BYTES = 1024 * 1024
MAX_DEPTH = 32
REQUEST, RESPONSE, NOTIFICATION = 0, 1, 2

# A MessagePack extension value: its type code (-128 to 127) and its bytes. Nothing on the rover sends one, but a decoder
# that met one would otherwise fail on the whole message.
Ext = collections.namedtuple("Ext", "code data")

_ids = itertools.count(1)


class BridgeError(Exception):
    """A call that got no answer, or an error for one, in plain words."""


class MsgpackError(ValueError):
    """Bytes that aren't MessagePack, or a value MessagePack can't hold."""


class Incomplete(MsgpackError):
    """The bytes end partway through a value, so more are needed."""


# Numbers of a fixed size, by their first byte.
FIXED = {0xCA: ">f", 0xCB: ">d", 0xCC: ">B", 0xCD: ">H", 0xCE: ">I", 0xCF: ">Q", 0xD0: ">b", 0xD1: ">h", 0xD2: ">i", 0xD3: ">q"}
# Values whose length comes after the first byte, and that length's format.
SIZED = {
    0xC4: ("bin", ">B"), 0xC5: ("bin", ">H"), 0xC6: ("bin", ">I"),
    0xC7: ("ext", ">B"), 0xC8: ("ext", ">H"), 0xC9: ("ext", ">I"),
    0xD9: ("str", ">B"), 0xDA: ("str", ">H"), 0xDB: ("str", ">I"),
    0xDC: ("array", ">H"), 0xDD: ("array", ">I"),
    0xDE: ("map", ">H"), 0xDF: ("map", ">I"),
}
FIXEXT_SIZES = {0xD4: 1, 0xD5: 2, 0xD6: 4, 0xD7: 8, 0xD8: 16}
FIXEXT_CODES = {size: code for code, size in FIXEXT_SIZES.items()}


def packb(value):
    """value as MessagePack: None, bools, ints, floats, str, bytes, lists and tuples, dicts, and Ext."""
    out = bytearray()
    _pack(value, out, 0)
    return bytes(out)


def _pack_length(n, small, codes, out):
    """A length in the smallest form: inside the first byte up to small, then 8, 16 or 32 bits."""
    if small and n < small[1]:
        out.append(small[0] | n)
        return
    for code, fmt, limit in codes:
        if n < limit:
            out.append(code)
            out += struct.pack(fmt, n)
            return
    raise MsgpackError(f"{n} is too long for MessagePack.")


def _pack(value, out, depth):
    if depth > MAX_DEPTH:
        raise MsgpackError(f"Values nested deeper than {MAX_DEPTH} aren't sent.")
    # Before int, since True and False are ints to Python.
    if value is None:
        out.append(0xC0)
    elif value is False:
        out.append(0xC2)
    elif value is True:
        out.append(0xC3)
    elif isinstance(value, int):
        _pack_int(value, out)
    elif isinstance(value, float):
        out.append(0xCB)
        out += struct.pack(">d", value)
    elif isinstance(value, str):
        data = value.encode("utf-8")
        _pack_length(len(data), (0xA0, 32), ((0xD9, ">B", 2**8), (0xDA, ">H", 2**16), (0xDB, ">I", 2**32)), out)
        out += data
    elif isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        _pack_length(len(data), None, ((0xC4, ">B", 2**8), (0xC5, ">H", 2**16), (0xC6, ">I", 2**32)), out)
        out += data
    elif isinstance(value, Ext):
        if not -128 <= value.code <= 127:
            raise MsgpackError("An extension's code must be from -128 to 127.")
        data = bytes(value.data)
        if len(data) in FIXEXT_CODES:
            out.append(FIXEXT_CODES[len(data)])
        else:
            _pack_length(len(data), None, ((0xC7, ">B", 2**8), (0xC8, ">H", 2**16), (0xC9, ">I", 2**32)), out)
        out += struct.pack(">b", value.code) + data
    elif isinstance(value, (list, tuple)):
        _pack_length(len(value), (0x90, 16), ((0xDC, ">H", 2**16), (0xDD, ">I", 2**32)), out)
        for item in value:
            _pack(item, out, depth + 1)
    elif isinstance(value, dict):
        _pack_length(len(value), (0x80, 16), ((0xDE, ">H", 2**16), (0xDF, ">I", 2**32)), out)
        for key, item in value.items():
            _pack(key, out, depth + 1)
            _pack(item, out, depth + 1)
    else:
        raise MsgpackError(f"MessagePack can't hold a {type(value).__name__}.")


def _pack_int(value, out):
    if 0 <= value < 0x80:
        out.append(value)
    elif -32 <= value < 0:
        out.append(value & 0xFF)
    else:
        sizes = ((0xCC, ">B", 0, 2**8), (0xCD, ">H", 0, 2**16), (0xCE, ">I", 0, 2**32), (0xCF, ">Q", 0, 2**64))
        if value < 0:
            sizes = ((0xD0, ">b", -(2**7), 0), (0xD1, ">h", -(2**15), 0), (0xD2, ">i", -(2**31), 0), (0xD3, ">q", -(2**63), 0))
        for code, fmt, low, high in sizes:
            if low <= value < high:
                out.append(code)
                out += struct.pack(fmt, value)
                return
        raise MsgpackError(f"{value} doesn't fit in 64 bits.")


def unpackb(data):
    """The one value in data. Raises MsgpackError for anything else, Incomplete when data stops short."""
    data = bytes(data)
    value, end = _unpack(data, 0, 0)
    if end != len(data):
        raise MsgpackError(f"{len(data) - end} bytes follow the value.")
    return value


def _take(data, pos, n):
    if pos + n > len(data):
        raise Incomplete("The bytes end partway through a value.")
    return data[pos : pos + n], pos + n


def _unpack(data, pos, depth):
    """The value starting at pos, and where the next one starts."""
    if depth > MAX_DEPTH:
        raise MsgpackError(f"Values nested deeper than {MAX_DEPTH} aren't read.")
    code, pos = _take(data, pos, 1)
    code = code[0]
    if code <= 0x7F:
        return code, pos
    if code >= 0xE0:
        return code - 0x100, pos
    if 0xA0 <= code <= 0xBF:
        return _sized("str", code & 0x1F, data, pos, depth)
    if 0x90 <= code <= 0x9F:
        return _sized("array", code & 0x0F, data, pos, depth)
    if 0x80 <= code <= 0x8F:
        return _sized("map", code & 0x0F, data, pos, depth)
    if code == 0xC0:
        return None, pos
    if code in (0xC2, 0xC3):
        return code == 0xC3, pos
    if code in FIXED:
        raw, pos = _take(data, pos, struct.calcsize(FIXED[code]))
        return struct.unpack(FIXED[code], raw)[0], pos
    if code in SIZED:
        kind, fmt = SIZED[code]
        raw, pos = _take(data, pos, struct.calcsize(fmt))
        return _sized(kind, struct.unpack(fmt, raw)[0], data, pos, depth)
    if code in FIXEXT_SIZES:
        return _sized("ext", FIXEXT_SIZES[code], data, pos, depth)
    # 0xC1 is the one byte MessagePack never uses.
    raise MsgpackError(f"0x{code:02x} doesn't start a MessagePack value.")


def _sized(kind, n, data, pos, depth):
    if kind == "str":
        raw, pos = _take(data, pos, n)
        return raw.decode("utf-8", errors="replace"), pos
    if kind == "bin":
        return _take(data, pos, n)
    if kind == "ext":
        code, pos = _take(data, pos, 1)
        raw, pos = _take(data, pos, n)
        return Ext(struct.unpack(">b", code)[0], raw), pos
    # Every item takes at least a byte, so a count past what's left can't be complete. Checking first means a made-up count
    # of four billion costs nothing.
    if n * (2 if kind == "map" else 1) > len(data) - pos:
        raise Incomplete("The bytes end partway through a value.")
    if kind == "array":
        items = []
        for _ in range(n):
            item, pos = _unpack(data, pos, depth + 1)
            items.append(item)
        return items, pos
    pairs = {}
    for _ in range(n):
        key, pos = _unpack(data, pos, depth + 1)
        item, pos = _unpack(data, pos, depth + 1)
        try:
            pairs[key] = item
        except TypeError:
            raise MsgpackError("A map key must be a string, a number, a bool or nil.")
    return pairs, pos


class Unpacker:
    """Whole values from a stream of bytes, as they arrive."""

    def __init__(self):
        self.buffer = b""

    def feed(self, data):
        self.buffer += data

    def values(self):
        while self.buffer:
            try:
                value, end = _unpack(self.buffer, 0, 0)
            except Incomplete:
                if len(self.buffer) > MAX_MESSAGE_BYTES:
                    raise MsgpackError(f"More than {MAX_MESSAGE_BYTES // 1024} KiB came without a whole message.")
                return
            self.buffer = self.buffer[end:]
            yield value


def open_socket(path, timeout):
    """A connection to the router, or a BridgeError saying why there isn't one."""
    if not hasattr(socket, "AF_UNIX"):
        raise BridgeError("This system has no Unix sockets, so it can't reach a router.")
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
    except FileNotFoundError:
        sock.close()
        raise BridgeError(f"There is no router socket at {path}, so arduino-router isn't running on this board.")
    except PermissionError:
        sock.close()
        raise BridgeError(
            f"This user may not open {path}. It has to be in the socket's group, which setup-rover.sh adds, and a server started "
            "before that has to be restarted."
        )
    except ConnectionRefusedError:
        sock.close()
        raise BridgeError(f"Nothing is listening on {path}, so arduino-router has stopped.")
    except socket.timeout:
        sock.close()
        raise BridgeError(f"The router at {path} didn't take the connection within {timeout} seconds.")
    except OSError as err:
        sock.close()
        raise BridgeError(f"Couldn't connect to the router at {path}: {err.strerror or err}.")
    return sock


def describe_error(error):
    """An RPC error as words. The router and RPClite send a string, or a [code, message] list."""
    if isinstance(error, bytes):
        return error.decode("utf-8", errors="replace")
    if isinstance(error, (list, tuple)):
        words = [item for item in error if isinstance(item, str)]
        return "; ".join(words) if words else " ".join(str(item) for item in error)
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error)


def call(method, params=(), path=SOCKET_PATH, timeout=DEFAULT_TIMEOUT_S):
    """Calls method on whoever provides it, through the router, and returns its result. Raises BridgeError in plain words."""
    msgid = next(_ids) % 2**31
    request = packb([REQUEST, msgid, method, list(params)])
    deadline = time.monotonic() + timeout
    sock = open_socket(path, timeout)
    try:
        try:
            sock.sendall(request)
        except OSError as err:
            raise BridgeError(f"Couldn't send {method} to the router: {err}.")
        unpacker = Unpacker()
        while True:
            try:
                for message in unpacker.values():
                    # Notifications, and anything else that isn't this call's answer, are someone else's.
                    if isinstance(message, list) and len(message) == 4 and message[0] == RESPONSE and message[1] == msgid:
                        if message[2] is not None:
                            raise BridgeError(f"The router answered {method} with an error: {describe_error(message[2])}.")
                        return message[3]
            except MsgpackError as err:
                raise BridgeError(f"The router's answer to {method} isn't MessagePack: {err}")
            left = deadline - time.monotonic()
            if left <= 0:
                raise BridgeError(f"No answer to {method} within {timeout} seconds.")
            sock.settimeout(left)
            try:
                data = sock.recv(65536)
            except socket.timeout:
                raise BridgeError(f"No answer to {method} within {timeout} seconds.")
            except OSError as err:
                raise BridgeError(f"The connection to the router broke during {method}: {err}.")
            if not data:
                raise BridgeError(f"The router closed the connection without answering {method}.")
            unpacker.feed(data)
    finally:
        sock.close()


def main(argv):
    """One call from a shell: each argument is read as JSON when it is JSON, so 120 is a number and drive a string."""
    if not argv:
        print("Usage: bridge_client.py <method> [argument ...]", file=sys.stderr)
        return 2
    params = []
    for arg in argv[1:]:
        try:
            params.append(json.loads(arg))
        except ValueError:
            params.append(arg)
    try:
        result = call(argv[0], params)
    except BridgeError as err:
        print(err, file=sys.stderr)
        return 1
    print(result if isinstance(result, str) else json.dumps(result, default=repr))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
