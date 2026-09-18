import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { safeReturnPath } from "../auth-return";
import { useAuth } from "../auth";

export function Login() {
  const { username, ready, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnPath = safeReturnPath((location.state as { from?: unknown } | null)?.from);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!ready) {
    return (
      <main className="boot">
        <div className="skeleton-stack boot__skeleton">
          <div className="skeleton skeleton--hero" />
          <div className="skeleton skeleton--block" />
        </div>
      </main>
    );
  }

  if (username) {
    return <Navigate to={returnPath} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user.trim() || !password) {
      setError("Username and password are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(user.trim(), password);
      navigate(returnPath, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login__card">
        <p className="login__mark">RA</p>
        <p className="eyebrow">Your workspace, anywhere</p>
        <h1>Remote Agents</h1>
        <p className="login__lede">
          Your agents. Your projects. Always within reach.
        </p>
        <form className="login__form" onSubmit={(e) => void onSubmit(e)}>
          <label className="field">
            <span>Username</span>
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={user}
              onChange={(e) => setUser(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="btn btn--accent login__submit" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
