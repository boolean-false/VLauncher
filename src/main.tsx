import { startAnalytics } from "./telemetry";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, loadActiveTheme } from "./design-system/theme";

import { installDesktopBehavior } from "./desktop";
applyTheme(loadActiveTheme());
const stopAnalytics = startAnalytics();
if (import.meta.hot) import.meta.hot.dispose(stopAnalytics);
const disposeDesktopBehavior = installDesktopBehavior();
if (import.meta.hot) import.meta.hot.dispose(disposeDesktopBehavior);

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("VLauncher renderer failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <h1>VLauncher не смог открыть интерфейс</h1>
        <p>Профили и миры остались на диске. Перезапустите интерфейс.</p>
        <button onClick={() => location.reload()}>Перезапустить</button>
        <details>
          <summary>Технические подробности</summary>
          {this.state.error.message}
        </details>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
