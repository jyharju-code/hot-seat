import { useEffect, useState } from "react";
import type { ProvidersResponse } from "@hot-seat/shared";
import { Session } from "./Session.js";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; data: ProvidersResponse }
  | { kind: "error"; message: string };

export function App() {
  const [view, setView] = useState<"home" | "session">("home");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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

  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/">hot seat.</a>
        <nav className="nav" aria-label="Main">
          <a className="current" href="/">Home</a>
        </nav>
      </header>
      {view === "session" ? <Session onEnd={() => setView("home")} /> : (
      <main>
        <h1 className="status-headline">Take the seat.</h1>
        <p className="lede">
          Hot Seat rehearses small business owners for hard press questions, out loud,
          before a real crisis day arrives.
        </p>
        <p>
          <button className="primary" type="button" onClick={() => setView("session")}>Start</button>
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
