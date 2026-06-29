import * as crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import { CertificateService } from './CertificateService';

export class XmlSigningService {
  static signXml(xml: string, referenceUri: string): string {
    const privateKeyPem = CertificateService.getPrivateKeyPem();
    const certBase64 = CertificateService.getCertificateBase64();
    const modulus = CertificateService.getModulusBase64();
    const exponent = CertificateService.getExponentBase64();

    const sig = new SignedXml({
      signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
      canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      privateKey: Buffer.from(privateKeyPem),
      publicCert: Buffer.from(CertificateService.getCertificatePem()),
    });

    sig.addReference({
      xpath: referenceUri ? `//*[@ID='${referenceUri}']` : '/*',
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    });

    sig.getKeyInfoContent = () => {
      return (
        `<KeyValue><RSAKeyValue>` +
        `<Modulus>${modulus}</Modulus>` +
        `<Exponent>${exponent}</Exponent>` +
        `</RSAKeyValue></KeyValue>` +
        `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`
      );
    };

    sig.computeSignature(xml, {
      location: { reference: referenceUri ? `//*[@ID='${referenceUri}']` : '/*', action: 'append' },
    });

    return sig.getSignedXml();
  }

  static signSemilla(semilla: string): string {
    const xml = `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
    const privateKeyPem = CertificateService.getPrivateKeyPem();
    const certBase64 = CertificateService.getCertificateBase64();
    const modulus = CertificateService.getModulusBase64();
    const exponent = CertificateService.getExponentBase64();

    const sig = new SignedXml({
      signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
      canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
      privateKey: Buffer.from(privateKeyPem),
      publicCert: Buffer.from(CertificateService.getCertificatePem()),
    });

    sig.addReference({
      xpath: '/*',
      digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    });

    sig.getKeyInfoContent = () => {
      return (
        `<KeyValue><RSAKeyValue>` +
        `<Modulus>${modulus}</Modulus>` +
        `<Exponent>${exponent}</Exponent>` +
        `</RSAKeyValue></KeyValue>` +
        `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`
      );
    };

    sig.computeSignature(xml, { location: { reference: '/*', action: 'append' } });
    return sig.getSignedXml();
  }

  static signTED(ddContent: string, cafPrivateKeyPem: string): string {
    const sign = crypto.createSign('SHA1');
    sign.update(ddContent);
    sign.end();
    return sign.sign(cafPrivateKeyPem, 'base64');
  }
}
