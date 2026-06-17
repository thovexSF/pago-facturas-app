import { Box, Typography } from '@mui/material';

type StatVariant = 'default' | 'warning' | 'amount' | 'success';

const valueColors: Record<StatVariant, string> = {
  default: '#2d3748',
  warning: '#e53e3e',
  amount: '#2b6cb0',
  success: '#276749',
};

export default function StatCard({
  value,
  label,
  variant = 'default',
}: {
  value: string | number;
  label: string;
  variant?: StatVariant;
}) {
  return (
    <Box
      sx={{
        bgcolor: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: '10px',
        px: 2.5,
        py: 2,
      }}
    >
      <Typography
        sx={{
          fontSize: 26,
          fontWeight: 700,
          lineHeight: 1.1,
          color: valueColors[variant],
        }}
      >
        {value}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
        {label}
      </Typography>
    </Box>
  );
}
