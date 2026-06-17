export const useAuth = () => ({
  token: import.meta.env.VITE_AUTH_BEARER || 'workbench-local',
  user: null as null,
  isAuthenticated: true,
  login: async (_t: string, _u: unknown) => {},
  logout: () => {},
  checkUserStatus: async () => {},
});
