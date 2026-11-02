"""M05 round questions - mirrors packages/contracts rounds.ts (generateQuestions*). Internal: API <-> worker only."""
from typing import Literal

from pydantic import BaseModel, Field

RoundType = Literal[
    "APTITUDE",
    "TECHNICAL_MCQ",
    "CODING",
    "SQL",
    "COMMUNICATION",
    "GROUP_DISCUSSION",
    "TECHNICAL_INTERVIEW",
    "HR_INTERVIEW",
    "CUSTOM",
]
QuestionKind = Literal["MCQ", "TRUE_FALSE", "SHORT_ANSWER", "DESCRIPTIVE", "CODING", "INTERVIEW"]
Difficulty = Literal["EASY", "MEDIUM", "HARD"]


class QuestionJob(BaseModel):
    """What the job is about: the approved JD and HR's requirements. Never candidate data."""

    title: str = Field(max_length=200)
    summary: str = Field(default="", max_length=4000)
    responsibilities: list[str] = Field(default_factory=list, max_length=40)
    requirements: list[str] = Field(default_factory=list, max_length=40)
    niceToHave: list[str] = Field(default_factory=list, max_length=40)
    mustHaveSkills: list[str] = Field(default_factory=list, max_length=40)
    niceToHaveSkills: list[str] = Field(default_factory=list, max_length=40)
    experienceMin: float | None = None
    experienceMax: float | None = None


class QuestionRound(BaseModel):
    type: RoundType
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=1000)


class RoundQuestionsRequest(BaseModel):
    job: QuestionJob
    round: QuestionRound
    count: int = Field(ge=1, le=20)
    difficulty: Difficulty
    topics: list[str] = Field(default_factory=list, max_length=10)
    kinds: list[QuestionKind] = Field(min_length=1, max_length=6)
    avoid: list[str] = Field(default_factory=list, max_length=100)


class GeneratedQuestion(BaseModel):
    kind: QuestionKind
    text: str
    options: list[str] = []
    correct: list[int] = []
    modelAnswer: str | None = None
    language: str | None = None
    marks: int = 1
    difficulty: Difficulty | None = None
    topics: list[str] = []


class GeneratedQuestions(BaseModel):
    """The JSON the model must answer with."""

    questions: list[GeneratedQuestion]


class RoundQuestionsResult(BaseModel):
    questions: list[GeneratedQuestion]
    model: str
    promptVersion: str
