import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import Portfolio from "./pages/portfolio";

// The private area is a separate chunk: visitors to the public page never download it.
const Login = lazy(() => import("./pages/login"));
const PrivateArea = lazy(() => import("./pages/private-area"));

// Follow the system appearance, like a native app.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const syncTheme = () => document.documentElement.classList.toggle("dark", media.matches);
syncTheme();
media.addEventListener("change", syncTheme);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // Retry network and server errors, never 4xx.
      retry: (count, error) => {
        const status = (error as { status?: number }).status ?? 0;
        return count < 2 && (status === 0 || status >= 500);
      },
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Portfolio />} />
            <Route path="/login" element={<Login />} />
            <Route path="/mail/*" element={<PrivateArea section="mail" />} />
            <Route path="/files" element={<PrivateArea section="files" />} />
            <Route path="/codes" element={<PrivateArea section="codes" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
