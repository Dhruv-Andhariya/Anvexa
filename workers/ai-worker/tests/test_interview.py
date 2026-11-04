"""AI technical interview: /v1/interview/plan, /turn, /speak, /report. Fake providers only; no network."""
import base64

import pytest
from fastapi.testclient import TestClient

from ai_worker.interview.normalize import normalize_transcript
from ai_worker.llm_gateway import LLMRateLimitError
from ai_worker.main import app, get_speech_provider
from ai_worker.speech import SpeechResult

client = TestClient(app)

AUDIO = base64.b64encode(b"\x1aE\xdf\xa3" + b"\x00" * 2000).decode()
JOB = {
    "title": "AI Engineer Intern",
    "summary": "Build LLM features.",
    "requirements": ["Python", "SQL", "REST APIs", "Generative AI"],
    "skills": ["Python", "FastAPI", "PostgreSQL"],
}
RESUME = {
    "summary": "Final year student.",
    "skills": ["Python", "FastAPI", "ChromaDB"],
    "projects": [
        {"title": "RAG chatbot for college notes", "technologies": ["LangChain", "ChromaDB", "Gemini"], "summary": "Answers questions from notes."}
    ],
    "experience": [{"organization": "Acme Labs", "role": "Backend intern", "kind": "internship", "months": 3, "summary": "APIs"}],
}
PLAN = [
    {"id": "t1", "title": "RAG chatbot", "source": "RESUME", "resumeRef": "RAG chatbot for college notes", "question": "How does a question flow through your RAG chatbot?", "priority": 1},
    {"id": "t2", "title": "SQL", "source": "JOB", "question": "How would you prevent duplicate rows in a table?", "priority": 1},
    {"id": "t3", "title": "Slow API", "source": "SCENARIO", "question": "Suppose your API suddenly becomes slow - how would you find the cause?", "priority": 2},
]


def turn_body(**extra):
    body = {
        "audio": {"contentBase64": AUDIO, "mimeType": "audio/webm;codecs=opus"},
        "vocabulary": ["ChromaDB", "LangChain", "FastAPI"],
        "question": {"text": "How does a question flow through your RAG chatbot?", "kind": "MAIN", "topicId": "t1"},
        "decide": True,
        "followUpAllowed": True,
        "timing": {"elapsedSeconds": 120, "remainingSeconds": 1080, "durationMinutes": 20, "phase": "CORE"},
        "plan": PLAN,
        "coveredTopicIds": [],
        "history": [],
        "job": JOB,
        "resume": RESUME,
    }
    body.update(extra)
    return body


def heard(text="", audible=True, quality="CLEAR", unclear=None):
    return {"audible": audible, "transcript": text, "quality": quality, "unclearTerms": unclear or []}


# ---------- normalised transcript ----------


def test_normalisation_only_respells_known_terms():
    raw = "we stored vectors in chroma db and served it with fast api on post gres sql using node js"
    out = normalize_transcript(raw, ["ChromaDB"])
    assert out == "we stored vectors in ChromaDB and served it with FastAPI on PostgreSQL using Node.js"
    # never inside other words, never adds words
    assert normalize_transcript("rapid drag and draggable", []) == "rapid drag and draggable"
    assert len(normalize_transcript(raw, ["ChromaDB"]).split()) <= len(raw.split())


# ---------- the plan ----------


def test_plan_keeps_grounded_topics_and_drops_invented_resume_items(fake_llm):
    fake_llm.queue({"topics": [
        {"id": "a", "title": "RAG", "source": "RESUME", "resumeRef": "RAG chatbot for college notes", "question": "How did you split the notes into chunks?", "priority": 1},
        {"id": "b", "title": "Kafka project", "source": "RESUME", "resumeRef": "Kafka stream processor", "question": "How did you partition your Kafka topics?", "priority": 1},
        {"id": "c", "title": "SQL", "source": "JOB", "question": "When would you add an index to a table?", "priority": 1},
        {"id": "d", "title": "Not a question", "source": "SCENARIO", "question": "Tell me about scaling", "priority": 2},
        {"id": "e", "title": "Same again", "source": "JOB", "question": "When would you add an index to a table?", "priority": 2},
    ]})
    res = client.post("/v1/interview/plan", json={"candidateFirstName": "Asha", "durationMinutes": 20, "job": JOB, "resume": RESUME,
                                                   "hrQuestions": [{"text": "Explain the difference between a process and a thread", "topics": ["OS"]}]})
    assert res.status_code == 200
    topics = res.json()["topics"]
    titles = [t["title"] for t in topics]
    assert "Kafka project" not in titles  # the resume has no Kafka project: never asked
    assert "Not a question" not in titles and titles.count("SQL") == 1
    assert [t["id"] for t in topics] == [f"t{i + 1}" for i in range(len(topics))]
    hr = [t for t in topics if t["source"] == "HR"]
    assert len(hr) == 1 and hr[0]["question"].endswith("?") and "process and a thread" in hr[0]["question"]
    assert topics[0]["resumeRef"] == "RAG chatbot for college notes"
    # the plan prompt carries the resume and job as data
    assert "RAG chatbot for college notes" in fake_llm.calls[0]["prompt"] and "AI Engineer Intern" in fake_llm.calls[0]["prompt"]


# ---------- one spoken answer ----------


def test_transcription_sees_only_audio_and_spellings_then_decides_on_text(fake_llm):
    fake_llm.queue(
        heard("we use lang chain to retrieve chunks from chroma db"),
        {"reading": "INCOMPLETE", "action": "FOLLOW_UP", "question": "How did you decide how many chunks to retrieve for each question?", "coveredTopicIds": []},
    )
    res = client.post("/v1/interview/turn", json=turn_body(history=[{"seq": 1, "question": "Ready?", "answer": "EARLIER ANSWER"}]))
    assert res.status_code == 200
    body = res.json()
    assert body["transcript"] == "we use lang chain to retrieve chunks from chroma db"  # raw kept word for word
    assert body["normalizedTranscript"] == "we use LangChain to retrieve chunks from ChromaDB"
    assert body["decision"]["action"] == "FOLLOW_UP" and body["decision"]["reading"] == "INCOMPLETE"
    assert body["promptVersion"] == "interview_transcribe.v1+interview_turn.v1"
    hear, decide = fake_llm.calls
    assert hear["attachments"][0].mime_type == "audio/webm"
    # anti-hallucination: no question, no history, no job, no resume in the transcription call
    for leaked in ("flow through", "EARLIER ANSWER", "AI Engineer Intern", "college notes"):
        assert leaked not in hear["prompt"]
    assert "ChromaDB" in hear["prompt"]  # spellings only
    assert not decide["attachments"]
    assert "retrieve chunks" in decide["prompt"] and "EARLIER ANSWER" in decide["prompt"]


def test_follow_up_becomes_next_topic_when_the_topic_limit_is_reached(fake_llm):
    fake_llm.queue(heard("We used cosine similarity."), {"reading": "STRONG", "action": "FOLLOW_UP", "question": "Why cosine and not dot product?"})
    d = client.post("/v1/interview/turn", json=turn_body(followUpAllowed=False)).json()["decision"]
    assert d["action"] == "NEXT_TOPIC" and d["question"] is None  # the API asks the next planned topic
    assert d["coveredTopicIds"] == ["t1"]  # moving on covers the topic


def test_never_concludes_before_the_minimum_time(fake_llm):
    fake_llm.queue(heard("That is all I did."), {"reading": "STRONG", "action": "CONCLUDE", "question": ""})
    d = client.post("/v1/interview/turn", json=turn_body()).json()["decision"]
    assert d["action"] == "NEXT_TOPIC"


def test_conclude_allowed_after_the_minimum_time(fake_llm):
    fake_llm.queue(heard("That is all."), {"reading": "STRONG", "action": "CONCLUDE", "question": "", "coveredTopicIds": ["t2", "t3"]})
    timing = {"elapsedSeconds": 900, "remainingSeconds": 300, "durationMinutes": 20, "phase": "MAY_CONCLUDE"}
    d = client.post("/v1/interview/turn", json=turn_body(timing=timing)).json()["decision"]
    assert d["action"] == "CONCLUDE" and d["question"] is None and set(d["coveredTopicIds"]) == {"t1", "t2", "t3"}


def test_dont_know_is_never_pressed_again(fake_llm):
    fake_llm.queue(heard("Sorry, I don't know that."), {"reading": "DONT_KNOW", "action": "FOLLOW_UP", "question": "Are you sure you don't know how embeddings work?"})
    d = client.post("/v1/interview/turn", json=turn_body()).json()["decision"]
    assert d["action"] == "NEXT_TOPIC"


def test_repeated_question_is_dropped(fake_llm):
    fake_llm.queue(heard("I am not sure."), {"reading": "VAGUE", "action": "FOLLOW_UP", "question": "How does a question flow through your RAG chatbot?"})
    d = client.post("/v1/interview/turn", json=turn_body()).json()["decision"]
    assert d["question"] is None


def test_next_topic_must_be_an_uncovered_plan_topic_or_grounded(fake_llm):
    fake_llm.queue(heard("Done."), {"reading": "STRONG", "action": "NEXT_TOPIC", "question": "How would you prevent duplicate rows in a table?", "topicId": "t2"})
    d = client.post("/v1/interview/turn", json=turn_body()).json()["decision"]
    assert d["topicId"] == "t2" and d["question"]
    # a new resume topic about something the resume does not contain is refused
    fake_llm.queue(heard("Done."), {"reading": "STRONG", "action": "NEXT_TOPIC", "question": "How did you deploy your Kubernetes operator?",
                                    "newTopicTitle": "K8s operator", "newTopicSource": "RESUME", "newTopicResumeRef": "Kubernetes operator"})
    d = client.post("/v1/interview/turn", json=turn_body(coveredTopicIds=["t1", "t2", "t3"])).json()["decision"]
    assert d["question"] is None and d["newTopicSource"] is None


def test_silence_is_never_filled_and_nothing_is_decided(fake_llm):
    fake_llm.queue(heard("probably talked about RAG", audible=False))
    body = client.post("/v1/interview/turn", json=turn_body()).json()
    assert body["audible"] is False and body["transcript"] == "" and body["decision"] is None
    assert len(fake_llm.calls) == 1


def test_decision_failure_keeps_the_transcript(fake_llm):
    fake_llm.queue(heard("We embed the notes with Gemini."), LLMRateLimitError())
    body = client.post("/v1/interview/turn", json=turn_body()).json()
    assert body["transcript"] == "We embed the notes with Gemini."
    assert body["decision"]["action"] == "NEXT_TOPIC" and body["decision"]["question"] is None
    assert body["decision"]["reading"] is None  # not read: never a guessed label


def test_greeting_reply_is_only_transcribed(fake_llm):
    fake_llm.queue(heard("Yes, I'm ready.", quality="PARTLY_UNCLEAR", unclear=["ready"]))
    body = client.post("/v1/interview/turn", json=turn_body(decide=False, question={"text": "Are you ready?", "kind": "INTRO"})).json()
    assert body["decision"] is None and body["quality"] == "PARTLY_UNCLEAR" and body["unclearTerms"] == ["ready"]


# ---------- speech ----------


class FakeSpeech:
    def synthesize(self, text, *, deadline=None):
        return SpeechResult(data=b"RIFF....WAVE", mime_type="audio/wav", model="fake-tts")


def test_speak_returns_wav():
    app.dependency_overrides[get_speech_provider] = lambda: (lambda: FakeSpeech())
    res = client.post("/v1/interview/speak", json={"text": "Could you walk me through your project?"})
    assert res.status_code == 200 and res.headers["content-type"] == "audio/wav"


# ---------- the report ----------

TURNS = [
    {"seq": 1, "kind": "INTRO", "source": "INTRO", "question": "Ready?", "answer": "Yes."},
    {"seq": 2, "kind": "MAIN", "source": "RESUME", "question": "How does your chatbot work?", "answer": "We split notes into chunks, embed them, store them in ChromaDB and retrieve the top five."},
    {"seq": 3, "kind": "FOLLOW_UP", "source": "FOLLOW_UP", "question": "Why five?", "answer": "We tested a few values and five gave the best answers."},
    {"seq": 4, "kind": "MAIN", "source": "JOB", "question": "How do you prevent duplicates?", "answer": "A unique constraint on the email column.", "quality": "CLEAR"},
    {"seq": 5, "kind": "MAIN", "source": "SCENARIO", "question": "The API is slow, what do you do?", "answer": "mumble mumble", "quality": "UNCLEAR"},
]


def report_body(turns=TURNS, status="COMPLETED"):
    return {"job": JOB, "resume": RESUME, "hrQuestions": [], "turns": turns, "durationMinutes": 20, "usedSeconds": 1150, "status": status}


def draft(**extra):
    d = {
        "dimensions": [
            {"key": "TECHNICAL_KNOWLEDGE", "score": 8, "summary": "Solid.", "evidence": [2, 4]},
            {"key": "PROJECT_UNDERSTANDING", "score": 9, "summary": "Knows the project.", "evidence": [2, 3, 99]},
            {"key": "COMMUNICATION_CLARITY", "score": 6, "summary": "Clear.", "evidence": [2]},
            {"key": "SCENARIO_REASONING", "score": 7, "summary": "No evidence given.", "evidence": []},
        ],
        "answers": [
            {"seq": 2, "technicalAccuracy": 8, "depth": 7, "strengths": ["Explains retrieval"], "gaps": [], "quote": "store them in ChromaDB", "summary": "Good."},
            {"seq": 4, "technicalAccuracy": 7, "depth": 4, "quote": "a primary key on everything", "summary": "Correct but short."},
            {"seq": 5, "technicalAccuracy": 2, "depth": 1, "quote": "", "summary": "Weak."},
            {"seq": 42, "technicalAccuracy": 10, "depth": 10, "summary": "Invented turn."},
        ],
        "strengths": ["Retrieval design"],
        "recommendationReason": "Good project knowledge.",
        "summary": "Solid candidate.",
    }
    d.update(extra)
    return d


def test_report_is_evidence_based_and_scored_in_code(fake_llm):
    fake_llm.queue(draft())
    res = client.post("/v1/interview/report", json=report_body())
    assert res.status_code == 200
    r = res.json()["report"]
    dims = {d["key"]: d for d in r["dimensions"]}
    assert dims["PROJECT_UNDERSTANDING"]["evidence"] == [2, 3]  # turn 99 does not exist
    assert dims["SCENARIO_REASONING"]["score"] is None  # no evidence, no score
    assert dims["DEPTH_OF_UNDERSTANDING"]["score"] is None  # not assessed
    # (8 + 9 + 0.5 * 6) / 2.5 = 8.0 -> 80
    assert r["overallScore"] == 80
    answers = {a["seq"]: a for a in r["answers"]}
    assert 42 not in answers and 1 not in answers
    assert answers[2]["quote"] == "store them in ChromaDB"
    assert answers[4]["quote"] is None  # not literally in the answer
    assert answers[5]["technicalAccuracy"] is None and answers[5]["depth"] is None  # unclear audio is never scored
    assert r["recommendation"] == "STRONGLY_RECOMMENDED" and r["uncertain"] is False


def test_too_few_answers_needs_human_review(fake_llm):
    fake_llm.queue(draft())
    r = client.post("/v1/interview/report", json=report_body(turns=TURNS[:3], status="INCOMPLETE")).json()["report"]
    assert r["uncertain"] is True and r["recommendation"] == "NEEDS_HUMAN_REVIEW"
    assert any("not completed" in n for n in r["uncertaintyNotes"])


@pytest.mark.parametrize(("score", "label"), [(9, "STRONGLY_RECOMMENDED"), (7, "RECOMMENDED"), (5, "NEEDS_HUMAN_REVIEW"), (3, "NOT_RECOMMENDED")])
def test_recommendation_thresholds(fake_llm, score, label):
    dims = [{"key": "TECHNICAL_KNOWLEDGE", "score": score, "evidence": [2, 3, 4]}]
    fake_llm.queue(draft(dimensions=dims))
    clear = [{**t, "quality": "CLEAR"} for t in TURNS]
    assert client.post("/v1/interview/report", json=report_body(turns=clear)).json()["report"]["recommendation"] == label
