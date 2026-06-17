export function workbenchBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return (
      (window as unknown as { ENV?: { WORKBENCH_API_URL?: string } }).ENV?.WORKBENCH_API_URL ||
      'http://localhost:3890'
    );
  }
  return process.env.WORKBENCH_API_URL || 'http://localhost:3890';
}

export const BIOMA_API = () => `${workbenchBaseUrl()}/api/bioma`;
export const SII_API = () => `${workbenchBaseUrl()}/api/sii-facturacion`;
