import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useLeadsSubscription } from './store/useLeads';
import { AppShell } from './components/AppShell';
import { LoginScreen } from './components/LoginScreen';
import { HomeView } from './pages/HomeView';
import { CommandCenter } from './pages/CommandCenter';
import { RetainedList } from './pages/RetainedList';
import { FinancingView } from './pages/FinancingView';
import { CompletedList } from './pages/CompletedList';
import { CalendarView } from './pages/CalendarView';
import { ArchivedView } from './pages/ArchivedView';
import { ReportsView } from './pages/ReportsView';
import { NoSaleList } from './pages/NoSaleList';
import { SettingsView } from './pages/SettingsView';
import { LeadDetailDrawer } from './components/LeadDetailDrawer';
import { FinancingModal } from './components/FinancingModal';
import { NewLeadModal } from './components/NewLeadModal';
import { Toaster } from './components/ui/Toaster';

function AuthedApp() {
  useLeadsSubscription(true);
  return (
    <BrowserRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<HomeView />} />
          <Route path="/command-center" element={<CommandCenter />} />
          <Route path="/calendar" element={<CalendarView />} />
          <Route path="/retained" element={<RetainedList />} />
          <Route path="/financing" element={<FinancingView />} />
          <Route path="/completed" element={<CompletedList />} />
          <Route path="/archived" element={<ArchivedView />} />
          <Route path="/no-sale" element={<NoSaleList />} />
          <Route path="/reports" element={<ReportsView />} />
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </AppShell>
      <LeadDetailDrawer />
      <FinancingModal />
      <NewLeadModal />
      <Toaster />
    </BrowserRouter>
  );
}

function Gate() {
  const { user, loading, configured } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="font-hand text-3xl text-white">Loading…</p>
      </div>
    );
  }
  if (!configured || !user) return <LoginScreen />;
  return <AuthedApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}
