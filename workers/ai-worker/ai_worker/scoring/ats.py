"""M11 ATS scorer: resume text + the approved JD -> explainable score out of 100.

The model only READS the resume against the job (which skills are there, which experience and projects are
relevant, with evidence). The score itself is a fixed, published formula computed here, so the same reading
always gives the same score and every point has a reason:

    Technical skills .......................... 40  (must-have 35 + nice-to-have 5)
    Work experience & internships ............. 20
    Projects relevant to the job domain ....... 20
    Achievements & certifications ............. 10
    Qualifications ............................ 10
"""
import json
import logging
import re
import time

from pydantic import BaseModel, ValidationError

from ..llm_gateway import (
    LLMInvalidOutputError,
    LLMProvider,
    LLMTimeoutError,
    PromptSpec,
    escape_data,
    parse_json_object,
)
from ..schemas import (
    AtsPart,
    ParsedEducation,
    ParsedExperience,
    ParsedProject,
    ParsedResume,
    ResumeScreenResult,
    ScreenJd,
    ScreenJob,
)

log = logging.getLogger("ai_worker.ats")

PROMPT_FILE = "resume_screen.v1.yaml"
MAX_ATTEMPTS = 2  # one retry on invalid output, no more (protects quota)
WEIGHTS = {"skills": 40, "experience": 20, "projects": 20, "achievements": 10, "qualifications": 10}
MUST_HAVE_POINTS = 35
NICE_TO_HAVE_POINTS = 5
FRESHER_INTERNSHIP_MONTHS = 6  # months of relevant internship that give a fresher full experience points


# ---------- what the model fills in (Gemini structured output) ----------


class SkillCheck(BaseModel):
    skill: str
    present: bool
    evidence: str = ""


class ExperienceRead(BaseModel):
    organization: str
    role: str
    kind: str  # job | internship | freelance | other
    months: int = 0
    relevance: int = 0  # 0 none, 1 low, 2 medium, 3 high
    summary: str = ""


class ProjectRead(BaseModel):
    title: str
    technologies: list[str] = []
    relevance: int = 0
    summary: str = ""


class EducationRead(BaseModel):
    institution: str
    degree: str
    field: str = ""
    year: str = ""


class ResumeReading(BaseModel):
    summary: str
    candidateSkills: list[str] = []
    mustHave: list[SkillCheck] = []
    niceToHave: list[SkillCheck] = []
    experience: list[ExperienceRead] = []
    experienceReason: str = ""
    projects: list[ProjectRead] = []
    projectsReason: str = ""
    achievements: list[str] = []
    certifications: list[str] = []
    achievementsRelevance: int = 0
    achievementsReason: str = ""
    education: list[EducationRead] = []
    qualificationFit: int = 0
    qualificationReason: str = ""


def screen_resume(
    resume_text: str,
    job: ScreenJob,
    jd: ScreenJd,
    provider: LLMProvider,
    prompt: PromptSpec,
    *,
    budget_seconds: float | None = None,
    deadline: float | None = None,  # a time.monotonic() value; wins over budget_seconds
) -> ResumeScreenResult:
    rendered = prompt.render(job=job_block(job, jd), resume=escape_data(resume_text))
    if deadline is None and budget_seconds:
        deadline = time.monotonic() + budget_seconds
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if deadline is not None and time.monotonic() >= deadline:
            raise LLMTimeoutError()
        out = provider.generate_json(
            system=prompt.system,
            prompt=rendered,
            schema=ResumeReading,
            temperature=prompt.temperature,
            deadline=deadline,
        )
        try:
            reading = parse_reading(out.text)
        except (ValueError, TypeError, ValidationError) as exc:
            # failure class only - never the model output (it echoes resume content)
            log.warning("resume reading invalid", extra={"attempt": attempt, "error_type": type(exc).__name__})
            continue
        return score(reading, resume_text, job, model=out.model, prompt_version=prompt.version)
    raise LLMInvalidOutputError()


def parse_reading(text: str) -> ResumeReading:
    return ResumeReading.model_validate(parse_json_object(text))


# ---------- the formula ----------


def score(reading: ResumeReading, resume_text: str, job: ScreenJob, *, model: str, prompt_version: str) -> ResumeScreenResult:
    must_found, must_missing = _match_skills(job.mustHaveSkills, reading.mustHave, resume_text)
    nice_found, _ = _match_skills(job.niceToHaveSkills, reading.niceToHave, resume_text)

    must_ratio = len(must_found) / len(job.mustHaveSkills)
    nice_ratio = len(nice_found) / len(job.niceToHaveSkills) if job.niceToHaveSkills else must_ratio
    skills_points = MUST_HAVE_POINTS * must_ratio + NICE_TO_HAVE_POINTS * nice_ratio
    skills_reason = f"Has {len(must_found)} of {len(job.mustHaveSkills)} must-have skills"
    skills_reason += f" (missing: {', '.join(must_missing)})." if must_missing else "."
    if job.niceToHaveSkills:
        skills_reason += f" Nice-to-have: {len(nice_found)} of {len(job.niceToHaveSkills)}."

    exp_points, exp_reason = _experience(reading, job)
    proj_points, proj_reason = _projects(reading)
    ach = _rating(reading.achievementsRelevance)
    ach_points = WEIGHTS["achievements"] * ach / 3
    qual = _rating(reading.qualificationFit)
    qual_points = WEIGHTS["qualifications"] * qual / 3

    parts = [
        _part("skills", "Technical skills", skills_points, skills_reason),
        _part("experience", "Work experience & internships", exp_points, exp_reason),
        _part("projects", "Projects relevant to the role", proj_points, proj_reason),
        _part(
            "achievements",
            "Achievements & certifications",
            ach_points,
            _reason(reading.achievementsReason, "No relevant achievements or certifications found."),
        ),
        _part(
            "qualifications",
            "Qualifications",
            qual_points,
            _reason(reading.qualificationReason, "Education could not be matched to the role."),
        ),
    ]
    total = max(0, min(100, round(sum(p.points for p in parts))))
    return ResumeScreenResult(
        score=total,
        breakdown=parts,
        matchedSkills=must_found + [s for s in nice_found if s not in must_found],
        missingSkills=must_missing,
        profile=_profile(reading),
        model=model,
        promptVersion=prompt_version,
    )


def _match_skills(required: list[str], checks: list[SkillCheck], resume_text: str) -> tuple[list[str], list[str]]:
    """HR's skill list is authoritative: every required skill is decided once, in HR's spelling.
    A skill counts when the model found evidence for it, or when the resume names it literally."""
    by_name = {c.skill.strip().casefold(): c for c in checks}
    found: list[str] = []
    missing: list[str] = []
    for skill in required:
        check = by_name.get(skill.strip().casefold())
        model_says = bool(check and check.present and check.evidence.strip())
        if model_says or _mentions(resume_text, skill):
            found.append(skill)
        else:
            missing.append(skill)
    return found, missing


def _mentions(text: str, skill: str) -> bool:
    # word boundaries that also work for skills like "C++", "C#", "Node.js"
    skill = skill.strip()
    pattern = r"(?<![\w+#.])" + re.escape(skill) + r"(?![\w+#])"
    # very short names ("Go", "R", "C") are ordinary words and initials in prose: match them only in HR's exact case
    flags = 0 if len(skill) <= 2 else re.IGNORECASE
    return re.search(pattern, text, flags) is not None


def _experience(reading: ResumeReading, job: ScreenJob) -> tuple[float, str]:
    relevant = 0.0
    for item in reading.experience:
        months = max(0, min(item.months, 600))
        r = _rating(item.relevance)
        relevant += months if r >= 2 else months * 0.5 if r == 1 else 0
    required = job.experienceMin * 12
    if required <= 0:
        # entry-level role: half the points for everyone, relevant internships/jobs earn the rest
        ratio = 0.5 + 0.5 * min(1.0, relevant / FRESHER_INTERNSHIP_MONTHS)
        need = "entry-level role"
    else:
        ratio = min(1.0, relevant / required)
        need = f"role asks for {_years(job.experienceMin)} years"
    reason = f"About {round(relevant)} months of relevant experience or internships ({need})."
    if reading.experienceReason.strip():
        reason += " " + reading.experienceReason.strip()
    return WEIGHTS["experience"] * ratio, reason


def _projects(reading: ResumeReading) -> tuple[float, str]:
    ratings = sorted((_rating(p.relevance) for p in reading.projects), reverse=True)[:2]
    ratio = sum(ratings) / 6  # two highly relevant projects = full points
    relevant = sum(1 for p in reading.projects if _rating(p.relevance) >= 2)
    reason = f"{relevant} of {len(reading.projects)} projects are relevant to the role."
    if reading.projectsReason.strip():
        reason += " " + reading.projectsReason.strip()
    return WEIGHTS["projects"] * ratio, reason


def _profile(reading: ResumeReading) -> ParsedResume:
    return ParsedResume(
        summary=reading.summary.strip()[:600],
        skills=_dedupe(reading.candidateSkills)[:60],
        experience=[
            ParsedExperience(
                organization=e.organization[:120],
                role=e.role[:120],
                kind=_kind(e.kind),
                months=max(0, min(e.months, 600)),
                relevant=_rating(e.relevance) >= 2,
                summary=e.summary[:400],
            )
            for e in reading.experience[:15]
        ],
        projects=[
            ParsedProject(
                title=p.title[:150],
                technologies=_dedupe(p.technologies)[:20],
                relevant=_rating(p.relevance) >= 2,
                summary=p.summary[:400],
            )
            for p in reading.projects[:15]
        ],
        achievements=_dedupe(reading.achievements)[:15],
        certifications=_dedupe(reading.certifications)[:15],
        education=[
            ParsedEducation(institution=e.institution[:150], degree=e.degree[:120], field=e.field[:120], year=e.year[:20])
            for e in reading.education[:6]
        ],
    )


def _kind(value: str) -> str:
    kind = value.strip().casefold()
    if kind in ("job", "internship", "freelance"):
        return kind
    return "internship" if "intern" in kind else "other"


def _part(key: str, label: str, points: float, reason: str) -> AtsPart:
    return AtsPart(key=key, label=label, points=round(max(0.0, min(points, WEIGHTS[key])), 1), max=WEIGHTS[key], reason=reason[:500])


def _rating(value: int) -> int:
    return max(0, min(int(value), 3))


def _reason(text: str, fallback: str) -> str:
    return text.strip() or fallback


def _years(value: float) -> str:
    return str(int(value)) if value == int(value) else str(value)


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        value = item.strip()
        if value and value.casefold() not in seen:
            seen.add(value.casefold())
            out.append(value)
    return out


def job_block(job: ScreenJob, jd: ScreenJd) -> str:
    data = {
        "title": job.title,
        "department": job.department,
        "employmentType": job.employmentType,
        "experienceYears": f"{_years(job.experienceMin)}-{_years(job.experienceMax)}",
        "mustHaveSkills": job.mustHaveSkills,
        "niceToHaveSkills": job.niceToHaveSkills,
        "additionalRequirements": job.shortDescription,
        "summary": jd.summary,
        "responsibilities": jd.responsibilities,
        "requirements": jd.requirements,
        "niceToHave": jd.niceToHave,
    }
    data = {k: v for k, v in data.items() if v not in (None, [], "")}
    return escape_data(json.dumps(data, ensure_ascii=False, indent=2))


