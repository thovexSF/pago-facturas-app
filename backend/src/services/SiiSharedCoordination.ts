import type { BrowserContext } from 'playwright';
import { SiiGlobalMutex } from './SiiGlobalMutex';

export type PagoSiiCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

export type SharedSiiSessionSnapshot = {
  sessionId: string;
  cookieHeader: string;
  context: BrowserContext | null;
  expiresAt: number;
  expiresInMs: number;
};

type SessionProvider = () => SharedSiiSessionSnapshot | null | Promise<SharedSiiSessionSnapshot | null>;
type SessionChangeListener = () => void;

/**
 * Coordina sesión SII entre módulo Clientes (TypeScript) y Proveedores (pago-facturas JS).
 */
export class SiiSharedCoordination {
  private static sessionProvider: SessionProvider | null = null;
  private static onSessionChanged: SessionChangeListener | null = null;

  static registerSessionProvider(provider: SessionProvider): void {
    this.sessionProvider = provider;
  }

  static setOnSessionChanged(fn: SessionChangeListener | null): void {
    this.onSessionChanged = fn;
  }

  static notifySessionChanged(): void {
    this.onSessionChanged?.();
  }

  static async getActiveSession(): Promise<SharedSiiSessionSnapshot | null> {
    if (!this.sessionProvider) return null;
    return this.sessionProvider();
  }

  static parseCookieHeader(header: string): PagoSiiCookie[] {
    const out: PagoSiiCookie[] = [];
    for (const part of header.split(';')) {
      const p = part.trim();
      const eq = p.indexOf('=');
      if (eq <= 0) continue;
      const name = p.slice(0, eq).trim();
      const value = p.slice(eq + 1).trim();
      if (!name || !value) continue;
      out.push({ name, value, domain: '.sii.cl', path: '/' });
    }
    return out;
  }

  static async getSharedCookiesForPago(): Promise<PagoSiiCookie[] | null> {
    const session = await this.getActiveSession();
    if (!session) return null;

    if (session.context) {
      try {
        const raw = await session.context.cookies();
        const cookies = raw
          .filter((c) => c.name && c.value && c.value !== 'DEL')
          .map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain?.startsWith('.') ? c.domain : `.${c.domain || 'sii.cl'}`,
            path: c.path || '/',
          }));
        if (cookies.length) {
          console.log('[SII shared] Cookies desde sesión Clientes (browser context)');
          return cookies;
        }
      } catch (e: any) {
        console.warn('[SII shared] context cookies:', e?.message || e);
      }
    }

    const header = session.cookieHeader?.trim();
    if (!header) return null;
    const parsed = this.parseCookieHeader(header);
    if (parsed.length) {
      console.log('[SII shared] Cookies desde sesión Clientes (HTTP header)');
    }
    return parsed.length ? parsed : null;
  }

  static async getSharedStatus() {
    const session = await this.getActiveSession();
    return {
      shared: true,
      clientesSessionActive: session !== null,
      sessionId: session?.sessionId ?? null,
      expiresAt: session?.expiresAt ?? 0,
      expiresInMs: session?.expiresInMs ?? 0,
      globalBusy: SiiGlobalMutex.isBusy(),
      busyLabel: SiiGlobalMutex.getBusyLabel(),
    };
  }

  /** Objeto plain para apps/pago-facturas/server-postgres.js */
  static createPagoBridge() {
    return {
      waitForSlot: (maxWaitMs?: number) =>
        SiiGlobalMutex.waitForSlot(1500, maxWaitMs ?? 120000),
      beginOp: (label: string) => SiiGlobalMutex.beginOp(label),
      endOp: (label: string) => SiiGlobalMutex.endOp(label),
      isBusy: () => SiiGlobalMutex.isBusy(),
      getBusyLabel: () => SiiGlobalMutex.getBusyLabel(),
      runExclusive: <T>(label: string, fn: () => Promise<T>, maxWaitMs?: number) =>
        SiiGlobalMutex.runExclusive(label, fn, maxWaitMs ?? 120000),
      getSharedCookies: () => SiiSharedCoordination.getSharedCookiesForPago(),
      getStatus: () => SiiSharedCoordination.getSharedStatus(),
      setOnSessionChanged: (fn: (() => void) | null) =>
        SiiSharedCoordination.setOnSessionChanged(fn),
      forceReset: () => SiiGlobalMutex.forceReset(),
    };
  }
}
