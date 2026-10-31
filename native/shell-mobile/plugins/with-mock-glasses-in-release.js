// The wearables module compiles Meta's mock glasses only under #if DEBUG. A Debug simulator build would need Metro
// running on the lab Mac, so for the simulator-only glasses build this turns that flag on for the module alone. The
// JavaScript stays embedded, and the app starts with no packager. Never used for a build that goes on a real phone.

const { withPodfile } = require("expo/config-plugins");

const MARKER = "# muse: mock glasses in release";
const SNIPPET = `  ${MARKER}
  installer.pods_project.targets.each do |target|
    next unless target.name == 'EMWDAT'
    target.build_configurations.each do |build|
      build.build_settings['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DEBUG'
    end
  end
`;

module.exports = function withMockGlassesInRelease(config) {
  return withPodfile(config, (next) => {
    const { contents } = next.modResults;
    if (contents.includes(MARKER)) return next;
    const hook = /post_install do \|installer\|\n/;
    if (!hook.test(contents)) throw new Error("The Podfile has no post_install block to add mock glasses to.");
    next.modResults.contents = contents.replace(hook, (line) => `${line}${SNIPPET}`);
    return next;
  });
};
