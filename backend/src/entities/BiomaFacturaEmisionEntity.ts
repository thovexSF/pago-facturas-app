import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type BiomaFacturaStatus = 'pending' | 'drafting' | 'emitting' | 'emitted' | 'error';

/**
 * Tracks which Shopify orders (for Bioma) have been turned into SII facturas.
 * Each Shopify order has at most one factura emission row.
 */
@Entity('bioma_factura_emisiones')
@Index(['shopifyOrderId'], { unique: true })
export class BiomaFacturaEmisionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  /** Shopify GraphQL gid, e.g. `gid://shopify/Order/1234567890` */
  @Column({ name: 'shopify_order_id', type: 'varchar', length: 255 })
  shopifyOrderId: string;

  /** Human-friendly order name from Shopify, e.g. `#3549` */
  @Column({ name: 'shopify_order_name', type: 'varchar', length: 50 })
  shopifyOrderName: string;

  /** Numeric order number (3549) for sorting / display */
  @Column({ name: 'shopify_order_number', type: 'int', nullable: true })
  shopifyOrderNumber: number | null;

  /** Empresa emisora (RUT del emisor en SII) — por defecto el de Bioma */
  @Column({ name: 'empresa_rut', type: 'varchar', length: 50 })
  empresaRut: string;

  /** Receptor data snapshot at the moment of emission */
  @Column({ name: 'rut_receptor', type: 'varchar', length: 50, nullable: true })
  rutReceptor: string | null;

  @Column({ name: 'razon_social', type: 'varchar', length: 255, nullable: true })
  razonSocial: string | null;

  @Column({ name: 'giro_receptor', type: 'varchar', length: 255, nullable: true })
  giroReceptor: string | null;

  @Column({ name: 'comuna_receptor', type: 'varchar', length: 100, nullable: true })
  comunaReceptor: string | null;

  @Column({ name: 'ciudad_receptor', type: 'varchar', length: 100, nullable: true })
  ciudadReceptor: string | null;

  @Column({ name: 'dir_receptor', type: 'varchar', length: 255, nullable: true })
  dirReceptor: string | null;

  /** Telefono del cliente, normalizado para wa.me (digits-only with country code) */
  @Column({ name: 'customer_phone', type: 'varchar', length: 30, nullable: true })
  customerPhone: string | null;

  @Column({ name: 'customer_name', type: 'varchar', length: 255, nullable: true })
  customerName: string | null;

  @Column({ name: 'customer_email', type: 'varchar', length: 255, nullable: true })
  customerEmail: string | null;

  /** Items as sent to SII */
  @Column({ type: 'jsonb', nullable: true })
  items: Array<{
    descripcion: string;
    cantidad: number;
    precioUnitario: number;
    subtotal: number;
  }> | null;

  /** Tipo DTE (33 = afecta, 34 = exenta). Default 33. */
  @Column({ name: 'tipo_codigo', type: 'int', default: 33 })
  tipoCodigo: number;

  /** Result from SII once emitted */
  @Column({ name: 'sii_codigo', type: 'varchar', length: 255, nullable: true })
  siiCodigo: string | null;

  @Column({ name: 'sii_folio', type: 'int', nullable: true })
  siiFolio: number | null;

  @Column({ name: 'sii_track_id', type: 'varchar', length: 255, nullable: true })
  siiTrackId: string | null;

  /** Lifecycle status */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: BiomaFacturaStatus;

  /** Last error message if status='error' */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** Whether the customer has been messaged via WhatsApp (set by UI button) */
  @Column({ name: 'whatsapp_sent_at', type: 'timestamp', nullable: true })
  whatsappSentAt: Date | null;

  @Column({ name: 'emitted_at', type: 'timestamp', nullable: true })
  emittedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
