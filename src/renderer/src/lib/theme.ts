import { useEffect } from 'react';

export type ThemeSetting = 'light' | 'dark' | 'system';

export function useApplyTheme(theme: ThemeSetting | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (theme !== 'system') {
      root.dataset.theme = theme ?? 'light';
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => (root.dataset.theme = mq.matches ? 'dark' : 'light');
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
