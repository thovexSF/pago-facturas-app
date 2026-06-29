import axios from 'axios';
import FormData from 'form-data';
import { XMLParser } from 'fast-xml-parser';
import { MercadoConfig } from './MercadoConfig';
import { SiiAuthService } from './SiiAuthService';
import { splitRutDv } from '../../utils/rutUtils';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

export interface UploadResult {
  success: boolean;
  trackId: string | null;
  status: number;
  timestamp: string;
  error?: string;
  raw?: any;
}

export interface QueryEstadoResult {
  estado: string;
  glosa: string;
  numAtencion: string;
  raw?: any;
}

export class DteUploadService {
  static async upload(
    envioXml: string,
    rutEmpresa: string,
    rutEnvia: string,
  ): Promise<UploadResult> {
    const token = await SiiAuthService.authenticate();
    const url = MercadoConfig.getUrls().upload;

    const empresa = splitRutDv(rutEmpresa);
    const sender = splitRutDv(rutEnvia);
    if (!empresa || !sender) {
      throw new Error(`RUT inválido: empresa=${rutEmpresa}, sender=${rutEnvia}`);
    }

    const form = new FormData();
    form.append('rutSender', sender.rut);
    form.append('dvSender', sender.dv);
    form.append('rutCompany', empresa.rut);
    form.append('dvCompany', empresa.dv);
    form.append('archivo', Buffer.from(envioXml, 'utf-8'), {
      filename: 'envio.xml',
      contentType: 'text/xml',
    });

    const resp = await axios.post(url, form, {
      headers: {
        ...form.getHeaders(),
        Cookie: `TOKEN=${token}`,
      },
      timeout: 30000,
    });

    const parsed = parser.parse(resp.data);
    const recepcion = parsed?.RECEPCIONDTE || parsed;

    const status = Number(recepcion?.STATUS ?? -1);
    const trackId = recepcion?.TRACKID ? String(recepcion.TRACKID) : null;
    const timestamp = recepcion?.TIMESTAMP ? String(recepcion.TIMESTAMP) : '';

    if (status !== 0) {
      return {
        success: false,
        trackId: null,
        status,
        timestamp,
        error: `SII rechazó el envío (STATUS=${status})`,
        raw: recepcion,
      };
    }

    return { success: true, trackId, status, timestamp, raw: recepcion };
  }

  static async queryEstado(
    rutEmpresa: string,
    trackId: string,
  ): Promise<QueryEstadoResult> {
    const token = await SiiAuthService.authenticate();
    const url = MercadoConfig.getUrls().queryEstado;

    const empresa = splitRutDv(rutEmpresa);
    if (!empresa) throw new Error(`RUT empresa inválido: ${rutEmpresa}`);

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getEstEnvio>
      <Token>${token}</Token>
      <TrackId>${trackId}</TrackId>
    </getEstEnvio>
  </soapenv:Body>
</soapenv:Envelope>`;

    const resp = await axios.post(url, soapBody, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        Cookie: `TOKEN=${token}`,
      },
      timeout: 15000,
    });

    const parsed = parser.parse(resp.data);
    const body = parsed?.Envelope?.Body;
    const ret = body?.getEstEnvioResponse?.getEstEnvioReturn || resp.data;
    const inner = typeof ret === 'string' ? parser.parse(ret) : ret;

    const respHdr = inner?.RESPUESTA?.RESP_HDR || inner?.RESP_HDR || {};
    return {
      estado: String(respHdr.ESTADO || ''),
      glosa: String(respHdr.GLOSA || ''),
      numAtencion: String(respHdr.NUM_ATENCION || trackId),
      raw: inner,
    };
  }

  static async queryEstadoDte(params: {
    rutEmpresa: string;
    tipoCodigo: number;
    folio: number;
    fechaEmision: string;
    montoTotal: number;
    rutReceptor: string;
  }): Promise<QueryEstadoResult> {
    const token = await SiiAuthService.authenticate();
    const host = MercadoConfig.getHost();

    const empresa = splitRutDv(params.rutEmpresa);
    const receptor = splitRutDv(params.rutReceptor);
    if (!empresa || !receptor) throw new Error('RUT inválido para consulta estado DTE');

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getEstDte>
      <RutConsultante>${empresa.rut}-${empresa.dv}</RutConsultante>
      <DvConsultante>${empresa.dv}</DvConsultante>
      <RutCompania>${empresa.rut}-${empresa.dv}</RutCompania>
      <DvCompania>${empresa.dv}</DvCompania>
      <RutReceptor>${receptor.rut}-${receptor.dv}</RutReceptor>
      <DvReceptor>${receptor.dv}</DvReceptor>
      <TipoDte>${params.tipoCodigo}</TipoDte>
      <FolioDte>${params.folio}</FolioDte>
      <FechaEmisionDte>${params.fechaEmision}</FechaEmisionDte>
      <MontoDte>${params.montoTotal}</MontoDte>
      <Token>${token}</Token>
    </getEstDte>
  </soapenv:Body>
</soapenv:Envelope>`;

    const url = `https://${host}/DTEWS/QueryEstDte.jws`;
    const resp = await axios.post(url, soapBody, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        Cookie: `TOKEN=${token}`,
      },
      timeout: 15000,
    });

    const parsed = parser.parse(resp.data);
    const body = parsed?.Envelope?.Body;
    const ret = body?.getEstDteResponse?.getEstDteReturn || resp.data;
    const inner = typeof ret === 'string' ? parser.parse(ret) : ret;
    const respHdr = inner?.RESPUESTA?.RESP_HDR || inner?.RESP_HDR || {};

    return {
      estado: String(respHdr.ESTADO || ''),
      glosa: String(respHdr.GLOSA || ''),
      numAtencion: String(respHdr.NUM_ATENCION || ''),
      raw: inner,
    };
  }
}
