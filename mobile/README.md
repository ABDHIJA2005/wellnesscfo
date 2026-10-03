# Stillwell Mobile

Native Expo / React Native app for Android and iOS. Financial records are stored locally with AsyncStorage; there is no bank login, bank connection, cloud sync, or statement upload.

## Enter and import your data

- Add income or expenses manually from **Activity → Add transaction**. Tap a saved row to edit it; long press to delete.
- Import a bank statement from **Activity → Import bank statement** or the Home screen.
- CSV imports recognize common headers for date, description/narration, debit/withdrawal, credit/deposit, or amount plus transaction type. If a bank uses unusual labels or formats, export CSV with those columns or add transactions manually.
- PDF import reads selectable text on-device. Scanned/image-only PDFs are not supported because this version has no OCR. PDF layouts vary by bank, so review each parsed row.
- The review screen lets you select/skip rows and edit description, date, amount, category, and income/expense type. Likely duplicates are unchecked initially. Confirm to save.
- The statement file is read from the picker cache and is not saved into the app's finance records. No credentials are requested.
- Existing demo transactions from earlier builds are discarded during migration. Set your opening balance in the profile, then import the transactions for the period after that balance date. This prevents demo figures appearing as your finances.

## Run locally

```sh
npm install
npm start
```

Native PDF extraction requires a native build; it does not work in Expo Go. For Android, install JDK 17 and Android SDK API 36, then run `npm run android` or build the release APK from `android` with `./gradlew assembleRelease`. For iOS, macOS and Xcode are required for local builds; iPhone distribution requires Apple signing and distribution setup.

Statement parsing is heuristic and should be checked against the original statement before confirming. Scanned PDFs, bank connections, OCR, automatic categorization learning, and server AI are not included.
