import { useCallback, useEffect, useRef, useState } from 'react';

export interface SiiSessionStatus {
  valid: boolean;
  exists: boolean;
  expiresAt: number;
  expiresInMs: number;
  playwrightReady?: boolean;
  siiAlive?: boolean;
  reason?: string;
}

export function isSiiSessionError(httpStatus: number, message: string): boolean {
  if (httpStatus === 401) return true;
  const m = message.toLowerCase();
  return (
    (m.includes('sesión') || m.includes('session')) &&
    (m.includes('expir') || m.includes('invalid') || m.includes('caduc') || m.includes('no existe') || m.includes('vencid'))
  );
}

export function formatSessionExpiresIn(ms: number): string {
  if (ms <= 0) return 'expirada';
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

type Options = {
  siiApiBase: string;
  sessionId: string | null;
  onInvalid?: (reason?: string) => void;
  /** Verificación ligera cada N ms (solo TTL). */
  pollMs?: number;
  /** Verificación con probe al SII cada N ms. */
  probeMs?: number;
  /** Cerrar sesión en servidor al salir de la pestaña/app. */
  closeOnPageHide?: boolean;
};

export function useSiiSessionMonitor({
  siiApiBase,
  sessionId,
  onInvalid,
  pollMs = 30_000,
  probeMs = 120_000,
  closeOnPageHide = true,
}: Options) {
  const [status, setStatus] = useState<SiiSessionStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const probeCounter = useRef(0);
  const onInvalidRef = useRef(onInvalid);
  onInvalidRef.current = onInvalid;

  const refresh = useCallback(
    async (opts?: { probe?: boolean }) => {
      if (!sessionId) {
        setStatus(null);
        return null;
      }
      setChecking(true);
      try {
        const probe = opts?.probe ? '1' : '0';
        const res = await fetch(
          `${siiApiBase}/session/${encodeURIComponent(sessionId)}/status?probe=${probe}`,
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
          const invalid: SiiSessionStatus = {
            valid: false,
            exists: false,
            expiresAt: 0,
            expiresInMs: 0,
            reason: data.error || 'No se pudo verificar la sesión',
          };
          setStatus(invalid);
          onInvalidRef.current?.(invalid.reason);
          return invalid;
        }
        const next: SiiSessionStatus = {
          valid: !!data.valid,
          exists: !!data.exists,
          expiresAt: data.expiresAt || 0,
          expiresInMs: data.expiresInMs ?? 0,
          playwrightReady: data.playwrightReady,
          siiAlive: data.siiAlive,
          reason: data.reason,
        };
        setStatus(next);
        if (!next.valid) onInvalidRef.current?.(next.reason);
        return next;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus(invalidStatus(msg));
        return invalidStatus(msg);
      } finally {
        setChecking(false);
      }
    },
    [sessionId, siiApiBase],
  );

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      return;
    }
    void refresh({ probe: true });
    const id = window.setInterval(() => {
      probeCounter.current += pollMs;
      const doProbe = probeCounter.current >= probeMs;
      if (doProbe) probeCounter.current = 0;
      void refresh({ probe: doProbe });
    }, pollMs);
    return () => clearInterval(id);
  }, [sessionId, pollMs, probeMs, refresh]);

  useEffect(() => {
    if (!closeOnPageHide || !sessionId) return;
    const beaconUrl = `${siiApiBase}/session/beacon-close`;
    const onPageHide = () => {
      const body = JSON.stringify({ sessionId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(beaconUrl, new Blob([body], { type: 'application/json' }));
      } else {
        fetch(beaconUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [closeOnPageHide, sessionId, siiApiBase]);

  const sessionReady = !!sessionId && !!status?.valid;
  const expiresSoon = !!status?.valid && status.expiresInMs > 0 && status.expiresInMs < 10 * 60_000;

  return { status, checking, sessionReady, expiresSoon, refresh };
}

function invalidStatus(reason: string): SiiSessionStatus {
  return {
    valid: false,
    exists: false,
    expiresAt: 0,
    expiresInMs: 0,
    reason,
  };
}
