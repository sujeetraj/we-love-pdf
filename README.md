# We Love PDF

We Love PDF is an internal web application for common PDF operations on a trusted private network. It is designed for day-to-day staff usage without login, without persistent document storage, and with all PDF processing handled by open-source components.

Uploaded files and generated outputs live only in session-scoped temporary folders. The browser requests cleanup when the session closes, and the server also removes expired temporary sessions by TTL.

## Features

- Merge PDFs by arranging whole files in the required order
- Split PDFs using page ranges or selected pages
- Compress PDFs while preserving readable output quality
- Organize PDFs by dragging pages, deleting pages, rotating pages, and adding blank pages
- Redact PDFs by searching text, optionally using OCR for scanned pages, and permanently applying redactions
- Edit PDFs in a viewer-style workspace with:
  - Text and comment objects
  - Highlights, rectangles, circles, and image insertion
  - Drag-to-move objects
  - Resize handles
  - Delete or Backspace removal for selected objects
  - Font family, size, colour, background fill, bold, italic, and underline controls

## Application Flow

1. Open the home page and choose a PDF tool.
2. Upload one or more PDFs depending on the selected tool.
3. Preview the PDF or generated page thumbnails.
4. Arrange, edit, redact, split, compress, or organize as needed.
5. Click the generate/save action to download the output.
6. Temporary session data is deleted on browser close or by server TTL cleanup.

Tool pages are available at:

```text
/tool/merge
/tool/split
/tool/compress
/tool/organize
/tool/redact
/tool/edit
```

## Technology Stack

- Python
- Flask
- PyMuPDF
- Gunicorn
- Tesseract OCR in the container image
- SortableJS served locally for drag and drop
- Plain HTML, CSS, and JavaScript

No external CDN is required at runtime.

## Local Development

Create a virtual environment and install dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run the application:

```bash
python app.py
```

Open:

```text
http://127.0.0.1:8000
```

Run validation:

```bash
node --check static/app.js
python -m unittest tests.smoke_test
```

## Container Deployment

Build and run:

```bash
docker build -t we-love-pdf .
docker run --rm -p 8000:8000 -e MAX_UPLOAD_MB=150 we-love-pdf
```

The container runs Gunicorn and includes Tesseract OCR English language data for scanned PDF redaction search.

For the hardened local container profile with CPU, memory, PID, read-only filesystem, and tmpfs limits:

```bash
docker compose up --build
```

The compose profile confines writable data to `/tmp`, drops Linux capabilities, prevents privilege escalation, and applies resource limits so expensive PDF parsing/OCR work is contained within the application container.

## Internal Network Deployment

For a direct server deployment:

```bash
gunicorn -w 2 -b 0.0.0.0:8000 --timeout 150 --graceful-timeout 20 --max-requests 100 --max-requests-jitter 20 app:app
```

Recommended production placement:

- Run behind an internal reverse proxy with HTTPS.
- Restrict access to internal network ranges at the firewall or proxy.
- Keep the application off the public internet unless authentication and stronger perimeter controls are added.
- Store temporary files on encrypted local disk.
- Forward application and reverse-proxy access logs to the internal logging platform.
- Tune worker count and upload size based on expected file sizes and concurrency.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `150` | Maximum request upload size in MB |
| `APP_TEMP_ROOT` | OS temp directory + `we-love-pdf` | Root directory for temporary session folders |
| `SESSION_TTL_MINUTES` | `60` | Time before temporary sessions are eligible for cleanup |
| `MAX_PDF_PAGES` | `300` | Maximum pages allowed in an uploaded PDF |
| `MAX_OCR_PAGES` | `25` | Maximum pages OCR may process during one redaction search |
| `MAX_OPERATION_SECONDS` | `120` | Cooperative time budget for heavy PDF operations |
| `GUNICORN_WORKERS` | `2` | Container Gunicorn worker count |
| `GUNICORN_TIMEOUT` | `150` | Gunicorn worker timeout in seconds |
| `GUNICORN_GRACEFUL_TIMEOUT` | `20` | Gunicorn graceful shutdown timeout in seconds |
| `TESSDATA_PREFIX` | System default | Tesseract language data path for OCR |
| `PORT` | `8000` | Port used by the Flask development server |

## Data Handling

The application does not use a database and does not intentionally retain uploaded PDFs or generated outputs.

- Files are written under a UUID session directory.
- The browser calls `/api/session/cleanup` with `sendBeacon` when the page unloads.
- The server deletes expired sessions before handling requests.
- Generated files are returned as downloads.
- Only application/request logs should persist outside the temporary workspace.

## Security Notes

- No login is included by design for trusted internal deployment.
- PDF files are processed server-side with PyMuPDF.
- Security headers are applied by the Flask app, including content type, frame, referrer, permissions, cache, and CSP controls.
- Uploaded files are validated as PDFs before processing.
- Uploaded PDFs are rejected when they exceed the configured page limit.
- OCR searches are capped by page count, and heavy operations have a configurable time budget.
- Container deployment can be run with CPU, memory, PID, read-only filesystem, dropped capability, and `no-new-privileges` limits through `docker-compose.yml`.
- Runtime scripts and vendor assets are served locally.
- OCR is opt-in for redaction searches.

## Project Structure

```text
.
├── app.py
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── static/
│   ├── app.js
│   ├── styles.css
│   └── vendor/
├── templates/
│   └── index.html
└── tests/
    └── smoke_test.py
```

## Repository

```text
https://github.com/sujeetraj/we-love-pdf
```
