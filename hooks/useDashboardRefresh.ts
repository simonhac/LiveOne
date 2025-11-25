import { useEffect } from "react";

const REFRESH_EVENT = "dashboard:refresh";

export function useDashboardRefresh(onRefresh: () => void) {
  useEffect(() => {
    const handler = () => onRefresh();
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, [onRefresh]);
}

export function triggerDashboardRefresh() {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}
