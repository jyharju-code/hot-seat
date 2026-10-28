import { useEffect, useState } from "react";
import type { CreateScenarioResponse, GeneratedScenario, ProvidersResponse, ScenarioPreset } from "@hot-seat/shared";
import { Session } from "./Session.js";

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
  | { kind: "session"; built: CreateScenarioResponse };

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
        <Session scenarioId={view.built.id} onEnd={() => setView({ kind: "briefing", built: view.built })} />
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
        <Briefing scenario={view.built.scenario} onTake={() => setView({ kind: "session", built: view.built })} onChange={() => setView({ kind: "setup" })} />
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

function Briefing({ scenario, onTake, onChange }: { scenario: GeneratedScenario; onTake: () => void; onChange: () => void }) {
  const reporter = scenario.journalists[0];
  return (
    <main>
      <h1 className="status-headline">Your briefing.</h1>
      <section className="paper briefing" aria-label="Briefing">
        <h2>{scenario.company.name}, {scenario.company.city}</h2>
        <p className="headline-q">{scenario.crisis.headline}</p>
        <ul className="briefing-list">
          {scenario.briefing_for_user.map((point, i) => (<li key={i}>{point}</li>))}
        </ul>
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
