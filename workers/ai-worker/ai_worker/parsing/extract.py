"""M10 resume text extraction: PDF (pypdf) and DOCX (python-docx) bytes -> plain text.
The API already checked the file type (magic bytes), size and viruses before saving it."""
import io
import logging
import re
import zipfile

log = logging.getLogger("ai_worker.parsing")

PDF = "application/pdf"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
MAX_PAGES = 10  # a resume; anything longer is cut, never refused
MAX_CHARS = 20_000  # what goes to the model (protects quota); resumes are far shorter
MIN_CHARS = 80  # less than this = nothing readable (e.g. a scanned image PDF)


class ResumeUnreadableError(Exception):
    """The file holds no readable text. Not a technical error to retry: HR reviews it by hand."""

    status_code = 422
    code = "RESUME_UNREADABLE"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class ResumeHasNoTextError(ResumeUnreadableError):
    """The file opened fine but holds (almost) no text - usually a scan or a phone photo saved as PDF.
    The only unreadable case the scanned-resume fallback (ocr.py) may try to read from the page images."""


def extract_text(data: bytes, mime_type: str) -> str:
    if mime_type == PDF:
        text = _pdf_text(data)
    elif mime_type == DOCX:
        text = _docx_text(data)
    else:
        raise ResumeUnreadableError("Only PDF and DOCX resumes can be read.")
    return usable_text(text)


def usable_text(text: str) -> str:
    """Normalised text, cut to what the model may see. Too little text = ResumeHasNoTextError."""
    text = _normalize(text)
    if len(text) < MIN_CHARS:
        raise ResumeHasNoTextError(
            "The resume has no readable text (it may be a scanned image). HR should review it by hand."
        )
    return text[:MAX_CHARS]


def first_pages(data: bytes) -> bytes:
    """The PDF cut to MAX_PAGES, so the model never reads (and bills) more pages than pypdf would.
    Only called on a PDF pypdf already opened; if rewriting fails anyway, the original bytes are used."""
    from pypdf import PdfReader, PdfWriter

    try:
        reader = PdfReader(io.BytesIO(data))
        if len(reader.pages) <= MAX_PAGES:
            return data
        writer = PdfWriter()
        for page in reader.pages[:MAX_PAGES]:
            writer.add_page(page)
        out = io.BytesIO()
        writer.write(out)
        return out.getvalue()
    except Exception as exc:  # noqa: BLE001 - a malformed PDF can fail in many ways; the original still works
        log.warning("pdf page cut failed", extra={"error_type": type(exc).__name__})
        return data


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader
    from pypdf.errors import DependencyError, PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ResumeUnreadableError("The PDF is password-protected, so it cannot be read.")
        pages = reader.pages[:MAX_PAGES]
        return "\n".join(page.extract_text() or "" for page in pages)
    except ResumeUnreadableError:
        raise
    except (PyPdfError, DependencyError, ValueError, KeyError, TypeError, OSError, IndexError, AttributeError, ArithmeticError,
            RecursionError, NotImplementedError) as exc:
        # DependencyError: an AES-encrypted PDF while `cryptography` is not installed. A malformed file can
        # break pypdf in many ways - every one of them means "this file cannot be read", not a server error to retry
        log.warning("pdf unreadable", extra={"error_type": type(exc).__name__})
        raise ResumeUnreadableError("The PDF file is damaged or could not be read.") from None


def _docx_text(data: bytes) -> str:
    import docx
    from docx.opc.exceptions import PackageNotFoundError

    try:
        document = docx.Document(io.BytesIO(data))
    except (PackageNotFoundError, zipfile.BadZipFile, ValueError, KeyError, OSError) as exc:
        log.warning("docx unreadable", extra={"error_type": type(exc).__name__})
        raise ResumeUnreadableError("The DOCX file is damaged or could not be read.") from None
    parts = [p.text for p in document.paragraphs]
    for table in document.tables:  # many resume templates put everything in tables
        for row in table.rows:
            parts.append(" | ".join(cell.text for cell in row.cells))
    return "\n".join(parts)
 

_SPACES = re.compile(r"[ \t ]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")


def _normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _SPACES.sub(" ", text)
    return _BLANK_LINES.sub("\n\n", text).strip()
