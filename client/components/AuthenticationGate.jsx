"use client";
import { useEffect, useState } from "react";
import { AuthenticationError, ensureSession, login, logout } from "../lib/api";
import Dashboard from "./Dashboard";
import DotBrand from "./DotBrand";
import MascotAvatar from "./MascotAvatar";
import { FiArrowUpRight, FiLock, FiLoader } from "react-icons/fi";

export default function AuthenticationGate() {
  const [phase, setPhase] = useState("loading");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function checkSession() {
    setPhase("loading");
    setError("");
    try {
      await ensureSession();
      setPhase("authenticated");
    } catch (failure) {
      setPhase(
        failure instanceof AuthenticationError ? "login" : "unavailable",
      );
      if (!(failure instanceof AuthenticationError))
        setError(
          "No se pudo conectar con tu espacio. Inténtalo de nuevo en un momento.",
        );
    }
  }
  useEffect(() => {
    checkSession();
    const expired = () => {
      setToken("");
      setError("");
      setPhase("login");
    };
    window.addEventListener("open-dots:authentication-required", expired);
    return () =>
      window.removeEventListener("open-dots:authentication-required", expired);
  }, []);
  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const credential = token;
    setToken("");
    try {
      await login(credential);
      setPhase("authenticated");
    } catch (failure) {
      setError("La clave de acceso no es válida o la conexión ha fallado.");
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    try {
      await logout();
      setPhase("login");
    } catch (failure) {
      setError(failure.message);
      setPhase("unavailable");
    }
  }
  if (phase === "authenticated") return <Dashboard onLogout={signOut} />;
  return (
    <main className="auth-page">
      <section className="auth-story">
        <DotBrand />
        <div className="auth-story-content">
          <h1>
            Tu próxima idea
            <br />
            empieza <span>aquí.</span>
          </h1>
          <p>
            Un pequeño equipo para tus grandes ideas. Piensa, crea y avanza con
            tus Dots.
          </p>
          <div className="auth-characters" aria-hidden="true">
            <MascotAvatar type="lavender" size="hero" />
            <MascotAvatar type="lime" size="hero" />
            <MascotAvatar type="orange" size="hero" />
          </div>
        </div>
        <span className="auth-footnote">
          <FiLock />
          Tu espacio personal. Tus conversaciones.
        </span>
      </section>
      <section className="auth-form-section">
        <div className="auth-card">
          <span className="eyebrow">BIENVENIDO A TU ESPACIO</span>
          <h2>Qué bueno verte.</h2>
          <p>
            Entra y continúa donde lo dejaste.
            <br />
            Tus Dots te esperan.
          </p>
          {phase === "loading" ? (
            <div className="auth-loading" role="status">
              <FiLoader />
              Comprobando sesión…
            </div>
          ) : phase === "unavailable" ? (
            <>
              <p role="alert" className="inline-error mt-6">
                {error}
              </p>
              <button
                onClick={checkSession}
                className="primary-button full-width mt-6"
              >
                Volver a conectar
                <FiArrowUpRight />
              </button>
            </>
          ) : (
            <form onSubmit={signIn}>
              <label htmlFor="owner-token" className="field-label">
                Tu clave de acceso
              </label>
              <input
                id="owner-token"
                className="studio-input"
                type="password"
                autoComplete="current-password"
                required
                maxLength={4096}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={busy}
                placeholder="Introduce tu clave privada"
              />
              {error && (
                <p role="alert" className="inline-error mt-4">
                  {error}
                </p>
              )}
              <button
                disabled={busy}
                type="submit"
                className="primary-button full-width"
              >
                {busy ? "Entrando…" : "Entrar en mi espacio"}
                <FiArrowUpRight />
              </button>
              <p className="auth-help">
                <FiLock className="inline mr-1" />
                Usa la clave de acceso de tu instalación, distinta de la clave
                de NVIDIA. Solo tú puedes entrar en este espacio.
              </p>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
