FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_TEMP_ROOT=/tmp/we-love-pdf \
    MAX_UPLOAD_MB=150 \
    SESSION_TTL_MINUTES=60 \
    MAX_PDF_PAGES=300 \
    MAX_OCR_PAGES=25 \
    MAX_OPERATION_SECONDS=120 \
    GUNICORN_WORKERS=2 \
    GUNICORN_TIMEOUT=150 \
    GUNICORN_GRACEFUL_TIMEOUT=20 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

WORKDIR /app

RUN adduser --disabled-password --gecos "" appuser
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN mkdir -p /tmp/we-love-pdf && chown -R appuser:appuser /app /tmp/we-love-pdf

USER appuser

EXPOSE 8000
CMD ["sh", "-c", "gunicorn -w ${GUNICORN_WORKERS:-2} -b 0.0.0.0:8000 --timeout ${GUNICORN_TIMEOUT:-150} --graceful-timeout ${GUNICORN_GRACEFUL_TIMEOUT:-20} --max-requests 100 --max-requests-jitter 20 --worker-tmp-dir /tmp app:app"]
