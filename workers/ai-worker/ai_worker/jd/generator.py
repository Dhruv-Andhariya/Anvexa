"""M02 JD generator: JobForm + CompanyProfile -> seniority -> versioned prompt -> LLM (structured JSON) ->
validated JdContent.

The prompt gets the seniority guidance and style examples for THIS role's level (from the prompt file), and the
API's fact-check corrections when it asks for a second draft. Grounding is enforced by the API afterwards
(packages/contracts jd-review.ts); this module only cleans the output shape."""
import json
import logging
import time
from dataclasses import dataclass

from pydantic import ValidationError

from ..llm_gateway import (
    LLMInvalidOutputError,
    LLMProvider,
    LLMTimeoutError,
    PromptSpec,
    escape_data,
    parse_json_object,
)
from ..schemas import CompanyProfile, JdContent, JobForm
from .seniority import Seniority, seniority_for

log = logging.getLogger("ai_worker.jd")

PROMPT_FILE = "jd_generate.v4.yaml"
NO_COMPANY_PROFILE = "(not provided)"
NO_CORRECTIONS = "(none)"
MAX_ATTEMPTS = 2  # one automatic retry on invalid output (doc 13.1), no more - protects quota

_WORK_MODES = {"ONSITE": "On-site", "HYBRID": "Hybrid", "REMOTE": "Remote"}
_EMPLOYMENT_TYPES = {
    "FULL_TIME": "Full-time",
    "PART_TIME": "Part-time",
    "INTERNSHIP": "Internship",
    "CONTRACT": "Contract",
}


@dataclass(frozen=True)
class GeneratedJd:
    content: JdContent
    model: str
    prompt_version: str


def generate_jd(
    form: JobForm,
    provider: LLMProvider,
    prompt: PromptSpec,
    company: CompanyProfile | None = None,
    *,
    budget_seconds: float | None = None,
    corrections: list[str] | None = None,
) -> GeneratedJd:
    """`budget_seconds` caps the WHOLE generation (output retry, provider retries and fallback models),
    so the worker answers before the API stops waiting for it."""
    level = seniority_for(form)
    rendered = prompt.render(
        requirements=requirements_block(form),
        company=company_block(company),
        seniority=seniority_block(prompt, level),
        examples=examples_block(prompt, level),
        corrections=corrections_block(corrections),
    )
    deadline = time.monotonic() + budget_seconds if budget_seconds else None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if deadline is not None and time.monotonic() >= deadline:
            log.warning("jd generation budget exhausted", extra={"attempt": attempt})
            raise LLMTimeoutError()
        result = provider.generate_json(
            system=prompt.system,
            prompt=rendered,
            schema=JdContent,
            temperature=prompt.temperature,
            deadline=deadline,
        )
        try:
            content = parse_jd_output(result.text, form, has_company=company is not None)
        except (ValueError, TypeError, ValidationError) as exc:
            # log the failure class only - never the model output (may echo user data)
            log.warning(
                "jd output invalid",
                extra={"attempt": attempt, "error_type": type(exc).__name__},
            )
            continue
        return GeneratedJd(content=content, model=result.model, prompt_version=prompt.version)
    raise LLMInvalidOutputError()


def requirements_block(form: JobForm) -> str:
    """Human-readable facts for the prompt. Only fields HR supplied are included."""
    data: dict[str, object] = {
        "title": form.title,
        "department": form.department or None,
        "experience": _experience(form),
        "mustHaveSkills": form.mustHaveSkills,
        "niceToHaveSkills": form.niceToHaveSkills,
        "locations": form.locations,
        "workMode": _WORK_MODES[form.workMode],
        "employmentType": _EMPLOYMENT_TYPES[form.employmentType],
        "openings": form.openings,
        "salary": _salary(form),
        "additionalRequirements": form.shortDescription or None,
    }
    return _data_block(data)


def company_block(company: CompanyProfile | None) -> str:
    """The saved company profile as prompt data. Only fields HR filled in are included."""
    if company is None:
        return NO_COMPANY_PROFILE
    return _data_block(company.model_dump())


def seniority_block(prompt: PromptSpec, level: Seniority) -> str:
    """The prompt file's guidance for this level (what the role owns, which verbs fit, what it must not claim)."""
    return str(prompt.extras.get("seniority", {}).get(level, f"Level: {level}")).strip()


def examples_block(prompt: PromptSpec, level: Seniority) -> str:
    """Style references for the same level only - showing other levels would blur the depth."""
    return str(prompt.extras.get("examples", {}).get(level, "(none)")).strip()


def corrections_block(corrections: list[str] | None) -> str:
    if not corrections:
        return NO_CORRECTIONS
    lines = "\n".join(f"- {c}" for c in corrections)
    # checker messages quote words from the previous draft - keep them inside the data tag
    return escape_data(f"Your previous draft had these problems. Fix all of them in this draft:\n{lines}")


def _data_block(data: dict[str, object]) -> str:
    data = {k: v for k, v in data.items() if v not in (None, [], "")}
    # keep user text from closing the <job_requirements>/<company_profile> data tags (prompt-injection hardening)
    return escape_data(json.dumps(data, ensure_ascii=False, indent=2))


def parse_jd_output(text: str, form: JobForm, *, has_company: bool = False) -> JdContent:
    raw = JdContent.model_validate(parse_json_object(text))
    return JdContent.model_validate(
        {
            "title": form.title,  # HR's title is authoritative; never let the model rename the role
            "summary": raw.summary.strip(),
            # without a profile there are no company facts to describe - drop anything the model made up
            "aboutCompany": raw.aboutCompany.strip() if has_company else "",
            "responsibilities": _clean(raw.responsibilities),
            "requirements": _clean(raw.requirements),
            "niceToHave": _clean(raw.niceToHave),
            "benefits": _clean(raw.benefits),
        }
    )


def _clean(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        value = item.strip().lstrip("-*• ").strip()
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            out.append(value)
    return out


def _fmt_years(value: float) -> str:
    return str(int(value)) if value == int(value) else str(value)


def _experience(form: JobForm) -> str:
    lo, hi = _fmt_years(form.experienceMin), _fmt_years(form.experienceMax)
    if form.experienceMax == 0:
        return "0 years (entry level / fresher)"
    return f"{lo} years" if lo == hi else f"{lo}-{hi} years"


def _salary(form: JobForm) -> str | None:
    def fmt(v: float) -> str:
        return f"{v:,.0f}"

    lo, hi = form.salaryMin, form.salaryMax
    if lo is None and hi is None:
        return None
    if lo is not None and hi is not None:
        amount = fmt(lo) if lo == hi else f"{fmt(lo)} - {fmt(hi)}"
    elif lo is not None:
        amount = f"from {fmt(lo)}"
    else:
        amount = f"up to {fmt(hi)}"  # type: ignore[arg-type]
    kind = "CTC" if form.salaryType == "CTC" else "in-hand"
    return f"{form.currency} {amount} ({kind})"
