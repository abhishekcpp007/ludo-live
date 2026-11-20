#!/bin/bash
# Builds a signed release APK without Gradle.
# SERVER_URL must be the https address of the deployed game server.
set -euo pipefail
cd "$(dirname "$0")"

SERVER_URL="${SERVER_URL:?set SERVER_URL to the https game server}"
VERSION_CODE="${VERSION_CODE:-1}"
VERSION_NAME="${VERSION_NAME:-1.0.0}"
KEY_DIR="${KEY_DIR:-$HOME/.ludo-live-release}"
SDK="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"
API=35
MIN_API=26
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-$API/android.jar"
OUT=build
PKG=io/github/abhishekcpp007/ludolive

case "$SERVER_URL" in https://*) ;; *) echo "SERVER_URL must start with https://" >&2; exit 1 ;; esac

rm -rf "$OUT"
mkdir -p "$OUT/gen/$PKG" "$OUT/classes" "$OUT/dex"
cat > "$OUT/gen/$PKG/Config.java" <<JAVA
package io.github.abhishekcpp007.ludolive;
final class Config {
    static final String SERVER_URL = "${SERVER_URL%/}/";
    static final String VERSION = "${VERSION_NAME}";
}
JAVA

"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" --manifest AndroidManifest.xml \
  -A assets --java "$OUT/gen" --min-sdk-version $MIN_API --target-sdk-version $API \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" "$OUT/res.zip"

javac -Xlint:-options --release 11 -cp "$JAR" -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --lib "$JAR" --min-api $MIN_API --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -u ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="$KEY_DIR/release.keystore"
PASS_FILE="$KEY_DIR/password.txt"
if [ ! -f "$KS" ]; then
  mkdir -p "$KEY_DIR" && chmod 700 "$KEY_DIR"
  umask 077
  openssl rand -base64 24 | tr -d '/+=' > "$PASS_FILE"
  keytool -genkeypair -keystore "$KS" -storepass:file "$PASS_FILE" -keypass:file "$PASS_FILE" -alias ludolive \
    -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Ludo Live" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "file:$PASS_FILE" --ks-key-alias ludolive \
  --out "ludo-live-$VERSION_NAME.apk" "$OUT/aligned.apk"
rm -f "ludo-live-$VERSION_NAME.apk.idsig"
"$BT/apksigner" verify --print-certs "ludo-live-$VERSION_NAME.apk" | head -2
ls -lh "ludo-live-$VERSION_NAME.apk"
