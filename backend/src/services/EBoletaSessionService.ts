/**
 * Sesiones Playwright para e-Boleta (eboleta.sii.cl) — separadas de MiPyme.
 */
import { randomUUID } from 'crypto';
import { Browser, BrowserContext, Page, chromium } from 'playwright';

export interface EBoletaSession {
  id: string;
  empresaRut: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  ts: number;
  loggedIn: boolean;
}

const sessions = new Map<string, EBoletaSession>();

function playwrightHeadless(): boolean {
  const wantHeaded = /^(1|true|yes)$/i.test(String(process.env.SII_PLAYWRIGHT_HEADED || '').trim());
  if (wantHeaded && process.env.DISPLAY) return false;
  return true;
}

export class EBoletaSessionService {
  static getSession(sessionId: string): EBoletaSession | undefined {
    return sessions.get(sessionId);
  }

  static async createSession(empresaRut: string): Promise<string> {
    const id = randomUUID();
    const browser = await chromium.launch({
      headless: playwrightHeadless(),
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      locale: 'es-CL',
      timezoneId: 'America/Santiago',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto('https://eboleta.sii.cl/emitir/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    });
    await page.waitForSelector('#app', { timeout: 45000 });

    sessions.set(id, {
      id,
      empresaRut,
      browser,
      context,
      page,
      ts: Date.now(),
      loggedIn: false,
    });
    console.log(`[eboleta] sesión creada ${id} empresa=${empresaRut}`);
    return id;
  }

  static async closeSession(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    await s.context.close().catch(() => {});
    await s.browser.close().catch(() => {});
  }

  static async closeAllSessions(): Promise<void> {
    const ids = [...sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }
}
