"""Seniority of a job from the experience range HR entered.

Mirror of seniorityFor() in packages/contracts/src/schemas/jd-review.ts - keep both in sync. The API's JD fact check
uses the TypeScript one to judge whether a draft's depth fits the level this module told the model to write for.
"""
from typing import Literal

from ..schemas import JobForm

Seniority = Literal["ENTRY", "MID", "SENIOR", "LEAD"]


def seniority_for(form: JobForm) -> Seniority:
    """0-1 years: entry, 2-4: mid, 4-7: senior, 7+: lead. An internship is always entry level."""
    if form.employmentType == "INTERNSHIP":
        return "ENTRY"
    lo, hi = form.experienceMin, form.experienceMax
    if lo >= 7:
        return "LEAD"
    if lo >= 4:
        return "SENIOR"
    if lo >= 2:
        return "MID"
    if lo >= 1 and hi >= 3:
        return "MID"
    return "ENTRY"
