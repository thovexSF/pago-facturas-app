import * as fs from 'fs';
import * as forge from 'node-forge';
import { MercadoConfig } from './MercadoConfig';

export interface CertificateData {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
  privateKeyPem: string;
  certificatePem: string;
  certificateDer: string;
  subjectRut: string | null;
  notAfter: Date;
}

let cached: CertificateData | null = null;

export class CertificateService {
  static load(): CertificateData {
    if (cached) return cached;

    const certPass = MercadoConfig.getCertPass();
    const certBase64Env = process.env.SII_CERT_BASE64;
    const p12Buffer = certBase64Env
      ? Buffer.from(certBase64Env, 'base64')
      : fs.readFileSync(MercadoConfig.getCertPath());
    const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, certPass);

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });

    const keyBag = (keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] || [])[0];
    const certBag = (certBags[forge.pki.oids.certBag] || [])[0];

    if (!keyBag?.key) throw new Error('No se encontró llave privada en el certificado .p12');
    if (!certBag?.cert) throw new Error('No se encontró certificado en el archivo .p12');

    const privateKey = keyBag.key as forge.pki.rsa.PrivateKey;
    const certificate = certBag.cert;
    const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
    const certificatePem = forge.pki.certificateToPem(certificate);

    const certDerBytes = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
    const certificateDer = forge.util.encode64(certDerBytes);

    let subjectRut: string | null = null;
    const serialNumber = certificate.subject.getField({ name: 'serialNumber' });
    if (serialNumber) {
      subjectRut = String(serialNumber.value);
    }

    if (certificate.validity.notAfter < new Date()) {
      console.warn(`[CertificateService] Certificado expirado: ${certificate.validity.notAfter.toISOString()}`);
    }

    cached = {
      privateKey,
      certificate,
      privateKeyPem,
      certificatePem,
      certificateDer,
      subjectRut,
      notAfter: certificate.validity.notAfter,
    };
    return cached;
  }

  static getPrivateKeyPem(): string {
    return this.load().privateKeyPem;
  }

  static getCertificatePem(): string {
    return this.load().certificatePem;
  }

  static getCertificateBase64(): string {
    return this.load().certificateDer;
  }

  static getModulusBase64(): string {
    const pk = this.load().privateKey;
    const mod = (pk as any).n as forge.jsbn.BigInteger;
    const hex = mod.toString(16);
    const padded = hex.length % 2 ? '0' + hex : hex;
    const bytes = forge.util.hexToBytes(padded);
    return forge.util.encode64(bytes);
  }

  static getExponentBase64(): string {
    const pk = this.load().privateKey;
    const exp = (pk as any).e as forge.jsbn.BigInteger;
    const hex = exp.toString(16);
    const padded = hex.length % 2 ? '0' + hex : hex;
    const bytes = forge.util.hexToBytes(padded);
    return forge.util.encode64(bytes);
  }

  static clearCache(): void {
    cached = null;
  }
}
