# WellnessCFO

A standalone, local-first personal finance dashboard inspired by the calm, editorial feel of Stillwell. This is a separate project; it does not modify Stillwell.

## Run

Open `index.html` in a modern browser. Data is stored in that browser's local storage.

## Imports

The demo supports transaction CSV files, PDFs, and screenshots/images through an import review flow. CSV transaction rows are parsed locally. Image and PDF uploads are staged for review; automatic extraction is not connected to an OCR or AI service yet. Review and confirm rows before they are saved. Transaction deduplication compares date, amount, and normalized description. Portfolio screenshots can be recorded as dated portfolio snapshots.

## Privacy

The demo stores imported records and portfolio snapshots in browser local storage. It does not upload files to a server.
