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
const KnowledgeBasePage = lazy(() =>
  import('./pages/KnowledgeBasePage').then((m) => ({ default: m.KnowledgeBasePage })),
);
const GovernancePage = lazy(() =>
  import('./pages/GovernancePage').then((m) => ({ default: m.GovernancePage })),
);
const CostsPage = lazy(() =>
  import('./pages/CostsPage').then((m) => ({ default: m.CostsPage })),
);
const EvaluationsPage = lazy(() =>
  import('./pages/EvaluationsPage').then((m) => ({ default: m.EvaluationsPage })),
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
            <Route path="/knowledge-base" element={<KnowledgeBasePage />} />
            <Route path="/governance" element={<GovernancePage />} />
            <Route path="/costs" element={<CostsPage />} />
            <Route path="/evaluations" element={<EvaluationsPage />} />
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
