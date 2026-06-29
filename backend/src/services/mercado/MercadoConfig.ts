export type SiiEnvironment = 'cert' | 'prod';

const HOSTS: Record<SiiEnvironment, string> = {
  cert: 'maullin.sii.cl',
  prod: 'palena.sii.cl',
};

export class MercadoConfig {
  static getEnv(): SiiEnvironment {
    return process.env.SII_ENV === 'prod' ? 'prod' : 'cert';
  }

  static getHost(): string {
    return HOSTS[this.getEnv()];
  }

  static getCertPath(): string {
    const p = process.env.SII_CERT_PATH;
    if (!p) throw new Error('SII_CERT_PATH o SII_CERT_BASE64 no configurado');
    return p;
  }

  static getCertPass(): string {
    return process.env.SII_CERT_PASS || '';
  }

  static isMercadoMode(): boolean {
    return process.env.SII_MODE === 'mercado';
  }

  static getEmisorRut(): string {
    const rut = process.env.BIOMA_EMPRESA_RUT;
    if (!rut) throw new Error('BIOMA_EMPRESA_RUT no configurado');
    return rut;
  }

  static getUrls() {
    const host = this.getHost();
    return {
      semilla: `https://${host}/DTEWS/CrSeed.jws?WSDL`,
      token: `https://${host}/DTEWS/GetTokenFromSeed.jws?WSDL`,
      upload: `https://${host}/cgi_dte/UPL/DTEUpload`,
      queryEstado: `https://${host}/DTEWS/QueryEstDte.jws?WSDL`,
      queryEstadoAvanzado: `https://${host}/DTEWS/services/QueryEstDteAv?wsdl`,
    };
  }
}
