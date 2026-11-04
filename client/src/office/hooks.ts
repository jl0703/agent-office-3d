import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { applyEvent, initialState, type AgentsState } from "../agents.ts";
import { createDemoWorld, demoSnapshot, stepDemo, type DemoWorld } from "./demo.ts";
import type { Scheme } from "./palette.ts";

/** Follows a CSS media query, for example the user's colour scheme or motion preference. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

export const useReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");
export const useScheme = (): Scheme => (useMediaQuery("(prefers-color-scheme: dark)") ? "dark" : "light");

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** The number in `?demo=48`, 20 for a bare `?demo`, or null when demo mode is not asked for. */
export function demoFromUrl(search: string): number | null {
  const value = new URLSearchParams(search).get("demo");
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 20;
}

export type Demo = {
  active: boolean;
  state: AgentsState;
  start: (count?: number) => void;
  stop: () => void;
  log: (id: string) => ReturnType<DemoWorld["log"]["get"]>;
};

/** Demo mode: fake agents that change status every few seconds. Never mixes with real data. */
export function useDemo(): Demo {
  const [count, setCount] = useState<number | null>(() => (typeof window === "undefined" ? null : demoFromUrl(window.location.search)));
  const [state, dispatch] = useReducer(applyEvent, initialState);
  const world = useRef<DemoWorld | null>(null);

  useEffect(() => {
    if (count === null) return;
    const w = createDemoWorld(count);
    world.current = w;
    dispatch(demoSnapshot(w));
    const timer = setInterval(() => {
      for (const event of stepDemo(w, Date.now())) dispatch(event);
    }, 500);
    return () => {
      clearInterval(timer);
      world.current = null;
    };
  }, [count]);

  useEffect(() => {
    if (count === null) return;
    const before = document.title;
    document.title = `[Demo] ${before.replace(/^\[Demo\] /, "")}`;
    return () => {
      document.title = before;
    };
  }, [count]);

  const start = useCallback((n = 20) => {
    const url = new URL(window.location.href);
    url.searchParams.set("demo", String(n));
    window.history.replaceState(null, "", url);
    setCount(n);
  }, []);
  const stop = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete("demo");
    window.history.replaceState(null, "", url);
    setCount(null);
  }, []);
  const log = useCallback((id: string) => world.current?.log.get(id), []);

  return { active: count !== null, state: count === null ? initialState : state, start, stop, log };
}
