"""AI technical interview - request/response shapes (API <-> worker). The report mirrors
packages/contracts/src/schemas/ai-interview.ts (aiInterviewReportSchema)."""
from typing import Literal

from pydantic import BaseModel, Field

from ..screening.models import AudioIn

Source = Literal["RESUME", "JOB", "SCENARIO", "HR"]
Kind = Literal["INTRO", "MAIN", "FOLLOW_UP", "CLARIFY", "CLOSING"]
Phase = Literal["CORE", "MAY_CONCLUDE", "FINAL"]
Quality = Literal["CLEAR", "PARTLY_UNCLEAR", "UNCLEAR"]
Reading = Literal["STRONG", "DETAILED", "INCOMPLETE", "VAGUE", "INCORRECT", "OFF_TOPIC", "DONT_KNOW", "UNCLEAR_AUDIO", "READY"]
Action = Literal["FOLLOW_UP", "CLARIFY", "NEXT_TOPIC", "CONCLUDE"]
Recommendation = Literal["STRONGLY_RECOMMENDED", "RECOMMENDED", "NEEDS_HUMAN_REVIEW", "NOT_RECOMMENDED"]
DimensionKey = Literal[
    "TECHNICAL_KNOWLEDGE",
    "PROJECT_UNDERSTANDING",
    "PRACTICAL_IMPLEMENTATION",
    "PROBLEM_SOLVING",
    "SCENARIO_REASONING",
    "DEPTH_OF_UNDERSTANDING",
    "COMMUNICATION_CLARITY",
]
DIMENSION_KEYS: tuple[str, ...] = DimensionKey.__args__  # type: ignore[attr-defined]


# ---------- context (what the interviewer may know) ----------


class InterviewJob(BaseModel):
    """The approved JD the candidate applied to + the job form's skills / level."""

    title: str = Field(max_length=200)
    summary: str = Field(default="", max_length=4000)
    responsibilities: list[str] = Field(default_factory=list, max_length=40)
    requirements: list[str] = Field(default_factory=list, max_length=40)
    niceToHave: list[str] = Field(default_factory=list, max_length=40)
    skills: list[str] = Field(default_factory=list, max_length=60)
    experienceLevel: str | None = Field(default=None, max_length=100)


class ResumeProject(BaseModel):
    title: str = Field(max_length=300)
    technologies: list[str] = Field(default_factory=list, max_length=40)
    summary: str = Field(default="", max_length=2000)


class ResumeExperience(BaseModel):
    organization: str = Field(max_length=300)
    role: str = Field(default="", max_length=300)
    kind: str = Field(default="other", max_length=40)
    months: int = 0
    summary: str = Field(default="", max_length=2000)


class InterviewResume(BaseModel):
    """The parsed resume from the ATS step (M10). Empty when it was never parsed: the plan then leans on the job."""

    summary: str = Field(default="", max_length=4000)
    skills: list[str] = Field(default_factory=list, max_length=100)
    projects: list[ResumeProject] = Field(default_factory=list, max_length=30)
    experience: list[ResumeExperience] = Field(default_factory=list, max_length=30)
    education: list[str] = Field(default_factory=list, max_length=10)
    certifications: list[str] = Field(default_factory=list, max_length=30)
    achievements: list[str] = Field(default_factory=list, max_length=30)


class HrQuestion(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    topics: list[str] = Field(default_factory=list, max_length=10)
    # private reference for the report only - never used to ask, never shown to the candidate
    expectedAnswer: str | None = Field(default=None, max_length=8000)


# ---------- the plan ----------


class PlanTopic(BaseModel):
    id: str = Field(max_length=10)
    title: str = Field(max_length=120)
    source: Source
    resumeRef: str | None = Field(default=None, max_length=300)
    skill: str | None = Field(default=None, max_length=120)
    goal: str = Field(default="", max_length=400)
    question: str = Field(max_length=400)
    priority: int = Field(default=2, ge=1, le=3)


class InterviewPlanRequest(BaseModel):
    candidateFirstName: str = Field(default="", max_length=60)
    durationMinutes: int = Field(ge=5, le=60)
    job: InterviewJob
    resume: InterviewResume
    hrQuestions: list[HrQuestion] = Field(default_factory=list, max_length=30)


class InterviewPlanResult(BaseModel):
    topics: list[PlanTopic]
    model: str
    promptVersion: str


# ---------- one spoken answer ----------


class AskedQuestion(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    kind: Kind
    topicId: str | None = Field(default=None, max_length=10)


class PastTurn(BaseModel):
    seq: int
    question: str = Field(max_length=2000)
    answer: str = Field(max_length=8000)
    topicId: str | None = Field(default=None, max_length=10)


class Timing(BaseModel):
    elapsedSeconds: int = Field(ge=0)
    remainingSeconds: int = Field(ge=0)
    durationMinutes: int = Field(ge=1, le=60)
    phase: Phase


class InterviewTurnRequest(BaseModel):
    audio: AudioIn
    # spellings of technical terms from the resume / job (transcription help only)
    vocabulary: list[str] = Field(default_factory=list, max_length=80)
    question: AskedQuestion
    # False = transcribe only (the greeting reply, or the time is up): the API chooses what comes next
    decide: bool = True
    followUpAllowed: bool = True
    timing: Timing
    plan: list[PlanTopic] = Field(default_factory=list, max_length=30)
    coveredTopicIds: list[str] = Field(default_factory=list, max_length=30)
    history: list[PastTurn] = Field(default_factory=list, max_length=60)
    job: InterviewJob
    resume: InterviewResume


class TurnDecisionOut(BaseModel):
    # None = not read (the decision call failed, or the model's label was not one of ours): never a guessed label
    reading: Reading | None
    action: Action
    # None = no usable question from the model: the API takes the next planned topic's question
    question: str | None
    topicId: str | None
    newTopicTitle: str | None
    newTopicSource: Source | None
    newTopicResumeRef: str | None
    coveredTopicIds: list[str]


class InterviewTurnResult(BaseModel):
    audible: bool
    transcript: str  # raw, word for word
    normalizedTranscript: str
    quality: Quality
    unclearTerms: list[str]
    decision: TurnDecisionOut | None
    model: str
    promptVersion: str


# ---------- the report ----------


class ReportTurn(BaseModel):
    seq: int
    kind: Kind
    source: str = Field(max_length=20)
    topic: str | None = Field(default=None, max_length=200)
    question: str = Field(max_length=2000)
    answer: str = Field(max_length=8000)
    quality: Quality = "CLEAR"


class InterviewReportRequest(BaseModel):
    job: InterviewJob
    resume: InterviewResume
    hrQuestions: list[HrQuestion] = Field(default_factory=list, max_length=30)
    turns: list[ReportTurn] = Field(max_length=80)
    durationMinutes: int = Field(ge=1, le=60)
    usedSeconds: int = Field(ge=0)
    status: Literal["COMPLETED", "INCOMPLETE"]


class Dimension(BaseModel):
    key: DimensionKey
    score: float | None = Field(default=None, ge=0, le=10)
    summary: str = ""
    evidence: list[int] = Field(default_factory=list)


class AnswerEvaluation(BaseModel):
    seq: int
    technicalAccuracy: float | None = Field(default=None, ge=0, le=10)
    depth: float | None = Field(default=None, ge=0, le=10)
    strengths: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    quote: str | None = None
    summary: str = ""


class ReportDraft(BaseModel):
    """What the model fills in. Scores to an overall number and the label are computed in code."""

    dimensions: list[Dimension] = Field(default_factory=list)
    answers: list[AnswerEvaluation] = Field(default_factory=list)
    strengths: list[str] = Field(default_factory=list)
    improvementAreas: list[str] = Field(default_factory=list)
    skillsDemonstrated: list[str] = Field(default_factory=list)
    skillsNotVerified: list[str] = Field(default_factory=list)
    recommendationReason: str = ""
    summary: str = ""
    uncertaintyNotes: list[str] = Field(default_factory=list)


class InterviewReport(BaseModel):
    overallScore: int | None
    dimensions: list[Dimension]
    answers: list[AnswerEvaluation]
    strengths: list[str]
    improvementAreas: list[str]
    skillsDemonstrated: list[str]
    skillsNotVerified: list[str]
    recommendation: Recommendation
    recommendationReason: str
    uncertain: bool
    uncertaintyNotes: list[str]
    summary: str


class InterviewReportResult(BaseModel):
    report: InterviewReport
    model: str
    promptVersion: str
