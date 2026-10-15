import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown in the fallback so the user knows which part of the app failed. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps one broken panel from taking the whole window down with it.
 *
 * React unmounts the entire tree when a render throws and nothing catches it,
 * which is exactly the "点进去白茫茫一片" failure mode: a single bad component
 * (an infinite effect loop, a malformed option list) turns the app into a blank
 * window with no way back. This boundary keeps the shell — sidebar, navigation,
 * other routes — and renders the failure in place.
 *
 * Kept dependency-free on purpose: `error.ts` here imports nothing, so a
 * failure in the component tree can never cascade into the fallback itself.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only sink available inside a WebView.
    console.error("[error-boundary]", this.props.label ?? "page", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-start gap-3 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-semibold">
            {this.props.label ?? "这个页面"}出错了
          </h1>
          <p className="text-sm text-muted-foreground">
            界面没有渲染出来，但其它页面仍然可用。可以先重试；如果一直失败，重新载入应用。
          </p>
        </div>

        <pre className="max-h-60 w-full overflow-auto rounded-md border border-border bg-card p-3 text-xs text-muted-foreground [.glass_&]:bg-[hsl(var(--glass-strong))] [.glass_&]:backdrop-blur-2xl">
          {error.message || String(error)}
        </pre>

        <div className="flex items-center gap-2">
          <Button onClick={this.reset}>重试</Button>
          <Button variant="outline" onClick={this.reload}>
            重新载入
          </Button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
