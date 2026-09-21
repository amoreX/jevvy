"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Compass,
  Download,
  Leaf,
  LoaderCircle,
  MessageCircle,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Sprout,
  X,
} from "lucide-react";
import {
  MAX_ANSWERS,
  type Answer,
  type Brief,
  type Criterion,
  type Decision,
  type Interview,
  type InterviewInput,
  type Option,
  type Question,
  type Receipt,
} from "@/lib/decision";

type Stage = "start" | "interview" | "review" | "result";
type Pending =
  | { type: "interview"; input: InterviewInput }
  | { type: "decide"; brief: Brief };
const examples = [
  {
    icon: Compass,
    title: "My next career move",
    text: "Help me decide my next career move.",
  },
  {
    icon: Sprout,
    title: "What to learn next",
    text: "Help me decide what to learn next.",
  },
  {
    icon: Leaf,
    title: "Making more time for myself",
    text: "Help me choose how to make more time for myself.",
  },
];

function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? "small" : ""}`} aria-hidden="true">
      <Sparkles size={small ? 18 : 22} strokeWidth={1.7} />
    </span>
  );
}
function cleanBrief(b: Brief): Brief {
  const lines = (v: string[]) => v.map((s) => s.trim()).filter(Boolean);
  return {
    ...b,
    facts: lines(b.facts),
    constraints: lines(b.constraints),
    assumptions: lines(b.assumptions),
    options: b.options.map((o) => ({
      ...o,
      benefits: lines(o.benefits),
      tradeoffs: lines(o.tradeoffs),
      unknowns: lines(o.unknowns),
    })),
  };
}

export default function Picks() {
  const [stage, setStage] = useState<Stage>("start");
  const [goal, setGoal] = useState("");
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState("");
  const [brief, setBrief] = useState<Brief | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const resetDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/config", { signal: abort.signal })
      .then((r) => r.json())
      .then((d) => setConfigured(d.configured === true))
      .catch(() => {});
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (stage !== "start" && !loading) heading.current?.focus();
  }, [stage, question, loading]);
  useEffect(() => {
    if (confirmReset) resetDialog.current?.showModal();
    else resetDialog.current?.close();
  }, [confirmReset]);

  async function run(task: Pending) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setPending(task);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/${task.type === "interview" ? "interview" : "decide"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            task.type === "interview" ? task.input : task.brief,
          ),
          signal: abort.signal,
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Something went wrong. Please retry.");
      if (controller.current !== abort || abort.signal.aborted) return;
      if (task.type === "interview") {
        const next = data as Interview & { receipt: Receipt };
        setReceipts((r) => [...r, next.receipt]);
        setAnswer("");
        if (next.brief) {
          setBrief(next.brief);
          setQuestion(null);
          setStage("review");
        } else {
          setQuestion(next.question);
          setStage("interview");
        }
      } else {
        setBrief(task.brief);
        setDecision(data);
        setStage("result");
      }
      setPending(null);
    } catch (err) {
      if (controller.current !== abort || abort.signal.aborted) return;
      setError(
        err instanceof Error ? err.message : "Could not connect. Please retry.",
      );
    } finally {
      if (controller.current === abort) setLoading(false);
    }
  }
  function start(e: FormEvent) {
    e.preventDefault();
    if (!goal.trim() || loading) return;
    setStage("interview");
    void run({
      type: "interview",
      input: { goal: goal.trim(), answers: [], prepare: false },
    });
  }
  function respond(e: FormEvent) {
    e.preventDefault();
    if (!question || !answer.trim() || loading) return;
    const updated = [
      ...answers,
      { question: question.text, answer: answer.trim() },
    ];
    setAnswers(updated);
    setQuestion(null);
    void run({
      type: "interview",
      input: { goal, answers: updated, prepare: updated.length >= MAX_ANSWERS },
    });
  }
  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setLoading(false);
    setError(
      "Request stopped. Retry when you’re ready. A request already processed by the provider may still be charged.",
    );
  }
  function reset() {
    controller.current?.abort();
    controller.current = null;
    setStage("start");
    setGoal("");
    setAnswers([]);
    setQuestion(null);
    setAnswer("");
    setBrief(null);
    setDecision(null);
    setPending(null);
    setError("");
    setLoading(false);
    setReceipts([]);
    setConfirmReset(false);
  }
  function editAnswer(index: number) {
    controller.current?.abort();
    controller.current = null;
    setLoading(false);
    setPending(null);
    setError("");
    setBrief(null);
    setDecision(null);
    setQuestion({
      text: answers[index].question,
      context:
        "Update this answer. The following questions and options will be rebuilt.",
      suggestions: [],
    });
    setAnswer(answers[index].answer);
    setAnswers(answers.slice(0, index));
    setStage("interview");
  }
  function exportDecision() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            goal,
            answers,
            brief,
            decision,
            interviewReceipts: receipts,
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "jev-picks-decision.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  const activeStep = stage === "review" ? 2 : stage === "result" ? 3 : 1;

  return (
    <div className="app-shell">
      <header className="site-header">
        <button
          className="brand"
          aria-label="Jev Picks home"
          onClick={() => {
            if (stage !== "start") setConfirmReset(true);
          }}
        >
          <Mark />
          <span>
            jev<span className="brand-light"> picks</span>
            <span className="brand-dot">.</span>
          </span>
        </button>
        <span className="header-note">
          <span className="status-dot" /> A little perspective goes a long way
        </span>
        {stage !== "start" ? (
          <button
            className="button subtle compact"
            onClick={() => setConfirmReset(true)}
          >
            <Plus size={16} /> New decision
          </button>
        ) : (
          <a className="how-link" href="#how-it-works">
            How it works <ArrowUpRight size={15} />
          </a>
        )}
      </header>

      <main id="main-content">
        {stage === "start" ? (
          <div className="landing">
            <div className="eyebrow">
              <span className="tiny-flower">✳</span> LESS OVERTHINKING. MORE
              FORWARD.
            </div>
            <h1>
              A little clarity.
              <br />
              <em>A better next step.</em>
            </h1>
            <p className="hero-description">
              Big crossroads or everyday choices. Talk it through,
              <br className="desktop-break" /> find your options, and see what
              fits you.
            </p>
            <form className="start-card" onSubmit={start}>
              <label htmlFor="goal">Help me with…</label>
              <textarea
                id="goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={2000}
                placeholder="The decision that’s been on your mind"
                rows={3}
                required
              />
              <div className="start-actions">
                <span>
                  <MessageCircle size={15} /> Start anywhere. We’ll ask the
                  right questions.
                </span>
                <button
                  className="button primary"
                  disabled={!goal.trim() || configured === false}
                >
                  Let’s figure it out <ArrowRight size={17} />
                </button>
              </div>
            </form>
            {configured === false && (
              <div className="notice" role="status">
                One setup step: add OPENROUTER_API_KEY to{" "}
                <code>jev-picks/.env.local</code> and restart the app.
              </div>
            )}
            <div className="examples">
              <p>NEED A STARTING POINT?</p>
              <div className="example-grid">
                {examples.map(({ icon: Icon, title, text }) => (
                  <button
                    key={title}
                    onClick={() => {
                      setGoal(text);
                      document.getElementById("goal")?.focus();
                    }}
                  >
                    <Icon size={20} strokeWidth={1.5} />
                    <span>{title}</span>
                    <ArrowUpRight size={15} />
                  </button>
                ))}
              </div>
            </div>
            <section
              className="how-section"
              id="how-it-works"
              aria-label="How it works"
            >
              <div>
                <span className="step-number">01</span>
                <h2>Talk it through</h2>
                <p>Sonnet asks a few thoughtful questions, one at a time.</p>
              </div>
              <div>
                <span className="step-number">02</span>
                <h2>Make it yours</h2>
                <p>Review the options and what matters. Change anything.</p>
              </div>
              <div>
                <span className="step-number">03</span>
                <h2>Find your pick</h2>
                <p>Jev weighs your options, with scores you can explore.</p>
              </div>
            </section>
          </div>
        ) : (
          <div className="workspace">
            <nav className="steps" aria-label="Decision progress">
              {["Talk it through", "Review your options", "Your pick"].map(
                (label, i) => (
                  <div
                    key={label}
                    className={
                      i + 1 === activeStep
                        ? "active"
                        : i + 1 < activeStep
                          ? "complete"
                          : ""
                    }
                    aria-current={i + 1 === activeStep ? "step" : undefined}
                  >
                    <span>
                      {i + 1 < activeStep ? <Check size={13} /> : `0${i + 1}`}
                    </span>
                    {label}
                  </div>
                ),
              )}
            </nav>
            <div className="workspace-grid">
              <aside className="context-panel">
                <p className="eyebrow">YOUR DECISION</p>
                <p className="context-goal">{goal}</p>
                {answers.length > 0 && (
                  <div className="answer-history">
                    <p className="eyebrow">WHAT YOU’VE SHARED</p>
                    {answers.map((a, i) => (
                      <details key={`${i}-${a.question}`}>
                        <summary>
                          <span>{a.question}</span>
                          <ChevronDown size={14} />
                        </summary>
                        <p>{a.answer}</p>
                        <button
                          disabled={loading}
                          onClick={() => editAnswer(i)}
                        >
                          Edit answer <ArrowUpRight size={12} />
                        </button>
                      </details>
                    ))}
                  </div>
                )}
                <div className="side-note">
                  <Sprout size={22} strokeWidth={1.4} />
                  <p>
                    You bring the context.
                    <br />
                    We help you see the possibilities.
                  </p>
                </div>
              </aside>

              <div className="main-panel">
                {stage === "interview" && (
                  <>
                    <div className="section-topline">
                      <span className="tag">
                        <MessageCircle size={13} /> WITH SONNET 5
                      </span>
                      <span className="muted small-text">
                        {answers.length} of up to 5 answers
                      </span>
                    </div>
                    {question && !loading && (
                      <form className="question-card" onSubmit={respond}>
                        <h1 ref={heading} tabIndex={-1}>
                          {question.text}
                        </h1>
                        <p className="question-context">{question.context}</p>
                        <div className="suggestions">
                          {question.suggestions.map((s) => (
                            <button
                              type="button"
                              className={answer === s ? "selected" : ""}
                              key={s}
                              onClick={() => setAnswer(s)}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                        <label className="field-label" htmlFor="answer">
                          Your answer
                        </label>
                        <textarea
                          id="answer"
                          rows={4}
                          value={answer}
                          maxLength={3000}
                          onChange={(e) => setAnswer(e.target.value)}
                          placeholder="Tell us a little more, in your own words…"
                          required
                        />
                        <div className="question-actions">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setAnswer("I’m not sure yet.")}
                          >
                            I’m not sure
                          </button>
                          <button
                            className="button primary"
                            disabled={!answer.trim()}
                          >
                            Continue <ArrowRight size={17} />
                          </button>
                        </div>
                        {answers.length > 0 && (
                          <button
                            type="button"
                            className="prepare-button"
                            onClick={() => {
                              setQuestion(null);
                              void run({
                                type: "interview",
                                input: { goal, answers, prepare: true },
                              });
                            }}
                          >
                            I’ve shared enough. Show my options{" "}
                            <ArrowRight size={14} />
                          </button>
                        )}
                      </form>
                    )}
                  </>
                )}

                {stage === "review" && brief && (
                  <>
                    <span className="tag">
                      <SlidersHorizontal size={13} /> YOUR CALL, BEFORE THE PICK
                    </span>
                    <h1 ref={heading} tabIndex={-1}>
                      Does this feel like you?
                    </h1>
                    <p className="section-description">
                      Check the details, adjust your priorities, and make these
                      options your own.
                    </p>
                    <Review
                      brief={brief}
                      onChange={(updated) => {
                        setBrief(updated);
                        setPending(null);
                        setError("");
                      }}
                      disabled={loading}
                    />
                    <div className="review-actions">
                      <span>
                        {brief.options.filter((o) => o.eligible).length < 2
                          ? "Include at least two options to compare."
                          : `Jev will compare ${brief.options.filter((o) => o.eligible).length} options.`}
                      </span>
                      <button
                        className="button primary"
                        disabled={
                          loading ||
                          brief.options.filter((o) => o.eligible).length < 2
                        }
                        onClick={() => {
                          const cleaned = cleanBrief(brief);
                          setBrief(cleaned);
                          void run({ type: "decide", brief: cleaned });
                        }}
                      >
                        <Sparkles size={16} /> Let Jev choose{" "}
                        <ArrowRight size={17} />
                      </button>
                    </div>
                  </>
                )}

                {stage === "result" && brief && decision && (
                  <>
                    <span className="tag">
                      <Sparkles size={13} /> A LITTLE MORE CLARITY
                    </span>
                    <h1 ref={heading} tabIndex={-1}>
                      Here’s your next step.
                    </h1>
                    <Results brief={brief} decision={decision} />
                    <div className="result-actions">
                      <button
                        className="button secondary"
                        onClick={() => {
                          setDecision(null);
                          setError("");
                          setStage("review");
                        }}
                      >
                        <ArrowLeft size={16} /> Revisit your options
                      </button>
                      <button
                        className="button subtle"
                        onClick={exportDecision}
                      >
                        <Download size={16} /> Save decision
                      </button>
                    </div>
                  </>
                )}

                {loading && (
                  <div className="loading-card" role="status">
                    <span className="loading-symbol">
                      <LoaderCircle size={26} className="spin" />
                    </span>
                    <h2>
                      {pending?.type === "decide"
                        ? "Weighing what matters to you…"
                        : pending?.type === "interview" &&
                            (pending.input.prepare ||
                              pending.input.answers.length >= 3)
                          ? "Connecting the dots…"
                          : "A little thought, a better question…"}
                    </h2>
                    <p>
                      {pending?.type === "decide"
                        ? "Jev is comparing your options and building your scorecard."
                        : "Sonnet is reading your context. This can take a moment."}
                    </p>
                    <button className="text-button" onClick={cancel}>
                      Stop request
                    </button>
                  </div>
                )}
                {error && (
                  <div className="error-card" role="alert">
                    <p>{error}</p>
                    <div>
                      {pending && (
                        <button
                          className="button secondary compact"
                          onClick={() => void run(pending)}
                        >
                          <RotateCcw size={14} /> Retry request
                        </button>
                      )}
                      {!question &&
                        stage === "interview" &&
                        answers.length === 0 && (
                          <button className="text-button" onClick={reset}>
                            Back to your decision
                          </button>
                        )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
      <footer className="site-footer">
        <span>Thoughtful questions. Clearer choices.</span>
        <span>
          Powered by Sonnet & Jev<span className="footer-dot">·</span>Made for
          your next step
        </span>
      </footer>
      <p className="privacy-note">
        Your answers are sent to OpenRouter’s model providers to generate a
        response. This app doesn’t save them; refreshing clears your session.
      </p>
      <dialog
        ref={resetDialog}
        className="reset-modal"
        aria-labelledby="reset-title"
        onCancel={() => setConfirmReset(false)}
        onClose={() => setConfirmReset(false)}
      >
        <button
          className="modal-close"
          aria-label="Close"
          onClick={() => setConfirmReset(false)}
        >
          <X size={18} />
        </button>
        <Mark />
        <h2 id="reset-title">A fresh start?</h2>
        <p>
          This clears your current decision and answers. Save your result first
          if you’d like to keep it.
        </p>
        <div>
          <button
            autoFocus
            className="button secondary"
            onClick={() => setConfirmReset(false)}
          >
            Keep working
          </button>
          <button className="button primary" onClick={reset}>
            Start fresh
          </button>
        </div>
      </dialog>
    </div>
  );
}

function Lines({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <label className="edit-field">
      {label}
      <textarea
        rows={Math.max(2, Math.min(5, value.length + 1))}
        value={value.join("\n")}
        onChange={(e) => onChange(e.target.value.split("\n"))}
        placeholder="One item per line"
        maxLength={6000}
      />
    </label>
  );
}
function Review({
  brief,
  onChange,
  disabled,
}: {
  brief: Brief;
  onChange: (b: Brief) => void;
  disabled: boolean;
}) {
  const changeOption = (index: number, patch: Partial<Option>) =>
    onChange({
      ...brief,
      options: brief.options.map((o, i) =>
        i === index ? { ...o, ...patch } : o,
      ),
    });
  const changeCriterion = (index: number, patch: Partial<Criterion>) =>
    onChange({
      ...brief,
      criteria: brief.criteria.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  return (
    <fieldset className="review-fieldset" disabled={disabled}>
      <section className="brief-card">
        <div className="card-heading">
          <span className="eyebrow">THE BIG PICTURE</span>
          <span className="small-text muted">
            Prepared by Sonnet · editable by you
          </span>
        </div>
        <p className="brief-objective">{brief.objective}</p>
        <div className="brief-columns">
          <FactList
            title="What we know"
            items={brief.facts}
            empty="No additional facts supplied."
          />
          <FactList
            title="Your non-negotiables"
            items={brief.constraints}
            empty="No hard limits specified."
          />
        </div>
        {brief.assumptions.length > 0 && (
          <div className="assumptions">
            <FactList title="Assumptions to check" items={brief.assumptions} />
          </div>
        )}
        <details className="edit-details">
          <summary>
            <SlidersHorizontal size={14} /> Edit the brief{" "}
            <ChevronDown size={14} />
          </summary>
          <label className="edit-field">
            Your decision
            <textarea
              value={brief.objective}
              onChange={(e) =>
                onChange({ ...brief, objective: e.target.value })
              }
              maxLength={1800}
            />
          </label>
          <Lines
            label="User-provided facts"
            value={brief.facts}
            onChange={(facts) => onChange({ ...brief, facts })}
          />
          <Lines
            label="Hard constraints"
            value={brief.constraints}
            onChange={(constraints) => onChange({ ...brief, constraints })}
          />
          <Lines
            label="Unverified assumptions"
            value={brief.assumptions}
            onChange={(assumptions) => onChange({ ...brief, assumptions })}
          />
        </details>
      </section>
      <section className="priorities-section">
        <div className="section-label">
          <h2>What matters most</h2>
          <span>Set your priorities</span>
        </div>
        <div className="priority-list">
          {brief.criteria.map((c, i) => (
            <div className="priority-card" key={c.id}>
              <div>
                <span className="priority-index">0{i + 1}</span>
                <strong>{c.name}</strong>
                <select
                  aria-label={`Priority for ${c.name}`}
                  value={c.importance}
                  onChange={(e) =>
                    changeCriterion(i, {
                      importance: e.target.value as Criterion["importance"],
                    })
                  }
                >
                  <option value="high">High priority</option>
                  <option value="medium">Medium priority</option>
                  <option value="low">Low priority</option>
                </select>
              </div>
              <details>
                <summary>
                  View & edit scoring scale <ChevronDown size={13} />
                </summary>
                <label className="edit-field">
                  Criterion name
                  <input
                    value={c.name}
                    maxLength={100}
                    onChange={(e) =>
                      changeCriterion(i, { name: e.target.value })
                    }
                  />
                </label>
                {c.levels.map((level, j) => (
                  <label className="level-edit" key={j}>
                    <span>{j}</span>
                    <textarea
                      rows={2}
                      aria-label={`${c.name} level ${j}`}
                      value={level}
                      maxLength={1800}
                      onChange={(e) =>
                        changeCriterion(i, {
                          levels: c.levels.map((l, k) =>
                            k === j ? e.target.value : l,
                          ),
                        })
                      }
                    />
                  </label>
                ))}
              </details>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="section-label">
          <h2>Your possible paths</h2>
          <span>{brief.options.length} options to consider</span>
        </div>
        <div className="options-grid">
          {brief.options.map((o, i) => (
            <article
              className={`option-card ${!o.eligible ? "excluded" : ""}`}
              key={o.id}
            >
              <div className="option-top">
                <span className="option-letter">
                  {String.fromCharCode(65 + i)}
                </span>
                <label className="include-toggle">
                  <input
                    type="checkbox"
                    checked={o.eligible}
                    onChange={(e) =>
                      changeOption(i, { eligible: e.target.checked })
                    }
                  />{" "}
                  Include in pick
                </label>
              </div>
              <h3>{o.title}</h3>
              <p>{o.description}</p>
              <FactList title="The upside" items={o.benefits} />
              <FactList title="The tradeoff" items={o.tradeoffs} />
              <FactList title="Still unknown" items={o.unknowns} />
              {!o.eligible && (
                <p className="exclusion-note">
                  Excluded:{" "}
                  {o.exclusionReason ||
                    "You’ve left this option out of the comparison."}
                </p>
              )}
              <details className="edit-details">
                <summary>
                  Edit option <ChevronDown size={14} />
                </summary>
                <label className="edit-field">
                  Title
                  <input
                    value={o.title}
                    maxLength={120}
                    onChange={(e) => changeOption(i, { title: e.target.value })}
                  />
                </label>
                <label className="edit-field">
                  Description
                  <textarea
                    value={o.description}
                    maxLength={1800}
                    onChange={(e) =>
                      changeOption(i, { description: e.target.value })
                    }
                  />
                </label>
                <Lines
                  label="Benefits"
                  value={o.benefits}
                  onChange={(benefits) => changeOption(i, { benefits })}
                />
                <Lines
                  label="Tradeoffs"
                  value={o.tradeoffs}
                  onChange={(tradeoffs) => changeOption(i, { tradeoffs })}
                />
                <Lines
                  label="Unknowns"
                  value={o.unknowns}
                  onChange={(unknowns) => changeOption(i, { unknowns })}
                />
                <label className="edit-field">
                  Practical next step
                  <textarea
                    value={o.nextStep}
                    maxLength={1800}
                    onChange={(e) =>
                      changeOption(i, { nextStep: e.target.value })
                    }
                  />
                </label>
                <label className="edit-field">
                  Exclusion reason
                  <input
                    value={o.exclusionReason}
                    maxLength={500}
                    onChange={(e) =>
                      changeOption(i, { exclusionReason: e.target.value })
                    }
                  />
                </label>
                {brief.options.length > 2 && (
                  <button
                    className="text-button danger-text"
                    onClick={() =>
                      onChange({
                        ...brief,
                        options: brief.options.filter((_, j) => i !== j),
                      })
                    }
                  >
                    Remove this option
                  </button>
                )}
              </details>
            </article>
          ))}
        </div>
        {brief.options.length < 5 && (
          <button
            className="add-option"
            onClick={() =>
              onChange({
                ...brief,
                options: [
                  ...brief.options,
                  {
                    id: `custom_${Date.now()}`,
                    title: "My own option",
                    description: "Describe your alternative here.",
                    benefits: [],
                    tradeoffs: [],
                    unknowns: [],
                    nextStep: "Define a first step for this option.",
                    eligible: false,
                    exclusionReason:
                      "Fill in this option’s details, then include it in the pick.",
                  },
                ],
              })
            }
          >
            <Plus size={16} /> Add your own option
          </button>
        )}
      </section>
    </fieldset>
  );
}
function FactList({
  title,
  items,
  empty,
}: {
  title: string;
  items: string[];
  empty?: string;
}) {
  if (!items.length && !empty) return null;
  return (
    <div className="fact-list">
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </div>
  );
}
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}
function Results({ brief, decision }: { brief: Brief; decision: Decision }) {
  const selected = brief.options.find((o) => o.id === decision.choice)!;
  const options = brief.options.filter((o) => o.eligible);
  const probabilities = decision.probabilities;
  return (
    <div className="results">
      <section className="winner-card">
        <div className="winner-top">
          <span>
            <Sparkles size={15} /> JEV’S PICK
          </span>
          <span>Based on your reviewed brief</span>
        </div>
        <h2>{selected.title}</h2>
        <p>{selected.description}</p>
        <div className="winner-metrics">
          <Metric label="Choice probability">
            {probabilities
              ? `${Math.round(probabilities[selected.id] * 100)}%`
              : "Not returned"}
          </Metric>
          <Metric label="Model confidence">
            {decision.confidence !== undefined
              ? `${Math.round(decision.confidence * 100)}%`
              : "Not returned"}
          </Metric>
          <Metric label="Options considered">{options.length}</Metric>
        </div>
      </section>
      <p className="score-explainer">
        Probabilities describe Jev’s choice among these options. Confidence
        describes how concentrated its answer is. Neither is a forecast of
        real-world success.
      </p>
      <section className="next-step">
        <span>
          <ArrowUpRight size={21} />
        </span>
        <div>
          <p className="eyebrow">ONE SMALL NEXT STEP</p>
          <p>{selected.nextStep}</p>
        </div>
      </section>
      <div className="result-tradeoffs">
        <FactList title="What this path offers" items={selected.benefits} />
        <FactList title="What you’re trading off" items={selected.tradeoffs} />
      </div>
      {(selected.unknowns.length > 0 || brief.assumptions.length > 0) && (
        <div className="assumptions">
          <FactList
            title="Before you act, check these"
            items={[...selected.unknowns, ...brief.assumptions]}
          />
        </div>
      )}
      <p className="attribution">
        Descriptions and next steps come from the brief you reviewed. The choice
        and scores below are Jev’s responses.
      </p>
      <section className="score-section">
        <div className="section-label">
          <h2>See how the options compare</h2>
          <span>Jev’s scorecard</span>
        </div>
        <p className="small-text muted">
          Scores run from 0 to 4 on your shared descriptive scales. Higher means
          a better fit for that criterion. Each score is a separate judgment;
          the pick isn’t a calculated average.
        </p>
        <div
          className="table-scroll"
          tabIndex={0}
          role="region"
          aria-label="Option score comparison"
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Option</th>
                {brief.criteria.map((c) => (
                  <th scope="col" key={c.id}>
                    {c.name}
                    <span>{c.importance} priority</span>
                  </th>
                ))}
                <th scope="col">Choice probability</th>
              </tr>
            </thead>
            <tbody>
              {options.map((o) => (
                <tr
                  className={o.id === selected.id ? "picked-row" : ""}
                  key={o.id}
                >
                  <th scope="row">
                    {o.title}
                    {o.id === selected.id && (
                      <span className="picked-label">
                        <Check size={12} /> Jev’s pick
                      </span>
                    )}
                  </th>
                  {brief.criteria.map((c) => {
                    const rating = decision.scores[o.id][c.id];
                    return (
                      <td key={c.id}>
                        <span className="score-value">
                          {rating.score.toFixed(1)}
                          <small> / 4</small>
                        </span>
                        <span className="score-track">
                          <span
                            style={{ width: `${(rating.score / 4) * 100}%` }}
                          />
                        </span>
                      </td>
                    );
                  })}
                  <td>
                    <span className="score-value">
                      {probabilities
                        ? `${Math.round(probabilities[o.id] * 100)}%`
                        : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="scale-details">
          <summary>
            Explore the scales & score confidence <ChevronDown size={16} />
          </summary>
          {brief.criteria.map((c) => (
            <div className="scale-block" key={c.id}>
              <h3>{c.name}</h3>
              <ol start={0}>
                {c.levels.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ol>
              <div className="score-confidence">
                {options.map((o) => {
                  const r = decision.scores[o.id][c.id];
                  return (
                    <div key={o.id}>
                      <strong>{o.title}</strong>
                      <span>
                        Score {r.score.toFixed(2)} · Confidence{" "}
                        {r.confidence !== undefined
                          ? `${Math.round(r.confidence * 100)}%`
                          : "not returned"}
                      </span>
                      {r.probabilities && (
                        <span className="level-probabilities">
                          Level probabilities:{" "}
                          {Object.entries(r.probabilities)
                            .map(
                              ([level, p]) =>
                                `${level}: ${Math.round(p * 100)}%`,
                            )
                            .join(" · ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </details>
      </section>
      <div className="receipt">
        <span>{decision.receipt.model}</span>
        <span>
          {(decision.receipt.latencyMs / 1000).toFixed(1)}s ·{" "}
          {decision.receipt.cost === null
            ? "Cost not reported"
            : `$${decision.receipt.cost.toFixed(6)} reported for this evaluation`}
        </span>
      </div>
    </div>
  );
}
