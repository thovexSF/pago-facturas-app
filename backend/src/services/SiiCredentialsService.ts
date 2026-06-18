export interface SiiCredentials {
  username: string;
  password: string;
  companies: string[];
  /** Clave de firma electrónica SII (para firmar DTE al guardar). Si no se setea, se usa password. */
  firmaClave: string;
}

export class SiiCredentialsService {
  private static instance: SiiCredentialsService;

  private constructor() {}

  static getInstance(): SiiCredentialsService {
    if (!SiiCredentialsService.instance) {
      SiiCredentialsService.instance = new SiiCredentialsService();
    }
    return SiiCredentialsService.instance;
  }

  private static siiUsername(): string {
    return (
      process.env.SII_USERNAME?.trim() ||
      process.env.SII_RUT?.trim() ||
      ''
    );
  }

  hasCredentials(): boolean {
    return !!(SiiCredentialsService.siiUsername() && process.env.SII_PASSWORD?.trim());
  }

  getCredentials(): SiiCredentials | null {
    const username = SiiCredentialsService.siiUsername();
    const password = process.env.SII_PASSWORD?.trim();
    if (!username || !password) return null;
    const companies: string[] = [];
    const c1 = process.env.SII_COMPANY1?.trim();
    const c2 = process.env.SII_COMPANY2?.trim();
    if (c1) companies.push(c1);
    if (c2) companies.push(c2);
    // SII_FIRMA_CLAVE: clave para firmar DTE. Si no está seteada, fallback a SII_PASSWORD.
    const firmaClave = process.env.SII_FIRMA_CLAVE?.trim() || password;
    return { username, password, companies, firmaClave };
  }
}
