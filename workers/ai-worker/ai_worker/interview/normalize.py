"""Normalised transcript: technical terms written one consistent way ("post gres" -> "PostgreSQL", "fast api" ->
"FastAPI"). Rule-based on purpose - it only changes how a known term is spelled, cased or spaced, never any other word,
never adds or removes words. The raw transcript is always kept next to it and stays the source of truth."""
import re

# (pattern, canonical). Whole words only, case-insensitive. Ordered: longer phrases before their parts.
_RULES: list[tuple[str, str]] = [
    (r"postgre(?:s|ss)?\s*(?:q\s*l|sql)|post\s*gres(?:\s*(?:q\s*l|sql))?|postgres", "PostgreSQL"),
    (r"my\s*sql", "MySQL"),
    (r"no\s*sql", "NoSQL"),
    (r"mongo\s*d\s*b|mongo\s*db", "MongoDB"),
    (r"chroma\s*d\s*b|chroma\s*db", "ChromaDB"),
    (r"dynamo\s*db", "DynamoDB"),
    (r"fast\s*api", "FastAPI"),
    (r"node\s*(?:dot\s*)?js|node\.js", "Node.js"),
    (r"next\s*(?:dot\s*)?js|next\.js", "Next.js"),
    (r"nest\s*(?:dot\s*)?js|nest\.js", "NestJS"),
    (r"express\s*(?:dot\s*)?js|express\.js", "Express.js"),
    (r"react\s*(?:dot\s*)?js|react\.js", "React"),
    (r"vue\s*(?:dot\s*)?js|vue\.js", "Vue.js"),
    (r"type\s*script", "TypeScript"),
    (r"java\s*script", "JavaScript"),
    (r"kuber\s*net(?:e)?s|kubernetes|k8s", "Kubernetes"),
    (r"tensor\s*flow", "TensorFlow"),
    (r"py\s*torch", "PyTorch"),
    (r"sci\s*kit\s*-?\s*learn|scikit\s*-?\s*learn|sk\s*learn", "scikit-learn"),
    (r"num\s*py", "NumPy"),
    (r"lang\s*chain", "LangChain"),
    (r"llama\s*index", "LlamaIndex"),
    (r"hugging\s*face", "Hugging Face"),
    (r"open\s*ai", "OpenAI"),
    (r"graph\s*q\s*l|graphql", "GraphQL"),
    (r"git\s*hub", "GitHub"),
    (r"git\s*lab", "GitLab"),
    (r"ci\s*/\s*cd|ci\s+cd", "CI/CD"),
    (r"rest\s*ful", "RESTful"),
    (r"j\s*w\s*t|jwt", "JWT"),
    (r"o\s*auth", "OAuth"),
    (r"l\s*l\s*m|llm", "LLM"),
    (r"r\s*a\s*g|rag", "RAG"),
    (r"a\s*w\s*s|aws", "AWS"),
    (r"g\s*c\s*p|gcp", "GCP"),
    (r"s\s*q\s*l|sql", "SQL"),
    (r"api", "API"),
    (r"apis", "APIs"),
    (r"html", "HTML"),
    (r"css", "CSS"),
    (r"json", "JSON"),
    (r"docker", "Docker"),
    (r"redis", "Redis"),
    (r"prisma", "Prisma"),
    (r"django", "Django"),
    (r"flask", "Flask"),
    (r"pandas", "pandas"),
    (r"kafka", "Kafka"),
    (r"python", "Python"),
]

# "rag" / "api" written as plain words in ordinary speech: only spelled-out or lowercase forms near tech context are
# realistic, but "rag" is rare enough in interview speech that the rule stays; the raw transcript is kept anyway.
_COMPILED = [(re.compile(rf"(?<![\w.])(?:{p})(?![\w])", re.IGNORECASE), c) for p, c in _RULES]


def _vocabulary_rules(vocabulary: list[str]) -> list[tuple[re.Pattern[str], str]]:
    """Terms from this candidate's resume / job: only their casing and inner spacing are aligned ("chroma db" -> the
    resume's "ChromaDB"). Short or plain-word terms are skipped (they could match ordinary words)."""
    rules = []
    for term in vocabulary:
        t = " ".join(term.split())
        if len(t) < 3 or len(t) > 40 or not re.search(r"[A-Za-z]", t):
            continue
        if t.islower() and " " not in t:
            continue  # "python", "react": nothing to align that the fixed rules do not already cover
        parts = [re.escape(p) for p in re.split(r"[\s\-.]+", t) if p]
        if not parts:
            continue
        pattern = r"[\s\-.]*".join(parts)
        rules.append((re.compile(rf"(?<![\w]){pattern}(?![\w])", re.IGNORECASE), t))
    return rules


def normalize_transcript(text: str, vocabulary: list[str] | None = None) -> str:
    out = " ".join((text or "").split())
    if not out:
        return out
    for pattern, canonical in [*_COMPILED, *_vocabulary_rules(vocabulary or [])]:
        out = pattern.sub(canonical, out)
    return out
