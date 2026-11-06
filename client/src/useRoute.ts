import { useEffect, useState } from "react";
import { parseRoute, type Route } from "./route.ts";

/** The current route, following the address bar and the browser's Back and Forward buttons. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
