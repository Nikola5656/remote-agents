import type { AgentSnapshot, HealthReport } from "@remote-agents/shared";
import { emptyHealth } from "@remote-agents/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AuthError, fetchAgents, fetchHealth, wsUrl } from "./api";
import { createLiveRefresh } from "./live-refresh";
import { isAgentSnapshot, type LiveMode } from "./format";

type Snapshot = { health: HealthReport; agents: AgentSnapshot[] };

type LiveState = {
  health: HealthReport;
  agents: AgentSnapshot[];
  mode: LiveMode;
  error: string | null;
  refresh: () => Promise<void>;
  replaceAgent: (agent: AgentSnapshot) => void;
};

const LiveContext = createContext<LiveState | null>(null);

function applyMessage(prev: Snapshot, raw: unknown): Snapshot {
  if (!raw || typeof raw !== "object") return prev;
  const msg = raw as Record<string, unknown>;
  let next = prev;

  if (msg.health && typeof msg.health === "object") {
    next = { ...next, health: msg.health as HealthReport };
  }
  if (Array.isArray(msg.agents)) {
    next = { ...next, agents: msg.agents as AgentSnapshot[] };
  }
  if (msg.agent && isAgentSnapshot(msg.agent)) {
    const agent = msg.agent;
    const exists = next.agents.some((a) => a.id === agent.id);
    next = {
      ...next,
      agents: exists
        ? next.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...next.agents, agent],
    };
  }
  return next;
}

export function LiveProvider({
  enabled,
  onUnauth,
  children,
}: {
  enabled: boolean;
  onUnauth: () => void;
  children: React.ReactNode;
}) {
  const [health, setHealth] = useState<HealthReport>(emptyHealth);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [mode, setMode] = useState<LiveMode>("offline");
  const [error, setError] = useState<string | null>(null);
  const onUnauthRef = useRef(onUnauth);
  const snapRef = useRef<Snapshot>({ health: emptyHealth(), agents: [] });
  onUnauthRef.current = onUnauth;

  const commit = useCallback((next: Snapshot) => {
    snapRef.current = next;
    setHealth(next.health);
    setAgents(next.agents);
  }, []);

  const refreshCoordinator = useMemo(() => createLiveRefresh(async (signal) => {
    const [health, agents] = await Promise.all([fetchHealth(signal), fetchAgents(signal)]);
    return { health, agents };
  }, commit), [commit]);

  const refresh = useCallback(async () => {
    try {
      if (await refreshCoordinator.refresh()) setError(null);
    } catch (err) {
      if (err instanceof AuthError) {
        onUnauthRef.current();
        return;
      }
      setError(err instanceof Error ? err.message : "Refresh failed");
    }
  }, [refreshCoordinator]);

  const replaceAgent = useCallback((agent: AgentSnapshot) => {
    refreshCoordinator.invalidate();
    const prev = snapRef.current;
    const exists = prev.agents.some((a) => a.id === agent.id);
    commit({
      ...prev,
      agents: exists
        ? prev.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...prev.agents, agent],
    });
  }, [commit, refreshCoordinator]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let pollTimer: number | undefined;
    let openTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let ws: WebSocket | null = null;
    let alive = false;
    let retries = 0;

    const refreshSafe = async () => {
      try {
        const applied = await refreshCoordinator.refresh();
        if (cancelled || !applied) return;
        setError(null);
        setMode((prev) => (prev === "live" ? "live" : "poll"));
      } catch (err) {
        if (cancelled) return;
        if (err instanceof AuthError) {
          onUnauthRef.current();
          return;
        }
        setError(err instanceof Error ? err.message : "Refresh failed");
        setMode((prev) => (prev === "live" ? prev : "offline"));
      }
    };

    const startPoll = () => {
      if (pollTimer !== undefined) return;
      void refreshSafe();
      pollTimer = window.setInterval(() => {
        void refreshSafe();
      }, 3000);
    };

    const stopPoll = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
    };

    void refreshSafe();

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== undefined) return;
      retries += 1;
      const delay = Math.min(30_000, 2000 * 2 ** (retries - 1));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {
          if (cancelled) return;
          alive = true;
          retries = 0;
          stopPoll();
          setMode("live");
        };
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(String(ev.data)) as unknown;
            if (cancelled) return;
            const next = applyMessage(snapRef.current, parsed);
            if (next !== snapRef.current) {
              refreshCoordinator.invalidate();
              commit(next);
            }
            setError(null);
          } catch {
            /* ignore malformed frames */
          }
        };
        ws.onerror = () => {
          /* close handler starts polling */
        };
        ws.onclose = () => {
          if (cancelled) return;
          alive = false;
          setMode("poll");
          startPoll();
          scheduleReconnect();
        };
        if (openTimer !== undefined) window.clearTimeout(openTimer);
        openTimer = window.setTimeout(() => {
          if (!alive && !cancelled) startPoll();
        }, 1500);
      } catch {
        startPoll();
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      cancelled = true;
      refreshCoordinator.invalidate();
      stopPoll();
      if (openTimer !== undefined) window.clearTimeout(openTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [enabled, commit, refreshCoordinator]);

  const value = useMemo(
    () => ({ health, agents, mode, error, refresh, replaceAgent }),
    [health, agents, mode, error, refresh, replaceAgent]
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used within LiveProvider");
  return ctx;
}
