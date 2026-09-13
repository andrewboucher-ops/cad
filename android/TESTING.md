# Testing the handset build

The code is written; what remains is everything only a real device can tell you.
Work down this list with one handset before you buy twenty.

## First build

```bash
./build.sh              # debug APK
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

If Gradle fails, it is almost always a version mismatch between the Android
Gradle plugin (`build.gradle`), Capacitor (`package.json`) and your installed
SDK. Send me the last 40 lines of the output and I will pin the versions.

## Before you trust it with an officer

Tick these off in order. Each one has burned someone before.

- [ ] **Sign in over HTTPS.** On plain HTTP, Android silently refuses the
      microphone and you get a radio with no audio and no error message.
- [ ] **PTT with the screen off.** Lock the handset, hold the key, confirm
      control hears you and sees the TX indication.
- [ ] **Leave it 30 minutes in a pocket.** Then check control still shows it on
      air. If it dropped, the foreground service was killed — grant the battery
      optimisation exemption and try again.
- [ ] **Which keycode is the side key?** `adb shell getevent -l` while pressing
      it, or just use Settings > Learn on the handset. Confirm it is not one of
      the codes the OS swallows.
- [ ] **SOS hold time.** 2 seconds is the default. Try it wearing gloves.
- [ ] **Lock the keypad, then raise an SOS from the lock screen.** This is the
      one that matters most and the one most likely to be wrong.
- [ ] **Go somewhere with no signal.** Change a job status, walk back into
      coverage, confirm it arrives and control sees it once, not twice.
- [ ] **Welfare timer while backgrounded.** Set a five-minute timer, put the
      handset away, do not check in, confirm control gets the alarm.
- [ ] **Covert mode.** Screen dims, tones silent, control shows "covert".
- [ ] **Mobile data, not wifi.** Drive around. This is where you find out whether
      you need TURN — and you do.
- [ ] **Battery over a full shift.** Constant GPS and an open WebSocket cost
      real power. Measure it before promising anyone a twelve-hour shift.

## What to tell me when something is wrong

- The Gradle output, if it will not build.
- `adb logcat | grep -i cccs`, if it builds but misbehaves.
- For audio problems: whether it fails on wifi too, or only on mobile data. That
  single answer separates a TURN problem from a code problem.
