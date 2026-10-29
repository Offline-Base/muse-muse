"""requests.sessions.Session with a request method that records its calls (no network)."""

CALLS = []


class Session:
    def request(self, method, url, **kwargs):
        CALLS.append((method, url, kwargs.get("timeout")))
        return None
