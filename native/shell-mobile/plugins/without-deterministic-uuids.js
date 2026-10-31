// The wearables module's plugin adds CocoaPods' deterministic_uuids to the Podfile. On React Native 0.88 that gives
// every generated file with the same name the same build entry, so react-native-webview's Props.cpp and friends are
// dropped from ReactCodegen and the app fails to link. This takes the line back out.
//
// Expo runs the last plugin's Podfile step first, so this has to be listed before the module in app.config.ts.

const { withPodfile } = require("expo/config-plugins");

const LINE = /^.*deterministic_uuids.*\n/gm;
const COMMENT = /^# EMWDAT: prevent CocoaPods UUID collisions.*\n/gm;

module.exports = function withoutDeterministicUuids(config) {
  return withPodfile(config, (next) => {
    next.modResults.contents = next.modResults.contents.replace(COMMENT, "").replace(LINE, "");
    return next;
  });
};
