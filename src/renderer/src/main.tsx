import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './lib/toast';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // Local data: no network retries or background refetch storms.
    // 'always': requests go to this computer, never the network, so they must not wait while the
    // computer reports itself offline (the default would hold every save until the internet is back).
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000, networkMode: 'always' },
    mutations: { retry: false, networkMode: 'always' },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
