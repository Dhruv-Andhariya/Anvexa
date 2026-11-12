'use client';

import {
  QUESTION_KINDS,
  ROUND_TYPES,
  ROUNDS_LIMITS,
  type PassMode,
  type QuestionKind,
  type RoundType,
} from '@hireflow/contracts';
import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { HR_ROUND_TYPES, PASS_MODES, messagesUnder, move, newQuestion, passMarkHint, passMarkMax, passMarkProblem, roundTypeLabel, type RoundDraft, type Validation } from '@/lib/rounds';
import { changePassRule } from '@/lib/rounds-api';
import { Button, Spinner, inputClass } from '../ui';
import { AiGeneratePanel } from './ai-generate-panel';
import { CodingAuthorPanel } from './coding-author-panel';
import { CodingPlan } from './coding-plan';
import { InterviewProtectionSettings } from './interview-protection-settings';
import { QuestionEditor } from './question-editor';
import { RoundSkipButton, SkippedNote } from './round-skip';

const KIND_KEYS = Object.keys(QUESTION_KINDS) as QuestionKind[];

/** One assessment round: name, type, description, time limit, passing criterion and its questions. */
export function RoundCard({
  jobId,
  round,
  index,
  count,
  validation,
  disabled,
  locked = false,
  expanded,
  onToggle,
  onChange,
  onMove,
  onRemove,
  onSkipped,
}: {
  jobId: string;
  round: RoundDraft;
  index: number;
  count: number;
  validation: Validation | null;
  disabled: boolean;
  /** The rounds are locked (students started): only the passing criterion can change, saved on its own. */
  locked?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (r: RoundDraft) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  /** Skip / Undo skip is saved on the server at once (not part of the unsaved edits). */
  onSkipped: (skipped: RoundDraft['skipped'], message: string) => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  // DSA coding round: every question is a coding problem (no type to choose); AI or HR's file add problems with tests
  const codingRound = round.type === 'CODING';
  // SQL round: every question is a coding question (one SQL query), so no question type is offered
  const sqlRound = round.type === 'SQL';
  const [codingPanel, setCodingPanel] = useState<'ai' | 'upload' | null>(null);
  // HR's plan for a coding round: how many problems (each problem's marks are set in its own section, CodingPlan)
  const wholeOrNull = (v: string | undefined, max: number) => {
    const n = Number(v);
    return v && Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };
  const targetText = round.targetCount ?? ((codingRound || sqlRound) && round.questions.length ? String(round.questions.length) : '');
  const target = wholeOrNull(targetText, 50);
  const room = Math.max(0, ((codingRound || sqlRound) && target ? target : ROUNDS_LIMITS.questionsMax) - round.questions.length);
  const [addKind, setAddKind] = useState<QuestionKind>(ROUND_TYPES[round.type].kinds[0]!);
  const set = (patch: Partial<RoundDraft>) => onChange({ ...round, ...patch });
  const path = `rounds.${index}`;
  const errorsOf = (field: string) => (validation?.fields[`${path}.${field}`] ?? []).join(' ');
  const problemCount = validation ? messagesUnder(validation, path).length : 0;
  const id = `round-${round.key}`;
  const totalMarks = round.questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);

  // locked rounds: HR may still change the passing criterion; it is saved on its own and re-grades the round
  const ruleEditable = locked && !!round.id;
  const ruleDisabled = disabled && !ruleEditable;
  const [savedRule, setSavedRule] = useState({ mode: round.passMode, value: round.passValue, max: round.passMaxScore });
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleMessage, setRuleMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ruleChanged = round.passMode !== savedRule.mode || round.passValue !== savedRule.value || round.passMaxScore !== savedRule.max;
  const passMax = passMarkMax(round);
  const passProblem = passMarkProblem(round);
  const saveRule = async () => {
    if (!round.id || !round.passMode || !round.passValue.trim()) return;
    setRuleBusy(true);
    setRuleMessage(null);
    try {
      const res = await changePassRule(jobId, round.id, {
        mode: round.passMode,
        value: Math.round(Number(round.passValue)),
        maxScore:
          round.passMode === 'INTERVIEWER_SCORE' || (round.passMode === 'MARKS' && round.passMaxScore.trim()) ? Math.round(Number(round.passMaxScore)) : null,
      });
      setSavedRule({ mode: round.passMode, value: round.passValue, max: round.passMaxScore });
      const moved = res.changed.map((c) => `${c.name} (${c.before === 'PASSED' ? 'passed' : 'failed'} → ${c.after === 'PASSED' ? 'passed' : 'failed'}${c.overridden ? ', your override still applies' : ''})`);
      setRuleMessage({
        ok: true,
        text: `Saved. ${res.regraded} result${res.regraded === 1 ? '' : 's'} graded again${moved.length ? `; changed: ${moved.join(', ')}. Nobody is emailed or moved automatically: check them on the Assessments page.` : '; no result changed.'}`,
      });
    } catch (err) {
      setRuleMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Could not save. Please try again.' });
    } finally {
      setRuleBusy(false);
    }
  };

  // Marks: the "out of" total starts as the questions' own total, shown in the box, and HR sets any total they want
  const setMode = (mode: PassMode | '') =>
    set({
      passMode: mode,
      passMaxScore: mode === 'INTERVIEWER_SCORE' ? round.passMaxScore || '10' : mode === 'MARKS' ? round.passMaxScore || (totalMarks ? String(totalMarks) : '') : '',
    });

  // a group discussion is just a step here: everything about it happens on the Group Discussion page
  if (round.type === 'GROUP_DISCUSSION') {
    return (
      <li className="rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 3}</span>
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{round.name || 'Group Discussion'}</span>
            <span className="ml-2 text-muted">AI moderator · groups, results and selection on the Group Discussion page</span>
          </span>
          <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>
            ↑
          </Button>
          <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}>
            ↓
          </Button>
          <Button variant="ghost" className="px-2 py-1 text-danger" aria-label={`Remove ${round.name || 'round'}`} disabled={disabled} onClick={onRemove}>
            Remove
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className={`rounded-lg border bg-surface ${problemCount ? 'border-danger/50' : 'border-border'} ${round.skipped ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{index + 3}</span>
        <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={`${id}-body`} className="min-w-0 flex-1 truncate text-left text-sm font-medium">
          {round.name || <span className="text-muted">Unnamed round</span>}
          <span className="ml-2 font-normal text-muted">
            {roundTypeLabel(round.type)} · {round.questions.length} question{round.questions.length === 1 ? '' : 's'}
            {round.timeLimitMinutes && ` · ${round.timeLimitMinutes} min`}
          </span>
          {problemCount > 0 && <span className="ml-2 text-xs text-danger">⚠ {problemCount} to fix</span>}
        </button>
        <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} up`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>
          ↑
        </Button>
        <Button variant="ghost" className="px-2 py-1" aria-label={`Move ${round.name || 'round'} down`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}>
          ↓
        </Button>
        {/* a saved round can be skipped / brought back at any time, also after students started */}
        {round.id && (
          <RoundSkipButton
            jobId={jobId}
            roundId={round.id}
            roundName={round.name}
            skipped={round.skipped ?? null}
            onChange={(skipped, message) => onSkipped(skipped, message)}
          />
        )}
        <Button variant="ghost" className="px-2 py-1 text-danger" aria-label={`Remove ${round.name || 'round'}`} disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
        <Button variant="ghost" className="px-2 py-1" onClick={onToggle} aria-label={expanded ? 'Collapse round' : 'Expand round'}>
          {expanded ? '▴' : '▾'}
        </Button>
      </div>
      {round.skipped && <SkippedNote skipped={round.skipped} />}

      {expanded && (
        <div id={`${id}-body`} className="flex flex-col gap-4 border-t border-border px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Round name <span className="text-xs font-normal text-muted">(students see this name in the selection process)</span>
              <input
                className={inputClass}
                value={round.name}
                maxLength={ROUNDS_LIMITS.nameMax}
                aria-invalid={!!errorsOf('name')}
                disabled={disabled}
                onChange={(e) => set({ name: e.target.value })}
              />
              {errorsOf('name') && <span className="text-xs text-danger">{errorsOf('name')}</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Round type
              <select className={inputClass} value={round.type} disabled={disabled} onChange={(e) => set({ type: e.target.value as RoundType })}>
                {/* the types HR can choose; a round saved earlier with another type keeps showing its own */}
                {(HR_ROUND_TYPES.includes(round.type) ? HR_ROUND_TYPES : [...HR_ROUND_TYPES, round.type]).map((t) => (
                  <option key={t} value={t}>
                    {roundTypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm font-medium">
            Description <span className="text-xs font-normal text-muted">(optional, private)</span>
            <textarea
              rows={2}
              className={inputClass}
              value={round.description}
              maxLength={ROUNDS_LIMITS.descriptionMax}
              disabled={disabled}
              onChange={(e) => set({ description: e.target.value })}
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm font-medium">
              Time limit (minutes)
              <input
                type="number"
                min={1}
                max={ROUNDS_LIMITS.timeLimitMaxMinutes}
                placeholder="No limit"
                className={inputClass}
                value={round.timeLimitMinutes}
                aria-invalid={!!errorsOf('timeLimitMinutes')}
                disabled={disabled}
                onChange={(e) => set({ timeLimitMinutes: e.target.value })}
              />
              {errorsOf('timeLimitMinutes') && <span className="text-xs text-danger">{errorsOf('timeLimitMinutes')}</span>}
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Passing criterion
              <select className={inputClass} value={round.passMode} disabled={ruleDisabled || ruleBusy} onChange={(e) => setMode(e.target.value as PassMode | '')}>
                <option value="">Choose…</option>
                {PASS_MODES.map((m) => (
                  <option key={m.mode} value={m.mode}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {round.passMode && (
              <div className="flex flex-col gap-1 text-sm font-medium">
                <label htmlFor={`${id}-pass`}>Pass mark</label>
                <div className="flex items-center gap-2">
                  <input
                    id={`${id}-pass`}
                    type="number"
                    min={1}
                    max={passMax ?? undefined}
                    step={1}
                    placeholder={passMax ? `1–${passMax}` : undefined}
                    className={`${inputClass} w-24`}
                    value={round.passValue}
                    aria-invalid={!!errorsOf('passRule.value') || (!!round.passValue.trim() && !!passProblem)}
                    disabled={ruleDisabled || ruleBusy}
                    onChange={(e) => set({ passValue: e.target.value })}
                  />
                  {round.passMode === 'MARKS' ? (
                    <label className="flex shrink-0 items-center gap-2 whitespace-nowrap font-normal text-muted">
                      out of
                      <input
                        type="number"
                        min={1}
                        max={ROUNDS_LIMITS.totalMarksMax}
                        aria-label="Total marks of the round"
                        placeholder={String(totalMarks || 'total')}
                        title="The round's total marks: any number you want (students' marks are scaled to it)"
                        className={`${inputClass} w-28`}
                        value={round.passMaxScore}
                        disabled={ruleDisabled || ruleBusy}
                        onChange={(e) => set({ passMaxScore: e.target.value })}
                      />
                      marks
                    </label>
                  ) : round.passMode === 'INTERVIEWER_SCORE' ? (
                    <label className="flex items-center gap-2 font-normal text-muted">
                      out of
                      <input
                        type="number"
                        min={1}
                        max={ROUNDS_LIMITS.interviewerScoreMax}
                        aria-label="Maximum interviewer score"
                        className={`${inputClass} w-20`}
                        value={round.passMaxScore}
                        disabled={ruleDisabled || ruleBusy}
                        onChange={(e) => set({ passMaxScore: e.target.value })}
                      />
                    </label>
                  ) : (
                    <span className="font-normal text-muted">{passMarkHint(round)}</span>
                  )}
                </div>
                {errorsOf('passRule.value') || errorsOf('passRule.maxScore') ? (
                  <span className="text-xs text-danger">{[errorsOf('passRule.value'), errorsOf('passRule.maxScore')].filter(Boolean).join(' ')}</span>
                ) : (
                  round.passValue.trim() && passProblem && <span className="text-xs text-danger">{passProblem}</span>
                )}
              </div>
            )}
            {ruleEditable && (ruleChanged || ruleMessage) && (
              <div className="flex flex-col gap-2 sm:col-span-3">
                {ruleChanged && (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="primary" disabled={ruleBusy || !!passProblem} onClick={() => void saveRule()}>
                      {ruleBusy && <Spinner />} Save passing criterion
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={ruleBusy}
                      onClick={() => {
                        set({ passMode: savedRule.mode, passValue: savedRule.value, passMaxScore: savedRule.max });
                        setRuleMessage(null);
                      }}
                    >
                      Undo
                    </Button>
                    <span className="text-xs text-muted">
                      {passProblem
                        ? `Fix the pass mark first${passMax ? ` (1 to ${passMax})` : ''}.`
                        : 'Students already took this round: their results are graded again with the new criterion.'}
                    </span>
                  </div>
                )}
                {ruleMessage && (
                  <p role="status" className={`text-xs ${ruleMessage.ok ? 'text-success' : 'text-danger'}`}>
                    {ruleMessage.text}
                  </p>
                )}
              </div>
            )}
          </div>

          {round.type === 'AI_INTERVIEW' && <InterviewProtectionSettings jobId={jobId} roundId={round.id} readOnly={disabled} />}

          {(codingRound || sqlRound) && (
            <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2" disabled={disabled}>
              <legend className="px-1 text-sm font-semibold">Problems in this round</legend>
              <label className="flex flex-col gap-1 text-sm font-medium">
                Number of questions
                <input
                  type="number"
                  min={1}
                  max={50}
                  placeholder="e.g. 3"
                  className={inputClass}
                  value={targetText}
                  aria-invalid={!!targetText && !target}
                  onChange={(e) => set({ targetCount: e.target.value })}
                />
                {targetText && !target && <span className="text-xs text-danger">A whole number from 1 to 50.</span>}
              </label>
              <div className="flex flex-col justify-end gap-0.5 text-sm">
                <span className="font-medium">Total: {totalMarks} marks</span>
                <span className={`text-xs ${target && round.questions.length !== target ? 'text-danger' : 'text-muted'}`}>
                  {target
                    ? round.questions.length < target
                      ? `${round.questions.length} of ${target} added: add ${target - round.questions.length} more`
                      : round.questions.length > target
                        ? `${round.questions.length - target} more than planned: remove some or raise the number`
                        : `All ${target} added`
                    : `${round.questions.length} added`}
                </span>
              </div>
              <CodingPlan jobId={jobId} variant={sqlRound ? 'sql' : 'dsa'} round={round} target={target} marksEach={null} disabled={disabled} onChange={onChange} />
            </fieldset>
          )}

          <section aria-label="Questions" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">
                Questions <span className="font-normal text-muted">({round.questions.length} · {totalMarks} marks)</span>
              </h4>
              {!disabled && (
                codingRound ? (
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => {
                        const q = newQuestion('CODING');
                        set({ questions: [...round.questions, q] });
                      }}
                      disabled={room <= 0}
                    >
                      + Add question
                    </Button>
                    <Button onClick={() => setCodingPanel('ai')} disabled={codingPanel !== null || room <= 0}>
                      ✨ Generate with AI
                    </Button>
                    <Button onClick={() => setCodingPanel('upload')} disabled={codingPanel !== null || room <= 0}>
                      ⬆ Upload PDF / Word / CSV
                    </Button>
                  </span>
                ) : (
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {/* SQL rounds are coding only: every question is one SQL query, so there is no type to choose */}
                    {!sqlRound && (
                      <select aria-label="Question type to add" className="rounded-md border border-border bg-surface px-2 py-1.5 text-sm" value={addKind} onChange={(e) => setAddKind(e.target.value as QuestionKind)}>
                        {KIND_KEYS.map((k) => (
                          <option key={k} value={k}>
                            {QUESTION_KINDS[k].label}
                          </option>
                        ))}
                      </select>
                    )}
                    <Button onClick={() => set({ questions: [...round.questions, newQuestion(sqlRound ? 'CODING' : addKind)] })} disabled={round.questions.length >= ROUNDS_LIMITS.questionsMax}>
                      + Add question
                    </Button>
                    <Button onClick={() => setAiOpen(true)} disabled={aiOpen || round.questions.length >= ROUNDS_LIMITS.questionsMax}>
                      ✨ Generate with AI
                    </Button>
                  </span>
                )
              )}
            </div>

            {codingRound && codingPanel && (
              <CodingAuthorPanel
                jobId={jobId}
                round={round}
                mode={codingPanel}
                room={room}
                marksEach={null}
                onClose={() => setCodingPanel(null)}
                // "Marks per question" then shows the common value only while every problem has the same marks
                onAdd={(qs) => set({ marksEach: undefined, questions: [...round.questions, ...qs].slice(0, ROUNDS_LIMITS.questionsMax) })}
              />
            )}

            {aiOpen && !codingRound && (
              <AiGeneratePanel
                jobId={jobId}
                round={round}
                onClose={() => setAiOpen(false)}
                onAdd={(qs) => set({ questions: [...round.questions, ...qs].slice(0, ROUNDS_LIMITS.questionsMax) })}
              />
            )}

            {round.questions.length === 0 ? (
              <p className="text-sm text-muted">
                {round.passMode === 'INTERVIEWER_SCORE'
                  ? 'Optional for interview rounds: add the questions the interviewer should ask.'
                  : codingRound
                    ? 'No coding problems yet. Write your own, generate them with AI, or upload a PDF, Word or CSV file.'
                    : 'No questions yet. Add your own or generate them with AI.'}
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {round.questions.map((q, j) => (
                  <QuestionEditor
                    key={q.key}
                    q={q}
                    index={j}
                    count={round.questions.length}
                    path={`${path}.questions.${j}`}
                    validation={validation}
                    disabled={disabled}
                    onChange={(next) => set({ questions: round.questions.map((x, k) => (k === j ? next : x)) })}
                    onMove={(to) => set({ questions: move(round.questions, j, to) })}
                    onRemove={() => set({ questions: round.questions.filter((_, k) => k !== j) })}
                  />
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </li>
  );
}
