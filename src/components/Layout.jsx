import React from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import { Waves, Home, BarChart3, Settings, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "レース", icon: Home },
  { to: "/verify", label: "検証", icon: BarChart3 },
  { to: "/admin", label: "管理", icon: Settings },
];

export default function Layout() {
  const loc = useLocation();
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-sky-100">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 flex items-center justify-center shadow-sm">
              <Waves className="w-5 h-5 text-white" strokeWidth={2.4} />
            </div>
            <div className="leading-none">
              <div className="font-display font-bold tracking-tight text-slate-900 text-[15px]">BOAT WORKS 2</div>
              <div className="text-[10px] text-sky-600 font-medium tracking-widest">AI RACE PREDICTION</div>
            </div>
          </Link>
          <nav className="flex items-center gap-1">
            {nav.map((n) => {
              const active = loc.pathname === n.to;
              const Icon = n.icon;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={cn(
                    "flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-medium transition-colors",
                    active ? "bg-sky-600 text-white shadow-sm" : "text-slate-600 hover:bg-sky-50"
                  )}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{n.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-5 pb-24">
        <Outlet />
      </main>
      <footer className="fixed bottom-0 inset-x-0 sm:hidden bg-white border-t border-sky-100 flex">
        {nav.map((n) => {
          const active = loc.pathname === n.to;
          const Icon = n.icon;
          return (
            <Link key={n.to} to={n.to} className={cn("flex-1 flex flex-col items-center justify-center py-2.5 text-[11px] font-medium", active ? "text-sky-600" : "text-slate-400")}>
              <Icon className="w-5 h-5 mb-0.5" />
              {n.label}
            </Link>
          );
        })}
      </footer>
    </div>
  );
}