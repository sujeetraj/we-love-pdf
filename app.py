import base64
import io
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

import fitz
from flask import Flask, abort, g, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename


APP_NAME = "We Love PDF"
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "150"))
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_MINUTES", "60")) * 60
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "300"))
MAX_OCR_PAGES = int(os.environ.get("MAX_OCR_PAGES", "25"))
MAX_OPERATION_SECONDS = int(os.environ.get("MAX_OPERATION_SECONDS", "120"))
TEMP_ROOT = Path(os.environ.get("APP_TEMP_ROOT", tempfile.gettempdir())) / "we-love-pdf"
ALLOWED_EXTENSIONS = {".pdf"}
TOOLS = {"merge", "split", "compress", "organize", "redact", "edit"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger(APP_NAME)


def ensure_temp_root() -> None:
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)


def clean_expired_sessions() -> None:
    ensure_temp_root()
    now = time.time()
    for path in TEMP_ROOT.iterdir():
        check_operation_budget()
        if path.is_dir() and now - path.stat().st_mtime > SESSION_TTL_SECONDS:
            shutil.rmtree(path, ignore_errors=True)


@app.before_request
def before_request() -> None:
    g.operation_started_at = time.monotonic()
    clean_expired_sessions()


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Cache-Control"] = "no-store"
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    response.headers["Content-Security-Policy"] = csp
    return response


def session_dir(session_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9-]{36}", session_id or ""):
        abort(400, "Invalid session")
    ensure_temp_root()
    path = TEMP_ROOT / session_id
    path.mkdir(parents=True, exist_ok=True)
    path.touch()
    return path


def new_session_dir() -> tuple[str, Path]:
    session_id = str(uuid.uuid4())
    return session_id, session_dir(session_id)


def require_pdf(file_storage) -> None:
    name = secure_filename(file_storage.filename or "")
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        abort(400, "Only PDF files are allowed")


def check_operation_budget() -> None:
    started_at = getattr(g, "operation_started_at", None)
    if started_at is not None and time.monotonic() - started_at > MAX_OPERATION_SECONDS:
        abort(408, "PDF operation exceeded the configured time limit")


def validate_pdf_page_limit(page_count: int) -> None:
    if page_count > MAX_PDF_PAGES:
        abort(400, f"PDF has {page_count} pages; maximum allowed is {MAX_PDF_PAGES}")


def save_pdf_upload(file_storage, target_dir: Path, prefix: str = "upload") -> Path:
    require_pdf(file_storage)
    filename = secure_filename(file_storage.filename or "document.pdf")
    path = target_dir / f"{prefix}-{uuid.uuid4().hex}-{filename}"
    file_storage.save(path)
    try:
        doc = fitz.open(path)
    except Exception:
        path.unlink(missing_ok=True)
        abort(400, "Invalid PDF file")
    with doc:
        if doc.page_count < 1:
            abort(400, "Uploaded PDF has no pages")
        validate_pdf_page_limit(doc.page_count)
    return path


def output_path(target_dir: Path, name: str) -> Path:
    return target_dir / f"{uuid.uuid4().hex}-{secure_filename(name)}"


def send_pdf(path: Path, download_name: str):
    data = io.BytesIO(path.read_bytes())
    return send_file(
        data,
        as_attachment=True,
        download_name=download_name,
        mimetype="application/pdf",
        max_age=0,
    )


def parse_pages(page_text: str, page_count: int) -> list[int]:
    if not page_text.strip():
        return list(range(page_count))
    pages: list[int] = []
    for part in page_text.split(","):
        token = part.strip()
        if not token:
            continue
        if "-" in token:
            start_text, end_text = token.split("-", 1)
            start = int(start_text)
            end = int(end_text)
            if start > end:
                start, end = end, start
            pages.extend(range(start, end + 1))
        else:
            pages.append(int(token))
    unique = []
    for page in pages:
        if page < 1 or page > page_count:
            abort(400, f"Page {page} is outside the document range")
        if page not in unique:
            unique.append(page)
    return [page - 1 for page in unique]


def make_zip(files: list[tuple[str, Path]]) -> io.BytesIO:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, path in files:
            archive.write(path, name)
    buffer.seek(0)
    return buffer


@app.route("/")
def index():
    return render_template("index.html", app_name=APP_NAME, max_upload_mb=MAX_UPLOAD_MB, active_tool="")


@app.route("/tool/<tool>")
def tool_page(tool: str):
    if tool not in TOOLS:
        abort(404, "Tool not found")
    return render_template("index.html", app_name=APP_NAME, max_upload_mb=MAX_UPLOAD_MB, active_tool=tool)


@app.post("/api/session")
def create_session():
    session_id, _path = new_session_dir()
    logger.info("session.created id=%s", session_id)
    return jsonify({"sessionId": session_id})


@app.post("/api/session/cleanup")
def cleanup_session():
    data = request.get_json(silent=True) or request.form
    session_id = data.get("sessionId", "")
    if re.fullmatch(r"[a-f0-9-]{36}", session_id or ""):
        shutil.rmtree(TEMP_ROOT / session_id, ignore_errors=True)
        logger.info("session.cleaned id=%s", session_id)
    return ("", 204)


@app.post("/api/merge")
def merge_pdfs():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    uploads = request.files.getlist("files")
    if len(uploads) < 2:
        abort(400, "Upload at least two PDFs")
    result = fitz.open()
    for index, upload in enumerate(uploads):
        check_operation_budget()
        path = save_pdf_upload(upload, workdir, "merge")
        with fitz.open(path) as doc:
            page_count = doc.page_count
            result.insert_pdf(doc)
        logger.info("merge.input index=%s pages=%s name=%s", index, page_count, upload.filename)
    out = output_path(workdir, "merged.pdf")
    result.save(out, garbage=4, deflate=True, clean=True)
    result.close()
    logger.info("merge.output session=%s file=%s", sid, out.name)
    return send_pdf(out, "we-love-pdf-merged.pdf")


@app.post("/api/split")
def split_pdf():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    upload = request.files.get("file")
    if upload is None:
        abort(400, "Upload a PDF")
    path = save_pdf_upload(upload, workdir, "split")
    mode = request.form.get("mode", "selected")
    ranges = request.form.get("pages", "")
    outputs: list[tuple[str, Path]] = []
    with fitz.open(path) as doc:
        if mode == "all":
            page_sets = [[i] for i in range(doc.page_count)]
        else:
            page_sets = [parse_pages(ranges, doc.page_count)]
        for set_index, pages in enumerate(page_sets, start=1):
            check_operation_budget()
            split_doc = fitz.open()
            for page in pages:
                check_operation_budget()
                split_doc.insert_pdf(doc, from_page=page, to_page=page)
            out = output_path(workdir, f"split-{set_index}.pdf")
            split_doc.save(out, garbage=4, deflate=True, clean=True)
            split_doc.close()
            outputs.append((f"split-{set_index}.pdf", out))
    if len(outputs) == 1:
        return send_pdf(outputs[0][1], outputs[0][0])
    archive = make_zip(outputs)
    return send_file(archive, as_attachment=True, download_name="we-love-pdf-split.zip", mimetype="application/zip")


@app.post("/api/compress")
def compress_pdf():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    upload = request.files.get("file")
    if upload is None:
        abort(400, "Upload a PDF")
    path = save_pdf_upload(upload, workdir, "compress")
    out = output_path(workdir, "compressed.pdf")
    level = request.form.get("level", "balanced")
    with fitz.open(path) as doc:
        save_kwargs = {"garbage": 4, "deflate": True, "clean": True}
        if level == "maximum":
            save_kwargs.update({"deflate_images": True, "deflate_fonts": True})
        doc.save(out, **save_kwargs)
    logger.info("compress.output session=%s input_bytes=%s output_bytes=%s", sid, path.stat().st_size, out.stat().st_size)
    return send_pdf(out, "we-love-pdf-compressed.pdf")


@app.post("/api/document")
def upload_document():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    upload = request.files.get("file")
    if upload is None:
        abort(400, "Upload a PDF")
    path = save_pdf_upload(upload, workdir, "document")
    token = path.stem
    with fitz.open(path) as doc:
        pages = [{"page": i + 1, "width": doc[i].rect.width, "height": doc[i].rect.height} for i in range(doc.page_count)]
    return jsonify({"documentId": token, "pages": pages})


def find_document(workdir: Path, document_id: str) -> Path:
    safe = secure_filename(document_id)
    matches = list(workdir.glob(f"{safe}.pdf"))
    if not matches:
        matches = [p for p in workdir.glob("document-*.pdf") if p.stem == safe]
    if not matches:
        abort(404, "Document not found")
    return matches[0]


def selected_page_refs(data: dict, workdir: Path) -> list[dict]:
    refs = data.get("pages", [])
    if not isinstance(refs, list) or not refs:
        abort(400, "Upload and keep at least one page in the preview")
    selected = []
    for ref in refs:
        check_operation_budget()
        document_id = str(ref.get("documentId", ""))
        page_number = int(ref.get("page", 0))
        path = find_document(workdir, document_id)
        with fitz.open(path) as doc:
            validate_pdf_page_limit(doc.page_count)
            if page_number < 1 or page_number > doc.page_count:
                abort(400, "Invalid page in preview")
        selected.append({"documentId": document_id, "page": page_number})
    return selected


def selected_document_refs(data: dict, workdir: Path) -> list[str]:
    refs = data.get("documents", [])
    if not isinstance(refs, list) or len(refs) < 2:
        abort(400, "Upload and keep at least two PDFs in the preview")
    selected = []
    for document_id in refs:
        check_operation_budget()
        safe_id = str(document_id)
        find_document(workdir, safe_id)
        selected.append(safe_id)
    return selected


def document_from_document_refs(workdir: Path, refs: list[str]) -> fitz.Document:
    result = fitz.open()
    for document_id in refs:
        check_operation_budget()
        path = find_document(workdir, document_id)
        with fitz.open(path) as source:
            validate_pdf_page_limit(source.page_count)
            result.insert_pdf(source)
    return result


def document_from_refs(workdir: Path, refs: list[dict]) -> fitz.Document:
    result = fitz.open()
    for ref in refs:
        check_operation_budget()
        path = find_document(workdir, ref["documentId"])
        page_index = int(ref["page"]) - 1
        with fitz.open(path) as source:
            result.insert_pdf(source, from_page=page_index, to_page=page_index)
    return result


def organized_document_from_items(workdir: Path, items: list[dict]) -> fitz.Document:
    if not items:
        abort(400, "Keep at least one page in the organizer")
    result = fitz.open()
    default_width = 595
    default_height = 842
    for item in items:
        check_operation_budget()
        item_type = str(item.get("type") or "page")
        rotation = int(item.get("rotation") or 0) % 360
        if item_type == "blank":
            width = float(item.get("width") or default_width)
            height = float(item.get("height") or default_height)
            page = result.new_page(width=width, height=height)
            if rotation:
                page.set_rotation(rotation)
            continue

        document_id = str(item.get("documentId", ""))
        page_number = int(item.get("page") or 0)
        path = find_document(workdir, document_id)
        with fitz.open(path) as source:
            validate_pdf_page_limit(source.page_count)
            if page_number < 1 or page_number > source.page_count:
                abort(400, "Invalid page in organizer")
            result.insert_pdf(source, from_page=page_number - 1, to_page=page_number - 1)
            inserted = result[-1]
            if rotation:
                inserted.set_rotation((inserted.rotation + rotation) % 360)
            default_width = source[page_number - 1].rect.width
            default_height = source[page_number - 1].rect.height
    return result


def document_from_range(workdir: Path, document_id: str, start: int, end: int) -> fitz.Document:
    path = find_document(workdir, document_id)
    result = fitz.open()
    with fitz.open(path) as source:
        validate_pdf_page_limit(source.page_count)
        if start < 1 or end < 1 or start > source.page_count or end > source.page_count:
            abort(400, "Split range is outside the document")
        if start > end:
            start, end = end, start
        result.insert_pdf(source, from_page=start - 1, to_page=end - 1)
    return result


def search_document_text(path: Path, term: str, use_ocr: bool = False) -> tuple[list[dict], str]:
    matches: list[dict] = []
    ocr_warning = ""
    ocr_page_count = 0
    with fitz.open(path) as doc:
        validate_pdf_page_limit(doc.page_count)
        for page_index, page in enumerate(doc):
            check_operation_budget()
            rects = page.search_for(term)
            used_ocr = False
            if not rects and use_ocr and hasattr(page, "get_textpage_ocr"):
                ocr_page_count += 1
                if ocr_page_count > MAX_OCR_PAGES:
                    ocr_warning = f"OCR limited to {MAX_OCR_PAGES} pages. Narrow the document or search without OCR."
                    break
                try:
                    check_operation_budget()
                    textpage = page.get_textpage_ocr(language="eng", full=True)
                    rects = page.search_for(term, textpage=textpage)
                    used_ocr = bool(rects)
                except Exception as exc:
                    ocr_warning = f"OCR unavailable or failed: {exc}"
            for rect in rects:
                matches.append(
                    {
                        "page": page_index + 1,
                        "term": term,
                        "ocr": used_ocr,
                        "rect": {
                            "x0": rect.x0,
                            "y0": rect.y0,
                            "x1": rect.x1,
                            "y1": rect.y1,
                        },
                        "pageSize": {
                            "width": page.rect.width,
                            "height": page.rect.height,
                        },
                    }
                )
    return matches, ocr_warning


def save_generated_pdf(doc: fitz.Document, workdir: Path, filename: str, maximum: bool = False) -> Path:
    out = output_path(workdir, filename)
    save_kwargs = {"garbage": 4, "deflate": True, "clean": True}
    if maximum:
        save_kwargs.update({"deflate_images": True, "deflate_fonts": True})
    check_operation_budget()
    doc.save(out, **save_kwargs)
    doc.close()
    return out


def image_bytes_from_data_url(value: str) -> bytes:
    if not value or "," not in value:
        abort(400, "Upload an image before saving image edits")
    header, payload = value.split(",", 1)
    if not header.startswith("data:image/"):
        abort(400, "Only PNG and JPEG images can be inserted")
    try:
        return base64.b64decode(payload, validate=True)
    except Exception:
        abort(400, "Invalid image data")


def hex_to_rgb(value: str, fallback: tuple[float, float, float]) -> tuple[float, float, float]:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return fallback
    return tuple(int(value[index : index + 2], 16) / 255 for index in (1, 3, 5))


def font_name(style: dict) -> str:
    family = str(style.get("fontFamily") or "helvetica")
    bold = bool(style.get("bold"))
    italic = bool(style.get("italic"))
    if family == "times":
        return "tibi" if bold and italic else "tibo" if bold else "tiit" if italic else "tiro"
    if family == "courier":
        return "cobi" if bold and italic else "cobo" if bold else "coit" if italic else "cour"
    return "hebi" if bold and italic else "hebo" if bold else "heit" if italic else "helv"


def apply_edit_action(page, action: str, text: str, rect: fitz.Rect, image_data: str = "", style: dict | None = None) -> None:
    style = style if isinstance(style, dict) else {}
    color = hex_to_rgb(str(style.get("color") or ""), (0.82, 0.08, 0.12))
    background = str(style.get("backgroundColor") or "")
    fontsize = max(6, min(float(style.get("fontSize") or 14), 96))
    if background:
        page.draw_rect(rect, color=None, fill=hex_to_rgb(background, (1, 1, 1)), overlay=True)
    if action == "text":
        if not text:
            abort(400, "Text is required")
        page.insert_textbox(rect, text, fontsize=fontsize, fontname=font_name(style), color=color, align=fitz.TEXT_ALIGN_LEFT)
        if style.get("underline"):
            underline_y = min(rect.y1 - 2, rect.y0 + fontsize + 3)
            page.draw_line(fitz.Point(rect.x0, underline_y), fitz.Point(rect.x1, underline_y), color=color, width=1)
    elif action == "highlight":
        page.add_highlight_annot(rect)
    elif action == "comment":
        page.add_text_annot(fitz.Point(rect.x0, rect.y0), text or "Comment")
    elif action == "rectangle":
        page.draw_rect(rect, color=color, width=2)
    elif action == "circle":
        page.draw_oval(rect, color=color, width=2)
    elif action == "image":
        page.insert_image(rect, stream=image_bytes_from_data_url(image_data), keep_proportion=True)
    else:
        abort(400, "Unsupported edit action")


@app.get("/api/document/<session_id>/<document_id>/thumbnail/<int:page_number>")
def thumbnail(session_id: str, document_id: str, page_number: int):
    workdir = session_dir(session_id)
    path = find_document(workdir, document_id)
    with fitz.open(path) as doc:
        validate_pdf_page_limit(doc.page_count)
        if page_number < 1 or page_number > doc.page_count:
            abort(404)
        page = doc[page_number - 1]
        check_operation_budget()
        pix = page.get_pixmap(matrix=fitz.Matrix(0.24, 0.24), alpha=False)
        return send_file(io.BytesIO(pix.tobytes("png")), mimetype="image/png", max_age=0)


@app.get("/api/document/<session_id>/<document_id>/preview/<int:page_number>")
def preview(session_id: str, document_id: str, page_number: int):
    workdir = session_dir(session_id)
    path = find_document(workdir, document_id)
    with fitz.open(path) as doc:
        validate_pdf_page_limit(doc.page_count)
        if page_number < 1 or page_number > doc.page_count:
            abort(404)
        page = doc[page_number - 1]
        check_operation_budget()
        pix = page.get_pixmap(matrix=fitz.Matrix(1.4, 1.4), alpha=False)
        return send_file(io.BytesIO(pix.tobytes("png")), mimetype="image/png", max_age=0)


@app.post("/api/redact/search")
def search_redactions():
    data = request.get_json(force=True)
    sid = data.get("sessionId", "")
    workdir = session_dir(sid)
    document_id = str(data.get("documentId", ""))
    term = str(data.get("term", "")).strip()
    if not term:
        abort(400, "Enter text to search")
    path = find_document(workdir, document_id)
    matches, warning = search_document_text(path, term, bool(data.get("ocr")))
    return jsonify({"matches": matches, "warning": warning})


@app.post("/api/organize")
def organize_pdf():
    data = request.get_json(force=True)
    sid = data.get("sessionId", "")
    workdir = session_dir(sid)
    path = find_document(workdir, data.get("documentId", ""))
    order = data.get("order", [])
    if not order:
        abort(400, "Choose at least one page")
    with fitz.open(path) as doc:
        result = fitz.open()
        for page_number in order:
            page_index = int(page_number) - 1
            if page_index < 0 or page_index >= doc.page_count:
                abort(400, "Invalid page order")
            result.insert_pdf(doc, from_page=page_index, to_page=page_index)
        out = output_path(workdir, "organized.pdf")
        result.save(out, garbage=4, deflate=True, clean=True)
        result.close()
    return send_pdf(out, "we-love-pdf-organized.pdf")


@app.post("/api/generate/<tool>")
def generate_from_preview(tool: str):
    if tool not in TOOLS:
        abort(404, "Tool not found")
    data = request.get_json(force=True)
    sid = data.get("sessionId", "")
    workdir = session_dir(sid)
    options = data.get("options", {}) if isinstance(data.get("options", {}), dict) else {}

    if tool == "merge":
        document_refs = selected_document_refs(data, workdir)
        result = document_from_document_refs(workdir, document_refs)
        out = save_generated_pdf(result, workdir, "merged.pdf")
        logger.info("generate.output tool=%s session=%s documents=%s", tool, sid, len(document_refs))
        return send_pdf(out, "we-love-pdf-merged.pdf")

    if tool == "split":
        split_mode = str(options.get("splitMode") or "pages")
        if split_mode == "range":
            document_id = str(options.get("documentId") or "")
            ranges = options.get("ranges", [])
            if not document_id or not isinstance(ranges, list) or not ranges:
                abort(400, "Add at least one split range")
            if options.get("mergeRanges"):
                merged = fitz.open()
                for item in ranges:
                    check_operation_budget()
                    part = document_from_range(workdir, document_id, int(item.get("from", 1)), int(item.get("to", 1)))
                    merged.insert_pdf(part)
                    part.close()
                out = save_generated_pdf(merged, workdir, "split-ranges.pdf")
                return send_pdf(out, "we-love-pdf-split-ranges.pdf")

            outputs: list[tuple[str, Path]] = []
            for index, item in enumerate(ranges, start=1):
                check_operation_budget()
                split_doc = document_from_range(workdir, document_id, int(item.get("from", 1)), int(item.get("to", 1)))
                out = save_generated_pdf(split_doc, workdir, f"split-range-{index}.pdf")
                outputs.append((f"split-range-{index}.pdf", out))
            if len(outputs) == 1:
                return send_pdf(outputs[0][1], outputs[0][0])
            archive = make_zip(outputs)
            return send_file(archive, as_attachment=True, download_name="we-love-pdf-split-ranges.zip", mimetype="application/zip")

        refs = selected_page_refs(data, workdir)
        outputs: list[tuple[str, Path]] = []
        for index, ref in enumerate(refs, start=1):
            check_operation_budget()
            split_doc = document_from_refs(workdir, [ref])
            out = save_generated_pdf(split_doc, workdir, f"split-page-{index}.pdf")
            outputs.append((f"split-page-{index}.pdf", out))
        if len(outputs) == 1:
            return send_pdf(outputs[0][1], outputs[0][0])
        archive = make_zip(outputs)
        return send_file(archive, as_attachment=True, download_name="we-love-pdf-split.zip", mimetype="application/zip")

    if tool == "organize":
        items = options.get("items", [])
        if not isinstance(items, list):
            abort(400, "Invalid organizer items")
        result = organized_document_from_items(workdir, items)
        out = save_generated_pdf(result, workdir, "organized.pdf")
        logger.info("generate.output tool=%s session=%s items=%s", tool, sid, len(items))
        return send_pdf(out, "we-love-pdf-organized.pdf")

    refs = selected_page_refs(data, workdir)
    result = document_from_refs(workdir, refs)

    if tool == "redact":
        rect_redactions = options.get("rects", [])
        if isinstance(rect_redactions, list):
            for item in rect_redactions:
                check_operation_budget()
                page_index = int(item.get("page") or 1) - 1
                if page_index < 0 or page_index >= result.page_count:
                    abort(400, "Redaction page is outside the preview range")
                rect = item.get("rect", {}) if isinstance(item.get("rect", {}), dict) else {}
                result[page_index].add_redact_annot(
                    fitz.Rect(
                        float(rect.get("x0") or 0),
                        float(rect.get("y0") or 0),
                        float(rect.get("x1") or 0),
                        float(rect.get("y1") or 0),
                    ),
                    fill=(0, 0, 0),
                )
        terms = [term.strip() for term in str(options.get("terms", "")).splitlines() if term.strip()]
        for page in result:
            check_operation_budget()
            for term in terms:
                for rect in page.search_for(term):
                    page.add_redact_annot(rect, fill=(0, 0, 0))
        area = options.get("area") if isinstance(options.get("area"), dict) else {}
        if area and area.get("page"):
            page_index = int(area.get("page")) - 1
            if page_index < 0 or page_index >= result.page_count:
                abort(400, "Area page is outside the preview range")
            x = float(area.get("x") or 0)
            y = float(area.get("y") or 0)
            width = float(area.get("width") or 0)
            height = float(area.get("height") or 0)
            if width <= 0 or height <= 0:
                abort(400, "Area width and height are required")
            result[page_index].add_redact_annot(fitz.Rect(x, y, x + width, y + height), fill=(0, 0, 0))
        for page in result:
            check_operation_budget()
            if page.first_annot:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)

    if tool == "edit":
        edits = options.get("edits", [])
        if isinstance(edits, list) and edits:
            for edit in edits:
                check_operation_budget()
                page_index = int(edit.get("page") or 1) - 1
                if page_index < 0 or page_index >= result.page_count:
                    abort(400, "Edit page is outside the preview range")
                x = float(edit.get("x") or 72)
                y = float(edit.get("y") or 72)
                width = float(edit.get("width") or 180)
                height = float(edit.get("height") or 40)
                rect = fitz.Rect(x, y, x + width, y + height)
                apply_edit_action(
                    result[page_index],
                    str(edit.get("action") or "text"),
                    str(edit.get("text") or "").strip(),
                    rect,
                    str(edit.get("imageData") or ""),
                    edit.get("format") if isinstance(edit.get("format"), dict) else {},
                )
        else:
            page_index = int(options.get("page") or 1) - 1
            if page_index < 0 or page_index >= result.page_count:
                abort(400, "Edit page is outside the preview range")
            x = float(options.get("x") or 72)
            y = float(options.get("y") or 72)
            width = float(options.get("width") or 180)
            height = float(options.get("height") or 40)
            rect = fitz.Rect(x, y, x + width, y + height)
            apply_edit_action(
                result[page_index],
                str(options.get("action") or "text"),
                str(options.get("text") or "").strip(),
                rect,
                str(options.get("imageData") or ""),
                options.get("format") if isinstance(options.get("format"), dict) else {},
            )

    filename = {
        "merge": "merged.pdf",
        "compress": "compressed.pdf",
        "organize": "organized.pdf",
        "redact": "redacted.pdf",
        "edit": "edited.pdf",
    }.get(tool, "output.pdf")
    out = save_generated_pdf(result, workdir, filename, maximum=options.get("level") == "maximum")
    logger.info("generate.output tool=%s session=%s pages=%s", tool, sid, len(refs))
    return send_pdf(out, f"we-love-pdf-{filename}")


@app.post("/api/redact")
def redact_pdf():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    upload = request.files.get("file")
    if upload is None:
        abort(400, "Upload a PDF")
    path = save_pdf_upload(upload, workdir, "redact")
    search_terms = [term.strip() for term in request.form.get("terms", "").splitlines() if term.strip()]
    page_text = request.form.get("pages", "")
    area_page = request.form.get("areaPage", "").strip()
    out = output_path(workdir, "redacted.pdf")
    redactions = 0
    with fitz.open(path) as doc:
        target_pages = parse_pages(page_text, doc.page_count) if page_text.strip() else list(range(doc.page_count))
        for page_index in target_pages:
            check_operation_budget()
            page = doc[page_index]
            for term in search_terms:
                for rect in page.search_for(term):
                    page.add_redact_annot(rect, fill=(0, 0, 0))
                    redactions += 1
        if area_page:
            page_index = int(area_page) - 1
            if page_index < 0 or page_index >= doc.page_count:
                abort(400, "Area page is outside the document range")
            x = float(request.form.get("x") or 0)
            y = float(request.form.get("y") or 0)
            width = float(request.form.get("width") or 0)
            height = float(request.form.get("height") or 0)
            if width <= 0 or height <= 0:
                abort(400, "Area width and height are required")
            doc[page_index].add_redact_annot(fitz.Rect(x, y, x + width, y + height), fill=(0, 0, 0))
            redactions += 1
        for page in doc:
            check_operation_budget()
            if page.first_annot:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
        doc.save(out, garbage=4, deflate=True, clean=True)
    logger.info("redact.output session=%s matches=%s", sid, redactions)
    return send_pdf(out, "we-love-pdf-redacted.pdf")


@app.post("/api/edit")
def edit_pdf():
    sid = request.form.get("sessionId", "")
    workdir = session_dir(sid)
    upload = request.files.get("file")
    if upload is None:
        abort(400, "Upload a PDF")
    path = save_pdf_upload(upload, workdir, "edit")
    page_number = int(request.form.get("page", "1"))
    action = request.form.get("action", "text")
    text = request.form.get("text", "").strip()
    x = float(request.form.get("x", "72"))
    y = float(request.form.get("y", "72"))
    width = float(request.form.get("width", "180"))
    height = float(request.form.get("height", "40"))
    out = output_path(workdir, "edited.pdf")
    with fitz.open(path) as doc:
        if page_number < 1 or page_number > doc.page_count:
            abort(400, "Invalid page")
        page = doc[page_number - 1]
        rect = fitz.Rect(x, y, x + width, y + height)
        apply_edit_action(page, action, text, rect, request.form.get("imageData", ""))
        doc.save(out, garbage=4, deflate=True, clean=True)
    return send_pdf(out, "we-love-pdf-edited.pdf")


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(408)
@app.errorhandler(413)
@app.errorhandler(500)
def handle_error(error):
    code = getattr(error, "code", 500)
    message = getattr(error, "description", "Something went wrong")
    logger.warning("request.error code=%s message=%s", code, message)
    return jsonify({"error": message}), code


if __name__ == "__main__":
    ensure_temp_root()
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), debug=False)
