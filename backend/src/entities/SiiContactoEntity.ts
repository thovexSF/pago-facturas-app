import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('sii_contactos')
@Index(['empresaRut', 'rutReceptor'], { unique: true })
export class SiiContactoEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'empresa_rut', type: 'varchar', length: 20 })
  empresaRut: string;

  @Column({ name: 'rut_receptor', type: 'varchar', length: 25 })
  rutReceptor: string;

  @Column({ name: 'razon_social', type: 'varchar', length: 255, nullable: true })
  razonSocial: string;

  @Column({ name: 'giro_receptor', type: 'varchar', length: 255, nullable: true })
  giroReceptor: string;

  @Column({ name: 'dir_receptor', type: 'varchar', length: 255, nullable: true })
  dirReceptor: string;

  @Column({ name: 'comuna_receptor', type: 'varchar', length: 100, nullable: true })
  comunaReceptor: string;

  @Column({ name: 'ciudad_receptor', type: 'varchar', length: 100, nullable: true })
  ciudadReceptor: string;

  @Column({ name: 'last_factura_codigo', type: 'varchar', length: 25, nullable: true })
  lastFacturaCodigo: string;

  @Column({ name: 'last_factura_fecha', type: 'varchar', length: 20, nullable: true })
  lastFacturaFecha: string;

  @Column({ name: 'last_factura_monto', type: 'double precision', nullable: true })
  lastFacturaMonto: number;

  @Column({ name: 'factura_count', type: 'int', default: 0 })
  facturaCount: number;

  @Column({ name: 'imported_to_clients', type: 'boolean', default: false })
  importedToClients: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
