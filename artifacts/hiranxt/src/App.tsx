import { Suspense, lazy } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import AppLayout from "@/components/AppLayout";
import LoginPage from "@/pages/auth/login";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { TourProvider } from "@/contexts/TourContext";
import { PartnerAuthProvider, usePartnerAuth } from "@/contexts/PartnerAuthContext";

// Route-level code splitting. Everything used to arrive in one 1.65MB bundle, so a
// visitor who only ever saw the landing page still downloaded the admin panel, the
// partner dashboard and every module of the app. Each of these now ships as its own
// chunk, fetched the first time its route is actually visited.
//
// Landing, login and the 404 stay eager: they are the first paint for an anonymous
// visitor, and splitting them would only add a round-trip before anything renders.
const BlogIndex = lazy(() => import("@/pages/blog/index"));
const BlogPost = lazy(() => import("@/pages/blog/post"));
const Dashboard = lazy(() => import("@/pages/app/dashboard"));
const Inventory = lazy(() => import("@/pages/app/inventory"));
const Billing = lazy(() => import("@/pages/app/billing"));
const Customers = lazy(() => import("@/pages/app/customers"));
const Karigars = lazy(() => import("@/pages/app/karigars"));
const Repairs = lazy(() => import("@/pages/app/repairs"));
const Purchases = lazy(() => import("@/pages/app/purchases"));
const Reports = lazy(() => import("@/pages/app/reports"));
const Settings = lazy(() => import("@/pages/app/settings"));
const Girvi = lazy(() => import("@/pages/app/girvi"));
const Marketing = lazy(() => import("@/pages/app/marketing"));
const PendingPayments = lazy(() => import("@/pages/app/pending-payments"));
const CustomOrders = lazy(() => import("@/pages/app/custom-orders"));
const Accounting = lazy(() => import("@/pages/app/accounting"));
const RegisterPage = lazy(() => import("@/pages/auth/register"));
const PaymentPage = lazy(() => import("@/pages/auth/payment"));
const AdminPage = lazy(() => import("@/pages/admin/index"));
const PartnerLoginPage = lazy(() => import("@/pages/partner/login"));
const PartnerSignupPage = lazy(() => import("@/pages/partner/signup"));
const PartnerDashboardPage = lazy(() => import("@/pages/partner/dashboard"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx is a deterministic answer — the same request will get the same reply, so a
      // retry is a second round-trip bought for nothing. It matters most in the cases
      // that are already going wrong: an expired subscription answers 402 on every query
      // on the page, and retrying doubled that burst. Only retry what might genuinely
      // differ next time (network blips, 5xx).
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number } | null)?.status;
        if (typeof status === "number" && status >= 400 && status < 500) return false;
        return failureCount < 1;
      },
      // Shop data changes when someone in the shop changes it, and every mutation here
      // already invalidates the queries it affects. Two minutes of trust between those
      // explicit refreshes cuts repeat fetches on navigation without showing stale
      // figures after an action the user just took.
      staleTime: 120_000,
      // Keep results around long enough that moving between tabs and back reuses the
      // cache instead of re-querying the server.
      gcTime: 900_000,
      // An ERP left open on a counter all day gets focused constantly; refetching every
      // query each time is request volume with almost no informational value, given the
      // invalidate-on-mutation above. Reconnect stays on, because a dropped connection
      // genuinely can mean missed changes.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

/** Returns true if the user's access has actually expired based on real dates */
function isAccessExpired(user: { plan: string; trialEndsAt: string; subscriptionEndsAt: string | null }) {
  const now = new Date();
  if (user.plan === "expired") return true;
  if (user.plan === "trial" && new Date(user.trialEndsAt) < now) return true;
  if (user.plan === "active" && user.subscriptionEndsAt && new Date(user.subscriptionEndsAt) < now) return true;
  return false;
}

/** Wraps a component — redirects to /login if not authenticated, /payment if access expired.
 * A logged-in partner is locked out of every main-app route and bounced to their own
 * dashboard instead — the two account types' sessions are mutually exclusive. */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { partner } = usePartnerAuth();

  if (partner) return <Redirect to="/partner/dashboard" />;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin" && isAccessExpired(user)) return <Redirect to="/payment" />;

  return <>{children}</>;
}

/** Admin-only route */
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { partner } = usePartnerAuth();

  if (partner) return <Redirect to="/partner/dashboard" />;
  if (!user) return <Redirect to="/login" />;
  if (user.role !== "admin") return <Redirect to="/app/dashboard" />;

  return <>{children}</>;
}

/** Restricts a route to shop owner + a given set of staff roles — bounces a salesperson
 * off /app/settings or /app/accounting instead of rendering a page whose every API call
 * would 403 anyway. Mirrors requireShopRole() on the backend. */
function ShopRoleRoute({ allow, children }: { allow: "isShopAdmin" | "canAccessAccounting"; children: React.ReactNode }) {
  const auth = useAuth();
  if (!auth[allow]) return <Redirect to="/app/dashboard" />;
  return <>{children}</>;
}

/** Shown while a route's chunk is in flight — deliberately minimal, since chunks are
 * small and served from the CDN, so anything heavier would flash more than it reassures. */
function RouteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-live="polite">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<RouteFallback />}>
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/blog" component={BlogIndex} />
      <Route path="/blog/:slug" component={BlogPost} />
      <Route path="/login" component={LoginPage} />
      <Route path="/register" component={RegisterPage} />
      <Route path="/payment" component={PaymentPage} />
      <Route path="/partner/login" component={PartnerLoginPage} />
      <Route path="/partner/signup" component={PartnerSignupPage} />
      <Route path="/partner/dashboard" component={PartnerDashboardPage} />
      <Route path="/admin">
        <AdminRoute>
          <AdminPage />
        </AdminRoute>
      </Route>
      <Route path="/app/:rest*">
        <ProtectedRoute>
          <AppLayout>
            <Switch>
              <Route path="/app/dashboard" component={Dashboard} />
              <Route path="/app/inventory" component={Inventory} />
              <Route path="/app/billing" component={Billing} />
              <Route path="/app/customers" component={Customers} />
              <Route path="/app/karigars" component={Karigars} />
              <Route path="/app/repairs" component={Repairs} />
              <Route path="/app/purchases" component={Purchases} />
              <Route path="/app/reports" component={Reports} />
              <Route path="/app/settings">
                <ShopRoleRoute allow="isShopAdmin"><Settings /></ShopRoleRoute>
              </Route>
              <Route path="/app/girvi" component={Girvi} />
              <Route path="/app/marketing" component={Marketing} />
              <Route path="/app/pending-payments" component={PendingPayments} />
              <Route path="/app/custom-orders" component={CustomOrders} />
              <Route path="/app/accounting">
                <ShopRoleRoute allow="canAccessAccounting"><Accounting /></ShopRoleRoute>
              </Route>
              <Route component={Dashboard} />
            </Switch>
          </AppLayout>
        </ProtectedRoute>
      </Route>
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <PartnerAuthProvider>
              <TourProvider>
                <Router />
              </TourProvider>
            </PartnerAuthProvider>
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
