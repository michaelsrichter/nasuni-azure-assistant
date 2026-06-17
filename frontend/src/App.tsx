import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import './App.css';
import { Header } from './components/Header';
import { Footer } from './components/Footer';
import { ChatPage } from './pages/ChatPage';
import { useTheme } from './theme/useTheme';

const ArchitecturePage = lazy(() =>
  import('./pages/ArchitecturePage').then((m) => ({ default: m.ArchitecturePage })),
);
const PrivacyPage = lazy(() =>
  import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })),
);
const TermsPage = lazy(() =>
  import('./pages/TermsPage').then((m) => ({ default: m.TermsPage })),
);

function App() {
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="app-shell">
      <Header theme={theme} onToggleTheme={toggleTheme} />
      <main className="app-main">
        <Suspense fallback={<div className="route-loading">Loading…</div>}>
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/architecture" element={<ArchitecturePage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="*" element={<ChatPage />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}

export default App;
