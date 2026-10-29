"""webdriver.Remote: raises ConnectionRefusedError unless appium.webdriver.ALLOW is True; records what it was given."""

ALLOW = False
OPENED = []


class Driver:
    def __init__(self, url, capabilities):
        self.url = url
        self.capabilities = capabilities
        self.quit_called = False

    def quit(self):
        self.quit_called = True


def Remote(command_executor, options):
    if not ALLOW:
        raise ConnectionRefusedError("no Appium server")
    driver = Driver(command_executor, dict(options.capabilities))
    OPENED.append(driver)
    return driver
