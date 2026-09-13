import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireKey } from './auth';
import { Shell } from './components/Shell';
import { Keys } from './routes/Keys';
import { Login } from './routes/Login';
import { EmptyDetail, RequestDetail } from './routes/RequestDetail';
import { Requests } from './routes/Requests';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <RequireKey>
                  <Shell />
                </RequireKey>
              }
            >
              {/* The detail is a nested route, so /requests/:id is a real,
                  shareable URL and the back button does what you expect. */}
              <Route path="/requests" element={<Requests />}>
                <Route index element={<EmptyDetail />} />
                <Route path=":id" element={<RequestDetail />} />
              </Route>
              <Route path="/keys" element={<Keys />} />
            </Route>
            <Route path="*" element={<Navigate to="/requests" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
