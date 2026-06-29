import { XmlSigningService } from './XmlSigningService';

const SII_DTE_NS = 'http://www.sii.cl/SiiDte';

export interface DteEmisor {
  rut: string;
  razonSocial: string;
  giro: string;
  acteco: string;
  dirOrigen: string;
  cmnaOrigen: string;
  ciudadOrigen: string;
  telefono?: string;
  correo?: string;
  cdgSIISucur?: string;
}

export interface DteReceptor {
  rut: string;
  razonSocial: string;
  giro?: string;
  dirRecep?: string;
  cmnaRecep?: string;
  ciudadRecep?: string;
  correo?: string;
}

export interface DteItem {
  nroLinDet: number;
  nombre: string;
  descripcion?: string;
  cantidad: number;
  unidad?: string;
  precioUnitario: number;
  montoItem: number;
  indExe?: number;
}

export interface DteDescuentoGlobal {
  nroLinDR: number;
  tipoMovimiento: 'D' | 'R';
  glosa: string;
  tipoValor: '%' | '$';
  valor: number;
}

export interface DteReferencia {
  nroLinRef: number;
  tipoDocRef: string;
  folioRef: string;
  fechaRef: string;
  codRef?: number;
  razonRef?: string;
}

export interface DteTotales {
  montoNeto?: number;
  montoExento?: number;
  tasaIva?: number;
  iva?: number;
  montoTotal: number;
}

export interface DteDocumentoInput {
  tipoCodigo: number;
  folio: number;
  fechaEmision: string;
  fmaPago?: number;
  indServicio?: number;
  emisor: DteEmisor;
  receptor: DteReceptor;
  totales: DteTotales;
  items: DteItem[];
  descuentosGlobales?: DteDescuentoGlobal[];
  referencias?: DteReferencia[];
  cafXml: string;
  cafPrivateKeyPem: string;
}

function esc(val: string | number | undefined): string {
  if (val === undefined || val === null) return '';
  return String(val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tag(name: string, value: string | number | undefined, opts?: { omitEmpty?: boolean }): string {
  if (value === undefined || value === null || (opts?.omitEmpty && value === '')) return '';
  return `<${name}>${esc(value)}</${name}>`;
}

export class DteXmlBuilder {
  static buildDocumentoId(tipoCodigo: number, folio: number): string {
    return `F${folio}T${tipoCodigo}`;
  }

  static buildDocumentoXml(input: DteDocumentoInput): string {
    const docId = this.buildDocumentoId(input.tipoCodigo, input.folio);

    const encabezado = this.buildEncabezado(input);
    const detalle = input.items.map((it) => this.buildDetalle(it)).join('\n');
    const dscRcg = (input.descuentosGlobales || [])
      .map((d) => this.buildDscRcgGlobal(d))
      .join('\n');
    const refs = (input.referencias || [])
      .map((r) => this.buildReferencia(r))
      .join('\n');

    const ted = this.buildTED(input);
    const tmstFirma = new Date().toISOString().replace(/\.\d{3}Z$/, '');

    return (
      `<Documento ID="${docId}">\n` +
      encabezado + '\n' +
      detalle + '\n' +
      (dscRcg ? dscRcg + '\n' : '') +
      (refs ? refs + '\n' : '') +
      ted + '\n' +
      tag('TmstFirma', tmstFirma) + '\n' +
      `</Documento>`
    );
  }

  private static buildEncabezado(input: DteDocumentoInput): string {
    const { tipoCodigo, folio, fechaEmision, fmaPago, indServicio, emisor, receptor, totales } = input;

    let idDoc = '<IdDoc>\n';
    idDoc += tag('TipoDTE', tipoCodigo) + '\n';
    idDoc += tag('Folio', folio) + '\n';
    idDoc += tag('FchEmis', fechaEmision) + '\n';
    if (indServicio) idDoc += tag('IndServicio', indServicio) + '\n';
    if (fmaPago) idDoc += tag('FmaPago', fmaPago) + '\n';
    idDoc += '</IdDoc>';

    let em = '<Emisor>\n';
    em += tag('RUTEmisor', emisor.rut) + '\n';
    em += tag('RznSoc', emisor.razonSocial) + '\n';
    em += tag('GiroEmis', emisor.giro) + '\n';
    em += tag('Acteco', emisor.acteco) + '\n';
    if (emisor.cdgSIISucur) em += tag('CdgSIISucur', emisor.cdgSIISucur) + '\n';
    em += tag('DirOrigen', emisor.dirOrigen) + '\n';
    em += tag('CmnaOrigen', emisor.cmnaOrigen) + '\n';
    em += tag('CiudadOrigen', emisor.ciudadOrigen) + '\n';
    if (emisor.telefono) em += tag('Telefono', emisor.telefono) + '\n';
    if (emisor.correo) em += tag('CorreoEmisor', emisor.correo) + '\n';
    em += '</Emisor>';

    let rec = '<Receptor>\n';
    rec += tag('RUTRecep', receptor.rut) + '\n';
    rec += tag('RznSocRecep', receptor.razonSocial) + '\n';
    if (receptor.giro) rec += tag('GiroRecep', receptor.giro) + '\n';
    if (receptor.dirRecep) rec += tag('DirRecep', receptor.dirRecep) + '\n';
    if (receptor.cmnaRecep) rec += tag('CmnaRecep', receptor.cmnaRecep) + '\n';
    if (receptor.ciudadRecep) rec += tag('CiudadRecep', receptor.ciudadRecep) + '\n';
    if (receptor.correo) rec += tag('CorreoRecep', receptor.correo) + '\n';
    rec += '</Receptor>';

    let tot = '<Totales>\n';
    if (totales.montoNeto !== undefined) tot += tag('MntNeto', totales.montoNeto) + '\n';
    if (totales.montoExento !== undefined) tot += tag('MntExe', totales.montoExento) + '\n';
    if (totales.tasaIva !== undefined) tot += tag('TasaIVA', totales.tasaIva) + '\n';
    if (totales.iva !== undefined) tot += tag('IVA', totales.iva) + '\n';
    tot += tag('MntTotal', totales.montoTotal) + '\n';
    tot += '</Totales>';

    return `<Encabezado>\n${idDoc}\n${em}\n${rec}\n${tot}\n</Encabezado>`;
  }

  private static buildDetalle(item: DteItem): string {
    let xml = '<Detalle>\n';
    xml += tag('NroLinDet', item.nroLinDet) + '\n';
    if (item.indExe) xml += tag('IndExe', item.indExe) + '\n';
    xml += tag('NmbItem', item.nombre) + '\n';
    if (item.descripcion) xml += tag('DscItem', item.descripcion) + '\n';
    xml += tag('QtyItem', item.cantidad) + '\n';
    if (item.unidad) xml += tag('UnmdItem', item.unidad) + '\n';
    xml += tag('PrcItem', item.precioUnitario) + '\n';
    xml += tag('MontoItem', item.montoItem) + '\n';
    xml += '</Detalle>';
    return xml;
  }

  private static buildDscRcgGlobal(d: DteDescuentoGlobal): string {
    let xml = '<DscRcgGlobal>\n';
    xml += tag('NroLinDR', d.nroLinDR) + '\n';
    xml += tag('TpoMov', d.tipoMovimiento) + '\n';
    xml += tag('GlosaDR', d.glosa) + '\n';
    xml += tag('TpoValor', d.tipoValor) + '\n';
    xml += tag('ValorDR', d.valor) + '\n';
    xml += '</DscRcgGlobal>';
    return xml;
  }

  private static buildReferencia(r: DteReferencia): string {
    let xml = '<Referencia>\n';
    xml += tag('NroLinRef', r.nroLinRef) + '\n';
    xml += tag('TpoDocRef', r.tipoDocRef) + '\n';
    xml += tag('FolioRef', r.folioRef) + '\n';
    xml += tag('FchRef', r.fechaRef) + '\n';
    if (r.codRef) xml += tag('CodRef', r.codRef) + '\n';
    if (r.razonRef) xml += tag('RazonRef', r.razonRef) + '\n';
    xml += '</Referencia>';
    return xml;
  }

  private static buildTED(input: DteDocumentoInput): string {
    const { tipoCodigo, folio, fechaEmision, emisor, receptor, totales, items } = input;
    const firstItem = items[0]?.nombre || '';
    const tmst = new Date().toISOString().replace(/\.\d{3}Z$/, '');

    const dd =
      `<DD>` +
      tag('RE', emisor.rut) +
      tag('TD', tipoCodigo) +
      tag('F', folio) +
      tag('FE', fechaEmision) +
      tag('RR', receptor.rut) +
      tag('RSR', receptor.razonSocial) +
      tag('MNT', totales.montoTotal) +
      tag('IT1', firstItem) +
      input.cafXml +
      tag('TSTED', tmst) +
      `</DD>`;

    const frmt = XmlSigningService.signTED(dd, input.cafPrivateKeyPem);

    return (
      `<TED version="1.0">` +
      dd +
      `<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT>` +
      `</TED>`
    );
  }

  static buildEnvioDTE(params: {
    rutEmisor: string;
    rutEnvia: string;
    fchResol: string;
    nroResol: number;
    documentosXml: Array<{ tipoCodigo: number; xml: string }>;
  }): string {
    const { rutEmisor, rutEnvia, fchResol, nroResol, documentosXml } = params;
    const tmst = new Date().toISOString().replace(/\.\d{3}Z$/, '');

    const countByType = new Map<number, number>();
    for (const d of documentosXml) {
      countByType.set(d.tipoCodigo, (countByType.get(d.tipoCodigo) || 0) + 1);
    }
    const subTotDte = Array.from(countByType.entries())
      .map(([tipo, count]) => `<SubTotDTE>${tag('TpoDTE', tipo)}${tag('NroDTE', count)}</SubTotDTE>`)
      .join('\n');

    const caratula =
      `<Caratula version="1.0">\n` +
      tag('RutEmisor', rutEmisor) + '\n' +
      tag('RutEnvia', rutEnvia) + '\n' +
      tag('RutReceptor', '60803000-K') + '\n' +
      tag('FchResol', fchResol) + '\n' +
      tag('NroResol', nroResol) + '\n' +
      tag('TmstFirmaEnv', tmst) + '\n' +
      subTotDte + '\n' +
      `</Caratula>`;

    const dtes = documentosXml.map((d) => {
      const docId = d.xml.match(/ID="([^"]+)"/)?.[1] || '';
      const signedDoc = XmlSigningService.signXml(
        `<DTE version="1.0">\n${d.xml}\n</DTE>`,
        docId,
      );
      return signedDoc;
    }).join('\n');

    const setDte =
      `<SetDTE ID="SetDoc">\n` +
      caratula + '\n' +
      dtes + '\n' +
      `</SetDTE>`;

    const envioInner =
      `<EnvioDTE xmlns="${SII_DTE_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${SII_DTE_NS} EnvioDTE_v10.xsd" version="1.0">\n` +
      setDte + '\n' +
      `</EnvioDTE>`;

    return XmlSigningService.signXml(envioInner, 'SetDoc');
  }

  static buildEnvioBoleta(params: {
    rutEmisor: string;
    rutEnvia: string;
    fchResol: string;
    nroResol: number;
    documentosXml: Array<{ tipoCodigo: number; xml: string }>;
  }): string {
    const { rutEmisor, rutEnvia, fchResol, nroResol, documentosXml } = params;
    const tmst = new Date().toISOString().replace(/\.\d{3}Z$/, '');

    const countByType = new Map<number, number>();
    for (const d of documentosXml) {
      countByType.set(d.tipoCodigo, (countByType.get(d.tipoCodigo) || 0) + 1);
    }
    const subTotDte = Array.from(countByType.entries())
      .map(([tipo, count]) => `<SubTotDTE>${tag('TpoDTE', tipo)}${tag('NroDTE', count)}</SubTotDTE>`)
      .join('\n');

    const caratula =
      `<Caratula version="1.0">\n` +
      tag('RutEmisor', rutEmisor) + '\n' +
      tag('RutEnvia', rutEnvia) + '\n' +
      tag('RutReceptor', '60803000-K') + '\n' +
      tag('FchResol', fchResol) + '\n' +
      tag('NroResol', nroResol) + '\n' +
      tag('TmstFirmaEnv', tmst) + '\n' +
      subTotDte + '\n' +
      `</Caratula>`;

    const dtes = documentosXml.map((d) => {
      const docId = d.xml.match(/ID="([^"]+)"/)?.[1] || '';
      const signedDoc = XmlSigningService.signXml(
        `<DTE version="1.0">\n${d.xml}\n</DTE>`,
        docId,
      );
      return signedDoc;
    }).join('\n');

    const setDte =
      `<SetDTE ID="SetDoc">\n` +
      caratula + '\n' +
      dtes + '\n' +
      `</SetDTE>`;

    const envioInner =
      `<EnvioBOLETA xmlns="${SII_DTE_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${SII_DTE_NS} EnvioBOLETA_v11.xsd" version="1.0">\n` +
      setDte + '\n' +
      `</EnvioBOLETA>`;

    return XmlSigningService.signXml(envioInner, 'SetDoc');
  }
}
