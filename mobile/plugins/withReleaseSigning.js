// Signs Android release builds with your own upload key when one is configured, so a published APK can't be
// impersonated by anyone holding the public debug key. The key never lives in the repo:
//   ~/.tally/signing.properties (or the same keys as environment variables):
//     TALLY_UPLOAD_STORE_FILE, TALLY_UPLOAD_KEY_ALIAS, TALLY_UPLOAD_STORE_PASSWORD, TALLY_UPLOAD_KEY_PASSWORD
// Without it, release builds fall back to the debug key (fine for local testing, never for publishing).
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// tally-release-signing';

const GRADLE = `
${MARK}
def tallySigning = new Properties()
def tallySigningFile = new File(System.getProperty('user.home'), '.tally/signing.properties')
if (tallySigningFile.exists()) { tallySigningFile.withInputStream { tallySigning.load(it) } }
def tallyProp = { String k -> System.getenv(k) ?: tallySigning.getProperty(k) }
def tallyHasRelease = tallyProp('TALLY_UPLOAD_STORE_FILE') != null && new File(tallyProp('TALLY_UPLOAD_STORE_FILE')).exists()
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARK)) return cfg;
    src = src.replace(/^android \{/m, `${GRADLE}\nandroid {`);
    src = src.replace(
      /signingConfigs \{\s*debug \{/,
      `signingConfigs {
        release {
            if (tallyHasRelease) {
                storeFile file(tallyProp('TALLY_UPLOAD_STORE_FILE'))
                storePassword tallyProp('TALLY_UPLOAD_STORE_PASSWORD')
                keyAlias tallyProp('TALLY_UPLOAD_KEY_ALIAS')
                keyPassword tallyProp('TALLY_UPLOAD_KEY_PASSWORD')
            }
        }
        debug {`,
    );
    src = src.replace(
      /(release \{[^}]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig tallyHasRelease ? signingConfigs.release : signingConfigs.debug',
    );
    if (!src.includes('tallyHasRelease ? signingConfigs.release')) throw new Error('withReleaseSigning: build.gradle layout changed; update the plugin');
    cfg.modResults.contents = src;
    return cfg;
  });
};
