import { XMLParser } from 'fast-xml-parser';
import * as forge from 'node-forge';
import { AppDataSource } from '../../config/database';
import { CafEntity } from '../../entities/CafEntity';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

export interface CafData {
  rut: string;
  razonSocial: string;
  tipoCodigo: number;
  folioDesde: number;
  folioHasta: number;
  fechaAutorizacion: string;
  privateKeyPem: string;
  publicKeyModulus: string;
  publicKeyExponent: string;
  cafXmlFragment: string;
}

export class CafService {
  private static repo() {
    return AppDataSource.getRepository(CafEntity);
  }

  static parseCafXml(cafXml: string): CafData {
    const parsed = parser.parse(cafXml);
    const autorizacion = parsed?.AUTORIZACION || parsed;
    const caf = autorizacion?.CAF || parsed?.CAF;
    if (!caf) throw new Error('XML CAF inválido: no se encontró nodo CAF');

    const da = caf.DA;
    const re = String(da.RE);
    const rs = String(da.RS);
    const td = Number(da.TD);
    const d = Number(da.RNG?.D);
    const h = Number(da.RNG?.H);
    const fa = String(da.FA);

    const rsapk = da.RSAPK;
    const modulus = String(rsapk?.M || '');
    const exponent = String(rsapk?.E || '');

    const rsapubk = da.RSAPUBK;
    let privateKeyPem = '';
    if (autorizacion?.RSASK) {
      privateKeyPem = autorizacion.RSASK;
      if (!privateKeyPem.includes('-----BEGIN')) {
        privateKeyPem = `-----BEGIN RSA PRIVATE KEY-----\n${privateKeyPem}\n-----END RSA PRIVATE KEY-----`;
      }
    } else if (autorizacion?.RSASK_PEM) {
      privateKeyPem = autorizacion.RSASK_PEM;
    }

    const cafStart = cafXml.indexOf('<CAF');
    const cafEnd = cafXml.indexOf('</CAF>');
    const cafXmlFragment = cafEnd > cafStart
      ? cafXml.substring(cafStart, cafEnd + '</CAF>'.length)
      : '';

    return {
      rut: re,
      razonSocial: rs,
      tipoCodigo: td,
      folioDesde: d,
      folioHasta: h,
      fechaAutorizacion: fa,
      privateKeyPem,
      publicKeyModulus: modulus,
      publicKeyExponent: exponent,
      cafXmlFragment,
    };
  }

  static async importCaf(empresaRut: string, cafXml: string): Promise<CafEntity> {
    const data = this.parseCafXml(cafXml);
    const repo = this.repo();

    const existing = await repo.findOne({
      where: { empresaRut, tipoCodigo: data.tipoCodigo, folioDesde: data.folioDesde },
    });
    if (existing) {
      existing.cafXml = data.cafXmlFragment;
      existing.privateKeyPem = data.privateKeyPem;
      existing.folioHasta = data.folioHasta;
      return repo.save(existing);
    }

    const entity = repo.create({
      empresaRut,
      tipoCodigo: data.tipoCodigo,
      folioDesde: data.folioDesde,
      folioHasta: data.folioHasta,
      folioActual: data.folioDesde,
      cafXml: data.cafXmlFragment,
      privateKeyPem: data.privateKeyPem,
      agotado: false,
    });
    return repo.save(entity);
  }

  static async getNextFolio(
    empresaRut: string,
    tipoCodigo: number,
  ): Promise<{ folio: number; cafEntity: CafEntity }> {
    return AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CafEntity);
      const caf = await repo
        .createQueryBuilder('caf')
        .setLock('pessimistic_write')
        .where('caf.empresa_rut = :empresaRut', { empresaRut })
        .andWhere('caf.tipo_codigo = :tipoCodigo', { tipoCodigo })
        .andWhere('caf.agotado = false')
        .andWhere('caf.folio_actual <= caf.folio_hasta')
        .orderBy('caf.folio_desde', 'ASC')
        .getOne();

      if (!caf) {
        throw new Error(
          `Sin folios CAF disponibles para tipo ${tipoCodigo}. Importe un nuevo archivo CAF desde el SII.`,
        );
      }

      const folio = caf.folioActual;
      caf.folioActual = folio + 1;
      if (caf.folioActual > caf.folioHasta) {
        caf.agotado = true;
      }
      await repo.save(caf);

      const remaining = caf.folioHasta - caf.folioActual + 1;
      if (remaining <= 10 && remaining > 0) {
        console.warn(
          `[CafService] Quedan ${remaining} folios para tipo ${tipoCodigo} (rango ${caf.folioDesde}-${caf.folioHasta})`,
        );
      }

      return { folio, cafEntity: caf };
    });
  }

  static async getStatus(empresaRut: string): Promise<Array<{
    tipoCodigo: number;
    folioDesde: number;
    folioHasta: number;
    folioActual: number;
    restantes: number;
    agotado: boolean;
  }>> {
    const cafs = await this.repo().find({
      where: { empresaRut },
      order: { tipoCodigo: 'ASC', folioDesde: 'ASC' },
    });
    return cafs.map((c) => ({
      tipoCodigo: c.tipoCodigo,
      folioDesde: c.folioDesde,
      folioHasta: c.folioHasta,
      folioActual: c.folioActual,
      restantes: c.agotado ? 0 : Math.max(0, c.folioHasta - c.folioActual + 1),
      agotado: c.agotado,
    }));
  }
}
