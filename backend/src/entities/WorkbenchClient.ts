import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('workbench_clients')
export class WorkbenchClient {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20, default: 'empresa' })
  type: string;

  @Column({ type: 'varchar', length: 20 })
  rut: string;

  @Column({ name: 'rut_with_dv', type: 'varchar', length: 20, nullable: true })
  rutWithDv: string | null;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 50, default: '' })
  phone: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'business_name', type: 'varchar', length: 255, nullable: true })
  businessName: string | null;

  @Column({ name: 'razon_social', type: 'varchar', length: 255, nullable: true })
  razonSocial: string | null;

  @Column({ name: 'giro_comercial', type: 'varchar', length: 255, nullable: true })
  giroComercial: string | null;

  @Column({ type: 'varchar', length: 500 })
  address: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  commune: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
