import { useState, useEffect } from 'react';

export const useFontSize = () => {
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('sidebarFontSize');
    const n = saved != null ? parseFloat(saved) : 0.85;
    return Number.isFinite(n) && n > 0 ? n : 0.85;
  });

  useEffect(() => {
    const handleStorageChange = () => {
      const saved = localStorage.getItem('sidebarFontSize');
      if (saved) {
        const n = parseFloat(saved);
        if (Number.isFinite(n) && n > 0) setFontSize(n);
      }
    };

    const handleFontSizeChange = (event: CustomEvent) => {
      const n = event.detail.fontSize;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) setFontSize(n);
    };

    // Escuchar cambios de localStorage (otras pestañas)
    window.addEventListener('storage', handleStorageChange);
    
    // Escuchar evento personalizado para cambios en la misma pestaña
    window.addEventListener('fontSizeChanged', handleFontSizeChange as EventListener);
    
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('fontSizeChanged', handleFontSizeChange as EventListener);
    };
  }, []);

  return fontSize;
}; 