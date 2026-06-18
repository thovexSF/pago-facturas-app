/**
 * Emisión de boletas electrónicas vía portal e-Boleta (eboleta.sii.cl).
 * No usa MiPyme / mipeGenFacEx.
 */
import { Page } from 'playwright';
import { SiiCredentialsService } from './SiiCredentialsService';
import { EBoletaSession, EBoletaSessionService } from './EBoletaSessionService';
import { splitRutDv, normalizeRutKey } from '../utils/rutUtils';
import { eboletaReceptorForSii } from '../utils/biomaOrderAttrs';

export interface EBoletaEmitItem {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
}

export interface EBoletaEmitParams {
  tipoCodigo: number;
  items: EBoletaEmitItem[];
  /** Monto total bruto (CLP, IVA incluido para tipo 39). */
  montoTotal: number;
  detalleLabel?: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
}

export interface EBoletaEmitResult {
  success: boolean;
  folio?: number;
  pdfPublicUrl?: string | null;
  b64Pdf?: string | null;
  dte?: string;
  error?: string;
}

export class EBoletaService {
  static async ensureLoggedIn(session: EBoletaSession): Promise<void> {
    if (session.loggedIn) return;

    const creds = SiiCredentialsService.getInstance().getCredentials();
    if (!creds) throw new Error('Credenciales SII no configuradas (SII_USERNAME / SII_PASSWORD)');

    const username = creds.username.replace(/\./g, '').trim();

    const loginErr = await session.page.evaluate(
      async ({ user, pass }) => {
        const app = (globalThis as any).document?.querySelector('#app');
        const store = app?.__vue__?.$store;
        if (!store) return 'App e-Boleta no cargó (sin Vue store)';

        if (store.getters['usuario/authStatus'] === 'authenticated') return null;

        const err = await store.dispatch('usuario/signIn', { username: user, pass });
        if (err && typeof err === 'string') return err;
        if (store.getters['usuario/authStatus'] !== 'authenticated') {
          return 'Login e-Boleta falló (revisa RUT/clave tributaria)';
        }
        return null;
      },
      { user: username, pass: creds.password },
    );

    if (loginErr) throw new Error(String(loginErr));

    await this.selectEmpresa(session);
    session.loggedIn = true;
    console.log(`[eboleta] login OK sesión ${session.id}`);
  }

  static async selectEmpresa(session: EBoletaSession): Promise<void> {
    const targetKey = normalizeRutKey(session.empresaRut);
    const err = await session.page.evaluate(
      async ({ targetKey }) => {
        const app = (globalThis as any).document?.querySelector('#app');
        const store = app?.__vue__?.$store;
        if (!store) return 'Sin store Vue';

        await store.dispatch('empresas/getEmpresasExternos');
        const lista = store.getters['empresas/lista'] || [];
        if (!lista.length) return 'No hay empresas en e-Boleta para este usuario';

        const norm = (r: string) =>
          String(r || '')
            .replace(/\./g, '')
            .replace(/-/g, '')
            .toLowerCase();

        let pick = lista.find((e: any) => norm(`${e.rut}${e.dv}`) === targetKey);
        if (!pick) {
          pick = lista.find((e: any) =>
            norm(`${e.rut}${e.dv}`).startsWith(targetKey.slice(0, Math.max(1, targetKey.length - 1))),
          );
        }
        if (!pick) pick = lista[0];

        await store.dispatch('empresas/selectEmisor', pick);

        const router = app.__vue__.$router;
        if (router?.currentRoute?.name !== 'calculadora-botonera') {
          await router.push({ name: 'calculadora-botonera' }).catch(() => {});
        }
        return null;
      },
      { targetKey },
    );

    if (err) throw new Error(String(err));

    await session.page.waitForTimeout(1500);
    await this.waitForDatosEmisor(session.page, 45000);
  }

  private static async waitForDatosEmisor(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await page.evaluate(() => {
        function findCalculadora(vm: any): any {
          if (!vm) return null;
          if (vm.modalBoleta && vm.cargarDatosEmisor) return vm;
          for (const c of vm.$children || []) {
            const f = findCalculadora(c);
            if (f) return f;
          }
          return null;
        }
        const app = (globalThis as any).document?.querySelector('#app');
        const vm = findCalculadora(app?.__vue__);
        return !!(vm?.modalBoleta?.datosEmisor?.rut);
      });
      if (ready) return;
      await page.waitForTimeout(500);
    }
    throw new Error('e-Boleta: no se cargaron datos del emisor (¿empresa inscrita en e-Boleta?)');
  }

  static async emitBoleta(
    sessionId: string,
    params: EBoletaEmitParams,
  ): Promise<EBoletaEmitResult> {
    const session = EBoletaSessionService.getSession(sessionId);
    if (!session) return { success: false, error: 'Sesión e-Boleta no encontrada o expirada' };

    try {
      await this.ensureLoggedIn(session);

      const cf = eboletaReceptorForSii();
      const detalleLabel =
        params.detalleLabel?.trim() ||
        (params.items.length === 1
          ? params.items[0].descripcion.slice(0, 80)
          : `Pedido Shopify (${params.items.length} ítems)`);

      const medioPagoId = parseInt(String(process.env.EBOLETA_MEDIO_PAGO_ID || ''), 10);
      const useMultiLine = params.items.length > 1;

      const responsePromise = session.page.waitForResponse(
        (r) => r.url().includes('/api/dte/documentos/generar') && r.request().method() === 'POST',
        { timeout: 120000 },
      );

      const evalErr = await session.page.evaluate(
        async ({
          tipoCodigo,
          montoTotal,
          detalleLabel,
          useMultiLine,
          items,
          medioPagoId,
          cf,
        }) => {
          function findCalculadora(vm: any): any {
            if (!vm) return null;
            if (vm.modalBoleta && vm.botoneraEmitir) return vm;
            for (const c of vm.$children || []) {
              const f = findCalculadora(c);
              if (f) return f;
            }
            return null;
          }

          function findModalEmision(root: any): any {
            function walk(vm: any): any {
              if (!vm) return null;
              if (typeof vm.emitir === 'function' && vm.datosEmisor && vm.monto !== undefined) {
                return vm;
              }
              for (const c of vm.$children || []) {
                const f = walk(c);
                if (f) return f;
              }
              return null;
            }
            return walk(root) || walk(root?.$root);
          }

          const app = (globalThis as any).document?.querySelector('#app');
          const calc = findCalculadora(app?.__vue__);
          if (!calc?.modalBoleta?.datosEmisor) {
            return 'Calculadora e-Boleta no lista (datos emisor ausentes)';
          }

          calc.monto = montoTotal;
          calc.entrada = String(montoTotal);
          await new Promise((r) => setTimeout(r, 200));
          if (typeof calc.abrirModalBoleta === 'function') {
            await calc.abrirModalBoleta();
          }
          await new Promise((r) => setTimeout(r, 500));

          const modal = findModalEmision(calc);
          if (!modal) return 'No se pudo abrir modal de emisión e-Boleta';

          modal.tipoDte = { codigo: tipoCodigo };
          if (typeof modal.establecerReceptorGenerico === 'function') {
            modal.establecerReceptorGenerico();
          } else {
            const [rutBody, rutDv] = cf.rut.split('-');
            modal.rutDvReceptor = `${rutBody}-${rutDv || '6'}`;
            modal.razonSocialReceptor = cf.razonSocial;
            modal.direccionReceptor = cf.direccion;
            modal.comunaReceptor = cf.comuna;
          }

          if (Array.isArray(modal.metodosPago) && modal.metodosPago.length) {
            const pick =
              modal.metodosPago.find((m: any) => medioPagoId && m.id_sii === medioPagoId) ||
              modal.metodosPago.find((m: any) =>
                /tarjeta|cr[eé]dito|d[eé]bito/i.test(String(m.nombre || '')),
              ) ||
              modal.metodosPago[0];
            modal.metodoPago = pick;
          }

          if (Array.isArray(modal.sucursales) && modal.sucursales.length && !modal.sucursal) {
            modal.sucursal = modal.sucursales[0];
          }

          modal.conDetalle = useMultiLine;
          modal.monto = montoTotal;
          if (useMultiLine) {
            modal.nombreDetalle = detalleLabel.slice(0, 80);
          } else {
            modal.nombreDetalle = detalleLabel.slice(0, 80);
          }

          return new Promise<string | null>((resolve) => {
            const timeout = setTimeout(
              () => resolve('Timeout esperando emisión e-Boleta'),
              115000,
            );
            const origEmitido = calc.emitidoModalBoleta?.bind(calc);
            calc.emitidoModalBoleta = function emitidoWrap() {
              clearTimeout(timeout);
              if (origEmitido) origEmitido();
              resolve(null);
            };
            try {
              modal.emitir();
            } catch (e: any) {
              clearTimeout(timeout);
              resolve(e?.message || 'Error al llamar emitir() en e-Boleta');
            }
          });
        },
        {
          tipoCodigo: params.tipoCodigo,
          montoTotal: params.montoTotal,
          detalleLabel,
          useMultiLine,
          items: params.items.map((it) => ({
            descripcion: it.descripcion,
            cantidad: it.cantidad,
            precioUnitario: it.precioUnitario,
          })),
          medioPagoId: Number.isFinite(medioPagoId) ? medioPagoId : 0,
          cf,
        },
      );

      if (evalErr) {
        return { success: false, error: String(evalErr) };
      }

      let apiBody: any;
      try {
        const response = await responsePromise;
        if (!response.ok()) {
          const txt = await response.text().catch(() => '');
          return {
            success: false,
            error: `e-Boleta API HTTP ${response.status()}: ${txt.slice(0, 300)}`,
          };
        }
        apiBody = await response.json();
      } catch (e: any) {
        return { success: false, error: `Sin respuesta de e-Boleta: ${e?.message || e}` };
      }

      const folio = parseInt(String(apiBody?.folio ?? 0), 10) || undefined;
      if (!folio) {
        return {
          success: false,
          error: apiBody?.glosa || apiBody?.message || 'e-Boleta no devolvió folio',
        };
      }

      console.log(`[eboleta] emit OK folio=${folio}`);
      return {
        success: true,
        folio,
        pdfPublicUrl: apiBody?.pdf_public_url ?? null,
        b64Pdf: apiBody?.b64encoded_pdf ?? null,
        dte: apiBody?.dte,
      };
    } catch (err: any) {
      console.error('[eboleta] emit error:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  static async createSession(empresaRut: string): Promise<string> {
    const parts = splitRutDv(empresaRut);
    if (!parts) throw new Error(`RUT empresa inválido: ${empresaRut}`);
    return EBoletaSessionService.createSession(empresaRut);
  }
}
