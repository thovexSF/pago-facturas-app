import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('sii_caf')
@Index(['empresaRut', 'tipoCodigo', 'folioDesde'], { unique: true })
export class CafEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'empresa_rut', type: 'varchar', length: 50 })
  empresaRut: string;

  @Column({ name: 'tipo_codigo', type: 'int' })
  tipoCodigo: number;

  @Column({ name: 'folio_desde', type: 'int' })
  folioDesde: number;

  @Column({ name: 'folio_hasta', type: 'int' })
  folioHasta: number;

  @Column({ name: 'folio_actual', type: 'int' })
  folioActual: number;

  @Column({ name: 'caf_xml', type: 'text' })
  cafXml: string;

  @Column({ name: 'private_key_pem', type: 'text' })
  privateKeyPem: string;

  @Column({ name: 'agotado', type: 'boolean', default: false })
  agotado: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
