"""AppiumOptions: records capabilities, with the appium: prefix for names that aren't W3C ones, as the real client does."""

W3C = {"platformName", "browserName", "platformVersion"}


class AppiumOptions:
    def __init__(self):
        self.capabilities = {}

    def set_capability(self, name, value):
        self.capabilities[name if name in W3C or ":" in name else f"appium:{name}"] = value
