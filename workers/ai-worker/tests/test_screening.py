"""M12 AI screening round: /v1/screening/turn, /speak, /extract. Fake providers only; no network."""
import base64
import io
import wave

import pytest
from fastapi.testclient import TestClient

from ai_worker.llm_gateway import LLMRateLimitError, LLMUnavailableError
from ai_worker.main import app, get_speech_provider
from ai_worker.screening.interview import audio_mime, checked_extraction
from ai_worker.screening.models import ScreeningExtraction, ScreeningExtractRequest
from ai_worker.speech import SpeechResult
from ai_worker.speech.gemini_tts import to_wav

client = TestClient(app)

AUDIO = base64.b64encode(b"\x1aE\xdf\xa3" + b"\x00" * 2000).decode()  # looks like webm, content irrelevant to fakes
JOB = {
    "title": "Backend Intern",
    "companyName": "Acme Tech",
    "locations": ["Ahmedabad"],
    "workMode": "Hybrid",
    "employmentType": "Internship",
    "summary": "Build APIs with Python.",
    "responsibilities": ["Build REST APIs."],
    "requirements": ["Python"],
    "benefits": ["Certificate of completion"],
}


def turn(step="INTRO", question="Could you briefly introduce yourself?", follow_up_allowed=True, **extra):
    return {
        "step": step,
        "kind": "MAIN",
        "question": question,
        "audio": {"contentBase64": AUDIO, "mimeType": "audio/webm;codecs=opus"},
        "history": [],
        "job": JOB,
        "followUpAllowed": follow_up_allowed,
        **extra,
    }


class FakeSpeech:
    def __init__(self, error: Exception | None = None):
        self.error = error
        self.texts: list[str] = []

    def synthesize(self, text, *, deadline=None):
        self.texts.append(text)
        if self.error:
            raise self.error
        return SpeechResult(data=b"RIFF....WAVE", mime_type="audio/wav", model="fake-tts")


@pytest.fixture
def fake_speech():
    fake = FakeSpeech()
    app.dependency_overrides[get_speech_provider] = lambda: (lambda: fake)
    return fake


# ---------- one spoken answer ----------


def heard(text="", audible=True):
    return {"audible": audible, "transcript": text}


def test_turn_hears_the_audio_alone_then_decides_on_text(fake_llm):
    fake_llm.queue(heard("I am Asha, a final year computer engineering student."), {"needsFollowUp": False})
    res = client.post("/v1/screening/turn", json=turn(history=[{"step": "INTRO", "question": "Q?", "answer": "EARLIER ANSWER"}]))
    assert res.status_code == 200
    body = res.json()
    assert body["audible"] is True
    assert body["transcript"] == "I am Asha, a final year computer engineering student."
    assert body["needsFollowUp"] is False and body["followUpQuestion"] is None
    assert body["promptVersion"] == "screening_transcribe.v1+screening_turn.v1"
    hear, decide = fake_llm.calls
    assert hear["attachments"][0].mime_type == "audio/webm"  # codec parameter dropped
    # anti-hallucination: the transcription call sees no question, no history, no job
    assert "introduce" not in hear["prompt"] and "EARLIER ANSWER" not in hear["prompt"] and "Acme" not in hear["prompt"]
    assert not decide["attachments"]  # deciding is text only
    assert "Could you briefly introduce yourself?" in decide["prompt"] and "final year" in decide["prompt"]


def test_follow_up_is_kept_when_allowed(fake_llm):
    fake_llm.queue(heard("I study engineering."),
                   {"needsFollowUp": True, "followUpQuestion": "Which college are you studying at, and when do you expect to graduate?"})
    body = client.post("/v1/screening/turn", json=turn(step="EDUCATION")).json()
    assert body["needsFollowUp"] is True
    assert body["followUpQuestion"].startswith("Which college")


def test_no_decision_call_when_no_follow_up_is_allowed(fake_llm):
    fake_llm.queue(heard("I study engineering."))
    body = client.post("/v1/screening/turn", json=turn(step="EDUCATION", follow_up_allowed=False)).json()
    assert body["needsFollowUp"] is False
    assert len(fake_llm.calls) == 1


def test_follow_up_that_is_not_a_question_is_dropped(fake_llm):
    fake_llm.queue(heard("I study engineering."), {"needsFollowUp": True, "followUpQuestion": "Tell me more"})
    assert client.post("/v1/screening/turn", json=turn(step="EDUCATION")).json()["needsFollowUp"] is False


def test_silence_stays_unknown_and_nothing_is_decided(fake_llm):
    # the model claims a transcript but says it was not audible: nothing is kept, nothing is guessed, no decision call
    fake_llm.queue(heard("probably said their name", audible=False))
    body = client.post("/v1/screening/turn", json=turn()).json()
    assert body == {**body, "audible": False, "transcript": "", "needsFollowUp": False, "followUpQuestion": None}
    assert len(fake_llm.calls) == 1


def test_candidate_question_gets_a_reply_and_continues(fake_llm):
    fake_llm.queue(heard("Is there a stipend?"), {"candidateAskedQuestion": True,
                   "reply": "I don't have verified information about the stipend. The HR team can clarify it.", "candidateIsDone": False})
    body = client.post("/v1/screening/turn", json=turn(step="CANDIDATE_QUESTIONS", question="Do you have any questions?", follow_up_allowed=False)).json()
    assert body["candidateAskedQuestion"] is True
    assert "HR team" in body["reply"]
    assert body["candidateIsDone"] is False
    assert body["needsFollowUp"] is False  # never a follow-up in the questions step


def test_no_questions_finishes_the_questions_step(fake_llm):
    fake_llm.queue(heard("No, that's all, thank you."), {"candidateAskedQuestion": False, "candidateIsDone": False})
    body = client.post("/v1/screening/turn", json=turn(step="CANDIDATE_QUESTIONS", question="Any questions?", follow_up_allowed=False)).json()
    assert body["candidateIsDone"] is True and body["reply"] is None


def test_reply_is_never_given_outside_the_questions_step(fake_llm):
    fake_llm.queue(heard("I live in Surat."), {"candidateAskedQuestion": True, "reply": "Salary is 50k."})
    body = client.post("/v1/screening/turn", json=turn(step="LOCATION")).json()
    assert body["reply"] is None and body["candidateAskedQuestion"] is False


def test_invalid_model_output_is_retried_once(fake_llm):
    fake_llm.queue("not json", heard("Hello."), {"needsFollowUp": False})
    assert client.post("/v1/screening/turn", json=turn()).status_code == 200
    assert len(fake_llm.calls) == 3


def test_provider_errors_are_safe(fake_llm):
    fake_llm.queue(LLMRateLimitError(retry_after=30))
    res = client.post("/v1/screening/turn", json=turn())
    assert res.status_code == 429
    assert res.json()["detail"]["code"] == "LLM_RATE_LIMITED"
    assert res.headers["Retry-After"] == "30"


def test_bad_audio_is_rejected_before_any_ai_call(fake_llm):
    bad = turn(audio={"contentBase64": "%%%", "mimeType": "audio/webm"})
    assert client.post("/v1/screening/turn", json=bad).json()["detail"]["code"] == "AUDIO_UNREADABLE"
    tiny = turn(audio={"contentBase64": base64.b64encode(b"x").decode(), "mimeType": "audio/webm"})
    assert client.post("/v1/screening/turn", json=tiny).status_code == 422
    video = turn(audio={"contentBase64": AUDIO, "mimeType": "video/x-msvideo"})
    assert client.post("/v1/screening/turn", json=video).json()["detail"]["code"] == "AUDIO_UNREADABLE"
    assert fake_llm.calls == []


def test_audio_mime_aliases():
    assert audio_mime("audio/webm;codecs=opus") == "audio/webm"
    assert audio_mime("audio/mp4") == "audio/m4a"  # iOS Safari
    assert audio_mime("AUDIO/WAV") == "audio/wav"


# ---------- speaking ----------


def test_speak_returns_wav(fake_speech):
    res = client.post("/v1/screening/speak", json={"text": "Could you briefly introduce yourself?"})
    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.headers["X-TTS-Model"] == "fake-tts"
    assert fake_speech.texts == ["Could you briefly introduce yourself?"]


def test_speak_provider_error_is_safe():
    fake = FakeSpeech(error=LLMUnavailableError())
    app.dependency_overrides[get_speech_provider] = lambda: (lambda: fake)
    res = client.post("/v1/screening/speak", json={"text": "Hello"})
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "LLM_UNAVAILABLE"


def test_raw_pcm_gets_a_wav_header():
    pcm = b"\x00\x01" * 2400
    out = to_wav(pcm, "audio/L16;codec=pcm;rate=24000")
    with wave.open(io.BytesIO(out)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24000, 2400)
    assert to_wav(out, "audio/wav") == out  # already a WAV file


# ---------- structured summary ----------

TURNS = [
    {"seq": 1, "step": "INTRO", "kind": "MAIN", "question": "Introduce yourself?", "answer": "I'm Asha."},
    {"seq": 2, "step": "EDUCATION", "kind": "MAIN", "question": "Education?", "answer": "B.E. Computer at LDCE."},
    {"seq": 3, "step": "CANDIDATE_QUESTIONS", "kind": "MAIN", "question": "Questions?", "answer": "Is it paid?",
     "aiReply": "I don't have verified information about that."},
]
EXTRACTION = {
    "introduction": {"statedName": "Asha", "summary": "Student.", "evidence": [1, 99]},
    "education": {"degree": "B.E.", "fieldOfStudy": "Computer", "institution": "LDCE", "currentYearOrSemester": "",
                  "expectedGraduation": None, "evidence": [2]},
    "background": {"projects": [], "internshipsOrWork": [], "interests": [], "summary": None, "evidence": []},
    "location": {"currentLocation": None, "willingToWorkAtJobLocation": "UNKNOWN", "relocationNotes": None, "evidence": []},
    "availability": {"collegePermission": "UNKNOWN", "evidence": []},
    "candidateQuestions": [{"question": "Is it paid?", "answerGiven": "No verified info.", "answeredFromVerifiedInfo": False, "evidence": [3]}],
    "unclear": ["Location not discussed", ""],
    "summary": "Asha is a computer engineering student.",
}


def test_extract_returns_checked_structure(fake_llm):
    fake_llm.queue(EXTRACTION)
    res = client.post("/v1/screening/extract", json={"job": JOB, "turns": TURNS})
    assert res.status_code == 200
    x = res.json()["extraction"]
    assert x["introduction"]["evidence"] == [1]  # seq 99 does not exist: dropped
    assert x["education"]["currentYearOrSemester"] is None  # "" is "not said", never a guess
    assert x["location"]["willingToWorkAtJobLocation"] == "UNKNOWN"
    assert x["unclear"] == ["Location not discussed"]
    assert x["candidateQuestions"][0]["answeredFromVerifiedInfo"] is False


def test_extract_rejects_an_empty_transcript(fake_llm):
    assert client.post("/v1/screening/extract", json={"job": JOB, "turns": []}).status_code == 422
    assert fake_llm.calls == []


def test_checked_extraction_keeps_unknowns():
    x = ScreeningExtraction.model_validate({**EXTRACTION, "education": {"evidence": []}, "introduction": {"evidence": []}})
    out = checked_extraction(x, ScreeningExtractRequest.model_validate({"job": JOB, "turns": TURNS}))
    assert out.education.institution is None and out.introduction.statedName is None


# ---------- TTS fallback (each model has its own small quota) ----------


def test_tts_falls_back_to_the_next_model_on_quota():
    from google.genai import errors as genai_errors
    from google.genai import types

    from ai_worker.speech.gemini_tts import GeminiSpeechProvider

    class Models:
        def __init__(self):
            self.calls = []

        def generate_content(self, *, model, contents, config):
            self.calls.append(model)
            if model == "tts-main":
                raise genai_errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})
            part = types.Part(inline_data=types.Blob(data=b"RIFF0000WAVEfmt ", mime_type="audio/wav"))
            return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(parts=[part]))])

    class Client:
        models = Models()

    client = Client()
    provider = GeminiSpeechProvider(api_key="k", model="tts-main", voice="Kore", fallback_models=("tts-backup",), client=client)
    out = provider.synthesize("Hello")
    assert out.model == "tts-backup"
    assert client.models.calls == ["tts-main", "tts-backup"]


def test_tts_quota_on_every_model_is_a_safe_429():
    from google.genai import errors as genai_errors

    from ai_worker.llm_gateway import LLMRateLimitError
    from ai_worker.speech.gemini_tts import GeminiSpeechProvider

    class Models:
        def generate_content(self, **_):
            raise genai_errors.ClientError(429, {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}})

    class Client:
        models = Models()

    provider = GeminiSpeechProvider(api_key="k", model="a", voice="Kore", fallback_models=("b",), client=Client())
    with pytest.raises(LLMRateLimitError):
        provider.synthesize("Hello")
