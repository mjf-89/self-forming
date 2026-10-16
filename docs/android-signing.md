# Android signing and updates

Android installs an update only when it has the same application ID (`md.incept.selfforming`) and the same
signing identity as the installed app, and a higher `versionCode`. Bump `versionName` in
`apps/android/app/build.gradle.kts` together with `version` in `package.json` (`build-all.sh` checks that they
match), and raise `selfFormingVersionCode` in `apps/android/gradle.properties` for each release.

## Local and CI builds

Gradle reads the signing configuration from the environment:

- `SELF_FORMING_KEYSTORE_PATH`: path to a PKCS#12 keystore containing the key with alias `self-forming`.
- `SELF_FORMING_KEYSTORE_PASSWORD`: the keystore and key password.
- `SELF_FORMING_SIGNING_REQUIRED=true`: fail instead of falling back to the debug key.

Without them the APK is signed with the local Gradle debug key. Such an APK cannot update an app installed
with a different key. In GitHub Actions the keystore comes from the required distribution secrets
`SELF_FORMING_KEYSTORE_BASE64` and `SELF_FORMING_KEYSTORE_PASSWORD`; without them a distribution build fails. Pull requests can run checks using a temporary debug identity, but do not publish an APK.

This repository's permanent identity is pinned by `apps/android/signing-certificate.sha256`. Configure a new repository with that existing key; do not generate a replacement while keeping the pinned certificate. When establishing a separate app identity for the first time, create a key once and keep it:

```sh
keytool -genkeypair -storetype PKCS12 -keystore self-forming.p12 -alias self-forming \
  -keyalg RSA -keysize 3072 -validity 36500 -dname "CN=Self Forming"
```

Never regenerate the key for each build, put it in a cache, or commit it. Public APKs deliberately contain the app key for self-rebuilding, as described below; source archives generated from Git do not. Keep a backup. An existing installation with the same application ID and a different certificate cannot accept an update signed by this key; changing the repository name does not change that Android requirement.

## Building on the phone

`build-apk.sh` requires `.signing/self-forming.p12` (alias `self-forming`, password in `.signing/password`)
and signs with APK Signature Schemes v2 and v3, or with `.signing/lineage.bin` as a v3 rotation when that file exists.
It refuses to build an installable update without the permanent key, and verifies the signed APK against the committed certificate fingerprint.
`.signing/` is gitignored but is packed into the APK with the source on purpose, so the app can update itself: anyone
with an APK can extract the key and password (see the README, "Security and signing"). The public certificate and SHA-256 fingerprint are committed in `apps/android/signing-certificate.*`; CI and on-device rebuilds check that identity. Since anyone with the APK can sign a compatible update, that certificate is not proof that an update came from this repository's maintainers. Never reuse this self-rebuild key for unrelated apps or services.

See [Android's signing documentation](https://developer.android.com/studio/publish/app-signing) for the platform's
update requirements.
