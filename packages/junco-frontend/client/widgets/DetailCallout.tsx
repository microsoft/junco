import { type ReactNode, useLayoutEffect, useRef } from "react";
import { calloutPosition } from "../callout-position.ts";

type Trigger = HTMLButtonElement | SVGGElement;

export function DetailCallout({ selector, label, onDismiss, children }: {
  selector: string;
  label: "Task details" | "Node details";
  onDismiss: () => void;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const bubble = surface.current;
    const button = close.current;
    const initial = document.querySelector<Trigger>(selector);
    const panel = initial?.closest(".panel");
    if (!bubble || !button || !panel || !initial) {
      onDismiss();
      return;
    }

    let trigger = initial;
    const position = (): boolean => {
      // Mermaid replaces the SVG, but an occurrence keeps its selector across status updates.
      if (!trigger.isConnected) {
        resize.unobserve(trigger);
        trigger.removeAttribute("aria-expanded");
        const replacement = panel.querySelector<Trigger>(selector);
        if (!replacement) {
          onDismiss();
          return false;
        }
        trigger = replacement;
        resize.observe(trigger);
      }
      const pos = calloutPosition(
        trigger.getBoundingClientRect(), panel.getBoundingClientRect(),
        bubble.getBoundingClientRect().width, window.innerWidth, window.innerHeight,
      );
      if (!pos) {
        onDismiss();
        return false;
      }
      trigger.setAttribute("aria-expanded", "true");
      bubble.dataset.side = pos.side;
      bubble.style.left = `${pos.left}px`;
      bubble.style.maxHeight = `${pos.maxHeight}px`;
      bubble.style.setProperty("--inset", `${pos.inset}px`);
      bubble.style.setProperty("--tip", `${pos.tip}px`);
      return true;
    };
    const resize = new ResizeObserver(position);
    resize.observe(panel);
    resize.observe(trigger);
    const mutations = new MutationObserver(position);
    mutations.observe(panel, { childList: true, characterData: true, subtree: true });
    if (position()) button.focus({ preventScroll: true });

    const dismissToTrigger = () => {
      panel.querySelector<Trigger>(selector)?.focus({ preventScroll: true });
      onDismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissToTrigger();
      }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !bubble.contains(event.target) && !trigger.contains(event.target)) {
        onDismiss();
      }
    };
    button.addEventListener("click", dismissToTrigger);
    document.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      trigger.removeAttribute("aria-expanded");
      resize.disconnect();
      mutations.disconnect();
      button.removeEventListener("click", dismissToTrigger);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [selector, onDismiss]);
  return (
    <div ref={surface} className="callout" role="dialog" aria-label={label}>
      <div className="callout-body">
        <button type="button" ref={close} className="callout-close">Close details</button>
        {children}
      </div>
    </div>
  );
}
