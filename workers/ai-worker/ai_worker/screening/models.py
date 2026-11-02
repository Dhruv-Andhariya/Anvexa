"""M12 AI screening round - request/response shapes. Mirror packages/contracts/src/schemas/screening.ts."""
from typing import Literal

from pydantic import BaseModel, Field

Step = Literal["INTRO", "EDUCATION", "BACKGROUND", "LOCATION", "AVAILABILITY", "CANDIDATE_QUESTIONS"]
Kind = Literal["MAIN", "FOLLOW_UP", "CLOSING"]


class ScreeningJob(BaseModel):
    """Verified information the AI may use when answering the candidate's questions. Nothing else."""

    title: str = Field(max_length=200)
    companyName: str = Field(max_length=200)
    locations: list[str] = Field(default_factory=list, max_length=20)
    workMode: str | None = None
    employmentType: str | None = None
    applicationDeadline: str | None = None
    summary: str = Field(default="", max_length=4000)
    responsibilities: list[str] = Field(default_factory=list, max_length=40)
    requirements: list[str] = Field(default_factory=list, max_length=40)
    niceToHave: list[str] = Field(default_factory=list, max_length=40)
    benefits: list[str] = Field(default_factory=list, max_length=40)
    aboutCompany: str = Field(default="", max_length=4000)
    salary: str | None = Field(default=None, max_length=200)


class AudioIn(BaseModel):
    contentBase64: str = Field(min_length=1, max_length=8_000_000)  # ~6 MB of audio
    mimeType: str = Field(min_length=3, max_length=100)


class PastTurn(BaseModel):
    step: Step
    question: str = Field(max_length=2000)
    answer: str = Field(max_length=6000)


class ScreeningTurnRequest(BaseModel):
    step: Step
    kind: Kind
    question: str = Field(min_length=1, max_length=2000)
    audio: AudioIn
    history: list[PastTurn] = Field(default_factory=list, max_length=40)
    job: ScreeningJob
    followUpAllowed: bool = True


class ScreeningTurnResult(BaseModel):
    audible: bool
    transcript: str
    needsFollowUp: bool
    followUpQuestion: str | None
    candidateAskedQuestion: bool
    reply: str | None
    candidateIsDone: bool
    model: str
    promptVersion: str


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1500)


class TurnForExtraction(BaseModel):
    seq: int = Field(ge=1)
    step: Step
    kind: Kind
    question: str = Field(max_length=2000)
    answer: str = Field(max_length=6000)
    aiReply: str | None = Field(default=None, max_length=2000)


class ScreeningExtractRequest(BaseModel):
    job: ScreeningJob
    turns: list[TurnForExtraction] = Field(min_length=1, max_length=60)


# ---------- the structured summary (mirrors aiScreeningExtractionSchema) ----------


class Introduction(BaseModel):
    statedName: str | None = None
    summary: str | None = None
    evidence: list[int] = []


class Education(BaseModel):
    degree: str | None = None
    fieldOfStudy: str | None = None
    institution: str | None = None
    currentYearOrSemester: str | None = None
    expectedGraduation: str | None = None
    evidence: list[int] = []


class Background(BaseModel):
    projects: list[str] = []
    internshipsOrWork: list[str] = []
    interests: list[str] = []
    summary: str | None = None
    evidence: list[int] = []


class Location(BaseModel):
    currentLocation: str | None = None
    willingToWorkAtJobLocation: Literal["YES", "NO", "UNSURE", "UNKNOWN"] = "UNKNOWN"
    relocationNotes: str | None = None
    evidence: list[int] = []


class Availability(BaseModel):
    currentStatus: str | None = None
    availability: str | None = None
    joiningTimeline: str | None = None
    constraints: str | None = None
    collegePermission: Literal["REQUIRED", "NOT_REQUIRED", "NOT_SURE", "NOT_APPLICABLE", "UNKNOWN"] = "UNKNOWN"
    evidence: list[int] = []


class CandidateQuestion(BaseModel):
    question: str
    answerGiven: str | None = None
    answeredFromVerifiedInfo: bool = False
    evidence: list[int] = []


class ScreeningExtraction(BaseModel):
    introduction: Introduction
    education: Education
    background: Background
    location: Location
    availability: Availability
    candidateQuestions: list[CandidateQuestion] = []
    unclear: list[str] = []
    summary: str | None = None


class ScreeningExtractResult(BaseModel):
    extraction: ScreeningExtraction
    model: str
    promptVersion: str
