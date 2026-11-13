import { describe, expect, it } from 'vitest';
import { reviewJd, reviewScore, seniorityFor, isCorrectable, type JdContent, type JobForm } from '../src';

const form = (over: Partial<JobForm> = {}): JobForm => ({
  title: 'AI Engineer',
  experienceMin: 4,
  experienceMax: 6,
  mustHaveSkills: ['Python', 'Deep Learning', 'Computer Vision', 'LangChain', 'Qdrant', 'MongoDB', 'MySQL'],
  niceToHaveSkills: [],
  currency: 'INR',
  salaryType: 'CTC',
  locations: ['Pune'],
  workMode: 'HYBRID',
  employmentType: 'FULL_TIME',
  openings: 1,
  ...over,
});

const jd = (over: Partial<JdContent> = {}): JdContent => ({
  title: 'AI Engineer',
  summary:
    'We are hiring an AI Engineer for a full-time, hybrid role in Pune. You will work on Python-based AI workflows, deep learning and computer vision features, and LLM applications built with LangChain.',
  aboutCompany: '',
  responsibilities: [
    'Own the design and implementation of Python-based AI workflows and the components that support them.',
    'Design, evaluate and improve deep learning and computer vision solutions based on product requirements.',
    'Build LLM-powered workflows with LangChain and integrate retrieval where it fits the use case.',
    'Design vector retrieval with Qdrant for the AI features that need it.',
    'Work with MongoDB and MySQL to meet the data persistence needs of these workflows.',
    'Review technical approaches, troubleshoot issues and drive improvements across AI workflows.',
  ],
  requirements: [
    '4-6 years of experience building AI or machine learning systems.',
    'Strong Python, with hands-on deep learning and computer vision work.',
    'Experience building LLM applications with LangChain and vector search with Qdrant.',
    'Working knowledge of MongoDB and MySQL.',
  ],
  niceToHave: [],
  benefits: [],
  ...over,
});

const codes = (issues: ReturnType<typeof reviewJd>) => issues.map((i) => i.code);

describe('seniorityFor', () => {
  it.each([
    [0, 1, 'ENTRY'],
    [0, 2, 'ENTRY'],
    [1, 3, 'MID'],
    [2, 4, 'MID'],
    [3, 5, 'MID'],
    [4, 6, 'SENIOR'],
    [5, 8, 'SENIOR'],
    [7, 12, 'LEAD'],
  ] as const)('%s-%s years -> %s', (min, max, level) =>
    expect(seniorityFor({ experienceMin: min, experienceMax: max, employmentType: 'FULL_TIME' })).toBe(level));
  it('an internship is entry level whatever the range', () =>
    expect(seniorityFor({ experienceMin: 2, experienceMax: 4, employmentType: 'INTERNSHIP' })).toBe('ENTRY'));
});

describe('reviewJd', () => {
  it('a grounded, senior-depth JD has no issues', () => {
    expect(reviewJd(form(), jd())).toEqual([]);
  });

  // Test 1 - fresher
  it('fresher: architecture ownership and mentoring are flagged; guided wording is fine', () => {
    const f = form({ experienceMin: 0, experienceMax: 1, mustHaveSkills: ['Python', 'Deep Learning', 'Computer Vision'] });
    const good = jd({
      summary: 'An entry-level AI Engineer role in Pune.',
      responsibilities: [
        'Implement Python components for deep learning features.',
        'Assist in training and testing computer vision models.',
        'Debug issues in the Python code and fix them.',
      ],
      requirements: ['0-1 years of experience.', 'Python, deep learning and computer vision fundamentals.'],
    });
    expect(reviewJd(f, good)).toEqual([]);
    const bad = jd({ ...good, responsibilities: ['Architect the end-to-end computer vision platform.', 'Mentor junior engineers on deep learning.', 'Write Python.'] });
    const issue = reviewJd(f, bad).find((i) => i.code === 'SENIORITY_MISMATCH')!;
    expect(issue.severity).toBe('warning');
    expect(issue.terms.join(' ')).toMatch(/Architect the/);
    expect(issue.terms.join(' ')).toMatch(/Mentor/);
  });

  // Test 2 - mid level
  it('mid level: leadership language is flagged, independent implementation is not', () => {
    const f = form({ experienceMin: 2, experienceMax: 4, mustHaveSkills: ['Python', 'LangChain', 'Qdrant'] });
    const good = jd({
      summary: 'A mid-level AI Engineer role in Pune.',
      responsibilities: [
        'Develop and maintain Python services for LLM features built with LangChain.',
        'Integrate Qdrant-based retrieval into the LangChain workflows.',
        'Troubleshoot and optimise retrieval quality in the Qdrant-backed features.',
      ],
      requirements: ['2-4 years of experience.', 'Python, LangChain and Qdrant.'],
    });
    expect(reviewJd(f, good)).toEqual([]);
    const bad = jd({ ...good, responsibilities: [...good.responsibilities, 'Set the technical strategy and lead a team of engineers.'] });
    expect(codes(reviewJd(f, bad))).toContain('SENIORITY_MISMATCH');
  });

  // Test 3 - senior
  it('senior: junior wording and automatic people management are flagged', () => {
    const juniorish = jd({
      responsibilities: [
        'Assist in building Python workflows under the guidance of senior engineers.',
        'Help with deep learning and computer vision experiments.',
        'Learn the LangChain and Qdrant codebase.',
      ],
    });
    const junior = reviewJd(form(), juniorish).filter((i) => i.code === 'SENIORITY_MISMATCH');
    expect(junior.map((i) => i.message).join(' ')).toMatch(/junior-level wording/);
    expect(junior.map((i) => i.message).join(' ')).toMatch(/little technical ownership/);

    const manager = jd({ responsibilities: [...jd().responsibilities, 'Manage a team of engineers and run performance reviews.'] });
    expect(reviewJd(form(), manager).find((i) => i.message.includes('people-management'))).toBeDefined();
    // a lead role may include it when HR asks for it
    const lead = form({ experienceMin: 8, experienceMax: 12, shortDescription: 'Manages a team of engineers and runs their performance reviews.' });
    expect(reviewJd(lead, { ...manager, requirements: ['8-12 years of experience.'] })).toEqual([]);
  });

  // Test 4 - unsupported technology
  it('flags technologies HR did not provide, and accepts ones implied by a provided skill', () => {
    const f = form({ experienceMin: 2, experienceMax: 4, mustHaveSkills: ['Python', 'LangChain', 'Qdrant'] });
    const invented = jd({
      responsibilities: ['Deploy LangChain services on AWS with Docker and Kubernetes.', 'Cache Qdrant results in Redis.', 'Write Python.'],
      requirements: ['2-4 years of experience.', 'Python, LangChain and Qdrant.'],
    });
    const issue = reviewJd(f, invented).find((i) => i.code === 'UNSUPPORTED_TECHNOLOGY')!;
    expect(issue.severity).toBe('error');
    expect(issue.terms.sort()).toEqual(['AWS', 'Docker', 'Kubernetes', 'Redis']);

    // Django implies Python; MySQL implies SQL
    const implied = form({ mustHaveSkills: ['Django', 'MySQL', 'REST APIs'], experienceMin: 2, experienceMax: 4 });
    const ok = jd({
      summary: 'A backend role.',
      responsibilities: ['Build Python services with Django and RESTful APIs.', 'Write SQL against MySQL.', 'Review pull requests.'],
      requirements: ['2-4 years of experience.'],
    });
    expect(codes(reviewJd(implied, ok))).not.toContain('UNSUPPORTED_TECHNOLOGY');
  });

  it('a technology named in the company profile is supported', () => {
    const withAws = jd({ aboutCompany: 'Acme runs its analytics platform on AWS.' });
    expect(codes(reviewJd(form(), withAws))).toContain('UNSUPPORTED_TECHNOLOGY');
    expect(codes(reviewJd(form(), withAws, { description: 'Acme runs its analytics platform on AWS for retailers.' }))).not.toContain(
      'UNSUPPORTED_TECHNOLOGY',
    );
  });

  // Test 5 - skill checklist
  it('flags one shallow responsibility per skill', () => {
    const checklist = jd({
      responsibilities: [
        'Develop Python workflows.',
        'Build Deep Learning models.',
        'Implement Computer Vision.',
        'Develop LangChain workflows.',
        'Store Qdrant embeddings.',
        'Manage MongoDB.',
        'Manage MySQL.',
      ],
    });
    expect(codes(reviewJd(form(), checklist))).toContain('SKILL_CHECKLIST');
    expect(codes(reviewJd(form(), jd()))).not.toContain('SKILL_CHECKLIST');
  });

  // Test 6 - experience
  it('experience must match the range HR entered', () => {
    const wrong = jd({ requirements: ['7+ years of experience with Python.', 'At least 3 years of computer vision work.'] });
    const issue = reviewJd(form(), wrong).find((i) => i.code === 'EXPERIENCE_MISMATCH')!;
    expect(issue.terms).toEqual(['7+ years', '3 years']);
    expect(codes(reviewJd(form(), jd({ requirements: ['4 to 6 years of experience.'] })))).not.toContain('EXPERIENCE_MISMATCH');
    // company history in the About section is not an experience requirement
    expect(codes(reviewJd(form(), jd({ aboutCompany: 'Founded 12 years ago.' }), { description: 'Founded 12 years ago in Pune.' }))).toEqual([]);
  });

  // Test 7 - natural writing
  it('flags generic AI / corporate phrases', () => {
    const fluffy = jd({ summary: 'Join our dynamic team in a fast-paced environment and leverage cutting-edge technologies.' });
    const issue = reviewJd(form(), fluffy).find((i) => i.code === 'GENERIC_LANGUAGE')!;
    expect(issue.terms).toEqual(expect.arrayContaining(['dynamic team', 'fast-paced', 'leverage', 'cutting-edge']));
  });

  it('flags invented qualifications, benefits, locations and work modes', () => {
    const invented = jd({
      requirements: ["Bachelor's degree in Computer Science.", 'AWS certification.', ...jd().requirements],
      benefits: ['Health insurance', 'Flexible working hours', 'Stock options'],
      summary: 'A fully remote role, open to candidates in Bangalore.',
    });
    const onsite = form({ workMode: 'ONSITE' });
    const found = reviewJd(onsite, invented);
    expect(codes(found)).toEqual(
      expect.arrayContaining(['UNSUPPORTED_QUALIFICATION', 'UNSUPPORTED_BENEFIT', 'UNSUPPORTED_LOCATION', 'UNSUPPORTED_WORK_MODE']),
    );
    expect(found.find((i) => i.code === 'UNSUPPORTED_BENEFIT')!.terms).toEqual(['insurance', 'flexible hours', 'stock options']);
    // benefits from the company profile are allowed
    const allowed = reviewJd(form(), jd({ benefits: ['Health insurance'] }), { benefits: ['Health insurance for you and family'] });
    expect(codes(allowed)).not.toContain('UNSUPPORTED_BENEFIT');
  });

  it('does not treat everyday words as facts', () => {
    const prose = jd({
      responsibilities: [
        ...jd().responsibilities,
        'Bring a high degree of ownership to each node of the AI workflows and spark discussion on trade-offs.',
      ],
    });
    expect(reviewJd(form(), prose)).toEqual([]);
  });

  it('flags how-the-person-works statements HR did not make, in the summary and the duties', () => {
    const f = form({ experienceMin: 3, experienceMax: 5, mustHaveSkills: ['Python', 'Machine Learning', 'LLM'] });
    const styled = jd({
      summary: 'As an AI Engineer, you will build machine learning models in Python, working independently on your assigned tasks.',
      responsibilities: ['Develop machine learning models in Python.', 'Build LLM applications and document your work for the team.'],
      requirements: ['3-5 years of experience.'],
    });
    const issue = reviewJd(f, styled).find((i) => i.code === 'UNSUPPORTED_CONTEXT')!;
    expect(issue.severity).toBe('error');
    expect(issue.terms[0]).toMatch(/how the person works/);
    // fine when HR wrote it
    const said = form({ ...f, shortDescription: 'Works independently on assigned tasks and documents their work for the team.' });
    expect(codes(reviewJd(said, styled))).not.toContain('UNSUPPORTED_CONTEXT');
  });

  it('flags environment, scale and team claims HR did not make', () => {
    const f = form({ experienceMin: 3, experienceMax: 5, mustHaveSkills: ['Python', 'Machine Learning', 'LLM'] });
    const padded = jd({
      responsibilities: [
        'Develop machine learning models in Python and deploy them to production.',
        'Integrate LLM features into existing systems through APIs.',
        'Troubleshoot accuracy and latency issues and work with the product team on fixes.',
      ],
      requirements: ['3-5 years of experience.'],
    });
    const issue = reviewJd(f, padded).find((i) => i.code === 'UNSUPPORTED_CONTEXT')!;
    expect(issue.severity).toBe('error');
    expect(issue.terms).toEqual(
      expect.arrayContaining(['production', 'deployment', 'latency / performance at scale', 'existing systems', 'APIs', 'other teams / stakeholders']),
    );
    expect(isCorrectable(issue)).toBe(true);
    // the same words are fine when HR wrote them
    const said = form({ ...f, shortDescription: 'Deploy models to production, expose them through APIs and keep latency low. Work with the product team on existing systems.' });
    expect(codes(reviewJd(said, padded))).not.toContain('UNSUPPORTED_CONTEXT');
    // ...or when a skill HR named implies them
    const rest = form({ ...f, mustHaveSkills: ['Python', 'REST', 'Docker'] });
    const impliedJd = jd({ responsibilities: ['Build REST APIs in Python and deploy them with Docker.'], requirements: ['3-5 years of experience.'] });
    expect(codes(reviewJd(rest, impliedJd))).not.toContain('UNSUPPORTED_CONTEXT');
  });

  it('flags every duty that comes from no skill, title or additional requirement', () => {
    const f = form({ experienceMin: 3, experienceMax: 5, mustHaveSkills: ['Python', 'Machine Learning', 'LLM'] });
    const grounded = jd({
      summary: 'As an AI Engineer, you will develop machine learning models in Python and build LLM applications.',
      responsibilities: [
        'Develop machine learning models in Python and evaluate the results.',
        'Build applications on large language models and improve their answers.',
      ],
      requirements: ['3-5 years of experience.'],
    });
    expect(reviewJd(f, grounded)).toEqual([]);
    const invented = jd({
      ...grounded,
      responsibilities: [...grounded.responsibilities, 'Evaluate alternative approaches and recommend the best methods to ship.'],
    });
    const issue = reviewJd(f, invented).find((i) => i.code === 'UNGROUNDED_DUTY')!;
    expect(issue.terms).toEqual(['Evaluate alternative approaches and recommend the best methods to ship.']);
    expect(isCorrectable(issue)).toBe(true);
    // a duty taken from HR's additional requirements is grounded
    const fromHr = form({ ...f, shortDescription: 'The person will build chatbots for internal support tickets.' });
    const withHrDuty = jd({ ...grounded, responsibilities: [...grounded.responsibilities, 'Build chatbots that answer internal support tickets.'] });
    expect(codes(reviewJd(fromHr, withHrDuty))).not.toContain('UNGROUNDED_DUTY');
  });

  it('correctable issues and score', () => {
    const issues = reviewJd(form(), jd({ benefits: ['Stock options'], summary: 'A fast-paced role.' }));
    expect(issues.every(isCorrectable)).toBe(true);
    expect(reviewScore(issues)).toBe(11);
  });
});
