# Muse Rover's Linux half doesn't live here: muse-device's server.py calls the sketch through the router itself
# (docs/ROVER.md). App Lab runs an app's Python beside its sketch, so this only keeps the app running.
from arduino.app_utils import *

App.run()
