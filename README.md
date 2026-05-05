# We Love PDF

Internal web application for day-to-day PDF work on a private network. It has no login, keeps uploaded/generated files only in session-scoped temporary folders, and deletes them when the browser session is closed or when the server-side TTL cleanup runs.

## Features

- Merge PDFs in a chosen order
- Split selected pages into independent PDF files
- Compress PDFs with quality-preserving cleanup
- Organize/reorder/delete pages using draggable thumbnails
- Redact searched text and selected page areas
- Edit PDFs by adding text, highlights, comments, rectangles, and circles

Each home-page tool opens its own workspace at `/tool/<name>`. Users upload PDFs there, preview page thumbnails, drag/drop or remove pages, and then click Generate to produce the output.

## Open-source stack

- Python 3.11+
- Flask
- PyMuPDF
- Tesseract OCR for scanned PDF redaction searches in container deployment
- SortableJS served locally for drag/drop thumbnails

## Run Locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:8000`.

## Internal Deployment

```bash
gunicorn -w 2 -b 0.0.0.0:8000 app:app
```

Or run the container:

```bash
docker build -t we-love-pdf .
docker run --rm -p 8000:8000 -e MAX_UPLOAD_MB=150 we-love-pdf
```

Place it behind your internal reverse proxy with HTTPS enabled. Recommended controls:

- Restrict access to internal network ranges at the firewall or reverse proxy.
- Set `MAX_UPLOAD_MB` to match your policy.
- Put `APP_TEMP_ROOT` on encrypted local disk.
- Keep `SESSION_TTL_MINUTES` low for shared machines.
- Forward access logs to your internal log system.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `150` | Maximum upload size |
| `APP_TEMP_ROOT` | OS temp directory | Root folder for ephemeral session files |
| `SESSION_TTL_MINUTES` | `60` | Age before temp sessions are removed |
| `TESSDATA_PREFIX` | System default | Tesseract OCR data path for scanned PDFs |
| `PORT` | `8000` | Development server port |

## Data Handling

Uploaded PDFs and generated outputs are written only to temporary per-session folders. The browser calls `/api/session/cleanup` via `sendBeacon` on page unload. The server also deletes expired sessions before each request. Only standard request/application logs should persist.
