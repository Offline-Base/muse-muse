"""The SDK's Unset marker: a field the server left out."""


class Unset:
    def __bool__(self):
        return False


UNSET = Unset()


class Response:
    """What the SDK's sync_detailed functions return: a status code and the parsed body (a model, or a plain dict)."""

    def __init__(self, status_code, parsed, content=b"{}"):
        self.status_code = status_code
        self.parsed = parsed
        self.content = content
