import 'reflect-metadata';
import dotenv from 'dotenv';
import path from 'path';
import { DataSource } from 'typeorm';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import { SiiFacturaEntity } from '../entities/SiiFacturaEntity';
import { SiiContactoEntity } from '../entities/SiiContactoEntity';
import { WorkbenchClient } from '../entities/WorkbenchClient';
import { BiomaFacturaEmisionEntity } from '../entities/BiomaFacturaEmisionEntity';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL es requerido (PostgreSQL, ej. postgresql://user:pass@localhost:5432/sii_workbench)');
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: process.env.TYPEORM_SYNC !== 'false',
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [SiiFacturaEntity, SiiContactoEntity, WorkbenchClient, BiomaFacturaEmisionEntity],
});
