# Stillwell Mobile

Native Expo / React Native implementation. This is a separate mobile application; it does not wrap or display the web app.

## Run

```sh
npm install
npm start
```

Open the project with Expo Go while developing. For local native builds, install Android Studio with its SDK and use `npm run android`; macOS with Xcode is required for a local iOS build.

## Android APK

The current Android APK is available at:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Copy the APK to an Android phone and open it to install. Android may ask you to allow installs from the file manager or browser used to open it.

To rebuild locally on Windows, install a JDK 17 and Android SDK with API 36, then run:

```powershell
$env:ANDROID_HOME = "C:\path\to\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
cd android
./gradlew assembleRelease
```

To build through Expo's cloud builder, install EAS CLI and sign in to an Expo account:

```sh
npx eas-cli build --platform android --profile preview
```

The preview profile is configured to produce an installable APK. A successful build returns an Expo download link. iOS TestFlight/App Store builds require Apple developer credentials.

The same React Native app supports iPhone. The `preview` EAS profile is configured for internal iOS distribution, which requires an Apple Developer account and a registered iPhone device. For TestFlight or App Store distribution, use the `production` profile and an Apple Developer account with App Store Connect access.

For an iOS Simulator build without Apple Developer membership, use the `ios-simulator` EAS profile. This produces a simulator app that runs on a Mac simulator, not an installable iPhone app. It still requires an Expo account and an EAS cloud build.

The locally generated APK is signed with the Android debug key for sideloading. Create and configure a private release keystore before distributing through an app store or sharing future updates publicly.

The app saves its demo data on-device with AsyncStorage. Authentication, cloud synchronization, server-side AI, and secure financial-data backup are not connected yet.
