import type { CompanyProfile } from './company';
import type { JdContent, JobForm } from './job';

/**
 * Deterministic fact check of a job description against what HR actually entered (job form + company profile).
 * The AI may rewrite and structure HR's input; it may not invent job facts. This module finds what it invented.
 *
 * Used in two places, so they never disagree:
 * - the API, right after generation: problems are sent back to the AI worker once as corrections (one regeneration);
 * - the HR dashboard, live on every version and while editing: whatever is left is shown to HR before approval.
 *
 * Nothing here changes the JD. HR is the source of truth and may deliberately keep a flagged line.
 */

// ---------- seniority ----------

export const SENIORITY_LEVELS = ['ENTRY', 'MID', 'SENIOR', 'LEAD'] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const SENIORITY_LABELS: Record<Seniority, string> = {
  ENTRY: 'Entry level / fresher',
  MID: 'Mid level',
  SENIOR: 'Senior',
  LEAD: 'Lead / principal',
};

/**
 * Seniority from the experience range HR entered (mirrored in ai_worker/jd/seniority.py - keep both in sync).
 * 0-1 years: entry, 2-4: mid, 4-7: senior, 7+: lead. An internship is always entry level.
 */
export function seniorityFor(form: Pick<JobForm, 'experienceMin' | 'experienceMax' | 'employmentType'>): Seniority {
  if (form.employmentType === 'INTERNSHIP') return 'ENTRY';
  const { experienceMin: min, experienceMax: max } = form;
  if (min >= 7) return 'LEAD';
  if (min >= 4) return 'SENIOR';
  if (min >= 2) return 'MID';
  if (min >= 1 && max >= 3) return 'MID';
  return 'ENTRY';
}

// ---------- result ----------

export type JdReviewCode =
  | 'UNSUPPORTED_TECHNOLOGY'
  | 'UNSUPPORTED_QUALIFICATION'
  | 'UNSUPPORTED_BENEFIT'
  | 'UNSUPPORTED_WORK_MODE'
  | 'UNSUPPORTED_LOCATION'
  | 'EXPERIENCE_MISMATCH'
  | 'UNSUPPORTED_CONTEXT'
  | 'UNGROUNDED_DUTY'
  | 'SENIORITY_MISMATCH'
  | 'SKILL_CHECKLIST'
  | 'GENERIC_LANGUAGE'
  | 'REPETITIVE';

export interface JdReviewIssue {
  /** error = a fact HR did not provide; warning = writing quality / seniority depth. */
  severity: 'error' | 'warning';
  code: JdReviewCode;
  message: string;
  /** The words in the JD that triggered the issue. */
  terms: string[];
}

type CompanyFacts = Partial<Pick<CompanyProfile, 'name' | 'industry' | 'description' | 'productsServices' | 'headquarters' | 'culture' | 'benefits'>>;

// ---------- text helpers ----------

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word match that also works for terms like "C++", "Node.js" and ".NET". */
const word = (source: string, flags = 'i') => new RegExp(`(?<![A-Za-z0-9])(?:${source})(?![A-Za-z0-9])`, flags);
const literal = (term: string) => word(esc(term.trim()));
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const uniq = (items: string[]) => [...new Set(items)];

// ---------- technologies ----------

interface Tech {
  name: string;
  /** Regex sources, matched as whole words. */
  patterns: string[];
  caseSensitive?: boolean;
  /** Technologies that HR mentioning this one also covers (e.g. Django -> Python). */
  implies?: string[];
}

const JS = ['JavaScript'];
/**
 * Technologies an AI writer tends to add on its own. Not exhaustive: it is a net for the common inventions.
 * Ambiguous everyday words (Go, R, "react", "spring", "express") are case-sensitive or left out.
 */
const TECHNOLOGIES: Tech[] = [
  // languages
  { name: 'Python', patterns: ['python'] },
  { name: 'Java', patterns: ['java(?!\\s*script)'] },
  { name: 'JavaScript', patterns: ['javascript', 'JS'], caseSensitive: false },
  { name: 'TypeScript', patterns: ['typescript'], implies: JS },
  { name: 'Golang', patterns: ['golang'] },
  { name: 'Rust', patterns: ['Rust'], caseSensitive: true },
  { name: 'C++', patterns: ['c\\+\\+'] },
  { name: 'C#', patterns: ['c#'] },
  { name: 'Ruby', patterns: ['ruby'] },
  { name: 'PHP', patterns: ['php'] },
  { name: 'Kotlin', patterns: ['kotlin'] },
  { name: 'Swift', patterns: ['Swift'], caseSensitive: true },
  { name: 'Scala', patterns: ['scala'] },
  { name: 'Dart', patterns: ['Dart'], caseSensitive: true },
  { name: 'SQL', patterns: ['SQL'], caseSensitive: true },
  { name: 'Bash', patterns: ['Bash'], caseSensitive: true },
  // web / app frameworks
  { name: 'React', patterns: ['React(?:\\.js|JS)?(?! Native)'], caseSensitive: true, implies: JS },
  { name: 'React Native', patterns: ['react native'], implies: ['React', ...JS] },
  { name: 'Next.js', patterns: ['next\\.?js'], implies: ['React', ...JS] },
  { name: 'Angular', patterns: ['angular(?:js)?'], implies: ['TypeScript', ...JS] },
  { name: 'Vue', patterns: ['vue(?:\\.js)?'], implies: JS },
  { name: 'Svelte', patterns: ['svelte'], implies: JS },
  { name: 'Redux', patterns: ['redux'], implies: ['React', ...JS] },
  { name: 'Node.js', patterns: ['node\\.?js'], implies: JS },
  { name: 'Node.js', patterns: ['Node(?= (?:services?|backends?|servers?|APIs?|applications?))'], caseSensitive: true, implies: JS },
  { name: 'Express', patterns: ['Express(?:\\.js|JS)?'], caseSensitive: true, implies: ['Node.js', ...JS] },
  { name: 'NestJS', patterns: ['nest\\.?js'], implies: ['Node.js', 'TypeScript', ...JS] },
  { name: 'Django', patterns: ['django'], implies: ['Python'] },
  { name: 'Flask', patterns: ['flask'], implies: ['Python'] },
  { name: 'FastAPI', patterns: ['fastapi'], implies: ['Python'] },
  { name: 'Spring Boot', patterns: ['Spring(?: Boot)?'], caseSensitive: true, implies: ['Java'] },
  { name: 'Hibernate', patterns: ['hibernate'], implies: ['Java'] },
  { name: '.NET', patterns: ['\\.net(?: core)?', 'asp\\.net'], implies: ['C#'] },
  { name: 'Laravel', patterns: ['laravel'], implies: ['PHP'] },
  { name: 'Ruby on Rails', patterns: ['rails'], implies: ['Ruby'] },
  { name: 'Flutter', patterns: ['flutter'], implies: ['Dart'] },
  { name: 'Tailwind CSS', patterns: ['tailwind'] },
  { name: 'jQuery', patterns: ['jquery'], implies: JS },
  { name: 'GraphQL', patterns: ['graphql'] },
  { name: 'gRPC', patterns: ['grpc'] },
  { name: 'REST', patterns: ['REST(?:ful)?', 'RESTful'], caseSensitive: true },
  { name: 'Microservices', patterns: ['micro-?services?'] },
  { name: 'Celery', patterns: ['celery'], implies: ['Python'] },
  // data stores
  { name: 'MySQL', patterns: ['mysql'], implies: ['SQL'] },
  { name: 'PostgreSQL', patterns: ['postgres(?:ql)?'], implies: ['SQL'] },
  { name: 'SQL Server', patterns: ['sql server', 'mssql'], implies: ['SQL'] },
  { name: 'SQLite', patterns: ['sqlite'], implies: ['SQL'] },
  { name: 'Oracle', patterns: ['Oracle'], caseSensitive: true, implies: ['SQL'] },
  { name: 'MongoDB', patterns: ['mongo(?:db)?'] },
  { name: 'Redis', patterns: ['redis'] },
  { name: 'Cassandra', patterns: ['cassandra'] },
  { name: 'DynamoDB', patterns: ['dynamodb'] },
  { name: 'Elasticsearch', patterns: ['elastic\\s?search'] },
  { name: 'Neo4j', patterns: ['neo4j'] },
  { name: 'Firebase', patterns: ['firebase'] },
  { name: 'Snowflake', patterns: ['Snowflake'], caseSensitive: true },
  { name: 'BigQuery', patterns: ['bigquery'] },
  { name: 'Redshift', patterns: ['redshift'] },
  { name: 'Databricks', patterns: ['databricks'] },
  { name: 'Qdrant', patterns: ['qdrant'] },
  { name: 'Pinecone', patterns: ['pinecone'] },
  { name: 'Weaviate', patterns: ['weaviate'] },
  { name: 'Milvus', patterns: ['milvus'] },
  { name: 'FAISS', patterns: ['faiss'] },
  { name: 'ChromaDB', patterns: ['chroma(?:db)?'] },
  { name: 'pgvector', patterns: ['pgvector'], implies: ['PostgreSQL', 'SQL'] },
  // data / messaging / pipelines
  { name: 'Kafka', patterns: ['kafka'] },
  { name: 'RabbitMQ', patterns: ['rabbitmq'] },
  { name: 'Spark', patterns: ['Spark', 'PySpark', 'pyspark'], caseSensitive: true },
  { name: 'Hadoop', patterns: ['hadoop'] },
  { name: 'Airflow', patterns: ['airflow'] },
  { name: 'dbt', patterns: ['dbt'], caseSensitive: true },
  { name: 'Tableau', patterns: ['tableau'] },
  { name: 'Power BI', patterns: ['power\\s?bi'] },
  { name: 'Looker', patterns: ['looker'] },
  // ML / AI
  { name: 'PyTorch', patterns: ['pytorch'], implies: ['Python'] },
  { name: 'TensorFlow', patterns: ['tensorflow'], implies: ['Python'] },
  { name: 'Keras', patterns: ['keras'], implies: ['Python'] },
  { name: 'scikit-learn', patterns: ['scikit-?learn', 'sklearn'], implies: ['Python'] },
  { name: 'Hugging Face', patterns: ['hugging\\s?face'] },
  { name: 'OpenCV', patterns: ['opencv'] },
  { name: 'YOLO', patterns: ['YOLO(?:v\\d+)?'], caseSensitive: true },
  { name: 'LangChain', patterns: ['langchain'] },
  { name: 'LangGraph', patterns: ['langgraph'] },
  { name: 'LlamaIndex', patterns: ['llama\\s?index'] },
  { name: 'OpenAI', patterns: ['openai'] },
  { name: 'GPT', patterns: ['GPT(?:-?\\d+(?:\\.\\d+)?o?)?', 'ChatGPT'], caseSensitive: true },
  { name: 'Gemini', patterns: ['Gemini'], caseSensitive: true },
  { name: 'BERT', patterns: ['BERT'], caseSensitive: true },
  { name: 'CUDA', patterns: ['cuda'] },
  { name: 'NumPy', patterns: ['numpy'], implies: ['Python'] },
  { name: 'Pandas', patterns: ['pandas'], implies: ['Python'] },
  { name: 'MLflow', patterns: ['mlflow'] },
  { name: 'Kubeflow', patterns: ['kubeflow'] },
  { name: 'SageMaker', patterns: ['sagemaker'] },
  { name: 'Vertex AI', patterns: ['vertex ai'] },
  { name: 'ONNX', patterns: ['onnx'] },
  { name: 'TensorRT', patterns: ['tensorrt'] },
  { name: 'MLOps', patterns: ['mlops'] },
  // cloud / infrastructure / delivery
  { name: 'AWS', patterns: ['aws', 'amazon web services', 'EC2', 'S3', 'AWS Lambda'], caseSensitive: false },
  { name: 'Azure', patterns: ['azure'] },
  { name: 'Google Cloud', patterns: ['gcp', 'google cloud'] },
  { name: 'Heroku', patterns: ['heroku'] },
  { name: 'Vercel', patterns: ['vercel'] },
  { name: 'Docker', patterns: ['docker', 'containeri[sz](?:ed|ation)'] },
  { name: 'Kubernetes', patterns: ['kubernetes', 'k8s'] },
  { name: 'Helm', patterns: ['Helm'], caseSensitive: true },
  { name: 'Terraform', patterns: ['terraform'] },
  { name: 'Ansible', patterns: ['ansible'] },
  { name: 'Jenkins', patterns: ['jenkins'] },
  { name: 'GitHub Actions', patterns: ['github actions'] },
  { name: 'CI/CD', patterns: ['ci\\s?/\\s?cd', 'continuous (?:integration|delivery|deployment)'] },
  { name: 'DevOps', patterns: ['devops'] },
  { name: 'Serverless', patterns: ['serverless'] },
  { name: 'Linux', patterns: ['linux'] },
  { name: 'Nginx', patterns: ['nginx'] },
  { name: 'Prometheus', patterns: ['prometheus'] },
  { name: 'Grafana', patterns: ['grafana'] },
  { name: 'Datadog', patterns: ['datadog'] },
  // tools / practices
  { name: 'Git', patterns: ['Git'], caseSensitive: true },
  { name: 'GitHub', patterns: ['github(?! actions)'], implies: ['Git'] },
  { name: 'GitLab', patterns: ['gitlab'], implies: ['Git'] },
  { name: 'Jira', patterns: ['jira'] },
  { name: 'Agile', patterns: ['Agile'], caseSensitive: true },
  { name: 'Scrum', patterns: ['scrum'] },
  { name: 'Selenium', patterns: ['selenium'] },
  { name: 'Cypress', patterns: ['cypress'] },
  { name: 'Playwright', patterns: ['playwright'] },
  { name: 'Jest', patterns: ['Jest'], caseSensitive: true },
  { name: 'JUnit', patterns: ['junit'], implies: ['Java'] },
  { name: 'pytest', patterns: ['pytest'], implies: ['Python'] },
];

const COMPILED = TECHNOLOGIES.map((t) => ({ ...t, regexes: t.patterns.map((p) => word(p, t.caseSensitive ? '' : 'i')) }));
const techIn = (text: string) => COMPILED.filter((t) => t.regexes.some((r) => r.test(text)));

/** Technologies HR's input covers: named directly, implied by a named one (Django -> Python), or part of a named skill. */
function supportedTech(input: string): Set<string> {
  const named = techIn(input);
  return new Set([...named.map((t) => t.name), ...named.flatMap((t) => t.implies ?? [])]);
}

// ---------- other facts ----------

interface FactPattern {
  label: string;
  regex: RegExp;
}

const f = (label: string, source: string): FactPattern => ({ label, regex: word(source) });

const QUALIFICATIONS: FactPattern[] = [
  f("Bachelor's degree", "bachelor(?:'?s)?"),
  f("Master's degree", "master'?s(?: degree)?|masters degree"),
  f('PhD', 'ph\\.?\\s?d|doctorate'),
  f('B.Tech / B.E.', 'b\\.?\\s?tech|b\\.e\\.'),
  f('M.Tech / M.E.', 'm\\.?\\s?tech|m\\.e\\.'),
  f('MCA / BCA', 'mca|bca'),
  f('MBA', 'mba'),
  f('degree', 'degree (?:in|from)|(?:university|college|graduate|engineering|bachelor|master) degree'),
  f('diploma', 'diploma'),
  f('certification', 'certifi(?:cation|cate)s?|certified'),
];

const BENEFITS: FactPattern[] = [
  f('insurance', '(?:health|medical|life|group) insurance|insurance'),
  f('flexible hours', 'flexible (?:working )?(?:hours|timings?|schedules?)|flexi(?:ble)?[- ]time'),
  f('stock options', 'stock options?|esops?|equity'),
  f('paid leave', 'paid (?:time off|leaves?)|pto|annual leaves?|parental leaves?'),
  f('bonus', 'bonus(?:es)?|incentives?'),
  f('wellness', 'gym|wellness'),
  f('learning budget', 'learning (?:budget|allowance)|training budget'),
  f('relocation', 'relocation'),
  f('free meals', 'free (?:meals|lunch|food|snacks)'),
  f('competitive pay', 'competitive (?:salary|compensation|pay|package)'),
];

const WORK_MODES: Record<JobForm['workMode'], FactPattern> = {
  REMOTE: f('remote', 'remote(?:ly)?(?! (?:sensing|servers?|devices?|apis?|repositor(?:y|ies)|procedure))|work from home|wfh'),
  HYBRID: f('hybrid', 'hybrid(?! (?:search|retrieval|cloud|models?|approach|apps?|architectures?|systems?))'),
  ONSITE: f('on-site', 'on-?site|in-office|from (?:the|our) office|in the office|work from office'),
};

/** City names (with spellings) the AI might add. A city HR did not enter anywhere is flagged. */
const CITIES: string[][] = [
  ['Mumbai', 'Bombay'], ['New Delhi', 'Delhi', 'NCR'], ['Bengaluru', 'Bangalore'], ['Hyderabad'], ['Chennai'],
  ['Kolkata'], ['Pune'], ['Ahmedabad'], ['Gurugram', 'Gurgaon'], ['Noida'], ['Jaipur'], ['Chandigarh'],
  ['Kochi', 'Cochin'], ['Indore'], ['Surat'], ['Vadodara', 'Baroda'], ['Coimbatore'], ['Nagpur'], ['Lucknow'],
  ['Bhubaneswar'], ['Thiruvananthapuram', 'Trivandrum'], ['Mysuru', 'Mysore'], ['Rajkot'], ['Gandhinagar'],
  ['Visakhapatnam', 'Vizag'], ['Goa'], ['London'], ['New York'], ['San Francisco'], ['Seattle'], ['Austin'],
  ['Boston'], ['Toronto'], ['Singapore'], ['Dubai'], ['Berlin'], ['Amsterdam'], ['Sydney'], ['Tokyo'], ['Paris'],
];

/**
 * Claims about the work environment, scale, systems or other people that an AI writer adds to make a duty sound
 * concrete ("in production", "low latency", "existing systems", "product team"). They are job facts: allowed only
 * when HR's input says them, or a skill HR named implies them (`impliedBy`: "REST" -> APIs, "Docker" -> deployment).
 */
interface ContextClaim extends FactPattern {
  impliedBy?: RegExp;
}
const c = (label: string, source: string, impliedBy?: string): ContextClaim => ({
  ...f(label, source),
  ...(impliedBy ? { impliedBy: word(impliedBy) } : {}),
});
const CONTEXT_CLAIMS: ContextClaim[] = [
  c('production', '(?:in|into|to|for|on) production|production(?:[- ]ready| systems?| environments?| issues?| load| quality| use)', 'mlops|devops|sre'),
  c('deployment', 'deploy(?:s|ed|ing|ment|ments)?', 'docker|kubernetes|k8s|ci\\s?/\\s?cd|devops|mlops|helm|terraform|jenkins|github actions'),
  c('latency / performance at scale', 'latency|throughput|at scale|scalab(?:le|ility)|high[- ]availability|real[- ]time'),
  c('existing systems', 'existing (?:systems?|applications?|application workflows?|services?|products?|platforms?|codebase|infrastructure|backend)'),
  c('pipelines', 'pipelines?', 'etl|elt|airflow|spark|pyspark|kafka|dbt|ci\\s?/\\s?cd|mlops|data engineering|jenkins|github actions'),
  c('APIs', 'APIs?', 'rest(?:ful)?|graphql|grpc|fastapi|flask|django|express(?:\\.js)?|nest\\.?js|spring(?: boot)?|\\.net|asp\\.net|laravel|rails|node\\.?js'),
  c('cloud', 'cloud', 'aws|azure|gcp|google cloud|serverless|kubernetes'),
  c('dashboards', 'dashboards?', 'tableau|power\\s?bi|looker|grafana|kibana|metabase|superset|streamlit'),
  c('A/B testing', 'a/b test(?:s|ing)?'),
  c('other teams / stakeholders', 'cross[- ]functional|stakeholders?|(?:product|design|business|backend|frontend|infra(?:structure)?|platform|data|qa|ops|sales|marketing) (?:teams?|managers?|leads?|owners?)'),
  c('customers / users', 'customers?|clients?|end[- ]users?'),
  // how the person works is a job fact too - it never follows from the experience range alone
  c(
    'how the person works (independence, supervision, guidance, reviews, documentation, team discussions)',
    'independent(?:ly)?|(?:minimal|without|little|close) supervision|under (?:the )?(?:guidance|supervision|direction)|with guidance|guidance (?:from|of)|' +
      'mentor(?:s|ed|ing)?|code reviews?|design reviews?|review(?:s|ing)? (?:the )?(?:code|designs?|pull requests|work of)|team discussions?|' +
      'document (?:your|their) work|organi[sz]e (?:your|their) (?:own )?time|go-to (?:person|expert)|assigned (?:tasks?|areas?|work)',
  ),
];

/** Words in a title that say nothing about the work itself. */
const GENERIC_TITLE_WORDS = new Set(
  'engineer engineers developer developers senior junior lead principal associate intern trainee staff manager specialist analyst executive head the and of for'.split(' '),
);
/**
 * Common words and generic work verbs that do not make a sentence of HR's additional requirements a "source" for a
 * duty - otherwise "build" in HR's text would ground every "Build ..." line the AI invents.
 */
const STOP_WORDS = new Set(
  [
    'about above after again against along also among because before being below between both could during each every',
    'from have having into itself more most other ought over same should some such than that their them then there',
    'these they this those through under until very were what when where which while will with within would your must',
    'work works working role roles person people candidate candidates experience years able ability good strong',
    'build builds building develop develops developing design designs designing create creates creating write writes',
    'writing maintain maintains maintaining ensure ensures support supports supporting improve improves improving',
    'implement implements implementing deliver delivers delivering manage manages managing handle handles handling',
    'perform performs provide provides using should across within based related various multiple',
  ]
    .join(' ')
    .split(' '),
);
/** Short forms of skills HR often types, so "LLM" also matches "large language models". */
const SKILL_ALIASES: Record<string, string[]> = {
  llm: ['large language models?', 'llms'],
  llms: ['large language models?', 'llm'],
  ml: ['machine learning'],
  'machine learning': ['ml'],
  dl: ['deep learning'],
  'deep learning': ['dl'],
  nlp: ['natural language processing'],
  'natural language processing': ['nlp'],
  cv: ['computer vision'],
  'computer vision': ['cv'],
  genai: ['generative ai', 'gen ai'],
  'generative ai': ['genai', 'gen ai'],
  rag: ['retrieval[- ]augmented generation', 'retrieval'],
};
/** A skill as written by HR, its plural, and its common short / long form. */
const skillRegex = (skill: string) => {
  const key = skill.trim().toLowerCase();
  return word([`${esc(skill.trim())}s?`, ...(SKILL_ALIASES[key] ?? [])].join('|'));
};

const GENERIC_PHRASES: string[] = [
  'dynamic environment', 'dynamic team', 'fast-paced', 'fast paced', 'passionate', 'rockstar', 'rock star', 'ninja', 'guru',
  'exciting opportunity', 'unlock your potential', 'cutting-edge', 'cutting edge', 'leverage', 'innovative and collaborative',
  'highly motivated', 'self-motivated', 'world-class', 'world class', 'game-changing', 'game changer', 'revolutioni[sz]e',
  'transformative', 'state-of-the-art', 'best-in-class', 'synerg(?:y|ies)', 'seamless(?:ly)?', 'thrive', 'wear many hats',
  'go-getter', 'team player', 'hit the ground running', 'next-generation', 'paradigm',
];
const GENERIC_REGEX = GENERIC_PHRASES.map((p) => word(p));

/** Wording that belongs to a junior role. */
const JUNIOR_SIGNALS = [
  'under (?:the )?(?:guidance|supervision|direction)', 'with guidance', 'assist(?:s|ing)? (?:in|with)', 'help(?:s|ing)? (?:the team )?with',
  'learn(?:ing)? (?:from|the|about|our)', 'entry[- ]level', 'freshers?', 'no prior experience',
].map((p) => word(p));

/** Wording that belongs to a senior/lead role (technical ownership). */
const SENIOR_SIGNALS = [
  'architect(?:s|ing)? (?:the|our|scalable|end-to-end)', '(?:own|define|set|lead)(?:s|ing)? (?:the )?(?:overall )?architecture',
  'mentor(?:s|ing)?', 'lead(?:s|ing)? (?:a|the) (?:team|engineering team|squad)', 'technical strategy', 'technical direction',
  'engineering standards', 'set(?:s|ting)? (?:the )?standards', '(?:own|drive)(?:s|ing)? technical decisions', 'technical roadmap',
].map((p) => word(p));

/** People management - not implied by a senior individual-contributor role. */
const MANAGER_SIGNALS = [
  'manag(?:e|es|ing) (?:a |the )?(?:team|engineers|people|reports)', 'people management', 'direct reports',
  'performance reviews?', 'hir(?:e|es|ing) (?:and (?:grow|develop) )?(?:engineers|team members|the team)', 'line management',
].map((p) => word(p));

const OWNERSHIP_VERBS = word('own(?:s|ing)?|design(?:s|ing)?|drive(?:s|ing)?|lead(?:s|ing)?|architect(?:s|ing)?|evaluate(?:s|ing)?|review(?:s|ing)?|guide(?:s|ing)?|decid(?:e|es|ing)|establish(?:es|ing)?|define(?:s|ing)?|shape(?:s|ing)?');

const YEARS = /(\d+(?:\.\d+)?)\s*(\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*\+?\s*)?(?:years?|yrs?)\b/gi;

// ---------- the check ----------

/** Everything HR wrote: the job form and the company profile. Only these may be stated as facts. */
function hrInputText(form: JobForm, company?: CompanyFacts | null): string {
  return [
    form.title,
    form.department,
    ...form.mustHaveSkills,
    ...form.niceToHaveSkills,
    ...form.locations,
    form.shortDescription,
    company?.name,
    company?.industry,
    company?.description,
    company?.productsServices,
    company?.headquarters,
    company?.culture,
    ...(company?.benefits ?? []),
  ]
    .filter(Boolean)
    .join('\n');
}

const jdText = (jd: JdContent) =>
  [jd.title, jd.summary, jd.aboutCompany, ...jd.responsibilities, ...jd.requirements, ...jd.niceToHave, ...jd.benefits].join('\n');

/** The role-describing parts (not the company paragraph, which may legitimately mention company history in years). */
const roleText = (jd: JdContent) => [jd.summary, ...jd.responsibilities, ...jd.requirements, ...jd.niceToHave, ...jd.benefits].join('\n');

const fmtYears = (n: number) => String(n);

/**
 * Checks a JD against HR's input. Returns problems only; never edits the JD.
 * Errors are facts HR did not provide; warnings are about depth and wording.
 */
export function reviewJd(form: JobForm, jd: JdContent, company?: CompanyFacts | null): JdReviewIssue[] {
  const issues: JdReviewIssue[] = [];
  const input = hrInputText(form, company);
  const text = jdText(jd);
  const role = roleText(jd);
  const add = (severity: JdReviewIssue['severity'], code: JdReviewCode, message: string, terms: string[]) =>
    issues.push({ severity, code, message, terms });

  // 1. technologies HR did not name
  const supported = supportedTech(input);
  const invented = uniq(techIn(text).map((t) => t.name)).filter((name) => !supported.has(name));
  if (invented.length) {
    add('error', 'UNSUPPORTED_TECHNOLOGY', `Mentions ${list(invented)}, which ${invented.length > 1 ? 'are' : 'is'} not in the job requirements.`, invented);
  }

  // 2. qualifications, 3. benefits
  const unsupportedFacts = (patterns: FactPattern[]) =>
    uniq(patterns.filter((p) => p.regex.test(text) && !p.regex.test(input)).map((p) => p.label));
  const quals = unsupportedFacts(QUALIFICATIONS);
  if (quals.length) {
    add('error', 'UNSUPPORTED_QUALIFICATION', `Asks for ${list(quals)}, which the job requirements do not mention.`, quals);
  }
  const perks = unsupportedFacts(BENEFITS);
  if (perks.length) {
    add('error', 'UNSUPPORTED_BENEFIT', `Promises ${list(perks)}, which is not in the job requirements or the company profile.`, perks);
  }

  // 4. work mode other than the one HR chose
  // a hybrid role naturally mentions both office days and remote days, so only remote / on-site roles are checked
  const otherModes = (form.workMode === 'HYBRID' ? [] : (Object.keys(WORK_MODES) as JobForm['workMode'][]))
    .filter((mode) => mode !== form.workMode)
    .map((mode) => WORK_MODES[mode])
    .filter((p) => p.regex.test(role) && !p.regex.test(input))
    .map((p) => p.label);
  if (otherModes.length) {
    add('error', 'UNSUPPORTED_WORK_MODE', `Describes the role as ${list(otherModes)}, but the work mode is ${WORK_MODES[form.workMode].label}.`, otherModes);
  }

  // 5. cities HR did not enter
  const cities = CITIES.filter((names) => names.some((n) => literal(n).test(text)) && !names.some((n) => literal(n).test(input))).map(
    (names) => names[0]!,
  );
  if (cities.length) {
    add('error', 'UNSUPPORTED_LOCATION', `Mentions ${list(cities)}, which is not one of the job's locations.`, cities);
  }

  // 6. experience other than HR's range
  const allowed = new Set([form.experienceMin, form.experienceMax]);
  const wrongYears = uniq(
    [...role.matchAll(YEARS)]
      .filter((m) => [m[1], m[3]].filter((n): n is string => n !== undefined).some((n) => !allowed.has(Number(n))))
      .map((m) => m[0].trim()),
  );
  const range = form.experienceMin === form.experienceMax ? `${fmtYears(form.experienceMin)} years` : `${fmtYears(form.experienceMin)}-${fmtYears(form.experienceMax)} years`;
  if (wrongYears.length) {
    add('error', 'EXPERIENCE_MISMATCH', `States ${list(wrongYears.map((y) => `"${y}"`))}, but the experience range is ${range}.`, wrongYears);
  }

  // 7a. claims about the environment, scale, systems or other teams that HR did not make
  const context = unsupportedFacts(CONTEXT_CLAIMS.filter((claim) => !claim.impliedBy?.test(input)));
  if (context.length) {
    add(
      'error',
      'UNSUPPORTED_CONTEXT',
      `Mentions ${list(context)}, which the job requirements and company profile do not mention. Remove these words or rewrite the sentence without them.`,
      context,
    );
  }

  // 7b. duties with no source in HR's input - every responsibility needs one
  const sources: RegExp[] = [
    ...form.mustHaveSkills.map(skillRegex),
    ...[form.title, form.department ?? '']
      .flatMap((t) => t.split(/[\s/,&-]+/))
      .filter((w) => w.length >= 2 && !GENERIC_TITLE_WORDS.has(w.toLowerCase()))
      .map((w) => literal(w)),
    ...uniq(
      (form.shortDescription ?? '')
        .toLowerCase()
        .match(/[a-z][a-z+#.]{4,}/g)
        ?.filter((w) => !STOP_WORDS.has(w)) ?? [],
    ).map((w) => literal(w)),
  ];
  const ungrounded = jd.responsibilities.filter((r) => !sources.some((s) => s.test(r)));
  if (ungrounded.length) {
    add(
      'warning',
      'UNGROUNDED_DUTY',
      `${ungrounded.length > 1 ? `${ungrounded.length} responsibilities are` : 'A responsibility is'} not based on any skill, the title or the additional requirements HR entered: ${list(ungrounded.map((r) => `"${r}"`))}. Base every duty on the must-have skills or HR's additional requirements, or remove it.`,
      ungrounded,
    );
  }

  // 8. seniority depth
  const level = seniorityFor(form);
  const duties = [jd.summary, ...jd.responsibilities].join('\n');
  const found = (signals: RegExp[]) => uniq(signals.flatMap((r) => duties.match(r)?.[0] ?? []));
  const inputMentions = (signals: RegExp[]) => signals.some((r) => r.test(input));
  if (level === 'SENIOR' || level === 'LEAD') {
    const junior = found(JUNIOR_SIGNALS);
    if (junior.length) {
      add('warning', 'SENIORITY_MISMATCH', `Uses junior-level wording (${list(junior.map((j) => `"${j}"`))}) for a ${range} role.`, junior);
    }
    const owning = jd.responsibilities.filter((r) => OWNERSHIP_VERBS.test(r)).length;
    if (jd.responsibilities.length >= 3 && owning < 2) {
      add('warning', 'SENIORITY_MISMATCH', `The responsibilities show little technical ownership for a ${range} role.`, []);
    }
  } else {
    const senior = found(SENIOR_SIGNALS);
    if (senior.length && !inputMentions(SENIOR_SIGNALS)) {
      add('warning', 'SENIORITY_MISMATCH', `Uses senior/lead wording (${list(senior.map((s) => `"${s}"`))}) for a ${range} role.`, senior);
    }
  }
  if (level !== 'LEAD') {
    const managing = found(MANAGER_SIGNALS);
    if (managing.length && !inputMentions(MANAGER_SIGNALS)) {
      add('warning', 'SENIORITY_MISMATCH', `Adds people-management duties (${list(managing.map((m) => `"${m}"`))}) that the job requirements do not ask for.`, managing);
    }
  }

  // 9. one shallow responsibility per skill
  const skills = form.mustHaveSkills.map((s) => ({ skill: s, regex: literal(s) }));
  const single = jd.responsibilities
    .map((r) => skills.filter((s) => s.regex.test(r)).map((s) => s.skill))
    .filter((hits) => hits.length === 1)
    .map((hits) => hits[0]!);
  if (jd.responsibilities.length >= 4 && single.length >= 4 && single.length / jd.responsibilities.length >= 0.7 && uniq(single).length >= 4) {
    add('warning', 'SKILL_CHECKLIST', 'The responsibilities read like the skill list rewritten one skill per line. Describe the work the role does instead.', uniq(single));
  }

  // 10. buzzwords
  const generic = uniq(GENERIC_REGEX.flatMap((r) => text.match(r)?.[0] ?? []));
  if (generic.length) {
    add('warning', 'GENERIC_LANGUAGE', `Uses generic phrases (${list(generic.map((g) => `"${g}"`))}). Plain, specific wording reads better.`, generic);
  }

  // 11. the same opening verb again and again
  const openers = jd.responsibilities.map((r) => r.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '');
  const counts = new Map<string, number>();
  for (const o of openers) if (o) counts.set(o, (counts.get(o) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n >= 3 && n / openers.length > 0.4).map(([w]) => w);
  if (repeated.length) {
    add('warning', 'REPETITIVE', `Most responsibilities start with the same word (${list(repeated.map((w) => `"${w}"`))}).`, repeated);
  }

  return issues;
}

/** Issues worth one automatic regeneration (all factual errors, plus the main writing problems). */
export const isCorrectable = (issue: JdReviewIssue) =>
  issue.severity === 'error' ||
  issue.code === 'UNGROUNDED_DUTY' ||
  issue.code === 'SKILL_CHECKLIST' ||
  issue.code === 'SENIORITY_MISMATCH' ||
  issue.code === 'GENERIC_LANGUAGE';

/** Lower is better: each invented fact counts far more than a writing warning. Used to keep the better of two drafts. */
export const reviewScore = (issues: JdReviewIssue[]) =>
  issues.reduce((sum, i) => sum + (i.severity === 'error' ? 10 * Math.max(1, i.terms.length) : 1), 0);
