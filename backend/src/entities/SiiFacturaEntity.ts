import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('sii_facturas')
@Index(['empresaRut', 'codigo'], { unique: true })
export class SiiFacturaEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'empresa_rut', type: 'varchar', length: 50 })
  empresaRut: string;

  @Column({ type: 'varchar', length: 255 })
  codigo: string;

  @Column({ name: 'rut_receptor', type: 'varchar', length: 255, nullable: true })
  rutReceptor: string;

  @Column({ name: 'razon_social', type: 'varchar', length: 255, nullable: true })
  razonSocial: string;

  @Column({ name: 'tipo_codigo', type: 'int', nullable: true })
  tipoCodigo: number;

  @Column({ name: 'tipo_documento', type: 'varchar', length: 100, nullable: true })
  tipoDocumento: string;

  @Column({ type: 'int', nullable: true })
  folio: number;

  @Column({ type: 'varchar', length: 50, nullable: true })
  fecha: string;

  @Column({ type: 'double precision', nullable: true })
  monto: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  estado: string;

  // ── Detalle (se llena en el sync) ────────────────────────────────────────
  @Column({ type: 'jsonb', nullable: true })
  items: Array<{
    numero: number;
    descripcion: string;
    cantidad: number;
    unidad: string;
    precioUnitario: number;
    descuento: number;
    subtotal: number;
    codigo?: string;
    imptoAdicPct?: number;
  }>;

  @Column({ name: 'dir_receptor', type: 'varchar', length: 255, nullable: true })
  dirReceptor: string;

  @Column({ name: 'comuna_receptor', type: 'varchar', length: 100, nullable: true })
  comunaReceptor: string;

  @Column({ name: 'ciudad_receptor', type: 'varchar', length: 100, nullable: true })
  ciudadReceptor: string;

  @Column({ name: 'giro_receptor', type: 'varchar', length: 255, nullable: true })
  giroReceptor: string;

  @Column({ name: 'forma_pago', type: 'varchar', length: 255, nullable: true })
  formaPago: string;

  /** Snapshot de campos EFXP_* del formulario «Copiar documento» del SII (emisor, transporte, etc.) */
  @Column({ name: 'detalle_extendido', type: 'jsonb', nullable: true })
  detalleExtendido: Record<string, string> | null;

  @Column({ type: 'double precision', nullable: true })
  neto: number;

  @Column({ type: 'double precision', nullable: true })
  iva: number;

  @Column({ type: 'double precision', nullable: true })
  total: number;

  @Column({ name: 'detalle_completo', type: 'boolean', default: false })
  detalleCompleto: boolean;

  @Column({ name: 'has_pdf', type: 'boolean', default: false })
  hasPdf: boolean;

  @Column({ name: 'pdf_data', type: 'bytea', nullable: true, select: false })
  pdfData: Buffer;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
