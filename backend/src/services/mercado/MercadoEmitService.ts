import { AppDataSource } from '../../config/database';
import { DteMercadoEntity } from '../../entities/DteMercadoEntity';
import { SiiFacturaEntity } from '../../entities/SiiFacturaEntity';
import { MercadoConfig } from './MercadoConfig';
import { CafService } from './CafService';
import { DteXmlBuilder, type DteDocumentoInput, type DteEmisor, type DteReceptor, type DteItem, type DteTotales, type DteDescuentoGlobal, type DteReferencia } from './DteXmlBuilder';
import { DteUploadService } from './DteUploadService';
import { CertificateService } from './CertificateService';
import { IVA_CHILE_FACTOR } from '../../utils/biomaMontos';

export interface MercadoEmitParams {
  tipoCodigo: number;
  fechaEmision: string;
  emisor: DteEmisor;
  receptor: DteReceptor;
  items: Array<{
    descripcion: string;
    descripcionExtendida?: string;
    cantidad: number;
    precioUnitario: number;
    indExe?: number;
  }>;
  descuentoGlobal?: { montoNeto: number; porcentaje: number; glosa: string } | null;
  referencias?: DteReferencia[];
  fmaPago?: number;
  indServicio?: number;
  /** Fecha resolución SII (necesaria para Caratula) */
  fchResol: string;
  /** Número resolución SII */
  nroResol: number;
  /** RUT de quien envía (generalmente el admin, puede ser distinto al emisor) */
  rutEnvia?: string;
}

export interface MercadoEmitResult {
  success: boolean;
  folio?: number;
  tipoCodigo?: number;
  trackId?: string | null;
  error?: string;
  dteXml?: string;
  envioXml?: string;
}

export class MercadoEmitService {
  static async emitir(params: MercadoEmitParams): Promise<MercadoEmitResult> {
    const empresaRut = params.emisor.rut;
    const isBoleta = params.tipoCodigo === 39 || params.tipoCodigo === 41;

    const { folio, cafEntity } = await CafService.getNextFolio(empresaRut, params.tipoCodigo);

    const dteItems: DteItem[] = params.items.map((it, i) => {
      const montoItem = Math.round(it.precioUnitario * it.cantidad);
      return {
        nroLinDet: i + 1,
        nombre: it.descripcion.slice(0, 80),
        descripcion: it.descripcionExtendida?.slice(0, 1000),
        cantidad: it.cantidad,
        unidad: 'UN',
        precioUnitario: it.precioUnitario,
        montoItem,
        indExe: it.indExe,
      };
    });

    const subtotalLineas = dteItems.reduce((s, it) => s + it.montoItem, 0);

    let descuentosGlobales: DteDescuentoGlobal[] | undefined;
    let descuentoMonto = 0;
    if (params.descuentoGlobal && params.descuentoGlobal.montoNeto > 0) {
      descuentoMonto = params.descuentoGlobal.montoNeto;
      descuentosGlobales = [{
        nroLinDR: 1,
        tipoMovimiento: 'D',
        glosa: params.descuentoGlobal.glosa.slice(0, 45),
        tipoValor: '$',
        valor: descuentoMonto,
      }];
    }

    const netoBase = subtotalLineas - descuentoMonto;
    const totales: DteTotales = this.computeTotales(params.tipoCodigo, netoBase, dteItems);

    const docInput: DteDocumentoInput = {
      tipoCodigo: params.tipoCodigo,
      folio,
      fechaEmision: params.fechaEmision,
      fmaPago: params.fmaPago,
      indServicio: params.indServicio,
      emisor: params.emisor,
      receptor: params.receptor,
      totales,
      items: dteItems,
      descuentosGlobales,
      referencias: params.referencias,
      cafXml: cafEntity.cafXml,
      cafPrivateKeyPem: cafEntity.privateKeyPem,
    };

    const documentoXml = DteXmlBuilder.buildDocumentoXml(docInput);

    const rutEnvia = params.rutEnvia || CertificateService.load().subjectRut || empresaRut;

    const buildEnvio = isBoleta
      ? DteXmlBuilder.buildEnvioBoleta.bind(DteXmlBuilder)
      : DteXmlBuilder.buildEnvioDTE.bind(DteXmlBuilder);

    const envioXml = buildEnvio({
      rutEmisor: empresaRut,
      rutEnvia,
      fchResol: params.fchResol,
      nroResol: params.nroResol,
      documentosXml: [{ tipoCodigo: params.tipoCodigo, xml: documentoXml }],
    });

    const uploadResult = await DteUploadService.upload(envioXml, empresaRut, rutEnvia);

    if (!uploadResult.success) {
      return {
        success: false,
        folio,
        tipoCodigo: params.tipoCodigo,
        error: uploadResult.error || `SII upload falló (status=${uploadResult.status})`,
        dteXml: documentoXml,
        envioXml,
      };
    }

    const dteMercadoRepo = AppDataSource.getRepository(DteMercadoEntity);
    await dteMercadoRepo.save(dteMercadoRepo.create({
      empresaRut,
      tipoCodigo: params.tipoCodigo,
      folio,
      rutReceptor: params.receptor.rut,
      razonSocialReceptor: params.receptor.razonSocial,
      montoTotal: totales.montoTotal,
      fechaEmision: params.fechaEmision,
      dteXml: documentoXml,
      envioXml,
      trackId: uploadResult.trackId,
      estado: 'enviado',
      siiResponse: uploadResult.raw,
    }));

    const facturaRepo = AppDataSource.getRepository(SiiFacturaEntity);
    const codigo = `MKT-${params.tipoCodigo}-${folio}`;
    const facturaRow: Partial<SiiFacturaEntity> = {
      empresaRut,
      codigo,
      tipoCodigo: params.tipoCodigo,
      tipoDocumento: this.tipoNombre(params.tipoCodigo),
      folio,
      fecha: params.fechaEmision,
      rutReceptor: params.receptor.rut,
      razonSocial: params.receptor.razonSocial,
      giroReceptor: params.receptor.giro || undefined,
      dirReceptor: params.receptor.dirRecep || undefined,
      comunaReceptor: params.receptor.cmnaRecep || undefined,
      ciudadReceptor: params.receptor.ciudadRecep || undefined,
      neto: totales.montoNeto || undefined,
      iva: totales.iva || undefined,
      total: totales.montoTotal,
      monto: totales.montoTotal,
      estado: 'Emitido (Mercado)',
      items: dteItems.map((it, i) => ({
        numero: i + 1,
        descripcion: it.nombre,
        cantidad: it.cantidad,
        unidad: it.unidad || 'UN',
        precioUnitario: it.precioUnitario,
        descuento: 0,
        subtotal: it.montoItem,
      })),
      detalleCompleto: true,
    };
    await facturaRepo.save(facturaRepo.create(facturaRow));

    console.log(`[MercadoEmit] DTE tipo=${params.tipoCodigo} folio=${folio} trackId=${uploadResult.trackId}`);

    return {
      success: true,
      folio,
      tipoCodigo: params.tipoCodigo,
      trackId: uploadResult.trackId,
      dteXml: documentoXml,
      envioXml,
    };
  }

  private static computeTotales(tipoCodigo: number, netoBase: number, items: DteItem[]): DteTotales {
    const hasExentos = items.some((it) => it.indExe === 1);
    const montoExento = hasExentos
      ? items.filter((it) => it.indExe === 1).reduce((s, it) => s + it.montoItem, 0)
      : undefined;

    if (tipoCodigo === 34 || tipoCodigo === 41) {
      return {
        montoExento: netoBase,
        montoTotal: netoBase,
      };
    }

    const montoNeto = montoExento ? netoBase - montoExento : netoBase;
    const tasaIva = 19;
    const iva = Math.round(montoNeto * 0.19);
    const montoTotal = montoNeto + iva + (montoExento || 0);

    return {
      montoNeto,
      montoExento: montoExento || undefined,
      tasaIva,
      iva,
      montoTotal,
    };
  }

  private static tipoNombre(tipoCodigo: number): string {
    const nombres: Record<number, string> = {
      33: 'Factura Electrónica',
      34: 'Factura No Afecta o Exenta',
      39: 'Boleta Electrónica',
      41: 'Boleta Exenta Electrónica',
      52: 'Guía de Despacho Electrónica',
      56: 'Nota de Débito Electrónica',
      61: 'Nota de Crédito Electrónica',
    };
    return nombres[tipoCodigo] || `DTE tipo ${tipoCodigo}`;
  }

  static async queryEstado(empresaRut: string, trackId: string) {
    return DteUploadService.queryEstado(empresaRut, trackId);
  }
}
