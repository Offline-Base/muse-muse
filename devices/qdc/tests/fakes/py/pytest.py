"""Just enough of pytest for importing devices/qdc/carrier/tests/conftest.py in the unit tests: a fixture decorator
that leaves the function as it is."""


def fixture(*args, **kwargs):
    if args and callable(args[0]) and not kwargs:
        return args[0]
    return lambda f: f
