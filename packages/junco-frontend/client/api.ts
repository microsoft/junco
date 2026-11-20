import { useEffect, useReducer } from "react";
import { EMPTY, reduce, type State } from "./state.ts";

/** The reduced event log, live: `EventSource` resumes from `Last-Event-ID` on reconnect itself. */
export function useJuncoState(): State {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  useEffect(() => {
    const source = new EventSource("/api/events/stream?after=0");
    source.onmessage = (event) => dispatch(JSON.parse(event.data));
    return () => source.close();
  }, []);
  return state;
}
