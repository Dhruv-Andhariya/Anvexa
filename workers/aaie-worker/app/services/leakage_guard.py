"""H5 (D21): no corrected code and no actionable solution in the AI's reply. Deterministic; runs before any band.

The AI may *describe* what is wrong and why it matters, mention operators / variables / syntax, and quote the
candidate's own code. It may not say *how to fix it*. A reply is refused (RE-EVALUATE, AI_SOLUTION_LEAKAGE) when its
reasoning or a defect description contains:

  1. a code block (``` or ~~~), or a multi-line defect description;
  2. inline `code` that is not verbatim text of the submission (a single operator or a single identifier is allowed:
     "the `<` comparison", "`left` is never reset");
  3. code-shaped text that is not part of the submission: a corrected control statement ("for i in range(1, n):",
     "for (int i = 0; i <= n; i++) {"), a function with a body ("def f(a): return a"), a self-referencing or computed
     assignment ("i = i + 1", "best = max(best, cur)"), an increment ("count += 1", "i++"), or a code-like line;
  4. a prescription: an imperative or modal fix ("Use <= ...", "you should initialise ...", "must be changed",
     "should be <=", "needs `<=`", "`<=` would be correct", "replace ... with ...", "< -> <="), an explicit fix or
     solution statement ("to fix this", "the correct condition is", "the solution is to"), or a suggestion;
  5. step-by-step instructions ("Step 1", numbered / bulleted lines, "First, sort ...; then use ...").

Text inside backticks that is verbatim candidate code is ignored by the prose rules (4, 5). Nothing matched is ever
logged or returned: the caller only gets the rule name.
"""

from __future__ import annotations

import re

from ..schemas.dsa_evaluation import AiDsaAssessment

_INLINE = re.compile(r"`([^`\n]+)`")
_SINGLE_TOKEN = re.compile(r"\s*(?:[A-Za-z_]\w*|\d+|[<>=!+\-*/%&|^~.:;,\[\]{}()]{1,3})\s*")

# ---------------------------------------------------------------------------------------------- 3. code-shaped text
_IDENT = r"[A-Za-z_][\w.]*(?:\[[^\]\n]{0,30}\])?"
_ATOM = r"(?:[A-Za-z_][\w.]*(?:\([^()\n]{0,40}\)|\[[^\]\n]{0,30}\])?|\d+)"
_ASSIGN = re.compile(rf"(?<![=<>!])\b({_IDENT})\s*=(?!=)\s*({_ATOM}(?:\s*[+\-*/%]\s*{_ATOM})*)")
#: "i++" / "count += 1" ("++" / "--" without a space, so a prose dash "loop -- which" is not an increment)
_AUGMENTED = re.compile(rf"\b{_IDENT}(?:\+\+|--)|\b{_IDENT}\s*[+\-*/%]=(?:\s*{_ATOM})?")
_LANGUAGE_NAMES = re.compile(r"\b(?:C|c|g|G)\+\+")
_CONTROL = re.compile(r"\b(?:if|elif|while|for)\b[^\n:{}`]{1,80}?(?::(?!\S)|\{)")
_FUNCTION = re.compile(
    r"\bdef\s+\w+\s*\([^)\n]*\)\s*:\s*\S[^\n]*|"
    r"\b(?:public|private|protected|static|void|int|long|bool|boolean|auto|string|String|vector<[^>\n]*>)"
    r"(?:\s+[\w<>\[\],]+)*\s+\w+\s*\([^)\n]*\)\s*\{[^\n]*"
)
_CODE_CHARS = re.compile(r"[=<>!\[\]()+\-*/%{};]")
_CODE_LINE = re.compile(
    r"^\s{2,}\S|[;{}]\s*$|^\s*(?:def|class|for|while|if|elif|else|return|int|long|void|public|private|static|import|"
    r"#include)\b.*[:({;=]"
)

# ---------------------------------------------------------------------------------------------- 4. prescriptions
_VERBS = (r"(?:change|replace|swap|rewrite|modify|switch|use|add|remove|delete|insert|initiali[sz]e|increment|decrement|"
          r"wrap|move|declare|append|store|update|reset|set|put|write|call|start|begin|convert|cast|fix|correct)")
_PRESCRIPTIONS = [
    # imperative at the start of a sentence / clause, or after "just", "simply", "instead,"
    # ("correct" is not in this list: "Correct approach; one slip." is an assessment, not an instruction)
    re.compile(r"(?:^|[.!?;:]\s+|\(\s*|\b(?:just|simply|instead,?|so|then)\s+)(?:change|replace|swap|rewrite|modify|switch|use|"
               r"add|remove|delete|insert|initiali[sz]e|increment|decrement|wrap|move|declare|append|store|update|reset|"
               r"fix|try|make\s+sure)\b", re.IGNORECASE),
    # modal / advisory + a change verb
    re.compile(r"\b(?:should|must|needs?\s+to|has\s+to|have\s+to|ought\s+to|would\s+need\s+to|(?:is|be|would\s+be)\s+better\s+to|"
               r"it\s+is\s+(?:enough|sufficient)\s+to|make\s+sure\s+to|remember\s+to)\s+(?:instead\s+)?" + _VERBS + r"\b",
               re.IGNORECASE),
    # passive modal: "must be changed", "should be initialised"
    re.compile(r"\b(?:should|must|needs?\s+to|has\s+to|have\s+to|ought\s+to)\s+be\s+(?:changed|replaced|rewritten|updated|modified|"
               r"swapped|initiali[sz]ed|set|moved|removed|added|wrapped|converted|reset|declared|incremented|decremented|cast|"
               r"stored)\b",
               re.IGNORECASE),
    # "should be <=", "must be `i + 1`", "should be len(nums)", "should be zero"
    re.compile(r"\b(?:should|must|needs?\s+to|ought\s+to|has\s+to|have\s+to)\s+(?:be|read|say|become|equal)\s+"
               r"(?:`|[<>=!+\-*/%&|^~]|\d|[A-Za-z_]\w*\s*[(\[]|(?:zero|one|minus\s+one|true|false|none|null)\b)",
               re.IGNORECASE),
    # "needs `<=`", "requires <=", "expects ++"
    re.compile(r"\b(?:needs?|requires?|wants?|expects?)\s+(?:an?\s+|the\s+)?(?:`|[<>=!]=?(?!\w)|\+\+|--|[+\-*/%]=)", re.IGNORECASE),
    # "`<=` would be correct", "<= would fix it"
    re.compile(r"(?:`[^`\n]+`|(?<!\w)[<>=!+\-*/%&|^]{1,3}(?!\w))\s+(?:would|will|should)\s+(?:be\s+)?(?:fix|correct|solve|work|right)",
               re.IGNORECASE),
    # "< -> <=", "`<` => `<=`" (an operator or code on both sides, so "[3, 3] -> [0, 1]" and `it->second` are fine)
    re.compile(r"(?:`[^`\n]+`|QUOTE|(?<!\w)[<>=!+\-*/%&|^]{1,3})\s+(?:->|=>|→|⇒)\s+(?:`|[<>=!+\-*/%&|^])"),
    # "replace X with Y" / "replacing X by Y" / "swap X for Y"
    re.compile(r"\b(?:replac(?:e|ing)|swap(?:ping)?|chang(?:e|ing)|turn(?:ing)?|rewrit(?:e|ing))\b[^.\n]{0,60}?\b(?:with|by|into|for|to)\s+"
               r"(?:`|[<>=!+\-*/%]|\d|[A-Za-z_]\w*\s*[(\[])", re.IGNORECASE),
    # "by using a set", "try using", "consider using"
    re.compile(r"\b(?:by|try|consider|recommend|suggest)\s+using\b", re.IGNORECASE),
    # a sentence that starts with a change and says it fixes the code: "Replacing the map with two pointers solves it."
    re.compile(r"(?:^|[.!?;]\s+)(?:replacing|swapping|switching|changing|using|adding|removing|sorting|storing|initiali[sz]ing|"
               r"moving|rewriting|checking|keeping)\b[^.\n]{0,80}?\b(?:fixes|solves|corrects|resolves|would\s+(?:fix|solve|correct|"
               r"resolve)|makes\s+it\s+(?:correct|work|pass))\b", re.IGNORECASE),
    # explicit fix / solution statements
    re.compile(r"\b(?:the\s+)?(?:correct|right|proper|fixed|working|optimal|intended)\s+(?:code|solution|implementation|version|fix|"
               r"line|statement|condition|loop|program|function|approach|algorithm|expression|check)\s+(?:is|would\s+be|should\s+be|"
               r"looks\s+like|reads|uses|requires)\b", re.IGNORECASE),
    re.compile(r"\b(?:to\s+fix\s+(?:this|it|the\s+\w+)|the\s+fix\s+is|a\s+fix\s+would|fix(?:ed)?\s+by|correct(?:ed)?\s+by|"
               r"solved\s+by|resolved\s+by|the\s+solution\s+is\s+to|a\s+correct\s+solution\s+would)\b", re.IGNORECASE),
    re.compile(r"\b(?:i|we)\s+(?:suggest|recommend)\b|\b(?:suggestion|recommendation|hint|fix)\s*:", re.IGNORECASE),
]

# ---------------------------------------------------------------------------------------------- 5. step-by-step
_STEPS = [
    re.compile(r"\bstep\s*(?:\d+|one|two|three)\b|\bsteps\s*:", re.IGNORECASE),
    re.compile(r"\b(?:first|then|next|finally|after\s+that|afterwards)\s*,?\s+" + _VERBS + r"\b", re.IGNORECASE),
]
_LIST_LINE = re.compile(r"^\s*(?:\d+[.)]|[-*•])\s+\S", re.MULTILINE)


def _norm(text: str) -> str:
    return " ".join(text.split())


def _strip_quotes(text: str, code: str) -> str:
    """Backticked spans that are verbatim candidate code become a neutral word, so prose rules ignore them."""
    return _INLINE.sub(lambda m: " QUOTE " if _norm(m.group(1)) in code else m.group(0), text)


def _foreign_code(text: str, code: str) -> bool:
    text = _LANGUAGE_NAMES.sub("CPP", text)
    for m in _ASSIGN.finditer(text):
        lhs, rhs = m.group(1), m.group(2)
        # arithmetic or a self-reference is a statement; "n = len(nums)" / "target = 6" are notation / example values
        computed = bool(re.search(r"[+\-*/%]", rhs))
        self_ref = re.search(rf"\b{re.escape(lhs.split('[')[0])}\b", rhs) is not None
        if (computed or self_ref) and _norm(m.group(0)) not in code:
            return True
    for pattern in (_AUGMENTED, _FUNCTION):
        if any(_norm(m.group(0)) not in code for m in pattern.finditer(text)):
            return True
    for m in _CONTROL.finditer(text):
        fragment = _norm(m.group(0))
        if _CODE_CHARS.search(fragment) and fragment not in code:
            return True
    return False


def leakage(assessment: AiDsaAssessment, submitted_code: str) -> str | None:
    """The rule a reply breaks (for metadata only), or None when it contains no corrected code or solution."""
    code = _norm(submitted_code)
    texts = [assessment.reasoning, *(d.description for d in assessment.defects)]
    if any("\n" in d.description for d in assessment.defects):
        return "multi-line defect description"
    for text in texts:
        if "```" in text or "~~~" in text:
            return "code block"
        for inline in _INLINE.findall(text):
            if _norm(inline) and _norm(inline) not in code and not _SINGLE_TOKEN.fullmatch(inline):
                return "inline code that is not part of the submission"
        prose = _strip_quotes(text, code)
        if _foreign_code(prose, code):
            return "code that is not part of the submission"
        if any(_CODE_LINE.search(line) and _norm(line) not in code for line in text.split("\n")[1:]):
            return "code-like line"
        if any(p.search(prose) for p in _PRESCRIPTIONS):
            return "fix or solution instruction"
        if any(p.search(prose) for p in _STEPS) or len(_LIST_LINE.findall(text)) >= 2:
            return "step-by-step instructions"
    return None
