"""H4: prompt-injection screening, deterministic and independent of the AI.

Trust model: only the system instruction (app/prompts/dsa_prompt.py) and the execution summary the worker computes from
enums are trusted. The problem text, the candidate code (comments, strings, identifiers, data) and the compiler output
are untrusted data.

  - scan_request: untrusted text that addresses the evaluator (instructions to ignore rules, award a band, fake
    system / developer messages, forged data markers, references to the output schema), also when it is split across
    strings, spaced out, in leetspeak, homoglyphs, full-width letters, reversed, ROT13, base64, hex, \\x / \\u escapes or
    character-code lists. A hit -> RE-EVALUATE (INJECTION_SUSPECTED) before any AI call: such a submission cannot be
    evaluated safely, so it goes to human review; it is never penalised with a band.
  - scan_reply: an AI reply that repeats injected instructions or says it followed instructions found in the data ->
    RE-EVALUATE (INJECTION_SUSPECTED).

The patterns are narrow on purpose: ordinary code and problem statements ("ignore duplicates", "maximum score",
`System.out.println`, `system_message`) must not trigger them. Nothing matched is ever logged or returned.
"""

from __future__ import annotations

import base64
import binascii
import codecs
import re
import unicodedata

from ..schemas.dsa_evaluation import AiDsaAssessment, DsaEvaluationRequest

_ZERO_WIDTH = re.compile("[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]")
#: Common Cyrillic / Greek look-alikes of Latin letters (NFKC does not fold them).
_CONFUSABLES = str.maketrans("аеорсухіјѕԁԛԝοαεικνρτυχ", "aeopcyxijsdqwoaeikvptux")
_LEET = str.maketrans("013457@$", "oieastas")

_AI = r"(?:ai|llm|gemini|gpt|chatgpt|grader|evaluator|assessor)"
#: Multi-word objects only: a bare `this` / `it` / `me` would match code such as `rate(this, 100)` or `mark[it] = 100`.
_OBJ = r"(?:thecode|thiscode|thesolution|thissolution|thesubmission|thissubmission|mycode|mysolution|thecandidate)"

#: Searched in the text with everything except a-z / 0-9 removed (so "i g n o r e", "ign" + "ore", 'i','g',... match).
#: Used for untrusted input AND for the AI's reply.
_COMPACT = [
    re.compile(r"(?:ignore|disregard|forget|override|bypass)(?:all|any)?(?:of)?(?:the|your|my)?"
               r"(?:previous|prior|above|earlier|preceding|original|system|grading)?"
               r"(?:instructions?|rules?|prompts?|directions?|rubric|guidelines?)"),
    re.compile(r"youarenow(?:a|an|the)?(?:grader|evaluator|assessor|admin|administrator|system|ai|assistant|model)"),
    re.compile(r"newinstructions?|systemprompt|systeminstructions?|developermessage|developerprompt|"
               r"developerinstructions?|adminoverride|systemoverride|rubricoverride"),
    re.compile(r"(?:noteto|messageto|instructionsfor|instructionto)(?:the|any)?" + _AI),
    re.compile(r"(?:dear|hey)(?:gemini|chatgpt|gpt|llm|grader|evaluator|assessor)"),
    re.compile(r"(?:verified|approved|certified)by(?:the)?(?:admin|administrator|system|hiringteam|platform|grader|recruiter|hr)"),
    re.compile(r"endcandidatecode|endcompileroutput|endproblem"),
]
#: Untrusted input only (an AI reply may legitimately say "the proposed band" or "treat the solution as correct").
_COMPACT_INPUT = [
    re.compile(r"proposedband|logicband"),
    re.compile(r"(?:grade|mark|rate|treat|evaluate|assess|score)" + _OBJ + r"(?:as)?(?:correct|perfect|passing|passed|flawless|100|full)"),
    re.compile(r"(?:give|award|assign)" + _OBJ + r"(?:a)?(?:100|fullmarks|fullscore|fullpoints|perfectscore|maximumscore|"
               r"maxscore|topscore|highestscore|highestband|band100)"),
    re.compile(r"(?:donot|dont|never)(?:report|flag|mention)(?:any)?(?:defects?|bugs?|mistakes?)"),
]
#: Searched in the normalised text (case-insensitive, layout kept).
_RAW = [
    re.compile(r"<\|im_(?:start|end)\|>|<\|(?:system|user|assistant)\|>|\[/?inst\]|<<\s*/?sys\s*>>|<\s*/?\s*(?:system|developer)\s*>"),
    # a fake role line inside a comment or string: "# SYSTEM: ...", '"developer message: ...', "// [system]: ..."
    re.compile(r"^\s*(?:#|//|/\*|\*|--|;|['\"`])+\s*\[?(?:system|developer|assistant)\]?"
               r"(?:\s+(?:message|prompt|note|instruction))?\s*[:\]]", re.MULTILINE),
    # ... or at the start of a string anywhere on a line: x = "[system]: ...", msg = 'SYSTEM MESSAGE: ...'
    re.compile(r"['\"`]\s*\[?(?:system|developer|assistant)\]?(?:\s+(?:message|prompt|note|instruction))?\s*[:\]]"),
    re.compile(r"<<<\s*/?\s*(?:end_)?(?:candidate_code|compiler_output|problem)"),
    re.compile(r"\b(?:give|award|assign|grade|rate|score)\s+(?:this|it|me|the\s+(?:code|solution|submission|candidate)|"
               r"my\s+(?:code|solution))\b[^\n.]{0,20}?\b100\s*(?:%|percent\b)"),
    # "give this 100" / "award me full marks", separated by spaces only (not `rate(this, 100)`)
    re.compile(r"\b(?:give|award|assign)\s+(?:this|it|me)\s+(?:a\s+)?(?:100|full\s+marks|perfect\s+score)\b"),
]
#: Phrases an AI reply uses when it followed (or reports) instructions found in the untrusted data.
_COMPLIANCE = re.compile(
    r"\bas\s+(?:instructed|requested|directed)\b|\b(?:i|we)\s+(?:have\s+been|was|were|am)\s+(?:told|instructed|asked)\b|"
    r"\b(?:instructions?|requests?|directives?)\s+(?:in|inside|from|within|embedded\s+in)\s+(?:the\s+)?"
    r"(?:code|comments?|strings?|submission|problem|compiler\s+output)\b|\bfull\s+marks\b",
    re.IGNORECASE,
)

_B64 = re.compile(r"[A-Za-z0-9+/]{16,}={0,2}")
_HEX_ESC = re.compile(r"(?:\\x[0-9a-fA-F]{2}){8,}")
_UNI_ESC = re.compile(r"(?:\\u[0-9a-fA-F]{4}){8,}")
_HEX_RUN = re.compile(r"\b(?:[0-9a-fA-F]{2}){8,}\b")
_CODES = re.compile(r"(?:\b\d{2,3}\b\s*,\s*){7,}\b\d{2,3}\b")
_CHR = re.compile(r"chr\s*\(\s*(\d{2,3})\s*\)|\(\s*char\s*\)\s*(\d{2,3})")


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    return _ZERO_WIDTH.sub("", text).lower().translate(_CONFUSABLES)


def _printable(data: bytes) -> str | None:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return text if text and sum(ch.isprintable() or ch.isspace() for ch in text) >= 0.9 * len(text) else None


def _decoded(text: str) -> list[str]:
    """Plain text hidden in common encodings (one level)."""
    out: list[str] = []
    for token in _B64.findall(text):
        try:
            decoded = _printable(base64.b64decode(token + "=" * (-len(token) % 4), validate=True))
        except (binascii.Error, ValueError):
            decoded = None
        if decoded:
            out.append(decoded)
    for m in _HEX_ESC.findall(text):
        out.append(bytes(int(h, 16) for h in re.findall(r"\\x([0-9a-fA-F]{2})", m)).decode("latin-1"))
    for m in _UNI_ESC.findall(text):
        out.append("".join(chr(int(h, 16)) for h in re.findall(r"\\u([0-9a-fA-F]{4})", m)))
    for m in _HEX_RUN.findall(text):
        decoded = _printable(bytes.fromhex(m))
        if decoded:
            out.append(decoded)
    for m in _CODES.finditer(text):
        numbers = [int(n) for n in re.findall(r"\d+", m.group())]
        if all(32 <= n < 127 for n in numbers):
            out.append("".join(map(chr, numbers)))
    chars = [int(a or b) for a, b in _CHR.findall(text)]
    if len(chars) >= 8 and all(32 <= n < 127 for n in chars):
        out.append("".join(map(chr, chars)))
    return out


def _addresses_evaluator(text: str, patterns: list[re.Pattern[str]]) -> bool:
    norm = _normalise(text)
    if any(p.search(norm) for p in _RAW):
        return True
    compact = re.sub(r"[^a-z0-9]", "", norm)
    forms = (compact, compact.translate(_LEET), codecs.encode(compact, "rot13"), compact[::-1])
    return any(p.search(form) for form in forms for p in patterns)


def instruction_like(text: str, *, reply: bool = False) -> bool:
    """True when the text (or a decoded part of it) contains instructions addressed to the evaluator."""
    if not text:
        return False
    patterns = _COMPACT if reply else _COMPACT + _COMPACT_INPUT
    if _addresses_evaluator(text, patterns):
        return True
    return any(_addresses_evaluator(d, patterns) for d in _decoded(text))


def scan_request(request: DsaEvaluationRequest) -> str | None:
    """The untrusted source that carries instruction-like text ("problem", "code", "compiler_output"), or None."""
    p = request.problem
    problem = "\n".join([p.title, p.statement, p.input_format, p.output_format, *p.constraints])
    for source, text in (("code", request.submission.code), ("compiler_output", request.execution.compile_output), ("problem", problem)):
        if instruction_like(text):
            return source
    return None


def scan_reply(assessment: AiDsaAssessment) -> bool:
    """True when the AI's own words repeat injected instructions or say it followed instructions from the data."""
    texts = [assessment.reasoning, *(d.description for d in assessment.defects)]
    return any(_COMPLIANCE.search(t) or instruction_like(t, reply=True) for t in texts)
