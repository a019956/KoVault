# KoVault

A small, fast, local-first note-taking app inspired by Obsidian. It runs in the browser and on Android (packaged with Capacitor for the Google Play Store). Notes can sync to your own Google Drive.

## Features

| | |
|---|---|
| **Notes** | Markdown notes with Write / Preview modes, `- [ ]` checklists, `[[Wiki links]]` that open (or create) the linked note, pinning, Markdown download |
| **Folders** | Nested folders (create, rename, delete, subfolders). Notes can be moved between folders |
| **Search** | Full-text search over titles and bodies. `#label` filters by label (`#home` also matches `#home/cooking`) |
| **Labels** | Add labels to any note, browse them from the sidebar, nested labels with `/` |
| **Tasks** | Daily tasks and weekly goals, a week overview, progress bar, and one-tap carry-over of unfinished tasks |
| **Drawing** | A pen canvas on every note: 6 colors, 3 widths, eraser, undo/redo, scroll mode. Works with mouse, finger, and stylus |
| **Google** | Sign in with Google; notes are saved to a `KoVault` folder in your Google Drive and loaded back on any device |
| **Offline** | Everything is saved on the device first. Sync runs in the background when you're online |
| **Backup** | Export or import the whole vault as a single JSON file |

## How it keeps memory and storage low

- **Only metadata in memory.** Titles, labels, folders, and tasks are kept in memory. Note bodies and drawings stay in IndexedDB and are read one at a time when you open a note.
- **Search streams.** Search reads note bodies through an IndexedDB cursor, one at a time, so memory use stays flat however big the vault gets.
- **Vector drawings.** Drawings are stored as strokes, not images. Points are rounded to integers, delta-encoded, and packed as base64 varints, which is about 2 characters per point. A typical sketch takes a few KB; the same drawing as a PNG would take hundreds of KB. See `src/data/strokeCodec.ts`.
- **Compressed sync file.** The Drive copy is one gzipped snapshot (`KoVault/kovault-vault.json.gz`), built with the platform's native `CompressionStream`.
- **Small bundle.** The app has no Google SDK and no state library. The Drive client is about 100 lines of `fetch` code. The production JS is about 115 KB gzipped.

## Project layout

```
src/
  data/        types, IndexedDB (idb), Vault store, search, merge rules, stroke codec
  sync/        Google sign-in (web + Android), Drive REST client, sync engine
  components/  Sidebar, NoteList, NoteEditor, SketchPad, Tasks, Account
android/       Capacitor Android project (Play Store build)
test/          Vitest unit tests (vault, search, codec, Drive sync against a fake Drive)
```

### Sync model

Every folder, note, and task has an `updatedAt` timestamp. Deleted items become *tombstones* so that deletions reach your other devices. A sync runs these steps:

1. Find or create the `KoVault` folder in Drive.
2. Download `kovault-vault.json.gz`, if it exists.
3. Merge it into the local vault record by record. The newer `updatedAt` wins. If the timestamps are equal, a delete beats an edit.
4. Upload the merged snapshot, but only if Drive is missing something or has an older copy.

Sync runs a few seconds after each edit, when the app comes back to the foreground, when the device comes back online, and every 5 minutes. Edits made offline sync later.

The app asks only for the **`drive.file`** scope. With it, KoVault can see only the files it created, never the rest of your Drive. Google also classes it as a *non-sensitive* scope, so the app doesn't need Google's restricted-scope security review.

## Development

```bash
npm install
```

```bash
cp .env.example .env.local   # then put your Google Web client ID in it
```

```bash
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests
```

```bash
npm run build      # type-check + production build into dist/
```

Without `VITE_GOOGLE_CLIENT_ID`, the app still works fully on the device. Only Google sign-in and Drive sync are turned off.

## Google Cloud setup (sign-in + Drive)

**Quick way:** run the interactive setup script:

```bash
npm run setup:google      # or: bash scripts/setup-google.sh [--project my-id] [--skip-gcloud] [--skip-github]
```

The script does these steps for you:

- creates the project and enables the Drive API (with the [gcloud CLI](https://cloud.google.com/sdk/docs/install))
- writes `.env.local`
- prints your SHA-1 fingerprints and can create the upload keystore (at `~/.kovault/kovault-upload.jks`)
- can save the client ID and keystore to GitHub Actions (with `gh`)

Google has no API for the consent screen or for creating OAuth clients, so for those steps the script opens the right console page and waits for you. It is safe to re-run.

The manual steps, if you prefer to click through yourself. Do all of this in **one** Google Cloud project:

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project.
2. In **APIs & Services → Library**, enable the **Google Drive API**.
3. Set up the **Google Auth Platform / OAuth consent screen**:
   - User type: *External*.
   - App name, support email, and a privacy policy URL (see `PRIVACY.md`).
   - Scopes: `openid`, `email`, `profile`, `.../auth/drive.file`.
   - While in *Testing*, add your Google accounts under **Test users**. When you're ready, choose **Publish app**. With only non-sensitive scopes there is no security review.
4. In **Credentials → Create OAuth client ID**, create these clients:
   - **Web application**. This ID goes into `VITE_GOOGLE_CLIENT_ID`, for both web and Android.
     - Authorized JavaScript origins: `http://localhost:5173`, `http://localhost:4173`, and your hosted URL if you deploy the web version.
   - **Android**, one for each signing certificate. Package name `com.kovault.app` plus the SHA-1 of:
     - your debug keystore (`cd android && ./gradlew signingReport`)
     - your upload keystore
     - the **Play App Signing** key (Play Console → *Test and release → App integrity*). Play-installed builds are signed with this key, so without its SHA-1, sign-in fails only for users who install from the Play Store.

   You never paste the Android client ID anywhere in the code. Google matches it by package name and SHA-1.

## Android / Google Play

Requirements: Node 22+, JDK 21, Android Studio (or the Android SDK command-line tools).

```bash
npm run cap:sync       # builds the web app and copies it into android/
```

```bash
npm run android:open   # opens Android Studio; press Run to install on a device/emulator
```

### Release build for the Play Store

1. Create an upload keystore once. Keep it and its passwords safe, and never commit them:

   ```bash
   keytool -genkeypair -v -keystore kovault-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

2. Build a signed Android App Bundle:

   ```bash
   export KOVAULT_KEYSTORE_PATH=$PWD/kovault-upload.jks KOVAULT_KEYSTORE_PASSWORD=... KOVAULT_KEY_ALIAS=upload KOVAULT_KEY_PASSWORD=...
   ```

   ```bash
   export KOVAULT_VERSION_CODE=2 KOVAULT_VERSION_NAME=0.2.0   # bump the version code for every upload
   ```

   ```bash
   npm run cap:sync && (cd android && ./gradlew bundleRelease)
   ```

   The bundle is written to `android/app/build/outputs/bundle/release/app-release.aab`.

3. In the [Play Console](https://play.google.com/console):
   - Create the app and turn on **Play App Signing**.
   - Upload the `.aab` to the *Internal testing* track first.
   - Fill in the store listing. `resources/icon-only.png` is a 1024² source; scale it to 512² for the store icon.
   - Fill in the **Data safety** form. The app collects your email and name (for sign-in only). Notes are stored on the device and in *your own* Google Drive. There is no developer server and no third-party sharing.
   - Add the privacy policy URL. You can host `PRIVACY.md` anywhere public.
   - Add the Play App Signing SHA-1 to an Android OAuth client (step 4 above).

### CI

`.github/workflows/ci.yml` runs the type-check, the tests, and the web build on every push, then builds a debug APK. It saves the APK as a downloadable workflow artifact. To also build a signed release `.aab`, add these to the repository:

- **Variables:** `VITE_GOOGLE_CLIENT_ID`
- **Secrets:** `KOVAULT_KEYSTORE_BASE64` (`base64 -w0 kovault-upload.jks`), `KOVAULT_KEYSTORE_PASSWORD`, `KOVAULT_KEY_ALIAS`, `KOVAULT_KEY_PASSWORD`

App icons and splash screens in `android/` come from `resources/` and were generated with `npx @capacitor/assets generate --android`.
