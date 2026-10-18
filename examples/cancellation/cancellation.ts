/** A CLI-scoped cancellation signal; importing examples installs no signal handler. */
export function ctrlC(): { readonly signal: AbortSignal; [Symbol.dispose](): void } {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("Interrupted by Ctrl-C", "AbortError"));
  process.on("SIGINT", interrupt);
  return {
    signal: controller.signal,
    [Symbol.dispose]() {
      process.off("SIGINT", interrupt);
    },
  };
}
