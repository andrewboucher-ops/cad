# CCCS Radio / MDT — Android build

Capacitor shell around the existing radio and MDT web consoles. One codebase,
real APK, with the native pieces a radio actually needs: a foreground service so
it stays registered with the screen off, background location, high-priority
notifications for emergency and job dispatch, audio focus handling, and hardware
PTT key capture.

**Not built here.** This project was written without an Android SDK or network
access, so no APK has been compiled or run from it. The Gradle files pin
plausible current versions, but the Android Gradle plugin, Capacitor and your
installed SDK all have to agree, and I could not check that from here. Expect to
resolve at least one version mismatch on the first build; send me the Gradle
output and it is a quick fix.

Treat this as source you build, not a binary you install.

## Build

```bash
cd android
./build.sh              # debug APK
./build.sh release      # signed release, needs keystore.properties
```

That installs Capacitor, stages the web consoles, generates the native project on
first run, and builds. The APK lands in `android/app/build/outputs/apk/`.

You need Node 18+, a JDK 17, and the Android SDK with `ANDROID_HOME` set. The
script checks for the last one and tells you what to do if it is missing.

See [TESTING.md](TESTING.md) for what to verify on a real handset before trusting
it with an officer — that list matters more than the build.

Two hosting choices, set in `capacitor.config.json`:

- `server.url` pointing at your deployed CCCS host — the app is a shell, UI
  updates ship without a new APK. Needs HTTPS with a valid certificate; WebRTC
  and `getUserMedia` will not work over plain HTTP on Android.
- Bundled `www/` — works offline for the shell, but the app still needs the
  server for everything real.

## Release signing

```bash
keytool -genkey -v -keystore cccs-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias cccs
# put the passwords in android/keystore.properties, which is gitignored
./gradlew assembleRelease
```

Never commit the keystore or its passwords.

## Which pages

`uk.cccs.radio` loads `/radio.html`; build a second flavour with
`uk.cccs.mdt` loading `/mdt.html` if you want them installed side by side on the
same device. For an in-vehicle tablet running one app, a launch switch is simpler.

## Device notes

- **Hardware keys are learned, not compiled in.** `MainActivity` forwards every
  keycode it sees to the web layer as a `cccs:key` event, and the officer binds
  PTT and SOS in Settings by pressing the button. This means a new handset model
  needs no new APK, and you can check a device in the shop by loading the web
  console in Chrome on it. Volume, power, back, home and recents are deliberately
  left with Android.
- **If a key does not appear when learning**, the handset is likely routing it
  through a vendor SDK rather than the standard key pipeline. `adb shell getevent`
  will tell you whether the key reaches Android at all — if it does not, that
  device needs its vendor SDK wired into `forward()`, and it is worth knowing
  that before you buy fifty of them.
- **Battery optimisation.** Android will kill the foreground service on many OEM
  builds unless the user exempts the app. Prompt for it on first run.
- **Doze.** Background GPS intervals stretch under Doze. For real vehicle
  tracking, use a foreground service with a location type, which this project does.
