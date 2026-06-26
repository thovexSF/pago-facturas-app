import { Box, IconButton, Tab, Tabs, Tooltip } from '@mui/material';
import StarIcon from '@mui/icons-material/esm/Star.js';
import StarBorderIcon from '@mui/icons-material/esm/StarBorder.js';
import type { FacturacionModule } from '../utils/modulePreference';

type Props = {
  value: FacturacionModule;
  defaultModule: FacturacionModule;
  onChange: (mod: FacturacionModule) => void;
  onSetDefault: (mod: FacturacionModule) => void;
};

function TabLabel({
  label,
  mod,
  isDefault,
  onSetDefault,
}: {
  label: string;
  mod: FacturacionModule;
  isDefault: boolean;
  onSetDefault: (mod: FacturacionModule) => void;
}) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
      {label}
      <Tooltip title={isDefault ? 'Pestaña por defecto' : 'Marcar como pestaña por defecto'}>
        <IconButton
          size="small"
          aria-label={isDefault ? `${label} es la pestaña por defecto` : `Marcar ${label} como pestaña por defecto`}
          onClick={(e) => {
            e.stopPropagation();
            onSetDefault(mod);
          }}
          sx={{
            p: 0.25,
            color: isDefault ? '#d69e2e' : 'action.disabled',
            '&:hover': { color: isDefault ? '#b7791f' : 'action.active' },
          }}
        >
          {isDefault ? (
            <StarIcon sx={{ fontSize: 16 }} />
          ) : (
            <StarBorderIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export default function FacturacionModuleTabs({ value, defaultModule, onChange, onSetDefault }: Props) {
  return (
    <Tabs
      value={value}
      onChange={(_, mod: FacturacionModule) => onChange(mod)}
      sx={{ mb: 2.5, borderBottom: '2px solid #e2e8f0' }}
    >
      <Tab
        value="clientes"
        label={
          <TabLabel
            label="Clientes"
            mod="clientes"
            isDefault={defaultModule === 'clientes'}
            onSetDefault={onSetDefault}
          />
        }
      />
      <Tab
        value="proveedores"
        label={
          <TabLabel
            label="Proveedores"
            mod="proveedores"
            isDefault={defaultModule === 'proveedores'}
            onSetDefault={onSetDefault}
          />
        }
      />
    </Tabs>
  );
}
