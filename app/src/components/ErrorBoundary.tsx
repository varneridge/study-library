// When something on a page fails, the page says so calmly and offers a way
// on, instead of leaving a screen that looks fine but does nothing. Notes
// and readings are safe: they are saved on the device as you go.

import { Component, type ReactNode } from "react";

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(this.state.error.message);
    return (
      <div className="page failure" role="alert">
        <h1>{stale ? "Study Library has been updated" : `This ${this.props.label ?? "page"} hit a problem`}</h1>
        <p>
          {stale
            ? "Part of the app changed since this tab opened. Reloading brings in the new version."
            : "Nothing you wrote has been lost: notes and highlights are saved on this device as you go."}
        </p>
        <div className="row">
          <button className="button primary" onClick={() => location.reload()}>Reload</button>
          {!stale && <button className="quiet" onClick={() => this.setState({ error: null })}>Try again without reloading</button>}
        </div>
        {!stale && <p className="small muted failure-detail">{this.state.error.message}</p>}
      </div>
    );
  }
}

// Shown while a notes editor loads, so the space never looks empty or dead.
export function NotesLoading() {
  return (
    <div className="notes-loading" aria-busy="true" aria-label="Opening notes">
      <span /><span /><span />
    </div>
  );
}

// Shown while a part of the app loads for the first time: the shape of a
// page, so the screen never stands empty or says "Opening".
export function PageLoading({ label, wide }: { label: string; wide?: boolean }) {
  return (
    <div className={`page${wide ? " wide" : ""} page-loading`} aria-busy="true" aria-label={label}>
      <span className="pl-title" /><span /><span /><span />
    </div>
  );
}
