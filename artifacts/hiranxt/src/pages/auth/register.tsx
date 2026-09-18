import { useState } from "react";
import { Link, useLocation, useSearch, Redirect } from "wouter";
import { Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useSEO } from "@/lib/seo";

// Mirrors the server-side minimum in api-server routes/auth.ts.
const MIN_PASSWORD_LENGTH = 8;

export default function RegisterPage() {
  useSEO({
    title: "Sign Up Free — 7 Day Trial",
    description: "Start your 7 day free trial of SwarnDesk, India's complete jewellery ERP software. No credit card needed.",
    path: "/register",
  });
  // Pre-fills from a partner's shareable link (/register?ref=CODE) — the only
  // "referral link" mechanism this app has, no server-side redirect involved.
  const initialReferralCode = (new URLSearchParams(useSearch()).get("ref") ?? "").toUpperCase();
  const [form, setForm] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    name: "",
    shopName: "",
    mobile: "",
    referralCode: initialReferralCode,
  });
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { register, isLoading, user } = useAuth();
  const [, navigate] = useLocation();

  // Already logged in
  if (user) return <Redirect to="/app/dashboard" />;

  const handleChange = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm(f => ({ ...f, [field]: e.target.value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    // 8 is what the server enforces, and what staff accounts and the change-password
    // screen already require — keep the three in step so the form can't call a password
    // acceptable that registration then rejects.
    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    try {
      await register({
        email: form.email,
        password: form.password,
        name: form.name,
        shopName: form.shopName,
        mobile: form.mobile || undefined,
        referralCode: form.referralCode || undefined,
      });
      navigate("/app/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Registration failed");
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo / Brand */}
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="w-12 h-12 rounded-full bg-sidebar flex items-center justify-center shadow-md overflow-hidden">
              <img src="/logo.png" alt="SwarnDesk" className="w-10 h-10 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-foreground">SwarnDesk</h1>
          <p className="text-sm text-muted-foreground">Start your 7-day free trial — no credit card required</p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Create Account</CardTitle>
            <CardDescription>Set up your jewellery store in minutes</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm px-3 py-2">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">Owner Name <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="Your full name"
                    value={form.name}
                    onChange={handleChange("name")}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">Shop Name <span className="text-destructive">*</span></label>
                  <Input
                    placeholder="e.g. Shree Jewellers"
                    value={form.shopName}
                    onChange={handleChange("shopName")}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Email <span className="text-destructive">*</span></label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={handleChange("email")}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Mobile</label>
                <Input
                  type="tel"
                  placeholder="98765 43210"
                  value={form.mobile}
                  onChange={handleChange("mobile")}
                />
                <p className="text-xs text-muted-foreground">10-digit mobile number (no need to type +91)</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">Password <span className="text-destructive">*</span></label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="Min. 6 characters"
                      value={form.password}
                      onChange={handleChange("password")}
                      required
                      autoComplete="new-password"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {form.password.length > 0 && (
                    <p className={`text-xs ${form.password.length >= MIN_PASSWORD_LENGTH ? "text-green-600" : "text-destructive"}`}>
                      {form.password.length >= MIN_PASSWORD_LENGTH ? "Password length OK" : `At least ${MIN_PASSWORD_LENGTH - form.password.length} more character${MIN_PASSWORD_LENGTH - form.password.length !== 1 ? "s" : ""} needed`}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-foreground">Confirm Password <span className="text-destructive">*</span></label>
                  <div className="relative">
                    <Input
                      type={showConfirmPassword ? "text" : "password"}
                      placeholder="Re-enter password"
                      value={form.confirmPassword}
                      onChange={handleChange("confirmPassword")}
                      required
                      autoComplete="new-password"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(v => !v)}
                      className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                      tabIndex={-1}
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {form.confirmPassword.length > 0 && (
                    <p className={`text-xs ${form.confirmPassword === form.password ? "text-green-600" : "text-destructive"}`}>
                      {form.confirmPassword === form.password ? "Passwords match" : "Passwords do not match"}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Referral Code <span className="text-muted-foreground font-normal">(optional)</span></label>
                <Input
                  placeholder="e.g. SD-AB12CD"
                  value={form.referralCode}
                  onChange={(e) => setForm(f => ({ ...f, referralCode: e.target.value.toUpperCase() }))}
                  className="font-mono uppercase"
                />
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Creating account..." : "Start Free Trial"}
              </Button>
            </form>
            <div className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-primary font-medium hover:underline">
                Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
        <p className="text-center text-[10px] text-muted-foreground/40">
          SwarnDesk by <a href="https://www.tirthontech.com" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground hover:underline underline-offset-2">TirthonTech</a>
        </p>
      </div>
    </div>
  );
}
