import base64
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

import fitz

import app as pdf_app


def sample_pdf(text: str, pages: int = 1) -> bytes:
    doc = fitz.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"{text} page {index + 1}")
    data = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return data


def table_pdf_with_image() -> bytes:
    red_png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
    )
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Name", fontname="Helvetica-Bold", fontsize=12)
    page.insert_text((220, 72), "Amount", fontname="Helvetica-Bold", fontsize=12)
    page.insert_text((72, 96), "Alice", fontsize=12)
    page.insert_text((220, 96), "100", fontsize=12)
    page.insert_image(fitz.Rect(72, 130, 122, 180), stream=red_png)
    page.draw_rect(fitz.Rect(72, 200, 220, 232), fill=(0, 0, 0), color=(0, 0, 0))
    page.insert_text((80, 220), "WhiteText", fontsize=12, color=(1, 1, 1))
    data = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return data


class SmokeTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.original_max_pdf_pages = pdf_app.MAX_PDF_PAGES
        self.original_max_ocr_pages = pdf_app.MAX_OCR_PAGES
        self.original_max_operation_seconds = pdf_app.MAX_OPERATION_SECONDS
        pdf_app.TEMP_ROOT = Path(self.tempdir.name)
        pdf_app.app.config["TESTING"] = True
        self.client = pdf_app.app.test_client()
        response = self.client.post("/api/session")
        self.session_id = response.get_json()["sessionId"]

    def tearDown(self):
        pdf_app.MAX_PDF_PAGES = self.original_max_pdf_pages
        pdf_app.MAX_OCR_PAGES = self.original_max_ocr_pages
        pdf_app.MAX_OPERATION_SECONDS = self.original_max_operation_seconds
        self.tempdir.cleanup()

    def post_pdf(self, endpoint: str, fields: dict, filename: str = "sample.pdf"):
        data = {"sessionId": self.session_id, **fields}
        return self.client.post(endpoint, data=data, content_type="multipart/form-data")

    def test_merge_split_compress_redact_and_edit(self):
        pdf_one = sample_pdf("first secret")
        pdf_two = sample_pdf("second", pages=2)

        merge = self.post_pdf(
            "/api/merge",
            {"files": [(io.BytesIO(pdf_one), "one.pdf"), (io.BytesIO(pdf_two), "two.pdf")]},
        )
        self.assertEqual(merge.status_code, 200)
        with fitz.open(stream=merge.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 3)

        split = self.post_pdf(
            "/api/split",
            {"file": (io.BytesIO(pdf_two), "two.pdf"), "mode": "selected", "pages": "1"},
        )
        self.assertEqual(split.status_code, 200)
        with fitz.open(stream=split.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 1)

        compress = self.post_pdf("/api/compress", {"file": (io.BytesIO(pdf_two), "two.pdf"), "level": "balanced"})
        self.assertEqual(compress.status_code, 200)

        redact = self.post_pdf(
            "/api/redact",
            {"file": (io.BytesIO(pdf_one), "one.pdf"), "terms": "secret", "pages": ""},
        )
        self.assertEqual(redact.status_code, 200)
        with fitz.open(stream=redact.data, filetype="pdf") as doc:
            self.assertNotIn("secret", doc[0].get_text())

        edit = self.post_pdf(
            "/api/edit",
            {
                "file": (io.BytesIO(pdf_one), "one.pdf"),
                "action": "text",
                "page": "1",
                "text": "Approved",
                "x": "72",
                "y": "120",
                "width": "180",
                "height": "40",
            },
        )
        self.assertEqual(edit.status_code, 200)
        with fitz.open(stream=edit.data, filetype="pdf") as doc:
            self.assertIn("Approved", doc[0].get_text())

    def test_upload_organize_and_cleanup(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("organize", pages=3)), "org.pdf")},
            content_type="multipart/form-data",
        )
        self.assertEqual(upload.status_code, 200)
        document_id = upload.get_json()["documentId"]

        organized = self.client.post(
            "/api/organize",
            json={"sessionId": self.session_id, "documentId": document_id, "order": [3, 1]},
        )
        self.assertEqual(organized.status_code, 200)
        with fitz.open(stream=organized.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 2)
            self.assertIn("page 3", doc[0].get_text())

        cleanup = self.client.post("/api/session/cleanup", json={"sessionId": self.session_id})
        self.assertEqual(cleanup.status_code, 204)

    def test_generate_organize_with_blank_and_rotation(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("organize", pages=2)), "org.pdf")},
            content_type="multipart/form-data",
        )
        document_id = upload.get_json()["documentId"]
        organized = self.client.post(
            "/api/generate/organize",
            json={
                "sessionId": self.session_id,
                "pages": [{"documentId": document_id, "page": 1}],
                "options": {
                    "items": [
                        {"type": "page", "documentId": document_id, "page": 2, "rotation": 90},
                        {"type": "blank", "width": 595, "height": 842},
                        {"type": "page", "documentId": document_id, "page": 1, "rotation": 0},
                    ]
                },
            },
        )
        self.assertEqual(organized.status_code, 200)
        with fitz.open(stream=organized.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 3)
            self.assertEqual(doc[0].rotation, 90)
            self.assertEqual(doc[1].get_text().strip(), "")
            self.assertIn("organize page 1", doc[2].get_text())

    def test_preview_generate_flow(self):
        upload_one = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("first", pages=2)), "first.pdf")},
            content_type="multipart/form-data",
        )
        upload_two = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("second", pages=1)), "second.pdf")},
            content_type="multipart/form-data",
        )
        first_id = upload_one.get_json()["documentId"]
        second_id = upload_two.get_json()["documentId"]

        merged = self.client.post(
            "/api/generate/merge",
            json={
                "sessionId": self.session_id,
                "documents": [second_id, first_id],
                "options": {},
            },
        )
        self.assertEqual(merged.status_code, 200)
        with fitz.open(stream=merged.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 3)
            self.assertIn("second page 1", doc[0].get_text())
            self.assertIn("first page 1", doc[1].get_text())
            self.assertIn("first page 2", doc[2].get_text())

    def test_split_range_generation(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("range", pages=5)), "range.pdf")},
            content_type="multipart/form-data",
        )
        document_id = upload.get_json()["documentId"]

        merged_ranges = self.client.post(
            "/api/generate/split",
            json={
                "sessionId": self.session_id,
                "pages": [{"documentId": document_id, "page": 1}],
                "options": {
                    "splitMode": "range",
                    "documentId": document_id,
                    "ranges": [{"from": 1, "to": 2}, {"from": 4, "to": 5}],
                    "mergeRanges": True,
                },
            },
        )
        self.assertEqual(merged_ranges.status_code, 200)
        with fitz.open(stream=merged_ranges.data, filetype="pdf") as doc:
            self.assertEqual(doc.page_count, 4)
            self.assertIn("range page 1", doc[0].get_text())
            self.assertIn("range page 5", doc[3].get_text())

    def test_redact_search_and_mark_generation(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("sensitive NAME", pages=1)), "redact.pdf")},
            content_type="multipart/form-data",
        )
        document_id = upload.get_json()["documentId"]
        search = self.client.post(
            "/api/redact/search",
            json={"sessionId": self.session_id, "documentId": document_id, "term": "NAME", "ocr": False},
        )
        self.assertEqual(search.status_code, 200)
        matches = search.get_json()["matches"]
        self.assertGreaterEqual(len(matches), 1)

        redacted = self.client.post(
            "/api/generate/redact",
            json={
                "sessionId": self.session_id,
                "pages": [{"documentId": document_id, "page": 1}],
                "options": {"rects": [{"page": 1, "rect": matches[0]["rect"]}], "terms": ""},
            },
        )
        self.assertEqual(redacted.status_code, 200)
        with fitz.open(stream=redacted.data, filetype="pdf") as doc:
            self.assertNotIn("NAME", doc[0].get_text())

    def test_generate_excel_from_preview(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(table_pdf_with_image()), "report.pdf")},
            content_type="multipart/form-data",
        )
        document_id = upload.get_json()["documentId"]

        converted = self.client.post(
            "/api/generate/excel",
            json={
                "sessionId": self.session_id,
                "pages": [{"documentId": document_id, "page": 1}],
                "options": {},
            },
        )
        self.assertEqual(converted.status_code, 200)
        self.assertEqual(
            converted.mimetype,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        self.assertIn("converted-report.xlsx", converted.headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(converted.data)) as workbook:
            sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
            styles = workbook.read("xl/styles.xml").decode("utf-8")
            names = workbook.namelist()
        self.assertIn('<c r="A1" s="1" t="inlineStr"><is><t>Name</t></is></c>', sheet)
        self.assertIn('<c r="B1" s="1" t="inlineStr"><is><t>Amount</t></is></c>', sheet)
        self.assertIn('<c r="A2" s="0" t="inlineStr"><is><t>Alice</t></is></c>', sheet)
        self.assertIn("<b/>", styles)
        self.assertIn("xl/drawings/drawing1.xml", names)
        self.assertIn("xl/media/image1.png", names)

    def test_generate_word_and_ppt_from_preview(self):
        upload = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(table_pdf_with_image()), "report.pdf")},
            content_type="multipart/form-data",
        )
        document_id = upload.get_json()["documentId"]
        payload = {
            "sessionId": self.session_id,
            "pages": [{"documentId": document_id, "page": 1}],
            "options": {},
        }

        word = self.client.post("/api/generate/word", json=payload)
        self.assertEqual(word.status_code, 200)
        self.assertEqual(word.mimetype, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertIn("converted-report.docx", word.headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(word.data)) as document:
            document_xml = document.read("word/document.xml").decode("utf-8")
            names = document.namelist()
        self.assertIn("<w:b/>", document_xml)
        self.assertIn("Name", document_xml)
        self.assertIn("Alice", document_xml)
        self.assertIn("word/media/image1.png", names)

        ppt = self.client.post("/api/generate/ppt", json=payload)
        self.assertEqual(ppt.status_code, 200)
        self.assertEqual(ppt.mimetype, "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        self.assertIn("converted-report.pptx", ppt.headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(ppt.data)) as deck:
            slide_xml = deck.read("ppt/slides/slide1.xml").decode("utf-8")
            names = deck.namelist()
        self.assertIn('b="1"', slide_xml)
        self.assertIn("Name", slide_xml)
        self.assertIn("Alice", slide_xml)
        self.assertIn("WhiteText", slide_xml)
        self.assertIn('val="FFFFFF"', slide_xml)
        self.assertLess(slide_xml.index("<p:pic>"), slide_xml.index("<a:t>Name</a:t>"))
        self.assertIn("ppt/media/image1.png", names)

    def test_invalid_pdf_error_is_generic(self):
        response = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(b"not a pdf"), "bad.pdf")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        error = response.get_json()["error"]
        self.assertEqual(error, "Invalid PDF file")
        self.assertNotIn(str(self.tempdir.name), error)

    def test_pdf_page_limit_is_enforced(self):
        pdf_app.MAX_PDF_PAGES = 2
        response = self.client.post(
            "/api/document",
            data={"sessionId": self.session_id, "file": (io.BytesIO(sample_pdf("many", pages=3)), "many.pdf")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("maximum allowed is 2", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
