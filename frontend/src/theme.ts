import { createTheme } from '@mui/material/styles';

export const biomaTheme = createTheme({
  palette: {
    primary: { main: '#2b6cb0', dark: '#2c5282', light: '#4299e1' },
    success: { main: '#276749' },
    warning: { main: '#d69e2e' },
    error: { main: '#e53e3e' },
    text: { primary: '#1a202c', secondary: '#718096' },
    background: { default: '#f7fafc', paper: '#ffffff' },
    divider: '#e2e8f0',
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h5: { fontSize: '22px', fontWeight: 700, color: '#1a202c' },
    h6: { fontSize: '16px', fontWeight: 600 },
    body2: { fontSize: '13px' },
    caption: { fontSize: '12px', color: '#718096' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          fontSize: '13px',
          borderRadius: 6,
          boxShadow: 'none',
          '&:hover': { boxShadow: 'none' },
        },
        containedPrimary: {
          backgroundColor: '#2b6cb0',
          '&:hover': { backgroundColor: '#2c5282' },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontSize: '14px',
          fontWeight: 500,
          color: '#718096',
          minHeight: 44,
          '&.Mui-selected': { color: '#2b6cb0', fontWeight: 600 },
        },
      },
    },
    MuiTabs: {
      styleOverrides: {
        indicator: { backgroundColor: '#2b6cb0', height: 2 },
      },
    },
    MuiPaper: {
      styleOverrides: {
        outlined: { borderColor: '#e2e8f0' },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 500, fontSize: '12px' },
      },
    },
  },
});
