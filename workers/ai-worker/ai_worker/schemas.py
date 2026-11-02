"""Pydantic mirror of packages/contracts (TypeScript/Zod).
RULE: if you change a schema in packages/contracts, update this file in the SAME pull request."""
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


class Education(BaseModel):
    institution: str
    degree: str
    year: int | None = None


class Project(BaseModel):
    title: str
    description: str


class Experience(BaseModel):
    company: str
    role: str
    months: float


class ParsedProfile(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    education: list[Education] = []
    skills: list[str] = []
    projects: list[Project] = []
    experience: list[Experience] = []


class AtsParts(BaseModel):
    skills: float
    experience: float
    education: float
    projects: float


class AtsScore(BaseModel):
    application_id: str
    score: int = Field(ge=0, le=100)
    parts: AtsParts
    reasons: list[str] = Field(min_length=1)  # no score without reasons
    model: str
    prompt_version: str


# Mirrors JOB_FORM_LIMITS in packages/contracts/src/schemas/job.ts
TITLE_MAX = 120
DEPARTMENT_MAX = 100
EXPERIENCE_MAX = 50
SKILL_MAX = 60
SKILLS_MAX = 25
LOCATION_MAX = 100
LOCATIONS_MAX = 10
OPENINGS_MAX = 1000
SHORT_DESCRIPTION_MAX = 2000

Skill = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=SKILL_MAX)]
Location = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=LOCATION_MAX)
]


class JobForm(BaseModel):
    """M01 job input form (mirror of jobFormSchema). Unknown keys are ignored, like Zod."""

    model_config = ConfigDict(extra="ignore")

    title: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=2, max_length=TITLE_MAX)
    ]
    department: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=DEPARTMENT_MAX)
    ] | None = None
    experienceMin: float = Field(ge=0, le=EXPERIENCE_MAX)
    experienceMax: float = Field(ge=0, le=EXPERIENCE_MAX)
    mustHaveSkills: list[Skill] = Field(min_length=3, max_length=SKILLS_MAX)
    niceToHaveSkills: list[Skill] = Field(default_factory=list, max_length=SKILLS_MAX)
    salaryMin: float | None = Field(default=None, ge=0)
    salaryMax: float | None = Field(default=None, ge=0)
    currency: str = "INR"
    salaryType: Literal["CTC", "IN_HAND"] = "CTC"
    locations: list[Location] = Field(min_length=1, max_length=LOCATIONS_MAX)
    workMode: Literal["ONSITE", "HYBRID", "REMOTE"]
    employmentType: Literal["FULL_TIME", "PART_TIME", "INTERNSHIP", "CONTRACT"]
    openings: int = Field(default=1, gt=0, le=OPENINGS_MAX)
    shortDescription: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=SHORT_DESCRIPTION_MAX)
    ] | None = None
    deadline: datetime | None = None

    @model_validator(mode="after")
    def _check_ranges(self) -> "JobForm":
        if self.experienceMin > self.experienceMax:
            raise ValueError("experienceMin must be <= experienceMax")
        if (
            self.salaryMin is not None
            and self.salaryMax is not None
            and self.salaryMin > self.salaryMax
        ):
            raise ValueError("salaryMin must be <= salaryMax")
        return self


# Mirrors COMPANY_PROFILE_LIMITS in packages/contracts/src/schemas/company.ts
COMPANY_NAME_MAX = 120
INDUSTRY_MAX = 100
COMPANY_DESCRIPTION_MIN = 30
COMPANY_DESCRIPTION_MAX = 3000
PRODUCTS_MAX = 2000
WEBSITE_MAX = 200
HEADQUARTERS_MAX = 120
CULTURE_MAX = 1500
BENEFIT_MAX = 120
BENEFITS_MAX = 15


def _text(max_length: int, min_length: int = 0):
    return Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=min_length, max_length=max_length),
    ]


class CompanyProfile(BaseModel):
    """Step 1 company profile (mirror of companyProfileSchema). Saved once by HR in the API."""

    model_config = ConfigDict(extra="ignore")

    name: _text(COMPANY_NAME_MAX, 2)
    industry: _text(INDUSTRY_MAX, 2)
    description: _text(COMPANY_DESCRIPTION_MAX, COMPANY_DESCRIPTION_MIN)
    productsServices: _text(PRODUCTS_MAX) | None = None
    website: _text(WEBSITE_MAX) | None = None
    headquarters: _text(HEADQUARTERS_MAX) | None = None
    companySize: Literal["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"] | None = None
    foundedYear: int | None = Field(default=None, ge=1800, le=2100)
    culture: _text(CULTURE_MAX) | None = None
    benefits: list[_text(BENEFIT_MAX, 1)] = Field(default_factory=list, max_length=BENEFITS_MAX)


class JdGenerateRequest(JobForm):
    """POST /v1/jd/generate body: the job form plus (optionally) the company profile."""

    company: CompanyProfile | None = None


class JdContent(BaseModel):
    title: str
    summary: str = Field(min_length=1)  # a blank summary is invalid output (retried, then 502)
    aboutCompany: str = ""
    responsibilities: list[str] = Field(min_length=1)
    requirements: list[str] = Field(min_length=1)
    niceToHave: list[str] = []
    benefits: list[str] = []


class JdIssue(BaseModel):
    severity: str  # "error" | "warning"
    code: str
    message: str


class JdValidation(BaseModel):
    valid: bool
    issues: list[JdIssue]


# ---------- M10/M11 resume screening (mirror of packages/contracts/src/schemas/ats.ts) ----------

RESUME_MAX_BYTES = 5 * 1024 * 1024  # mirrors RESUME_LIMITS.maxBytes
ResumeMime = Literal[
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]


class ScreenResumeFile(BaseModel):
    fileName: str = Field(max_length=200)
    mimeType: ResumeMime
    # base64 of at most RESUME_MAX_BYTES (4/3 + padding)
    contentBase64: str = Field(min_length=1, max_length=RESUME_MAX_BYTES * 4 // 3 + 8)


class ScreenJob(BaseModel):
    """The HR job form fields screening needs (the approved version's form)."""

    model_config = ConfigDict(extra="ignore")

    title: str
    department: str | None = None
    experienceMin: float = Field(ge=0, le=EXPERIENCE_MAX)
    experienceMax: float = Field(ge=0, le=EXPERIENCE_MAX)
    mustHaveSkills: list[str] = Field(min_length=1, max_length=SKILLS_MAX)
    niceToHaveSkills: list[str] = Field(default=[], max_length=SKILLS_MAX)
    employmentType: Literal["FULL_TIME", "PART_TIME", "INTERNSHIP", "CONTRACT"]
    shortDescription: str | None = None


class ScreenJd(BaseModel):
    """The HR-approved JD version the student applied to."""

    model_config = ConfigDict(extra="ignore")

    title: str
    summary: str
    responsibilities: list[str]
    requirements: list[str]
    niceToHave: list[str] = []


class ResumeScreenRequest(BaseModel):
    resume: ScreenResumeFile
    job: ScreenJob
    jd: ScreenJd


class AtsPart(BaseModel):
    key: Literal["skills", "experience", "projects", "achievements", "qualifications"]
    label: str
    points: float = Field(ge=0)
    max: int = Field(gt=0)
    reason: str


class ParsedExperience(BaseModel):
    organization: str
    role: str
    kind: Literal["job", "internship", "freelance", "other"]
    months: int = Field(ge=0)
    relevant: bool
    summary: str


class ParsedProject(BaseModel):
    title: str
    technologies: list[str] = []
    relevant: bool
    summary: str


class ParsedEducation(BaseModel):
    institution: str
    degree: str
    field: str = ""
    year: str = ""


class ParsedResume(BaseModel):
    """What the resume says, as the HR page shows it (no contact details: the application has those)."""

    summary: str
    skills: list[str] = []
    experience: list[ParsedExperience] = []
    projects: list[ParsedProject] = []
    achievements: list[str] = []
    certifications: list[str] = []
    education: list[ParsedEducation] = []


class ResumeScreenResult(BaseModel):
    score: int = Field(ge=0, le=100)
    breakdown: list[AtsPart] = Field(min_length=5, max_length=5)  # no score without reasons
    matchedSkills: list[str]
    missingSkills: list[str]
    profile: ParsedResume
    model: str
    promptVersion: str
