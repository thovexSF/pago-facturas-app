import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { MercadoConfig } from './MercadoConfig';
import { XmlSigningService } from './XmlSigningService';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 min (SII tokens last ~60 min)

export class SiiAuthService {
  static async getSemilla(): Promise<string> {
    const url = MercadoConfig.getUrls().semilla;
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getSeed/></soapenv:Body>
</soapenv:Envelope>`;

    const resp = await axios.post(url, soapBody, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: 15000,
    });

    const parsed = parser.parse(resp.data);
    const respBody =
      parsed?.Envelope?.Body?.getSeedResponse?.getSeedReturn ||
      resp.data;

    const innerParsed = typeof respBody === 'string' ? parser.parse(respBody) : respBody;
    const estado = innerParsed?.RESPUESTA?.RESP_HDR?.ESTADO ?? innerParsed?.RESP_HDR?.ESTADO;
    const semilla = innerParsed?.RESPUESTA?.RESP_BODY?.SEMILLA ?? innerParsed?.RESP_BODY?.SEMILLA;

    if (String(estado) !== '00' || !semilla) {
      throw new Error(`SII getSemilla falló: estado=${estado}, respuesta=${JSON.stringify(innerParsed)}`);
    }
    return String(semilla);
  }

  static async getToken(semillaFirmada: string): Promise<string> {
    const url = MercadoConfig.getUrls().token;
    const encoded = semillaFirmada
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body><getToken><pszXml>${encoded}</pszXml></getToken></soapenv:Body>
</soapenv:Envelope>`;

    const resp = await axios.post(url, soapBody, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: 15000,
    });

    const parsed = parser.parse(resp.data);
    const respBody =
      parsed?.Envelope?.Body?.getTokenResponse?.getTokenReturn ||
      resp.data;

    const innerParsed = typeof respBody === 'string' ? parser.parse(respBody) : respBody;
    const estado = innerParsed?.RESPUESTA?.RESP_HDR?.ESTADO ?? innerParsed?.RESP_HDR?.ESTADO;
    const token = innerParsed?.RESPUESTA?.RESP_BODY?.TOKEN ?? innerParsed?.RESP_BODY?.TOKEN;

    if (String(estado) !== '00' || !token) {
      throw new Error(`SII getToken falló: estado=${estado}, respuesta=${JSON.stringify(innerParsed)}`);
    }
    return String(token);
  }

  static async authenticate(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
      return cachedToken.token;
    }

    const semilla = await this.getSemilla();
    const semillaFirmada = XmlSigningService.signSemilla(semilla);
    const token = await this.getToken(semillaFirmada);

    cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    console.log(`[SiiAuth] Token obtenido (env: ${MercadoConfig.getEnv()})`);
    return token;
  }

  static clearToken(): void {
    cachedToken = null;
  }
}
