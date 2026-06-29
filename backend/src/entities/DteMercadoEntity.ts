import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('sii_dte_mercado')
@Index(['empresaRut', 'tipoCodigo', 'folio'], { unique: true })
export class DteMercadoEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'empresa_rut', type: 'varchar', length: 50 })
  empresaRut: string;

  @Column({ name: 'tipo_codigo', type: 'int' })
  tipoCodigo: number;

  @Column({ type: 'int' })
  folio: number;

  @Column({ name: 'rut_receptor', type: 'varchar', length: 50 })
  rutReceptor: string;

  @Column({ name: 'razon_social_receptor', type: 'varchar', length: 255, nullable: true })
  razonSocialReceptor: string | null;

  @Column({ name: 'monto_total', type: 'int' })
  montoTotal: number;

  @Column({ name: 'fecha_emision', type: 'varchar', length: 10 })
  fechaEmision: string;

  @Column({ name: 'dte_xml', type: 'text' })
  dteXml: string;

  @Column({ name: 'envio_xml', type: 'text', nullable: true })
  envioXml: string | null;

  @Column({ name: 'track_id', type: 'varchar', length: 100, nullable: true })
  trackId: string | null;

  @Column({ type: 'varchar', length: 50, default: 'enviado' })
  estado: string;

  @Column({ name: 'sii_response', type: 'jsonb', nullable: true })
  siiResponse: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
