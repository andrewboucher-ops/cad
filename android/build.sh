#!/usr/bin/env bash
# One command from a clean checkout to an installable APK.
#   ./build.sh            debug build
#   ./build.sh release    signed release (needs keystore.properties)
#
# Prerequisites on your machine, none of which can be scripted away:
#   - Node 18+ and npm
#   - Android Studio, or the command line tools plus a JDK 17
#   - ANDROID_HOME (or ANDROID_SDK_ROOT) pointing at the SDK
set -euo pipefail

MODE="${1:-debug}"
cd "$(dirname "$0")"

if [[ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]]; then
  echo "ANDROID_HOME is not set. Install Android Studio, then:"
  echo "  export ANDROID_HOME=\$HOME/Android/Sdk       # Linux"
  echo "  export ANDROID_HOME=\$HOME/Library/Android/sdk # macOS"
  exit 1
fi

echo "==> Installing Capacitor"
npm install

echo "==> Staging the web consoles"
rm -rf www && mkdir -p www
cp -r ../public/* www/
# The app points at your deployed server by default (see capacitor.config.json).
# The bundled copy is the shell and the offline fallback.

if [[ ! -d android ]]; then
  echo "==> Generating the native project"
  npx cap add android
  # Our hand-written sources and config win over the generated defaults.
  cp -r app/src/main/java android/app/src/main/ 2>/dev/null || true
  cp app/src/main/AndroidManifest.xml android/app/src/main/AndroidManifest.xml
  cp -r app/src/main/res/xml android/app/src/main/res/ 2>/dev/null || true
  cp app/build.gradle android/app/build.gradle
  cp variables.gradle android/variables.gradle
  [[ -f keystore.properties ]] && cp keystore.properties android/
fi

echo "==> Syncing"
npx cap sync android

echo "==> Building ($MODE)"
cd android
if [[ "$MODE" == "release" ]]; then
  [[ -f keystore.properties ]] || { echo "keystore.properties missing — see keystore.properties.example"; exit 1; }
  ./gradlew assembleRelease
  echo "APK: android/app/build/outputs/apk/release/app-release.apk"
else
  ./gradlew assembleDebug
  echo "APK: android/app/build/outputs/apk/debug/app-debug.apk"
fi

cat <<'NEXT'

Install on a handset over USB with debugging enabled:
  adb install -r app/build/outputs/apk/debug/app-debug.apk

If the build failed, send me the last 40 lines of the Gradle output. Version
mismatches between the Android Gradle plugin, Capacitor and your SDK are the
usual cause and they are quick to fix once I can see the actual error.
NEXT
