import { useEffect, useState } from "react";
import {
  ownerKnownLandmines,
  type CreateScenarioResponse,
  type Debrief,
  type DebriefLandmineStatus,
  type DebriefResponse,
  type GeneratedScenario,
  type ProvidersResponse,
  type ScenarioPreset,
} from "@hot-seat/shared";
import { Session, type CameraStill } from "./Session.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; data: ProvidersResponse }
  | { kind: "error"; message: string };

type View =
  | { kind: "home" }
  | { kind: "setup" }
  | { kind: "building"; description: string; startedAt: number }
  | { kind: "buildError"; description: string; message: string }
  | { kind: "briefing"; built: CreateScenarioResponse }
  | { kind: "session"; built: CreateScenarioResponse; runId: number }
  | { kind: "debriefing"; built: CreateScenarioResponse; still: CameraStill | null; sessionId: string | null; startedAt: number }
  | { kind: "debrief"; built: CreateScenarioResponse; data: DebriefResponse; sessionId: string | null }
  | { kind: "debriefError"; built: CreateScenarioResponse; still: CameraStill | null; sessionId: string | null; message: string };

export function App() {
  const [view, setView] = useState<View>({ kind: "home" });
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [description, setDescription] = useState("");
  const [presets, setPresets] = useState<ScenarioPreset[]>([]);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/providers")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server replied ${res.status}`);
        return (await res.json()) as ProvidersResponse;
      })
      .then((data) => { if (!cancelled) setState({ kind: "ok", data }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: "error", message: err instanceof Error ? err.message : "Could not reach the server." });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (view.kind !== "setup") return;
    let cancelled = false;
    fetch("/api/presets")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server replied ${res.status}`);
        return (await res.json()) as { presets: ScenarioPreset[] };
      })
      .then((data) => { if (!cancelled) setPresets(data.presets); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [view.kind]);

  useEffect(() => {
    if (view.kind !== "building") return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - view.startedAt) / 1000)), 250);
    let cancelled = false;
    fetch("/api/scenarios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: view.description, language: "en" }),
    })
      .then(async (res) => {
        const data = (await res.json()) as CreateScenarioResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Server replied ${res.status}`);
        return data;
      })
      .then((built) => { if (!cancelled) setView({ kind: "briefing", built }); })
      .catch((err: unknown) => {
        if (!cancelled) {
          setView({
            kind: "buildError",
            description: view.description,
            message: err instanceof Error ? err.message : "Scenario generation failed.",
          });
        }
      });
    return () => { cancelled = true; window.clearInterval(id); };
  }, [view.kind === "building" ? view.startedAt : 0]);

  useEffect(() => {
    if (view.kind !== "debriefing") return;
    setElapsed(0);
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - view.startedAt) / 1000)),
      250,
    );
    let cancelled = false;
    const still = view.still;
    fetch(`/api/sessions/${view.sessionId ?? view.built.id}/debrief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        language: "en",
        ...(still ? { stillBase64: still.base64, stillMime: still.mime } : {}),
      }),
    })
      .then(async (res) => {
        const data = (await res.json()) as DebriefResponse & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `Server replied ${res.status}`);
        return data;
      })
      .then((data) => {
        if (!cancelled) setView({ kind: "debrief", built: view.built, data, sessionId: view.sessionId ?? view.built.id });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setView({
            kind: "debriefError",
            built: view.built,
            still,
            sessionId: view.sessionId,
            message: err instanceof Error ? err.message : "Debrief generation failed.",
          });
        }
      });
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view.kind === "debriefing" ? view.startedAt : 0]);

  const build = (text: string) => setView({ kind: "building", description: text, startedAt: Date.now() });

  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/">hot seat.</a>
        <nav className="nav" aria-label="Main">
          <a className="current" href="/">Home</a>
        </nav>
      </header>
      {view.kind === "session" ? (
        <Session
          key={view.runId}
          scenarioId={view.built.id}
          onExpired={() => setView({ kind: "setup" })}
          onStartAgain={() => setView({ kind: "session", built: view.built, runId: Date.now() })}
          onEnd={(still, sessionId) =>
            setView({ kind: "debriefing", built: view.built, still, sessionId, startedAt: Date.now() })
          }
        />
      ) : view.kind === "debriefing" ? (
        <main>
          <h1 className="status-headline">Debrief.</h1>
          <p className="lede">Writing your debrief and tomorrow&apos;s front page. {elapsed} s</p>
          <p className="muted">This can take a minute.</p>
        </main>
      ) : view.kind === "debriefError" ? (
        <main>
          <h1 className="status-headline">Debrief.</h1>
          <p className="error">{view.message}</p>
          <p>
            <button
              className="primary"
              type="button"
              onClick={() =>
                setView({
                  kind: "debriefing",
                  built: view.built,
                  still: view.still,
                  sessionId: view.sessionId,
                  startedAt: Date.now(),
                })
              }
            >
              Try again
            </button>{" "}
            <button className="linklike" type="button" onClick={() => setView({ kind: "setup" })}>
              New crisis
            </button>
          </p>
        </main>
      ) : view.kind === "debrief" ? (
        <DebriefView
          debrief={view.data.debrief}
          scenario={view.built.scenario}
          frontPage={view.data.frontPage}
          sessionId={view.sessionId}
          onTryAgain={() =>
            setView({ kind: "session", built: view.built, runId: Date.now() })
          }
          onNewCrisis={() => setView({ kind: "setup" })}
        />
      ) : view.kind === "building" ? (
        <main>
          <h1 className="status-headline">Building.</h1>
          <p className="lede">Building your scenario. {elapsed} s</p>
          <p className="muted">This can take up to a minute.</p>
        </main>
      ) : view.kind === "buildError" ? (
        <main>
          <h1 className="status-headline">Building.</h1>
          <p className="error">{view.message}</p>
          <p>
            <button className="primary" type="button" onClick={() => build(view.description)}>Try again</button>{" "}
            <button className="linklike" type="button" onClick={() => setView({ kind: "setup" })}>Change the story</button>
          </p>
        </main>
      ) : view.kind === "briefing" ? (
        <Briefing scenario={view.built.scenario} onTake={() => setView({ kind: "session", built: view.built, runId: Date.now() })} onChange={() => setView({ kind: "setup" })} />
      ) : view.kind === "setup" ? (
        <main>
          <h1 className="status-headline">Your crisis.</h1>
          <label className="field-label" htmlFor="crisis-description">Your business and what went wrong</label>
          <textarea
            id="crisis-description"
            className="crisis-input"
            rows={5}
            maxLength={600}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="My café in Leeds. A customer says she found glass in a croissant and the post is everywhere."
          />
          {presets.length > 0 && (
            <p className="preset-row">
              {presets.map((p) => (
                <button key={p.id} className="linklike" type="button" onClick={() => setDescription(p.description)}>{p.label}</button>
              ))}
            </p>
          )}
          <p>
            <button className="primary" type="button" disabled={description.trim().length < 10} onClick={() => build(description.trim())}>
              Build my scenario
            </button>
          </p>
        </main>
      ) : (
      <main>
        <h1 className="status-headline">Take the seat.</h1>
        <p className="lede">
          Hot Seat rehearses small business owners for hard press questions, out loud,
          before a real crisis day arrives.
        </p>
        <p>
          <button className="primary" type="button" onClick={() => setView({ kind: "setup" })}>Start</button>
        </p>
        <section className="paper" id="providers" aria-label="Providers">
          <h2>Providers</h2>
          {state.kind === "loading" && <p className="muted">Loading provider status.</p>}
          {state.kind === "error" && <p className="error">Provider status unavailable: {state.message}</p>}
          {state.kind === "ok" && (
            <ul>
              {state.data.providers.map((p) => (
                <li key={p.id}>
                  <span>{p.label}</span>
                  <span className="muted">{p.configured ? "Configured" : "Not configured"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>)}
    </>
  );
}

const SCORE_LABELS: Array<{ key: keyof Debrief["scores"]; label: string }> = [
  { key: "clarity", label: "Clarity" },
  { key: "accountability", label: "Accountability" },
  { key: "composure", label: "Composure" },
  { key: "message_discipline", label: "Message discipline" },
  { key: "empathy", label: "Empathy" },
];

const LANDMINE_STATUS_LABELS: Record<DebriefLandmineStatus, string> = {
  disclosed_proactively: "Disclosed proactively",
  raised_and_handled: "Raised and handled",
  raised_and_fumbled: "Raised and fumbled",
  not_raised: "Not raised",
};

function DebriefView({
  debrief,
  scenario,
  frontPage: initialFrontPage,
  sessionId,
  onTryAgain,
  onNewCrisis,
}: {
  debrief: Debrief;
  scenario: GeneratedScenario;
  frontPage: DebriefResponse["frontPage"];
  sessionId: string | null;
  onTryAgain: () => void;
  onNewCrisis: () => void;
}) {
  const landmineFacts = new Map(scenario.landmines.map((m) => [m.id, m.fact]));
  const [frontPage, setFrontPage] = useState(initialFrontPage);
  const [printing, setPrinting] = useState(!initialFrontPage && sessionId !== null);

  useEffect(() => {
    if (frontPage || !sessionId) return;
    let cancelled = false;
    const poll = () => {
      fetch(`/api/sessions/${sessionId}/front-page`)
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 202) return;
          if (!res.ok) { setPrinting(false); return; }
          const data = (await res.json()) as DebriefResponse;
          if (cancelled) return;
          setFrontPage(data.frontPage);
          setPrinting(false);
        })
        .catch(() => { if (!cancelled) setPrinting(false); });
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [frontPage, sessionId]);
  return (
    <main>
      <h1 className="status-headline">Debrief.</h1>
      <p className="lede">{debrief.verdict}</p>

      <section className="debrief-scores" aria-label="Scores">
        {SCORE_LABELS.map(({ key, label }) => (
          <div key={key} className="score-row">
            <span className="score-label">{label}</span>
            <span className="score-value">{debrief.scores[key]}</span>
          </div>
        ))}
      </section>

      {debrief.best_moments.length > 0 && (
        <section className="debrief-section" aria-label="Best moments">
          <h2>Best moments</h2>
          {debrief.best_moments.map((m, i) => (
            <article key={i} className="moment">
              <p className="moment-t">{m.t}</p>
              <blockquote className="moment-quote">&ldquo;{m.quote}&rdquo;</blockquote>
              <p>{m.why}</p>
            </article>
          ))}
        </section>
      )}

      {debrief.worst_moments.length > 0 && (
        <section className="debrief-section" aria-label="Worst moments">
          <h2>Worst moments</h2>
          {debrief.worst_moments.map((m, i) => (
            <article key={i} className="moment">
              <p className="moment-t">{m.t}</p>
              <blockquote className="moment-quote">&ldquo;{m.quote}&rdquo;</blockquote>
              <p>{m.why}</p>
              <p>
                <strong>Better:</strong> &ldquo;{m.better}&rdquo;
              </p>
              {m.principle && <p className="moment-principle">{m.principle}</p>}
            </article>
          ))}
        </section>
      )}

      {debrief.landmines.length > 0 && (
        <section className="debrief-section" aria-label="Landmines">
          <h2>Landmines</h2>
          <ul className="landmine-list">
            {debrief.landmines.map((l) => (
              <li key={l.id} className={`landmine landmine-${l.status.replaceAll("_", "-")}`}>
                <strong>{l.id}</strong>{" "}
                <span className="landmine-status">{LANDMINE_STATUS_LABELS[l.status]}.</span>{" "}
                {landmineFacts.get(l.id) && <span>{landmineFacts.get(l.id)} </span>}
                {l.comment}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="debrief-section" aria-label="One thing to practise">
        <h2>One thing to practise</h2>
        <p className="lede">{debrief.one_thing_to_practice}</p>
      </section>

      {frontPage ? (
        <figure className="front-page">
          <img
            src={`data:${frontPage.mime};base64,${frontPage.imageBase64}`}
            alt={`Tomorrow's front page: ${debrief.front_page.headline}`}
          />
        </figure>
      ) : printing ? (
        <p className="muted">Printing tomorrow&apos;s paper.</p>
      ) : (
        <p className="muted">Tomorrow&apos;s front page could not be made this time.</p>
      )}

      <p>
        <button className="primary" type="button" onClick={onTryAgain}>
          Try again
        </button>
      </p>
      <p>
        <button className="linklike" type="button" onClick={onNewCrisis}>
          New crisis
        </button>
      </p>
    </main>
  );
}

function Briefing({ scenario, onTake, onChange }: { scenario: GeneratedScenario; onTake: () => void; onChange: () => void }) {
  const reporter = scenario.journalists[0];
  const known = ownerKnownLandmines(scenario);
  return (
    <main>
      <h1 className="status-headline">Your briefing.</h1>
      <section className="paper briefing" aria-label="Briefing">
        <h2>{scenario.company.name}, {scenario.company.city}</h2>
        <p className="headline-q">{scenario.crisis.headline}</p>
        <h3>What happened</h3>
        <ul className="briefing-list">
          {scenario.briefing_for_user.map((point, i) => (<li key={i}>{point}</li>))}
        </ul>
        <h3>What&apos;s already public</h3>
        <ul className="briefing-list">
          {scenario.public_facts.map((fact, i) => (<li key={i}>{fact}</li>))}
        </ul>
        {known.length > 0 && (
          <>
            <h3>What you know that the press doesn&apos;t, yet</h3>
            <ul className="briefing-list">
              {known.map((m) => (<li key={m.id}>{m.fact}</li>))}
            </ul>
          </>
        )}
        {reporter && <p>Who is coming: {reporter.name}, {reporter.outlet}</p>}
      </section>
      <p>
        <button className="primary" type="button" onClick={onTake}>Take the seat.</button>
      </p>
      <p>
        <button className="linklike" type="button" onClick={onChange}>Change the story</button>
      </p>
    </main>
  );
}
