import pytest

from app.schemas.dsa_evaluation import Approach, LogicBand
from app.services.rubric_validator import derive_band


@pytest.mark.parametrize(
    ("approach", "minor", "significant", "band"),
    [
        (Approach.CORRECT, 0, 0, LogicBand.B100),
        (Approach.CORRECT, 1, 0, LogicBand.B75),
        (Approach.CORRECT, 2, 0, LogicBand.B50),
        (Approach.CORRECT, 3, 0, LogicBand.B50),
        (Approach.CORRECT, 0, 1, LogicBand.B50),
        (Approach.CORRECT, 3, 1, LogicBand.B50),  # one significant plus up to three minor
        (Approach.CORRECT, 4, 0, LogicBand.B25),
        (Approach.CORRECT, 0, 2, LogicBand.B25),
        (Approach.PARTIALLY_RELEVANT, 0, 0, LogicBand.B25),
        (Approach.WRONG_OR_MISSING, 0, 0, LogicBand.B0),
        (Approach.WRONG_OR_MISSING, 1, 0, LogicBand.B0),
    ],
)
def test_logic_rubric_v1_band_rule(approach, minor, significant, band):
    assert derive_band(approach, minor, significant) is band
